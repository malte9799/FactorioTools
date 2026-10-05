import type { PlacedEntity } from "@factoriotools/engine";

/** Cargo hubs and bays grow into one structure. The game plates the outline
 *  of the whole group with wall and corner pieces and spans every seam
 *  between two of its members with a bridge, all laid out on a grid of 2x2-
 *  tile cells — a bay is 2x2 of them, a hub 4x4, and both snap to that grid
 *  when built.
 *
 *  The game's own rule is not published. This is the one FBSR
 *  (demodude4u/Factorio-FBSR, CargoBayConnectionsRendering) arrived at, read
 *  off the grid rather than once per entity so that a junction of several
 *  entities is drawn by exactly one of them:
 *
 *  - a cell on the outline gets a wall along each open side whose two
 *    flanking cells are taken, an outer corner where two adjacent sides are
 *    open, and an inner corner where two adjacent sides are taken but the
 *    cell diagonally between them is not;
 *  - a point where four taken cells meet gets a wide bridge across the seam
 *    running through it, or a crossing where seams run both ways;
 *  - a seam a single cell long, with no such point at either end, gets a
 *    narrow bridge at its middle. */

/** Edge length of one connection cell, in tiles. */
export const CARGO_CELL = 2;

export interface CargoBayPiece {
  /** One of the CargoBayConnections shape names, e.g. `top_wall`. */
  shape: string;
  /** Where the piece is anchored, as an offset from its entity's centre. */
  x: number;
  y: number;
  /** Stable per spot — picks which of the shape's interchangeable looks is
   *  drawn there, so a blueprint always renders the same way. */
  seed: number;
}

/** What the grid needs to know about a hub or bay prototype. */
export interface CargoBayShape {
  footprint: [number, number];
  /** Set on hubs: the kind of surface that hub is built on. */
  surface?: "planet" | "space";
}

function cellOf(tile: number): number {
  return Math.floor(tile / CARGO_CELL);
}

/** Which entity owns each connection cell. */
export class CargoBayGrid {
  private owners = new Map<string, number>();
  /** Whether the blueprint stands on a space platform, where a cargo bay
   *  wears its platform art instead of its planet art. */
  spacePlatform = false;

  ownerAt(cx: number, cy: number): number | undefined {
    return this.owners.get(`${cx},${cy}`);
  }

  claim(entity: PlacedEntity, [w, h]: [number, number]): void {
    const { cx0, cy0, cols, rows } = cellsOf(entity, w, h);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) this.owners.set(`${cx0 + i},${cy0 + j}`, entity.entityNumber);
    }
  }
}

function cellsOf(entity: { x: number; y: number }, w: number, h: number) {
  return {
    // Half a cell in from the corner, so a float-noisy edge still lands in
    // the cell it belongs to.
    cx0: cellOf(entity.x - w / 2 + CARGO_CELL / 2),
    cy0: cellOf(entity.y - h / 2 + CARGO_CELL / 2),
    cols: Math.max(1, Math.round(w / CARGO_CELL)),
    rows: Math.max(1, Math.round(h / CARGO_CELL)),
  };
}

/** `floorInSpace` is the fallback for a blueprint with bays but no hub: its
 *  floor tiles are then the only hint of where it was built. */
export function buildCargoBayGrid(
  entities: PlacedEntity[],
  shapeOf: (name: string) => CargoBayShape | undefined,
  floorInSpace = false,
): CargoBayGrid {
  const grid = new CargoBayGrid();
  let planetHub = false;
  let spaceHub = false;
  for (const e of entities) {
    const shape = shapeOf(e.name);
    if (!shape) continue;
    grid.claim(e, shape.footprint);
    if (shape.surface === "space") spaceHub = true;
    if (shape.surface === "planet") planetHub = true;
  }
  grid.spacePlatform = spaceHub || (!planetHub && floorInSpace);
  return grid;
}

function seedOf(x: number, y: number): number {
  // Anchors sit on whole and half cells, so doubling makes them integers.
  let h = Math.imul(Math.round(x * 2) ^ 0x9e3779b1, 0x85ebca6b);
  h = Math.imul((h ^ (h >>> 15)) + Math.round(y * 2), 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A cell's four sides clockwise from the top, and the corner each shares
 *  with the next one round. */
const SIDES = [
  { name: "top", dx: 0, dy: -1, corner: "top_right" },
  { name: "right", dx: 1, dy: 0, corner: "bottom_right" },
  { name: "bottom", dx: 0, dy: 1, corner: "bottom_left" },
  { name: "left", dx: -1, dy: 0, corner: "top_left" },
] as const;

/** Every connection piece one hub or bay draws. A seam is drawn by the
 *  entity below or right of it, a junction by the one at its bottom right. */
export function cargoBayPieces(
  entity: { entityNumber: number; x: number; y: number },
  [w, h]: [number, number],
  grid: CargoBayGrid,
): CargoBayPiece[] {
  const { cx0, cy0, cols, rows } = cellsOf(entity, w, h);
  // The entity owns its own cells whether or not the grid has heard of it —
  // a placement ghost previews its plating before it is built.
  const owner = (cx: number, cy: number) =>
    cx >= cx0 && cx < cx0 + cols && cy >= cy0 && cy < cy0 + rows ? entity.entityNumber : grid.ownerAt(cx, cy);
  const taken = (cx: number, cy: number) => owner(cx, cy) !== undefined;

  const pieces: CargoBayPiece[] = [];
  const add = (shape: string, x: number, y: number) =>
    pieces.push({ shape, x, y, seed: seedOf(entity.x + x, entity.y + y) });

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i > 0 && i < cols - 1 && j > 0 && j < rows - 1) continue;
      const cx = cx0 + i;
      const cy = cy0 + j;
      const x = (i + 0.5) * CARGO_CELL - w / 2;
      const y = (j + 0.5) * CARGO_CELL - h / 2;

      const side = SIDES.map((s) => taken(cx + s.dx, cy + s.dy));
      SIDES.forEach((s, k) => {
        const next = SIDES[(k + 1) % 4]!;
        const [here, after, opposite, before] = [side[k], side[(k + 1) % 4], side[(k + 2) % 4], side[(k + 3) % 4]];
        if (!here && after && before) add(`${s.name}_wall`, x, y);
        if (!here && !after && opposite && before) add(`${s.corner}_outer_corner`, x, y);
        if (here && after && !taken(cx + s.dx + next.dx, cy + s.dy + next.dy)) add(`${s.corner}_inner_corner`, x, y);
      });

      // The point at this cell's top left corner, when this is the bottom
      // right of the four cells round it.
      if (i === 0 || j === 0) {
        const [tl, tr, bl] = [owner(cx - 1, cy - 1), owner(cx, cy - 1), owner(cx - 1, cy)];
        if (tl !== undefined && tr !== undefined && bl !== undefined) {
          const seamAcross = tl !== bl || tr !== entity.entityNumber;
          const seamDown = tl !== tr || bl !== entity.entityNumber;
          const shape = seamAcross && seamDown ? "bridge_crossing" : seamAcross ? "bridge_vertical_wide" : seamDown ? "bridge_horizontal_wide" : undefined;
          if (shape) add(shape, x - CARGO_CELL / 2, y - CARGO_CELL / 2);
        }
      }

      // A seam one cell long: neither of its ends is a point four cells meet at.
      if (j === 0 && side[0]) {
        const leftEnd = taken(cx - 1, cy - 1) && taken(cx - 1, cy);
        const rightEnd = taken(cx + 1, cy - 1) && taken(cx + 1, cy);
        if (!leftEnd && !rightEnd) add("bridge_vertical_narrow", x, y - CARGO_CELL / 2);
      }
      if (i === 0 && side[3]) {
        const topEnd = taken(cx - 1, cy - 1) && taken(cx, cy - 1);
        const bottomEnd = taken(cx - 1, cy + 1) && taken(cx, cy + 1);
        if (!topEnd && !bottomEnd) add("bridge_horizontal_narrow", x - CARGO_CELL / 2, y);
      }
    }
  }
  return pieces;
}
