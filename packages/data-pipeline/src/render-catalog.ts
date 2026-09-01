/**
 * Builds the RenderCatalog — visual-only entries (footprint + sprite) for
 * every entity kind that can appear in a blueprint but has no rate of its
 * own (poles, pipes, chests, walls, lamps, ...). GameData's
 * machines/beacons/belts/inserters already cover the entities that DO have a
 * rate; this catalog is what the renderer draws for everything else.
 *
 * Per the project plan's B.3, this is a small set of explicit per-kind
 * adapters, not one generic graphics_set interpreter — each shape below was
 * confirmed against the real dump before being written, not inferred from
 * Lua source.
 */
import type { EntityGraphics, MenuGroup, MenuPosition, RenderCatalog, RenderEntityProto } from "@factoriotools/engine";
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
  const layers: any[] | undefined = source.layers ?? source.sheets ?? (source.filename ? [source] : undefined);
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

/** Splitters composite three genuinely separate pieces of art (confirmed by
 *  spike against data.raw.splitter.splitter): `belt_animation_set` is only
 *  the two belt lanes running under/through the splitter, using the exact
 *  same sheet + row layout as a plain transport belt (an earlier version of
 *  this mapper mistook this alone for the splitter's whole appearance,
 *  which is why it rendered as a single straight belt tile); the visible
 *  splitter body/case (with the priority-input/output arrows and
 *  filter-item slot) is a SEPARATE `structure` field — four independent
 *  whole-file animations, one per cardinal direction
 *  (structure.north/east/south/west); AND `structure_patch`, which is NOT
 *  the mostly-empty afterthought its name suggests — confirmed by spike
 *  north/south's own patch really is __core__/graphics/empty.png (skippable),
 *  but east/west's is a real non-empty sprite that fills in exactly the
 *  portion `structure` itself is too short to cover (north/south's
 *  structure sprite is 2.5 tiles wide, already spanning the whole splitter
 *  in one image; east/west's is only ~1.3 tiles along the direction of
 *  travel, short of the splitter's 1.8-tile length) — omitting it left the
 *  reported "top half of an east/west splitter is missing" gap. Returns
 *  undefined (outline fallback) if belt or structure is missing rather than
 *  drawing a half-composited splitter; a missing/empty patch is fine, it's
 *  legitimately absent for north/south. */
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
  wall: "pictures",
  gate: undefined as any, // has no simple static picture (animated open/close) — falls back to outline
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
  // Neither has a single representative static sprite the way the other
  // graphics_set-keyed entities here do — confirmed by spike: their real
  // base structure lives in graphics_set.picture as an array of per-variant
  // multi-layer composites (no one "main" layer to pick), and the field
  // extractPicture actually reaches first, graphics_set.animation, is a
  // decal/greebling overlay (turbine detail bits / cockpit panel bits), not
  // the base structure — picking it up produced a tiny, wrong-looking
  // fragment instead of the real platform. Left undefined (falls back to
  // the outline box) rather than showing a misleadingly wrong sprite, the
  // same treatment already given to gate/rocket-silo's own multi-piece
  // complexity.
  "cargo-landing-pad": undefined as any,
  "space-platform-hub": undefined as any,
  "mining-drill": "graphics_set",
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

  const add = (proto: any, graphics: EntityGraphics | undefined) => {
    if (entities[proto.name] || NOT_PLACEABLE.test(proto.name)) return;
    entities[proto.name] = {
      name: proto.name,
      tileFootprint: footprintOf(proto),
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
    // pipe-to-ground's 4 facings are 4 entirely separate image files (not
    // columns of one sheet the way poles/other direction_count>1 entities
    // are), which doesn't fit either extractPicture's single-sheet model
    // or the neighbor-classified connector model above — so, matching
    // this pipeline's existing "static preview pose" simplification, only
    // the north-facing file is kept as a single representative sprite;
    // the entity still renders (just always in its north pose) rather
    // than needing a third graphics variant just for this one case.
    add(proto, extractPicture(proto.pictures?.north));
  }
  for (const proto of Object.values(raw["heat-pipe"] ?? {})) {
    add(proto, extractPipeConnectors(proto.connection_sprites));
  }
  // Underground belts have their OWN static entrance/exit sprites
  // (structure.direction_in / direction_out, confirmed by spike on
  // fast-underground-belt — a single 768x768 sheet, 4 columns (one per
  // cardinal facing, same convention as poles) x rows, with direction_out
  // at row 0 and direction_in at row 1 (their sheet.y offsets — 0 and
  // frameHeight — confirm this; only these two rows are ever drawn from,
  // the sheet's other rows are unrelated belt-animation content this
  // renderer doesn't use). direction_in is the entrance a belt feeds into
  // (item disappears); direction_out is the exit it re-emerges from — which
  // one a given placed entity needs depends on its own blueprint `type`
  // field (PlacedEntity.undergroundType), not derivable from direction
  // alone, so both row offsets are kept rather than picking one
  // "representative" sprite as this mapper originally (incorrectly) did.
  for (const proto of Object.values(raw["underground-belt"] ?? {})) {
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
  for (const proto of Object.values(raw.inserter ?? {})) {
    // Procedural (rotating hand + platform layers), confirmed no frame sheet
    // exists at all — renderer draws these compositely, not from `graphics`.
    add(proto, undefined);
  }

  const { menuGroups, menuPositions } = buildMenuIndex(raw, locale);
  return { version, entities, menuGroups, menuPositions };
}
