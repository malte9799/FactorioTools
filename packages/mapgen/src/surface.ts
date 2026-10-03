/** A generated planet surface for one seed: what the seed viewer asks.
 *
 *  Wraps the compiler and evaluator behind map-shaped questions: which tile
 *  is here, where are the ore patches, how much is in one, where can enemies
 *  spawn. Everything is derived from the planet's autoplace rules. */
import { Program, type Node, type Op } from "./compiler.js";
import { Evaluator } from "./evaluator.js";
import { compileSettings, type MapGenData, type MapGenOptions } from "./settings.js";
import type { SpotParams } from "./spot.js";
import { cliffName, cliffPieces, onCliffLine, pointInBox, trimCliffs, type OrientedBox } from "./cliffs.js";
import { CHUNK, placementGroups, rollChunk, type Attempt, type PlacementEntity } from "./placement.js";

export type Rgb = [number, number, number];

export interface TileLayer {
  name: string;
  color: Rgb;
  water: boolean;
}

export interface ResourceLayer {
  name: string;
  color: Rgb;
  /** Share of patch tiles that pass the resource's random penalty: 1 for an
   *  ore that fills its patch, 1/48 for oil wells. */
  chance: number;
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
}

export interface SampleOptions {
  /** Trees cost about as much as everything else together. */
  trees?: boolean;
  cliffs?: boolean;
  /** Show a sparse resource (oil) as the wells the game places, not as the
   *  field they stand in. */
  wells?: boolean;
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
const WATER = /water|lava|ocean|ammoniacal/;
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
    if (node.op === "voronoi") missing.add(`voronoi_${node.p.kind as string}`);
    for (const a of node.args) visit(a);
    if (node.op === "spot") for (const key of ["density", "quantity", "radius", "favorability"] as const) visit((node.p as SpotParams)[key]);
    if (node.op === "multisample") visit(node.p.expr as number);
  };
  roots.forEach(visit);
  return [...missing].sort();
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
  private readonly cliffElevation0: number;
  private readonly cliffInterval: number;
  private readonly cliffBoxes: Record<string, OrientedBox>;
  /** Resources that fill their patch: these displace cliffs. */
  private readonly oreRoots: number[];
  /** Autoplace order of each resource, parallel to `resources`. */
  private readonly resourceOrders: string[];
  /** Everything the planet autoplaces, for replaying a chunk's rolls. */
  private readonly placementEntities: PlacementEntity[];
  private readonly placementGroups: number[][];
  /** Applies per-tile penalties: placement is one particular roll. */
  private readonly exactEvaluator: Evaluator;
  private readonly chunkWater = new Map<string, Uint8Array>();
  private readonly chunkPlaced = new Map<string, PlacedResource[]>();
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
    this.tiles = tileNames.map((name) => ({ name, color: data.autoplace.tile[name]?.map_color ?? [255, 0, 255], water: WATER.test(name) }));
    // A bounded map (the ribbon world) ends in void; nothing generates there.
    this.halfWidth = options.width ? options.width / 2 : Infinity;
    this.halfHeight = options.height ? options.height / 2 : Infinity;
    this.voidTile = this.tiles.length;
    if (options.width || options.height) this.tiles.push({ name: "out-of-map", color: [0, 0, 0], water: true });
    this.tileRoots = tileNames.map((name) => program.named(`tile:${name}:probability`));

    const resources = entities.filter(([, a]) => a.type === "resource");
    this.resourceRoots = resources.map(([name]) => program.named(`entity:${name}:probability`));
    this.resourceOrders = resources.map(([, a]) => a.order ?? "");
    this.resources = resources.map(([name, a], i) => {
      const penalty = this.findNode(this.resourceRoots[i]!, "random_penalty");
      return {
        name,
        color: a.map_color ?? [255, 255, 255],
        chance: penalty ? 1 / (penalty.p.amplitude as number) : 1,
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
      aquatic: a.type === "fish",
    }));
    this.placementGroups = placementGroups(entities.map(([, a]) => ({ order: a.order ?? "" })));

    const cliff = data.cliffs?.[mgs.cliff_settings?.name ?? ""];
    // With cliff smoothing on (the Lakes and Island presets) the game places
    // cliffs by a rule not reproduced here; show none rather than wrong ones.
    // Only an explicit zero counts: Vulcanus leaves smoothing unset and the
    // game's default is not zero.
    const smoothed = (options.cliffs?.smoothing ?? mgs.cliff_settings?.cliff_smoothing) !== 0;
    this.cliffRoots = cliff && !smoothed ? [program.named("cliff_elevation"), program.named("cliffiness")] : null;
    this.cliffElevation0 = settings.constants.cliff_elevation_0 ?? 10;
    this.cliffInterval = settings.constants.cliff_elevation_interval ?? 40;
    this.cliffBoxes = cliff?.orientations ?? {};
    this.oreRoots = this.resourceRoots.filter((_, i) => this.resources[i]!.chance === 1);
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

  /** Which of a chunk's 1024 tiles are water. */
  private waterOf(chunkX: number, chunkY: number): Uint8Array {
    const key = `${chunkX},${chunkY}`;
    let water = this.chunkWater.get(key);
    if (water) return water;
    const xs = new Float32Array(CHUNK * CHUNK);
    const ys = new Float32Array(CHUNK * CHUNK);
    for (let k = 0; k < xs.length; k++) {
      xs[k] = chunkX * CHUNK + (k % CHUNK);
      ys[k] = chunkY * CHUNK + Math.floor(k / CHUNK);
    }
    const tile = this.evaluate(this.tileRoots, xs, ys);
    water = new Uint8Array(xs.length);
    for (let k = 0; k < xs.length; k++) {
      let best = 0;
      for (let t = 1; t < tile.length; t++) if (tile[t]![k]! > tile[best]![k]!) best = t;
      if (this.tiles[best]!.water) water[k] = 1;
    }
    if (this.chunkWater.size > 4096) this.chunkWater.clear();
    this.chunkWater.set(key, water);
    return water;
  }

  private isWater(x: number, y: number): boolean {
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    return this.waterOf(cx, cy)[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)] === 1;
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
      values.slice(0, entities.length), values.slice(entities.length), this.waterOf(chunkX, chunkY),
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
      // Resources collide with each other and with water, nothing else.
      let free = true;
      for (let i = 0; i < placed.length && free; i++) {
        const [[ox1, oy1], [ox2, oy2]] = boxes[i]!;
        const ox = placed[i]!.x + 0.5;
        const oy = placed[i]!.y + 0.5;
        if (cx + x1 < ox + ox2 && cx + x2 > ox + ox1 && cy + y1 < oy + oy2 && cy + y2 > oy + oy1) free = false;
      }
      for (let ty = Math.floor(cy + y1); ty <= Math.floor(cy + y2) && free; ty++) {
        for (let tx = Math.floor(cx + x1); tx <= Math.floor(cx + x2) && free; tx++) if (this.isWater(tx, ty)) free = false;
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

  /** Cliff pieces for a block of grid cells, as codes from `cliffs.ts`.
   *
   *  `grid` is the cell size in tiles. At the game's own 4 the result is the
   *  game's cliffs, less the pieces ore displaces; a larger grid follows the
   *  same contour more coarsely, for views zoomed too far out to show cells. */
  cliffs(cellX0: number, cellY0: number, cols: number, rows: number, grid = 4): Uint8Array {
    if (!this.cliffRoots) return new Uint8Array(cols * rows);
    // One cell of margin: whether a line ends in a cell depends on its
    // neighbours.
    const mc = cols + 2;
    const mr = rows + 2;
    const vx = new Float32Array((mc + 1) * (mr + 1));
    const vy = new Float32Array(vx.length);
    for (let j = 0; j <= mr; j++) {
      for (let i = 0; i <= mc; i++) {
        vx[j * (mc + 1) + i] = (cellX0 - 1 + i) * grid;
        vy[j * (mc + 1) + i] = (cellY0 - 1 + j) * grid;
      }
    }
    const [elevation, cliffiness] = this.evaluate(this.cliffRoots, vx, vy);
    const pieces = cliffPieces(elevation!, cliffiness!, mc, mr, this.cliffElevation0, this.cliffInterval);
    const displaced = grid === 4 ? this.cliffsUnderOre(pieces, cellX0 - 1, cellY0 - 1, mc) : new Set<number>();
    trimCliffs(pieces, mc, mr, (k) => displaced.has(k));
    const out = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) out.set(pieces.subarray((j + 1) * mc + 1, (j + 1) * mc + 1 + cols), j * cols);
    return out;
  }

  /** Cells whose piece collides with an ore tile: the game puts no cliff
   *  there. Oil wells displace cliffs too, but where they stand is random. */
  private cliffsUnderOre(pieces: Uint8Array, cellX0: number, cellY0: number, cols: number): Set<number> {
    const cells: number[] = [];
    for (let k = 0; k < pieces.length; k++) if (pieces[k]) cells.push(k);
    const out = new Set<number>();
    if (cells.length === 0 || this.oreRoots.length === 0) return out;
    // A piece reaches at most a few tiles past its 4x4 cell.
    const W = 10;
    const H = 10;
    const xs = new Float32Array(cells.length * W * H);
    const ys = new Float32Array(xs.length);
    cells.forEach((k, c) => {
      const tx = (cellX0 + (k % cols)) * 4 - 3;
      const ty = (cellY0 + Math.floor(k / cols)) * 4 - 3;
      for (let i = 0; i < W * H; i++) {
        xs[c * W * H + i] = tx + (i % W);
        ys[c * W * H + i] = ty + Math.floor(i / W);
      }
    });
    const ore = this.evaluate(this.oreRoots, xs, ys);
    cells.forEach((k, c) => {
      const box = this.cliffBoxes[cliffName(pieces[k]!)!];
      if (!box) return;
      // The cliff entity stands at the cell centre, half a tile south.
      const originX = (cellX0 + (k % cols)) * 4 + 2;
      const originY = (cellY0 + Math.floor(k / cols)) * 4 + 2.5;
      for (let i = 0; i < W * H; i++) {
        const at = c * W * H + i;
        if (!ore.some((p) => p[at]! > 0)) continue;
        if (pointInBox(box, originX, originY, xs[at]! + 0.5, ys[at]! + 0.5, 0.1)) {
          out.add(k);
          return;
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
    };
    if (options.cliffs) this.sampleCliffs(grid, x0, y0, step);
    const wells = options.wells ?? false;
    const nTiles = this.tileRoots.length;
    const roots = [...this.tileRoots, ...this.resourceRoots, ...this.richnessRoots];
    const enemyAt = this.enemyRoot === null ? -1 : roots.push(this.enemyRoot) - 1;
    const treesAt = roots.length;
    if (trees) roots.push(...this.treeRoots);

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
      const v = this.evaluator.run(roots, xs, ys);
      for (let i = 0; i < n; i++) {
        let best = 0;
        let bestP = -Infinity;
        for (let t = 0; t < nTiles; t++) {
          const p = v[t]![i]!;
          if (p > bestP) {
            bestP = p;
            best = t;
          }
        }
        const k = start + i;
        if (Math.abs(xs[i]! + 0.5) > this.halfWidth || Math.abs(ys[i]! + 0.5) > this.halfHeight) {
          grid.tile[k] = this.voidTile;
          grid.cliff[k] = 0;
          continue;
        }
        grid.tile[k] = best;
        if (this.tiles[best]!.water) continue;
        grid.resource[k] = this.resourceAt(v, nTiles, i) + 1;
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
      }
    }
    if (wells) this.sampleWells(grid, x0, y0, step);
    return grid;
  }

  private sampleCliffs(grid: SampleGrid, x0: number, y0: number, step: number): void {
    const { cols, rows } = grid;
    const cell = Math.max(4, step);
    const perCell = cell / step;
    const cx0 = Math.floor(x0 / cell);
    const cy0 = Math.floor(y0 / cell);
    const cx1 = Math.floor((x0 + (cols - 1) * step) / cell);
    const cy1 = Math.floor((y0 + (rows - 1) * step) / cell);
    const ccols = cx1 - cx0 + 1;
    const pieces = this.cliffs(cx0, cy0, ccols, cy1 - cy0 + 1, cell);
    for (let j = 0; j < rows; j++) {
      const y = y0 + j * step;
      const cy = Math.floor(y / cell);
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * step;
        const cx = Math.floor(x / cell);
        const code = pieces[(cy - cy0) * ccols + (cx - cx0)]!;
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
        let best = 0;
        for (let t = 1; t < nTiles; t++) if (tile[t]![i]! > tile[best]![i]!) best = t;
        if (this.tiles[best]!.water) continue;
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
    if (this.resources[target - 1]!.chance < 1) {
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
          if (this.resources[r.resource]!.chance < 1 && Math.abs(r.x - x) <= 1 && Math.abs(r.y - y) <= 1) return r;
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
      if (this.resources[r]!.chance === 1) return;
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

  /** Replace a sparse resource's field in a sampled grid by its wells. Up
   *  close each well covers its 3x3 footprint; from far out, where replaying
   *  every chunk would cost too much, each field is one mark at its centre. */
  private sampleWells(grid: SampleGrid, x0: number, y0: number, step: number): void {
    const { cols, rows } = grid;
    const sparse = this.resources.map((r) => r.chance < 1);
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
          grid.resource[j * cols + i] = resource + 1;
          any = true;
        }
      }
      if (any) return;
      const i = Math.floor((tx - x0) / step);
      const j = Math.floor((ty - y0) / step);
      if (i >= 0 && j >= 0 && i < cols && j < rows) grid.resource[j * cols + i] = resource + 1;
    };
    if (step > 4) {
      this.resourceRoots.forEach((root, r) => {
        if (!sparse[r]) return;
        for (const spot of this.spotsIn(root, x0, y0, maxX + step - 1, maxY + step - 1)) if (!this.isWater(spot.x, spot.y)) mark(r, spot.x, spot.y, 0);
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
    for (let t = 1; t < nTiles; t++) if (v[1 + t]! > v[1 + best]!) best = t;
    const tile = this.tiles[best]!;
    let resource: string | null = null;
    let richness = 0;
    if (!tile.water) {
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
        let best = 0;
        for (let t = 1; t < this.tileRoots.length; t++) if (v[2 + t]![i]! > v[2 + best]![i]!) best = t;
        if (this.tiles[best]!.water) continue;
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
      let best = 0;
      for (let t = 1; t < this.tileRoots.length; t++) if (v[1 + t]![i]! > v[1 + best]![i]!) best = t;
      if (!this.tiles[best]!.water) out.push({ x: s.x, y: s.y, radius: s.radius });
    });
    return out;
  }
}

