import { CARDINALS, Dir, opposite, step, toCardinal, type Cardinal, type NeighbourGrid, type Neighbour } from "./grid.js";

/** What classifyPipe needs from a connection-point network — implemented by
 *  both FluidNetwork (for plain pipes) and HeatNetwork (for heat pipes),
 *  kept separate classes since the two networks must never cross-match. */
export interface ConnectionNetwork {
  hasConnectionFacing(x: number, y: number, direction: Cardinal): boolean;
}

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
  network?: ConnectionNetwork,
): string {
  let mask = 0;
  for (const dir of CARDINALS) {
    const n = grid.towards(x, y, dir);
    if (n && isPipeLike(n.name)) {
      const open = openSide(n);
      if (open === undefined || open === opposite(dir)) {
        mask |= BIT[dir];
        continue;
      }
    }
    // Not a plain pipe-like neighbour (or a facing-restricted one that
    // doesn't open this way) — a machine/storage-tank/etc's own fluid (or
    // heat) box can still have a real connection point right there (e.g. a
    // pump's socket one tile off its own centre, or a reactor's heat-buffer
    // socket), which the single-tile grid check above has no way to see.
    // The network's own point-to-point match (the same one pipe-covers/
    // heat-connection-patches uses) answers that directly: is there a
    // connection point at this neighbour tile facing back at (x,y)?
    if (network?.hasConnectionFacing(x + step(dir).dx, y + step(dir).dy, opposite(dir))) {
      mask |= BIT[dir];
    }
  }
  return MASK_TO_VARIANT[mask]!;
}
