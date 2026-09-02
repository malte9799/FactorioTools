import { CARDINALS, Dir, opposite, toCardinal, type Cardinal, type NeighbourGrid, type Neighbour } from "./grid.js";

const N = 1, E = 2, S = 4, W = 8;

/** Neighbour bitmask to Factorio's own pipe sprite names. Corner names give
 *  the two sides that connect; T names give the odd stub out. */
const MASK_TO_VARIANT: Record<number, string> = {
  [0]: "straight_vertical_single",
  [N]: "ending_up",
  [E]: "ending_right",
  [S]: "ending_down",
  [W]: "ending_left",
  [N | S]: "straight_vertical",
  [E | W]: "straight_horizontal",
  [N | E]: "corner_up_right",
  [N | W]: "corner_up_left",
  [S | E]: "corner_down_right",
  [S | W]: "corner_down_left",
  [N | E | W]: "t_up",
  [S | E | W]: "t_down",
  [N | S | W]: "t_left",
  [N | S | E]: "t_right",
  [N | E | S | W]: "cross",
};

const BIT: Record<Cardinal, number> = { [Dir.North]: N, [Dir.East]: E, [Dir.South]: S, [Dir.West]: W };

/** A pipe-to-ground opens only on the side it faces; everything else
 *  pipe-like is open on all four. */
function openSide(n: Neighbour): Cardinal | undefined {
  return n.name === "pipe-to-ground" ? toCardinal(n.direction) : undefined;
}

export function classifyPipe(
  x: number,
  y: number,
  grid: NeighbourGrid,
  isPipeLike: (name: string) => boolean,
): string {
  let mask = 0;
  for (const dir of CARDINALS) {
    const n = grid.towards(x, y, dir);
    if (!n || !isPipeLike(n.name)) continue;
    const open = openSide(n);
    if (open === undefined || open === opposite(dir)) mask |= BIT[dir];
  }
  return MASK_TO_VARIANT[mask]!;
}
