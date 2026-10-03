/** Pulls everything map generation needs out of the game's `--dump-data`
 *  output into `mapgen-data.json`: the named noise expressions and functions,
 *  the autoplace rule of every tile and entity, and each planet's map-gen
 *  settings. `packages/mapgen` compiles and evaluates these; nothing about a
 *  planet is hard-coded there, so a modded dump works the same way. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMP_PATH =
  process.env.FACTORIO_DUMP ??
  path.join(process.env.HOME ?? "", "Library/Application Support/factorio/script-output/data-raw-dump.json");
const FACTORIO_DATA_ROOT = process.env.FACTORIO_DATA ?? "/Applications/factorio.app/Contents/data";
/** One file per game version, and an index the Seed Viewer lists them from. */
const OUT_DIR = path.resolve(__dirname, "../../../apps/site/public/data/mapgen");

type Json = Record<string, any>;

/** The dump writes an empty Lua table as `{}`; treat that as "absent". */
function table(v: unknown): Json | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.keys(v).length ? (v as Json) : undefined;
}

/** Map colours come as 0-1 or 0-255, with or without keys. */
function rgb(c: unknown): [number, number, number] | undefined {
  if (!c || typeof c !== "object") return undefined;
  const o = c as Json;
  const parts = Array.isArray(c) ? c.slice(0, 3) : [o.r, o.g, o.b];
  if (parts.some((v) => typeof v !== "number")) return undefined;
  const scale = parts.every((v) => v <= 1) ? 255 : 1;
  return parts.map((v) => Math.round(v * scale)) as [number, number, number];
}

/** Where the freeplay scenario puts the crashed ship, relative to spawn
 *  (`base/script/freeplay/freeplay.lua`). The dump does not carry scripts. */
const CRASH_SITE: [number, number] = [-5, -6];
/** The ship's sprite is far larger than a map marker needs. */
const MARKER_SHRINK = 4;

/** Shrink an RGBA image by a whole factor, averaging in premultiplied alpha
 *  so transparent pixels do not darken the edges. */
function shrink(src: PNG, factor: number): PNG {
  const out = new PNG({ width: Math.floor(src.width / factor), height: Math.floor(src.height / factor) });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.width + x * factor + dx) * 4;
          const alpha = src.data[i + 3]!;
          r += src.data[i]! * alpha;
          g += src.data[i + 1]! * alpha;
          b += src.data[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (y * out.width + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round(a / (factor * factor));
    }
  }
  return out;
}

/** Copy the crashed ship's sprite for the Seed Viewer's spawn marker and
 *  describe where it sits in the world, in tiles. */
function spawnMarker(raw: Record<string, Record<string, Json>>): Json | undefined {
  const layers: Json[] = raw.container?.["crash-site-spaceship"]?.picture?.layers ?? [];
  const layer = layers.find((l) => !l.draw_as_shadow && typeof l.filename === "string");
  if (!layer) return undefined;
  const [, mod, rest] = /^__(.+?)__\/(.+)$/.exec(layer.filename as string) ?? [];
  if (!mod || !rest) return undefined;
  const small = shrink(PNG.sync.read(readFileSync(path.join(FACTORIO_DATA_ROOT, mod, rest))), MARKER_SHRINK);
  const file = "crash-site-spaceship.png";
  writeFileSync(path.join(OUT_DIR, file), PNG.sync.write(small));
  // A sprite pixel is 1/32 of a tile at scale 1.
  const tilesPerPixel = ((layer.scale as number | undefined) ?? 1) / 32;
  const shift = (layer.shift as [number, number] | undefined) ?? [0, 0];
  return {
    file,
    x: CRASH_SITE[0] + shift[0],
    y: CRASH_SITE[1] + shift[1],
    width: small.width * MARKER_SHRINK * tilesPerPixel,
    height: small.height * MARKER_SHRINK * tilesPerPixel,
  };
}

function main(): void {
  console.log(`Reading dump from: ${DUMP_PATH}`);
  const raw = JSON.parse(readFileSync(DUMP_PATH, "utf8")) as Record<string, Record<string, Json>>;

  const expressions: Json = {};
  for (const [name, p] of Object.entries(raw["noise-expression"] ?? {})) {
    expressions[name] = {
      expression: p.expression,
      local_expressions: table(p.local_expressions),
      local_functions: table(p.local_functions),
    };
  }

  const functions: Json = {};
  for (const [name, p] of Object.entries(raw["noise-function"] ?? {})) {
    functions[name] = {
      parameters: Array.isArray(p.parameters) ? p.parameters : [],
      expression: p.expression,
      local_expressions: table(p.local_expressions),
      local_functions: table(p.local_functions),
    };
  }

  // Decoratives are left out: the viewer does not draw them and they are
  // more than half of all autoplace rules.
  const autoplace: Json = { tile: {}, entity: {} };
  for (const [type, protos] of Object.entries(raw)) {
    if (type === "optimized-decorative") continue;
    for (const [name, p] of Object.entries(protos)) {
      const a = table(p?.autoplace);
      if (!a) continue;
      autoplace[type === "tile" ? "tile" : "entity"][name] = {
        type,
        probability_expression: a.probability_expression,
        richness_expression: a.richness_expression,
        local_expressions: table(a.local_expressions),
        local_functions: table(a.local_functions),
        control: a.control,
        order: a.order,
        map_color: rgb(p.map_color),
        // What the placement simulation needs: the footprint that must stay
        // free, and whether the entity lands anywhere within its tile (two
        // extra random draws) or snaps to it.
        collision_box: Array.isArray(p.collision_box) ? p.collision_box : undefined,
        off_grid: Array.isArray(p.flags) && p.flags.includes("placeable-off-grid") ? true : undefined,
        // Resources only: an infinite one (oil) reports its amount as a
        // yield, `normal` being 100%.
        infinite: p.infinite === true ? true : undefined,
        normal: typeof p.normal === "number" ? p.normal : undefined,
      };
    }
  }

  // Cliffs are not autoplaced like other entities: the planet's cliff
  // settings name a prototype, and the game lays its pieces along contour
  // lines. The viewer needs each piece's footprint to know where ore
  // displaces it.
  const cliffs: Json = {};
  for (const [name, p] of Object.entries(raw.cliff ?? {})) {
    const orientations: Json = {};
    for (const [orientation, o] of Object.entries((p.orientations ?? {}) as Record<string, Json>)) {
      orientations[orientation.replace(/_/g, "-")] = o.collision_bounding_box;
    }
    cliffs[name] = { map_color: rgb(p.map_color), grid_size: p.grid_size, grid_offset: p.grid_offset, orientations };
  }

  const planets: Json = {};
  for (const [name, p] of Object.entries(raw.planet ?? {})) {
    if (table(p.map_gen_settings)) planets[name] = { map_gen_settings: p.map_gen_settings, order: p.order };
  }

  const controls: Json = {};
  for (const [name, p] of Object.entries(raw["autoplace-control"] ?? {})) {
    controls[name] = { category: p.category, richness: p.richness, can_be_disabled: p.can_be_disabled, order: p.order };
  }

  const chart = raw["utility-constants"]?.default?.chart ?? {};
  const colors = { tree: rgb(chart.default_color_by_type?.tree), enemy: rgb(chart.default_enemy_color) };

  // The map generator's presets, minus the entries that are not presets.
  const presets: Json = {};
  for (const [name, p] of Object.entries((raw["map-gen-presets"]?.default ?? {}) as Record<string, Json>)) {
    if (p && typeof p === "object" && typeof p.order === "string") presets[name] = { order: p.order, default: p.default, basic_settings: table(p.basic_settings) };
  }
  // What the game offers under "map type": expressions meant for elevation.
  const mapTypes = Object.entries(raw["noise-expression"] ?? {}).filter(([, p]) => p.intended_property === "elevation").map(([name]) => name);

  // The dump does not say which game wrote it; the install it came from does.
  const version: string = JSON.parse(readFileSync(path.join(FACTORIO_DATA_ROOT, "base/info.json"), "utf8")).version;
  const spaceAge = raw.planet?.vulcanus !== undefined;
  const id = `${version}${spaceAge ? "-space-age" : ""}`;

  mkdirSync(OUT_DIR, { recursive: true });
  const marker = spawnMarker(raw);
  const data = { version, spaceAge, expressions, functions, autoplace, cliffs, planets, controls, colors, presets, mapTypes, spawnMarker: marker };
  const json = JSON.stringify(data);
  const OUT_PATH = path.join(OUT_DIR, `${id}.json`);
  writeFileSync(OUT_PATH, json);

  // Newest version first; it is the one the viewer opens with.
  const indexPath = path.join(OUT_DIR, "index.json");
  type Entry = { id: string; version: string; spaceAge: boolean; file: string };
  let index: Entry[] = [];
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8")) as Entry[];
  } catch {
    // First run.
  }
  index = index.filter((e) => e.id !== id);
  index.push({ id, version, spaceAge, file: `${id}.json` });
  const key = (e: Entry): number[] => [...e.version.split(".").map(Number), e.spaceAge ? 1 : 0];
  index.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
    return 0;
  });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

  console.log(
    `Wrote ${OUT_PATH} (${(json.length / 1024).toFixed(0)} KB): ${Object.keys(expressions).length} expressions, ` +
      `${Object.keys(functions).length} functions, ${Object.keys(autoplace.tile).length} tiles, ` +
      `${Object.keys(autoplace.entity).length} entities, ${Object.keys(planets).length} planets`,
  );
}

main();
