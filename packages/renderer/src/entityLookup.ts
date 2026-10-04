import type { EntityGraphics, GameData, HeatConnectionPoint, InserterGraphics, PipeConnectionPoint, PlacedEntity, RenderCatalog, WireAttachPoints } from "@factoriotools/engine";
import { toCardinal, opposite, step, Dir } from "./neighbours/grid.js";
import { isRail, railFootprint } from "./railGeometry.js";

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
  /** Beacons only: how each module's slot art looks, keyed by module name. */
  moduleArt?: Record<string, ModuleArt>;
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
  /** Where each wire colour attaches to this entity's sprite, per facing —
   *  a combinator's input side, and every other wired entity's only side.
   *  Undefined for the majority of entities, which cannot be wired. */
  wireConnections?: WireAttachPoints;
  /** A combinator's output-side attachment points. */
  outputWireConnections?: WireAttachPoints;
  /** Poles only: half-width of the square supply area, in tiles. */
  supplyAreaDistance?: number;
  /** Poles only: copper wire reach, in tiles. */
  maxWireDistance?: number;
  /** Rails only: the rail's entity name, whose footprint railGeometry
   *  works out per facing. */
  rail?: string;
}

/** A module's look inside a beacon slot — its tier picks the art variation,
 *  its tint colours the overlays (CSS rgb strings, ready for the painter). */
export interface ModuleArt {
  tier: number;
  primary?: string;
  secondary?: string;
}

const cssRgb = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

const EMPTY = {
  isMachine: false,
  isBeacon: false,
  moduleSlots: 0,
  showDirectionArrow: false,
};

/** Machines whose non-square footprint genuinely swaps width/height when
 *  rotated east/west, confirmed against their real in-game collision box
 *  (not just their selection_box, which can be non-square even for an
 *  entity that never actually swaps — e.g. stone-furnace's 1.6x2
 *  selection_box hides a square 2x2 collision box, so footprint inequality
 *  alone isn't a safe signal here). Mirrors render-catalog.ts's own
 *  ROTATES_FOOTPRINT allowlist for visual-only entities — this is the
 *  machine-side equivalent, needed because buildVisualLookup never set
 *  rotatesFootprint for anything sourced from data.machines. */
const MACHINE_ROTATES_FOOTPRINT = new Set([
  "steam-engine",
  "steam-turbine",
  "crusher",
  "recycler",
]);

/** Circuit-connectable buildings besides poles, combinators and crafting
 *  machines, by prototype name. */
const CIRCUIT_CONNECTABLE =
  /transport-belt$|inserter|chest|container|lamp|display-panel|pump|mining-drill|train-stop|rail-signal|rail-chain-signal|roboport|accumulator|programmable-speaker|storage-tank|gate$|splitter|turret|wagon|loader|agricultural-tower|asteroid-collector|cargo-landing-pad|space-platform-hub|reactor|silo/;

function centreTerminal([w, h]: [number, number]): WireAttachPoints {
  const dx = Math.min(0.18, w * 0.15);
  const dy = -Math.min(0.2, h * 0.2);
  const point = { red: [-dx, dy] as [number, number], green: [dx, dy] as [number, number] };
  return { byDirection: [point, point, point, point] };
}

export function buildVisualLookup(data: GameData, catalog: RenderCatalog): Map<string, ResolvedVisual> {
  const lookup = new Map<string, ResolvedVisual>();

  for (const m of Object.values(data.machines)) {
    lookup.set(m.name, {
      ...EMPTY,
      tileFootprint: m.tileFootprint ?? m.size,
      graphics: m.graphics,
      rotatesFootprint: MACHINE_ROTATES_FOOTPRINT.has(m.name),
      localised: m.localised,
      isMachine: true,
      moduleSlots: m.moduleSlots,
      pipeConnections: m.pipeConnections,
    });
  }
  const moduleArt: Record<string, ModuleArt> = {};
  for (const m of Object.values(data.modules)) {
    moduleArt[m.name] = {
      tier: m.tier ?? 1,
      primary: m.beaconTint && cssRgb(m.beaconTint.primary),
      secondary: m.beaconTint && cssRgb(m.beaconTint.secondary),
    };
  }
  for (const b of Object.values(data.beacons)) {
    lookup.set(b.name, {
      moduleArt,
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
      wireConnections: e.wireConnections,
      outputWireConnections: e.outputWireConnections,
      supplyAreaDistance: e.supplyAreaDistance,
      maxWireDistance: e.maxWireDistance,
      rail: isRail(e.name) ? e.name : undefined,
    });
  }
  // Most buildings take circuit wires, but the dataset only records where
  // they attach for poles and combinators. Everything else that can be
  // wired gets a terminal near its centre, so its wires draw and the
  // editor can connect them.
  for (const [name, visual] of lookup) {
    if (visual.wireConnections || !(visual.isMachine || CIRCUIT_CONNECTABLE.test(name))) continue;
    visual.wireConnections = centreTerminal(visual.tileFootprint);
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
  // A rail's footprint changes shape with its facing in ways no width/height
  // swap describes (a curve's box is neither square nor symmetric).
  if (visual.rail) return railFootprint(visual.rail, direction);
  const [w, h] = visual.tileFootprint;
  if (!visual.rotatesFootprint) return [w, h];
  const facing = toCardinal(direction);
  return facing === Dir.East || facing === Dir.West ? [h, w] : [w, h];
}

/** Whether building `name` at (x, y) facing `direction` builds over
 *  `existing` instead of colliding with it — the game's fast-replace rule:
 *  the same spot, and either the same entity (a rebuild that re-faces or
 *  re-qualities it) or one from the same fast-replace group with the same
 *  footprint (any inserter over any inserter, a turbine over a steam
 *  engine, but not a 3x3 electric furnace over a 2x2 stone one). `groups`
 *  is RenderCatalog.replaceGroups. */
export function canBuildOver(
  existing: PlacedEntity,
  name: string,
  x: number,
  y: number,
  direction: number,
  visualFor: (name: string) => ResolvedVisual | undefined,
  groups: Record<string, string> | undefined,
): boolean {
  if (existing.x !== x || existing.y !== y) return false;
  if (existing.name === name) return true;
  const group = groups?.[name];
  if (!group || groups![existing.name] !== group) return false;
  const oldVisual = visualFor(existing.name);
  const newVisual = visualFor(name);
  if (!oldVisual || !newVisual) return false;
  const [oldW, oldH] = effectiveFootprint(oldVisual, existing.direction);
  const [newW, newH] = effectiveFootprint(newVisual, direction);
  return oldW === newW && oldH === newH;
}

/** autoUnderground, except that an underground built over one of another
 *  tier takes that one's place as it stands — same end of the pair, same
 *  travel direction — however it is held, the way the game upgrades one. */
export function undergroundForPlacement(
  entities: readonly PlacedEntity[],
  name: string,
  x: number,
  y: number,
  direction: number,
  maxDistance: number,
  replaced: PlacedEntity | undefined,
): { undergroundType: "input" | "output"; direction: number } {
  if (replaced && replaced.name !== name && replaced.undergroundType !== undefined) {
    return { undergroundType: replaced.undergroundType, direction: replaced.direction };
  }
  return autoUnderground(entities, name, x, y, direction, maxDistance);
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

/** The first same-name underground travelling the same way within
 *  maxDistance tiles of (x, y), walking with travel (`forward`) or against
 *  it. Same rule as the belt sim's own pairing (packages/sim/src/network.ts):
 *  ones travelling any other way are passed over. Both ends of a pair store
 *  the travel direction, as a 2.0 blueprint does. */
function undergroundAlong(
  entities: readonly PlacedEntity[],
  name: string,
  x: number,
  y: number,
  direction: number,
  forward: boolean,
  maxDistance: number,
): PlacedEntity | undefined {
  const facing = toCardinal(direction);
  const { dx, dy } = step(forward ? facing : opposite(facing));
  const byTile = new Map<string, PlacedEntity>();
  for (const e of entities) if (e.name === name) byTile.set(`${Math.floor(e.x)},${Math.floor(e.y)}`, e);
  for (let k = 1; k <= maxDistance; k++) {
    const e = byTile.get(`${Math.floor(x) + dx * k},${Math.floor(y) + dy * k}`);
    if (e && toCardinal(e.direction) === facing) return e;
  }
  return undefined;
}

/** What a newly-built underground becomes when placed held at
 *  `direction`, auto-paired the way the game does it: held facing back at
 *  an entrance in range (the entrance travelling the opposite way, toward
 *  it), it becomes that entrance's exit — stored with the travel direction,
 *  like the entrance. Otherwise it's an entrance travelling `direction`.
 *  Same pairing rule as the reference editor's own
 *  PaintEntityContainer.updateUndergroundBeltRotation. */
export function autoUnderground(
  entities: readonly PlacedEntity[],
  name: string,
  x: number,
  y: number,
  direction: number,
  maxDistance: number,
): { undergroundType: "input" | "output"; direction: number } {
  const travel = (direction + 8) % 16;
  const entrance = undergroundAlong(entities, name, x, y, travel, false, maxDistance);
  return entrance?.undergroundType === "input"
    ? { undergroundType: "output", direction: travel }
    : { undergroundType: "input", direction };
}

/** The other half of `target`'s underground pair, if it has one in range —
 *  an entrance looks ahead for its exit, an exit looks back for its
 *  entrance. */
export function undergroundPartner(
  entities: readonly PlacedEntity[],
  target: PlacedEntity,
  maxDistance: number,
): PlacedEntity | undefined {
  const isIn = target.undergroundType !== "output";
  const other = undergroundAlong(entities, target.name, target.x, target.y, target.direction, isIn, maxDistance);
  return other && (other.undergroundType === "output") === isIn ? other : undefined;
}

/** True for every electric-pole tier (small/medium/big-electric-pole,
 *  substation). Poles must never be player-rotated: their facing is
 *  meaningless today and will later be derived automatically from the wires
 *  connected to them, so exposing a manual rotate would just be undone by
 *  that future auto-orientation. */
export function isPoleLike(name: string): boolean {
  return name.endsWith("electric-pole") || name === "substation";
}

/** Rotates one entity's position around `center` by `steps` quarter-turns
 *  (each step = 90°, i.e. 4 of the 16-way direction scheme), and advances
 *  its own facing by the same amount — the position half of a *group*
 *  rotation (the paste ghost's R/Shift+R), kept separate from a
 *  single-entity in-place rotate since a group rotation must also move
 *  WHERE each member sits, not just which way it faces. `steps` can be
 *  negative for counter-clockwise. Exported (rather than kept local to
 *  render.ts) so the app layer's onPaste commit can apply the exact same
 *  math the ghost previewed — any drift between the two would mean what
 *  you see is not what gets placed. */
export function rotateAroundCenter(e: PlacedEntity, center: { x: number; y: number }, steps: number): PlacedEntity {
  const normalizedSteps = ((steps % 4) + 4) % 4;
  let rx = e.x - center.x;
  let ry = e.y - center.y;
  for (let i = 0; i < normalizedSteps; i++) {
    const nx = -ry;
    const ny = rx;
    rx = nx;
    ry = ny;
  }
  return { ...e, x: center.x + rx, y: center.y + ry, direction: (e.direction + steps * 4 + 16 * 4) % 16 };
}

/** Entities that rotate in 22.5° increments (step 1 of the 16-way scheme)
 *  instead of the usual 90° (step 4) — rail-signal/rail-chain-signal have
 *  a genuine 16-row direction sheet (data-pipeline's railSignalGraphics),
 *  one real sprite per step. */
const FINE_ROTATION = new Set(["rail-signal", "rail-chain-signal"]);

/** Entities that rotate in 45° increments (step 2 of 16) — 8-way, matching
 *  their own 8 real facing sprites (dir8) — railgun-turret only, so far. */
const EIGHT_WAY_ROTATION = new Set(["railgun-turret", "straight-rail", "elevated-straight-rail", "rail-support"]);

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
