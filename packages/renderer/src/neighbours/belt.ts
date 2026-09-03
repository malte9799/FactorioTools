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
 *  side-load decals. Side-loading has no art of its own. Row numbers ported
 *  from the reference renderer's getBeltSpriteFromData (teoxoy /
 *  factorio-blueprint-editor), converting its 1-indexed starting_ and
 *  ending_ fallbacks (13, 18, ...) to this pipeline's 0-indexed rows. */
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
 *  the run would otherwise continue onto. */
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

  // A cap closes an end nothing continues onto, shifted a full tile toward
  // the neighbour it covers. The reference renderer always shifts toward
  // the belt's own behind/ahead — even for a curve's start cap, whose input
  // is to a side — so this matches that rather than shifting toward
  // inputSide, which only differs from `behind` on a curve.
  const caps: BeltCap[] = [];
  if (!occupied(inputSide)) caps.push({ row: START_CAP[facing], ...offsetTowards(behind) });
  if (!occupied(facing)) caps.push({ row: END_CAP[facing], ...offsetTowards(facing) });

  return { row, caps };
}

function offsetTowards(dir: Cardinal): { dx: number; dy: number } {
  const { dx, dy } = step(dir);
  return { dx, dy };
}

export { STRAIGHT as STRAIGHT_ROW };
