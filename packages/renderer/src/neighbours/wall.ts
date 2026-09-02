import { Dir, type NeighbourGrid } from "./grid.js";

export type WallSprite =
  | "single"
  | "straightVertical"
  | "straightHorizontal"
  | "cornerRight"
  | "cornerLeft"
  | "t"
  | "endingRight"
  | "endingLeft";

/** Factorio's wall art has no piece for a north-only neighbour, and the real
 *  game's cascade never tests north at all — a wall whose only neighbour is
 *  above it draws as `single`. Ported from the game's own ordering; the
 *  asymmetry is deliberate, not an oversight. */
export function classifyWall(
  x: number,
  y: number,
  grid: NeighbourGrid,
  isWallLike: (name: string) => boolean,
): WallSprite {
  const has = (dx: number, dy: number): boolean => {
    const n = grid.at(x + dx, y + dy);
    return n !== undefined && isWallLike(n.name);
  };
  const e = has(1, 0);
  const s = has(0, 1);
  const w = has(-1, 0);

  if (e && s && w) return "t";
  if (e && s) return "cornerRight";
  if (s && w) return "cornerLeft";
  if (e && w) return "straightHorizontal";
  if (e) return "endingRight";
  if (s) return "straightVertical";
  if (w) return "endingLeft";
  return "single";
}

/** Gates sit in a wall run and connect to the walls either side. */
export function isWallConnectable(name: string, hasWallGraphics: boolean): boolean {
  return hasWallGraphics || name === "gate";
}

export { Dir };
