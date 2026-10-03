/** Glue between the rail planner and the placed blueprint: which tiles are
 *  taken, where existing track can be continued from, where signals and
 *  train stops may go. Rebuilt once per edit, queried every frame while a
 *  rail item is held. */

import type { PlacedEntity } from "@factoriotools/engine";
import {
  isElevatedRail,
  isRail,
  nearestSlot,
  railEndKey,
  railEndsAt,
  railKey,
  railName,
  railTiles,
  signalSlots,
  snapStraightRail,
  trainStopSlots,
  type RailEnd,
  type RailPiece,
  type RailSlot,
} from "./railGeometry.js";
import { planEnd, planRail, supportsFor } from "./railPlanner.js";

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
  /** Ends no other piece continues from — where planning can pick up. */
  freeEnds: RailEnd[];
  /** Placed rails covering each tile, for picking the rail under the cursor. */
  railsAt: Map<string, RailPiece[]>;
  /** The piece each free end belongs to. */
  freeEndOwner: Map<RailEnd, RailPiece>;
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
  for (const e of entities) {
    if (isRail(e.name)) {
      rails.push({ name: e.name, x: e.x, y: e.y, direction: e.direction });
      continue;
    }
    if (isRailSnapped(e.name)) {
      railsideTaken.add(`${e.x},${e.y}`);
      continue;
    }
    if (e.name === "rail-support") supports.add(`${e.x},${e.y}`);
    tilesUnder(e, footprintOf(e), groundTaken);
  }

  const ends = new Map<string, RailEnd[]>();
  const endOwner = new Map<RailEnd, RailPiece>();
  const rampTops = new Set<string>();
  for (const r of rails) {
    for (const end of railEndsAt(r)) {
      const key = railEndKey(end.x, end.y, end.elevated);
      (ends.get(key) ?? ends.set(key, []).get(key)!).push(end);
      endOwner.set(end, r);
      if (r.name === "rail-ramp" && end.elevated) rampTops.add(`${end.x},${end.y}`);
    }
  }
  const railsAt = new Map<string, RailPiece[]>();
  for (const r of rails) {
    for (const [tx, ty] of railTiles(r)) {
      const key = `${tx},${ty}`;
      (railsAt.get(key) ?? railsAt.set(key, []).get(key)!).push(r);
    }
  }
  const freeEnds: RailEnd[] = [];
  for (const group of ends.values()) {
    for (const end of group) {
      if (!group.some((o) => o.dir === (end.dir + 8) % 16)) freeEnds.push(end);
    }
  }

  return {
    blocked: (tx, ty, elevated) => !elevated && groundTaken.has(`${tx},${ty}`),
    freeEnds,
    railsAt,
    freeEndOwner: endOwner,
    existing: new Set(rails.map(railKey)),
    supported: (x, y) => supports.has(`${x},${y}`) || rampTops.has(`${x},${y}`),
    supportBlocked: (x, y) => {
      for (let ty = y - 1; ty <= y; ty++) for (let tx = x - 1; tx <= x; tx++) if (groundTaken.has(`${tx},${ty}`)) return true;
      return false;
    },
    signalSlots: signalSlots(rails.filter((r) => !isElevatedRail(r.name))),
    stopSlots: trainStopSlots(rails.filter((r) => !isElevatedRail(r.name))),
    railsideTaken,
    hasRails: rails.length > 0,
  };
}

/** The free end nearest a point, within `reach` tiles, on the given layer
 *  if one is preferred. */
export function nearestFreeEnd(index: RailIndex, x: number, y: number, reach: number): RailEnd | undefined {
  let best: RailEnd | undefined;
  let bestDist = reach;
  for (const end of index.freeEnds) {
    const d = Math.hypot(end.x - x, end.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = end;
    }
  }
  return best;
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

export function previewRail(index: RailIndex, start: RailEnd, target: { x: number; y: number }, targetElevated: boolean): RailPreview {
  const pieces = planRail({ start, target, targetElevated, blocked: index.blocked });
  const supports = supportsFor(start, pieces, index.supported, (x, y) => index.supportBlocked(x, y)).filter((s) => !index.supported(s.x, s.y));
  return { pieces, supports, end: planEnd(start, pieces) };
}

/** Smallest turn between two 16-way directions, in steps. */
function dirGap(a: number, b: number): number {
  const d = (((a - b) % 16) + 16) % 16;
  return Math.min(d, 16 - d);
}

/** Where a press with the rail item would start planning, and the piece the
 *  start arrow sits on. Over a placed rail, that rail's end facing closest
 *  to the held heading — so R picks which way to build on from it, middle
 *  of the track included. Just past the end of track, that free end.
 *  Undefined over open ground, where the held piece itself is the start. */
export function railStartAt(index: RailIndex, x: number, y: number, heading: number): { end: RailEnd; piece: RailPiece } | undefined {
  const under = index.railsAt.get(`${Math.floor(x)},${Math.floor(y)}`);
  if (under && under.length > 0) {
    // Several pieces on one tile (a junction): the one whose centre is
    // nearest the cursor.
    const piece = under.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b));
    const ends = railEndsAt(piece);
    const end = ends.reduce((a, b) => (dirGap(a.dir, heading) <= dirGap(b.dir, heading) ? a : b));
    return { end, piece };
  }
  const free = nearestFreeEnd(index, x, y, 1.5);
  if (!free) return undefined;
  const owner = index.freeEndOwner.get(free);
  return owner ? { end: free, piece: owner } : undefined;
}

/** The signal or train stop slot a held signal/stop snaps to near a point. */
export function railsideSlot(index: RailIndex, name: string, x: number, y: number, heldDirection: number): RailSlot | undefined {
  const slots = SIGNALS.has(name) ? index.signalSlots : index.stopSlots;
  return nearestSlot(slots, x, y, name === "train-stop" ? 3 : 2, heldDirection);
}
