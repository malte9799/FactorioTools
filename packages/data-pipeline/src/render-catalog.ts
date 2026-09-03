/** Builds the RenderCatalog: how to draw every entity that can appear in a
 *  blueprint but has no rate of its own. One explicit adapter per prototype
 *  family, each checked against a real dump. */
import { Layer } from "@factoriotools/engine";
import type { EntityGraphics, GraphicsLayer, MenuGroup, MenuPosition, RenderCatalog, RenderEntityProto, Sprite } from "@factoriotools/engine";
import type { LocaleTables } from "./locale.js";
import {
  animationListGraphics,
  directionColumnGraphics,
  layerOf,
  perDirection,
  stackSources,
  unwrapAll,
  toSprite,
  unwrap,
} from "./sprite-shapes.js";

type Raw = Record<string, Record<string, any>>;

function box(collisionBox: [[number, number], [number, number]] | undefined, fallback: [number, number]): [number, number] {
  if (!collisionBox) return fallback;
  const [[x1, y1], [x2, y2]] = collisionBox;
  return [Math.round((x2 - x1) * 100) / 100, Math.round((y2 - y1) * 100) / 100];
}

function footprintOf(proto: any): [number, number] {
  return box(proto.selection_box, [1, 1]);
}

const DIR4 = ["north", "east", "south", "west"] as const;
const DIR8 = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

/** Pipes and heat-pipes ship one sprite per connection shape, named by which
 *  sides connect. */
const PIPE_VARIANTS = [
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
  "straight_vertical_single",
] as const;

function pipeGraphics(pictures: any): EntityGraphics | undefined {
  if (!pictures) return undefined;
  const sprites: Record<string, Sprite> = {};
  for (const key of PIPE_VARIANTS) {
    const raw = pictures[key];
    const sprite = toSprite(Array.isArray(raw) ? raw[0] : raw);
    if (sprite) sprites[key] = sprite;
  }
  if (Object.keys(sprites).length === 0) return undefined;
  return {
    connector: "pipe",
    layers: [{ layer: Layer.Object, sprites, per: "connection" }],
  };
}

/** Walls pick both their sprite and its shadow by the same connection name. */
const WALL_PIECES: { field: string; name: string }[] = [
  { field: "single", name: "single" },
  { field: "straight_vertical", name: "straightVertical" },
  { field: "straight_horizontal", name: "straightHorizontal" },
  { field: "corner_right_down", name: "cornerRight" },
  { field: "corner_left_down", name: "cornerLeft" },
  { field: "t_up", name: "t" },
  { field: "ending_right", name: "endingRight" },
  { field: "ending_left", name: "endingLeft" },
];

function wallGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const sprites: Record<string, Sprite> = {};
  const shadows: Record<string, Sprite> = {};
  for (const { field, name } of WALL_PIECES) {
    const { main, shadow } = unwrap(pics?.[field]);
    if (!main) return undefined;
    sprites[name] = main;
    if (shadow) shadows[name] = shadow;
  }
  const layers: GraphicsLayer[] = [];
  if (Object.keys(shadows).length > 0) {
    layers.push({ layer: Layer.Shadow, sprites: shadows, per: "connection" });
  }
  layers.push({ layer: Layer.Object, sprites, per: "connection" });
  return { connector: "wall", layers };
}

/** Undergrounds and loaders share one sheet: facings as columns, entrance
 *  and exit (and, for undergrounds only, their side-loading variants — a
 *  different mouth piece for when a belt feeds in from the side rather
 *  than straight on) as rows. A loader's structure has no side-loading
 *  fields or ground-seam patches, so those layers are simply absent. */
function undergroundGraphics(proto: any): EntityGraphics | undefined {
  const struct = proto.structure;
  const out = struct?.direction_out?.sheet;
  const inn = struct?.direction_in?.sheet;
  const sprite = toSprite(out ?? inn);
  if (!sprite) return undefined;
  const rowOf = (s: any): number | undefined => (s ? Math.round((s.y ?? 0) / s.height) : undefined);

  const layers: GraphicsLayer[] = [];
  const backPatch = toSprite(struct?.back_patch?.sheet);
  if (backPatch) layers.push({ layer: Layer.Object, sprites: { ...backPatch, columns: 4 }, column: { by: "direction" } });

  layers.push({
    layer: Layer.Object,
    // One column per facing; the entrance/exit/side-loading rows are
    // picked by the entity's own end and its live neighbours, so the grid
    // origin resets to the sheet's top.
    sprites: { ...sprite, y: 0, columns: 4 },
    column: { by: "direction" },
    row: {
      by: "underground-end",
      inIndex: rowOf(inn) ?? 1,
      outIndex: rowOf(out) ?? 0,
      inSideLoadIndex: rowOf(struct?.direction_in_side_loading?.sheet),
      outSideLoadIndex: rowOf(struct?.direction_out_side_loading?.sheet),
    },
  });

  const frontPatch = toSprite(struct?.front_patch?.sheet);
  if (frontPatch) layers.push({ layer: Layer.Object, sprites: { ...frontPatch, columns: 4 }, column: { by: "direction" } });

  // Needed so collectEntity's belt-connector branch runs at all — without
  // it, an underground never picks up its own open-end cap or checks for
  // side-loading, both resolved from live neighbours the same way a plain
  // belt's are.
  return { layers, connector: "belt" };
}

/** A splitter draws two belt lanes under a body whose art is one whole file
 *  per facing. East and west need an extra patch to fill a gap their shorter
 *  body sprite leaves. */
function splitterGraphics(proto: any): EntityGraphics | undefined {
  const beltRaw = proto.belt_animation_set?.animation_set;
  const belt = toSprite(beltRaw);
  const structure = proto.structure;
  if (!belt || !structure) return undefined;

  const body = perDirection(structure, DIR4);
  if (!body) return undefined;

  // A splitter straddles two tiles, so it carries a belt lane either side of
  // its centre, offset across its own facing.
  const lane = (side: -1 | 1): Record<(typeof DIR4)[number], Sprite> => {
    const across = (d: (typeof DIR4)[number]): [number, number] =>
      d === "north" || d === "south" ? [0.5 * side, 0] : [0, 0.5 * side];
    return {
      north: { ...belt, shift: across("north") },
      east: { ...belt, shift: across("east") },
      south: { ...belt, shift: across("south") },
      west: { ...belt, shift: across("west") },
    };
  };

  const layers: GraphicsLayer[] = [
    { layer: Layer.LowerObject, sprites: lane(-1), per: "dir4", column: { by: "animation" }, row: { by: "connection" } },
    { layer: Layer.LowerObject, sprites: lane(1), per: "dir4", column: { by: "animation" }, row: { by: "connection" } },
    { layer: Layer.Object, sprites: body, per: "dir4" },
  ];

  const patches = proto.structure_patch ?? {};
  const usable = (raw: any) => typeof raw?.filename === "string" && !raw.filename.endsWith("empty.png");
  if (DIR4.some((d) => usable(patches[d]))) {
    const patch = {} as Record<(typeof DIR4)[number], Sprite>;
    for (const d of DIR4) {
      const sprite = usable(patches[d]) ? toSprite(patches[d]) : body[d];
      if (sprite) patch[d] = sprite;
    }
    layers.push({ layer: Layer.Object, sprites: patch, per: "dir4" });
  }
  return { connector: "belt", layers };
}

/** A roboport's `base` is the body with its hatch opening left uncovered;
 *  the closed-hatch cap and the seam patch over it are separate fields,
 *  always drawn together at their animation's first (closed) frame since a
 *  blueprint shows an idle roboport. The hatch is two leaves — up and down —
 *  each sliding into place from its own side at frame 0; each field's own
 *  shift already positions its half, no rotation needed. */
function roboportGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const l of unwrapAll(proto.base)) {
    layers.push({ layer: l.shadow ? Layer.Shadow : Layer.Object, sprites: l.sprite });
  }
  const patch = toSprite(proto.base_patch);
  if (patch) layers.push({ layer: Layer.Object, sprites: patch });
  for (const field of ["door_animation_up", "door_animation_down"]) {
    const door = toSprite(proto[field]);
    if (door) layers.push({ layer: Layer.Object, sprites: door });
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** A thruster's body is graphics_set.animation; its four pipe-connection
 *  pieces are always-visible working_visualisations entries (the fifth, a
 *  `fadeout` exhaust-flame effect, only shows while running and is skipped
 *  for the same reason animationListGraphics skips !always_draw entries). */
function thrusterGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const { main, shadow } = unwrap(gs?.animation);
  if (!main) return undefined;
  const layers: GraphicsLayer[] = [];
  if (shadow) layers.push({ layer: Layer.Shadow, sprites: shadow });
  layers.push({ layer: Layer.Object, sprites: main });
  const pipes = animationListGraphics(gs?.working_visualisations);
  if (pipes) layers.push(...pipes.layers);
  return { layers };
}

/** Gates only have two real orientations, so north aliases south and east
 *  aliases west. */
function gateGraphics(proto: any): EntityGraphics | undefined {
  const vertical = unwrap(proto.vertical_animation);
  const horizontal = unwrap(proto.horizontal_animation);
  if (!vertical.main || !horizontal.main) return undefined;
  const spread = (v: Sprite, h: Sprite) => ({ north: v, south: v, east: h, west: h });
  const layers: GraphicsLayer[] = [];
  if (vertical.shadow && horizontal.shadow) {
    layers.push({ layer: Layer.Shadow, sprites: spread(vertical.shadow, horizontal.shadow), per: "dir4" });
  }
  layers.push({ layer: Layer.Object, sprites: spread(vertical.main, horizontal.main), per: "dir4" });
  return { layers };
}

function fusionGeneratorGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const mains = {} as Record<(typeof DIR4)[number], Sprite>;
  const shadows = {} as Record<(typeof DIR4)[number], Sprite>;
  let anyShadow = false;
  for (const d of DIR4) {
    const { main, shadow } = unwrap(gs?.[`${d}_graphics_set`]?.animation);
    if (!main) return undefined;
    mains[d] = main;
    if (shadow) {
      shadows[d] = shadow;
      anyShadow = true;
    } else {
      shadows[d] = main;
    }
  }
  const layers: GraphicsLayer[] = [];
  if (anyShadow) layers.push({ layer: Layer.Shadow, sprites: shadows, per: "dir4" });
  layers.push({ layer: Layer.Object, sprites: mains, per: "dir4" });
  return { layers };
}

/** pipe-to-ground and valve ship one whole file per facing, no shadow. */
function perFacingGraphics(proto: any, field: string): EntityGraphics | undefined {
  const sprites = perDirection(proto[field], DIR4);
  if (!sprites) return undefined;
  return { layers: [{ layer: Layer.Object, sprites, per: "dir4" }] };
}

/** A rail's five pieces stack bottom-to-top: ballast, path, ties, backplates,
 *  metals. Only four of the eight facings carry art — the other four are the
 *  same piece seen from the opposite end. */
const RAIL_PIECES = ["stone_path_background", "stone_path", "ties", "backplates", "metals"] as const;

const RAIL_MIRROR: Record<(typeof DIR8)[number], (typeof DIR8)[number]> = {
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
  const layers: GraphicsLayer[] = [];
  for (const piece of RAIL_PIECES) {
    const sprites = {} as Record<(typeof DIR8)[number], Sprite>;
    for (const dir of DIR8) {
      const own = pics?.[dir];
      const source = own && Object.keys(own).length > 0 ? own : pics?.[RAIL_MIRROR[dir]];
      const sprite = toSprite(source?.[piece]);
      if (!sprite) return undefined;
      sprites[dir] = sprite;
    }
    layers.push({ layer: Layer.Floor, sprites, per: "dir8" });
  }
  return { layers };
}

/** Cargo hubs and bays declare an array of random appearance variants, each
 *  holding only the structure's edge pieces; the body sits separately under
 *  `animation`. Variant 0 is the static representative. The actual platform
 *  surface comes from `connections` — see platformGraphics below. */
function variantStackGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const layers: GraphicsLayer[] = [];
  for (const l of gs?.picture?.[0]?.layers ?? []) {
    if (l.draw_as_glow || l.blend_mode === "additive") continue;
    const sprite = toSprite(l);
    if (sprite) layers.push({ layer: l.draw_as_shadow ? Layer.Shadow : Layer.Object, sprites: sprite });
  }
  for (const l of unwrapAll(gs?.animation)) {
    layers.push({ layer: l.shadow ? Layer.Shadow : Layer.Object, sprites: l.sprite });
  }
  const platform = platformGraphics(gs?.connections);
  if (platform) layers.push(...platform);
  return layers.length > 0 ? { layers, connector: platform ? "platform" : undefined } : undefined;
}

/** The 17 shapes cargo hubs/bays pick between for their floor plating,
 *  keyed by which of their own kind sit adjacent — an auto-tiling system
 *  like walls, but per edge/corner of a whole multi-tile footprint rather
 *  than per tile. Each shape ships 1-4 random-looking variants (this pipeline
 *  always takes variant 0) built from four sub-images layered in a fixed
 *  order, each with its own render_layer. */
const PLATFORM_SHAPES = [
  "top_wall",
  "right_wall",
  "bottom_wall",
  "left_wall",
  "top_left_outer_corner",
  "top_right_outer_corner",
  "bottom_left_outer_corner",
  "bottom_right_outer_corner",
  "top_left_inner_corner",
  "top_right_inner_corner",
  "bottom_left_inner_corner",
  "bottom_right_inner_corner",
  "bridge_horizontal_narrow",
  "bridge_vertical_narrow",
  "bridge_horizontal_wide",
  "bridge_vertical_wide",
  "bridge_crossing",
] as const;

function platformGraphics(connections: any): GraphicsLayer[] | undefined {
  if (!connections) return undefined;
  // Every shape's variant 0 has the same four sub-images in the same order;
  // one GraphicsLayer per sub-image position, each keyed by shape name.
  const bySlot: Record<string, Sprite>[] = [];
  const slotLayer: Layer[] = [];
  for (const shape of PLATFORM_SHAPES) {
    const variant = connections[shape]?.[0];
    if (!Array.isArray(variant)) return undefined;
    variant.forEach((sub: any, slot: number) => {
      const raw = sub.layers?.[0] ?? sub;
      const sprite = toSprite(raw);
      if (!sprite) return;
      (bySlot[slot] ??= {})[shape] = sprite;
      slotLayer[slot] = layerOf(sub.render_layer, Layer.Object);
    });
  }
  return bySlot.map((sprites, slot) => ({
    layer: slotLayer[slot]!,
    sprites,
    per: "connection" as const,
  }));
}

const ROTATES_FOOTPRINT = new Set(["splitter", "fast-splitter", "express-splitter", "turbo-splitter"]);

/** table -> how to pull graphics out of that table's prototypes. Kept as an
 *  explicit map (not inferred) so adding a new entity kind means adding one
 *  line here with its confirmed field name, not guessing at runtime. */
const PICTURE_FIELD: Record<string, string> = {
  container: "picture",
  "logistic-container": "picture",
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
  "burner-generator": "animation",
  "fusion-reactor": "graphics_set",
  "selector-combinator": "sprites",
  "lightning-attractor": "chargable_graphics",
};

/** Tables whose art spans several fields, stacked bottom to top. A turret's
 *  gun sits on its base; a train stop's post and sign on its rail overlay. */
const STACKED_FIELDS: Record<string, string[]> = {
  "train-stop": ["rail_overlay_animations", "animations", "top_animations"],
  "ammo-turret": ["graphics_set", "folded_animation"],
  "electric-turret": ["graphics_set", "folded_animation"],
  "fluid-turret": ["graphics_set", "folded_animation"],
  "artillery-turret": ["base_picture", "cannon_base_pictures", "cannon_barrel_pictures"],
};

const SIMPLE_STATIC_TABLES = [...new Set([...Object.keys(PICTURE_FIELD), ...Object.keys(STACKED_FIELDS)])];

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

  // Cutscene set-dressing and map-generated ruins that share a real
  // prototype type but have no placing item, so can't appear in a blueprint.
  const NOT_PLACEABLE = /^(crash-site-|factorio-logo-|factorio-space-age-logo|fulgoran-ruin-)/;

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
    const stacked = STACKED_FIELDS[table];
    const field = PICTURE_FIELD[table];
    for (const proto of Object.values(raw[table] ?? {})) {
      if (stacked) {
        add(proto, stackSources(stacked.map((f) => proto[f])));
        continue;
      }
      // A prototype may not use its table's usual field — passive chests
      // carry `animation` where other containers carry `picture`.
      const source = (field ? proto[field] : undefined) ?? proto.animation ?? proto.picture ?? proto.pictures;
      add(proto, directionColumnGraphics(source));
    }
  }

  for (const proto of Object.values(raw.pipe ?? {})) {
    add(proto, pipeGraphics(proto.pictures));
  }
  for (const proto of Object.values(raw["heat-pipe"] ?? {})) {
    add(proto, pipeGraphics(proto.connection_sprites));
  }
  for (const proto of Object.values(raw["pipe-to-ground"] ?? {})) {
    add(proto, perFacingGraphics(proto, "pictures"));
  }
  for (const proto of Object.values(raw.valve ?? {})) {
    add(proto, perFacingGraphics(proto, "animations"));
  }
  for (const proto of Object.values({ ...(raw["underground-belt"] ?? {}), ...(raw["loader-1x1"] ?? {}), ...(raw.loader ?? {}) })) {
    add(proto, undergroundGraphics(proto));
  }
  for (const proto of Object.values(raw.splitter ?? {})) {
    add(proto, splitterGraphics(proto));
  }
  for (const proto of Object.values(raw.gate ?? {})) {
    add(proto, gateGraphics(proto));
  }
  for (const proto of Object.values(raw.roboport ?? {})) {
    add(proto, roboportGraphics(proto));
  }
  for (const proto of Object.values(raw.thruster ?? {})) {
    add(proto, thrusterGraphics(proto));
  }
  for (const proto of Object.values(raw["fusion-generator"] ?? {})) {
    add(proto, fusionGeneratorGraphics(proto));
  }
  for (const proto of Object.values(raw.wall ?? {})) {
    add(proto, wallGraphics(proto));
  }
  // Rails share one generic selection_box across every rail type, so their
  // real 2x2 collision box is passed explicitly instead.
  for (const proto of Object.values(raw["straight-rail"] ?? {})) {
    add(proto, railGraphics(proto), [2, 2]);
  }
  for (const table of ["cargo-landing-pad", "space-platform-hub", "cargo-bay"]) {
    for (const proto of Object.values(raw[table] ?? {})) {
      add(proto, variantStackGraphics(proto));
    }
  }
  for (const proto of Object.values(raw.inserter ?? {})) {
    add(proto, undefined);
  }

  const { menuGroups, menuPositions } = buildMenuIndex(raw, locale);
  return { version, entities, menuGroups, menuPositions };
}
