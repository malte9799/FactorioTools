/** Glue between the rail planner and the placed blueprint: which tiles are
 *  taken, where existing track can be continued from, where signals and
 *  train stops may go. Rebuilt once per edit, queried every frame while a
 *  rail item is held. */

import { stockOrientation, type PlacedEntity, type SignalColor } from "@factoriotools/engine";
import {
  isElevatedRail,
  railCentreline,
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
import { computeRailBlocks, type RailBlocks } from "./railBlocks.js";
import { computeSignalStates, occupiedBlocks, type StockBox, type TrackSignal } from "./railSignals.js";

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
  /** The blocks signals divide ground track into, worked out on first use. */
  blocks(): RailBlocks;
  /** The blocks a train stands on, worked out on first use. */
  occupied(): ReadonlySet<number>;
  /** What every placed signal shows, by entity number. A signal missing
   *  here stands on no signal slot. */
  signalStates(): Map<number, SignalColor>;
  /** Ground track, for snapping rolling stock onto it. */
  groundRails: RailPiece[];
}

/** Tiles under an entity's centred footprint. */
function tilesUnder(e: PlacedEntity, footprint: [number, number], out: Set<string>): void {
  const [w, h] = footprint;
  const eps = 0.01;
  for (let ty = Math.floor(e.y - h / 2 + eps); ty < Math.ceil(e.y + h / 2 - eps); ty++) {
    for (let tx = Math.floor(e.x - w / 2 + eps); tx < Math.ceil(e.x + w / 2 - eps); tx++) out.add(`${tx},${ty}`);
  }
}

export function buildRailIndex(
  entities: PlacedEntity[],
  footprintOf: (e: PlacedEntity) => [number, number],
  /** A locomotive's or wagon's collision box; undefined for anything else. */
  stockSizeOf: (name: string) => { width: number; length: number } | undefined = () => undefined,
): RailIndex {
  const groundTaken = new Set<string>();
  const rails: RailPiece[] = [];
  const supports = new Set<string>();
  const railsideTaken = new Set<string>();
  const signalsAt = new Map<string, PlacedEntity>();
  const stock: StockBox[] = [];
  for (const e of entities) {
    if (isRail(e.name)) {
      rails.push({ name: e.name, x: e.x, y: e.y, direction: e.direction });
      continue;
    }
    if (isRailSnapped(e.name)) {
      railsideTaken.add(`${e.x},${e.y}`);
      if (SIGNALS.has(e.name)) signalsAt.set(`${e.x},${e.y},${e.direction}`, e);
      continue;
    }
    // Rolling stock stands on the track rather than taking ground tiles.
    const size = stockSizeOf(e.name);
    if (size) {
      stock.push({ x: e.x, y: e.y, orientation: stockOrientation(e), ...size });
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
  const trackSignals: TrackSignal[] = [];
  for (const slot of groundSignalSlots) {
    const signal = signalsAt.get(`${slot.x},${slot.y},${slot.direction}`);
    if (!signal) continue;
    takenSignalGroups.add(slotGroup(slot));
    trackSignals.push({ id: signal.entityNumber, chain: signal.name === "rail-chain-signal", x: slot.ex!, y: slot.ey!, dir: slot.direction });
  }

  let blocks: RailBlocks | undefined;
  let occupied: Set<number> | undefined;
  let signalStates: Map<number, SignalColor> | undefined;
  const getBlocks = () => (blocks ??= computeRailBlocks(rails, (x, y, dir) => takenSignalGroups.has(`${x},${y},${dir}`)));
  const getOccupied = () => (occupied ??= occupiedBlocks(getBlocks(), stock));
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
    blocks: getBlocks,
    occupied: getOccupied,
    signalStates: () => (signalStates ??= computeSignalStates(getBlocks(), trackSignals, getOccupied())),
    groundRails: rails.filter((r) => !isElevatedRail(r.name) && r.name !== "rail-ramp"),
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
  const held = supportsFor(start, pieces, index.supported, (x, y) => index.supportBlocked(x, y));
  // Elevated track that can't be held up anywhere along a stretch isn't
  // buildable: no plan, so the red X shows instead.
  if (!held.covered) return { pieces: [], supports: [], end: start };
  const supports = held.supports.filter((s) => !index.supported(s.x, s.y));
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

/** The signal or train stop slot a held signal/stop snaps to near a point:
 *  the nearest one, even when it's taken (the ghost shows red, see
 *  railsideSlotTaken), as in the game. Skipping to the free slot beside a
 *  taken one made the click after placing a signal or stop drop a second
 *  one next to it. */
export function railsideSlot(index: RailIndex, name: string, x: number, y: number, heldDirection: number): RailSlot | undefined {
  const slots = SIGNALS.has(name) ? index.signalSlots : index.stopSlots;
  return nearestSlot(slots, x, y, name === "train-stop" ? 3 : 2, heldDirection);
}

/** True when a signal or stop already stands on the slot, or — for a
 *  signal — on the same side of the same joint. */
export function railsideSlotTaken(index: RailIndex, slot: RailSlot): boolean {
  if (index.railsideTaken.has(`${slot.x},${slot.y}`)) return true;
  return slot.ex !== undefined && index.takenSignalGroups.has(slotGroup(slot));
}

/** How far from the cursor a held signal shows its placement handles. */
export const SIGNAL_HANDLE_RANGE = 12;

/** How far from the cursor a held train stop shows its placement handles. */
export const STOP_HANDLE_RANGE = 16;

/** Free train stop slots within `radius` of a point. */
export function stopSlotsNear(index: RailIndex, x: number, y: number, radius = STOP_HANDLE_RANGE): RailSlot[] {
  return index.stopSlots.filter((s) => Math.hypot(s.x - x, s.y - y) <= radius && !index.railsideTaken.has(`${s.x},${s.y}`));
}

/** Free signal slots within `radius` of a point — where a held signal shows
 *  a handle on the track. */
export function signalSlotsNear(index: RailIndex, x: number, y: number, radius = SIGNAL_HANDLE_RANGE): RailSlot[] {
  return index.signalSlots.filter(
    (s) => Math.hypot(s.x - x, s.y - y) <= radius && !index.railsideTaken.has(`${s.x},${s.y}`) && !index.takenSignalGroups.has(slotGroup(s)),
  );
}

/** How far from track a held locomotive or wagon still snaps onto it. */
export const STOCK_SNAP_RANGE = 2.5;

/** Where a held locomotive or wagon goes: the point of ground track nearest
 *  the cursor, heading along the rail there — of the two ways along it, the
 *  one closer to the held direction, so R turns the stock round. Undefined
 *  away from track. */
export function rollingStockSnap(index: RailIndex, x: number, y: number, heldDirection: number): { x: number; y: number; direction: number } | undefined {
  let best: { x: number; y: number; tx: number; ty: number } | undefined;
  let bestDist = STOCK_SNAP_RANGE;
  for (const rail of index.groundRails) {
    if (Math.hypot(rail.x - x, rail.y - y) > 12) continue;
    const line = railCentreline(rail.name, rail.direction, 12);
    for (let i = 1; i < line.length; i++) {
      const ax = rail.x + line[i - 1]![0];
      const ay = rail.y + line[i - 1]![1];
      const vx = rail.x + line[i]![0] - ax;
      const vy = rail.y + line[i]![1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
      const px = ax + t * vx;
      const py = ay + t * vy;
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) {
        bestDist = d;
        best = { x: px, y: py, tx: vx, ty: vy };
      }
    }
  }
  if (!best) return undefined;
  // Heading clockwise from north, in sixteenths of a turn.
  const along = ((Math.round((Math.atan2(best.tx, -best.ty) / (Math.PI * 2)) * 16) % 16) + 16) % 16;
  const turn = (a: number, b: number) => Math.min((a - b + 16) % 16, (b - a + 16) % 16);
  const direction = turn(along, heldDirection) <= turn((along + 8) % 16, heldDirection) ? along : (along + 8) % 16;
  // Stock sits on the game's 1/256-tile position grid.
  return { x: Math.round(best.x * 256) / 256, y: Math.round(best.y * 256) / 256, direction };
}
