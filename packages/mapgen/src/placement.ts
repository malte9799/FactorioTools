/** Entity placement, rolled the way the game rolls it.
 *
 *  A probability alone does not say where an oil well stands. The game
 *  decides chunk by chunk, from one random stream per chunk:
 *
 *  - The stream is the game's RNG seeded from the chunk's coordinates alone.
 *    It does not depend on the map seed.
 *  - Entities take turns in the order of their autoplace `order` string;
 *    entities sharing an order roll once between them, for whichever has the
 *    highest probability on the tile (the higher richness on a tie).
 *  - A turn walks the chunk's tiles from the last to the first and draws one
 *    number for every tile the entity could stand on (one it shares no
 *    collision layer with: water for fish, land for most of the rest),
 *    whether or not its probability there is above zero.
 *  - A draw below the probability is a placement attempt. An entity that is
 *    not snapped to the grid then draws two more numbers for where in the
 *    tile it lands. The attempt fails if the spot is taken.
 *
 *  So every draw before an entity's turn matters to it, and the whole chunk
 *  has to be replayed to place any one thing. Worked out by putting a probe
 *  entity into the real game and solving for the generator's state from
 *  where the probes landed. */
import { Rng } from "./rng.js";

export interface PlacementEntity {
  name: string;
  type: string;
  /** Node of its probability expression. */
  probability: number;
  /** Node of its richness expression. */
  richness: number;
  offGrid: boolean;
  /** Half-extents of its collision box around its position. */
  box: [[number, number], [number, number]];
  /** By tile type: 1 where the entity cannot stand (water for most, land
   *  for fish). */
  blocked: Uint8Array;
}

/** One successful roll. Whether it became an entity depends on collisions. */
export interface Attempt {
  /** Index into the entity list. */
  entity: number;
  /** Tile the roll was for. */
  tileX: number;
  tileY: number;
  /** Richness expression at that tile. */
  richness: number;
  /** The two position draws of an off-grid entity, as fractions of 2^32. */
  offsetA: number;
  offsetB: number;
}

export const CHUNK = 32;

/** Seed of a chunk's placement stream. */
export function chunkStreamSeed(chunkX: number, chunkY: number): number {
  return (Math.imul(chunkY, 0x1ee3) + Math.imul(chunkX, 0x1eef) + 0x3fbe2c) >>> 0;
}

/** Entities sharing an `order`, in the order the game takes them. */
export function placementGroups(entities: { order: string }[]): number[][] {
  const byOrder = new Map<string, number[]>();
  entities.forEach((e, i) => {
    const group = byOrder.get(e.order);
    if (group) group.push(i);
    else byOrder.set(e.order, [i]);
  });
  // Plain code-unit comparison, as the game compares order strings.
  return [...byOrder.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((order) => byOrder.get(order)!);
}

/** Replay one chunk's stream.
 *
 *  `probability[e]` and `richness[e]` hold entity e's values for the chunk's
 *  1024 tiles, row-major; `tile[k]` is the type of tile k. Returns
 *  every placement attempt in the order the game makes them. */
export function rollChunk(
  chunkX: number,
  chunkY: number,
  entities: PlacementEntity[],
  groups: number[][],
  probability: Float32Array[],
  richness: Float32Array[],
  tile: Uint8Array,
): Attempt[] {
  const rng = new Rng(chunkStreamSeed(chunkX, chunkY));
  const attempts: Attempt[] = [];
  const TO_UNIT = 2 ** -32;
  for (const group of groups) {
    const blocked = entities[group[0]!]!.blocked;
    for (let k = CHUNK * CHUNK - 1; k >= 0; k--) {
      if (blocked[tile[k]!]) continue;
      const u = rng.next() * TO_UNIT;
      let best = group[0]!;
      let p = probability[best]![k]!;
      for (let g = 1; g < group.length; g++) {
        const candidate = probability[group[g]!]![k]!;
        // On a tie the richer one wins: where two full-strength ore patches
        // overlap, each tile goes to whichever would hold more there.
        if (candidate > p || (candidate === p && richness[group[g]!]![k]! > richness[best]![k]!)) {
          p = candidate;
          best = group[g]!;
        }
      }
      if (!(u < p)) continue;
      const entity = entities[best]!;
      const offsetA = entity.offGrid ? rng.next() * TO_UNIT : 0.5;
      const offsetB = entity.offGrid ? rng.next() * TO_UNIT : 0.5;
      attempts.push({
        entity: best,
        tileX: chunkX * CHUNK + (k % CHUNK),
        tileY: chunkY * CHUNK + Math.floor(k / CHUNK),
        richness: richness[best]![k]!,
        offsetA,
        offsetB,
      });
    }
  }
  return attempts;
}
