import { leftOf, opposite, rightOf, step, toCardinal, type Cardinal, type NeighbourGrid } from "./grid.js";
import { Dir } from "./grid.js";

/** Row indices into a belt_animation_set sheet's 20 rows. */
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
 *  side-load decals. Side-loading has no art of its own. Each row's art
 *  sits at one specific edge of its frame (confirmed by cropping the sheet)
 *  — 12/14/16/18 sit at the edge items enter from, 13/15/17/19 at the edge
 *  they exit toward, which is the reverse of the row numbers' own start/end
 *  naming. */
const START_CAP: Record<Cardinal, number> = {
  [Dir.North]: 17,
  [Dir.East]: 19,
  [Dir.South]: 13,
  [Dir.West]: 15,
};

const END_CAP: Record<Cardinal, number> = {
  [Dir.North]: 12,
  [Dir.East]: 14,
  [Dir.South]: 16,
  [Dir.West]: 18,
};

/** A cap piece closing off one end of a belt run — its row's own art already
 *  sits toward the matching edge of the frame, and a small extra push the
 *  same way makes it read as poking past the tile edge instead of stopping
 *  flush at it. */
export interface BeltCap {
  row: number;
  dx: number;
  dy: number;
}

export interface BeltShape {
  /** Row for the belt body. */
  row: number;
  /** Up to two, for a lone belt tile. */
  caps: BeltCap[];
}

export function classifyBelt(
  x: number,
  y: number,
  direction: number,
  grid: NeighbourGrid,
  isBeltLike: (name: string) => boolean,
): BeltShape {
  const facing = toCardinal(direction);
  const behind = opposite(facing);
  const left = leftOf(facing);
  const right = rightOf(facing);

  const feedsFrom = (dir: Cardinal): boolean => {
    const n = grid.towards(x, y, dir);
    return n !== undefined && isBeltLike(n.name) && toCardinal(n.direction) === opposite(dir);
  };
  const occupied = (dir: Cardinal): boolean => {
    const n = grid.towards(x, y, dir);
    return n !== undefined && isBeltLike(n.name);
  };

  const fromLeft = feedsFrom(left);
  const fromRight = feedsFrom(right);
  const fromBehind = feedsFrom(behind);

  // A side feed with nothing behind bends the belt; with a straight feed too
  // it merges, which the art doesn't distinguish from straight. A bend takes
  // its input from that side rather than from behind.
  const curvesLeft = fromLeft && !fromRight && !fromBehind;
  const curvesRight = fromRight && !fromLeft && !fromBehind;
  const inputSide = curvesLeft ? left : curvesRight ? right : behind;
  const row = curvesLeft ? CURVE[facing].left : curvesRight ? CURVE[facing].right : STRAIGHT[facing];

  // A cap closes an end nothing continues onto.
  const caps: BeltCap[] = [];
  if (!occupied(inputSide)) caps.push({ row: START_CAP[facing], ...offsetTowards(inputSide) });
  if (!occupied(facing)) caps.push({ row: END_CAP[facing], ...offsetTowards(facing) });

  return { row, caps };
}

/** A small nudge past the tile's own edge, toward the neighbour the cap
 *  faces — enough to read as poking out, not so much it overshoots onto a
 *  second cap's own art (the row's content already sits near that edge of
 *  its frame; see the comment on START_CAP/END_CAP above). */
function offsetTowards(dir: Cardinal): { dx: number; dy: number } {
  const { dx, dy } = step(dir);
  return { dx: dx * CAP_OFFSET, dy: dy * CAP_OFFSET };
}

const CAP_OFFSET = 0.2;

export { STRAIGHT as STRAIGHT_ROW };
