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
import { Layer } from "@factoriotools/engine";
import type {
  BeaconProto,
  BeltProto,
  Effects,
  EntityGraphics,
  GameData,
  GraphicsLayer,
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
  Sprite,
} from "@factoriotools/engine";
import { loadLocale, localisedRecipeName, type LocaleTables } from "./locale.js";
import { animationListGraphics, beltGraphics, directionColumnGraphics, sheetsOf, toSprite, unwrap, unwrapAll } from "./sprite-shapes.js";
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

/** Machine art hides behind several different keys depending on the
 *  prototype's age: newer ones use graphics_set, labs use on_animation,
 *  generators key theirs by physical orientation. */
const MACHINE_ANIMATION_KEYS = ["animation", "idle_animation"] as const;

function machineAnimation(proto: any): any {
  const gs = proto.graphics_set;
  for (const key of MACHINE_ANIMATION_KEYS) {
    if (gs?.[key]) return gs[key];
  }
  return proto.on_animation ?? proto.horizontal_animation;
}

const TRANSIENT_EFFECT_FILENAME = /scorchmark|scorch-mark|particles?\.png$/i;

const DIR4 = ["north", "east", "south", "west"] as const;

/** Some machines build their body from working_visualisations entries that
 *  are always on screen, rather than one main sprite: an "idle" state entry
 *  for electromagnetic-plant-likes, or several `always_draw` pieces for Space
 *  Age mining drills. Many of Space Age's mining-drill pieces (wheels,
 *  support, output chute, ...) declare a separate {north,east,south,west}
 *  _animation each, not one shared `animation` — reading only
 *  `north_animation` (as this used to) freezes those pieces to their
 *  north-facing art regardless of the entity's own direction, which reads as
 *  "the drill doesn't rotate" since these pieces are the visually dominant
 *  chassis. Returned as `per: "dir4"` when a piece is actually direction-
 *  split, or a plain sprite when it isn't (so a single-direction piece still
 *  renders — better than dropping it for lack of the other 3 facings). */
function alwaysDrawnPieces(workingVisualisations: any[] | undefined, baseSheet: string | undefined): GraphicsLayer[] {
  // Two ordering quirks the renderer's own paint order (layer, then each
  // command's y-shift, and only THEN array declaration order — see
  // compareDrawCommands in draw/commands.ts) won't get right by array
  // position alone, since these pieces all share Layer.Object and their
  // differing shiftY values would otherwise decide the outcome instead:
  //  - electric-mining-drill's own rotating arm/head assembly (declared for
  //    every facing) must draw OVER its east/south/west-only ore-chute
  //    overlay — confirmed against the real game — so it's promoted a whole
  //    layer, to Layer.AboveObject.
  //  - a piece named "*-front.*" (electric-mining-drill's own -front.png
  //    pieces, Factorio's own naming for "goes in front of everything else
  //    here") goes a layer above even that, on Layer.AboveObject pushed
  //    after the arm/head, so it wins the y-tiebreak against it too.
  const full: GraphicsLayer[] = [];
  const partial: GraphicsLayer[] = [];
  const top: GraphicsLayer[] = [];
  const isFrontPiece = (sprites: Partial<Record<(typeof DIR4)[number], Sprite>> | Sprite): boolean => {
    const sprite = "sheet" in sprites ? sprites : (sprites.north ?? sprites.east ?? sprites.south ?? sprites.west);
    return /-front\.[^/]+$/.test(sprite?.sheet ?? "");
  };
  for (const entry of workingVisualisations ?? []) {
    // `always_draw` means "draw whenever this entry's own state is active",
    // not "draw regardless of state" — a machine with idle/warm-up/working/
    // cool-down sub-animations (electromagnetic-plant and friends) marks
    // several of those `always_draw: true`, one per state, and Factorio only
    // shows whichever one matches the machine's current state. A blueprint
    // renders the idle pose, so any entry naming OTHER states via
    // draw_in_states must be skipped, or every state's art (including ones
    // whose own layers happen to be a shadow) gets stacked into one frame.
    // An entry with no draw_in_states at all (the mining-drill chassis
    // pieces this function was written for) has no state to filter on and
    // is always drawn, matching the prior behaviour for that shape.
    const states: string[] | undefined = entry.draw_in_states;
    if (Array.isArray(states) && !states.includes("idle")) continue;
    if (!Array.isArray(states) && entry.always_draw !== true) continue;

    if (DIR4.some((d) => entry[`${d}_animation`])) {
      // A direction's own `{dir}_animation` can hold more than one non-
      // shadow sub-layer (electric-mining-drill's south chute is
      // output.png UNDER front.png, east/west have only the one) — zipped
      // into separate slots by position within that direction's own list,
      // so a second sub-layer still gets its own GraphicsLayer instead of
      // being silently dropped by unwrap()'s "first match only" pick.
      const slots: Partial<Record<(typeof DIR4)[number], Sprite>>[] = [];
      for (const d of DIR4) {
        const source = entry[`${d}_animation`] ?? entry.animation;
        unwrapAll(source)
          .filter((l) => !l.shadow)
          .forEach((l, i) => {
            (slots[i] ??= {})[d] = l.sprite;
          });
      }
      const anyMain = slots[0]?.north ?? slots[0]?.east ?? slots[0]?.south ?? slots[0]?.west;
      if (!anyMain || anyMain.sheet === baseSheet || TRANSIENT_EFFECT_FILENAME.test(anyMain.sheet)) continue;
      // Some pieces (electric-mining-drill's east/south/west-only ore-chute
      // overlay) never had north art to begin with — Factorio simply doesn't
      // draw that piece facing north, not "art is missing". Pushed as a
      // partial dir4 record rather than requiring every facing, so it still
      // renders for the facings it does have instead of being dropped
      // everywhere for lack of the other one/two.
      const isFull = DIR4.every((d) => slots[0]?.[d]);
      for (const sprites of slots) {
        if (isFrontPiece(sprites)) top.push({ layer: Layer.AboveObject, sprites, per: "dir4" });
        else if (isFull) full.push({ layer: Layer.AboveObject, sprites, per: "dir4" });
        else partial.push({ layer: Layer.Object, sprites, per: "dir4" });
      }
      continue;
    }

    const { main } = unwrap(entry.north_animation ?? entry.animation);
    if (!main || main.sheet === baseSheet || TRANSIENT_EFFECT_FILENAME.test(main.sheet)) continue;
    (isFrontPiece(main) ? top : full).push({ layer: Layer.AboveObject, sprites: main });
  }
  return [...partial, ...full, ...top];
}

/** pumpjack's own rotating baseplate (the pipe-connector piece its horsehead
 *  pump sits on) — a `base_picture` field the rest of graphicsForMachine
 *  never reads (it only looks at graphics_set's animation/idle_animation,
 *  which for pumpjack is the north-only horsehead pump itself; the pump's
 *  motion doesn't need to visually rotate, but the baseplate's pipe stub
 *  does). Declared as one plain {width,height} sheet with no direction_count
 *  of its own, but confirmed against the real file — both it and its shadow
 *  are physically 4 frames wide (N,E,S,W in that column order) — Factorio
 *  apparently defaults an entity's own direction count (4, no diagonals
 *  declared) onto a field like this with no count of its own.
 *
 *  Its object piece goes on Layer.LowerObject rather than sharing the
 *  horsehead's Layer.Object: paint order sorts by layer first and each
 *  sprite's own y-shift only second (compareDrawCommands in
 *  draw/commands.ts), and the baseplate's shift (-0.148) is less negative
 *  than the horsehead's (-0.75) — same layer, it would win the y-sort and
 *  cover the pump it's meant to sit under, regardless of array order. */
function pumpjackBaseGraphics(proto: any): GraphicsLayer[] {
  const bp = proto.base_picture;
  if (!bp) return [];
  const layers: GraphicsLayer[] = [];
  for (const raw of unwrapAll(bp)) {
    const sprites = {} as Record<(typeof DIR4)[number], Sprite>;
    DIR4.forEach((d, i) => {
      sprites[d] = { ...raw.sprite, x: (raw.sprite.x ?? 0) + i * raw.sprite.frameWidth };
    });
    layers.push({ layer: raw.shadow ? Layer.Shadow : Layer.LowerObject, sprites, per: "dir4" });
  }
  return layers;
}

function graphicsForMachine(proto: any): EntityGraphics | undefined {
  const graphics = directionColumnGraphics(machineAnimation(proto));
  if (!graphics) return undefined;

  const body = graphics.layers[graphics.layers.length - 1]!;
  const baseSheet = "per" in body ? undefined : body.sprites.sheet;
  graphics.layers.unshift(...pumpjackBaseGraphics(proto));
  graphics.layers.push(...alwaysDrawnPieces(proto.graphics_set?.working_visualisations, baseSheet));
  return graphics;
}

/** The rocket silo's pieces are numbered by draw order in their filenames;
 *  they are stacked in their closed resting pose. */
const ROCKET_SILO_PIECES = ["shadow_sprite", "hole_sprite", "door_back_sprite", "door_front_sprite", "base_day_sprite", "base_front_sprite"];

function graphicsForRocketSilo(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const key of ROCKET_SILO_PIECES) {
    const sprite = toSprite(proto[key]);
    if (!sprite) continue;
    layers.push({ layer: key === "shadow_sprite" ? Layer.Shadow : Layer.Object, sprites: sprite });
  }
  return layers.length > 0 ? { layers } : undefined;
}

function graphicsForBeacon(proto: any): EntityGraphics | undefined {
  return animationListGraphics(proto.graphics_set?.animation_list) ?? graphicsForMachine(proto);
}


function graphicsForBelt(proto: any): EntityGraphics | undefined {
  return beltGraphics(proto.belt_animation_set);
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
        graphics: table === "rocket-silo" ? graphicsForRocketSilo(proto) : graphicsForMachine(proto),
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

/** Inserters composite a platform plate with a hand that the renderer rotates,
 *  rather than shipping a direction-indexed sheet. */
function graphicsForInserter(proto: any): InserterGraphics | undefined {
  const platform = toSprite(proto.platform_picture?.sheet);
  const handBase = toSprite(proto.hand_base_picture);
  const handOpen = toSprite(proto.hand_open_picture);
  if (!platform || !handBase || !handOpen) return undefined;
  return { platform, platformDirections: 4, handBase, handOpen };
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


/** Every sprite filename referenced by the trimmed dataset, so
 *  extract-sprites.ts knows exactly which files to copy out of the game
 *  install without scanning the whole graphics tree. */
function collectSpriteFilenames(data: GameData, catalog: RenderCatalog): string[] {
  const files = new Set<string>();
  for (const m of Object.values(data.machines)) sheetsOf(m.graphics).forEach((f) => files.add(f));
  for (const beacon of Object.values(data.beacons)) sheetsOf(beacon.graphics).forEach((f) => files.add(f));
  for (const b of Object.values(data.belts)) sheetsOf(b.graphics).forEach((f) => files.add(f));
  for (const ins of Object.values(data.inserters)) {
    if (ins.graphics) {
      files.add(ins.graphics.platform.sheet);
      files.add(ins.graphics.handBase.sheet);
      files.add(ins.graphics.handOpen.sheet);
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
