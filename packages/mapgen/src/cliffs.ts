/** Cliff placement.
 *
 *  The game lays cliffs on a grid of 4x4-tile cells. Each grid vertex gets a
 *  level from `cliff_elevation` (which contour band it is in); a cell side
 *  whose two vertices differ in level is crossed by a cliff line, provided
 *  `cliffiness` averages above 0.5 over the two and neither lies below
 *  zero elevation. A cell with crossings holds
 *  one cliff piece running from one side to another, or ending in the cell
 *  where only one side is crossed. Worked out from cliffs the game placed;
 *  see the fixture in test/. */

/** Cell sides in the order the direction codes use. */
export const SIDES = ["north", "east", "south", "west"] as const;
/** "No side": the cliff line starts or ends inside the cell. */
export const NO_SIDE = 4;

/** A cliff piece as one byte: 0 for none, else 1 + from * 5 + to, with from
 *  and to indexing `SIDES` or being `NO_SIDE`. */
export function cliffCode(from: number, to: number): number {
  return 1 + from * 5 + to;
}

export function cliffFrom(code: number): number {
  return Math.floor((code - 1) / 5);
}

export function cliffTo(code: number): number {
  return (code - 1) % 5;
}

/** The game's name for a piece: "west-to-east", "none-to-south", ... */
export function cliffName(code: number): string | null {
  if (!code) return null;
  const name = (side: number): string => (side === NO_SIDE ? "none" : SIDES[side]!);
  return `${name(cliffFrom(code))}-to-${name(cliffTo(code))}`;
}

/** Pieces for a block of cells from the values at its vertices.
 *
 *  `elevation` and `cliffiness` hold `(cols + 1) * (rows + 1)` vertices,
 *  row-major. A piece runs with the high ground on its left, so a line
 *  entering through the north side has the higher vertex to the east. */
export function cliffPieces(
  elevation: Float32Array,
  cliffiness: Float32Array,
  cols: number,
  rows: number,
  elevation0: number,
  interval: number,
  cellX0?: number,
  cellY0?: number,
): Uint8Array {
  // Where the block's first cell stands on the game's grid of cells, when
  // the cells are the game's own: that decides which sides lie on a chunk's
  // edge.
  const chunked = cellX0 !== undefined && cellY0 !== undefined;
  const out = new Uint8Array(cols * rows);
  const stride = cols + 1;
  // Level 0 is everything below the first cliff elevation: ground lower
  // than that never gets a cliff, however far down it goes (Fulgora's sea
  // floor drops through several intervals).
  const level = (v: number): number => Math.max(0, Math.floor((v - elevation0) / interval) + 1);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      const nw = level(elevation[a]!);
      const ne = level(elevation[b]!);
      const sw = level(elevation[c]!);
      const se = level(elevation[d]!);
      if (nw === ne && ne === sw && sw === se) continue;
      // A side is only crossed between two vertices at or above zero (sea
      // level, whatever the planet's sea is made of), and then only if the
      // cliffiness midway between them is above a half.
      const cliffy = (p: number, q: number): boolean => elevation[p]! >= 0 && elevation[q]! >= 0 && cliffiness[p]! + cliffiness[q]! > 1;
      let from = NO_SIDE;
      let to = NO_SIDE;
      // Walking the sides clockwise from the west: a rise along the walk is
      // where the line enters, a drop where it leaves. Where more than two
      // sides are crossed (levels meeting diagonally, or three levels in
      // one cell) the later side wins, as it does in the game. The game
      // works a chunk of 8 x 8 cells at a time and comes to the sides on a
      // chunk's west and north edges last. Read off maps whose every cell
      // is crossed on all four sides.
      const edgeX = chunked && ((cellX0! + i) & 7) === 0;
      const edgeY = chunked && ((cellY0! + j) & 7) === 0;
      const west = (): void => {
        if (sw !== nw && cliffy(c, a)) nw > sw ? (from = 3) : (to = 3);
      };
      const north = (): void => {
        if (nw !== ne && cliffy(a, b)) ne > nw ? (from = 0) : (to = 0);
      };
      if (!edgeX) west();
      if (!edgeY) north();
      if (ne !== se && cliffy(b, d)) se > ne ? (from = 1) : (to = 1);
      if (se !== sw && cliffy(d, c)) sw > se ? (from = 2) : (to = 2);
      if (edgeX) west();
      if (edgeY) north();
      if (from === NO_SIDE && to === NO_SIDE) continue;
      out[j * cols + i] = cliffCode(from, to);
    }
  }
  return out;
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** Drop the pieces `removed` names, then end every line that its neighbour
 *  does not take up: one that led into a dropped or empty cell, or into a
 *  cell whose own piece runs elsewhere. The game does the same when ore
 *  takes a cliff's place, and where lines crowd each other. */
export function trimCliffs(pieces: Uint8Array, cols: number, rows: number, removed: (index: number) => boolean): void {
  for (let k = 0; k < pieces.length; k++) if (pieces[k] && removed(k)) pieces[k] = 0;
  const before = pieces.slice();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const code = before[j * cols + i]!;
      if (!code) continue;
      const open = (side: number, entering: boolean): number => {
        if (side === NO_SIDE) return side;
        const ni = i + DX[side]!;
        const nj = j + DY[side]!;
        // Beyond the block nothing is known; leave the line running.
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) return side;
        const next = before[nj * cols + ni]!;
        if (!next) return NO_SIDE;
        // The neighbour meets this side with its opposite one, leaving
        // through it where this piece enters.
        const opposite = (side + 2) % 4;
        return (entering ? cliffTo(next) : cliffFrom(next)) === opposite ? side : NO_SIDE;
      };
      const from = open(cliffFrom(code), true);
      const to = open(cliffTo(code), false);
      pieces[j * cols + i] = from === NO_SIDE && to === NO_SIDE ? 0 : cliffCode(from, to);
    }
  }
}

/** Where a side meets the cell, in cell units (0..1), and the cell centre. */
const ANCHOR_X = [0.5, 1, 0.5, 0, 0.5];
const ANCHOR_Y = [0, 0.5, 1, 0.5, 0.5];

/** Whether a sample `n` x `n` per cell, at column `sx` and row `sy`, lies on
 *  the piece's line. The line is about half a cell thick. */
export function onCliffLine(code: number, n: number, sx: number, sy: number): boolean {
  if (n <= 1) return true;
  const from = cliffFrom(code);
  const to = cliffTo(code);
  const ax = ANCHOR_X[from]!;
  const ay = ANCHOR_Y[from]!;
  const bx = ANCHOR_X[to]!;
  const by = ANCHOR_Y[to]!;
  const px = (sx + 0.5) / n;
  const py = (sy + 0.5) / n;
  const lx = bx - ax;
  const ly = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * lx + (py - ay) * ly) / (lx * lx + ly * ly)));
  return Math.hypot(px - (ax + lx * t), py - (ay + ly * t)) <= 0.26;
}

/** An oriented collision box as the game stores it: two corners and a
 *  rotation in turns about the box centre. */
export type OrientedBox = [[number, number], [number, number], number];

export function pointInBox(box: OrientedBox, originX: number, originY: number, px: number, py: number, margin: number): boolean {
  const [[x1, y1], [x2, y2], turns] = box;
  const dx = px - (originX + (x1 + x2) / 2);
  const dy = py - (originY + (y1 + y2) / 2);
  const angle = -turns * 2 * Math.PI;
  const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(rx) <= (x2 - x1) / 2 + margin && Math.abs(ry) <= (y2 - y1) / 2 + margin;
}
