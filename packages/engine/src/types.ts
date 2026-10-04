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
   *  than a visible color change. `speedup` multiplies it instead: a belt
   *  lane advances `speed * animation_speed_coefficient` frames a tick in
   *  the game (1 for a yellow belt, 2 red, 3 blue, 4 turbo), so a faster
   *  tier visibly runs faster rather than every tier crawling at yellow's
   *  pace. */
  | { by: "animation"; slowdown?: number; speedup?: number }
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
  /** Keyed by a connector's variant name (pipe/wall connection shapes, or
   *  a combinator's display symbol as `<symbol>-<facing>`, e.g.
   *  `plus-north`). */
  | { sprites: Record<string, Sprite>; per: "connection" }
  /** One cover sprite per cardinal facing, drawn once per unconnected
   *  fluid-box connection point rather than baked into a single per-entity
   *  shift — a storage tank's own 4 corner points each need their own world
   *  offset, unlike every other `per` variant, whose sprites already carry
   *  (or don't need) their own shift. Only the points the fluid network
   *  graph finds unconnected are drawn; keyed by Dir4Name to match
   *  `PipeConnectionPoint.direction`. */
  | { sprites: Partial<Record<Dir4Name, Sprite>>; per: "pipe-covers" }
  /** Connection art that belongs to ONE specific fluid-box connection
   *  point and changes with what that point is plugged into — fusion-reactor
   *  and fusion-generator's own ports, which don't use the generic round
   *  pipe-covers. `point` indexes the entity's own `pipeConnections`
   *  (declaration order); `sprites` is keyed by the entity's facing and
   *  already carries its own baked shift. `columns` names the sheet column
   *  for each state of that point: `open` (nothing attached), `connected`
   *  (a matching fluid connection), `sibling` (attached to another entity of
   *  the same prototype — falls back to `connected` when absent). A state
   *  with no column draws nothing: a fusion-generator's plasma intake only
   *  exists while something feeds it. */
  | {
      sprites: Partial<Record<Dir4Name, Sprite>>;
      per: "fluid-point";
      point: number;
      columns: { open?: number; connected?: number; sibling?: number };
    }
  /** One small pipe-stub cap per `heat_buffer.connections` entry, drawn at
   *  every point — unlike pipe-covers (drawn only when unconnected), a
   *  reactor's 12 heat-connection points always show one of two full sprite
   *  sets, picked per point by whether the real heat network finds a
   *  matching neighbour there. `connected`/`disconnected` are indexed by
   *  connection-point index (the sheet's own `variation_count`), not by
   *  direction — several points can share the same direction (a reactor has
   *  3 per side) so a Dir4Name key can't distinguish them. */
  | { connected: Sprite[]; disconnected: Sprite[]; per: "heat-connection-patches" }
  /** One cover sprite per cardinal facing, drawn once per UNCONNECTED heat
   *  connection point — the heat-exchanger's own case, and structurally
   *  the SAME rule as fluid pipe-covers (drawn only when nothing is
   *  attached there), not the reactor's heat-connection-patches (always
   *  one of two full sprite sets). Confirmed against the reference
   *  renderer's own draw_boiler: `energy_source.pipe_covers` is pushed
   *  only when `needsEnding = !isConnected` — a heat-exchanger's plain
   *  idle sprite already has a closed socket shape, and this cap patches
   *  over the OPEN stub, the same job a fluid pipe-cover does; a heat pipe
   *  actually plugged in needs no extra cap at all. Keyed by Dir4Name, but
   *  unlike pipe-covers the key is NOT the connection's own facing —
   *  render-catalog.ts/collect.ts pick it as (entity direction + south),
   *  matching draw_boiler's own hardcoded rule for this one entity rather
   *  than a connection-derived direction. */
  | { sprites: Partial<Record<Dir4Name, Sprite>>; per: "heat-covers" }
  /** A beacon's per-slot module art — one entry per physical slot (index
   *  order matches graphics_set.module_visualisations[0].slots). `empty`
   *  is the socket sheet (has_empty_slot): column 0 is the bare socket,
   *  column N the module of tier N sitting in it. `filled` are the overlays
   *  drawn once a module occupies the slot, one column per tier (column
   *  N-1 for tier N), each multiplied by the module's own beacon_tint
   *  channel — `primary` for the box, `secondary` for the lights. */
  | { slots: { empty: Sprite; filled: ModuleSlotPiece[] }[]; per: "module-slot" }
);

/** One tintable overlay of a filled beacon module slot. */
export interface ModuleSlotPiece {
  sprite: Sprite;
  tint?: "primary" | "secondary";
}

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
export type ConnectorKind = "pipe" | "heat-pipe" | "wall" | "belt" | "platform" | "combinator";


export interface MachineProto {
  name: string;
  kind: MachineKind;
  /** crafting_speed, researching_speed or mining_speed depending on kind. */
  speed: number;
  /** Labs only: the share of a science pack one research unit uses up
   *  (science_pack_drain_rate_percent / 100). Absent means a whole pack; a
   *  biolab's is 0.5. */
  packDrain?: number;
  categories: string[];
  moduleSlots: number;
  /** Effects the machine will accept. Undefined means all. */
  allowedEffects?: (keyof Effects)[];
  /** Effects the machine has on its own, with no modules: Space Age's
   *  foundry, electromagnetic plant and biochamber each carry +50%
   *  productivity (effect_receiver.base_effect). */
  baseEffect?: Partial<Effects>;
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
  /** 1..3 — picks the beacon slot art's variation. */
  tier?: number;
  /** RGB 0..1 per channel, multiplied over a beacon's filled-slot overlays.
   *  Absent for modules that can't go in a beacon (productivity, quality). */
  beaconTint?: { primary: [number, number, number]; secondary: [number, number, number] };
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
  /** Tiles per tick an item moves (the prototype's own `speed`). Optional
   *  only because datasets generated before it was extracted lack it —
   *  throughput / 480 is the same number. */
  speed?: number;
  graphics?: EntityGraphics;
  localised: string;
}

export interface UndergroundBeltProto {
  name: string;
  /** Tiles per tick. */
  speed: number;
  /** Largest entrance-to-exit distance in tiles (the prototype's
   *  `max_distance`): 5 means up to 4 tiles of gap. */
  maxDistance: number;
  localised: string;
}

export interface SplitterProto {
  name: string;
  /** Tiles per tick. */
  speed: number;
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
  /** Optional: absent from datasets generated before the belt simulation
   *  needed them; packages/sim falls back to vanilla values. */
  undergroundBelts?: Record<string, UndergroundBeltProto>;
  splitters?: Record<string, SplitterProto>;
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
  /** Factorio's own `connection_category` — two points only join when they
   *  share one. Absent means the default category every ordinary pipe uses;
   *  fusion plasma ports carry `["fusion-plasma"]`, so a plain pipe laid
   *  against one neither connects nor hides its cap. */
  connectionCategory?: string[];
  /** True when this point's own fluid box ships no `pipe_covers` while
   *  another box of the same prototype does (fusion-generator's plasma box
   *  next to its fluoroketone box) — the generic round cover must not be
   *  drawn here. */
  noCover?: boolean;
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
  /** Every real item prototype's own localised name, keyed by item name —
   *  the general item catalog itemMenuPositions/menuPositions lack (those
   *  only carry a menu POSITION, not a display name), needed for anything
   *  that lets the player pick an arbitrary item rather than a placeable
   *  entity, a module, or a recipe — e.g. an inserter's filter-item slots,
   *  which can hold any item at all, ores and intermediates included, not
   *  just the placeable/module/recipe subsets those other tables cover. */
  itemNames: Record<string, string>;
  /** Fluids and virtual signals by name — the non-item signals a
   *  blueprint's icons can name. Absent in datasets generated before it was
   *  extracted. */
  signals?: Record<string, { type: "fluid" | "virtual"; localised: string; position: MenuPosition }>;
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
/** A signal or item named in a blueprint setting. `type` is omitted for an
 *  item. */
export interface BpSignalFilter {
  name?: string;
  type?: string;
}

export interface BpRequestFilters {
  sections?: { index: number; filters?: BpItemFilter[] }[];
}

/** Whether an inserter/loader's `filters` list is a whitelist (pick up only
 *  these items) or a blacklist (pick up anything EXCEPT these) — omitted
 *  from a real blueprint's JSON when it's the default "whitelist" (the
 *  game's serializer drops default-valued fields). */
export type BpFilterMode = "whitelist" | "blacklist";

/** An inserter's spoil-priority radio: which end of an item's spoil timer it
 *  reaches for first when several stacks of the same item, at different
 *  spoilage, are available to pick up. "none" (the default, no preference)
 *  is likewise omitted from real blueprint JSON. */
export type BpSpoilPriority = "spoiled-first" | "fresh-first";

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
  /** Whitelist/blacklist mode for `filters` above. Inserters/loaders only. */
  filter_mode?: BpFilterMode;
  /** The "Use filters" checkbox — filters can be saved on the entity while
   *  this is false, in which case the game ignores them; kept as its own
   *  field (not inferred from `filters` being non-empty) so toggling it off
   *  and back on preserves whatever was configured, matching the in-game
   *  GUI's own checkbox behaviour. */
  use_filters?: boolean;
  /** Manual override of the inserter's hand size (items carried per swing).
   *  Presence of the key IS the "enabled" signal — there is no separate
   *  boolean flag; absent means the game computes it from the inserter's own
   *  stack-size bonus as usual. */
  override_stack_size?: number;
  /** Inserters only, Space Age spoilage mechanic. Omitted (not "none") when
   *  the player hasn't set a preference. */
  spoil_priority?: BpSpoilPriority;
  /** Storage/requester/buffer chests. */
  request_filters?: BpRequestFilters;
  /** Combinators, display panels and anything wired: circuit settings.
   *  Carried through untouched as PlacedEntity.controlBehavior and read by
   *  the circuit simulation (packages/sim/src/circuit.ts). */
  control_behavior?: BpControlBehavior;
  /** Display panels: the icon and text shown when no circuit message is. */
  icon?: BpSignalFilter;
  text?: string;
  always_show?: boolean;
  show_in_chart?: boolean;
  /** Lamps: the colour lit when no circuit colour is used. */
  color?: { r?: number; g?: number; b?: number; a?: number };
  /** Infinity (creative) chests: what they hold. */
  infinity_settings?: { filters?: BpSignalFilter[] };
  /** Splitters only: which input belt is drained first. Omitted = no
   *  priority (alternate). */
  input_priority?: BpSplitterSide;
  /** Splitters only: which output belt is filled first; also the side a
   *  `filter`ed item is sent to. Omitted = no priority (alternate). */
  output_priority?: BpSplitterSide;
  /** Splitters only: the item filter. 2.0 writes an item-filter object,
   *  1.1 wrote the bare item name. */
  filter?: string | { name: string; quality?: QualityName; comparator?: string };
}

/** A signal as a blueprint names it: `type` is omitted for an item. */
export interface BpSignalId {
  type?: string;
  name?: string;
  quality?: string;
}

/** Which wire colours an operand or output reads. Omitted means both. */
export interface BpNetworks {
  red?: boolean;
  green?: boolean;
}

/** A plain circuit condition: an enable/disable condition, a lamp's, a
 *  display panel message's. `comparator` defaults to "<", `constant` to 0. */
export interface BpCircuitCondition {
  first_signal?: BpSignalId;
  second_signal?: BpSignalId;
  constant?: number;
  comparator?: string;
}

export interface BpArithmeticConditions {
  first_signal?: BpSignalId;
  first_constant?: number;
  first_signal_networks?: BpNetworks;
  second_signal?: BpSignalId;
  second_constant?: number;
  second_signal_networks?: BpNetworks;
  /** Defaults to "*". */
  operation?: string;
  output_signal?: BpSignalId;
}

/** One row of a 2.0 decider: joined to the rows before it by `compare_type`
 *  ("or" when omitted); AND binds tighter than OR, as in game. */
export interface BpDeciderCondition extends BpCircuitCondition {
  first_signal_networks?: BpNetworks;
  second_signal_networks?: BpNetworks;
  compare_type?: "and" | "or";
}

export interface BpDeciderOutput {
  signal?: BpSignalId;
  /** Defaults to true: output the input's own count. */
  copy_count_from_input?: boolean;
  /** Used when not copying; defaults to 1. */
  constant?: number;
  networks?: BpNetworks;
}

/** One signal slot of a constant combinator's section. */
export interface BpLogisticFilter extends BpSignalId {
  index?: number;
  count?: number;
  comparator?: string;
}

/** A wired entity's circuit settings, as the 2.0 blueprint format writes
 *  them. Which keys apply depends on the entity; unknown ones are kept as
 *  they are so a blueprint round-trips. */
export interface BpControlBehavior {
  /** Constant combinators: the on/off switch. Omitted means on. */
  is_on?: boolean;
  sections?: { sections?: { index?: number; filters?: BpLogisticFilter[]; active?: boolean; group?: string; multiplier?: number }[] };
  arithmetic_conditions?: BpArithmeticConditions;
  decider_conditions?: { conditions?: BpDeciderCondition[]; outputs?: BpDeciderOutput[] };
  /** Selector combinators. */
  operation?: string;
  select_max?: boolean;
  index_constant?: number;
  index_signal?: BpSignalId;
  count_signal?: BpSignalId;
  random_update_interval?: number;
  /** Display panels: messages, the first whose condition holds is shown. */
  parameters?: { icon?: BpSignalId; text?: string; condition?: BpCircuitCondition }[];
  /** Enable/disable by circuit: "circuit_enabled" in 2.0, the older
   *  "circuit_enable_disable" is read too. */
  circuit_enabled?: boolean;
  circuit_enable_disable?: boolean;
  circuit_condition?: BpCircuitCondition;
  connect_to_logistic_network?: boolean;
  logistic_condition?: BpCircuitCondition;
  /** Inserters: read hand (mode 0 pulse, 1 hold), set filters, set stack. */
  circuit_read_hand_contents?: boolean;
  circuit_hand_read_mode?: number;
  circuit_set_filters?: boolean;
  circuit_set_stack_size?: boolean;
  stack_control_input_signal?: BpSignalId;
  /** Belts: read contents (mode 0 pulse, 1 hold, 2 entire belt). */
  circuit_contents_read_mode?: number;
  /** Crafting machines and containers. */
  read_contents?: boolean;
  read_working?: boolean;
  working_signal?: BpSignalId;
  /** Lamps. */
  use_colors?: boolean;
  color_mode?: number;
  [key: string]: unknown;
}

/** A splitter's side, relative to its own facing (left = counter-clockwise
 *  of the direction items travel). */
export type BpSplitterSide = "left" | "right";

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

/** One of a blueprint's (or book's) up to four icons, as the game writes
 *  them. `type` is absent for items. */
export interface BpIcon {
  index: number;
  signal: { type?: "item" | "fluid" | "virtual" | "entity" | "recipe" | "space-location" | "asteroid-chunk" | "quality"; name: string; quality?: string };
}

export interface Blueprint {
  item: string;
  label?: string;
  description?: string;
  icons?: BpIcon[];
  /** Snap-to-grid cell size in tiles. When set, entity positions are in the
   *  cell's own frame (its top-left corner at 0,0). */
  "snap-to-grid"?: BpPosition;
  /** Absolute snapping: cells line up with the world grid (offset by
   *  `position-relative-to-grid`). Absent/false: relative, cells line up with
   *  wherever the first copy was placed. */
  "absolute-snapping"?: boolean;
  "position-relative-to-grid"?: BpPosition;
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
  description?: string;
  icons?: BpIcon[];
  blueprints: BlueprintBookEntry[];
  active_index?: number;
}

export interface BlueprintEnvelope {
  blueprint?: Blueprint;
  blueprint_book?: BlueprintBook;
}

/** One node of a decoded book's folder tree (see buildBlueprintTree): either
 *  a leaf blueprint (`flatIndex` into collectBlueprints' own flattened
 *  order, so the sidebar can still call selectBlueprint(flatIndex)
 *  unchanged) or a nested book folder holding more nodes. */
export type BlueprintTreeNode =
  | { kind: "blueprint"; label: string; flatIndex: number }
  | { kind: "book"; label: string; children: BlueprintTreeNode[] };

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
   *  inserters'/loaders' `filters`, or a chest's `request_filters` first
   *  section. Empty for entities with no filters set (most blueprints never
   *  set these) or that can't have any.
   *
   *  For an inserter/loader this round-trips (see denormaliseEntities): it's
   *  the entity GUI's own editable filter-slot list, gated by `useFilters`
   *  below. For a chest it stays READ-ONLY display data — alt-mode's badge
   *  shows a request, but chest requests use the incompatible nested
   *  `request_filters.sections[]` shape (2.0's logistics-groups format),
   *  which this project has no editor for; denormaliseEntities only ever
   *  writes this back out as an inserter's flat `filters`. Deliberately NOT
   *  a live inventory snapshot either way — the blueprint format has no such
   *  thing, only the filter/request configuration. */
  filterItems: string[];
  /** Inserters/loaders only: the "Use filters" checkbox — filters can be
   *  configured while this is false, in which case the game ignores them
   *  (matches the in-game GUI, which keeps the slot contents when the
   *  checkbox is unticked rather than clearing them). Undefined for every
   *  entity that can't have filters at all. */
  useFilters?: boolean;
  /** Inserters/loaders only: whitelist (pick up only these items, the
   *  default) or blacklist (pick up anything EXCEPT these). Undefined for
   *  every entity that can't have filters, or that has filters at their
   *  default "whitelist". */
  filterMode?: "whitelist" | "blacklist";
  /** Inserters only: manual override of the hand size (items carried per
   *  swing), replacing the game's own stack-size-bonus calculation.
   *  Undefined means "not overridden" — there is no separate enabled flag,
   *  matching the blueprint format's own override_stack_size (presence IS
   *  the enabled signal). */
  overrideStackSize?: number;
  /** Inserters only, Space Age spoilage mechanic: which end of an item's
   *  spoil timer to reach for first when several stacks of the same item at
   *  different spoilage are available to pick up. Undefined means no
   *  preference set (matches the blueprint format's own omitted/"none"
   *  spoil_priority). */
  spoilPriority?: "spoiled-first" | "fresh-first";
  /** Underground belts only: which end this instance is, from the
   *  blueprint's own `type` field — confirmed by spike this is a real,
   *  separate field from `direction` (two undergrounds can share a
   *  direction while one is an entrance and the other an exit). Undefined
   *  for every other entity kind. */
  undergroundType?: "input" | "output";
  /** Splitters only, from the blueprint's `input_priority`. Undefined = no
   *  priority. */
  splitterInputPriority?: BpSplitterSide;
  /** Splitters only, from the blueprint's `output_priority`. Undefined = no
   *  priority. */
  splitterOutputPriority?: BpSplitterSide;
  /** Splitters only: the item name its filter is set to, if any. */
  splitterFilter?: string;
  /** READ-ONLY hints: the items a constant combinator's signals, a display
   *  panel's icons, an infinity chest's filters or a requester/buffer chest's
   *  requests (every section) name. Players put these next to belts to say
   *  what's on them. Not written back on export. */
  signalItems?: string[];
  /** Circuit settings, kept as the blueprint wrote them and written back
   *  on export. Edited by the editor's circuit GUIs. */
  controlBehavior?: BpControlBehavior;
  /** Display panels and lamps: the settings outside control_behavior. */
  panel?: { text?: string; icon?: BpSignalId; alwaysShow?: boolean; showInChart?: boolean };
  color?: { r?: number; g?: number; b?: number; a?: number };
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
