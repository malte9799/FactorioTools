/** Glue between the rail planner and the placed blueprint: which tiles are
 *  taken, where existing track can be continued from, where signals and
 *  train stops may go. Rebuilt once per edit, queried every frame while a
 *  rail item is held. */

import type { PlacedEntity } from "@factoriotools/engine";
import {
  isElevatedRail,
  isRail,
  nearestSlot,
  railEndsAt,
  railKey,
  railHighlightBox,
  railName,
  railTiles,
  signalSlots,
  slotGroup,
  snapStraightRail,
  trainStopSlots,
  type RailEnd,
  type RailPiece,
  type RailSlot,
} from "./railGeometry.js";
import { planEnd, planRail, RAIL_PLAN_LENGTH_LIMIT, supportsFor } from "./railPlanner.js";

/** Held items that drive the rail planner rather than placing one entity.
 *  The ramp item plans toward the elevated layer, climbing a ramp first
 *  when it starts on the ground. */
export function isRailPlannerItem(name: string): boolean {
  return isRail(name);
}

export function plannerTargetsElevated(name: string): boolean {
  return name === "rail-ramp" || isElevatedRail(name);
}

const SIGNALS = new Set(["rail-signal", "rail-chain-signal"]);

export function isRailSnapped(name: string): boolean {
  return SIGNALS.has(name) || name === "train-stop";
}

export interface RailIndex {
  /** True when a piece on this layer may not cover the tile. */
  blocked(tx: number, ty: number, elevated: boolean): boolean;
  /** Placed rails covering each tile, for picking the rail under the cursor. */
  railsAt: Map<string, RailPiece[]>;
  /** railKey of every placed rail, so a plan reuses track already there. */
  existing: Set<string>;
  /** True when a support or ramp top already holds the deck at this point. */
  supported(x: number, y: number): boolean;
  /** Ground blockers only, for a support about to stand here. */
  supportBlocked(x: number, y: number): boolean;
  signalSlots: RailSlot[];
  stopSlots: RailSlot[];
  /** Positions already holding a signal or stop. */
  railsideTaken: Set<string>;
  /** Joint sides (slotGroup) that already hold a signal. */
  takenSignalGroups: Set<string>;
  hasRails: boolean;
}

/** Tiles under an entity's centred footprint. */
function tilesUnder(e: PlacedEntity, footprint: [number, number], out: Set<string>): void {
  const [w, h] = footprint;
  const eps = 0.01;
  for (let ty = Math.floor(e.y - h / 2 + eps); ty < Math.ceil(e.y + h / 2 - eps); ty++) {
    for (let tx = Math.floor(e.x - w / 2 + eps); tx < Math.ceil(e.x + w / 2 - eps); tx++) out.add(`${tx},${ty}`);
  }
}

export function buildRailIndex(entities: PlacedEntity[], footprintOf: (e: PlacedEntity) => [number, number]): RailIndex {
  const groundTaken = new Set<string>();
  const rails: RailPiece[] = [];
  const supports = new Set<string>();
  const railsideTaken = new Set<string>();
  const signalsAt = new Set<string>();
  for (const e of entities) {
    if (isRail(e.name)) {
      rails.push({ name: e.name, x: e.x, y: e.y, direction: e.direction });
      continue;
    }
    if (isRailSnapped(e.name)) {
      railsideTaken.add(`${e.x},${e.y}`);
      if (SIGNALS.has(e.name)) signalsAt.add(`${e.x},${e.y},${e.direction}`);
      continue;
    }
    if (e.name === "rail-support") supports.add(`${e.x},${e.y}`);
    tilesUnder(e, footprintOf(e), groundTaken);
  }

  const rampTops = new Set<string>();
  for (const r of rails) {
    if (r.name !== "rail-ramp") continue;
    for (const end of railEndsAt(r)) if (end.elevated) rampTops.add(`${end.x},${end.y}`);
  }
  const railsAt = new Map<string, RailPiece[]>();
  for (const r of rails) {
    for (const [tx, ty] of railTiles(r)) {
      const key = `${tx},${ty}`;
      (railsAt.get(key) ?? railsAt.set(key, []).get(key)!).push(r);
    }
  }

  // A signal takes its whole joint side: both slots there stop being offered.
  const groundSignalSlots = signalSlots(rails.filter((r) => !isElevatedRail(r.name)));
  const takenSignalGroups = new Set<string>();
  for (const slot of groundSignalSlots) {
    if (signalsAt.has(`${slot.x},${slot.y},${slot.direction}`)) takenSignalGroups.add(slotGroup(slot));
  }

  return {
    blocked: (tx, ty, elevated) => !elevated && groundTaken.has(`${tx},${ty}`),
    railsAt,
    existing: new Set(rails.map(railKey)),
    supported: (x, y) => supports.has(`${x},${y}`) || rampTops.has(`${x},${y}`),
    supportBlocked: (x, y) => {
      for (let ty = y - 1; ty <= y; ty++) for (let tx = x - 1; tx <= x; tx++) if (groundTaken.has(`${tx},${ty}`)) return true;
      return false;
    },
    signalSlots: groundSignalSlots,
    stopSlots: trainStopSlots(rails.filter((r) => !isElevatedRail(r.name))),
    railsideTaken,
    takenSignalGroups,
    hasRails: rails.length > 0,
  };
}

/** The single straight piece a rail item shows before any track is planned,
 *  and the end that planning would continue from: the one facing the held
 *  direction. */
export function startPiece(x: number, y: number, direction: number, elevated: boolean): { piece: RailPiece; end: RailEnd } {
  const d = Math.floor(direction / 2) * 2;
  const at = snapStraightRail(x, y, d);
  const piece: RailPiece = { name: railName("straight", elevated), x: at.x, y: at.y, direction: d % 8 };
  const ends = railEndsAt(piece);
  return { piece, end: ends.find((e) => e.dir === d) ?? ends[0]! };
}

export interface RailPreview {
  /** The whole planned track, from the start outward. */
  pieces: RailPiece[];
  /** Supports carrying its elevated part. */
  supports: RailPiece[];
  /** Where the next placement continues from. */
  end: RailEnd;
}

/** Plans track from `start` toward `target`. Without `unlimited` (Shift), one
 *  placement lays at most the rail item's length limit, heading as close to
 *  the target as that gets — an empty plan means no track can get closer. */
export function previewRail(index: RailIndex, start: RailEnd, target: { x: number; y: number }, targetElevated: boolean, unlimited: boolean): RailPreview {
  const maxLength = unlimited ? undefined : RAIL_PLAN_LENGTH_LIMIT;
  const pieces = planRail({ start, target, targetElevated, blocked: index.blocked, maxLength });
  const supports = supportsFor(start, pieces, index.supported, (x, y) => index.supportBlocked(x, y)).filter((s) => !index.supported(s.x, s.y));
  return { pieces, supports, end: planEnd(start, pieces) };
}

/** Where a press with the rail item would start planning, and the piece the
 *  start arrow sits on: the placed rail the cursor is over (inside its
 *  turned hover box, so mid-track works too, to branch off), leaving from
 *  the end on the cursor's half of that rail. Undefined anywhere else —
 *  open ground, or beside track — where a press lays the held piece. */
export function railStartAt(index: RailIndex, x: number, y: number): { end: RailEnd; piece: RailPiece } | undefined {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  let best: RailPiece | undefined;
  let bestDist = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const piece of index.railsAt.get(`${tx + ox},${ty + oy}`) ?? []) {
        const box = railHighlightBox(piece.name, piece.direction);
        const dx = x - (piece.x + box.cx);
        const dy = y - (piece.y + box.cy);
        const cos = Math.cos(box.angle);
        const sin = Math.sin(box.angle);
        const across = Math.abs(dx * cos + dy * sin);
        const along = Math.abs(-dx * sin + dy * cos);
        if (across > box.w / 2 || along > box.h / 2) continue;
        // Several pieces under the cursor (a junction): the nearest centre.
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = piece;
        }
      }
    }
  }
  if (!best) return undefined;
  const [a, b] = railEndsAt(best) as [RailEnd, RailEnd];
  const end = Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b;
  return { end, piece: best };
}

/** The signal or train stop slot a held signal/stop snaps to near a point. */
export function railsideSlot(index: RailIndex, name: string, x: number, y: number, heldDirection: number): RailSlot | undefined {
  const slots = SIGNALS.has(name) ? index.signalSlots.filter((s) => !index.takenSignalGroups.has(slotGroup(s))) : index.stopSlots;
  return nearestSlot(slots, x, y, name === "train-stop" ? 3 : 2, heldDirection);
}

/** How far from the cursor a held signal shows its placement handles. */
export const SIGNAL_HANDLE_RANGE = 12;

/** Free signal slots within `radius` of a point — where a held signal shows
 *  a handle on the track. */
export function signalSlotsNear(index: RailIndex, x: number, y: number, radius = SIGNAL_HANDLE_RANGE): RailSlot[] {
  return index.signalSlots.filter(
    (s) => Math.hypot(s.x - x, s.y - y) <= radius && !index.railsideTaken.has(`${s.x},${s.y}`) && !index.takenSignalGroups.has(slotGroup(s)),
  );
}
