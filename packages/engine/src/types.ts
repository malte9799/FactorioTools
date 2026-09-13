/** Prototype data model. Deliberately a subset of Factorio's data.raw — just
 *  what is needed to compute rates and render entities. See
 *  packages/data-pipeline for how this is generated from a real game dump. */

export type QualityName =
  | "normal"
  | "uncommon"
  | "rare"
  | "epic"
  | "legendary";

export interface Effects {
  /** Fractional, e.g. 0.2 for +20%. */
  speed: number;
  productivity: number;
  consumption: number;
  pollution: number;
  quality: number;
}

export interface ItemProto {
  name: string;
  /** Items are measured in items, fluids in units. Used for belt/wagon scaling. */
  kind: "item" | "fluid";
  stackSize?: number;
  /** How many fit in a rocket's cargo hold per launch. Undefined/0 means it
   *  can't be sent to space (fluids, or items with no launch data). */
  rocketCapacity?: number;
  localised: string;
}

export interface IngredientProto {
  name: string;
  amount: number;
  /** Amount returned untouched by the machine; not multiplied by productivity. */
  ignoredByProductivity?: number;
}

export interface ProductProto {
  name: string;
  amount: number;
  probability?: number;
  /** 2.0: portion of the result that productivity does not apply to. */
  ignoredByProductivity?: number;
}

export interface RecipeProto {
  name: string;
  category: string;
  /** Seconds at crafting speed 1. */
  energyRequired: number;
  ingredients: IngredientProto[];
  results: ProductProto[];
  /** 2.0 productivity ceiling, as a fraction. Infinity when uncapped. */
  maximumProductivity?: number;
  /** Name of the (infinitely-repeatable) technology that raises this
   *  recipe's productivity, e.g. "steel-plate-productivity" — undefined for
   *  recipes with no such research. A blueprint doesn't record what's been
   *  researched, so the UI asks the user for a level per technology. */
  productivityTechnology?: string;
  localised: string;
}

/** One recipe-productivity technology (2.0's `change-recipe-productivity`
 *  effect) — "Steel plate productivity", "Processing unit productivity",
 *  etc. Infinitely repeatable; each level adds changePerLevel to every
 *  recipe it names. Surfaced separately from RecipeProto so the UI can list
 *  "what research applies to what's actually in this blueprint" without
 *  scanning every recipe. */
export interface ProductivityTechnology {
  name: string;
  localised: string;
  changePerLevel: number;
  /** Recipe names this technology's level applies productivity to. */
  recipes: string[];
}

export type MachineKind = "crafting" | "lab" | "mining-drill" | "generator";

/** A sprite sheet region, with the geometry needed to place it in the world.
 *  A sheet may hold a grid of frames; `frameWidth`/`frameHeight` give one
 *  cell, and `x`/`y` the grid's origin within the sheet. */
export interface Sprite {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  /** Frames per row; column indices wrap at this. Defaults to 1. */
  columns?: number;
  /** Pixel offset of the grid's origin within the sheet. */
  x?: number;
  y?: number;
  /** Offset from the entity's centre, in tiles. */
  shift?: [number, number];
  /** On-screen tile size = pixel size * scale / 32. */
  scale?: number;
  /** A grid too tall for one file, split across several same-sized files
   *  (Factorio's own `filenames` + `lines_per_file`, e.g. artillery-
   *  turret's 256-direction aiming sheet: 8 files of 8 rows each rather
   *  than one 64-row image) — `sheet` is ignored and `sheets[Math.floor(row
   *  / rowsPerSheet)]` used instead, with `row` itself taken mod
   *  rowsPerSheet for the in-file offset. Undefined for every ordinary
   *  single-file sprite, which uses plain `sheet`. */
  sheets?: string[];
  rowsPerSheet?: number;
  /** Clockwise rotation in degrees, about the sprite's own on-screen
   *  center, applied at paint time. Not something Factorio's own data ever
   *  carries — vanilla entities never need it, since every rotatable
   *  entity ships pre-rendered per-direction art instead (this is why
   *  Factorio's wall/rail art must never be rotated at render time: doing
   *  so breaks the connection art's alignment with its neighbours). This
   *  exists solely for a hand-placed static composite where no source
   *  frame exists at the needed angle — the agricultural tower's crane
   *  parts (see render-catalog.ts's agriculturalTowerGraphics), whose
   *  sheets are yaw-only (every direction keeps the part vertical on
   *  screen) and so have no frame that alone depicts a swept, angled arm.
   *  Leave undefined for anything backed by real per-direction art. */
  rotationDeg?: number;
}

/** Which paint pass a sprite belongs to. Every sprite in the world is sorted
 *  into these globally, then each pass is painted in order — so an entity can
 *  never paint over a neighbour belonging to a higher pass. Within a pass,
 *  sprites sort by their entity's y so entities lower on screen overlap those
 *  behind them. */
export enum Layer {
  Floor = 0,
  Shadow = 1,
  LowerObject = 2,
  Object = 3,
  AboveObject = 4,
}

export type Dir4Name = "north" | "east" | "south" | "west";
export type Dir8Name = Dir4Name | "northeast" | "southeast" | "southwest" | "northwest";

/** Picks a frame's column and row within a layer's sprite grid. The two axes
 *  are independent: an underground belt picks its column by facing and its
 *  row by entrance/exit, a belt its column by the animation clock and its row
 *  by neighbours. */
export type FrameAxis =
  | { by: "none" }
  /** Cardinal facing, 0..3. */
  | { by: "direction" }
  /** Entrance vs. exit, for underground belts and loaders. inSideLoadIndex/
   *  outSideLoadIndex are optional: an underground belt swaps to them when
   *  a belt feeds its mouth from the side rather than straight on: absent,
   *  a loader (which has no such variant) always uses inIndex/outIndex. */
  | {
      by: "underground-end";
      inIndex: number;
      outIndex: number;
      inSideLoadIndex?: number;
      outSideLoadIndex?: number;
    }
  /** Advances with the renderer's clock. `slowdown` divides the raw
   *  per-tick clock before indexing (default 1, every entity's previous
   *  behavior) — a belt wants full speed, but rail-signal's own 3-frame
   *  red/orange/green cycle at full speed reads as a strobe/flicker rather
   *  than a visible color change. */
  | { by: "animation"; slowdown?: number }
  /** A neighbour-derived index, from the entity's `connector`. */
  | { by: "connection" }
  /** Artillery-turret's cannon rotates through a 256-entry aiming sheet
   *  (packed `lineLength` frames per row) meant for fine in-combat traverse
   *  — a blueprint only ever shows one of the 16 placement facings, so this
   *  picks the single frame nearest that facing rather than animating
   *  through the sheet: entity.direction (0..15) scaled onto 0..255, then
   *  split into this row/column pair. */
  | { by: "direction256"; axis: "column" | "row"; lineLength: number }
  /** Rail-signal/rail-chain-signal pack a genuine 16-way direction sheet
   *  (one row per entity.direction value, 0..15 exactly, no 256-scaling
   *  needed) with several animation-state frames per row as columns —
   *  `column` picks by "animation" (slowed way down, see its own doc
   *  comment) to cycle through the row's red/orange/green frames, while
   *  `row` uses this to pick the direction row directly. */
  | { by: "direction16" };

/** One drawable piece of an entity.
 *
 *  `sprites` is either a single grid (frames packed in one sheet, indexed by
 *  `column`/`row`) or one whole sheet per facing (Factorio ships some
 *  entities as separate files per direction rather than one packed grid). */
export type GraphicsLayer = {
  layer: Layer;
  column?: FrameAxis;
  row?: FrameAxis;
  /** Nudges this layer's paint-order sort key within its own Layer tier,
   *  for two pieces that must always order a specific way relative to each
   *  other regardless of their individual sprite shifts — paint order sorts
   *  by layer tier, then each sprite's own y-shift, and only THEN array
   *  declaration order (compareDrawCommands in draw/commands.ts), so two
   *  pieces sharing a tier order by whichever happens to have the larger
   *  shiftY, not by which was declared first. Comfortably above float
   *  noise, comfortably below the smallest real gap between two distinct
   *  rows (1 world tile) — the same convention collect.ts's own
   *  CAP_PRIORITY_EPSILON already uses for belt caps, generalised here for
   *  reuse outside that one case (confirmed needed by spike:
   *  big-mining-drill's top-nozzle.png must always draw under top.png
   *  despite having the less-negative, "wins by default" shift). */
  ySortBias?: number;
} & (
  | { sprites: Sprite }
  /** Partial: some Factorio entities (e.g. electric-mining-drill's small
   *  "output" decal) omit a layer for one facing entirely while shipping it
   *  for the other three — the layer still draws for the facings that have
   *  it rather than being dropped everywhere just because one facing lacks
   *  it. spriteFor()/collectEntity() already skip a layer when the current
   *  facing's own entry is missing. */
  | { sprites: Partial<Record<Dir4Name, Sprite>>; per: "dir4" }
  | { sprites: Partial<Record<Dir8Name, Sprite>>; per: "dir8" }
  /** Keyed by a connector's variant name (pipe/wall connection shapes). */
  | { sprites: Record<string, Sprite>; per: "connection" }
  /** One cover sprite per cardinal facing, drawn once per unconnected
   *  fluid-box connection point rather than baked into a single per-entity
   *  shift — a storage tank's own 4 corner points each need their own world
   *  offset, unlike every other `per` variant, whose sprites already carry
   *  (or don't need) their own shift. Only the points the fluid network
   *  graph finds unconnected are drawn; keyed by Dir4Name to match
   *  `PipeConnectionPoint.direction`. */
  | { sprites: Partial<Record<Dir4Name, Sprite>>; per: "pipe-covers" }
  /** One small pipe-stub cap per `heat_buffer.connections` entry, drawn at
   *  every point — unlike pipe-covers (drawn only when unconnected), a
   *  reactor's 12 heat-connection points always show one of two full sprite
   *  sets, picked per point by whether the real heat network finds a
   *  matching neighbour there. `connected`/`disconnected` are indexed by
   *  connection-point index (the sheet's own `variation_count`), not by
   *  direction — several points can share the same direction (a reactor has
   *  3 per side) so a Dir4Name key can't distinguish them. */
  | { connected: Sprite[]; disconnected: Sprite[]; per: "heat-connection-patches" }
  /** A beacon's per-slot module art — one entry per physical slot (index
   *  order matches graphics_set.module_visualisations[0].slots). `empty`
   *  is the socket art shown when nothing's in that slot (drawn today
   *  regardless of loadout); `filled` is the box/lights-mask/lights-glow
   *  pieces shown once a module actually occupies it. This renderer has no
   *  runtime-tint concept (see unwrapAll's own apply_runtime_tint skip), so
   *  `filled` is the same untinted shape for every module — real Factorio
   *  colors it per the module's own beacon_tint, this only shows that a
   *  slot is occupied at all. */
  | { slots: { empty: Sprite; filled: Sprite[] }[]; per: "module-slot" }
);

/** How an entity is drawn: a flat list of layers, drawn in array order within
 *  each Layer. One shape for every entity — a chest is a single layer, a rail
 *  five, a wall one whose sprite is chosen by its neighbours. */
export interface EntityGraphics {
  layers: GraphicsLayer[];
  /** Which neighbour-classification rule supplies connection indices and
   *  variant names. Absent when no layer needs one. */
  connector?: ConnectorKind;
}

/** Names a neighbour-classification rule; the rules live in
 *  packages/renderer/src/neighbours. */
export type ConnectorKind = "pipe" | "heat-pipe" | "wall" | "belt" | "platform";


export interface MachineProto {
  name: string;
  kind: MachineKind;
  /** crafting_speed, researching_speed or mining_speed depending on kind. */
  speed: number;
  categories: string[];
  moduleSlots: number;
  /** Effects the machine will accept. Undefined means all. */
  allowedEffects?: (keyof Effects)[];
  /** Watts, active draw. */
  energyUsage: number;
  /** Watts, constant. */
  drain?: number;
  energySource: "electric" | "burner" | "heat" | "fluid" | "void";
  /** Tiles, for beacon coverage and rendering. */
  size: [number, number];
  /** Authoritative tile footprint for rendering, from a real data dump.
   *  Falls back to `size` when absent (today's behaviour). */
  tileFootprint?: [number, number];
  /** Real sprite data. Absent means render as an outline/fallback box. */
  graphics?: EntityGraphics;
  /** Rocket parts needed to fill the silo before it launches. Only set on
   *  rocket silos. */
  siloParts?: number;
  /** Every fluid-box connection point this entity declares — see
   *  RenderEntityProto's own doc comment. A machine like a boiler or steam
   *  engine has a real fluid box too, so this lives on MachineProto as well
   *  rather than only on the visual-only catalog. */
  pipeConnections?: PipeConnectionPoint[];
  localised: string;
}

export interface ModuleProto {
  name: string;
  effects: Partial<Effects>;
  localised: string;
}

export interface BeaconProto {
  name: string;
  /** Fraction of each module's effect transmitted, per beacon, at normal
   *  quality. */
  distributionEffectiveness: number;
  /** Added to distributionEffectiveness per quality level of the beacon
   *  itself (2.0's `distribution_effectivity_bonus_per_quality_level`) —
   *  additive, unlike the ×(1+0.3×level) multiplier every other quality
   *  bonus uses; e.g. base 1.5 + 0.2/level gives 1.5/1.7/1.9/2.1/2.5. */
  distributionEffectivenessBonusPerQualityLevel: number;
  /** Tiles beyond the beacon's own footprint that it supplies. */
  supplyAreaDistance: number;
  moduleSlots: number;
  size: [number, number];
  /** 2.0 diminishing returns by beacon count. profile[n-1] for n beacons.
   *  Past the end of the array, the last entry is reused (engine-documented
   *  behaviour), not a recomputed formula. */
  profile?: number[];
  energyUsage: number;
  /** Just the base pad layer — beacons' full graphics_set is a multi-layer
   *  animation_list (bottom pad + glowing top + light effects); rendering
   *  only the static bottom layer is a deliberate simplification, not a full
   *  effect-accurate beacon animation. */
  graphics?: EntityGraphics;
  localised: string;
}

export interface BeltProto {
  name: string;
  /** Items per second on a full belt, one item per slot. */
  throughput: number;
  graphics?: EntityGraphics;
  localised: string;
}

/** Inserters are drawn procedurally (a 4-facing platform plus a hand rotated
 *  at draw time), not from a packed grid, so they sit outside EntityGraphics. */
export interface InserterGraphics {
  platform: Sprite;
  platformDirections: number;
  handBase: Sprite;
  handOpen: Sprite;
}

export interface InserterProto {
  name: string;
  /** Items per second at normal quality, chest-to-chest, no capacity research.
   *  Already accounts for hand size on bulk/stack inserters. */
  throughput: number;
  graphics?: InserterGraphics;
  localised: string;
}

export interface GameData {
  version: string;
  items: Record<string, ItemProto>;
  recipes: Record<string, RecipeProto>;
  machines: Record<string, MachineProto>;
  modules: Record<string, ModuleProto>;
  beacons: Record<string, BeaconProto>;
  belts: Record<string, BeltProto>;
  inserters: Record<string, InserterProto>;
  /** Multiplier applied to a machine's base speed, by quality tier. */
  qualityMachineSpeed: Record<QualityName, number>;
  /** Multiplier applied to a module's positive effects, by quality tier. */
  qualityModuleEffect: Record<QualityName, number>;
  /** Integer quality level per tier (normal 0 .. legendary 5, note the jump
   *  from epic's 3) — used for beacon distribution effectiveness, which
   *  scales additively per level rather than via qualityModuleEffect's
   *  multiplier. */
  qualityLevel: Record<QualityName, number>;
  /** Infinitely-repeatable recipe-productivity technologies, keyed by name —
   *  see ProductivityTechnology. */
  productivityTechnologies: Record<string, ProductivityTechnology>;
}

/** Entities that appear in blueprints but have no rate of their own — poles,
 *  pipes, chests, walls, lamps. Keyed by prototype name, like GameData. */
/** One fluid-box connection point, in the entity's own unrotated (north-
 *  facing) local frame — matching Factorio's own `fluid_box.pipe_connections`
 *  position/direction pairs. `direction` is the cardinal the connection
 *  stub points outward (0/4/8/12 = N/E/S/W); rotating the entity rotates
 *  both `position` and `direction` together. The real fluid network graph
 *  (packages/renderer/src/neighbours/fluid.ts) rotates these into world
 *  space per placed entity and matches them up tile-for-tile against every
 *  other entity's own connection points (plain pipes included) to decide
 *  which points are actually connected — feeding both pipe-cover visibility
 *  and, longer term, any other feature that needs to know the real fluid
 *  network rather than just immediate 1-tile pipe neighbours. */
export interface PipeConnectionPoint {
  x: number;
  y: number;
  direction: 0 | 4 | 8 | 12;
  /** Pumpjack's own output socket is the one prototype in the dump that
   *  declares `positions` (plural — one [x,y] per placement direction,
   *  indexed 0/4/8/12 -> array index 0..3) instead of a single `position`:
   *  its off-center nozzle doesn't land correctly under a plain 90°
   *  rotation of one base point, so Factorio ships all 4 pre-computed
   *  positions directly. When present, the fluid network graph
   *  (packages/renderer/src/neighbours/fluid.ts) looks up the entity's
   *  actual facing here instead of rotating `x`/`y`. */
  positionsByDirection?: [number, number][];
  /** Which of the prototype's own (possibly several) fluid boxes this point
   *  belongs to, in declaration order (0-based) — e.g. assembling-machine-2
   *  has box 0 = input, box 1 = output; foundry has 0/1 = input, 2/3 =
   *  output. Undefined for a prototype with only one fluid box (a plain
   *  pump, boiler, etc — nothing to disambiguate). Combined with
   *  `flowDirection`, lets a caller (index.ts's activeFluidBoxIndices) work
   *  out which boxes the entity's currently-selected recipe actually
   *  activates, for machines that only draw the connections their fluid
   *  boxes are relevant for (assembling-machine-2/3, foundry,
   *  electromagnetic-plant, cryogenic-plant — real Factorio turns these off
   *  entirely for a recipe with no matching fluid ingredient/product,
   *  matching `fluid_boxes_off_when_no_fluid_recipe`). */
  fluidboxIndex?: number;
  /** The fluid box's own production_type — which side of a recipe (an
   *  ingredient vs a product) this point's box corresponds to. */
  flowDirection?: "input" | "output" | "input-output";
  /** The prototype's own `fluid_boxes_off_when_no_fluid_recipe` flag —
   *  true for assembling-machine-2/3, foundry, electromagnetic-plant,
   *  cryogenic-plant (recipe-conditional boxes); false/absent for
   *  oil-refinery, chemical-plant, and every other multi-fluid-box entity
   *  (their boxes always show, regardless of which recipe — Factorio never
   *  turns them off, they just sit unconnected when a recipe doesn't use
   *  a given box). renderer/entityLookup.ts's activeFluidConnections only
   *  filters points where this is true. */
  boxesOffWhenNoFluidRecipe?: boolean;
}

/** One `heat_buffer.connections` entry, in the entity's own unrotated
 *  (north-facing) local frame — same shape as PipeConnectionPoint, but heat
 *  pipes and fluid pipes are materially different networks (a heat pipe
 *  never carries fluid and vice versa), so this is kept as its own type
 *  rather than reused, even though the fields are identical today. */
export interface HeatConnectionPoint {
  x: number;
  y: number;
  direction: 0 | 4 | 8 | 12;
}

/** Where each wire colour attaches to an entity's sprite, in tiles relative
 *  to the entity's centre. A colour is undefined when the entity has no
 *  terminal of that kind (a pole has copper plus red/green; a combinator has
 *  only red/green). */
export interface WireAttachPoint {
  copper?: [number, number];
  red?: [number, number];
  green?: [number, number];
}

/** An entity's wire attachment points, one per 4-way facing (index is
 *  `direction / 4`). */
export interface WireAttachPoints {
  byDirection: (WireAttachPoint | undefined)[];
  /** A power switch's right-hand copper terminal — its two copper sides sit
   *  at different points on one sprite, unlike every other entity's single
   *  terminal per colour. */
  secondCopper?: [number, number];
}

export interface RenderEntityProto {
  name: string;
  tileFootprint: [number, number];
  graphics?: EntityGraphics;
  /** Swaps footprint width/height at east/west facings (splitters). */
  rotatesFootprint?: boolean;
  /** Every fluid-box connection point this entity declares (all boxes
   *  flattened together — rendering never needs to know which fluid box a
   *  point belongs to, only where it is). Absent for entities with no fluid
   *  box at all. */
  pipeConnections?: PipeConnectionPoint[];
  /** Every `heat_buffer.connections` entry this entity declares, in
   *  declaration order — the reactor's own connection-patch art is indexed
   *  by this same order (see GraphicsLayer's `heat-connection-patches`
   *  variant). Absent for entities with no heat buffer at all. */
  heatConnections?: HeatConnectionPoint[];
  /** Where wires attach to this entity's sprite, per facing. Present for
   *  poles, combinators, power switches and anything else that can be
   *  wired; absent for the majority that cannot. */
  wireConnections?: WireAttachPoints;
  /** A combinator's output-side attachment points, which sit elsewhere on
   *  the sprite than its input side (`wireConnections`). */
  outputWireConnections?: WireAttachPoints;
  /** Electric poles only: half-width of the square supply area, in tiles
   *  (Factorio's `supply_area_distance` — a medium pole's 3.5 means the
   *  7x7 area the game highlights). */
  supplyAreaDistance?: number;
  /** Electric poles only: how far a copper wire from this pole can reach,
   *  in tiles (`maximum_wire_distance`). */
  maxWireDistance?: number;
  localised: string;
}

/** A build-menu tab, mirroring the game's own item-group table. */
export interface MenuGroup {
  name: string;
  icon: string;
  localised: string;
  /** Sort order among tabs, string-compared. */
  order: string;
}

/** Sorted by subgroupOrder first, then order — the game's own menu grouping. */
export interface MenuPosition {
  group: string;
  subgroup: string;
  subgroupOrder: string;
  order: string;
}

export interface RenderCatalog {
  version: string;
  entities: Record<string, RenderEntityProto>;
  /** Build-menu tabs, keyed by item-group name, already sorted by `order`. */
  menuGroups: MenuGroup[];
  /** Build-menu slot per entity name, spanning both this catalog and
   *  GameData. Absent means not directly placeable. */
  menuPositions: Record<string, MenuPosition>;
  /** Same item-group/subgroup/order scheme as menuPositions, but keyed by
   *  ITEM name rather than by the entity an item places — what the module
   *  picker groups/sorts by (a module isn't placeable, so it never gets a
   *  menuPositions entry). */
  itemMenuPositions: Record<string, MenuPosition>;
  /** Same item-group/subgroup/order scheme as menuPositions, but keyed by
   *  RECIPE name and resolved from the recipe's own main product item
   *  (which usually isn't itself placeable — a science pack has no
   *  place_result, so it never gets a menuPositions entry) rather than
   *  place_result. This is what the recipe-picker window's category tabs
   *  use, matching the real game's own recipe-selection GUI grouping recipes
   *  by resulting-item category (the same Logistics/Production/... tabs the
   *  build menu shows), not Factorio's internal crafting_category field
   *  (RecipeProto.category — "crafting", "smelting", ...), which the recipe
   *  window used before this and doesn't correspond to any real in-game UI
   *  grouping the user would recognise. */
  recipeMenuPositions: Record<string, MenuPosition>;
}

/* ---------- Blueprint string shapes (as exported by the game) ---------- */

export interface BpPosition {
  x: number;
  y: number;
}

export interface BpItemRequest {
  /** 1.1 form: { "speed-module-3": 4 }. 2.0 form: the id/items object below. */
  id?: { name: string; quality?: QualityName };
  items?: { in_inventory?: { inventory: number; stack: number; count?: number }[] };
}

/** Inserter/loader filter slot — confirmed by spike against a real 2.0
 *  blueprint: a flat array, `index` 1-based. */
export interface BpItemFilter {
  name: string;
  index: number;
  quality?: QualityName;
}

/** Logistic-container (storage/requester/buffer chest) request filters —
 *  confirmed by spike: NOT a flat array like inserter filters, instead
 *  nested under `sections[].filters[]` (2.0's logistics-groups shape). Only
 *  `sections[0].filters` is read — a chest's alt-mode badge shows its
 *  request, not every group section. */
export interface BpRequestFilters {
  sections?: { index: number; filters?: BpItemFilter[] }[];
}

export interface BpEntity {
  entity_number: number;
  name: string;
  position: BpPosition;
  direction?: number;
  recipe?: string;
  recipe_quality?: QualityName;
  quality?: QualityName;
  items?: BpItemRequest[] | Record<string, number>;
  type?: string;
  /** Filter inserters/loaders. */
  filters?: BpItemFilter[];
  /** Storage/requester/buffer chests. */
  request_filters?: BpRequestFilters;
}

/** One wire from a 2.0 blueprint's top-level `wires` array:
 *  `[entityA, connectorA, entityB, connectorB]`.
 *
 *  The connector ids say both which colour the wire is and, for a
 *  combinator or power switch, which of its two sides the wire lands on —
 *  see WireConnectorId. Pre-2.0 blueprints have no `wires`; they carried
 *  circuit wires inside each entity's own `connections` object instead, a
 *  shape this project does not read (every blueprint the app has been
 *  tested against is 2.0). */
export type BpWire = [number, number, number, number];

/** `defines.wire_connector_id`, the numbers a blueprint's `wires` entries
 *  use. Verified against the reference editor's exported prototype data
 *  rather than the wiki, whose blueprint-format page still documents the
 *  pre-2.0 `connections` shape. Note the deliberate collisions: red and
 *  a combinator's input-red are the same id, as are pole-copper and a
 *  power switch's left-copper — the entity's own type is what
 *  disambiguates them. */
export const WireConnectorId = {
  circuitRed: 1,
  circuitGreen: 2,
  combinatorOutputRed: 3,
  combinatorOutputGreen: 4,
  poleCopper: 5,
  powerSwitchRightCopper: 6,
} as const;

/** Which of the three wire kinds a connector id denotes. */
export type WireColor = "copper" | "red" | "green";

export interface Blueprint {
  item: string;
  label?: string;
  entities?: BpEntity[];
  tiles?: { name: string; position: BpPosition }[];
  /** 2.0+ only. Absent on older blueprints and on ones with no wires. */
  wires?: BpWire[];
  version?: number;
}

export interface BlueprintBookEntry {
  index: number;
  blueprint?: Blueprint;
  blueprint_book?: BlueprintBook;
}

export interface BlueprintBook {
  item: string;
  label?: string;
  blueprints: BlueprintBookEntry[];
  active_index?: number;
}

export interface BlueprintEnvelope {
  blueprint?: Blueprint;
  blueprint_book?: BlueprintBook;
}

/* ---------- Normalised, engine-facing shapes ---------- */

export interface ModuleStack {
  name: string;
  quality: QualityName;
  count: number;
}

export interface PlacedEntity {
  entityNumber: number;
  name: string;
  x: number;
  y: number;
  direction: number;
  quality: QualityName;
  recipe?: string;
  modules: ModuleStack[];
  /** Item names this entity is explicitly configured to filter for — filter
   *  inserters' `filters`, or a chest's `request_filters` first section.
   *  Empty for entities with no filters set (most blueprints never set
   *  these) or that can't have any. Deliberately NOT a live inventory
   *  snapshot — the blueprint format has no such thing, only the
   *  filter/request configuration, which is what alt-mode shows here. */
  filterItems: string[];
  /** Underground belts only: which end this instance is, from the
   *  blueprint's own `type` field — confirmed by spike this is a real,
   *  separate field from `direction` (two undergrounds can share a
   *  direction while one is an entrance and the other an exit). Undefined
   *  for every other entity kind. */
  undergroundType?: "input" | "output";
}

/** One wire, normalised out of the blueprint's `wires` array into the pair
 *  of entities it joins.
 *
 *  `side` is which connector of that entity the wire lands on: 1 for a
 *  plain entity or a combinator's input, 2 for a combinator's output or a
 *  power switch's right terminal. Both are kept because a combinator draws
 *  its input and output wires at different points on its own sprite. */
export interface WireLink {
  color: WireColor;
  from: number;
  fromSide: 1 | 2;
  to: number;
  toSide: 1 | 2;
}
