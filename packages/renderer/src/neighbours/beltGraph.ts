import { leftOf, opposite, rightOf, step, toCardinal, type Cardinal, type NeighbourGrid } from "./grid.js";
import { Dir } from "./grid.js";

/** Row indices into a belt_animation_set sheet's 20 rows, ported from the
 *  reference renderer's getBeltSpriteFromData (teoxoy/factorio-blueprint-
 *  editor), converting its 1-indexed *_index fallbacks to 0-indexed rows.
 *  Shared by transport-belt, splitter (one call per lane), and
 *  underground-belt (forceStraight, since an underground never curves). */
const STRAIGHT: Record<Cardinal, number> = {
  [Dir.North]: 2,
  [Dir.East]: 0,
  [Dir.South]: 3,
  [Dir.West]: 1,
};

/** curve[facing][side the input turns in from]. */
const CURVE: Record<Cardinal, { left: number; right: number }> = {
  [Dir.North]: { left: 6, right: 4 },
  [Dir.East]: { left: 5, right: 8 },
  [Dir.South]: { left: 9, right: 11 },
  [Dir.West]: { left: 10, right: 7 },
};

/** Caps drawn at a run's ends: rows 12-19 are start/end pieces, not
 *  side-load decals — side-loading has no cap art of its own, the belt
 *  underneath just keeps drawing straight through. Each row's art sits at
 *  one specific edge of its frame, the reverse of the rows' own start/end
 *  naming (confirmed by cropping the sheet). */
const START_CAP: Record<Cardinal, number> = {
  [Dir.North]: 12,
  [Dir.East]: 14,
  [Dir.South]: 16,
  [Dir.West]: 18,
};

const END_CAP: Record<Cardinal, number> = {
  [Dir.North]: 17,
  [Dir.East]: 19,
  [Dir.South]: 13,
  [Dir.West]: 15,
};

/** A cap piece closing off one end of a belt run. The reference renderer
 *  shifts it a full tile toward the side it closes off — behind for the
 *  start cap, ahead for the end cap — landing it on the neighbouring tile
 *  the run would otherwise continue onto. `kind` lets a caller that only
 *  wants one of the two (an underground belt shows only its own open end)
 *  pick it out without hard-coding row numbers. */
export interface BeltCap {
  kind: "start" | "end";
  row: number;
  dx: number;
  dy: number;
  /** Tiles to pull the piece back toward the belt it closes off, on top of
   *  the whole-tile dx/dy — see START_CAP_INSET. */
  inset: number;
}

/** A North/South start cap's art begins on the exact pixel row the body's
 *  art stops on (measured off the sheet: body 30..95 / cap 96.. for North,
 *  cap ..31 / body 32.. for South), where every other cap overlaps its body
 *  by 2px or more. Flush edges open a 1px seam wherever the two frames
 *  land on a fractional pixel (each one's edge row fades out on its own
 *  and the two half-faded rows don't add back up to opaque) — most visible
 *  in a ghost, which is baked with smoothing on. Pulling the cap 2 sheet
 *  pixels back gives it the same overlap the end caps already have. */
const START_CAP_INSET = 2 / 64;

export interface BeltCell {
  /** Row for the belt body — straight or, unless forceStraight, a curve. */
  row: number;
  /** Up to two, for a lone belt tile. */
  caps: BeltCap[];
}

/** An underground belt or loader's entrance half has no surface output —
 *  only its exit half visually connects to a neighbour. A plain belt or a
 *  splitter always counts. */
function canFeed(n: { name: string; undergroundType?: "input" | "output" }, isBeltLike: (name: string) => boolean): boolean {
  if (!isBeltLike(n.name)) return false;
  return n.undergroundType === undefined || n.undergroundType === "output";
}

/** True when the neighbour in `dir` is belt-like AND actually faces back
 *  into `(x,y)` — not just that something sits there. A belt pointing some
 *  other way isn't a real connection (e.g. a south-facing belt dropping
 *  onto the middle of an unrelated west-facing row: the row doesn't face
 *  back north, so the south-facing belt still needs its own end cap, and
 *  the row draws as an unbroken straight run with no merge art of its
 *  own). */
function feedsFrom(
  x: number,
  y: number,
  dir: Cardinal,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): boolean {
  const n = grid.towards(x, y, dir);
  return n !== undefined && canFeed(n, isBeltLike) && toCardinal(n.direction) === opposite(dir);
}

/** The reference renderer's own `conn.from`/`conn.to`: the tile a belt-like
 *  entity's cap-suppression check compares against, computed UNCONDITIONALLY
 *  on that tile's own facing — "from" is whatever sits behind it (or, if it
 *  curves, whatever sits on its actual input side instead), "to" is
 *  whatever sits ahead of it. Deliberately not the same question feedsFrom
 *  asks ("does it face back into me") — a belt's own start/end cap
 *  is suppressed by ANY belt-like neighbour it would otherwise back into or
 *  feed into, even one facing away from it entirely, because the reference
 *  renderer's suppression check (getConnForPos in spriteDataBuilder.ts) only
 *  ever looks at what's physically adjacent, not which way it faces. Two
 *  belts placed back-to-back (or nose-to-nose) each suppress the other's
 *  cap this way — there is no cap art at all for "a belt run of one with a
 *  dead entity behind/ahead of it that never connects", only for a run with
 *  open, empty space at that end. */
function connectionPartners(
  x: number,
  y: number,
  direction: number,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
  forceStraight: boolean,
): { from: { x: number; y: number } | undefined; to: { x: number; y: number } | undefined } {
  const facing = toCardinal(direction);
  const behind = opposite(facing);
  const left = leftOf(facing);
  const right = rightOf(facing);

  const fromLeft = !forceStraight && feedsFrom(x, y, left, grid, isBeltLike);
  const fromRight = !forceStraight && feedsFrom(x, y, right, grid, isBeltLike);
  const fromBehind = feedsFrom(x, y, behind, grid, isBeltLike);
  const curvesLeft = fromLeft && !fromRight && !fromBehind;
  const curvesRight = fromRight && !fromLeft && !fromBehind;
  const inputSide = curvesLeft ? left : curvesRight ? right : behind;

  const at = (dir: Cardinal): { x: number; y: number } | undefined => {
    const n = grid.towards(x, y, dir);
    if (n === undefined || !isBeltLike(n.name)) return undefined;
    const { dx, dy } = step(dir);
    return { x: x + dx, y: y + dy };
  };
  return { from: at(inputSide), to: at(facing) };
}

/** True when the neighbour in `dir` is belt-like AND its own connection
 *  graph (see connectionPartners) already accounts for `(x,y)` — as either
 *  what it's fed from or what it feeds into — regardless of whether that
 *  neighbour's facing agrees with ours. This is the actual cap-suppression
 *  gate; feedsFrom (facing-agreement) is a stricter question used only for
 *  deciding whether a run curves, not for whether a cap is drawn. */
function occupiesConnection(
  x: number,
  y: number,
  dir: Cardinal,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): boolean {
  const n = grid.towards(x, y, dir);
  if (n === undefined || !isBeltLike(n.name)) return false;
  const { dx, dy } = step(dir);
  const nx = x + dx;
  const ny = y + dy;
  // Matches getConnForPos's own forceStraight gate: splitters and
  // undergrounds never curve, so their connection partners are always
  // straight behind/ahead, never a side neighbour.
  const forceStraight = n.undergroundType !== undefined || n.name.includes("splitter");
  const { from, to } = connectionPartners(nx, ny, n.direction, grid, isBeltLike, forceStraight);
  return (from !== undefined && from.x === x && from.y === y) || (to !== undefined && to.x === x && to.y === y);
}

function offsetTowards(dir: Cardinal): { dx: number; dy: number } {
  const { dx, dy } = step(dir);
  return { dx, dy };
}

/** Classifies one belt-shaped cell: transport-belt itself, one lane of a
 *  splitter (forceStraight — a splitter's lanes never curve), or an
 *  underground belt's single tile (forceStraight, and the caller keeps
 *  only the cap for its own open end). */
export function classifyBeltCell(
  x: number,
  y: number,
  direction: number,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
  forceStraight = false,
): BeltCell {
  const facing = toCardinal(direction);
  const behind = opposite(facing);
  const left = leftOf(facing);
  const right = rightOf(facing);

  const fromLeft = !forceStraight && feedsFrom(x, y, left, grid, isBeltLike);
  const fromRight = !forceStraight && feedsFrom(x, y, right, grid, isBeltLike);
  const fromBehind = feedsFrom(x, y, behind, grid, isBeltLike);

  // A side feed with nothing behind bends the belt; with a straight feed
  // too it merges, which the art doesn't distinguish from straight. A bend
  // takes its input from that side rather than from behind.
  const curvesLeft = fromLeft && !fromRight && !fromBehind;
  const curvesRight = fromRight && !fromLeft && !fromBehind;
  const inputSide = curvesLeft ? left : curvesRight ? right : behind;
  const row = curvesLeft ? CURVE[facing].left : curvesRight ? CURVE[facing].right : STRAIGHT[facing];

  // A cap closes an end nothing continues onto, shifted a full tile toward
  // the neighbour it covers. The reference renderer always shifts toward
  // the belt's own behind/ahead — even for a curve's start cap, whose
  // input is to a side — so this matches that rather than shifting toward
  // inputSide, which only differs from `behind` on a curve.
  //
  // Suppression uses occupiesConnection, not feedsFrom/feedsInto: those ask
  // "does the neighbour face back into me", which is the right question for
  // deciding whether a run curves, but the WRONG one for whether a cap is
  // drawn. Two belts placed back-to-back (or nose-to-nose), each facing
  // away from/into the other without either actually connecting, still each
  // suppress the other's cap in the real game — confirmed against the
  // reference renderer's own getConnForPos, which only checks physical
  // adjacency for this, never facing agreement. Using feedsFrom/feedsInto
  // here drew both belts' caps stacked on top of each other at the shared
  // seam, since neither belt considered itself fed by (or feeding into) the
  // other, so neither cap was suppressed.
  const caps: BeltCap[] = [];
  if (!occupiesConnection(x, y, inputSide, grid, isBeltLike)) {
    const vertical = facing === Dir.North || facing === Dir.South;
    caps.push({ kind: "start", row: START_CAP[facing], ...offsetTowards(behind), inset: vertical ? START_CAP_INSET : 0 });
  }
  if (!occupiesConnection(x, y, facing, grid, isBeltLike)) {
    caps.push({ kind: "end", row: END_CAP[facing], ...offsetTowards(facing), inset: 0 });
  }

  return { row, caps };
}

/** Which side of an East/West-facing underground a belt-like entity feeds
 *  into from — `back` from the north, `front` from the south, matching the
 *  reference renderer's own draw_underground_belt. Each swaps out the art
 *  that would otherwise show a gap where the feed cuts across it: a back
 *  feed only drops the structure's back_patch, a front feed swaps the body
 *  to its direction_*_side_loading sprite and drops the front_patch.
 *  Vanilla's side-loading art only exists for East/West facings (the
 *  North/South columns of the sheet are blank), so a North/South-facing
 *  underground is never side loaded. */
export function undergroundSideLoad(
  x: number,
  y: number,
  direction: number,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): { back: boolean; front: boolean } {
  const facing = toCardinal(direction);
  if (facing !== Dir.East && facing !== Dir.West) return { back: false, front: false };
  return {
    back: feedsFrom(x, y, Dir.North, grid, isBeltLike),
    front: feedsFrom(x, y, Dir.South, grid, isBeltLike),
  };
}

export { STRAIGHT as STRAIGHT_ROW };
