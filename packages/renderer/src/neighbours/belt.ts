import { leftOf, opposite, rightOf, toCardinal, type Cardinal, type NeighbourGrid } from "./grid.js";
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

export interface BeltShape {
  /** Row for the belt body. */
  row: number;
  /** Cap rows drawn over the body; up to two for a lone belt tile. */
  caps: number[];
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

  const caps: number[] = [];
  if (!occupied(behind)) caps.push(START_CAP[facing]);
  if (!occupied(facing)) caps.push(END_CAP[facing]);

  const fromLeft = feedsFrom(left);
  const fromRight = feedsFrom(right);
  const fromBehind = feedsFrom(behind);

  // A side feed with nothing behind bends the belt; with a straight feed too
  // it merges, which the art doesn't distinguish from straight.
  if (fromLeft && !fromRight && !fromBehind) return { row: CURVE[facing].left, caps };
  if (fromRight && !fromLeft && !fromBehind) return { row: CURVE[facing].right, caps };
  return { row: STRAIGHT[facing], caps };
}

export { STRAIGHT as STRAIGHT_ROW };
