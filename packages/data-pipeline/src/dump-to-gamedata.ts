#!/usr/bin/env tsx
/**
 * Reads Factorio's `--dump-data` output (data.raw as JSON) and a Factorio
 * install's Contents/data locale files, and emits a trimmed GameData JSON
 * the calc engine and renderer both read through.
 *
 * Run manually, never in CI (no licensed game files there):
 *   npm run dump-to-gamedata --workspace=@factoriotools/data-pipeline
 *
 * Inputs (both confirmed present via a spike before writing this):
 *   ~/Library/Application Support/factorio/script-output/data-raw-dump.json
 *   /Applications/factorio.app/Contents/data  (or the Steam copy)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeaconProto,
  BeltGraphicsSet,
  BeltProto,
  Effects,
  EntityGraphics,
  GameData,
  IngredientProto,
  InserterGraphics,
  InserterProto,
  ItemProto,
  MachineKind,
  MachineProto,
  ModuleProto,
  ProductProto,
  QualityName,
  RecipeProto,
  ShadowLayer,
  SpriteLayer,
} from "@factoriotools/engine";
import { loadLocale, localisedRecipeName, type LocaleTables } from "./locale.js";
import { buildRenderCatalog } from "./render-catalog.js";
import type { RenderCatalog } from "@factoriotools/engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMP_PATH =
  process.env.FACTORIO_DUMP ??
  path.join(
    process.env.HOME ?? "",
    "Library/Application Support/factorio/script-output/data-raw-dump.json",
  );
const FACTORIO_DATA_ROOT =
  process.env.FACTORIO_DATA ?? "/Applications/factorio.app/Contents/data";
const OUT_PATH = path.resolve(
  __dirname,
  "../../../apps/site/public/data/game-data.json",
);
const MANIFEST_OUT_PATH = path.resolve(
  __dirname,
  "../../../apps/site/public/data/sprite-source-manifest.json",
);
const RENDER_CATALOG_OUT_PATH = path.resolve(
  __dirname,
  "../../../apps/site/public/data/render-catalog.json",
);

/* ---------- raw data.raw shapes (only the fields we read) ---------- */

type Raw = Record<string, Record<string, any>>;

function loadDump(): Raw {
  const text = readFileSync(DUMP_PATH, "utf-8");
  return JSON.parse(text) as Raw;
}

/** Every prototype's `type` field is its table name; `data.raw` groups by
 *  that, and this pipeline only needs a subset of tables (see the project
 *  plan's B.4). */
const MACHINE_TABLES: { table: string; kind: MachineKind }[] = [
  { table: "assembling-machine", kind: "crafting" },
  { table: "furnace", kind: "crafting" },
  { table: "rocket-silo", kind: "crafting" },
  { table: "mining-drill", kind: "mining-drill" },
  { table: "lab", kind: "lab" },
  { table: "generator", kind: "generator" },
];

/** The +30%-per-tier bonus to module/machine speed and module effects is a
 *  fixed game-engine constant — confirmed absent from data.raw (checked
 *  utility-constants and every `quality` prototype directly), so it stays
 *  hardcoded here exactly as the original hand-written dataset had it. */
const QUALITY_MACHINE_SPEED: Record<QualityName, number> = {
  normal: 1,
  uncommon: 1.3,
  rare: 1.6,
  epic: 1.9,
  legendary: 2.5,
};
const QUALITY_MODULE_EFFECT = QUALITY_MACHINE_SPEED;

/** Chest-to-chest inserter throughput, items/second, no capacity research.
 *  Not in data.raw either (would need simulating the pickup/swing/drop
 *  rotation cycle from `rotation_speed`/`extension_speed`); measured values
 *  from the wiki, same numbers the ported prototype already used. */
const INSERTER_THROUGHPUT: Record<string, number> = {
  "burner-inserter": 0.79,
  inserter: 0.86,
  "long-handed-inserter": 1.25,
  "fast-inserter": 2.5,
  "bulk-inserter": 4.8,
  "stack-inserter": 15,
};

/** Lua can't distinguish an empty array from an empty map, so `--dump-data`
 *  serialises some empty tables (e.g. a couple of recipes' `ingredients`) as
 *  `{}` instead of `[]`. Confirmed present on "recipe-unknown"/"biter-egg". */
function asArray<T>(value: T[] | Record<string, never> | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Factorio's "energy value" fields are strings like "150kW" or "4MJ", not
 *  raw numbers (confirmed by inspecting the dump: assembling-machine-2's
 *  energy_usage is the string "150kW"). Watts and joules share the same unit
 *  prefixes; this engine only ever wants watts (an active power draw), which
 *  is what every energy_usage/drain field in the tables this pipeline reads
 *  represents. */
function parseEnergyValue(value: string | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return value;
  const match = /^([0-9.]+)\s*([kMGT]?)([WJ])$/.exec(value.trim());
  if (!match) return 0;
  const [, amount, prefix] = match;
  const scale = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[prefix!] ?? 1;
  return Number(amount) * scale;
}

function box(collisionBox: [[number, number], [number, number]] | undefined, fallback: [number, number]): [number, number] {
  if (!collisionBox) return fallback;
  const [[x1, y1], [x2, y2]] = collisionBox;
  return [Math.round((x2 - x1) * 100) / 100, Math.round((y2 - y1) * 100) / 100];
}

/** selection_box is the authoritative tile footprint (confirmed by spike:
 *  matches in-game rendered size, e.g. assembler -1.5..1.5 = 3x3), replacing
 *  the old hardcoded EXTRA_SIZES guess table entirely. */
function footprintOf(proto: any): [number, number] {
  return box(proto.selection_box, [1, 1]);
}

function energySourceOf(es: any): MachineProto["energySource"] {
  const type = es?.type;
  if (type === "electric") return "electric";
  if (type === "burner") return "burner";
  if (type === "fluid") return "fluid";
  if (type === "heat") return "heat";
  return "void";
}

/** Small, explicit per-kind graphics adapter, not a general graphics_set
 *  interpreter. Each entity kind's real dump shape was confirmed by
 *  spiking one representative entity before writing this, rather than
 *  guessed from Lua source. */
/** Confirmed by spike (assembling-machine-2): `frame_count`/`line_length`
 *  describe an animation-cycle grid — 32 frames at line_length 8 is 4 rows x
 *  8 columns, not 32 directions. Crafting machines don't visually rotate
 *  (their orientation is implied by pipes/inserters around them, not their
 *  own sprite), so `directionCount` is always 1 here; the renderer just
 *  picks frame (row 0, col 0) as the static preview frame. */
function graphicsForCraftingMachine(proto: any): EntityGraphics | undefined {
  // Labs have no graphics_set at all — their static art lives under
  // on_animation.layers directly (confirmed by spike against lab/biolab).
  // Centrifuge/electromagnetic-plant have a graphics_set but no `animation`
  // field within it — they use `idle_animation` instead (confirmed by
  // spike), a different key for the same "static preview frame" concept
  // this function already extracts from `animation` elsewhere. Generators
  // (steam-engine/steam-turbine) have no graphics_set at all either, and
  // key their sprite by physical orientation instead of a facing concept —
  // `horizontal_animation` is picked arbitrarily as the static preview,
  // matching this function's existing "one representative pose, not
  // rotation-accurate" simplification.
  const rawAnim = proto.graphics_set?.animation ?? proto.graphics_set?.idle_animation ?? proto.on_animation ?? proto.horizontal_animation;
  // A handful of machines (oil-refinery, chemical-plant, centrifuge, ... —
  // confirmed by spike) use a THIRD animation shape beyond the plain
  // {layers:[...]} and bare-sprite ones this function already handled: one
  // full, separate {layers:[...]} sub-animation per cardinal direction
  // (graphics_set.animation.{north,east,south,west}), because these
  // machines' art genuinely differs by facing (visible pipe/vent
  // placement), unlike the "doesn't visually rotate" assemblers this
  // function's own doc comment describes. Always takes the `north` variant
  // as the static preview frame — matching the "static pose, no live
  // rotation" simplification already used for the animation-cycle case —
  // rather than attempting to also thread facing-dependent art through
  // `directionCount` (a bigger change with no other entity kind needing
  // it right now).
  const anim = rawAnim?.north ?? rawAnim;
  const layers = anim?.layers ?? (anim ? [anim] : undefined);
  const main = layers?.find((l: any) => !l.draw_as_shadow) ?? layers?.[0];
  const shadow = layers?.find((l: any) => l.draw_as_shadow);
  // A handful of high-frame-count animations (foundry, biochamber, ... —
  // confirmed by spike) split their frames across multiple PNG files
  // (`filenames`/`lines_per_file`) instead of one `filename` sheet, since a
  // single file holding 128+ frames would be enormous. Only frame (0,0) is
  // ever drawn here (crafting machines don't visually rotate — see this
  // function's own doc comment), which always lives in the first file, so
  // taking filenames[0] as the sheet is exact for the static preview this
  // renders, not an approximation.
  const mainFile: string | undefined = main?.filename ?? main?.filenames?.[0];
  const shadowFile: string | undefined = shadow?.filename ?? shadow?.filenames?.[0];
  if (!mainFile) return undefined;
  const base: SpriteLayer = {
    sheet: mainFile,
    frameWidth: main.width,
    frameHeight: main.height,
    directionCount: 1,
    lineLength: main.line_length ?? main.frame_count ?? 1,
    shift: main.shift,
    scale: main.scale ?? 1,
  };
  const shadowLayer: ShadowLayer | undefined = shadowFile
    ? {
        sheet: shadowFile,
        frameWidth: shadow.width,
        frameHeight: shadow.height,
        scale: shadow.scale ?? 1,
        shift: shadow.shift,
      }
    : undefined;

  // Newer Space Age machines (electromagnetic-plant, confirmed by spike)
  // key their real main-body art through a working_visualisations state
  // machine instead of a plain animation/idle_animation layer: what
  // graphics_set.idle_animation/animation resolves to above is genuinely
  // just the base plate, with the actual body art living in whichever
  // working_visualisations entry has draw_in_states including "idle" —
  // that entry is always-present (not an active-crafting-only overlay)
  // even though it's declared alongside genuinely state-gated art in the
  // same array. Picking it up here means these machines get their real
  // static pose instead of rendering as a bare platform.
  const idleBodyLayer = extractIdleWorkingVisualisation(proto.graphics_set?.working_visualisations);
  if (idleBodyLayer) {
    return { kind: "layered-static", base, shadow: shadowLayer, layers: [idleBodyLayer] };
  }

  // Space Age mining drills (big-mining-drill, confirmed by spike — no
  // other prototype currently uses this exact shape) use a THIRD
  // working_visualisations convention: no draw_in_states field at all,
  // `always_draw: true` instead, and per-direction art under
  // `{north,east,south,west}_animation` rather than a single `animation`
  // key. What graphics_set.animation.north resolves to above (`base`) is
  // only the outer frame/legs — the drill head, support struts, wheels and
  // output chute are separate always_draw pieces (confirmed by spike:
  // rendering base alone left a large dark hole where the drill head
  // should be). Every always_draw entry's north_animation is stacked on
  // top, in their own declared order, EXCLUDING scorch-mark/particle decals
  // (matched by filename) which are transient effects this pipeline's
  // "static idle pose" convention has never modelled for any entity.
  const alwaysDrawLayers = extractAlwaysDrawLayers(proto.graphics_set?.working_visualisations, mainFile);
  if (alwaysDrawLayers.length > 0) {
    return { kind: "layered-static", base, shadow: shadowLayer, layers: alwaysDrawLayers };
  }

  return { kind: "sprite-4way", ...base, shadow: shadowLayer };
}

/** Rocket silo has no graphics_set at all — its real art is a multi-piece
 *  structure (base plate, launch-hole cutout, two independently-animated
 *  doors, a front plate, plus a rocket/flame/satellite state machine this
 *  pipeline doesn't model), so it's routed through its own mapper instead
 *  of graphicsForCraftingMachine. Modelled as LayeredStaticGraphics, layers
 *  stacked in the same back-to-front order the filenames' own numeric
 *  prefixes use (00-shadow, 01-hole, 04-door-back, 05-door-front, 06-base,
 *  14-front), always in their closed/idle resting pose — no open-doors/
 *  rocket-visible states. */
function graphicsForRocketSilo(proto: any): EntityGraphics | undefined {
  const layer = (sprite: any): SpriteLayer | undefined => {
    if (!sprite?.filename) return undefined;
    return { sheet: sprite.filename, frameWidth: sprite.width, frameHeight: sprite.height, shift: sprite.shift, scale: sprite.scale ?? 1 };
  };
  const base = layer(proto.base_day_sprite);
  if (!base) return undefined;
  const shadow = layer(proto.shadow_sprite);
  const layers = [layer(proto.hole_sprite), layer(proto.door_back_sprite), layer(proto.door_front_sprite), layer(proto.base_front_sprite)].filter(
    (l): l is SpriteLayer => l !== undefined,
  );
  return { kind: "layered-static", base, shadow, layers };
}

/** Finds the working_visualisations entry that's always drawn in the
 *  "idle" state (draw_in_states includes "idle") and extracts its
 *  animation as a plain SpriteLayer — the always-present main body for
 *  state-machine-animated machines (see graphicsForCraftingMachine's own
 *  doc comment above for why this exists and what confirmed it). Returns
 *  undefined for every ordinary machine, which has no
 *  working_visualisations at all. */
function extractIdleWorkingVisualisation(workingVisualisations: any[] | undefined): SpriteLayer | undefined {
  const idleEntry = workingVisualisations?.find((w) => Array.isArray(w.draw_in_states) && w.draw_in_states.includes("idle"));
  const anim = idleEntry?.animation;
  const layers = anim?.layers ?? (anim ? [anim] : undefined);
  const main = layers?.find((l: any) => !l.draw_as_shadow) ?? layers?.[0];
  const mainFile: string | undefined = main?.filename ?? main?.filenames?.[0];
  if (!mainFile) return undefined;
  return {
    sheet: mainFile,
    frameWidth: main.width,
    frameHeight: main.height,
    shift: main.shift,
    scale: main.scale ?? 1,
  };
}

/** Filename fragments that mark a working_visualisations entry as a
 *  transient effect (scorch marks, particle bursts) rather than a real
 *  always-visible structure piece — excluded from
 *  extractAlwaysDrawLayers' output since this pipeline has never modelled
 *  live animation/particle state for any entity, matching its existing
 *  "static idle pose" convention. */
const TRANSIENT_EFFECT_FILENAME = /scorchmark|scorch-mark|particles?\.png$/i;

/** Finds every working_visualisations entry marked `always_draw: true`
 *  (Space Age mining drills' own convention, distinct from
 *  electromagnetic-plant's draw_in_states that extractIdleWorkingVisualisation
 *  handles) and extracts each one's north-facing art as a SpriteLayer, in
 *  declared order — always the north variant, matching this pipeline's
 *  "static pose, no live rotation" simplification elsewhere. `baseSheet` is
 *  the file graphicsForCraftingMachine already picked as `base`; skipped
 *  here if an always_draw entry duplicates it (confirmed by spike
 *  big-mining-drill's own "still" body does exactly that). */
function extractAlwaysDrawLayers(workingVisualisations: any[] | undefined, baseSheet: string | undefined): SpriteLayer[] {
  const entries = workingVisualisations?.filter((w) => w.always_draw === true) ?? [];
  const result: SpriteLayer[] = [];
  for (const entry of entries) {
    const anim = entry.north_animation ?? entry.animation;
    const layers = anim?.layers ?? (anim ? [anim] : undefined);
    const main = layers?.find((l: any) => !l.draw_as_shadow) ?? layers?.[0];
    const mainFile: string | undefined = main?.filename ?? main?.filenames?.[0];
    if (!mainFile || mainFile === baseSheet || TRANSIENT_EFFECT_FILENAME.test(mainFile)) continue;
    result.push({
      sheet: mainFile,
      frameWidth: main.width,
      frameHeight: main.height,
      shift: main.shift,
      scale: main.scale ?? 1,
    });
  }
  return result;
}

function graphicsForBelt(proto: any): BeltGraphicsSet | undefined {
  const sheet = proto.belt_animation_set?.animation_set;
  if (!sheet?.filename) return undefined;
  // direction_count (confirmed 20 across every belt tier) indexes every
  // straight/curved/side-loading connection variant Factorio pre-renders
  // into one sheet as fixed rows — the renderer's beltGraph.ts picks the
  // row, it doesn't need to composite variants itself. frame_count (the
  // animation-cycle column count) varies by tier — confirmed 16/32/32/64
  // for yellow/red/blue/turbo — so it's read per-prototype, not assumed.
  return {
    sheet: sheet.filename as string,
    frameWidth: sheet.size ?? sheet.width,
    frameHeight: sheet.size ?? sheet.height,
    frameCount: sheet.frame_count ?? 1,
    scale: sheet.scale ?? 1,
  };
}

/* ---------- mapping ---------- */

function mapItems(raw: Raw, locale: LocaleTables): Record<string, ItemProto> {
  const items: Record<string, ItemProto> = {};
  for (const table of ["item", "item-with-entity-data", "module", "tool", "ammo", "capsule", "gun", "armor", "repair-tool", "rail-planner"]) {
    for (const proto of Object.values(raw[table] ?? {})) {
      items[proto.name] = {
        name: proto.name,
        kind: "item",
        stackSize: proto.stack_size,
        // 2.0's rocket silo mechanic (cargo_station_parameters) doesn't carry
        // a simple per-item launch capacity the way 1.1 did — left unset
        // until the rocket-cargo feature is revisited against the new system.
        localised: locale.itemName.get(proto.name) ?? proto.name,
      };
    }
  }
  for (const proto of Object.values(raw.fluid ?? {})) {
    items[proto.name] = {
      name: proto.name,
      kind: "fluid",
      localised: locale.fluidName.get(proto.name) ?? proto.name,
    };
  }
  return items;
}

function mapRecipes(raw: Raw, locale: LocaleTables): Record<string, RecipeProto> {
  const recipes: Record<string, RecipeProto> = {};
  for (const proto of Object.values(raw.recipe ?? {})) {
    const ingredients: IngredientProto[] = asArray(proto.ingredients).map((i: any) => ({
      name: i.name,
      amount: i.amount,
      ignoredByProductivity: i.ignored_by_productivity,
    }));
    const results: ProductProto[] = asArray(proto.results).map((r: any) => ({
      name: r.name,
      amount: r.amount ?? (r.amount_min !== undefined && r.amount_max !== undefined ? (r.amount_min + r.amount_max) / 2 : 1),
      probability: r.probability,
      ignoredByProductivity: r.ignored_by_productivity,
    }));
    if (results.length === 0) continue;

    recipes[proto.name] = {
      name: proto.name,
      category: proto.category ?? "crafting",
      // Factorio's own documented default when the field is absent.
      energyRequired: proto.energy_required ?? 0.5,
      ingredients,
      results,
      // JSON has no Infinity, so the "uncapped" case (the only one seen in
      // this dump — confirmed no vanilla recipe sets maximum_productivity)
      // is represented by omitting the field, matching how rates.ts already
      // reads it: `recipe.maximumProductivity ?? Infinity`.
      ...(proto.maximum_productivity !== undefined ? { maximumProductivity: proto.maximum_productivity } : {}),
      localised: localisedRecipeName(locale, proto.name, results[0]?.name),
    };
  }
  return recipes;
}

function mapMachines(raw: Raw, locale: LocaleTables): Record<string, MachineProto> {
  const machines: Record<string, MachineProto> = {};

  for (const { table, kind } of MACHINE_TABLES) {
    for (const proto of Object.values(raw[table] ?? {})) {
      const footprint = footprintOf(proto);
      const speed = proto.crafting_speed ?? proto.mining_speed ?? proto.researching_speed ?? 1;
      const categories: string[] =
        proto.crafting_categories ?? proto.resource_categories ?? (kind === "lab" ? ["lab"] : []);

      const machine: MachineProto = {
        name: proto.name,
        kind,
        speed,
        categories,
        moduleSlots: proto.module_slots ?? 0,
        allowedEffects: proto.allowed_effects,
        energyUsage: parseEnergyValue(proto.energy_usage),
        drain: proto.energy_source?.drain !== undefined ? parseEnergyValue(proto.energy_source.drain) : undefined,
        energySource: energySourceOf(proto.energy_source),
        size: footprint,
        tileFootprint: footprint,
        // Mining drills use graphics_set.animation.{north,...} — the same
        // per-direction shape graphicsForCraftingMachine now understands
        // (confirmed by spike; a previous version of this function only
        // handled the plain {layers:[...]} shape, which is why mining
        // drills were hard-excluded here entirely rather than rendering as
        // an outline). Rocket silo has no graphics_set at all — its own
        // graphicsForRocketSilo reads its real multi-piece structure
        // instead (see that function's own doc comment).
        graphics: table === "rocket-silo" ? graphicsForRocketSilo(proto) : graphicsForCraftingMachine(proto),
        siloParts: proto.rocket_parts_required,
        localised: locale.entityName.get(proto.name) ?? proto.name,
      };
      machines[proto.name] = machine;
    }
  }
  return machines;
}

function mapModules(raw: Raw, locale: LocaleTables): Record<string, ModuleProto> {
  const modules: Record<string, ModuleProto> = {};
  for (const proto of Object.values(raw.module ?? {})) {
    const eff = proto.effect ?? {};
    const effects: Partial<Effects> = {};
    for (const key of ["speed", "productivity", "consumption", "pollution", "quality"] as (keyof Effects)[]) {
      const v = eff[key];
      if (typeof v === "number" && v !== 0) effects[key] = v;
    }
    modules[proto.name] = {
      name: proto.name,
      effects,
      localised: locale.itemName.get(proto.name) ?? proto.name,
    };
  }
  return modules;
}

/** Beacons' graphics_set is a multi-layer animation_list: [0] the bottom
 *  pad, [1] a separate always-drawn top/spike piece, [2]/[3] the glowing
 *  light-effect layers — confirmed by spike neither [0] nor [1] alone is
 *  the whole beacon (rendering only [0], this function's previous
 *  behaviour, left the top spike missing entirely), while [2]/[3] are
 *  `always_draw: false` (only shown with modules active) and stay a
 *  deliberate simplification, not modeled. */
function graphicsForBeacon(proto: any): EntityGraphics | undefined {
  const animationList = proto.graphics_set?.animation_list;
  const bottom = animationList?.[0]?.animation;
  const layers = bottom?.layers ?? (bottom ? [bottom] : undefined);
  const main = layers?.find((l: any) => !l.draw_as_shadow) ?? layers?.[0];
  const shadow = layers?.find((l: any) => l.draw_as_shadow);
  if (!main?.filename) return undefined;

  const base: SpriteLayer = {
    sheet: main.filename,
    frameWidth: main.width,
    frameHeight: main.height,
    shift: main.shift,
    scale: main.scale ?? 1,
  };
  const shadowLayer: ShadowLayer | undefined = shadow?.filename
    ? {
        sheet: shadow.filename,
        frameWidth: shadow.width,
        frameHeight: shadow.height,
        scale: shadow.scale ?? 1,
        shift: shadow.shift,
      }
    : undefined;

  const top = animationList?.[1]?.animation;
  const topFile: string | undefined = top?.filename;
  const layersAbove: SpriteLayer[] = topFile
    ? [{ sheet: topFile, frameWidth: top.width, frameHeight: top.height, shift: top.shift, scale: top.scale ?? 1 }]
    : [];

  return { kind: "layered-static", base, shadow: shadowLayer, layers: layersAbove };
}

function mapBeacons(raw: Raw, locale: LocaleTables): Record<string, BeaconProto> {
  const beacons: Record<string, BeaconProto> = {};
  for (const proto of Object.values(raw.beacon ?? {})) {
    beacons[proto.name] = {
      name: proto.name,
      // Confirmed by spike: the dump's real field is `distribution_effectivity`,
      // not `distribution_effectiveness` (which the 1.1-era ported prototype
      // guessed at) — this is the exact fragile field the project README
      // flagged as needing verification against a live dump.
      distributionEffectiveness: proto.distribution_effectivity ?? 1,
      supplyAreaDistance: proto.supply_area_distance ?? 3,
      moduleSlots: proto.module_slots ?? 0,
      size: footprintOf(proto),
      profile: proto.profile,
      energyUsage: parseEnergyValue(proto.energy_usage),
      graphics: graphicsForBeacon(proto),
      localised: locale.entityName.get(proto.name) ?? proto.name,
    };
  }
  return beacons;
}

function mapBelts(raw: Raw, locale: LocaleTables): Record<string, BeltProto> {
  const belts: Record<string, BeltProto> = {};
  for (const proto of Object.values(raw["transport-belt"] ?? {})) {
    // speed is tiles/tick of item movement; throughput in items/second at one
    // item per lane slot is speed * 480 (confirmed against the well-known
    // yellow-belt constant: 0.03125 * 480 = 15 items/s).
    belts[proto.name] = {
      name: proto.name,
      throughput: (proto.speed ?? 0) * 480,
      graphics: graphicsForBelt(proto),
      localised: locale.entityName.get(proto.name) ?? proto.name,
    };
  }
  return belts;
}

/** Confirmed by spike: inserters have no direction-indexed sheet at all —
 *  platform_picture.sheet is one static plate sprite, hand_base_picture and
 *  hand_open_picture are separate static sprites for the arm's base segment
 *  and open claw. The renderer composites these into a fixed "hand extended
 *  toward the drop side" pose rather than the full pickup/swing/drop
 *  animation. */
function graphicsForInserter(proto: any): InserterGraphics | undefined {
  const platform = proto.platform_picture?.sheet;
  const handBase = proto.hand_base_picture;
  const handOpen = proto.hand_open_picture;
  if (!platform?.filename || !handBase?.filename || !handOpen?.filename) return undefined;
  return {
    platformSheet: platform.filename,
    platformWidth: platform.width,
    platformHeight: platform.height,
    platformScale: platform.scale ?? 1,
    // Confirmed by spike: no direction_count field is present on
    // platform_picture in the dump, but the real extracted PNG is 4x the
    // declared width (420px for a declared 105px frame) — Factorio defaults
    // inserter platform sprites to 4 facings.
    platformDirections: 4,
    handBaseSheet: handBase.filename,
    handBaseWidth: handBase.width,
    handBaseHeight: handBase.height,
    handBaseScale: handBase.scale ?? 1,
    handOpenSheet: handOpen.filename,
    handOpenWidth: handOpen.width,
    handOpenHeight: handOpen.height,
    handOpenScale: handOpen.scale ?? 1,
  };
}

function mapInserters(raw: Raw, locale: LocaleTables): Record<string, InserterProto> {
  const inserters: Record<string, InserterProto> = {};
  for (const proto of Object.values(raw.inserter ?? {})) {
    if (!(proto.name in INSERTER_THROUGHPUT)) continue;
    inserters[proto.name] = {
      name: proto.name,
      throughput: INSERTER_THROUGHPUT[proto.name]!,
      graphics: graphicsForInserter(proto),
      localised: locale.entityName.get(proto.name) ?? proto.name,
    };
  }
  return inserters;
}

/** Pulls every sheet filename out of one EntityGraphics value, regardless
 *  of which union variant it is (see types.ts's own doc comment on
 *  EntityGraphics for why this is a discriminated union, not one flat
 *  shape) — exhaustive over `kind` so a new variant added later fails to
 *  compile here instead of silently missing sprite files. */
function sheetsOf(graphics: EntityGraphics | undefined): string[] {
  if (!graphics) return [];
  switch (graphics.kind) {
    case "sprite-4way":
    case "static":
    case "belt":
    case "underground":
      return [graphics.sheet, ...(graphics.kind !== "belt" && graphics.kind !== "underground" && graphics.shadow ? [graphics.shadow.sheet] : [])];
    case "layered-static":
      return [graphics.base.sheet, ...(graphics.shadow ? [graphics.shadow.sheet] : []), ...graphics.layers.map((l) => l.sheet)];
    case "pipe":
      return Object.values(graphics.connectors).map((l) => l.sheet);
    case "splitter": {
      const dirs = [graphics.body.north, graphics.body.east, graphics.body.south, graphics.body.west];
      return [graphics.belt.sheet, ...dirs.map((d) => d.sheet), ...dirs.flatMap((d) => (d.structurePatch ? [d.structurePatch.sheet] : []))];
    }
    case "gate":
      return [graphics.sprites.north, graphics.sprites.east, graphics.shadows.north, graphics.shadows.east].map((l) => l.sheet);
    case "fusion-generator":
      return [
        graphics.sprites.north, graphics.sprites.east, graphics.sprites.south, graphics.sprites.west,
        graphics.shadows.north, graphics.shadows.east, graphics.shadows.south, graphics.shadows.west,
      ].map((l) => l.sheet);
    case "pipe-to-ground":
    case "valve":
      return [graphics.sprites.north, graphics.sprites.east, graphics.sprites.south, graphics.sprites.west].map((l) => l.sheet);
    case "wall": {
      const layers = [
        graphics.single, graphics.singleShadow,
        graphics.straightVertical, graphics.straightVerticalShadow,
        graphics.straightHorizontal, graphics.straightHorizontalShadow,
        graphics.cornerRight, graphics.cornerRightShadow,
        graphics.cornerLeft, graphics.cornerLeftShadow,
        graphics.t, graphics.tShadow,
        graphics.endingRight, graphics.endingRightShadow,
        graphics.endingLeft, graphics.endingLeftShadow,
      ];
      return layers.filter((l): l is SpriteLayer => l !== undefined).map((l) => l.sheet);
    }
    case "straight-rail": {
      const dirs = [graphics.north, graphics.northeast, graphics.east, graphics.southeast, graphics.south, graphics.southwest, graphics.west, graphics.northwest];
      return dirs.flatMap((d) => [d.stonePathBackground, d.stonePath, d.ties, d.backplates, d.metals]).map((l) => l.sheet);
    }
    case "none":
      return [];
  }
}

/** Every sprite filename referenced by the trimmed dataset, so
 *  extract-sprites.ts knows exactly which files to copy out of the game
 *  install without scanning the whole graphics tree. */
function collectSpriteFilenames(data: GameData, catalog: RenderCatalog): string[] {
  const files = new Set<string>();
  for (const m of Object.values(data.machines)) sheetsOf(m.graphics).forEach((f) => files.add(f));
  for (const beacon of Object.values(data.beacons)) sheetsOf(beacon.graphics).forEach((f) => files.add(f));
  for (const b of Object.values(data.belts)) {
    if (b.graphics?.sheet) files.add(b.graphics.sheet);
  }
  for (const ins of Object.values(data.inserters)) {
    if (ins.graphics) {
      files.add(ins.graphics.platformSheet);
      files.add(ins.graphics.handBaseSheet);
      files.add(ins.graphics.handOpenSheet);
    }
  }
  for (const e of Object.values(catalog.entities)) sheetsOf(e.graphics).forEach((f) => files.add(f));
  return [...files].sort();
}

function main() {
  console.log(`Reading dump: ${DUMP_PATH}`);
  const raw = loadDump();
  console.log(`Reading locale from: ${FACTORIO_DATA_ROOT}`);
  const locale = loadLocale(FACTORIO_DATA_ROOT);

  const items = mapItems(raw, locale);
  const recipes = mapRecipes(raw, locale);
  const machines = mapMachines(raw, locale);
  const modules = mapModules(raw, locale);
  const beacons = mapBeacons(raw, locale);
  const belts = mapBelts(raw, locale);
  const inserters = mapInserters(raw, locale);

  const data: GameData = {
    version: `factorio-dump ${raw.recipe ? "2.0.77" : "unknown"} (vanilla + space-age + quality + elevated-rails)`,
    items,
    recipes,
    machines,
    modules,
    beacons,
    belts,
    inserters,
    qualityMachineSpeed: QUALITY_MACHINE_SPEED,
    qualityModuleEffect: QUALITY_MODULE_EFFECT,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(data));
  console.log(`Wrote ${OUT_PATH} (${Object.keys(items).length} items, ${Object.keys(recipes).length} recipes, ${Object.keys(machines).length} machines)`);

  const catalog = buildRenderCatalog(raw, locale, data.version);
  writeFileSync(RENDER_CATALOG_OUT_PATH, JSON.stringify(catalog));
  console.log(`Wrote ${RENDER_CATALOG_OUT_PATH} (${Object.keys(catalog.entities).length} visual-only entities)`);

  const spriteFiles = collectSpriteFilenames(data, catalog);
  writeFileSync(MANIFEST_OUT_PATH, JSON.stringify({ dataRoot: FACTORIO_DATA_ROOT, files: spriteFiles }, null, 2));
  console.log(`Wrote ${MANIFEST_OUT_PATH} (${spriteFiles.length} sprite sheets referenced)`);
}

main();
