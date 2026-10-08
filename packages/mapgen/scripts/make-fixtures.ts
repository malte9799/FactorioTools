/** Records what the real game computes, for `test/mapgen.test.ts` to hold the
 *  implementation to. Needs a Factorio install; the tests do not.
 *
 *    npm run make-fixtures --workspace=@factoriotools/mapgen
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { MapGenData, MapGenOptions } from "../src/index.js";
import { queryEntities, queryOracle, queryTerritories } from "./oracle.js";
import { loadDataset } from "../test/dataset.js";

const ROOT = path.join(import.meta.dirname, "..");
const data: MapGenData = loadDataset();

export interface Fixture {
  seed: number;
  /** Planet the values are from; Nauvis when absent. */
  planet?: string;
  /** One of the game's presets, applied to Nauvis for this run. */
  preset?: string;
  /** Settings the map was created with (the game's `--map-gen-settings`),
   *  and the same thing as options for this package. */
  mapGenSettings?: Record<string, unknown>;
  options?: Partial<MapGenOptions>;
  /** Extra noise expressions the game was given for this run. */
  define: Record<string, string>;
  positions: [number, number][];
  /** name -> base64 of the float32 values, one per position. */
  values: Record<string, string>;
}

/** Deterministic scatter of integer tile positions. */
function positions(count: number, spread: number, salt: number): [number, number][] {
  const out: [number, number][] = [];
  let s = salt;
  const rand = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) out.push([Math.round((rand() - 0.5) * spread), Math.round((rand() - 0.5) * spread)]);
  return out;
}

/** Lua that applies one of the game's presets to Nauvis in the data stage.
 *  The planet prototype carries neither a starting area nor a map size, so
 *  those two parts of a preset are not exercised. */
const applyPreset = (preset: string): string => `
local preset = data.raw["map-gen-presets"].default["${preset}"].basic_settings or {}
local mgs = data.raw.planet.nauvis.map_gen_settings
for k, v in pairs(preset.autoplace_controls or {}) do mgs.autoplace_controls[k] = v end
mgs.property_expression_names = mgs.property_expression_names or {}
for k, v in pairs(preset.property_expression_names or {}) do mgs.property_expression_names[k] = v end
for k, v in pairs(preset.cliff_settings or {}) do mgs.cliff_settings[k] = v end
`;

/** `npm run make-fixtures -- <text>` records only the files whose name
 *  contains the text. */
const only = process.argv[2];
const wanted = (file: string): boolean => !only || file.includes(only);

interface Custom {
  mapGenSettings: Record<string, unknown>;
  options: Partial<MapGenOptions>;
}

function record(file: string, seed: number, names: string[], define: Record<string, string>, pos: [number, number][], preset?: string, planet?: string, custom?: Custom): void {
  if (!wanted(file)) return;
  const game = queryOracle({ seed, names, positions: pos, define, planet, finalFixesLua: preset ? applyPreset(preset) : undefined, mapGenSettings: custom?.mapGenSettings });
  const values: Record<string, string> = {};
  for (const name of names) {
    const v = game[name];
    // The game drops a rule it does not use on this surface (a tile listed
    // in the planet's settings but never generated); so does the fixture.
    if (!v && planet) continue;
    if (!v) throw new Error(`the game did not return '${name}'`);
    values[name] = Buffer.from(Float32Array.from(v).buffer).toString("base64");
  }
  const fixture: Fixture = { seed, preset, planet, ...custom, define, positions: pos, values };
  writeFileSync(path.join(ROOT, "test/fixtures", file), JSON.stringify(fixture));
  console.log(`${file}: ${Object.keys(values).length} expressions x ${pos.length} positions`);
}

/** Each built-in on its own, so a failure names the culprit. */
const PRIMITIVES: Record<string, string> = {
  t_basis: "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 7, input_scale = 1/8, output_scale = 1}",
  t_basis_offset: "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 200, input_scale = 1/24, output_scale = 3, offset_x = 1000, offset_y = -37}",
  t_basis_wide_seed1: "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 900, input_scale = 1/13}",
  t_multioctave: "multioctave_noise{x = x, y = y, persistence = 0.75, seed0 = map_seed, seed1 = 3, octaves = 4, input_scale = 1/32, output_scale = 2}",
  t_multioctave_offset: "multioctave_noise{x = x, y = y, persistence = 0.6, seed0 = map_seed, seed1 = 1000, octaves = 2, input_scale = 1/100, offset_x = 500, offset_y = 77}",
  t_multioctave_flat: "multioctave_noise{x = x, y = y, persistence = 1, seed0 = map_seed, seed1 = 5, octaves = 3, input_scale = 1/20}",
  t_variable_persistence:
    "variable_persistence_multioctave_noise{x = x, y = y, persistence = clamp(0.5 + x / 4000, 0.1, 0.9), seed0 = map_seed, seed1 = 600, octaves = 5, input_scale = 1/14, output_scale = 0.03, offset_x = 6666}",
  t_quick:
    "quick_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = 14, octaves = 4, input_scale = 1/64, output_scale = 8, octave_input_scale_multiplier = 2, octave_output_scale_multiplier = 0.68}",
  t_penalty: "random_penalty{x = x, y = y, seed = 5, source = 10, amplitude = 4}",
  t_penalty_signed: "random_penalty{x = x, y = y, seed = 1, source = x / 100, amplitude = 3}",
  t_pow: "(abs(x) + 1.5) ^ 0.37",
  t_pow_integer: "(x / 7) ^ 3",
  t_pow_constant: "x * 0 + 2 ^ 0.37",
  t_log2: "log2(abs(x) + 0.3)",
  t_sin: "sin(x / 5 + y / 11)",
  t_cos: "cos(x / 5 + y / 11)",
  t_sqrt: "sqrt(abs(x * y) + 0.1)",
  t_modulo: "(x * 1.3) % 7",
  t_remainder: "(x * 1.3) %% 7",
  t_compare: "(x > y) + 2 * (x <= 10) + 4 * (y == 53) + 8 * (x ~= 37)",
  t_if: "if(x - 20, x / 3, y / 3)",
  t_clamp: "clamp(x / 50, -1.5, 2.25)",
  t_fold_float: "x * 0 + (1/7 + 1/9) * 1000",
  t_range: "expression_in_range(20, 1, x / 300, y / 300, 0.4, -10, 0.45, 0.25)",
  t_spot_soft:
    "spot_noise{x = x, y = y, density_expression = 0.3, spot_quantity_expression = 5000, spot_radius_expression = 20, spot_favorability_expression = 1, seed0 = map_seed, seed1 = 77, region_size = 256, candidate_spot_count = 8, suggested_minimum_candidate_point_spacing = 30, hard_region_target_quantity = 0, basement_value = -50, maximum_spot_basement_radius = 64}",
  // Voronoi: every output, every distance, and a jitter on each side of
  // where the boundary search widens.
  ...Object.fromEntries(
    ["spot_noise", "facet_noise", "pyramid_noise", "cell_id"].flatMap((kind) =>
      ["chebyshev", "manhattan", "euclidean", "minkowski3"]
        .filter((type) => !(kind === "pyramid_noise" && type === "minkowski3"))
        .flatMap((type) =>
          ([[1, 16], [0.2, 7]] as const).map(([jitter, grid]) => [
            `t_voronoi_${kind}_${type}_${grid}`,
            `voronoi_${kind}{x = x + y / 7, y = y * 0.8, seed0 = map_seed, seed1 = 'abc', grid_size = ${grid}, distance_type = '${type}', jitter = ${jitter}}`,
          ]),
        ),
    ),
  ),
  t_spot_hard:
    "spot_noise{x = x, y = y, density_expression = 0.2, spot_quantity_expression = 3000 + x, spot_radius_expression = 11.3 + y / 100, spot_favorability_expression = x, seed0 = map_seed, seed1 = 5, region_size = 256, candidate_point_count = 20, skip_span = 2, skip_offset = 1, hard_region_target_quantity = 1, basement_value = -7, maximum_spot_basement_radius = 40}",
};

/** Every tile, resource, tree and enemy rule Nauvis generates with. */
function nauvis(): { names: string[]; define: Record<string, string> } {
  const mgs = data.planets.nauvis!.map_gen_settings;
  const define: Record<string, string> = {};
  const names = ["elevation", "moisture", "aux", "temperature", "cliffiness", "cliff_elevation", "enemy_base_probability"];
  const add = (kind: string, n: string, what: string): void => {
    const name = `t_${kind}_${n.replace(/-/g, "_")}_${what}`;
    define[name] = `var('${kind}:${n}:${what}')`;
    names.push(name);
  };
  for (const n of Object.keys(mgs.autoplace_settings.tile.settings)) add("tile", n, "probability");
  for (const n of Object.keys(mgs.autoplace_settings.entity.settings)) add("entity", n, "probability");
  for (const [n, a] of Object.entries(data.autoplace.entity)) {
    if (a.control === "enemy-base" || a.control === "trees") add("entity", n, "probability");
    if (a.type === "resource" && mgs.autoplace_settings.entity.settings[n]) add("entity", n, "richness");
  }
  return { names, define };
}

record("primitives-123.json", 123, Object.keys(PRIMITIVES), PRIMITIVES, positions(300, 400, 1));
const n = nauvis();
// Near spawn (starting patches, starting lake) and far out, on an ordinary
// seed and on one above 2^31, which a float cannot hold exactly.
record("nauvis-123.json", 123, n.names, n.define, [...positions(90, 320, 2), ...positions(110, 6000, 3)]);
record("nauvis-2718281828.json", 2718281828, n.names, n.define, [...positions(90, 320, 4), ...positions(110, 6000, 5)]);

// Presets: sliders (rail world, ribbon world's cliff control) and a different
// map type (island). A subset of the expressions is enough to show the
// settings reach them.
const key = n.names.filter((name) => /^(elevation|moisture|aux|cliffiness|cliff_elevation|enemy_base_probability)$|water|grass_1|iron_ore|crude_oil|spawner|tree_01/.test(name));
const keyDefine = Object.fromEntries(Object.entries(n.define).filter(([name]) => key.includes(name)));
for (const preset of ["rail-world", "ribbon-world", "island"]) {
  record(`nauvis-${preset}-123.json`, 123, key, keyDefine, [...positions(50, 320, 6), ...positions(70, 6000, 7)], preset);
}

// Settings no preset uses, given to the game as a map-gen-settings file:
// sliders at both ends of their range, a disabled resource, the starting
// area, the climate sliders, cliff settings and a bounded map.
const constants = ["starting_area_radius", "map_width", "map_height", "cliff_elevation_0", "cliff_elevation_interval", "cliff_richness"];
const settingsDefine = { ...n.define, ...Object.fromEntries(constants.map((name) => [`t_${name}`, `var('${name}')`])) };
const settingsNames = [...n.names, ...constants.map((name) => `t_${name}`)];
const sliders = {
  "iron-ore": { frequency: 6, size: 0.17, richness: 3 },
  "copper-ore": { frequency: 0.17, size: 6, richness: 0.5 },
  coal: { size: 0 },
  "crude-oil": { frequency: 2, size: 2, richness: 6 },
  water: { frequency: 0.25, size: 4 },
  trees: { frequency: 3, size: 0.33 },
  rocks: { frequency: 2, size: 2 },
  "enemy-base": { frequency: 6, size: 6 },
  starting_area_moisture: { frequency: 2, size: 3 },
  nauvis_cliff: { frequency: 4, size: 6 },
};
record("nauvis-settings-sliders-123.json", 123, settingsNames, settingsDefine, [...positions(50, 500, 10), ...positions(50, 6000, 11)], undefined, undefined, {
  mapGenSettings: { starting_area: 0.5, autoplace_controls: sliders },
  options: { startingArea: 0.5, controls: sliders },
});
record("nauvis-settings-terrain-123.json", 123, settingsNames, settingsDefine, [...positions(50, 500, 12), ...positions(50, 6000, 13)], undefined, undefined, {
  mapGenSettings: {
    starting_area: 2,
    width: 3000,
    height: 500,
    cliff_settings: { name: "cliff", control: "nauvis_cliff", cliff_elevation_0: 20, cliff_elevation_interval: 25, richness: 0.6, cliff_smoothing: 0 },
    property_expression_names: {
      elevation: "elevation_island",
      "control:moisture:frequency": "2",
      "control:moisture:bias": "0.25",
      "control:aux:frequency": "0.5",
      "control:aux:bias": "-0.3",
    },
  },
  options: {
    startingArea: 2,
    width: 3000,
    height: 500,
    cliffs: { elevation0: 20, interval: 25, richness: 0.6 },
    propertyExpressionNames: { elevation: "elevation_island" },
    climate: { moisture: { frequency: 2, bias: 0.25 }, aux: { frequency: 0.5, bias: -0.3 } },
  },
});

/** Every tile and entity rule of another planet. */
function planetNames(planet: string): { names: string[]; define: Record<string, string> } {
  const mgs = data.planets[planet]!.map_gen_settings;
  const define: Record<string, string> = {};
  const names = ["elevation", "moisture", "aux", "temperature"];
  const add = (kind: string, n: string): void => {
    const name = `t_${kind}_${n.replace(/-/g, "_")}`;
    define[name] = `var('${kind}:${n}:probability')`;
    names.push(name);
  };
  for (const n of Object.keys(mgs.autoplace_settings.tile.settings)) if (data.autoplace.tile[n]) add("tile", n);
  const controls = new Set(Object.keys(mgs.autoplace_controls ?? {}));
  const listed = new Set(Object.keys(mgs.autoplace_settings?.entity?.settings ?? {}));
  for (const [n, a] of Object.entries(data.autoplace.entity)) if (listed.has(n) || (a.control && controls.has(a.control))) add("entity", n);
  return { names, define };
}
for (const planet of ["vulcanus", "gleba", "fulgora", "aquilo"]) {
  const p = planetNames(planet);
  record(`${planet}-123.json`, 123, p.names, p.define, [...positions(40, 320, 8), ...positions(60, 6000, 9)], undefined, planet);
}

/** The cliffs the game really places around spawn, as grid cells. */
function recordCliffs(file: string, seed: number, half: number, where: { preset?: string; planet?: string } = {}): void {
  if (!wanted(file)) return;
  const { preset, planet } = where;
  const name = data.planets[planet ?? "nauvis"]!.map_gen_settings.cliff_settings.name;
  const cliffs = queryEntities(seed, [-half, -half, half, half], ["cliff"], { planet, gamePreset: preset }).filter((c) => c.name === name);
  // A cliff entity stands at the centre of its 4x4 cell, half a tile south.
  const cells = cliffs.map((c) => [(c.x - 2) / 4, (c.y - 2.5) / 4, c.o!] as [number, number, string]);
  writeFileSync(path.join(ROOT, "test/fixtures", file), JSON.stringify({ seed, preset, planet, half, cliffs: cells }));
  console.log(`${file}: ${cells.length} cliffs`);
}

recordCliffs("cliffs-123.json", 123, 384);
// The island preset, made as the New Game screen makes it: cliffs that
// follow the elevation and that the sea displaces.
recordCliffs("cliffs-island-123.json", 123, 384, { preset: "island" });
// The other planets with cliffs: Vulcanus smooths them and reads its
// elevation through `multisample`, Fulgora's cliffiness comes in every
// shade, Gleba's stop at its wetlands.
for (const planet of ["vulcanus", "gleba", "fulgora"]) recordCliffs(`cliffs-${planet}-123.json`, 123, 256, { planet });

/** The rocks, ruins and the like the game really places around spawn. */
function recordDecor(file: string, seed: number, half: number, planet?: string): void {
  if (!wanted(file)) return;
  const placed = queryEntities(seed, [-half, -half, half, half], ["simple-entity", "lightning-attractor"], { planet })
    .filter((e) => e.x >= -half && e.x < half && e.y >= -half && e.y < half)
    .map((e) => [e.name, e.x, e.y] as [string, number, number]);
  writeFileSync(path.join(ROOT, "test/fixtures", file), JSON.stringify({ seed, planet, half, decor: placed }));
  console.log(`${file}: ${placed.length} rocks and ruins`);
}

recordDecor("decor-123.json", 123, 256);
recordDecor("decor-vulcanus-123.json", 123, 256, "vulcanus");

/** The territories the game gives Vulcanus's demolishers around spawn, as
 *  lists of chunks within the area. */
function recordTerritories(file: string, seed: number, half: number, planet: string): void {
  if (!wanted(file)) return;
  const chunks = half / 32;
  const inside = ([x, y]: [number, number]): boolean => x >= -chunks && x < chunks && y >= -chunks && y < chunks;
  const territories = queryTerritories(seed, [-half, -half, half, half], planet).map((t) => t.chunks.filter(inside)).filter((c) => c.length > 0);
  writeFileSync(path.join(ROOT, "test/fixtures", file), JSON.stringify({ seed, planet, half, territories }));
  console.log(`${file}: ${territories.length} territories`);
}

recordTerritories("territories-vulcanus-123.json", 123, 1024, "vulcanus");

/** The resource entities the game really places in a few chunks: every ore
 *  tile and oil well with its amount. */
function recordResources(file: string, seed: number, areas: [number, number, number, number][]): void {
  if (!wanted(file)) return;
  const chunks: [number, number][] = [];
  const resources: [string, number, number, number][] = [];
  for (const area of areas) {
    for (let cy = area[1] / 32; cy < area[3] / 32; cy++) for (let cx = area[0] / 32; cx < area[2] / 32; cx++) chunks.push([cx, cy]);
    for (const e of queryEntities(seed, area, ["resource"])) {
      const x = Math.floor(e.x);
      const y = Math.floor(e.y);
      // The search also returns entities whose footprint reaches in from
      // outside; keep those that stand in the area.
      if (x >= area[0] && x < area[2] && y >= area[1] && y < area[3]) resources.push([e.name, x, y, e.a!]);
    }
  }
  writeFileSync(path.join(ROOT, "test/fixtures", file), JSON.stringify({ seed, chunks, resources }));
  console.log(`${file}: ${resources.length} resource entities in ${chunks.length} chunks`);
}

// An oil field, the overlapping starting patches, and a uranium patch.
recordResources("resources-123.json", 123, [
  [384, -416, 448, -352],
  [-128, 0, -32, 64],
  [-64, 384, 32, 448],
]);

