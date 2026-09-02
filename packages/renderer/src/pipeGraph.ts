import { Dir4, toCardinal } from "./beltGraph.js";

/** The 16 real Factorio pipe connection variants (minus the
 *  `_disabled_visualization`/`_frozen`/`_window`/`_background` decorative
 *  duplicates this renderer doesn't model), confirmed by spike: rendered
 *  each of these sprites at high zoom and read off which side(s) of the
 *  tile actually show an open connection socket. Corner/T names follow
 *  Factorio's own convention directly — `corner_up_right` connects
 *  North+East, `t_up` connects every direction except South (the named
 *  direction is the one WITH a stub, not the missing one, for corners;
 *  for T-shapes the named direction is the odd-one-out stub, with the
 *  opposite side's connection implied by continuing straight through). */
export type PipeVariant =
  | "straight_vertical"
  | "straight_horizontal"
  | "corner_up_right"
  | "corner_up_left"
  | "corner_down_right"
  | "corner_down_left"
  | "t_up"
  | "t_down"
  | "t_left"
  | "t_right"
  | "cross"
  | "ending_up"
  | "ending_down"
  | "ending_left"
  | "ending_right"
  | "straight_vertical_single";

/** neighbor bitmask (N=1,E=2,S=4,W=8) -> variant key, built once at module
 *  load. Every one of the 16 possible masks maps to exactly one of
 *  Factorio's real sprite variants — there's no "unknown shape" case,
 *  since a pipe with 0/1/2/3/4 neighbors always has a corresponding real
 *  asset (the 0-neighbor case uses the same lone-pipe sprite as the
 *  fallback `straight_vertical_single`). */
const N = 1, E = 2, S = 4, W = 8;
const MASK_TO_VARIANT: Record<number, PipeVariant> = {
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

export interface PipeLookupEntity {
  entityNumber: number;
  name: string;
  x: number;
  y: number;
  /** True for pipes, pipe-to-ground, and heat-pipe — anything that
   *  presents an open connection point on all 4 sides at its own tile.
   *  pipe-to-ground is deliberately included even though only ONE of its
   *  sides is actually open (the side facing its own direction) — see
   *  isConnectedTowards below, which checks the neighbor's own facing for
   *  directional entities instead of assuming all 4 sides are live. */
  isPipeLike: boolean;
  /** Only meaningful for directional pipe-like entities (pipe-to-ground):
   *  the single side that's actually open. Undefined for plain pipes/
   *  heat-pipes, which connect on all 4 sides unconditionally. */
  openSide?: Dir4;
}

function offsetFor(dir: Dir4): { dx: number; dy: number } {
  switch (dir) {
    case Dir4.North: return { dx: 0, dy: -1 };
    case Dir4.East: return { dx: 1, dy: 0 };
    case Dir4.South: return { dx: 0, dy: 1 };
    case Dir4.West: return { dx: -1, dy: 0 };
  }
}

function opposite(dir: Dir4): Dir4 {
  return ((dir + 8) % 16) as Dir4;
}

/** A neighbor in direction `dir` counts as connected if it's pipe-like AND
 *  (it has no single open side, i.e. it's a plain pipe/heat-pipe that's
 *  open on all sides, OR its one open side faces back toward this tile). */
function isConnectedTowards(
  self: { x: number; y: number },
  dir: Dir4,
  positionIndex: Map<string, PipeLookupEntity>,
): boolean {
  const { dx, dy } = offsetFor(dir);
  const neighbor = positionIndex.get(`${self.x + dx},${self.y + dy}`);
  if (!neighbor?.isPipeLike) return false;
  if (neighbor.openSide === undefined) return true;
  return neighbor.openSide === opposite(dir);
}

/** Classifies one pipe tile's connection shape by inspecting its 4
 *  immediate neighbors — mirrors beltGraph.ts's classifyBelt in spirit,
 *  but pipes have no facing of their own (a plain pipe is symmetric), so
 *  the classification is a pure neighbor-bitmask lookup rather than a
 *  facing-relative left/right test. */
export function classifyPipe(
  self: { x: number; y: number },
  positionIndex: Map<string, PipeLookupEntity>,
): PipeVariant {
  let mask = 0;
  if (isConnectedTowards(self, Dir4.North, positionIndex)) mask |= N;
  if (isConnectedTowards(self, Dir4.East, positionIndex)) mask |= E;
  if (isConnectedTowards(self, Dir4.South, positionIndex)) mask |= S;
  if (isConnectedTowards(self, Dir4.West, positionIndex)) mask |= W;
  return MASK_TO_VARIANT[mask]!;
}

/** pipe-to-ground's single open side is its own facing direction — ported
 *  from teoxoy/factorio-blueprint-editor's checkFluidConnection (see the
 *  project's own "use reference renderer for ground truth" memory): its
 *  fluid_box's one "normal" pipe_connection sits at the entity's own tile
 *  (offset [0,0], confirmed by spike against the real dump) with
 *  connection.direction 0, so the match condition reduces to "the
 *  neighbor's own placed direction equals the direction pointing back from
 *  the neighbor to this tile" — i.e. the open side faces the SAME way the
 *  entity itself faces, not the opposite. (An earlier version of this
 *  function had the sign backwards — confirmed wrong live in-app: both
 *  ends of an underground-to-underground pair opened toward each other
 *  instead of outward toward their plain-pipe neighbors.) */
export function pipeToGroundOpenSide(direction: number): Dir4 {
  return toCardinal(direction);
}

/** Builds the `x,y -> entity` lookup classifyPipe needs, once per loaded
 *  blueprint. Pipes/pipe-to-ground/heat-pipe are always exactly 1x1-tile
 *  aligned, so integer-tile keys are exact. */
export function buildPipePositionIndex(
  entities: { entityNumber: number; name: string; x: number; y: number; direction: number }[],
  isPipeLike: (name: string) => boolean,
  isPipeToGround: (name: string) => boolean,
): Map<string, PipeLookupEntity> {
  const index = new Map<string, PipeLookupEntity>();
  for (const e of entities) {
    if (!isPipeLike(e.name)) continue;
    index.set(`${Math.round(e.x)},${Math.round(e.y)}`, {
      entityNumber: e.entityNumber,
      name: e.name,
      x: Math.round(e.x),
      y: Math.round(e.y),
      isPipeLike: true,
      openSide: isPipeToGround(e.name) ? pipeToGroundOpenSide(e.direction) : undefined,
    });
  }
  return index;
}

/** Precomputes classifyPipe's result for every plain pipe in the blueprint,
 *  once, mirroring buildBeltFrameCache in beltGraph.ts — the neighbor
 *  bitmask a pipe's variant depends on only changes when entities are
 *  placed/removed/rotated, not every frame, so re-running the 4-neighbor
 *  lookup on every visible pipe every frame is wasted work. Only plain
 *  pipes are cached: pipe-to-ground draws a single representative sprite
 *  (see render-catalog.ts) and never calls classifyPipe at all. */
export function buildPipeVariantCache(
  entities: { entityNumber: number; name: string; x: number; y: number }[],
  isPipeLike: (name: string) => boolean,
  positionIndex: Map<string, PipeLookupEntity>,
): Map<number, PipeVariant> {
  const cache = new Map<number, PipeVariant>();
  for (const e of entities) {
    if (!isPipeLike(e.name)) continue;
    const self = { x: Math.round(e.x), y: Math.round(e.y) };
    const entry = positionIndex.get(`${self.x},${self.y}`);
    if (entry?.openSide !== undefined) continue; // pipe-to-ground: no variant to cache
    cache.set(e.entityNumber, classifyPipe(self, positionIndex));
  }
  return cache;
}
