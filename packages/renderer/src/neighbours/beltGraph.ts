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
}

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

/** True when the neighbour in `dir` is belt-like AND takes our output —
 *  i.e. is facing away from us in a straight line, the only shape that
 *  continues a run. A curve or merge ahead is still `direction === dir`
 *  from directly ahead: it only bends around its OWN input, not around
 *  what's feeding INTO the tile ahead of us. */
function feedsInto(
  x: number,
  y: number,
  dir: Cardinal,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): boolean {
  const n = grid.towards(x, y, dir);
  return n !== undefined && isBeltLike(n.name) && toCardinal(n.direction) === dir;
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
  const caps: BeltCap[] = [];
  if (!feedsFrom(x, y, inputSide, grid, isBeltLike)) {
    caps.push({ kind: "start", row: START_CAP[facing], ...offsetTowards(behind) });
  }
  if (!feedsInto(x, y, facing, grid, isBeltLike)) {
    caps.push({ kind: "end", row: END_CAP[facing], ...offsetTowards(facing) });
  }

  return { row, caps };
}

/** True when a belt-like entity feeds this underground's mouth from the
 *  side (perpendicular to its own facing) rather than straight on — the
 *  underground swaps to its direction_*_side_loading sprite when this is
 *  true, since the plain mouth art would otherwise show a gap where the
 *  feed visually cuts across it. Vanilla's side-loading sheet only actually
 *  has art for an East/West-facing underground (confirmed by cropping the
 *  sheet — the North/South columns are blank); the reference renderer
 *  gates on exactly this, and this matches it rather than picking a
 *  variant with nothing to show. */
export function undergroundSideLoaded(
  x: number,
  y: number,
  direction: number,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): boolean {
  const facing = toCardinal(direction);
  if (facing !== Dir.East && facing !== Dir.West) return false;
  return feedsFrom(x, y, leftOf(facing), grid, isBeltLike) || feedsFrom(x, y, rightOf(facing), grid, isBeltLike);
}

export { STRAIGHT as STRAIGHT_ROW };
