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

  // True when the neighbour in `dir` is belt-like AND actually faces back
  // into this tile — not just that something sits there. A belt pointing
  // some other way isn't a real connection (e.g. a south-facing belt
  // dropping onto the middle of an unrelated west-facing row from the
  // side: the row doesn't face back north, so the south-facing belt still
  // needs its own end cap there, and the row draws as an unbroken straight
  // run with no merge art of its own).
  const feedsFrom = (dir: Cardinal): boolean => {
    const n = grid.towards(x, y, dir);
    return n !== undefined && isBeltLike(n.name) && toCardinal(n.direction) === opposite(dir);
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

  // Does the tile ahead of us actually take our output — i.e. is IT facing
  // away from us in a straight line, the only shape that continues a run
  // (a belt merely pointed some other way isn't fed by us, even sitting
  // right there). Belt-like curves and drops in are all still `direction
  // === facing` from directly ahead, since a curve or merge only bends
  // around its OWN input, not around what's feeding INTO the tile ahead.
  const feedsInto = (dir: Cardinal): boolean => {
    const n = grid.towards(x, y, dir);
    return n !== undefined && isBeltLike(n.name) && toCardinal(n.direction) === dir;
  };

  // A cap closes an end nothing continues onto, shifted a full tile toward
  // the neighbour it covers. The reference renderer always shifts toward
  // the belt's own behind/ahead — even for a curve's start cap, whose input
  // is to a side — so this matches that rather than shifting toward
  // inputSide, which only differs from `behind` on a curve.
  const caps: BeltCap[] = [];
  if (!feedsFrom(inputSide)) caps.push({ row: START_CAP[facing], ...offsetTowards(behind) });
  if (!feedsInto(facing)) caps.push({ row: END_CAP[facing], ...offsetTowards(facing) });

  return { row, caps };
}

function offsetTowards(dir: Cardinal): { dx: number; dy: number } {
  const { dx, dy } = step(dir);
  return { dx, dy };
}

export { STRAIGHT as STRAIGHT_ROW };
