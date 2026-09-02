/**
 * Builds the RenderCatalog — visual-only entries (footprint + sprite) for
 * every entity kind that can appear in a blueprint but has no rate of its
 * own (poles, pipes, chests, walls, lamps, ...). GameData's
 * machines/beacons/belts/inserters already cover the entities that DO have a
 * rate; this catalog is what the renderer draws for everything else.
 *
 * This is a small set of explicit per-kind adapters, not one generic
 * graphics_set interpreter — each shape below was confirmed against the
 * real dump before being written, not inferred from Lua source.
 */
import type { EntityGraphics, MenuGroup, MenuPosition, RailLayerSet, RenderCatalog, RenderEntityProto, SpriteLayer } from "@factoriotools/engine";
import type { LocaleTables } from "./locale.js";

type Raw = Record<string, Record<string, any>>;

function box(collisionBox: [[number, number], [number, number]] | undefined, fallback: [number, number]): [number, number] {
  if (!collisionBox) return fallback;
  const [[x1, y1], [x2, y2]] = collisionBox;
  return [Math.round((x2 - x1) * 100) / 100, Math.round((y2 - y1) * 100) / 100];
}

function footprintOf(proto: any): [number, number] {
  return box(proto.selection_box, [1, 1]);
}

/** Pulls a {filename, shadow?, frame_count?} out of the handful of shapes
 *  confirmed present across static-picture entities: a bare sprite, a
 *  {layers:[...]} animation, a {sheets:[...]} picture set (storage-tank's
 *  shape), an {animation:{...}} wrapper (mining drills), or a genuinely
 *  per-direction {north,east,south,west} set of full sub-animations
 *  (oil-refinery, chemical-plant, pump, ... — confirmed by spike these
 *  machines' art actually differs by facing, unlike most entities) — each
 *  confirmed by spike, not guessed. The per-direction case always takes
 *  `north` as the static preview frame, matching this pipeline's existing
 *  "static pose, no live facing-dependent art" simplification rather than
 *  threading 4 separate sheets through EntityGraphics. Looks under a fixed
 *  list of known field names per entity kind rather than walking the object
 *  blindly, so an entity kind this doesn't recognise degrades to no graphics
 *  (outline fallback) instead of picking up something wrong. */
function extractPicture(source: any): EntityGraphics | undefined {
  if (!source) return undefined;
  // `filenames` (plural, an array of files the frame strip is split
  // across — confirmed by spike on thruster: 64 frames as 4 lines x 8/file
  // across 2 files) is treated as a single layer via its first file only;
  // frame (0,0) — this pipeline's static-pose convention — always lives in
  // file 0, so the later files covering only later frames are never needed.
  const single = source.filename ? source : source.filenames ? { ...source, filename: source.filenames[0] } : undefined;
  const layers: any[] | undefined = source.layers ?? source.sheets ?? (single ? [single] : undefined);
  if (!layers) {
    // One level deeper: {picture: {...}}, {animation: {...}}, or the
    // per-direction {north: {...}, ...} wrapper.
    if (source.north) return extractPicture(source.north);
    if (source.animation) return extractPicture(source.animation);
    if (source.picture) return extractPicture(source.picture);
    // Walls key their variants by name instead of a {layers:[...]} array —
    // `single` is the standalone-wall-tile variant, a reasonable static
    // representative (pipes/heat-pipes are the other named-variant case,
    // but those go through extractPipeConnectors instead since they need
    // ALL variants, not just one representative).
    if (source.single) return extractPicture(source.single);
    // Turrets' graphics_set wraps its real base sprite one level deeper
    // still, under base_visualisation.animation (a per-direction
    // {north,east,south,west[,diagonals]} wrapper the `source.north` check
    // above already knows how to recurse into) — confirmed by spike on
    // flamethrower-turret/railgun-turret, the two turret prototypes whose
    // `folded_animation` is itself a per-direction wrapper around the gun
    // NOZZLE piece rather than a {layers:[...]} object for the turret's own
    // base/body (gun-turret/laser-turret/rocket-turret's folded_animation
    // IS the base body directly, no graphics_set needed). base_visualisation
    // is itself sometimes an array of random-appearance variants rather
    // than a single object (confirmed on tesla-turret) — variant [0] is
    // taken as the static representative, same convention as
    // multiLayerPlatformGraphics uses for cargo-landing-pad's own variant
    // array.
    if (source.base_visualisation) {
      const bv = Array.isArray(source.base_visualisation) ? source.base_visualisation[0] : source.base_visualisation;
      return extractPicture(bv?.animation);
    }
    // Rail signals wrap their real sprite one level deeper still, under
    // ground_picture_set.structure.layers (confirmed by spike) — the
    // direction_count:16/frame_count:3 on that layer are the signal's own
    // rotation-angle and red/yellow/green status animation respectively,
    // neither of which this pipeline models; frame (0,0) is still the
    // right static preview pick.
    if (source.structure) return extractPicture(source.structure);
    return undefined;
  }
  const main = layers.find((l) => !l.draw_as_shadow) ?? layers[0];
  const shadow = layers.find((l) => l.draw_as_shadow);
  if (!main?.filename) return undefined;
  // direction_count (poles: 4, one column per facing) is a genuinely
  // different axis from frame_count/frames (an animation cycle, e.g.
  // storage-tank's 2-frame idle loop) — confirmed by spike these never both
  // appear together on the entities this pipeline covers, so picking
  // whichever is present is unambiguous here.
  return {
    kind: "sprite-4way",
    sheet: main.filename,
    frameWidth: main.width,
    frameHeight: main.height,
    directionCount: main.direction_count ?? 1,
    lineLength: main.frame_count ?? main.frames ?? 1,
    shift: main.shift,
    shadow: shadow?.filename
      ? {
          sheet: shadow.filename,
          frameWidth: shadow.width,
          frameHeight: shadow.height,
          scale: shadow.scale ?? 1,
          shift: shadow.shift,
        }
      : undefined,
    scale: main.scale ?? 1,
  };
}

/** Pipe/heat-pipe key their connection art by named variant
 *  (straight_vertical, corner_up_right, t_up, cross, ending_left, ...),
 *  confirmed by spike against the real dump AND by rendering each variant
 *  at high zoom to read off which side(s) actually show an open
 *  connection socket (see packages/renderer/src/pipeGraph.ts's own doc
 *  comment for the full mapping this pipeline and the renderer agree on).
 *  Extracts ALL 16 variants (not just one representative), since the
 *  renderer's neighbor classification (pipeGraph.ts) needs the real sheet
 *  for whichever shape a given pipe's neighbors resolve to — a single
 *  representative sprite (the pipeline's previous approach) meant every
 *  pipe rendered as an isolated straight segment regardless of what it was
 *  actually connected to. heat-pipe's connection_sprites wraps each
 *  variant as an ARRAY of layer objects instead of a bare sprite object,
 *  so each is unwrapped to its first element. */
const PIPE_VARIANT_KEYS = [
  "straight_vertical",
  "straight_horizontal",
  "corner_up_right",
  "corner_up_left",
  "corner_down_right",
  "corner_down_left",
  "t_up",
  "t_down",
  "t_left",
  "t_right",
  "cross",
  "ending_up",
  "ending_down",
  "ending_left",
  "ending_right",
] as const;

/** Splitters composite three separate pieces of art (confirmed by spike
 *  against data.raw.splitter.splitter): `belt_animation_set` is only the
 *  two belt lanes running under/through the splitter (the same sheet/row
 *  layout as a plain belt); the visible body/case is a SEPARATE `structure`
 *  field — four whole-file animations, one per cardinal direction; and
 *  `structure_patch` fills in a real gap for east/west specifically —
 *  north/south's own structure sprite is 2.5 tiles wide and already spans
 *  the whole splitter, but east/west's is only ~1.3 tiles along the
 *  direction of travel, short of the splitter's 1.8-tile length, and the
 *  patch (empty.png for north/south, a real sprite for east/west) covers
 *  the remainder. Returns undefined (outline fallback) if belt or
 *  structure is missing rather than drawing a half-composited splitter. */
function splitterGraphics(proto: any): EntityGraphics | undefined {
  const belt = proto.belt_animation_set?.animation_set;
  const structure = proto.structure;
  if (!belt?.filename || !structure) return undefined;

  type BodyLayer = { sheet: string; frameWidth: number; frameHeight: number; lineLength?: number; shift?: [number, number]; scale?: number };
  const spriteOf = (dir: any): BodyLayer | undefined => {
    if (!dir?.filename) return undefined;
    return {
      sheet: dir.filename,
      frameWidth: dir.width,
      frameHeight: dir.height,
      lineLength: dir.line_length ?? 1,
      shift: dir.shift,
      scale: dir.scale ?? 1,
    };
  };
  // __core__/graphics/empty.png is a real 1x1 placeholder file (confirmed
  // present in every Factorio install), not a missing reference — it loads
  // fine but draws nothing meaningful, so it's filtered out explicitly
  // rather than kept as a wasted extra draw call every frame.
  const patchOf = (dir: any): BodyLayer | undefined => {
    if (typeof dir?.filename !== "string" || dir.filename.endsWith("empty.png")) return undefined;
    return spriteOf(dir);
  };
  const bodyLayer = (dir: any, patch: any): (BodyLayer & { structurePatch?: BodyLayer }) | undefined => {
    const main = spriteOf(dir);
    if (!main) return undefined;
    const structurePatch = patchOf(patch);
    return structurePatch ? { ...main, structurePatch } : main;
  };
  const patches = proto.structure_patch ?? {};
  const north = bodyLayer(structure.north, patches.north);
  const east = bodyLayer(structure.east, patches.east);
  const south = bodyLayer(structure.south, patches.south);
  const west = bodyLayer(structure.west, patches.west);
  if (!north || !east || !south || !west) return undefined;

  return {
    kind: "splitter",
    belt: {
      kind: "belt",
      sheet: belt.filename,
      frameWidth: belt.size ?? belt.width,
      frameHeight: belt.size ?? belt.height,
      directionCount: belt.direction_count ?? 1,
      lineLength: belt.frame_count ?? 1,
      scale: belt.scale ?? 1,
    },
    body: { north, east, south, west },
  };
}

/** Gates have no plain static picture field (confirmed by spike) — their
 *  real art is vertical_animation/horizontal_animation, each a
 *  {main sprite, shadow} pair via the standard {layers:[...]} shape
 *  extractPicture already knows how to unwrap. Only 2 real orientations
 *  exist (a gate sits on a straight wall run), so north/south alias the
 *  vertical pair and east/west alias the horizontal one — see
 *  GateGraphics' own doc comment in types.ts for why this reuses
 *  DirectionalSpriteSet's 4-slot shape anyway. */
function gateGraphics(proto: any): EntityGraphics | undefined {
  const vertical = extractSpriteWithShadow(proto.vertical_animation);
  const horizontal = extractSpriteWithShadow(proto.horizontal_animation);
  if (!vertical || !horizontal) return undefined;
  return {
    kind: "gate",
    sprites: { north: vertical.sprite, south: vertical.sprite, east: horizontal.sprite, west: horizontal.sprite },
    shadows: { north: vertical.shadow, south: vertical.shadow, east: horizontal.shadow, west: horizontal.shadow },
  };
}

/** fusion-generator has no plain static picture field either (confirmed by
 *  spike) — its real art is graphics_set.{north,east,south,west}_graphics_
 *  set.animation, each a {main sprite, shadow} pair via the standard
 *  {layers:[...]} shape. All 4 directions have distinct dedicated art
 *  (unlike gates' 2-orientation aliasing), so this reuses GateGraphics'
 *  DirectionalSpriteSet+shadow shape as a 4-real-direction case of it. */
function fusionGeneratorGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const north = extractSpriteWithShadow(gs?.north_graphics_set?.animation);
  const east = extractSpriteWithShadow(gs?.east_graphics_set?.animation);
  const south = extractSpriteWithShadow(gs?.south_graphics_set?.animation);
  const west = extractSpriteWithShadow(gs?.west_graphics_set?.animation);
  if (!north || !east || !south || !west) return undefined;
  return {
    kind: "fusion-generator",
    sprites: { north: north.sprite, east: east.sprite, south: south.sprite, west: west.sprite },
    shadows: { north: north.shadow, east: east.shadow, south: south.shadow, west: west.shadow },
  };
}

/** pipe-to-ground and valve each have 4 facings as 4 entirely separate
 *  whole-file sprites (pipe-to-ground: pictures.{north,east,south,west};
 *  valve: animations.{north,east,south,west} — same shape, each a bare
 *  {filename,width,height,scale} with no shadow, confirmed by spike), so
 *  this pulls all 4 directly rather than picking one representative the
 *  way extractPicture does for other entities. Mirrors gateGraphics'
 *  DirectionalSpriteSet shape, just with no shadow slot needed. */
function directionalStaticGraphics(proto: any, field: string, kind: "pipe-to-ground" | "valve"): EntityGraphics | undefined {
  const pics = proto[field];
  // Valve's sprites use a single `size` (square) instead of separate
  // width/height (confirmed by spike on one-way-valve) — pipe-to-ground
  // uses width/height directly, so both are checked.
  const toLayer = (p: any): SpriteLayer | undefined =>
    p?.filename ? { sheet: p.filename, frameWidth: p.width ?? p.size, frameHeight: p.height ?? p.size, scale: p.scale ?? 1 } : undefined;
  const north = toLayer(pics?.north);
  const east = toLayer(pics?.east);
  const south = toLayer(pics?.south);
  const west = toLayer(pics?.west);
  if (!north || !east || !south || !west) return undefined;
  return { kind, sprites: { north, east, south, west } };
}

const RAIL_DIRECTIONS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;
const RAIL_LAYER_KEYS: { field: string; out: keyof RailLayerSet }[] = [
  { field: "stone_path_background", out: "stonePathBackground" },
  { field: "stone_path", out: "stonePath" },
  { field: "ties", out: "ties" },
  { field: "backplates", out: "backplates" },
  { field: "metals", out: "metals" },
];

/** straight-rail's pictures.{8 directions} each carry the same 5 named
 *  layers (stone_path_background, stone_path, ties, backplates, metals —
 *  confirmed by spike), every one a bare {filename,width,height,shift,
 *  scale,variation_count} sprite with no `layers` wrapper. Draw order
 *  bottom-to-top matches teoxoy/factorio-blueprint-editor's draw_rail
 *  exactly (background first, metals on top) — see
 *  [[feedback_reference_renderer_for_ground_truth]].
 *
 *  Only 4 of the 8 direction entries are ever populated in the real dump
 *  (north/northeast/east/southeast); south/southwest/west/northwest are
 *  literally `{}` (confirmed by spike) — a rail piece looks pixel-identical
 *  whether "facing" one way or its 180°-opposite along the same line, so
 *  Factorio doesn't duplicate the art. Falls back to `RAIL_OPPOSITE_DIR`'s
 *  pictures for the 4 empty ones, exactly matching draw_rail's own
 *  `if (Object.entries(ps).length === 0) ps = pictures[dir % 8]` fallback
 *  (that modulo, in the reference's OWN 0/2/4/6/8/10/12/14 8-way encoding,
 *  is precisely "the opposite direction's 4-way-equivalent slot"). */
const RAIL_OPPOSITE_DIR: Record<(typeof RAIL_DIRECTIONS)[number], (typeof RAIL_DIRECTIONS)[number]> = {
  north: "north",
  northeast: "northeast",
  east: "east",
  southeast: "southeast",
  south: "north",
  southwest: "northeast",
  west: "east",
  northwest: "southeast",
};

function railGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const toLayer = (p: any): SpriteLayer | undefined =>
    p?.filename
      ? { sheet: p.filename, frameWidth: p.width, frameHeight: p.height, shift: p.shift, scale: p.scale ?? 1, srcX: p.x ?? 0, srcY: p.y ?? 0 }
      : undefined;
  const result: any = { kind: "straight-rail" };
  for (const dir of RAIL_DIRECTIONS) {
    const dirPics = pics?.[dir];
    const source = dirPics && Object.keys(dirPics).length > 0 ? dirPics : pics?.[RAIL_OPPOSITE_DIR[dir]];
    const layers: any = {};
    for (const { field, out } of RAIL_LAYER_KEYS) {
      const layer = toLayer(source?.[field]);
      if (!layer) return undefined;
      layers[out] = layer;
    }
    result[dir] = layers;
  }
  return result;
}

/** cargo-landing-pad, space-platform-hub, and cargo-bay have no single
 *  representative sprite: their real base structure is graphics_set.picture,
 *  an array of random-appearance variants (each a composite of 1+ layers
 *  with no single "main" layer — graphics_set.animation, where present, is
 *  a separate decal, not the base structure). Takes variant [0] as the
 *  static representative and composes its layers as LayeredStaticGraphics
 *  (first layer becomes `base`, rest go in `layers` — for cargo-bay, whose
 *  variants only ever have the one layer, this degenerates to a plain
 *  single-sprite draw with an empty `layers` array).
 *
 *  KNOWN LIMITATION (cargo-landing-pad/space-platform-hub only, whose
 *  variants really are 4 equally-weighted edge/corner pieces): the real
 *  game also composites graphics_set.connections (a neighbor-aware
 *  wall/corner connector system, like pipeGraph.ts's classifyPipe but with
 *  more variants) to join the 4 pieces into one continuous border — not
 *  modelled here, so an isolated pad renders as 4 separate fragments with
 *  visible gaps. Confirmed this is genuinely how it looks without
 *  `connections`, not a shift-math bug — still an improvement over the
 *  previous total absence of any sprite. */
function multiLayerPlatformGraphics(proto: any): EntityGraphics | undefined {
  const variant = proto.graphics_set?.picture?.[0];
  const layers: any[] | undefined = variant?.layers;
  if (!Array.isArray(layers) || layers.length === 0) return undefined;
  const toLayer = (l: any): SpriteLayer | undefined =>
    l?.filename ? { sheet: l.filename, frameWidth: l.width, frameHeight: l.height, shift: l.shift, scale: l.scale ?? 1 } : undefined;
  const [first, ...rest] = layers;
  const base = toLayer(first);
  if (!base) return undefined;
  const extraLayers = rest.map(toLayer).filter((l): l is SpriteLayer => l !== undefined);
  return { kind: "layered-static", base, layers: extraLayers };
}

/** Unwraps a Factorio {layers:[main, shadow]} animation into its two
 *  SpriteLayer pieces directly, for the handful of callers (gateGraphics)
 *  that need both independently rather than folded into one
 *  Sprite4WayGraphics the way extractPicture's own return shape assumes. */
function extractSpriteWithShadow(anim: any): { sprite: SpriteLayer; shadow: SpriteLayer } | undefined {
  const layers = anim?.layers;
  if (!Array.isArray(layers)) return undefined;
  const main = layers.find((l: any) => !l.draw_as_shadow);
  const shadow = layers.find((l: any) => l.draw_as_shadow);
  if (!main?.filename || !shadow?.filename) return undefined;
  const toLayer = (l: any): SpriteLayer => ({
    sheet: l.filename,
    frameWidth: l.width,
    frameHeight: l.height,
    lineLength: l.line_length ?? l.frame_count ?? 1,
    shift: l.shift,
    scale: l.scale ?? 1,
  });
  return { sprite: toLayer(main), shadow: toLayer(shadow) };
}

/** Walls have no single representative sprite and no pipe-style
 *  one-file-per-neighbor-bitmask set either: confirmed by spike against
 *  data.raw.wall.stone-wall, `pictures` has exactly 8 named variants
 *  (single, straight_vertical, straight_horizontal, corner_right_down,
 *  corner_left_down, t_up, ending_right, ending_left), each a real
 *  {layers:[main,shadow]} pair extractSpriteWithShadow already knows how
 *  to unwrap. corner_right_down/corner_left_down are their own dedicated
 *  sprites (N|E and N|W respectively) — WallRenderer only falls back to
 *  rotating one of them for the other 2 corner cases, similarly t_up is
 *  the only dedicated T orientation and ending_right/ending_left the only
 *  two dedicated ending orientations (see WallGraphics' own doc comment in
 *  types.ts). Returns undefined (outline fallback) if any of the 8
 *  required variants is missing, matching this pipeline's existing
 *  all-or-nothing convention for other multi-piece entities (splitters,
 *  gates). */
function wallGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const single = extractSpriteWithShadow(pics?.single);
  const straightVertical = extractSpriteWithShadow(pics?.straight_vertical);
  const straightHorizontal = extractSpriteWithShadow(pics?.straight_horizontal);
  const cornerRight = extractSpriteWithShadow(pics?.corner_right_down);
  const cornerLeft = extractSpriteWithShadow(pics?.corner_left_down);
  const t = extractSpriteWithShadow(pics?.t_up);
  const endingRight = extractSpriteWithShadow(pics?.ending_right);
  const endingLeft = extractSpriteWithShadow(pics?.ending_left);
  if (!single || !straightVertical || !straightHorizontal || !cornerRight || !cornerLeft || !t || !endingRight || !endingLeft) return undefined;
  return {
    kind: "wall",
    single: single.sprite,
    singleShadow: single.shadow,
    straightVertical: straightVertical.sprite,
    straightVerticalShadow: straightVertical.shadow,
    straightHorizontal: straightHorizontal.sprite,
    straightHorizontalShadow: straightHorizontal.shadow,
    cornerRight: cornerRight.sprite,
    cornerRightShadow: cornerRight.shadow,
    cornerLeft: cornerLeft.sprite,
    cornerLeftShadow: cornerLeft.shadow,
    t: t.sprite,
    tShadow: t.shadow,
    endingRight: endingRight.sprite,
    endingRightShadow: endingRight.shadow,
    endingLeft: endingLeft.sprite,
    endingLeftShadow: endingLeft.shadow,
  };
}

function extractPipeConnectors(pictures: any): EntityGraphics | undefined {
  const connectors: Record<string, { sheet: string; frameWidth: number; frameHeight: number; scale?: number }> = {};
  for (const key of PIPE_VARIANT_KEYS) {
    let variant = pictures?.[key];
    if (Array.isArray(variant)) variant = variant[0];
    if (!variant?.filename) continue;
    connectors[key] = { sheet: variant.filename, frameWidth: variant.width, frameHeight: variant.height, scale: variant.scale ?? 1 };
  }
  // The lone-pipe-with-no-neighbors case uses its own dedicated asset
  // (straight_vertical_single) rather than reusing straight_vertical —
  // confirmed by spike it's visually a short capped stub, not a full
  // straight run. Keyed as "straight_vertical_single" to match
  // pipeGraph.ts's MASK_TO_VARIANT for the 0-neighbor case.
  let single = pictures?.straight_vertical_single;
  if (Array.isArray(single)) single = single[0];
  if (single?.filename) {
    connectors.straight_vertical_single = { sheet: single.filename, frameWidth: single.width, frameHeight: single.height, scale: single.scale ?? 1 };
  }
  if (Object.keys(connectors).length === 0) return undefined;
  return { kind: "pipe", connectors };
}

const ROTATES_FOOTPRINT = new Set(["splitter", "fast-splitter", "express-splitter", "turbo-splitter"]);

/** table -> how to pull graphics out of that table's prototypes. Kept as an
 *  explicit map (not inferred) so adding a new entity kind means adding one
 *  line here with its confirmed field name, not guessing at runtime. */
const PICTURE_FIELD: Record<string, string> = {
  container: "picture",
  "logistic-container": "picture",
  roboport: "base",
  "storage-tank": "pictures",
  pump: "animations",
  "offshore-pump": "graphics_set",
  "solar-panel": "picture",
  accumulator: "chargable_graphics",
  boiler: "pictures",
  "heat-interface": undefined as any,
  radar: "pictures",
  "rocket-silo": "graphics_set",
  "electric-pole": "pictures",
  // `picture_off` is the real unlit fixture (with its own proper shadow
  // layer) — confirmed by spike the previously-used `picture_on` is only
  // the glow-bulb overlay meant to sit ON TOP of the fixture when lit, not
  // the fixture itself, which is why lamps rendered as a bare floating
  // bulb with no shadow and no visible base.
  lamp: "picture_off",
  "arithmetic-combinator": "sprites",
  "decider-combinator": "sprites",
  "constant-combinator": "sprites",
  "programmable-speaker": "sprite",
  "power-switch": "power_on_animation",
  "display-panel": "sprites",
  "land-mine": "picture_safe",
  "rail-signal": "ground_picture_set",
  "rail-chain-signal": "ground_picture_set",
  "train-stop": "rail_overlay_animations",
  "asteroid-collector": "graphics_set",
  "agricultural-tower": "graphics_set",
  "mining-drill": "graphics_set",
  // Turrets: graphics_set.base_visualisation.animation is the turret's real
  // stationary base/body sprite (per-direction {north,east,south,west[,
  // diagonals]} — extractPicture's own base_visualisation fallback recurses
  // into it), universal across every ammo/electric/fluid-turret prototype
  // (confirmed by spike). `folded_animation` was tried first but is NOT a
  // reliable substitute: for gun-turret/laser-turret/tesla-turret/
  // rocket-turret it happens to BE the base body, but for flamethrower-
  // turret/railgun-turret it's only the gun NOZZLE piece (a much smaller,
  // separately-shifted sprite), which rendered as a nonsensical fragment
  // rather than the turret's actual body. Each base sprite also has a
  // `*-mask` layer (a team-color tint mask) extractPicture doesn't know
  // about; picking the first non-shadow layer as `main` skips it, matching
  // the "one main + one shadow" simplification used everywhere else here.
  "ammo-turret": "graphics_set",
  "electric-turret": "graphics_set",
  "fluid-turret": "graphics_set",
  // artillery-turret has no folded_animation of its own — base_picture is
  // its stationary base/platform only (no rotating cannon barrel, same
  // "static pose" simplification already used for rocket-silo/inserters).
  "artillery-turret": "base_picture",
  reactor: "picture",
  "linked-container": "picture",
  "infinity-container": "picture",
  "electric-energy-interface": "picture",
  thruster: "graphics_set",
  "burner-generator": "animation",
  "fusion-reactor": "graphics_set",
  "selector-combinator": "sprites",
  "lightning-attractor": "chargable_graphics",
};

const SIMPLE_STATIC_TABLES = Object.keys(PICTURE_FIELD);

/** Item tables that can carry a `place_result` — every prototype table an
 *  actually-placeable item could belong to. Kept as an explicit list rather
 *  than scanning every top-level table, matching this file's own house
 *  style of explicit per-kind lists over blind traversal. */
const ITEM_TABLES = ["item", "item-with-entity-data", "capsule", "gun", "armor", "module", "rail-planner"];

/** Resolves the real game's own build-menu structure (item-group ->
 *  item-subgroup -> item.order) from the raw dump — confirmed by spike this
 *  is exactly what the in-game build menu itself sorts by, not a guessed
 *  categorization. Returns menuGroups sorted by their own order, and one
 *  menuPositions entry per placeable entity name (resolved from whichever
 *  item has `place_result === entityName`; an entity with no such item, or
 *  whose item has no subgroup, is simply absent — the palette skips it
 *  rather than inventing a slot). */
function buildMenuIndex(raw: Raw, locale: LocaleTables): { menuGroups: MenuGroup[]; menuPositions: Record<string, MenuPosition> } {
  const subgroupToGroup = new Map<string, { group: string; subgroupOrder: string }>();
  for (const sg of Object.values(raw["item-subgroup"] ?? {})) {
    subgroupToGroup.set(sg.name, { group: sg.group, subgroupOrder: sg.order ?? "" });
  }

  const groupProtos = Object.values(raw["item-group"] ?? {});
  const menuGroups: MenuGroup[] = groupProtos
    .filter((g: any) => typeof g.icon === "string")
    .map((g: any) => ({
      name: g.name,
      icon: g.icon,
      localised: locale.itemGroupName?.get(g.name) ?? g.name,
      order: g.order ?? "",
    }))
    .sort((a, b) => a.order.localeCompare(b.order));

  const menuPositions: Record<string, MenuPosition> = {};
  for (const table of ITEM_TABLES) {
    for (const item of Object.values(raw[table] ?? {}) as any[]) {
      const entityName = item.place_result;
      if (typeof entityName !== "string" || menuPositions[entityName]) continue;
      const subgroupName = item.subgroup;
      const resolved = typeof subgroupName === "string" ? subgroupToGroup.get(subgroupName) : undefined;
      // No subgroup, or a subgroup naming a group this dump's item-group
      // table doesn't have an icon for (matches the game's own "Other"
      // catch-all tab) — confirmed by spike this is a real, if uncommon,
      // case rather than a data gap to work around.
      const group = resolved && menuGroups.some((g) => g.name === resolved.group) ? resolved.group : "other";
      menuPositions[entityName] = {
        group,
        subgroup: subgroupName ?? "other",
        subgroupOrder: resolved?.subgroupOrder ?? "",
        order: item.order ?? "",
      };
    }
  }

  return { menuGroups, menuPositions };
}

export function buildRenderCatalog(raw: Raw, locale: LocaleTables, version: string): RenderCatalog {
  const entities: Record<string, RenderEntityProto> = {};

  // A handful of "container"-typed prototypes are cutscene set-dressing
  // (crash-site-*, factorio-logo-*) — not placeable in any blueprint, so
  // they're filtered rather than cluttering the catalog.
  const NOT_PLACEABLE = /^(crash-site-|factorio-logo-|factorio-space-age-logo)/;

  const add = (proto: any, graphics: EntityGraphics | undefined, footprintOverride?: [number, number]) => {
    if (entities[proto.name] || NOT_PLACEABLE.test(proto.name)) return;
    entities[proto.name] = {
      name: proto.name,
      tileFootprint: footprintOverride ?? footprintOf(proto),
      graphics,
      rotatesFootprint: ROTATES_FOOTPRINT.has(proto.name),
      localised: locale.entityName.get(proto.name) ?? proto.name,
    };
  };

  for (const table of SIMPLE_STATIC_TABLES) {
    const field = PICTURE_FIELD[table];
    for (const proto of Object.values(raw[table] ?? {})) {
      // Falls back to a small set of other commonly-used field names when
      // the table's own declared PICTURE_FIELD comes up empty — confirmed
      // necessary by spike: some prototypes within a table that otherwise
      // uses e.g. `picture` instead use `animation` (passive-provider-chest
      // has no `picture` field at all, only `animation`), and maintaining a
      // second per-prototype override table isn't worth it for a handful
      // of cases extractPicture's own recursion already knows how to read.
      const graphics =
        (field ? extractPicture(proto[field]) : undefined) ??
        extractPicture(proto.animation) ??
        extractPicture(proto.picture) ??
        extractPicture(proto.pictures);
      add(proto, graphics);
    }
  }

  for (const proto of Object.values(raw.pipe ?? {})) {
    add(proto, extractPipeConnectors(proto.pictures));
  }
  for (const proto of Object.values(raw["pipe-to-ground"] ?? {})) {
    add(proto, directionalStaticGraphics(proto, "pictures", "pipe-to-ground"));
  }
  for (const proto of Object.values(raw["heat-pipe"] ?? {})) {
    add(proto, extractPipeConnectors(proto.connection_sprites));
  }
  for (const proto of Object.values(raw.valve ?? {})) {
    add(proto, directionalStaticGraphics(proto, "animations", "valve"));
  }
  // Underground belts AND loaders (loader/loader-1x1, all tiers) share the
  // exact same structure.direction_in / direction_out shape (confirmed by
  // spike on both fast-underground-belt and loader-1x1) — a single sheet, 4
  // columns (one per cardinal facing) x 2 rows, direction_out at row 0 and
  // direction_in at row 1 (their sheet.y offsets — 0 and frameHeight —
  // confirm this; only these two rows are ever drawn from, the sheet's
  // other rows on underground belts specifically are unrelated
  // belt-animation content this renderer doesn't use). direction_in is the
  // entrance a belt feeds into (item disappears); direction_out is the exit
  // it re-emerges from — which one a given placed entity needs depends on
  // its own blueprint `type` field (PlacedEntity.undergroundType, read
  // generically off ANY entity with that field, not underground-belt-
  // specific — loaders use the identical "input"/"output" convention for
  // which side of the container they load/unload), not derivable from
  // direction alone, so both row offsets are kept rather than picking one
  // "representative" sprite. Loaders' own belt-strip animation
  // (belt_animation_set) and container-transition overlay layers
  // (belt_reader) are NOT modelled — this draws the loader's structural
  // housing only, the same "good enough static representative" tradeoff
  // this pipeline already makes for e.g. inserters' platform. */
  for (const proto of Object.values({ ...(raw["underground-belt"] ?? {}), ...(raw["loader-1x1"] ?? {}), ...(raw.loader ?? {}) })) {
    const outSheet = proto.structure?.direction_out?.sheet;
    const inSheet = proto.structure?.direction_in?.sheet;
    const sheet = outSheet ?? inSheet;
    add(
      proto,
      sheet?.filename
        ? {
            kind: "underground",
            sheet: sheet.filename,
            frameWidth: sheet.width,
            frameHeight: sheet.height,
            directionCount: 4,
            lineLength: 1,
            scale: sheet.scale ?? 1,
            undergroundOutRow: outSheet ? Math.round((outSheet.y ?? 0) / outSheet.height) : 0,
            undergroundInRow: inSheet ? Math.round((inSheet.y ?? 0) / inSheet.height) : 1,
          }
        : undefined,
    );
  }
  for (const proto of Object.values(raw.splitter ?? {})) {
    add(proto, splitterGraphics(proto));
  }
  for (const proto of Object.values(raw.gate ?? {})) {
    add(proto, gateGraphics(proto));
  }
  for (const proto of Object.values(raw["fusion-generator"] ?? {})) {
    add(proto, fusionGeneratorGraphics(proto));
  }
  for (const proto of Object.values(raw.wall ?? {})) {
    add(proto, wallGraphics(proto));
  }
  // Rails' own selection_box is a fixed generic hitbox shared identically
  // across straight/curved/diagonal rail prototypes (confirmed by spike —
  // NOT usable as a visual footprint the way every other entity's
  // selection_box is), so this passes an explicit footprint override
  // instead of footprintOf's default collision_box read. [2,2] matches
  // straight-rail's own real collision_box (confirmed by spike) for
  // cardinal directions; diagonal-direction rails visually overhang this
  // (their sprite is ~6 tiles across, per the raw dump) but a 2x2
  // footprint is still the correct SELECTION/placement-grid size for every
  // direction (rails use Factorio's 2x2 build_grid_size uniformly) — this
  // pipeline's existing snapAxis placement logic (packages/renderer/src/
  // render.ts) already derives snapping from footprint parity generically,
  // so [2,2] gets that right for free without rail-specific snap code.
  for (const proto of Object.values(raw["straight-rail"] ?? {})) {
    add(proto, railGraphics(proto), [2, 2]);
  }
  for (const table of ["cargo-landing-pad", "space-platform-hub", "cargo-bay"]) {
    for (const proto of Object.values(raw[table] ?? {})) {
      add(proto, multiLayerPlatformGraphics(proto));
    }
  }
  for (const proto of Object.values(raw.inserter ?? {})) {
    // Procedural (rotating hand + platform layers), confirmed no frame sheet
    // exists at all — renderer draws these compositely, not from `graphics`.
    add(proto, undefined);
  }

  const { menuGroups, menuPositions } = buildMenuIndex(raw, locale);
  return { version, entities, menuGroups, menuPositions };
}
