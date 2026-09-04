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
  localised: string;
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
  /** Advances with the renderer's clock. */
  | { by: "animation" }
  /** A neighbour-derived index, from the entity's `connector`. */
  | { by: "connection" }
  /** Artillery-turret's cannon rotates through a 256-entry aiming sheet
   *  (packed `lineLength` frames per row) meant for fine in-combat traverse
   *  — a blueprint only ever shows one of the 16 placement facings, so this
   *  picks the single frame nearest that facing rather than animating
   *  through the sheet: entity.direction (0..15) scaled onto 0..255, then
   *  split into this row/column pair. */
  | { by: "direction256"; axis: "column" | "row"; lineLength: number };

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
export type ConnectorKind = "pipe" | "wall" | "belt" | "platform";


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
  /** Fraction of each module's effect transmitted, per beacon. */
  distributionEffectiveness: number;
  /** Tiles beyond the beacon's own footprint that it supplies. */
  supplyAreaDistance: number;
  moduleSlots: number;
  size: [number, number];
  /** 2.0 diminishing returns by beacon count. profile[n-1] for n beacons.
   *  Falls back to 1/sqrt(n) past the end of the array. */
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

export interface Blueprint {
  item: string;
  label?: string;
  entities?: BpEntity[];
  tiles?: { name: string; position: BpPosition }[];
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
