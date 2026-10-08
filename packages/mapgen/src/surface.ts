/** A generated planet surface for one seed: what the seed viewer asks.
 *
 *  Wraps the compiler and evaluator behind map-shaped questions: which tile
 *  is here, where are the ore patches, how much is in one, where can enemies
 *  spawn. Everything is derived from the planet's autoplace rules. */
import { Program, type Node, type Op } from "./compiler.js";
import { Evaluator } from "./evaluator.js";
import { compileSettings, type AutoplaceEntry, type MapGenData, type MapGenOptions } from "./settings.js";
import type { SpotParams } from "./spot.js";
import { cliffName, cliffPieces, onCliffLine, pointInBox, trimCliffs, type OrientedBox } from "./cliffs.js";
import { CHUNK, placementGroups, rollChunk, type Attempt, type PlacementEntity } from "./placement.js";

export type Rgb = [number, number, number];

export interface TileLayer {
  name: string;
  color: Rgb;
  water: boolean;
  /** No resource can stand here. Water on most planets; not on Aquilo,
   *  whose oil and brine sit in the open ocean. */
  noResources: boolean;
}

export interface ResourceLayer {
  name: string;
  color: Rgb;
  /** Share of patch tiles that pass the resource's random penalty: 1 for an
   *  ore that fills its patch, 1/48 for oil wells. */
  chance: number;
  /** Stands as separate wells in its field rather than covering it: oil,
   *  and anything else too wide for one tile or thinned out by chance. */
  wells: boolean;
  /** Amount that counts as 100% yield, for an infinite resource. */
  normalYield: number | null;
}

/** A grid of samples, row-major. */
export interface SampleGrid {
  cols: number;
  rows: number;
  /** Index into `tiles`. */
  tile: Uint8Array;
  /** 0 for none, else index into `resources` plus one. */
  resource: Uint8Array;
  /** How likely a spawner is on this tile, 0-255 (0 = cannot spawn). */
  enemy: Uint8Array;
  /** Tree cover, 0-255. All zero unless trees were requested. */
  trees: Uint8Array;
  /** 1 where a cliff runs. All zero unless cliffs were requested. */
  cliff: Uint8Array;
  /** 0 for none, else index into `decor` plus one: a rock, a ruin. All
   *  zero unless decor was requested. */
  decor: Uint8Array;
  /** 1 on the border of a territory (a Vulcanus demolisher's). All zero
   *  unless territories were requested. */
  territory: Uint8Array;
}

export interface SampleOptions {
  /** Trees cost about as much as everything else together. */
  trees?: boolean;
  cliffs?: boolean;
  /** Show a sparse resource (oil) as the wells the game places, not as the
   *  field they stand in. */
  wells?: boolean;
  /** Rocks, ruins and other fixtures: up close each one the game places,
   *  from further out a scatter as dense as they stand. */
  decor?: boolean;
  /** The borders of the territories the planet's guardians keep. */
  territories?: boolean;
}

/** One connected patch of a resource, measured tile by tile. */
export interface PatchMeasure extends PatchAmount {
  /** Index into `resources`. */
  resource: number;
  /** Bounding box of the patch, in tiles. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** `width * height` flags, row-major: 1 where the patch is. */
  mask: Uint8Array;
  /** False when the patch was larger than the limit and was cut off. */
  complete: boolean;
  /** For a sparse resource, the wells the game places in the field. */
  wells: PlacedResource[];
}

/** A resource entity the game places: an ore tile or an oil well. */
export interface PlacedResource {
  /** Index into `resources`. */
  resource: number;
  /** Tile it is centred on. */
  x: number;
  y: number;
  amount: number;
}

/** A kind of rock, ruin or other fixture the game scatters over the map. */
export interface DecorLayer {
  name: string;
  color: Rgb;
}

export interface PlacedDecor {
  /** Index into `decor`. */
  decor: number;
  /** Where it stands, in tiles. */
  x: number;
  y: number;
  /** Its footprint about that point. */
  box: [[number, number], [number, number]];
}

/** The game's map colours for layers that are not tiles or resources. */
export interface LayerColors {
  tree: Rgb;
  enemy: Rgb;
  cliff: Rgb;
}

export interface ResourcePatch {
  /** Index into `resources`. */
  resource: number;
  x: number;
  y: number;
  /** Radius of the patch before its outline is roughened. */
  radius: number;
  /** One of the guaranteed patches around the starting position. */
  starting: boolean;
}

export interface PatchAmount {
  /** Expected total: ore amount, or summed yield for a sparse resource. */
  amount: number;
  /** Tiles the patch covers. */
  tiles: number;
  /** Expected number of entities for a sparse resource (oil wells). */
  entities: number;
}

export interface EnemyBase {
  x: number;
  y: number;
  radius: number;
}

export interface Probe {
  x: number;
  y: number;
  tile: string;
  elevation: number;
  resource: string | null;
  /** Amount this tile would hold. */
  richness: number;
  enemy: number;
}

const BATCH = 1024;
/** `cliff_smoothing` where a planet's settings leave it out. */
const DEFAULT_CLIFF_SMOOTHING = 1;
/** The vertices of a chunk, of 0 to 8 along an axis, that keep their own
 *  cliff elevation when it is smoothed. */
const CLIFF_KNOTS = [0, 4, 7, 8];

/** The knots either side of vertex `v` (an index along an axis, counted from
 *  a chunk's edge) and how far `v` is from the first towards the second. */
function knotSpan(v: number): [number, number, number] {
  const base = Math.floor(v / 8) * 8;
  const local = v - base;
  for (let k = 0; k + 1 < CLIFF_KNOTS.length; k++) {
    const a = CLIFF_KNOTS[k]!;
    const b = CLIFF_KNOTS[k + 1]!;
    if (local === a) return [v, v, 0];
    if (local < b) return [base + a, base + b, (local - a) / (b - a)];
  }
  return [v, v, 0];
}

/** Coarsest sampling at which cliffs are still worked out cell by cell. */
const EXACT_CLIFF_STEP = 16;
/** How wary the quick pass over cliff elevation is: a block is left alone
 *  only if its corners clear every level change by this many times the
 *  difference between them. */
const QUICK_CLIFF_MARGIN = 1;
const WATER = /water|lava|ocean|ammoniacal/;
/** Coarsest sampling at which each rock and ruin is placed as the game
 *  places it; beyond that they are a scatter of the right density. */
const EXACT_DECOR_STEP = 1;

/** A fixed number in [0, 1) for a tile, for scatters that must come out
 *  the same however the map is cut into pieces. */
function scatter(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Entity types drawn as fixtures of the landscape. */
const DECOR_TYPES = new Set(["simple-entity", "lightning-attractor"]);
/** The game's map colour for one that names none. */
const DECOR_COLOR: Rgb = [129, 105, 78];
/** What a cliff collides with where the data does not say: the game's
 *  default for the type. */
const CLIFF_LAYERS = ["item", "meltable", "object", "player", "water_tile", "is_object", "is_lower_object"];
/** A spawner probability at or above this draws at full strength. */
const ENEMY_FULL = 0.25;

/** Noise functions a planet needs that are not implemented, by name; empty
 *  when the planet can be generated. Fulgora and Aquilo are built on the
 *  Voronoi functions, whose point placement has not been worked out. */
export function unsupportedFunctions(data: MapGenData, planet: string): string[] {
  const mgs = data.planets[planet]?.map_gen_settings ?? {};
  const program = new Program(data, compileSettings(data, { seed: 0, planet }));
  const controls = new Set(Object.keys(mgs.autoplace_controls ?? {}));
  const listed = new Set(Object.keys(mgs.autoplace_settings?.entity?.settings ?? {}));
  const roots = Object.keys(mgs.autoplace_settings?.tile?.settings ?? {}).map((name) => program.named(`tile:${name}:probability`));
  for (const [name, a] of Object.entries(data.autoplace.entity)) {
    if (listed.has(name) || (a.control !== undefined && controls.has(a.control))) roots.push(program.named(`entity:${name}:probability`));
  }
  const missing = new Set<string>();
  const seen = new Set<number>();
  const visit = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = program.nodes[id]!;
    for (const a of node.args) visit(a);
    if (node.op === "spot") for (const key of ["density", "quantity", "radius", "favorability"] as const) visit((node.p as SpotParams)[key]);
    if (node.op === "multisample") visit(node.p.expr as number);
  };
  roots.forEach(visit);
  return [...missing].sort();
}

/** The tile a position gets: the highest probability, the earlier tile on
 *  a tie. `values[offset + t][i]` is tile t's probability. A rule that
 *  comes out as NaN (Fulgora has one) never wins. */
function winningTile(values: Float32Array[], offset: number, count: number, i: number): number {
  let best = 0;
  let bestP = -Infinity;
  for (let t = 0; t < count; t++) {
    const p = values[offset + t]![i]!;
    if (p > bestP) {
      bestP = p;
      best = t;
    }
  }
  return best;
}

export class MapSurface {
  readonly tiles: TileLayer[];
  readonly resources: ResourceLayer[];
  readonly colors: LayerColors;
  readonly seed: number;
  readonly startingAreaRadius: number;

  private readonly program: Program;
  private readonly evaluator: Evaluator;
  private readonly tileRoots: number[];
  private readonly resourceRoots: number[];
  private readonly richnessRoots: number[];
  private readonly enemyRoot: number | null;
  private readonly treeRoots: number[];
  private readonly elevationRoot: number;
  private readonly halfWidth: number;
  private readonly halfHeight: number;
  /** Index of the tile beyond the edge of a bounded map. */
  private readonly voidTile: number;
  /** `cliff_elevation` and `cliffiness`, or null on a planet without cliffs. */
  private readonly cliffRoots: [number, number] | null;
  /** How far the cliff elevation is flattened between a chunk's knots. */
  private readonly cliffSmoothing: number;
  private readonly cliffElevation0: number;
  private readonly cliffInterval: number;
  private readonly cliffBoxes: Record<string, OrientedBox>;
  /** Per resource: half the width of a well's footprint, 0 for an ore. */
  private readonly wellMargins: number[];
  /** 1 for each tile type a cliff cannot stand on. */
  private readonly noCliffs: Uint8Array;
  /** Resources that fill their patch: these displace cliffs. */
  private readonly oreRoots: number[];
  /** Autoplace order of each resource, parallel to `resources`. */
  private readonly resourceOrders: string[];
  /** Everything the planet autoplaces, for replaying a chunk's rolls. */
  private readonly placementEntities: PlacementEntity[];
  private readonly placementGroups: number[][];
  /** Applies per-tile penalties: placement is one particular roll. */
  private readonly exactEvaluator: Evaluator;
  private readonly chunkTiles = new Map<string, Uint8Array>();
  private readonly chunkPlaced = new Map<string, PlacedResource[]>();
  /** The expression that says which territory a chunk belongs to, or null
   *  on a planet without any. */
  private readonly territoryRoot: number | null;
  /** Rocks, ruins and the like: what the game scatters that is neither a
   *  resource, a tree nor an enemy. */
  readonly decor: DecorLayer[];
  /** Per placement entity: the collision layers it has. */
  private readonly decorLayers: string[][];
  /** Per placement entity: its index into `decor`, or -1. */
  private readonly decorOf: number[];
  /** How many placement groups have to be rolled to reach the last decor. */
  private readonly decorGroups: number;
  private readonly chunkDecorPlaced = new Map<string, PlacedDecor[]>();
  private readonly chunkCliffPieces = new Map<string, Uint8Array>();
  /** Per decor: its probability expression and the tiles its footprint
   *  covers, for views too far out to place each one. */
  private readonly decorRoots: number[];
  private readonly decorAreas: number[];
  private readonly decorBlocked: Uint8Array[];
  private readonly xs = new Float32Array(BATCH);
  private readonly ys = new Float32Array(BATCH);

  constructor(data: MapGenData, options: MapGenOptions) {
    const planet = data.planets[options.planet ?? "nauvis"];
    if (!planet) throw new Error(`unknown planet '${options.planet}'`);
    const mgs = planet.map_gen_settings ?? {};
    const settings = compileSettings(data, options);
    this.seed = settings.seed;
    this.startingAreaRadius = settings.constants.starting_area_radius ?? 150;
    this.program = new Program(data, settings);
    this.evaluator = new Evaluator(this.program, false);
    const program = this.program;

    const controls = new Set(Object.keys(mgs.autoplace_controls ?? {}));
    const listed = new Set(Object.keys(mgs.autoplace_settings?.entity?.settings ?? {}));
    const entities = Object.entries(data.autoplace.entity)
      .filter(([name, a]) => listed.has(name) || (a.control !== undefined && controls.has(a.control)))
      .sort(([, a], [, b]) => ((a.order ?? "") < (b.order ?? "") ? -1 : (a.order ?? "") > (b.order ?? "") ? 1 : 0));

    const tileNames = Object.keys(mgs.autoplace_settings?.tile?.settings ?? {});
    // An entity cannot stand on a tile it shares a collision layer with.
    // Data written before the layers were exported falls back to "water
    // blocks everything but fish".
    const tileLayers = tileNames.map((name) => data.autoplace.tile[name]?.collision_layers);
    const blockedTiles = (a: AutoplaceEntry): Uint8Array => {
      const out = new Uint8Array(tileNames.length + 1);
      tileNames.forEach((name, t) => {
        const layers = tileLayers[t];
        if (layers && a.collision_layers) out[t] = a.collision_layers.some((layer) => layers.includes(layer)) ? 1 : 0;
        else out[t] = WATER.test(name) === (a.type === "fish") ? 0 : 1;
      });
      // Nothing stands in the void beyond a bounded map.
      out[tileNames.length] = 1;
      return out;
    };
    const noResources = blockedTiles({ type: "resource", collision_layers: ["resource"] });
    this.tiles = tileNames.map((name, t) => ({
      name, color: data.autoplace.tile[name]?.map_color ?? [255, 0, 255], water: WATER.test(name), noResources: noResources[t] === 1,
    }));
    // A bounded map (the ribbon world) ends in void; nothing generates there.
    this.halfWidth = options.width ? options.width / 2 : Infinity;
    this.halfHeight = options.height ? options.height / 2 : Infinity;
    this.voidTile = this.tiles.length;
    if (options.width || options.height) this.tiles.push({ name: "out-of-map", color: [0, 0, 0], water: true, noResources: true });
    this.tileRoots = tileNames.map((name) => program.named(`tile:${name}:probability`));

    const resources = entities.filter(([, a]) => a.type === "resource");
    this.resourceRoots = resources.map(([name]) => program.named(`entity:${name}:probability`));
    this.resourceOrders = resources.map(([, a]) => a.order ?? "");
    this.resources = resources.map(([name, a], i) => {
      const penalty = this.findNode(this.resourceRoots[i]!, "random_penalty");
      const chance = penalty ? 1 / (penalty.p.amplitude as number) : 1;
      const box = a.collision_box;
      return {
        name,
        color: a.map_color ?? [255, 255, 255],
        chance,
        wells: chance < 1 || (box !== undefined && box[1][0] - box[0][0] > 1),
        normalYield: a.infinite && a.normal ? a.normal : null,
      };
    });
    this.richnessRoots = resources.map(([name]) => program.named(`entity:${name}:richness`));

    const spawner = entities.find(([, a]) => a.type === "unit-spawner");
    this.enemyRoot = spawner ? program.named(`entity:${spawner[0]}:probability`) : null;
    this.treeRoots = entities.filter(([, a]) => a.type === "tree").map(([name]) => program.named(`entity:${name}:probability`));
    this.elevationRoot = program.named("elevation");

    this.exactEvaluator = new Evaluator(program, true);
    this.placementEntities = entities.map(([name, a]) => ({
      name,
      type: a.type,
      probability: program.named(`entity:${name}:probability`),
      richness: program.named(`entity:${name}:richness`),
      offGrid: a.off_grid === true,
      box: a.collision_box ?? [[-0.4, -0.4], [0.4, 0.4]],
      blocked: blockedTiles(a),
    }));
    this.placementGroups = placementGroups(entities.map(([, a]) => ({ order: a.order ?? "" })));
    const territory = mgs.territory_settings;
    this.territoryRoot = territory?.units?.length && territory.territory_index_expression ? program.named(territory.territory_index_expression) : null;
    this.decor = [];
    this.decorOf = entities.map(([name, a]) => {
      if (!DECOR_TYPES.has(a.type ?? "")) return -1;
      return this.decor.push({ name, color: a.map_color ?? DECOR_COLOR }) - 1;
    });
    this.decorLayers = entities.map(([, a]) => a.collision_layers ?? []);
    const decorEntities = this.placementEntities.filter((_, e) => this.decorOf[e]! >= 0);
    this.decorRoots = decorEntities.map((e) => e.probability);
    this.decorAreas = decorEntities.map((e) => (e.box[1][0] - e.box[0][0]) * (e.box[1][1] - e.box[0][1]));
    this.decorBlocked = decorEntities.map((e) => e.blocked);
    this.decorGroups = this.placementGroups.reduce((last, group, g) => (group.some((e) => this.decorOf[e]! >= 0) ? g + 1 : last), 0);

    const cliff = data.cliffs?.[mgs.cliff_settings?.name ?? ""];
    this.noCliffs = blockedTiles({ type: "cliff", collision_layers: cliff?.collision_layers ?? CLIFF_LAYERS });
    this.cliffRoots = cliff ? [program.named("cliff_elevation"), program.named("cliffiness")] : null;
    this.cliffSmoothing = options.cliffs?.smoothing ?? mgs.cliff_settings?.cliff_smoothing ?? DEFAULT_CLIFF_SMOOTHING;
    this.cliffElevation0 = settings.constants.cliff_elevation_0 ?? 10;
    this.cliffInterval = settings.constants.cliff_elevation_interval ?? 40;
    this.cliffBoxes = cliff?.orientations ?? {};
    this.oreRoots = this.resourceRoots.filter((_, i) => !this.resources[i]!.wells);
    this.wellMargins = this.resources.map((r) => {
      const box = data.autoplace.entity[r.name]?.collision_box;
      return r.wells && box ? (box[1][0] - box[0][0]) / 2 : 0;
    });
    this.colors = {
      tree: data.colors?.tree ?? [48, 99, 48],
      enemy: data.colors?.enemy ?? [255, 26, 26],
      cliff: cliff?.map_color ?? [144, 119, 87],
    };
  }

  /** Evaluate `roots` at many positions, in fixed-size batches so the
   *  evaluator's buffers are reused. Returns one array per root. */
  private evaluate(roots: number[], xs: Float32Array, ys: Float32Array): Float32Array[] {
    const total = xs.length;
    const out = roots.map(() => new Float32Array(total));
    for (let start = 0; start < total; start += BATCH) {
      const n = Math.min(BATCH, total - start);
      this.xs.set(xs.subarray(start, start + n));
      this.ys.set(ys.subarray(start, start + n));
      // Pad a short last batch rather than introduce a new batch length.
      if (n < BATCH) {
        this.xs.fill(xs[start]!, n);
        this.ys.fill(ys[start]!, n);
      }
      const v = this.evaluator.run(roots, this.xs, this.ys);
      for (let r = 0; r < roots.length; r++) out[r]!.set(v[r]!.subarray(0, n), start);
    }
    return out;
  }

  /** Which resource a tile shows where several have a positive probability:
   *  an earlier `order` wins outright, and within one order the higher
   *  probability, the higher richness on a tie. `values` holds the
   *  probabilities from `offset`, then the richnesses. Returns -1 for none. */
  private resourceAt(values: Float32Array[], offset: number, k: number): number {
    const n = this.resourceOrders.length;
    let best = -1;
    for (let r = 0; r < n; r++) {
      const p = values[offset + r]![k]!;
      if (!(p > 0)) continue;
      if (best < 0) {
        best = r;
        continue;
      }
      if (this.resourceOrders[r] !== this.resourceOrders[best]) continue;
      const bestP = values[offset + best]![k]!;
      if (p > bestP || (p === bestP && values[offset + n + r]![k]! > values[offset + n + best]![k]!)) best = r;
    }
    return best;
  }

  /** Whether a tile lies within a bounded map; always, on an unbounded one. */
  private inMap(x: number, y: number): boolean {
    return Math.abs(x + 0.5) <= this.halfWidth && Math.abs(y + 0.5) <= this.halfHeight;
  }

  /** The tile type of each of a chunk's 1024 tiles. */
  private tilesOf(chunkX: number, chunkY: number): Uint8Array {
    const key = `${chunkX},${chunkY}`;
    let types = this.chunkTiles.get(key);
    if (types) return types;
    const xs = new Float32Array(CHUNK * CHUNK);
    const ys = new Float32Array(CHUNK * CHUNK);
    for (let k = 0; k < xs.length; k++) {
      xs[k] = chunkX * CHUNK + (k % CHUNK);
      ys[k] = chunkY * CHUNK + Math.floor(k / CHUNK);
    }
    const tile = this.evaluate(this.tileRoots, xs, ys);
    types = new Uint8Array(xs.length);
    for (let k = 0; k < xs.length; k++) {
      types[k] = this.inMap(xs[k]!, ys[k]!) ? winningTile(tile, 0, tile.length, k) : this.voidTile;
    }
    if (this.chunkTiles.size > 4096) this.chunkTiles.clear();
    this.chunkTiles.set(key, types);
    return types;
  }

  private tileAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    return this.tilesOf(cx, cy)[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)]!;
  }

  /** Every placement attempt in a chunk, in the game's order. */
  chunkAttempts(chunkX: number, chunkY: number): { attempts: Attempt[]; entities: PlacementEntity[] } {
    const entities = this.placementEntities;
    const xs = new Float32Array(CHUNK * CHUNK);
    const ys = new Float32Array(CHUNK * CHUNK);
    for (let k = 0; k < xs.length; k++) {
      xs[k] = chunkX * CHUNK + (k % CHUNK);
      ys[k] = chunkY * CHUNK + Math.floor(k / CHUNK);
    }
    // The batch is the chunk, row by row: the per-tile penalties are drawn
    // from a generator seeded by the batch's first tile.
    const roots = [...entities.map((e) => e.probability), ...entities.map((e) => e.richness)];
    const values = this.exactEvaluator.run(roots, xs, ys);
    const attempts = rollChunk(
      chunkX, chunkY, entities, this.placementGroups,
      values.slice(0, entities.length), values.slice(entities.length), this.tilesOf(chunkX, chunkY),
    );
    return { attempts, entities };
  }

  /** The resource entities the game places in a chunk: each ore tile and
   *  each oil well, with its amount.
   *
   *  Exact, except in the few chunks where the game reshapes the shoreline
   *  after generating it (which shifts every roll in the chunk), and for a
   *  well whose only obstacle would be one in the neighbouring chunk. */
  chunkResources(chunkX: number, chunkY: number): PlacedResource[] {
    const key = `${chunkX},${chunkY}`;
    const hit = this.chunkPlaced.get(key);
    if (hit) return hit;
    const { attempts, entities } = this.chunkAttempts(chunkX, chunkY);
    const index = new Map(this.resources.map((r, i) => [r.name, i]));
    const placed: PlacedResource[] = [];
    const boxes: [[number, number], [number, number]][] = [];
    for (const a of attempts) {
      const entity = entities[a.entity]!;
      if (entity.type !== "resource") continue;
      const [[x1, y1], [x2, y2]] = entity.box;
      const cx = a.tileX + 0.5;
      const cy = a.tileY + 0.5;
      // Resources collide with each other and with the tiles they cannot
      // stand on, nothing else.
      let free = true;
      for (let i = 0; i < placed.length && free; i++) {
        const [[ox1, oy1], [ox2, oy2]] = boxes[i]!;
        const ox = placed[i]!.x + 0.5;
        const oy = placed[i]!.y + 0.5;
        if (cx + x1 < ox + ox2 && cx + x2 > ox + ox1 && cy + y1 < oy + oy2 && cy + y2 > oy + oy1) free = false;
      }
      for (let ty = Math.floor(cy + y1); ty <= Math.floor(cy + y2) && free; ty++) {
        for (let tx = Math.floor(cx + x1); tx <= Math.floor(cx + x2) && free; tx++) if (entity.blocked[this.tileAt(tx, ty)]) free = false;
      }
      if (!free) continue;
      // The amount is the richness rounded down; a resource that would hold
      // nothing is not placed.
      const amount = Math.floor(a.richness);
      if (amount < 1) continue;
      placed.push({ resource: index.get(entity.name)!, x: a.tileX, y: a.tileY, amount });
      boxes.push(entity.box);
    }
    if (this.chunkPlaced.size > 4096) this.chunkPlaced.clear();
    this.chunkPlaced.set(key, placed);
    return placed;
  }

  /** The game's cliffs in one chunk, 8 x 8 cells of piece codes. */
  private chunkCliffs(chunkX: number, chunkY: number): Uint8Array {
    const hit = this.chunkCliffPieces.get(`${chunkX},${chunkY}`);
    if (hit) return hit;
    this.primeChunkCliffs(chunkX, chunkY, chunkX, chunkY);
    return this.chunkCliffPieces.get(`${chunkX},${chunkY}`)!;
  }

  /** Work out the cliffs of a block of chunks in one go. */
  private primeChunkCliffs(chunkX0: number, chunkY0: number, chunkX1: number, chunkY1: number): void {
    let missing = false;
    for (let cy = chunkY0; cy <= chunkY1 && !missing; cy++) for (let cx = chunkX0; cx <= chunkX1 && !missing; cx++) missing = !this.chunkCliffPieces.has(`${cx},${cy}`);
    if (!missing) return;
    const cols = (chunkX1 - chunkX0 + 1) * 8;
    const rows = (chunkY1 - chunkY0 + 1) * 8;
    const pieces = this.cliffs(chunkX0 * 8, chunkY0 * 8, cols, rows);
    if (this.chunkCliffPieces.size > 4096) this.chunkCliffPieces.clear();
    for (let cy = chunkY0; cy <= chunkY1; cy++) {
      for (let cx = chunkX0; cx <= chunkX1; cx++) {
        const out = new Uint8Array(64);
        for (let j = 0; j < 8; j++) out.set(pieces.subarray(((cy - chunkY0) * 8 + j) * cols + (cx - chunkX0) * 8, ((cy - chunkY0) * 8 + j) * cols + (cx - chunkX0) * 8 + 8), j * 8);
        this.chunkCliffPieces.set(`${cx},${cy}`, out);
      }
    }
  }

  /** Whether a footprint about (x, y) touches one of the game's cliffs. */
  private onCliff(x: number, y: number, box: [[number, number], [number, number]]): boolean {
    if (!this.cliffRoots) return false;
    const [[x1, y1], [x2, y2]] = box;
    for (let cy = Math.floor((y + y1 - 4) / 4); cy <= Math.floor((y + y2 + 4) / 4); cy++) {
      for (let cx = Math.floor((x + x1 - 4) / 4); cx <= Math.floor((x + x2 + 4) / 4); cx++) {
        const code = this.chunkCliffs(Math.floor(cx / 8), Math.floor(cy / 8))[(cy & 7) * 8 + (cx & 7)]!;
        if (!code) continue;
        const cliff = this.cliffBoxes[cliffName(code)!];
        if (!cliff) continue;
        // The footprint, sampled finely enough for the narrowest cliff.
        for (let b = 0; b <= 4; b++) {
          for (let a = 0; a <= 4; a++) {
            if (pointInBox(cliff, cx * 4 + 2, cy * 4 + 2.5, x + x1 + ((x2 - x1) * a) / 4, y + y1 + ((y2 - y1) * b) / 4, 0)) return true;
          }
        }
      }
    }
    return false;
  }

  /** The rocks, ruins and other fixtures the game places in a chunk.
   *
   *  The chunk's dice are replayed as far as the last of them, so trees and
   *  whatever else comes later cost nothing. Each stands where its roll
   *  put it unless a tile it cannot stand on, a cliff, or one placed
   *  before it is in the way. Fixtures reaching in from a neighbouring
   *  chunk are not looked at. */
  chunkDecor(chunkX: number, chunkY: number): PlacedDecor[] {
    const key = `${chunkX},${chunkY}`;
    const hit = this.chunkDecorPlaced.get(key);
    if (hit) return hit;
    const placed: PlacedDecor[] = [];
    if (this.decorGroups > 0) {
      const entities = this.placementEntities;
      const groups = this.placementGroups.slice(0, this.decorGroups);
      const used = groups.flat();
      const xs = new Float32Array(CHUNK * CHUNK);
      const ys = new Float32Array(CHUNK * CHUNK);
      for (let k = 0; k < xs.length; k++) {
        xs[k] = chunkX * CHUNK + (k % CHUNK);
        ys[k] = chunkY * CHUNK + Math.floor(k / CHUNK);
      }
      const values = this.exactEvaluator.run([...used.map((e) => entities[e]!.probability), ...used.map((e) => entities[e]!.richness)], xs, ys);
      const probability: Float32Array[] = [];
      const richness: Float32Array[] = [];
      // Copies: the evaluator hands out its own buffers.
      used.forEach((e, n) => {
        probability[e] = values[n]!.slice();
        richness[e] = values[used.length + n]!.slice();
      });
      const attempts = rollChunk(chunkX, chunkY, entities, groups, probability, richness, this.tilesOf(chunkX, chunkY));
      const taken: { layers: string[]; x1: number; y1: number; x2: number; y2: number }[] = [];
      for (const a of attempts) {
        const entity = entities[a.entity]!;
        const decor = this.decorOf[a.entity]!;
        // Resources keep to themselves: they share no layer with the rest.
        if (decor < 0 && entity.type !== "resource") continue;
        // Off the grid an entity lands on a sixteenth of a tile.
        const x = a.tileX + (entity.offGrid ? Math.floor(a.offsetA * 16) / 16 : 0.5);
        const y = a.tileY + (entity.offGrid ? Math.floor(a.offsetB * 16) / 16 : 0.5);
        const [[bx1, by1], [bx2, by2]] = entity.box;
        const layers = this.decorLayers[a.entity]!;
        let free = true;
        for (let ty = Math.floor(y + by1); ty <= Math.floor(y + by2) && free; ty++) {
          for (let tx = Math.floor(x + bx1); tx <= Math.floor(x + bx2) && free; tx++) if (entity.blocked[this.tileAt(tx, ty)]) free = false;
        }
        for (let i = 0; i < taken.length && free; i++) {
          const t = taken[i]!;
          if (x + bx1 < t.x2 && x + bx2 > t.x1 && y + by1 < t.y2 && y + by2 > t.y1 && t.layers.some((l) => layers.includes(l))) free = false;
        }
        // Cliffs are there first; nothing of the landscape stands on one.
        if (free && decor >= 0 && this.onCliff(x, y, entity.box)) free = false;
        if (!free) continue;
        taken.push({ layers, x1: x + bx1, y1: y + by1, x2: x + bx2, y2: y + by2 });
        if (decor >= 0) placed.push({ decor, x, y, box: entity.box });
      }
    }
    if (this.chunkDecorPlaced.size > 4096) this.chunkDecorPlaced.clear();
    this.chunkDecorPlaced.set(key, placed);
    return placed;
  }

  /** Cliff pieces for a block of grid cells, as codes from `cliffs.ts`.
   *
   *  `grid` is the cell size in tiles. At the game's own 4 the result is the
   *  game's cliffs, less the pieces ore and water displace; a larger grid follows the
   *  same contour more coarsely, for views zoomed too far out to show cells. */
  cliffs(cellX0: number, cellY0: number, cols: number, rows: number, grid = 4, displace = true, quick = false): Uint8Array {
    if (!this.cliffRoots) return new Uint8Array(cols * rows);
    // One cell of margin: whether a line ends in a cell depends on its
    // neighbours.
    const mc = cols + 2;
    const mr = rows + 2;
    const stride = mc + 1;
    const vx = new Float32Array(stride * (mr + 1));
    const vy = new Float32Array(vx.length);
    for (let j = 0; j <= mr; j++) {
      for (let i = 0; i <= mc; i++) {
        vx[j * stride + i] = (cellX0 - 1 + i) * grid;
        vy[j * stride + i] = (cellY0 - 1 + j) * grid;
      }
    }
    // Cliffiness costs far more than the elevation and only matters where
    // the level changes, so it is worked out for those vertices alone.
    const elevation = this.cliffElevation(cellX0 - 1, cellY0 - 1, mc, mr, grid, quick);
    const level = (k: number): number => Math.floor((elevation[k]! - this.cliffElevation0) / this.cliffInterval);
    const needed = new Uint8Array(vx.length);
    for (let j = 0; j <= mr; j++) {
      for (let i = 0; i <= mc; i++) {
        const k = j * stride + i;
        if (i < mc && level(k) !== level(k + 1)) needed[k] = needed[k + 1] = 1;
        if (j < mr && level(k) !== level(k + stride)) needed[k] = needed[k + stride] = 1;
      }
    }
    const at: number[] = [];
    for (let k = 0; k < needed.length; k++) if (needed[k]) at.push(k);
    const cliffiness = new Float32Array(vx.length);
    if (at.length) {
      const [values] = this.evaluate([this.cliffRoots[1]], Float32Array.from(at, (k) => vx[k]!), Float32Array.from(at, (k) => vy[k]!));
      at.forEach((k, n) => (cliffiness[k] = values![n]!));
    }
    const pieces = grid === 4
      ? cliffPieces(elevation, cliffiness, mc, mr, this.cliffElevation0, this.cliffInterval, cellX0 - 1, cellY0 - 1)
      : cliffPieces(elevation, cliffiness, mc, mr, this.cliffElevation0, this.cliffInterval);
    const displaced = grid === 4 && displace ? this.displacedCliffs(pieces, cellX0 - 1, cellY0 - 1, mc) : new Set<number>();
    trimCliffs(pieces, mc, mr, (k) => displaced.has(k));
    const out = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) out.set(pieces.subarray((j + 1) * mc + 1, (j + 1) * mc + 1 + cols), j * cols);
    return out;
  }

  /** `cliff_elevation` at the vertices of a block of cells, smoothed as the
   *  game smooths it.
   *
   *  The game works a chunk at a time, on the 9 x 9 vertices of its 8 x 8
   *  cells. Only the vertices 0, 4, 7 and 8 along each axis keep their own
   *  elevation; the rest are interpolated between those, and
   *  `cliff_smoothing` blends that with the true value (1 is all
   *  interpolation, as on Vulcanus; Nauvis has none). Measured by
   *  giving the game elevations that are flat but for one line of vertices. */
  private cliffElevation(cellX0: number, cellY0: number, cols: number, rows: number, grid: number, quick = false): Float32Array {
    const s = grid === 4 ? this.cliffSmoothing : 0;
    if (!s && quick && grid === 4) return this.cliffElevationQuick(cellX0, cellY0, cols, rows);
    // Whole chunks, so that every knot a vertex leans on is there.
    const x0 = s ? Math.floor(cellX0 / 8) * 8 : cellX0;
    const y0 = s ? Math.floor(cellY0 / 8) * 8 : cellY0;
    const w = (s ? Math.ceil((cellX0 + cols) / 8) * 8 : cellX0 + cols) - x0 + 1;
    const h = (s ? Math.ceil((cellY0 + rows) / 8) * 8 : cellY0 + rows) - y0 + 1;
    // Fully smoothed, a vertex is nothing but its knots: only those need
    // working out, 9 of a chunk's 64.
    const wanted: number[] = [];
    const knot = (v: number): boolean => CLIFF_KNOTS.includes(v & 7);
    for (let k = 0; k < w * h; k++) if (s !== 1 || (knot(k % w) && knot(Math.floor(k / w)))) wanted.push(k);
    const exact = new Float32Array(w * h);
    const values = this.cliffElevationAt(Float32Array.from(wanted, (k) => (x0 + (k % w)) * grid), Float32Array.from(wanted, (k) => (y0 + Math.floor(k / w)) * grid));
    for (let n = 0; n < wanted.length; n++) exact[wanted[n]!] = values[n]!;
    if (!s) return exact;
    const out = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) {
      const y = cellY0 - y0 + j;
      const [ya, yb, ty] = knotSpan(y);
      for (let i = 0; i <= cols; i++) {
        const x = cellX0 - x0 + i;
        const [xa, xb, tx] = knotSpan(x);
        const top = exact[ya * w + xa]! * (1 - tx) + exact[ya * w + xb]! * tx;
        const bottom = exact[yb * w + xa]! * (1 - tx) + exact[yb * w + xb]! * tx;
        out[j * (cols + 1) + i] = exact[y * w + x]! * (1 - s) + (top * (1 - ty) + bottom * ty) * s;
      }
    }
    return out;
  }

  /** `cliff_elevation` at tile positions that are vertices of the cliff
   *  grid. `multisample` reads the neighbours of the grid it is evaluated
   *  on, which for cliffs is that grid of vertices, 4 tiles apart. */
  private cliffElevationAt(xs: Float32Array, ys: Float32Array): Float32Array {
    this.evaluator.sampleStep = 4;
    const values = this.evaluate([this.cliffRoots![0]], xs, ys)[0]!;
    this.evaluator.sampleStep = 1;
    return values;
  }

  /** Unsmoothed `cliff_elevation` over a block of cells without working
   *  every vertex out, for views that take in a great many cells.
   *
   *  Every fourth vertex each way is worked out first. A block of 4 x 4
   *  cells between them is only filled in where a cliff may run: where its
   *  corners differ in level or lie near one, and then wherever a line
   *  found in a block leaves it for the next. Every line found is followed
   *  to its end, exactly; what can be missed is a ring of cliffs that fits
   *  inside one block with flat ground at all its corners. A block left
   *  alone is returned level, at its corners' height. */
  private cliffElevationQuick(cellX0: number, cellY0: number, cols: number, rows: number): Float32Array {
    const B = 4;
    const x0 = Math.floor(cellX0 / B) * B;
    const y0 = Math.floor(cellY0 / B) * B;
    const bw = Math.ceil((cellX0 + cols) / B) - x0 / B;
    const bh = Math.ceil((cellY0 + rows) / B) - y0 / B;
    const w = bw * B + 1;
    const h = bh * B + 1;
    const value = new Float32Array(w * h);
    const known = new Uint8Array(w * h);
    const fill = (at: number[]): void => {
      if (at.length === 0) return;
      const v = this.cliffElevationAt(Float32Array.from(at, (k) => (x0 + (k % w)) * 4), Float32Array.from(at, (k) => (y0 + Math.floor(k / w)) * 4));
      for (let n = 0; n < at.length; n++) {
        value[at[n]!] = v[n]!;
        known[at[n]!] = 1;
      }
    };
    const corners: number[] = [];
    for (let j = 0; j <= bh; j++) for (let i = 0; i <= bw; i++) corners.push(j * B * w + i * B);
    fill(corners);

    const e0 = this.cliffElevation0;
    const interval = this.cliffInterval;
    const level = (v: number): number => Math.max(0, Math.floor((v - e0) / interval) + 1);
    // How far a value is from the nearest height where the level changes.
    const clearance = (v: number): number => {
      if (v < e0) return e0 - v;
      const t = (v - e0) % interval;
      return Math.min(t, interval - t);
    };
    const refined = new Uint8Array(bw * bh);
    let queue: number[] = [];
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        const nw = j * B * w + i * B;
        const c = [value[nw]!, value[nw + B]!, value[nw + B * w]!, value[nw + B * w + B]!];
        const spread = Math.max(...c) - Math.min(...c);
        const flat = c.every((v) => level(v) === level(c[0]!) && clearance(v) > spread * QUICK_CLIFF_MARGIN + interval * 0.02);
        if (!flat) queue.push(j * bw + i);
      }
    }
    while (queue.length) {
      const at: number[] = [];
      for (const b of queue) {
        refined[b] = 1;
        const nw = Math.floor(b / bw) * B * w + (b % bw) * B;
        for (let dj = 0; dj <= B; dj++) {
          for (let di = 0; di <= B; di++) {
            const k = nw + dj * w + di;
            if (!known[k]) {
              known[k] = 1;
              at.push(k);
            }
          }
        }
      }
      fill(at);
      // A level change along a block's edge is a line crossing into the
      // block beyond: fill that one in too.
      const next: number[] = [];
      for (const b of queue) {
        const bi = b % bw;
        const bj = Math.floor(b / bw);
        const nw = bj * B * w + bi * B;
        const corner = level(value[nw]!);
        const edge = (start: number, stride: number): boolean => {
          for (let n = 0; n <= B; n++) if (level(value[start + n * stride]!) !== corner) return true;
          return false;
        };
        const want = (i: number, j: number, crossed: boolean): void => {
          if (!crossed || i < 0 || j < 0 || i >= bw || j >= bh || refined[j * bw + i]) return;
          refined[j * bw + i] = 1;
          next.push(j * bw + i);
        };
        want(bi, bj - 1, edge(nw, 1));
        want(bi, bj + 1, edge(nw + B * w, 1));
        want(bi - 1, bj, edge(nw, w));
        want(bi + 1, bj, edge(nw + B, w));
      }
      queue = next;
    }
    for (let b = 0; b < refined.length; b++) {
      if (refined[b]) continue;
      const nw = Math.floor(b / bw) * B * w + (b % bw) * B;
      for (let dj = 0; dj <= B; dj++) for (let di = 0; di <= B; di++) if (!known[nw + dj * w + di]) value[nw + dj * w + di] = value[nw]!;
    }
    const out = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) out.set(value.subarray((cellY0 - y0 + j) * w + cellX0 - x0, (cellY0 - y0 + j) * w + cellX0 - x0 + cols + 1), j * (cols + 1));
    return out;
  }

  /** Cells whose piece collides with an ore tile, a well, or a tile a cliff
   *  cannot stand on (water): the game puts no cliff there. */
  private displacedCliffs(pieces: Uint8Array, cellX0: number, cellY0: number, cols: number): Set<number> {
    const cells: number[] = [];
    for (let k = 0; k < pieces.length; k++) if (pieces[k]) cells.push(k);
    const out = new Set<number>();
    if (cells.length === 0) return out;
    const nOre = this.oreRoots.length;
    const nTiles = this.tileRoots.length;
    const roots = [...this.oreRoots, ...this.tileRoots];
    const taken = (v: Float32Array[], at: number): boolean => {
      for (let r = 0; r < nOre; r++) if (v[r]![at]! > 0) return true;
      return !this.inMap(xs[at]!, ys[at]!) || this.noCliffs[winningTile(v, nOre, nTiles, at)] === 1;
    };
    // A piece reaches at most a few tiles past its 4x4 cell. Where cliffs
    // are dense (Fulgora) the pieces' surroundings overlap many times over;
    // evaluating every tile of the block once is then cheaper.
    const W = 10;
    const H = 10;
    const rows = pieces.length / cols;
    const blockW = cols * 4 + 6;
    const blockH = rows * 4 + 6;
    const dense = cells.length * W * H > blockW * blockH;
    const x0 = cellX0 * 4 - 3;
    const y0 = cellY0 * 4 - 3;
    const xs = new Float32Array(dense ? blockW * blockH : cells.length * W * H);
    const ys = new Float32Array(xs.length);
    if (dense) {
      for (let i = 0; i < xs.length; i++) {
        xs[i] = x0 + (i % blockW);
        ys[i] = y0 + Math.floor(i / blockW);
      }
    } else {
      cells.forEach((k, c) => {
        for (let i = 0; i < W * H; i++) {
          xs[c * W * H + i] = x0 + (k % cols) * 4 + (i % W);
          ys[c * W * H + i] = y0 + Math.floor(k / cols) * 4 + Math.floor(i / W);
        }
      });
    }
    const v = this.evaluate(roots, xs, ys);
    // Wells stand where the game's own dice put them; which chunks hold
    // any is cheap to tell, the dice are not.
    const wellChunks = this.wellMargins.some((m) => m > 0) ? this.sparseChunks(x0 - 4, y0 - 4, x0 + blockW + 4, y0 + blockH + 4) : new Set<string>();
    cells.forEach((k, c) => {
      const box = this.cliffBoxes[cliffName(pieces[k]!)!];
      if (!box) return;
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      // The cliff entity stands at the cell centre, half a tile south.
      const originX = (cellX0 + cx) * 4 + 2;
      const originY = (cellY0 + cy) * 4 + 2.5;
      for (let i = 0; i < W * H; i++) {
        const at = dense ? (cy * 4 + Math.floor(i / W)) * blockW + cx * 4 + (i % W) : c * W * H + i;
        if (!pointInBox(box, originX, originY, xs[at]! + 0.5, ys[at]! + 0.5, 0.1)) continue;
        if (taken(v, at)) {
          out.add(k);
          return;
        }
      }
      const tx = (cellX0 + cx) * 4;
      const ty = (cellY0 + cy) * 4;
      for (let chY = Math.floor((ty - 4) / CHUNK); chY <= Math.floor((ty + 8) / CHUNK); chY++) {
        for (let chX = Math.floor((tx - 4) / CHUNK); chX <= Math.floor((tx + 8) / CHUNK); chX++) {
          if (!wellChunks.has(`${chX},${chY}`)) continue;
          for (const r of this.chunkResources(chX, chY)) {
            const margin = this.wellMargins[r.resource]!;
            if (margin > 0 && pointInBox(box, originX, originY, r.x + 0.5, r.y + 0.5, margin)) {
              out.add(k);
              return;
            }
          }
        }
      }
    });
    return out;
  }

  /** Sample a `cols` x `rows` grid starting at tile (x0, y0), `step` tiles
   *  between samples. */
  sample(x0: number, y0: number, cols: number, rows: number, step: number, options: SampleOptions = {}): SampleGrid {
    const trees = options.trees ?? false;
    const total = cols * rows;
    const grid: SampleGrid = {
      cols,
      rows,
      tile: new Uint8Array(total),
      resource: new Uint8Array(total),
      enemy: new Uint8Array(total),
      trees: new Uint8Array(total),
      cliff: new Uint8Array(total),
      decor: new Uint8Array(total),
      territory: new Uint8Array(total),
    };
    if (options.territories) this.sampleTerritories(grid, x0, y0, step);
    const decor = (options.decor ?? false) && this.decor.length > 0;
    const exactDecor = decor && step <= EXACT_DECOR_STEP;
    // Tile by tile both the cliffs drawn and the fixtures placed lean on
    // the game's exact cliffs: work those out once for the lot.
    if (step < 2 && this.cliffRoots && (options.cliffs || exactDecor)) {
      const reach = exactDecor ? 1 : 0;
      this.primeChunkCliffs(
        Math.floor(x0 / CHUNK) - reach, Math.floor(y0 / CHUNK) - reach,
        Math.floor((x0 + cols * step - 1) / CHUNK) + reach, Math.floor((y0 + rows * step - 1) / CHUNK) + reach,
      );
    }
    if (options.cliffs) this.sampleCliffs(grid, x0, y0, step);
    const wells = options.wells ?? false;
    const nTiles = this.tileRoots.length;
    const roots = [...this.tileRoots, ...this.resourceRoots, ...this.richnessRoots];
    const enemyAt = this.enemyRoot === null ? -1 : roots.push(this.enemyRoot) - 1;
    const treesAt = roots.length;
    if (trees) roots.push(...this.treeRoots);
    const decorAt = roots.length;
    if (decor && !exactDecor) roots.push(...this.decorRoots);

    for (let start = 0; start < total; start += BATCH) {
      const n = Math.min(BATCH, total - start);
      // Always a full batch: the evaluator keeps one set of buffers per
      // batch length, so an odd-sized tail would cost a whole new set.
      const xs = this.xs;
      const ys = this.ys;
      if (n < BATCH) {
        xs.fill(x0);
        ys.fill(y0);
      }
      for (let i = 0; i < n; i++) {
        const k = start + i;
        xs[i] = x0 + (k % cols) * step;
        ys[i] = y0 + Math.floor(k / cols) * step;
      }
      // Beyond a bounded map there is nothing to work out.
      let inside = false;
      for (let i = 0; i < n && !inside; i++) inside = this.inMap(xs[i]!, ys[i]!);
      if (!inside) {
        grid.tile.fill(this.voidTile, start, start + n);
        grid.cliff.fill(0, start, start + n);
        continue;
      }
      const v = this.evaluator.run(roots, xs, ys);
      for (let i = 0; i < n; i++) {
        const k = start + i;
        if (!this.inMap(xs[i]!, ys[i]!)) {
          grid.tile[k] = this.voidTile;
          grid.cliff[k] = 0;
          continue;
        }
        const best = winningTile(v, 0, nTiles, i);
        grid.tile[k] = best;
        // Coarse views skip the exact displacement; there a cliff is just
        // not drawn over water.
        if (step >= 2 && this.noCliffs[best]) grid.cliff[k] = 0;
        if (!this.tiles[best]!.noResources) grid.resource[k] = this.resourceAt(v, nTiles, i) + 1;
        if (this.tiles[best]!.water) continue;
        if (enemyAt >= 0) {
          const p = v[enemyAt]![i]!;
          if (p > 0) grid.enemy[k] = Math.max(1, Math.min(255, Math.round((p / ENEMY_FULL) * 255)));
        }
        if (trees) {
          let cover = 0;
          for (let t = treesAt; t < roots.length; t++) {
            const p = v[t]![i]!;
            if (p > 0) cover += p < 1 ? p : 1;
          }
          if (cover > 0) grid.trees[k] = Math.max(1, Math.min(255, Math.round(cover * 255)));
        }
        if (decor && !exactDecor && !grid.cliff[k]) {
          // The share of this ground that fixtures cover, and the kind that
          // covers most of it; a fixed scatter of samples that dense.
          let cover = 0;
          let most = 0;
          let which = -1;
          for (let d = 0; d < this.decorRoots.length; d++) {
            const p = v[decorAt + d]![i]!;
            if (!(p > 0) || this.decorBlocked[d]![best]) continue;
            const share = (p < 1 ? p : 1) * this.decorAreas[d]!;
            cover += share;
            if (share > most) {
              most = share;
              which = d;
            }
          }
          if (which >= 0 && scatter(xs[i]!, ys[i]!) < cover) grid.decor[k] = which + 1;
        }
      }
    }
    if (exactDecor) this.sampleDecor(grid, x0, y0, step);
    if (wells) this.sampleWells(grid, x0, y0, step);
    return grid;
  }

  private sampleCliffs(grid: SampleGrid, x0: number, y0: number, step: number): void {
    const { cols, rows } = grid;
    // A few cells to a sample: still the game's own cells, each marking the
    // sample it falls in. A coarser grid would follow the contour but break
    // the lines up, as cliffiness is then only seen at its sparse vertices.
    if (step > 4 && step <= EXACT_CLIFF_STEP) {
      const cx0 = Math.floor(x0 / 4);
      const cy0 = Math.floor(y0 / 4);
      const ccols = Math.floor((x0 + cols * step - 1) / 4) - cx0 + 1;
      const crows = Math.floor((y0 + rows * step - 1) / 4) - cy0 + 1;
      const pieces = this.cliffs(cx0, cy0, ccols, crows, 4, false, true);
      for (let k = 0; k < pieces.length; k++) {
        if (!pieces[k]) continue;
        const i = Math.floor(((cx0 + (k % ccols)) * 4 - x0) / step);
        const j = Math.floor(((cy0 + Math.floor(k / ccols)) * 4 - y0) / step);
        if (i >= 0 && j >= 0 && i < cols && j < rows) grid.cliff[j * cols + i] = 1;
      }
      return;
    }
    const cell = Math.max(4, step);
    const perCell = cell / step;
    const cx0 = Math.floor(x0 / cell);
    const cy0 = Math.floor(y0 / cell);
    const cx1 = Math.floor((x0 + (cols - 1) * step) / cell);
    const cy1 = Math.floor((y0 + (rows - 1) * step) / cell);
    const ccols = cx1 - cx0 + 1;
    // Which pieces an ore patch displaced only shows tile by tile, so
    // coarser views leave that work out.
    const exact = step < 2;
    const pieces = exact ? null : this.cliffs(cx0, cy0, ccols, cy1 - cy0 + 1, cell, false);
    for (let j = 0; j < rows; j++) {
      const y = y0 + j * step;
      const cy = Math.floor(y / cell);
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * step;
        const cx = Math.floor(x / cell);
        const code = pieces ? pieces[(cy - cy0) * ccols + (cx - cx0)]! : this.chunkCliffs(cx >> 3, cy >> 3)[(cy & 7) * 8 + (cx & 7)]!;
        if (code && onCliffLine(code, perCell, (x - cx * cell) / step, (y - cy * cell) / step)) grid.cliff[j * cols + i] = 1;
      }
    }
  }

  /** The connected patch of a resource that covers tile (x, y), or null if
   *  the tile has none. Walks the patch tile by tile, so the amount is what
   *  the patch holds, not an estimate from its nominal size. */
  measurePatch(x: number, y: number, limit = 150_000): PatchMeasure | null {
    const CHUNK = 32;
    const nTiles = this.tileRoots.length;
    const nRes = this.resourceRoots.length;
    const resourceRoots = [...this.resourceRoots, ...this.richnessRoots];
    const chunks = new Map<string, { resource: Uint8Array; amount: Float32Array; entities: Float32Array; seen: Uint8Array }>();
    const xs = new Float32Array(CHUNK * CHUNK);
    const ys = new Float32Array(CHUNK * CHUNK);
    const chunkAt = (cx: number, cy: number) => {
      const key = `${cx},${cy}`;
      let chunk = chunks.get(key);
      if (chunk) return chunk;
      for (let i = 0; i < xs.length; i++) {
        xs[i] = cx * CHUNK + (i % CHUNK);
        ys[i] = cy * CHUNK + Math.floor(i / CHUNK);
      }
      chunk = { resource: new Uint8Array(xs.length), amount: new Float32Array(xs.length), entities: new Float32Array(xs.length), seen: new Uint8Array(xs.length) };
      chunks.set(key, chunk);
      // Resources first: most chunks around a patch hold none, and the tile
      // types, needed only to rule out water, cost several times as much.
      const res = this.evaluate(resourceRoots, xs, ys);
      let any = false;
      for (let r = 0; r < nRes && !any; r++) any = res[r]!.some((p) => p > 0);
      if (!any) return chunk;
      const tile = this.evaluate(this.tileRoots, xs, ys);
      for (let i = 0; i < xs.length; i++) {
        if (this.tiles[winningTile(tile, 0, nTiles, i)]!.noResources) continue;
        const r = this.resourceAt(res, 0, i);
        if (r < 0) continue;
        // An ore tile holds its richness where the game's roll succeeds: all
        // of a patch but its fringe, where the probability is below one.
        const p = res[r]![i]!;
        const chance = p < 1 ? p : 1;
        chunk.resource[i] = r + 1;
        chunk.entities[i] = chance;
        chunk.amount[i] = chance * res[nRes + r]![i]!;
      }
      return chunk;
    };
    const lookup = (tx: number, ty: number) => {
      const cx = Math.floor(tx / CHUNK);
      const cy = Math.floor(ty / CHUNK);
      return { chunk: chunkAt(cx, cy), i: (ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK) };
    };

    let start = lookup(x, y);
    if (!start.chunk.resource[start.i]) {
      // Not on a patch, but perhaps on a well: its footprint reaches a tile
      // past the field's edge.
      const well = this.wellCovering(x, y);
      if (!well) return null;
      x = well.x;
      y = well.y;
      start = lookup(x, y);
    }
    const target = start.chunk.resource[start.i]!;
    if (!target) return null;

    const px: number[] = [];
    const py: number[] = [];
    const stack: number[] = [x, y];
    start.chunk.seen[start.i] = 1;
    let amount = 0;
    let entities = 0;
    let minX = x, maxX = x, minY = y, maxY = y;
    let complete = true;
    while (stack.length) {
      const ty = stack.pop()!;
      const tx = stack.pop()!;
      const here = lookup(tx, ty);
      amount += here.chunk.amount[here.i]!;
      entities += here.chunk.entities[here.i]!;
      px.push(tx);
      py.push(ty);
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
      if (px.length >= limit) {
        complete = false;
        break;
      }
      for (let d = 0; d < 4; d++) {
        const nx = tx + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = ty + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const next = lookup(nx, ny);
        if (next.chunk.seen[next.i] || next.chunk.resource[next.i] !== target) continue;
        next.chunk.seen[next.i] = 1;
        stack.push(nx, ny);
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const mask = new Uint8Array(width * height);
    for (let k = 0; k < px.length; k++) mask[(py[k]! - minY) * width + (px[k]! - minX)] = 1;

    // A sparse resource is not spread over its field: replay the chunks and
    // report the wells the game actually places in it.
    let wells: PlacedResource[] = [];
    if (this.resources[target - 1]!.wells) {
      for (let cy = Math.floor(minY / CHUNK); cy <= Math.floor(maxY / CHUNK); cy++) {
        for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++) {
          for (const r of this.chunkResources(cx, cy)) {
            if (r.resource !== target - 1 || r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
            if (mask[(r.y - minY) * width + (r.x - minX)]) wells.push(r);
          }
        }
      }
      amount = wells.reduce((sum, w) => sum + w.amount, 0);
      entities = wells.length;
    }
    return { resource: target - 1, amount, entities, tiles: px.length, x0: minX, y0: minY, width, height, mask, complete, wells };
  }

  /** The well, if any, whose footprint covers a tile. */
  private wellCovering(x: number, y: number): PlacedResource | null {
    for (let cy = Math.floor((y - 2) / CHUNK); cy <= Math.floor((y + 2) / CHUNK); cy++) {
      for (let cx = Math.floor((x - 2) / CHUNK); cx <= Math.floor((x + 2) / CHUNK); cx++) {
        // Only chunks an oil field reaches are worth replaying.
        if (!this.sparseChunks(cx * CHUNK, cy * CHUNK, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1).has(`${cx},${cy}`)) continue;
        for (const r of this.chunkResources(cx, cy)) {
          if (this.resources[r.resource]!.wells && Math.abs(r.x - x) <= 1 && Math.abs(r.y - y) <= 1) return r;
        }
      }
    }
    return null;
  }

  /** Chunks a sparse resource's fields reach, among those touching a
   *  rectangle of tiles. */
  private sparseChunks(minX: number, minY: number, maxX: number, maxY: number): Set<string> {
    const out = new Set<string>();
    const cx0 = Math.floor(minX / CHUNK);
    const cx1 = Math.floor(maxX / CHUNK);
    const cy0 = Math.floor(minY / CHUNK);
    const cy1 = Math.floor(maxY / CHUNK);
    this.resourceRoots.forEach((root, r) => {
      if (!this.resources[r]!.wells) return;
      // A field is its spot, roughened: allow well past the nominal radius.
      const reach = 80;
      for (const spot of this.spotsIn(root, minX - reach, minY - reach, maxX + reach, maxY + reach)) {
        const span = spot.radius * 2 + 8;
        for (let cy = Math.max(cy0, Math.floor((spot.y - span) / CHUNK)); cy <= Math.min(cy1, Math.floor((spot.y + span) / CHUNK)); cy++) {
          for (let cx = Math.max(cx0, Math.floor((spot.x - span) / CHUNK)); cx <= Math.min(cx1, Math.floor((spot.x + span) / CHUNK)); cx++) out.add(`${cx},${cy}`);
        }
      }
    });
    return out;
  }

  /** Whether the planet has territories at all. */
  get hasTerritories(): boolean {
    return this.territoryRoot !== null;
  }

  /** The territory of each of a block of chunks: a number that is the same
   *  for every chunk of one territory, 0 where there is none.
   *
   *  The game asks the planet's territory expression once per chunk, at the
   *  chunk's first tile; chunks that get the same answer are one territory
   *  and an answer of zero or less (Vulcanus's starting area) is none. */
  territories(chunkX0: number, chunkY0: number, cols: number, rows: number): Float32Array {
    if (this.territoryRoot === null) return new Float32Array(cols * rows);
    const xs = new Float32Array(cols * rows);
    const ys = new Float32Array(cols * rows);
    for (let k = 0; k < xs.length; k++) {
      xs[k] = (chunkX0 + (k % cols)) * CHUNK;
      ys[k] = (chunkY0 + Math.floor(k / cols)) * CHUNK;
    }
    const out = this.evaluate([this.territoryRoot], xs, ys)[0]!;
    for (let k = 0; k < out.length; k++) if (!(out[k]! > 0) || !this.inMap(xs[k]!, ys[k]!)) out[k] = 0;
    return out;
  }

  /** Mark the samples that lie along a territory's border. */
  private sampleTerritories(grid: SampleGrid, x0: number, y0: number, step: number): void {
    if (this.territoryRoot === null) return;
    const { cols, rows } = grid;
    // Two tiles thick up close, one sample from further out.
    const reach = Math.max(step, 2);
    const cx0 = Math.floor((x0 - reach) / CHUNK);
    const cy0 = Math.floor((y0 - reach) / CHUNK);
    const ccols = Math.floor((x0 + (cols - 1) * step) / CHUNK) - cx0 + 1;
    const crows = Math.floor((y0 + (rows - 1) * step) / CHUNK) - cy0 + 1;
    const owner = this.territories(cx0, cy0, ccols, crows);
    const at = (x: number, y: number): number => owner[(Math.floor(y / CHUNK) - cy0) * ccols + Math.floor(x / CHUNK) - cx0]!;
    for (let j = 0; j < rows; j++) {
      const y = y0 + j * step;
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * step;
        const here = at(x, y);
        if (here !== at(x - reach, y) || here !== at(x, y - reach)) grid.territory[j * cols + i] = 1;
      }
    }
  }

  /** Mark the fixtures the game places, each over the tiles it covers. */
  private sampleDecor(grid: SampleGrid, x0: number, y0: number, step: number): void {
    const { cols, rows } = grid;
    for (let cy = Math.floor(y0 / CHUNK) - 1; cy <= Math.floor((y0 + rows * step - 1) / CHUNK) + 1; cy++) {
      for (let cx = Math.floor(x0 / CHUNK) - 1; cx <= Math.floor((x0 + cols * step - 1) / CHUNK) + 1; cx++) {
        // Nothing stands in the void beyond a bounded map.
        if (!this.inMap(cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2)) continue;
        for (const d of this.chunkDecor(cx, cy)) {
          const i0 = Math.max(0, Math.ceil((Math.floor(d.x + d.box[0][0]) - x0) / step));
          const i1 = Math.min(cols - 1, Math.floor((Math.floor(d.x + d.box[1][0] - 1e-6) - x0) / step));
          const j0 = Math.max(0, Math.ceil((Math.floor(d.y + d.box[0][1]) - y0) / step));
          const j1 = Math.min(rows - 1, Math.floor((Math.floor(d.y + d.box[1][1] - 1e-6) - y0) / step));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid.decor[j * cols + i] = d.decor + 1;
        }
      }
    }
  }

  /** Replace a sparse resource's field in a sampled grid by its wells. Up
   *  close each well covers its 3x3 footprint; from far out, where replaying
   *  every chunk would cost too much, each field is one mark at its centre. */
  private sampleWells(grid: SampleGrid, x0: number, y0: number, step: number): void {
    const { cols, rows } = grid;
    const sparse = this.resources.map((r) => r.wells);
    if (!sparse.some(Boolean)) return;
    for (let k = 0; k < grid.resource.length; k++) if (grid.resource[k] && sparse[grid.resource[k]! - 1]) grid.resource[k] = 0;
    const maxX = x0 + (cols - 1) * step;
    const maxY = y0 + (rows - 1) * step;
    const mark = (resource: number, tx: number, ty: number, reach: number): void => {
      // Every sample the footprint covers, and always the one at its centre.
      const i0 = Math.ceil((tx - reach - x0) / step);
      const i1 = Math.floor((tx + reach - x0) / step);
      const j0 = Math.ceil((ty - reach - y0) / step);
      const j1 = Math.floor((ty + reach - y0) / step);
      let any = false;
      for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) {
          // A well at the edge of a bounded map does not reach into the void.
          if (grid.tile[j * cols + i] !== this.voidTile) grid.resource[j * cols + i] = resource + 1;
          any = true;
        }
      }
      if (any) return;
      const i = Math.floor((tx - x0) / step);
      const j = Math.floor((ty - y0) / step);
      if (i >= 0 && j >= 0 && i < cols && j < rows && grid.tile[j * cols + i] !== this.voidTile) grid.resource[j * cols + i] = resource + 1;
    };
    if (step > 4) {
      this.resourceRoots.forEach((root, r) => {
        if (!sparse[r]) return;
        for (const spot of this.spotsIn(root, x0, y0, maxX + step - 1, maxY + step - 1)) if (!this.tiles[this.tileAt(spot.x, spot.y)]!.noResources) mark(r, spot.x, spot.y, 0);
      });
      return;
    }
    for (const key of this.sparseChunks(x0 - 1, y0 - 1, maxX + step, maxY + step)) {
      const [cx, cy] = key.split(",").map(Number) as [number, number];
      for (const r of this.chunkResources(cx, cy)) if (sparse[r.resource]) mark(r.resource, r.x, r.y, 1);
    }
  }

  /** Everything known about one tile. */
  probe(x: number, y: number): Probe {
    const roots = [this.elevationRoot, ...this.tileRoots, ...this.resourceRoots, ...this.richnessRoots];
    if (this.enemyRoot !== null) roots.push(this.enemyRoot);
    const v = this.evaluate(roots, Float32Array.of(x), Float32Array.of(y)).map((a) => a[0]!);
    const nTiles = this.tileRoots.length;
    const nRes = this.resourceRoots.length;
    let best = 0;
    let bestP = -Infinity;
    for (let t = 0; t < nTiles; t++) {
      if (v[1 + t]! > bestP) {
        bestP = v[1 + t]!;
        best = t;
      }
    }
    const tile = this.tiles[best]!;
    let resource: string | null = null;
    let richness = 0;
    if (!tile.noResources) {
      let best = -1;
      for (let r = 0; r < nRes; r++) {
        const p = v[1 + nTiles + r]!;
        if (!(p > 0)) continue;
        if (best < 0) best = r;
        else if (this.resourceOrders[r] === this.resourceOrders[best]) {
          const bestP = v[1 + nTiles + best]!;
          if (p > bestP || (p === bestP && v[1 + nTiles + nRes + r]! > v[1 + nTiles + nRes + best]!)) best = r;
        }
      }
      if (best >= 0) {
        resource = this.resources[best]!.name;
        richness = v[1 + nTiles + nRes + best]!;
      }
    }
    const enemy = this.enemyRoot === null || tile.water ? 0 : Math.max(0, v[v.length - 1]!);
    return { x, y, tile: tile.name, elevation: v[0]!, resource, richness, enemy };
  }

  /** Operations of one kind under a root, with their node ids. */
  private findNodes(root: number, op: Op): { id: number; node: Node }[] {
    const nodes = this.program.nodes;
    const seen = new Set<number>();
    const found: { id: number; node: Node }[] = [];
    const visit = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = nodes[id]!;
      if (node.op === op) found.push({ id, node });
      for (const a of node.args) visit(a);
    };
    visit(root);
    return found;
  }

  private findNode(root: number, op: Op): Node | undefined {
    return this.findNodes(root, op)[0]?.node;
  }

  private spotsIn(root: number, minX: number, minY: number, maxX: number, maxY: number): { x: number; y: number; radius: number; p: SpotParams }[] {
    const out: { x: number; y: number; radius: number; p: SpotParams }[] = [];
    // The `spot_noise` operations under a root: a resource's starting and
    // regular patch sets, or the enemy bases.
    for (const { id, node } of this.findNodes(root, "spot")) {
      const p = node.p as SpotParams;
      const half = p.regionSize / 2;
      const rx0 = Math.floor((minX + half) / p.regionSize);
      const rx1 = Math.floor((maxX + half) / p.regionSize);
      const ry0 = Math.floor((minY + half) / p.regionSize);
      const ry1 = Math.floor((maxY + half) / p.regionSize);
      for (let ry = ry0; ry <= ry1; ry++) {
        for (let rx = rx0; rx <= rx1; rx++) {
          for (const s of this.evaluator.regionSpots(p, id, rx, ry)) {
            if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) out.push({ x: s.x, y: s.y, radius: s.radius, p });
          }
        }
      }
    }
    return out;
  }

  /** Patch centres inside a rectangle. The patch itself may be missing if
   *  it landed in water; `patchAmount` tells. */
  resourcePatches(minX: number, minY: number, maxX: number, maxY: number): ResourcePatch[] {
    const out: ResourcePatch[] = [];
    this.resourceRoots.forEach((root, resource) => {
      for (const s of this.spotsIn(root, minX, minY, maxX, maxY)) {
        out.push({ resource, x: s.x, y: s.y, radius: s.radius, starting: s.p.hardTarget });
      }
    });
    return out;
  }

  /** What a patch holds, summed tile by tile over its neighbourhood. */
  patchAmount(patch: ResourcePatch): PatchAmount {
    const reach = Math.ceil(patch.radius * 1.5) + 6;
    const side = reach * 2 + 1;
    const roots = [this.resourceRoots[patch.resource]!, this.richnessRoots[patch.resource]!, ...this.tileRoots];
    const sparse = this.resources[patch.resource]!.chance;
    let amount = 0;
    let tiles = 0;
    let entities = 0;
    for (let row = 0; row < side; row++) {
      const xs = new Float32Array(side);
      const ys = new Float32Array(side);
      for (let i = 0; i < side; i++) {
        xs[i] = patch.x - reach + i;
        ys[i] = patch.y - reach + row;
      }
      const v = this.evaluate(roots, xs, ys);
      for (let i = 0; i < side; i++) {
        const p = v[0]![i]!;
        if (!(p > 0)) continue;
        if (this.tiles[winningTile(v, 2, this.tileRoots.length, i)]!.noResources) continue;
        // A sparse resource rolls against `p * (1 - u / chance)`; over a
        // uniform u that succeeds with probability p * chance / 2.
        const chance = (p < 1 ? p : 1) * (sparse < 1 ? sparse * 0.5 : 1);
        tiles++;
        entities += chance;
        amount += chance * v[1]![i]!;
      }
    }
    return { amount, tiles, entities };
  }

  /** Enemy bases with their centre inside a rectangle. */
  enemyBases(minX: number, minY: number, maxX: number, maxY: number): EnemyBase[] {
    if (this.enemyRoot === null) return [];
    const spots = this.spotsIn(this.enemyRoot, minX, minY, maxX, maxY);
    if (spots.length === 0) return [];
    // A base that the starting area, or water, suppresses has no tile where
    // a spawner can stand at its centre.
    const xs = Float32Array.from(spots, (s) => s.x);
    const ys = Float32Array.from(spots, (s) => s.y);
    const v = this.evaluate([this.enemyRoot, ...this.tileRoots], xs, ys);
    const out: EnemyBase[] = [];
    spots.forEach((s, i) => {
      if (!(v[0]![i]! > 0)) return;
      if (!this.tiles[winningTile(v, 1, this.tileRoots.length, i)]!.water) out.push({ x: s.x, y: s.y, radius: s.radius });
    });
    return out;
  }
}

