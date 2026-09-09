import type { EntityGraphics, GameData, HeatConnectionPoint, InserterGraphics, PipeConnectionPoint, RenderCatalog } from "@factoriotools/engine";
import { toCardinal, Dir } from "./neighbours/grid.js";

/** One lookup over both GameData (entities with rates) and the RenderCatalog
 *  (visual-only ones) — the renderer doesn't care which side a name came
 *  from, only how to draw it. */
export interface ResolvedVisual {
  tileFootprint: [number, number];
  graphics?: EntityGraphics;
  /** Inserters are drawn procedurally, outside the EntityGraphics model. */
  inserterGraphics?: InserterGraphics;
  rotatesFootprint?: boolean;
  localised: string;
  isMachine: boolean;
  isBeacon: boolean;
  moduleSlots: number;
  /** Alt mode draws a facing arrow for these. */
  showDirectionArrow: boolean;
  /** Fluid-box connection points, in the entity's own unrotated local frame
   *  — feeds the fluid network graph (neighbours/fluid.ts). Undefined for
   *  every entity with no fluid box. */
  pipeConnections?: PipeConnectionPoint[];
  /** `heat_buffer.connections` points, in the entity's own unrotated local
   *  frame — feeds the heat network graph (neighbours/heat.ts). Undefined
   *  for every entity with no heat buffer. */
  heatConnections?: HeatConnectionPoint[];
}

const EMPTY = {
  isMachine: false,
  isBeacon: false,
  moduleSlots: 0,
  showDirectionArrow: false,
};

export function buildVisualLookup(data: GameData, catalog: RenderCatalog): Map<string, ResolvedVisual> {
  const lookup = new Map<string, ResolvedVisual>();

  for (const m of Object.values(data.machines)) {
    lookup.set(m.name, {
      ...EMPTY,
      tileFootprint: m.tileFootprint ?? m.size,
      graphics: m.graphics,
      localised: m.localised,
      isMachine: true,
      moduleSlots: m.moduleSlots,
      pipeConnections: m.pipeConnections,
    });
  }
  for (const b of Object.values(data.beacons)) {
    lookup.set(b.name, {
      ...EMPTY,
      tileFootprint: b.size,
      graphics: b.graphics,
      localised: b.localised,
      isBeacon: true,
      moduleSlots: b.moduleSlots,
    });
  }
  for (const belt of Object.values(data.belts)) {
    lookup.set(belt.name, {
      ...EMPTY,
      tileFootprint: [1, 1],
      graphics: belt.graphics,
      localised: belt.localised,
    });
  }
  for (const inserter of Object.values(data.inserters)) {
    lookup.set(inserter.name, {
      ...EMPTY,
      tileFootprint: [1, 1],
      inserterGraphics: inserter.graphics,
      localised: inserter.localised,
      showDirectionArrow: true,
    });
  }
  for (const e of Object.values(catalog.entities)) {
    if (lookup.has(e.name)) continue;
    lookup.set(e.name, {
      ...EMPTY,
      tileFootprint: e.tileFootprint,
      graphics: e.graphics,
      rotatesFootprint: e.rotatesFootprint,
      localised: e.localised,
      showDirectionArrow: e.name.includes("combinator"),
      pipeConnections: e.pipeConnections,
      heatConnections: e.heatConnections,
    });
  }
  return lookup;
}

/** tileFootprint is stored north-facing; a rotatesFootprint entity swaps
 *  width and depth when it faces east or west. */
/** Whether any of this entity's layers pick their frame by the animation
 *  clock. The render loop uses it to decide whether the next frame would even
 *  look different: a scene with no animated entity on screen is static, and
 *  redrawing it 60 times a second changes nothing.
 *
 *  Cached per visual because the answer depends only on the catalog, which
 *  does not change while a renderer is mounted, and this is asked once per
 *  visible entity per frame. */
const animatedCache = new WeakMap<ResolvedVisual, boolean>();

export function hasAnimatedLayer(visual: ResolvedVisual): boolean {
  const cached = animatedCache.get(visual);
  if (cached !== undefined) return cached;

  let animated = false;
  for (const layer of visual.graphics?.layers ?? []) {
    // Both axes can carry the animation clock, and a `per`-keyed layer
    // (module slots, heat patches) nests its own sprites but keeps the
    // layer-level axes, so checking the axes covers every shape.
    const axes = [(layer as { column?: { by?: string } }).column, (layer as { row?: { by?: string } }).row];
    if (axes.some((axis) => axis?.by === "animation")) {
      animated = true;
      break;
    }
  }
  animatedCache.set(visual, animated);
  return animated;
}

export function effectiveFootprint(visual: ResolvedVisual, direction: number): [number, number] {
  const [w, h] = visual.tileFootprint;
  if (!visual.rotatesFootprint) return [w, h];
  const facing = toCardinal(direction);
  return facing === Dir.East || facing === Dir.West ? [h, w] : [w, h];
}

/** True for every underground-belt/loader tier (all vanilla names end in
 *  "underground-belt" or contain "loader" — loader-1x1, loader, *-loader).
 *  These are the belt-connector entities whose PlacedEntity MUST carry a
 *  real undergroundType ("input" unless a blueprint's own `type` field says
 *  "output") — collect.ts's resolveFrame branches on undergroundType being
 *  defined at all to pick the underground/loader structure art over plain
 *  belt row/cap art, so any caller that builds one of these without setting
 *  it (a freshly-placed entity, or the placement ghost) would otherwise
 *  render as a half-cropped, misrotated belt tread instead of the real
 *  entrance/exit structure. */
export function isUndergroundLike(name: string): boolean {
  return name.endsWith("underground-belt") || name.includes("loader");
}

/** True for every electric-pole tier (small/medium/big-electric-pole,
 *  substation). Poles must never be player-rotated: their facing is
 *  meaningless today and will later be derived automatically from the wires
 *  connected to them, so exposing a manual rotate would just be undone by
 *  that future auto-orientation. */
export function isPoleLike(name: string): boolean {
  return name.endsWith("electric-pole") || name === "substation";
}

/** Entities that rotate in 22.5° increments (step 1 of the 16-way scheme)
 *  instead of the usual 90° (step 4) — rail-signal/rail-chain-signal have
 *  a genuine 16-row direction sheet (data-pipeline's railSignalGraphics),
 *  one real sprite per step. */
const FINE_ROTATION = new Set(["rail-signal", "rail-chain-signal"]);

/** Entities that rotate in 45° increments (step 2 of 16) — 8-way, matching
 *  their own 8 real facing sprites (dir8) — railgun-turret only, so far. */
const EIGHT_WAY_ROTATION = new Set(["railgun-turret"]);

/** The R/Shift+R rotation step, in the 16-way scheme this renderer
 *  produces for every direction value (see rotateGhost's own doc comment).
 *  Every entity rotates in 90° increments (step 4 of 16) except
 *  FINE_ROTATION (step 1) and EIGHT_WAY_ROTATION (step 2) above. */
export function rotationStep(name: string): number {
  if (FINE_ROTATION.has(name)) return 1;
  if (EIGHT_WAY_ROTATION.has(name)) return 2;
  return 4;
}

/** True for every `two_direction_only` entity (only fusion-reactor today)
 *  — the real game only lets R toggle these between north and east, not
 *  the usual 4 (or, for rail-signal/rail-chain-signal, 16) facings. Its own
 *  connection-patch art (data-pipeline's fusionReactorGraphics) only has
 *  north/east sprites for exactly this reason — south/west would silently
 *  draw nothing for those layers. */
export function isTwoDirectionOnly(name: string): boolean {
  return name === "fusion-reactor";
}

/** For entities whose fluid boxes turn off entirely when the current
 *  recipe has no matching fluid ingredient/product (assembling-machine-2/3,
 *  foundry, electromagnetic-plant, cryogenic-plant — Factorio's own
 *  `fluid_boxes_off_when_no_fluid_recipe`), filters `points` down to just
 *  the boxes that recipe actually activates. Everything else — a
 *  single-fluid-box entity, or a multi-box one WITHOUT that flag
 *  (oil-refinery, chemical-plant — Factorio never turns their boxes off,
 *  a box just sits unconnected when a recipe doesn't use it) — passes
 *  through untouched.
 *
 *  Factorio assigns a recipe's fluid ingredients/products to boxes by
 *  matching declaration order: the machine's own boxes, in ascending
 *  fluidboxIndex, filtered to a flow direction, get the recipe's fluid
 *  ingredients (for input boxes) or products (for output) in the order
 *  each declares them — `fluidbox_index` on an ingredient/product
 *  overrides this only for the rare recipe that needs to (e.g.
 *  chemical-plant's basic-oil-processing); the implicit order-matching
 *  covers every one of these 4 machines' own recipes, none of which uses
 *  an explicit index. */
export function activeFluidConnections(
  points: PipeConnectionPoint[],
  recipeName: string | undefined,
  data: GameData,
): PipeConnectionPoint[] {
  const gated = points.some((p) => p.fluidboxIndex !== undefined && p.boxesOffWhenNoFluidRecipe);
  if (!gated) return points;

  const recipe = recipeName ? data.recipes[recipeName] : undefined;
  const isFluid = (name: string) => data.items[name]?.kind === "fluid";
  const fluidIngredientCount = recipe?.ingredients.filter((i) => isFluid(i.name)).length ?? 0;
  const fluidProductCount = recipe?.results.filter((r) => isFluid(r.name)).length ?? 0;

  // Rank each box among same-flow-direction boxes (ascending fluidboxIndex)
  // to know its position in the recipe's own ingredient/product order.
  const boxIndices = [...new Set(points.map((p) => p.fluidboxIndex).filter((i): i is number => i !== undefined))].sort((a, b) => a - b);
  const rankByFlow = new Map<"input" | "output" | "input-output", number>();
  const activeBoxes = new Set<number>();
  for (const boxIndex of boxIndices) {
    const flow = points.find((p) => p.fluidboxIndex === boxIndex)?.flowDirection;
    if (!flow) continue;
    const rank = rankByFlow.get(flow) ?? 0;
    rankByFlow.set(flow, rank + 1);
    const limit = flow === "output" ? fluidProductCount : fluidIngredientCount;
    if (rank < limit) activeBoxes.add(boxIndex);
  }
  return points.filter((p) => p.fluidboxIndex === undefined || activeBoxes.has(p.fluidboxIndex));
}

/** Family predicates for the neighbour classifiers, derived from which
 *  connector an entity declares. */
export function makeConnectorPredicates(lookup: Map<string, ResolvedVisual>) {
  const has = (kind: string) => (name: string) => lookup.get(name)?.graphics?.connector === kind;
  const isPipeLike = (name: string) => has("pipe")(name) || name === "pipe-to-ground";
  const isHeatPipeLike = has("heat-pipe");
  const isWallLike = (name: string) => has("wall")(name) || name === "gate";
  const isBeltLike = has("belt");
  const isPlatformLike = has("platform");
  return { isPipeLike, isHeatPipeLike, isWallLike, isBeltLike, isPlatformLike };
}
