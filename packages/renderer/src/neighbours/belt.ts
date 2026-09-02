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
 *  side-load decals. Side-loading has no art of its own. */
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

/** A cap piece closing off one end of a belt run. Its art covers the tile
 *  the run would continue onto, so it is drawn one tile off the belt's own
 *  centre: the start cap behind, the end cap ahead. */
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

  // A cap closes an end nothing continues onto. The sprite covers the
  // neighbouring tile, so it is offset half its own overhang that way.
  const caps: BeltCap[] = [];
  if (!occupied(inputSide)) caps.push({ row: START_CAP[facing], ...offsetTowards(inputSide) });
  if (!occupied(facing)) caps.push({ row: END_CAP[facing], ...offsetTowards(facing) });

  return { row, caps };
}

/** Belt art is drawn two tiles across, so a cap meant for the neighbouring
 *  tile sits half a tile out — a full tile would leave a seam. */
function offsetTowards(dir: Cardinal): { dx: number; dy: number } {
  const { dx, dy } = step(dir);
  return { dx: dx * CAP_OFFSET, dy: dy * CAP_OFFSET };
}

const CAP_OFFSET = 0.5;

export { STRAIGHT as STRAIGHT_ROW };
