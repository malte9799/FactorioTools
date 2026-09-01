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

/** One drawable sprite sheet: enough geometry to slice and place it, nothing
 *  kind-specific. Reused across every EntityGraphics variant below instead
 *  of each variant re-declaring sheet/frameWidth/frameHeight/etc. */
export interface SpriteLayer {
  /** Atlas region id / sprite manifest key. */
  sheet: string;
  /** Per-frame pixel width/height within the sheet — needed to slice it,
   *  since sheets pack either directions-as-columns (poles) or an
   *  animation-cycle grid (assemblers: frame_count/line_length rows x
   *  columns), and those aren't distinguishable from the sheet's pixel
   *  dimensions alone. */
  frameWidth: number;
  frameHeight: number;
  /** How many of the sheet's frames are distinct facings (poles: 4, one per
   *  cardinal direction, laid out as columns). 1 means the entity doesn't
   *  visually rotate (assemblers, furnaces — their footprint is direction-
   *  agnostic; only the recipe/what's plugged in matters). Defaults to 1. */
  directionCount?: number;
  /** How many columns one row of the sheet has — needed to convert a linear
   *  frame index back into (row, col) for sheets like the assembler's
   *  animation grid (frame_count 32, line_length 8 -> 4 rows x 8 cols).
   *  Defaults to 1. */
  lineLength?: number;
  /** This layer's own shift, in tiles, from the entity's collision-box
   *  center — Factorio's real dump carries this on essentially every
   *  layer (confirmed by spike against chemical-plant: shift [0.016,
   *  -0.281] even on the main, non-shadow layer), so most real sprites
   *  are NOT centered on the tile grid. [x, y] in the sprite's own
   *  north-facing local space, same convention as the game's own shift
   *  field. Undefined means no shift (draw centered). */
  shift?: [number, number];
  /** Factorio's per-sprite scale factor: on-screen tile size = pixel size *
   *  scale / 32. Defaults to 1. */
  scale?: number;
}

/** A shadow is always its own independent SpriteLayer, never reusing the
 *  main layer's geometry — confirmed by spike: chemical-plant's shadow is
 *  312x222 at shift [0.844, 0.188], versus the main layer's 220x292 at
 *  [0.016, -0.281]. */
export type ShadowLayer = SpriteLayer;

/** How an entity's real sprite is put together. Additive on top of the
 *  numeric model so the calc engine works whether or not graphics data is
 *  present — a dataset with no `graphics` fields still calculates rates
 *  fine, it just can't be sprite-rendered. A discriminated union on `kind`
 *  rather than one bag of optional fields, since Factorio composes
 *  different entity families in genuinely different ways (a single sprite
 *  vs. several always-drawn layers vs. neighbor-aware connection art) —
 *  each variant below only carries the fields its own composition actually
 *  needs, and the renderer dispatches on `kind` to a matching draw
 *  function per variant (see entityDraw.ts). */
export type EntityGraphics =
  | Sprite4WayGraphics
  | LayeredStaticGraphics
  | BeltEntityGraphics
  | UndergroundGraphics
  | PipeGraphics
  | SplitterGraphics
  | GateGraphics
  | { kind: "none" };

/** The common case: one main sprite (direction-indexed or animation-cycle,
 *  see SpriteLayer's own doc comments) plus an optional shadow. Used by the
 *  large majority of machines, chests, walls, and similar single-sprite
 *  entities. */
export interface Sprite4WayGraphics extends SpriteLayer {
  kind: "sprite-4way" | "static";
  shadow?: ShadowLayer;
}

/** Several always-visible static layers stacked in draw order, each with
 *  its own independent geometry/shift — for entities whose real
 *  graphics_set genuinely has more than one always-drawn piece and no
 *  single "main sprite" covers it:
 *  - Beacons: a base pad layer plus a separate top/spike layer
 *    (graphics_set.animation_list[0] and [1] — confirmed by spike neither
 *    alone is the whole beacon; the light-glow layers ([2]/[3]) are
 *    skipped as a deliberate simplification, matching the project's
 *    existing "no live animation state" convention).
 *  - Lamps: the real off/unlit fixture (picture_off, WITH its own shadow)
 *    as the base layer — confirmed by spike the previously-used
 *    `picture_on` field is only the glow-bulb overlay meant to sit ON TOP
 *    of the fixture when lit, not the fixture itself.
 *  - electromagnetic-plant-style newer Space Age machines: the base plate
 *    (graphics_set.idle_animation, WITH its own shadow) plus the "idle"
 *    working_visualisations entry (graphics_set.working_visualisations[i]
 *    where draw_in_states includes "idle" — confirmed by spike this is
 *    the always-present main body, not an active-crafting-only overlay,
 *    even though it's declared inside the working_visualisations state
 *    machine alongside genuinely state-gated art).
 *  - Space Age mining drills (big-mining-drill): a THIRD
 *    working_visualisations convention — every `always_draw: true` entry's
 *    art stacked as its own layer, since these entities' body is genuinely
 *    built from many always-visible pieces (drill head, struts, wheels,
 *    output chute, ...), not one main sprite plus a single extra layer. */
export interface LayeredStaticGraphics {
  kind: "layered-static";
  /** Drawn first, bottom-most. Carries the entity's own shift/shadow. */
  base: SpriteLayer;
  shadow?: ShadowLayer;
  /** Drawn in order after `base`, no shadows of their own (Factorio's real
   *  dump never gives these secondary layers an independent shadow —
   *  they're detail/structure sitting on the base's already-shadowed
   *  footprint). */
  layers: SpriteLayer[];
}

/** Belts pack every connection variant into one sheet as 20 fixed rows —
 *  see packages/renderer/src/beltGraph.ts for the row layout. */
export interface BeltEntityGraphics extends SpriteLayer {
  kind: "belt";
}

/** Underground belts share the direction-indexed column layout other
 *  sprite-4way entities use, but ALSO need a row pick this shape has no
 *  concept of otherwise: entrance vs. exit is a genuinely separate axis
 *  from facing (PlacedEntity.undergroundType, from the blueprint's own
 *  `type` field), packed as two rows in the same sheet. */
export interface UndergroundGraphics extends SpriteLayer {
  kind: "underground";
  undergroundOutRow?: number;
  undergroundInRow?: number;
}

/** Neighbor-aware connection art, keyed by neighbor bitmask (N/E/S/W
 *  connection variants) — mirrors belts' own neighbor-classification
 *  approach (see packages/renderer/src/beltGraph.ts) but for pipes'
 *  straight/corner/T/cross/end variants instead of belt curves. */
export interface PipeGraphics {
  kind: "pipe";
  connectors: Record<string, SpriteLayer>;
}

/** Splitters composite a belt-lane animation (`belt_animation_set`) with a
 *  separate body/case sprite (`structure`, one whole PNG per cardinal
 *  direction — not columns in a shared sheet) plus a `structurePatch` that
 *  fills a real gap for east/west facings specifically (see
 *  packages/data-pipeline/src/render-catalog.ts's splitterGraphics for the
 *  full story on why both pieces are needed). */
export interface SplitterGraphics {
  kind: "splitter";
  /** The belt-lane animation underneath the body — same sheet shape/row
   *  layout as BeltEntityGraphics, drawn first so the body sits on top. */
  belt: BeltEntityGraphics;
  /** One whole-file animation per cardinal facing (see
   *  DirectionalSpriteSetGraphics' own doc comment for why this needs its
   *  own set shape rather than SpriteLayer's directionCount columns). Each
   *  facing's own `structurePatch` (undefined when data.raw's own patch for
   *  that facing is __core__/graphics/empty.png, i.e. north/south in
   *  vanilla) is drawn on top of `structure`, filling in the gap described
   *  in DirectionalSpriteSetGraphics' doc comment's splitter example. */
  body: DirectionalSpriteSet<SpriteLayer & { structurePatch?: SpriteLayer }>;
}

/** Four independent whole-file sprites, one per cardinal facing — for
 *  entities whose per-direction art is genuinely separate source images
 *  rather than columns of one shared sheet (SpriteLayer's own
 *  `directionCount` covers that more common case; poles and undergrounds
 *  are one file with a column per facing). Confirmed by spike on two
 *  entities this doesn't fit any other way: splitters (structure.north/
 *  east/south/west are 4 distinct PNGs, each its own animation-cycle grid —
 *  see SplitterGraphics) and gates (vertical_animation/horizontal_animation
 *  are 2 distinct PNGs — a gate only ever has 2 real facings since it sits
 *  on a straight wall run, so north/south alias the same `vertical` sprite
 *  and east/west alias `horizontal`; GateGraphics still stores all 4 slots
 *  rather than adding a "2 vs 4 variants" branch to every reader of this
 *  type). Keys index directly by toCardinal()'s own 0/4/8/12 scheme (see
 *  packages/renderer/src/beltGraph.ts). */
export interface DirectionalSpriteSet<TLayer = SpriteLayer> {
  north: TLayer;
  east: TLayer;
  south: TLayer;
  west: TLayer;
}

/** Gates have no simple static picture (confirmed by spike: no plain
 *  `picture`/`graphics_set` field at all) — their real art is
 *  vertical_animation/horizontal_animation, each a {sprite, shadow} pair
 *  and an open/close animation-cycle grid (frame_count/line_length), always
 *  drawn at frame (0,0) — the closed resting pose — matching this
 *  pipeline's "static preview, no live animation" convention for every
 *  other multi-frame entity. A gate only has 2 real orientations (it sits
 *  on a straight wall run, so its own `direction` is either N/S or E/W),
 *  represented via DirectionalSpriteSet with north===south and east===west
 *  rather than inventing a 2-slot variant of that type. */
export interface GateGraphics {
  kind: "gate";
  sprites: DirectionalSpriteSet;
  shadows: DirectionalSpriteSet;
}

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

/** Belts pack every connection variant (straight/curved/side-loading) into
 *  ONE sheet as 20 fixed rows (a Factorio engine convention, confirmed by
 *  spike against the real transport-belt sheet — see
 *  packages/renderer/src/beltGraph.ts for the row layout), with `frameCount`
 *  animation-cycle columns that vary by belt tier (16 for yellow, up to 64
 *  for turbo). Additive/optional so the calc engine doesn't need it. */
export interface BeltGraphicsSet {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Factorio's per-sprite scale factor: on-screen tile size = pixel size *
   *  scale / 32 (confirmed by spike against fast-transport-belt's real
   *  128px-at-scale-0.5 frames, which render 2x2 tiles, not 1x1 — belt
   *  animation art deliberately overhangs into neighboring tiles so
   *  adjacent belts blend into one continuous strip instead of showing
   *  seams). */
  scale: number;
}

export interface BeltProto {
  name: string;
  /** Items per second on a full belt, one item per slot. */
  throughput: number;
  graphics?: BeltGraphicsSet;
  localised: string;
}

/** Inserters are procedurally drawn (platform + a rotating hand), not a
 *  single direction-indexed sheet like most entities — confirmed by spike —
 *  so this is its own small shape rather than reusing EntityGraphics. The
 *  renderer draws a static "hand
 *  extended toward its drop side" pose, matching how the game's own
 *  blueprint/ghost preview shows one fixed frame rather than an animation.
 *
 *  The platform sprite is 4-directional (one column per cardinal facing) —
 *  confirmed by inspecting the actual extracted PNG (420px wide = 4x105,
 *  the dump's own `width` field is the PER-FRAME size even though no
 *  direction_count field is present; Factorio defaults inserter platforms
 *  to 4 facings). The hand sprites are single frames rotated at draw time
 *  by the canvas transform instead of being pre-baked per direction —
 *  confirmed by their pixel dimensions matching the dump exactly with no
 *  multiple to divide out. */
export interface InserterGraphics {
  platformSheet: string;
  /** Per-frame size — divide the real sheet width by platformDirections to
   *  get this; the dump's own width/height fields are already per-frame. */
  platformWidth: number;
  platformHeight: number;
  /** Factorio's per-sprite scale factor: on-screen tile size = pixel size *
   *  scale / 32 (32px/tile is the game's base resolution at scale 1.0,
   *  confirmed against assembling-machine-2's own scale-0.5 sprite sizing).
   *  Each of the three sprites below carries its own independent scale in
   *  the dump, so all three are kept rather than assuming one shared value. */
  platformScale: number;
  /** Always 4 in the current dataset (confirmed by spike), kept explicit
   *  rather than hardcoded in the renderer in case a future dump differs. */
  platformDirections: number;
  handBaseSheet: string;
  handBaseWidth: number;
  handBaseHeight: number;
  handBaseScale: number;
  handOpenSheet: string;
  handOpenWidth: number;
  handOpenHeight: number;
  handOpenScale: number;
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

/** Visual-only entity entry — poles, pipes, chests, walls, lamps, and
 *  everything else that can appear in a blueprint but has no rate of its own
 *  (GameData's machines/beacons/belts/inserters already cover the entities
 *  that DO have a rate — this catalog exists purely so the renderer has
 *  something to draw for the rest, keyed by the same prototype names). */
export interface RenderEntityProto {
  name: string;
  tileFootprint: [number, number];
  graphics?: EntityGraphics;
  /** Entities that rotate their footprint (swap width/height) at east/west
   *  facings — confirmed necessary for splitters; harmless default false for
   *  everything else. */
  rotatesFootprint?: boolean;
  localised: string;
}

/** One of the real game's own build-menu tabs (Logistics, Production,
 *  Intermediate Products, Space, Combat, Other/Uncategorized) — confirmed
 *  by spike against the dump's `item-group` table, which is exactly what
 *  the game itself sorts the crafting/build menu by. Kept as its own
 *  lookup (not folded into MachineProto etc.) since it's a UI-only concern
 *  the calc engine has no use for, and applies uniformly across every
 *  placeable entity kind (GameData's machines/beacons/belts/inserters AND
 *  RenderCatalog's visual-only entities) via one shared name -> position
 *  map rather than per-kind duplication. */
export interface MenuGroup {
  name: string;
  /** Tab icon — a whole-image icon (item-group's own dedicated PNG, not a
   *  cell in the shared item/recipe icon sheet), referenced by manifest
   *  key the same way EntityGraphics.sheet works. */
  icon: string;
  localised: string;
  /** Sort order among tabs, e.g. "a" < "b" — matches the game's own
   *  item-group.order field, string-compared. */
  order: string;
}

export interface MenuPosition {
  group: string;
  subgroup: string;
  /** Sort order of `subgroup` among its siblings within `group` — matches
   *  the game's own item-subgroup.order field. Sort key priority is
   *  subgroupOrder, then order (below) — matches how the real build menu
   *  clusters items by subgroup first (e.g. all belt tiers together) before
   *  ordering within that cluster. */
  subgroupOrder: string;
  /** Sort order within the subgroup — matches the game's own item.order
   *  field, string-compared (not numeric; Factorio's own convention). */
  order: string;
}

export interface RenderCatalog {
  version: string;
  entities: Record<string, RenderEntityProto>;
  /** Build-menu tabs, keyed by item-group name, already sorted by `order`. */
  menuGroups: MenuGroup[];
  /** Every placeable entity's build-menu slot, keyed by entity/prototype
   *  name — covers both RenderCatalog's own entities AND GameData's
   *  machines/beacons/belts/inserters (the palette needs one lookup that
   *  doesn't care which side of that split a name came from, mirroring
   *  entityLookup.ts's own buildVisualLookup precedent). Absent for a name
   *  means "not directly placeable" (has no corresponding item with
   *  place_result) — the palette should skip it rather than guess a slot. */
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
