import { Dir4 } from "./beltGraph.js";

/** Which of WallGraphics' 8 base sprites to draw. This is a direct port of
 *  teoxoy/factorio-blueprint-editor's draw_wall (spriteDataBuilder.ts) —
 *  ground truth pulled from a working, widely-used reference renderer
 *  rather than re-derived from sprite reading (see the project's own
 *  "verify sprite reads in-app" rule: an earlier attempt at this
 *  classifier, built from live in-app screenshots alone, got several cases
 *  wrong that this port corrects). Notably the real cascade is NOT a full
 *  16-case bitmask lookup — several combinations (e.g. a north-only
 *  neighbor) fall through to `single` rather than getting a dedicated
 *  shape, which looked surprising until confirmed against the reference
 *  implementation. */
export type WallSprite = "single" | "straightVertical" | "straightHorizontal" | "cornerRight" | "cornerLeft" | "t" | "endingRight" | "endingLeft";

export interface WallLookupEntity {
  entityNumber: number;
  name: string;
  x: number;
  y: number;
  /** True for walls AND gates — a gate sitting in a wall run connects to
   *  the walls on either side of it in the real game. */
  isWallLike: boolean;
}

function offsetFor(dir: Dir4): { dx: number; dy: number } {
  switch (dir) {
    case Dir4.North: return { dx: 0, dy: -1 };
    case Dir4.East: return { dx: 1, dy: 0 };
    case Dir4.South: return { dx: 0, dy: 1 };
    case Dir4.West: return { dx: -1, dy: 0 };
  }
}

/** Classifies one wall tile's connection shape from its 4 immediate
 *  neighbors. Port of draw_wall's own if/else cascade (see this file's own
 *  top doc comment) — N/E/S/W booleans checked in that exact order and
 *  precedence, not a bitmask table, since the real logic isn't symmetric
 *  across all 16 combinations. */
export function classifyWall(self: { x: number; y: number }, positionIndex: Map<string, WallLookupEntity>): WallSprite {
  const has = (dir: Dir4) => {
    const { dx, dy } = offsetFor(dir);
    return positionIndex.get(`${self.x + dx},${self.y + dy}`)?.isWallLike ?? false;
  };
  // A north neighbor is never checked, matching draw_wall exactly — a
  // wall with ONLY a north neighbor falls through every branch below to
  // `single`. Surprising, but confirmed against the reference rather than
  // an oversight: this file's own top doc comment covers why.
  const e = has(Dir4.East), s = has(Dir4.South), w = has(Dir4.West);
  if (e && s && w) return "t";
  if (e && s) return "cornerRight";
  if (s && w) return "cornerLeft";
  if (e && w) return "straightHorizontal";
  if (e) return "endingRight";
  if (s) return "straightVertical";
  if (w) return "endingLeft";
  return "single";
}

/** Builds the `x,y -> entity` lookup classifyWall needs, once per loaded
 *  blueprint. Walls/gates are always exactly 1x1-tile aligned. */
export function buildWallPositionIndex(
  entities: { entityNumber: number; name: string; x: number; y: number }[],
  isWallLike: (name: string) => boolean,
): Map<string, WallLookupEntity> {
  const index = new Map<string, WallLookupEntity>();
  for (const e of entities) {
    if (!isWallLike(e.name)) continue;
    index.set(`${Math.round(e.x)},${Math.round(e.y)}`, {
      entityNumber: e.entityNumber,
      name: e.name,
      x: Math.round(e.x),
      y: Math.round(e.y),
      isWallLike: true,
    });
  }
  return index;
}

/** Precomputes classifyWall's result for every wall in the blueprint, once,
 *  mirroring buildBeltFrameCache/buildPipeVariantCache — the neighbor
 *  bitmask a wall's sprite depends on only changes when entities are
 *  placed/removed, not every frame. Gates are indexed as neighbors (see
 *  WallLookupEntity's own doc comment) but never cached themselves — they
 *  have their own GateRenderer with no neighbor-classification concept. */
export function buildWallVariantCache(
  entities: { entityNumber: number; name: string; x: number; y: number }[],
  isWall: (name: string) => boolean,
  positionIndex: Map<string, WallLookupEntity>,
): Map<number, WallSprite> {
  const cache = new Map<number, WallSprite>();
  for (const e of entities) {
    if (!isWall(e.name)) continue;
    cache.set(e.entityNumber, classifyWall({ x: Math.round(e.x), y: Math.round(e.y) }, positionIndex));
  }
  return cache;
}
