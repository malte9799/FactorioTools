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
  signalSlots,
  snapStraightRail,
  trainStopSlots,
  type RailEnd,
  type RailPiece,
  type RailSlot,
} from "./railGeometry.js";
import { piecesWithinLimit, planEnd, planRail, supportsFor } from "./railPlanner.js";

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
  const rampTops = new Set<string>();
  for (const r of rails) {
    for (const end of railEndsAt(r)) {
      const key = railEndKey(end.x, end.y, end.elevated);
      (ends.get(key) ?? ends.set(key, []).get(key)!).push(end);
      if (r.name === "rail-ramp" && end.elevated) rampTops.add(`${end.x},${end.y}`);
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
  /** How many leading pieces this placement actually lays. */
  placeable: number;
  /** Supports carrying the placeable elevated part. */
  supports: RailPiece[];
  /** Where the next placement continues from. */
  end: RailEnd;
}

export function previewRail(index: RailIndex, start: RailEnd, target: { x: number; y: number }, targetElevated: boolean, unlimited: boolean): RailPreview {
  const pieces = planRail({ start, target, targetElevated, blocked: index.blocked });
  const placeable = unlimited ? pieces.length : piecesWithinLimit(pieces, index.existing);
  const laid = pieces.slice(0, placeable);
  const supports = supportsFor(start, laid, index.supported, (x, y) => index.supportBlocked(x, y)).filter((s) => !index.supported(s.x, s.y));
  return { pieces, placeable, supports, end: planEnd(start, laid) };
}

/** The signal or train stop slot a held signal/stop snaps to near a point. */
export function railsideSlot(index: RailIndex, name: string, x: number, y: number, heldDirection: number): RailSlot | undefined {
  const slots = SIGNALS.has(name) ? index.signalSlots : index.stopSlots;
  return nearestSlot(slots, x, y, name === "train-stop" ? 3 : 2, heldDirection);
}
