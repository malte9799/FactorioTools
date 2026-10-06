/** Glue between the rail planner and the placed blueprint: which tiles are
 *  taken, where existing track can be continued from, what holds elevated
 *  track up, where signals and train stops may go. Rebuilt once per edit,
 *  queried every frame while a rail item is held. */

import type { PlacedEntity } from "@factoriotools/engine";
import {
  dirVector,
  isElevatedRail,
  isRail,
  nearestSlot,
  openEnds,
  RAIL_DECK_HEIGHT,
  railCentreline,
  railEndsAt,
  railHighlightBox,
  railJoints,
  railKey,
  railLength,
  railName,
  railTiles,
  RAMP_SUPPORT_RANGE,
  signalSlots,
  slotGroup,
  snapStraightRail,
  SUPPORT_RANGE,
  supportDirection,
  supportHolds,
  supportTiles,
  trainStopSlots,
  type RailEnd,
  type RailPiece,
  type RailSlot,
} from "./railGeometry.js";
import { planEnd, planRail, RAIL_PLAN_LENGTH_LIMIT, railLevel, supportsFor, type RailLevel } from "./railPlanner.js";
import { computeRailBlocks, type RailBlocks } from "./railBlocks.js";

/** Held items that drive the rail planner rather than placing one entity:
 *  the rail item, which lays track on the layer it starts from, and the
 *  ramp item, which takes the track to the other layer. */
export function isRailPlannerItem(name: string): boolean {
  return isRail(name);
}

/** The layer a plan with this item heads for, leaving from an end on the
 *  given layer. */
export function plannerTargetsElevated(name: string, fromElevated: boolean): boolean {
  return name === "rail-ramp" ? !fromElevated : fromElevated;
}

const SIGNALS = new Set(["rail-signal", "rail-chain-signal"]);

export function isRailSnapped(name: string): boolean {
  return SIGNALS.has(name) || name === "train-stop";
}

export interface RailIndex {
  /** True when a piece on this level may not cover the tile. */
  blocked(tx: number, ty: number, level: RailLevel): boolean;
  /** Placed rails by the tiles they are seen on (elevated track up on the
   *  deck), for picking the rail under the cursor. */
  railsAt: Map<string, RailPiece[]>;
  /** railKey of every placed rail, so a plan reuses track already there. */
  existing: Set<string>;
  /** Every placed rail end (railJoints), to tell where track stops. */
  joints: ReadonlySet<string>;
  /** Placed rail supports, so a held rail can start from one. */
  supports: RailPiece[];
  /** True when a placed support at this joint carries track running along `dir`. */
  supported(x: number, y: number, dir: number): boolean;
  /** How much further the deck is held at a placed elevated end, by the
   *  nearest support or ramp along the track joined there. Negative when
   *  none is in range. */
  reachAt(end: RailEnd): number;
  /** True when a support for track along `dir` can't stand at this joint. */
  supportBlocked(x: number, y: number, dir: number): boolean;
  /** Ends of elevated track with no support under them. */
  openJoints: RailEnd[];
  signalSlots: RailSlot[];
  stopSlots: RailSlot[];
  /** Spots already holding a signal or stop (see railsideKey). */
  railsideTaken: Set<string>;
  /** Joint sides (slotGroup) that already hold a signal. */
  takenSignalGroups: Set<string>;
  hasRails: boolean;
  /** The blocks signals divide track into, worked out on first use. */
  blocks(): RailBlocks;
}

/** A signal or stop's spot: its position and the layer it stands on. */
export function railsideKey(x: number, y: number, elevated: boolean | undefined): string {
  return `${x},${y},${elevated ? 1 : 0}`;
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
  // What stands on each tile, by what it blocks. Elevated signals stand on
  // the deck and take no ground.
  const objects = new Set<string>();
  const groundRails = new Set<string>();
  const deckRails = new Set<string>();
  const ramps = new Set<string>();
  const signals = new Set<string>();
  const rails: RailPiece[] = [];
  const supports: RailPiece[] = [];
  const railsideTaken = new Set<string>();
  const signalsAt = new Set<string>();
  for (const e of entities) {
    if (isRail(e.name)) {
      rails.push({ name: e.name, x: e.x, y: e.y, direction: e.direction });
      continue;
    }
    if (isRailSnapped(e.name)) {
      const elevated = e.railLayer === "elevated";
      railsideTaken.add(railsideKey(e.x, e.y, elevated));
      if (SIGNALS.has(e.name)) {
        signalsAt.add(`${e.x},${e.y},${e.direction},${elevated ? 1 : 0}`);
        if (!elevated) signals.add(`${Math.floor(e.x)},${Math.floor(e.y)}`);
      } else {
        tilesUnder(e, footprintOf(e), objects);
      }
      continue;
    }
    if (e.name === "rail-support") {
      supports.push({ name: e.name, x: e.x, y: e.y, direction: supportDirection(e.direction) });
      for (const [tx, ty] of supportTiles(e)) objects.add(`${tx},${ty}`);
      continue;
    }
    tilesUnder(e, footprintOf(e), objects);
  }

  const railsAt = new Map<string, RailPiece[]>();
  const endsAt = new Map<string, { piece: RailPiece; far: RailEnd }[]>();
  const endKey = (e: RailEnd) => `${e.x},${e.y},${e.dir},${e.elevated ? 1 : 0}`;
  for (const r of rails) {
    const level = railLevel(r.name);
    const set = level === "ramp" ? ramps : level === "elevated" ? deckRails : groundRails;
    const lift = level === "elevated" ? RAIL_DECK_HEIGHT : 0;
    const seen = new Set<string>();
    for (const [tx, ty] of railTiles(r)) {
      set.add(`${tx},${ty}`);
      seen.add(`${tx},${ty - lift}`);
      // A ramp is seen from its ground tiles up to the deck above its top.
      if (level === "ramp") for (let up = 1; up <= RAIL_DECK_HEIGHT; up++) seen.add(`${tx},${ty - up}`);
    }
    for (const key of seen) (railsAt.get(key) ?? railsAt.set(key, []).get(key)!).push(r);
    const [a, b] = railEndsAt(r) as [RailEnd, RailEnd];
    for (const [near, far] of [[a, b], [b, a]] as const) {
      const key = endKey(near);
      (endsAt.get(key) ?? endsAt.set(key, []).get(key)!).push({ piece: r, far });
    }
  }

  const supportAt = new Map<string, number>();
  for (const sp of supports) supportAt.set(`${sp.x},${sp.y}`, sp.direction);
  const supported = (x: number, y: number, dir: number) => {
    const d = supportAt.get(`${x},${y}`);
    return d !== undefined && supportHolds(d, dir);
  };

  // Walks along placed deck from an end to whatever holds it up.
  const reachAt = (end: RailEnd): number => {
    let best = -1;
    const seen = new Set<string>();
    const visit = (at: RailEnd, travelled: number) => {
      if (travelled > SUPPORT_RANGE) return;
      if (supported(at.x, at.y, at.dir)) best = Math.max(best, SUPPORT_RANGE - travelled);
      const key = endKey(at);
      if (seen.has(key)) return;
      seen.add(key);
      for (const { piece, far } of endsAt.get(key) ?? []) {
        if (piece.name === "rail-ramp") {
          best = Math.max(best, RAMP_SUPPORT_RANGE - travelled);
          continue;
        }
        // Step to the piece's other end, then face back along the track.
        visit({ ...far, dir: (far.dir + 8) % 16 }, travelled + railLength(piece.name, piece.direction));
      }
    };
    // Whatever is joined at this point holds it, whichever way it runs.
    if (end.elevated) {
      visit(end, 0);
      visit({ ...end, dir: (end.dir + 8) % 16 }, 0);
    }
    return best;
  };

  const openJoints: RailEnd[] = [];
  const jointSeen = new Set<string>();
  for (const r of rails) {
    if (!isElevatedRail(r.name)) continue;
    for (const end of railEndsAt(r)) {
      const key = `${end.x},${end.y},${supportDirection(end.dir)}`;
      if (jointSeen.has(key) || supportAt.has(`${end.x},${end.y}`)) continue;
      jointSeen.add(key);
      openJoints.push(end);
    }
  }

  // A signal takes its whole joint side: both slots there stop being offered.
  const slots = [
    ...signalSlots(rails.filter((r) => railLevel(r.name) === "ground")),
    ...signalSlots(rails.filter((r) => railLevel(r.name) === "elevated")).map((s) => ({ ...s, elevated: true })),
  ];
  const takenSignalGroups = new Set<string>();
  for (const slot of slots) {
    if (signalsAt.has(`${slot.x},${slot.y},${slot.direction},${slot.elevated ? 1 : 0}`)) takenSignalGroups.add(slotGroup(slot));
  }

  let blocks: RailBlocks | undefined;
  return {
    blocked: (tx, ty, level) => {
      const key = `${tx},${ty}`;
      // A ramp is solid all the way up: nothing passes through or over it.
      if (ramps.has(key)) return true;
      if (level === "elevated") return false;
      if (objects.has(key)) return true;
      return level === "ramp" && (groundRails.has(key) || deckRails.has(key) || signals.has(key));
    },
    railsAt,
    supports,
    existing: new Set(rails.map(railKey)),
    joints: railJoints(rails),
    supported,
    reachAt,
    supportBlocked: (x, y, dir) =>
      supportTiles({ x, y, direction: dir }).some(([tx, ty]) => {
        const key = `${tx},${ty}`;
        return objects.has(key) || groundRails.has(key) || ramps.has(key) || signals.has(key);
      }),
    openJoints,
    signalSlots: slots,
    stopSlots: trainStopSlots(rails.filter((r) => railLevel(r.name) === "ground")),
    railsideTaken,
    takenSignalGroups,
    hasRails: rails.length > 0,
    blocks: () => (blocks ??= computeRailBlocks(rails, (x, y, dir, elevated) => takenSignalGroups.has(slotGroup({ x, y, ex: x, ey: y, direction: dir, elevated })))),
  };
}

/** The single piece a rail item shows before any track is planned — a
 *  straight for the rail item, a ramp for the ramp item — and the end that
 *  planning would continue from: the one facing the held direction, or the
 *  ramp's top. */
export function startPiece(x: number, y: number, direction: number, elevated: boolean, ramp = false): { piece: RailPiece; end: RailEnd } {
  if (ramp) {
    // A ramp is 16 long and cardinal: its position is even along its run
    // and odd across it, so its ends land on the joints of straight track.
    const r = ((Math.floor(direction / 4) * 4) % 16 + 16) % 16;
    const vertical = r % 8 === 0;
    const odd = (v: number) => Math.round((v - 1) / 2) * 2 + 1;
    const even = (v: number) => Math.round(v / 2) * 2;
    const piece: RailPiece = { name: "rail-ramp", x: vertical ? odd(x) : even(x), y: vertical ? even(y) : odd(y), direction: r };
    const ends = railEndsAt(piece);
    return { piece, end: ends.find((e) => e.elevated) ?? ends[0]! };
  }
  const d = Math.floor(direction / 2) * 2;
  const at = snapStraightRail(x, y, d);
  const piece: RailPiece = { name: railName("straight", elevated), x: at.x, y: at.y, direction: d % 8 };
  const ends = railEndsAt(piece);
  return { piece, end: ends.find((e) => e.dir === d) ?? ends[0]! };
}

/** True when a piece can't be laid: something stands where it would go. A
 *  piece that is already there is fine — laying it again changes nothing. */
export function railPieceBlocked(index: RailIndex, piece: RailPiece): boolean {
  if (index.existing.has(railKey(piece))) return false;
  const level = railLevel(piece.name);
  return railTiles(piece).some(([tx, ty]) => index.blocked(tx, ty, level));
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
 *  the target as that gets — an empty plan means no track can get closer.
 *  `lead` is a piece laid with the plan, ahead of its start (the held piece
 *  a drag from open ground begins with). */
export function previewRail(
  index: RailIndex,
  start: RailEnd,
  target: { x: number; y: number },
  targetElevated: boolean,
  unlimited: boolean,
  lead?: RailPiece,
): RailPreview {
  const maxLength = unlimited ? undefined : RAIL_PLAN_LENGTH_LIMIT;
  const none: RailPreview = { pieces: [], supports: [], end: start };
  const leadTiles = new Set<string>();
  if (lead && railLevel(lead.name) !== "elevated") for (const [tx, ty] of railTiles(lead)) leadTiles.add(`${tx},${ty}`);
  const pieces = planRail({
    start,
    target,
    targetElevated,
    // The lead piece isn't placed yet, but the plan must not run back over it.
    blocked: (tx, ty, level) => index.blocked(tx, ty, level) || (lead?.name === "rail-ramp" && leadTiles.has(`${tx},${ty}`)),
    exists: (p) => index.existing.has(railKey(p)),
    maxLength,
  });
  if (pieces.length === 0) return none;

  // Supports can't stand on the plan's own ground track and ramps either.
  const own = new Set(leadTiles);
  for (const p of pieces) {
    if (railLevel(p.name) !== "elevated") for (const [tx, ty] of railTiles(p)) own.add(`${tx},${ty}`);
  }
  // A lead ramp holds the deck that climbs out of it, like a placed one.
  const startReach = lead?.name === "rail-ramp" && start.elevated ? RAMP_SUPPORT_RANGE : lead ? -1 : index.reachAt(start);
  const held = supportsFor(start, pieces, {
    startReach,
    supported: index.supported,
    blocked: (x, y, dir) =>
      index.supportBlocked(x, y, dir) || supportTiles({ x, y, direction: dir }).some(([tx, ty]) => own.has(`${tx},${ty}`)),
  });
  // Elevated track that can't be held up along some stretch isn't
  // buildable: no plan, so the red X shows instead.
  if (!held.covered) return none;
  return { pieces, supports: held.supports, end: planEnd(start, pieces) };
}

/** The pieces and supports of a plan that can actually go down on the
 *  blueprint as it is now: track already there is left alone, and anything
 *  that would land on something is dropped (which only happens when the
 *  blueprint changed under a stale plan). */
export function buildableRails(
  entities: PlacedEntity[],
  footprintOf: (e: PlacedEntity) => [number, number],
  pieces: RailPiece[],
  supports: RailPiece[],
): { pieces: RailPiece[]; supports: RailPiece[] } {
  const index = buildRailIndex(entities, footprintOf);
  const laid = new Set<string>();
  const fresh = pieces.filter((p) => {
    const key = railKey(p);
    if (index.existing.has(key) || laid.has(key) || railPieceBlocked(index, p)) return false;
    laid.add(key);
    return true;
  });
  const ground = new Set<string>();
  for (const p of fresh) {
    if (railLevel(p.name) !== "elevated") for (const [tx, ty] of railTiles(p)) ground.add(`${tx},${ty}`);
  }
  const stood = new Set<string>();
  const freshSupports = supports.filter((sp) => {
    const key = `${sp.x},${sp.y}`;
    if (stood.has(key) || index.supportBlocked(sp.x, sp.y, sp.direction)) return false;
    if (supportTiles(sp).some(([tx, ty]) => ground.has(`${tx},${ty}`))) return false;
    stood.add(key);
    return true;
  });
  return { pieces: fresh, supports: freshSupports };
}

/** True when the point is on a ramp's track as it is drawn: the ramp climbs
 *  to the deck, so its upper part is seen above the ground it stands on,
 *  out to the deck height beyond its own box at the top. */
function onRampSlope(piece: RailPiece, x: number, y: number): boolean {
  if (piece.name !== "rail-ramp") return false;
  const ends = railEndsAt(piece);
  const foot = ends.find((e) => !e.elevated)!;
  const top = ends.find((e) => e.elevated)!;
  const vx = top.x - foot.x;
  const vy = top.y - RAIL_DECK_HEIGHT - foot.y;
  const t = Math.max(0, Math.min(1, ((x - foot.x) * vx + (y - foot.y) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - foot.x - t * vx, y - foot.y - t * vy) <= 1.8;
}

/** Where a press with a rail item would start planning: the end to build
 *  from, and where on screen the start arrow goes (up on the deck for
 *  anything elevated). */
export interface RailStart {
  end: RailEnd;
  arrow: { x: number; y: number };
}

/** The start under the cursor: the placed rail it is over (inside its turned
 *  hover box, so mid-track works too, to branch off), leaving from the end
 *  on the cursor's half of that rail; failing that, a rail support, to run
 *  elevated track off either side of it. Undefined anywhere else — open
 *  ground, or beside track — where a press lays the held piece. */
export function railStartAt(index: RailIndex, x: number, y: number): RailStart | undefined {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  let best: RailPiece | undefined;
  let bestDist = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const piece of index.railsAt.get(`${tx + ox},${ty + oy}`) ?? []) {
        const box = railHighlightBox(piece.name, piece.direction, openEnds(piece, index.joints));
        const dx = x - (piece.x + box.cx);
        const dy = y - (piece.y + box.cy);
        const cos = Math.cos(box.angle);
        const sin = Math.sin(box.angle);
        const across = Math.abs(dx * cos + dy * sin);
        const along = Math.abs(-dx * sin + dy * cos);
        if ((across > box.w / 2 || along > box.h / 2) && !onRampSlope(piece, x, y)) continue;
        // Several pieces under the cursor (a junction): the nearest centre.
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = piece;
        }
      }
    }
  }
  if (best) {
    const lift = isElevatedRail(best.name) ? RAIL_DECK_HEIGHT : 0;
    const [a, b] = railEndsAt(best) as [RailEnd, RailEnd];
    // Each end is measured where it is seen: a ramp's top is up on the deck.
    const seenY = (e: RailEnd) => e.y - (best!.name === "rail-ramp" ? (e.elevated ? RAIL_DECK_HEIGHT : 0) : lift);
    const end = Math.hypot(a.x - x, seenY(a) - y) <= Math.hypot(b.x - x, seenY(b) - y) ? a : b;
    if (best.name === "rail-ramp") {
      // The arrow lies just inside the ramp, its tip at the end built from.
      const [vx, vy] = dirVector(end.dir);
      return { end, arrow: { x: end.x - vx * 0.6, y: end.y - vy * 0.6 - (end.elevated ? RAIL_DECK_HEIGHT : 0) } };
    }
    const [mx, my] = railCentreline(best.name, best.direction, 2)[1]!;
    return { end, arrow: { x: best.x + mx, y: best.y + my - lift } };
  }
  for (const sp of index.supports) {
    // A support is picked by its base or by its head up at the deck.
    const head = Math.abs(x - sp.x) <= 1.5 && Math.abs(y - (sp.y - RAIL_DECK_HEIGHT)) <= 1.5;
    const base = Math.abs(x - sp.x) <= 1.5 && Math.abs(y - sp.y) <= 1.5;
    if (!head && !base) continue;
    const [vx, vy] = dirVector(sp.direction);
    const forward = (x - sp.x) * vx + (y - (head ? sp.y - RAIL_DECK_HEIGHT : sp.y)) * vy >= 0;
    return {
      end: { x: sp.x, y: sp.y, dir: forward ? sp.direction : sp.direction + 8, elevated: true },
      arrow: { x: sp.x, y: sp.y - RAIL_DECK_HEIGHT },
    };
  }
  return undefined;
}

/** How near the cursor a held rail support snaps under elevated track
 *  (rail-support's snap_to_spots_distance). */
const SUPPORT_SNAP_DISTANCE = 3;

/** Where a held rail support goes: under the nearest unsupported joint of
 *  elevated track, turned to carry it — the cursor may point at the joint
 *  up on the deck or at the ground below it. Undefined away from such a
 *  joint, where the support stands wherever it is put. */
export function supportSpotNear(index: RailIndex, x: number, y: number): RailPiece | undefined {
  let best: RailEnd | undefined;
  let bestDist = SUPPORT_SNAP_DISTANCE;
  for (const j of index.openJoints) {
    const d = Math.min(Math.hypot(j.x - x, j.y - y), Math.hypot(j.x - x, j.y - RAIL_DECK_HEIGHT - y));
    if (d < bestDist) {
      bestDist = d;
      best = j;
    }
  }
  return best && { name: "rail-support", x: best.x, y: best.y, direction: supportDirection(best.dir) };
}

/** The signal or train stop slot a held signal/stop snaps to near a point:
 *  the nearest one, even when it's taken (the ghost shows red, see
 *  railsideSlotTaken), as in the game. Skipping to the free slot beside a
 *  taken one made the click after placing a signal or stop drop a second
 *  one next to it. */
export function railsideSlot(index: RailIndex, name: string, x: number, y: number, heldDirection: number): RailSlot | undefined {
  if (!SIGNALS.has(name)) return nearestSlot(index.stopSlots, x, y, 3, heldDirection);
  // A signal on elevated track is seen, and so pointed at, up on the deck.
  const seen = index.signalSlots.map((s) => (s.elevated ? { ...s, y: s.y - RAIL_DECK_HEIGHT } : s));
  const hit = nearestSlot(seen, x, y, 2, heldDirection);
  return hit?.elevated ? { ...hit, y: hit.y + RAIL_DECK_HEIGHT } : hit;
}

/** True when a signal or stop already stands on the slot, or — for a
 *  signal — on the same side of the same joint. */
export function railsideSlotTaken(index: RailIndex, slot: RailSlot): boolean {
  if (index.railsideTaken.has(railsideKey(slot.x, slot.y, slot.elevated))) return true;
  return slot.ex !== undefined && index.takenSignalGroups.has(slotGroup(slot));
}

/** How far from the cursor a held signal shows its placement handles. */
export const SIGNAL_HANDLE_RANGE = 12;

/** How far from the cursor a held train stop shows its placement handles. */
export const STOP_HANDLE_RANGE = 16;

/** Free train stop slots within `radius` of a point. */
export function stopSlotsNear(index: RailIndex, x: number, y: number, radius = STOP_HANDLE_RANGE): RailSlot[] {
  return index.stopSlots.filter((s) => Math.hypot(s.x - x, s.y - y) <= radius && !index.railsideTaken.has(railsideKey(s.x, s.y, false)));
}

/** Free signal slots within `radius` of a point — where a held signal shows
 *  a handle on the track. */
export function signalSlotsNear(index: RailIndex, x: number, y: number, radius = SIGNAL_HANDLE_RANGE): RailSlot[] {
  return index.signalSlots.filter(
    (s) =>
      Math.hypot(s.x - x, s.y - (s.elevated ? RAIL_DECK_HEIGHT : 0) - y) <= radius &&
      !index.railsideTaken.has(railsideKey(s.x, s.y, s.elevated)) &&
      !index.takenSignalGroups.has(slotGroup(s)),
  );
}
