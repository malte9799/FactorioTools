/** Asks the real game for exact noise values. Development only: needs a
 *  Factorio install, and is how the test fixtures are produced.
 *
 *  Runs Factorio headless with a tiny mod that evaluates named noise
 *  expressions at given positions (`LuaSurface.calculate_tile_properties`)
 *  and writes them out. It uses its own config and write directory, so a
 *  running game and the player's saves are never touched. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const FACTORIO = process.env.FACTORIO_BIN ?? "/Applications/factorio.app/Contents/MacOS/factorio";
const READ_DATA = process.env.FACTORIO_DATA ?? "/Applications/factorio.app/Contents/data";
export const ORACLE_DIR = process.env.MAPGEN_ORACLE_DIR ?? path.join(os.tmpdir(), "factoriotools-mapgen-oracle");

const CONTROL_LUA = `
local req = require("requests")
script.on_event(defines.events.on_tick, function()
  if storage.done then return end
  storage.done = true
  local surface = game.surfaces[1]
  if req.planet then surface = game.planets[req.planet].create_surface() end
  local res = surface.calculate_tile_properties(req.names, req.positions)
  local parts = {}
  for name, values in pairs(res) do
    local vs = {}
    for i, v in ipairs(values) do vs[i] = string.format("%.9g", v) end
    parts[#parts + 1] = string.format("%q:[%s]", name, table.concat(vs, ","))
  end
  local body = "{" .. table.concat(parts, ",") .. "}"
  body = body:gsub("%-?nan", "null"):gsub("inf", "1e999")
  helpers.write_file("oracle.json", body)
  -- What the surface was really created with: a preset reaches the map
  -- through the game's own settings, not always as written in the prototype.
  local mgs = surface.map_gen_settings
  helpers.write_file("settings.txt", serpent.block({cliff_settings = mgs.cliff_settings, property_expression_names = mgs.property_expression_names, starting_area = mgs.starting_area, width = mgs.width, height = mgs.height}))

  if req.entities then
    -- Really generate the chunks, with a margin so nothing at the edge of
    -- the area is missing a neighbour, and list what the game placed.
    local a = req.entities.area
    local cx, cy = (a[1] + a[3]) / 2, (a[2] + a[4]) / 2
    local radius = math.ceil(math.max(a[3] - a[1], a[4] - a[2]) / 64) + 2
    surface.request_to_generate_chunks({cx, cy}, radius)
    surface.force_generate_chunk_requests()
    local found = surface.find_entities_filtered{area = {{a[1], a[2]}, {a[3], a[4]}}, type = req.entities.types}
    local lines = {}
    for i, e in ipairs(found) do
      local extra = ""
      if e.type == "cliff" then extra = string.format(',"o":%q', e.cliff_orientation) end
      if e.type == "resource" then extra = string.format(',"a":%d', e.amount) end
      lines[i] = string.format('{"name":%q,"x":%.4f,"y":%.4f%s}', e.name, e.position.x, e.position.y, extra)
    end
    helpers.write_file("entities.json", "[" .. table.concat(lines, ",") .. "]")
    -- Territories (Vulcanus's demolishers): each one's chunks and how many
    -- units guard it.
    local parts = {}
    for _, territory in ipairs(surface.get_territories()) do
      local chunks = {}
      for i, c in ipairs(territory.get_chunks()) do chunks[i] = string.format("[%d,%d]", c.x, c.y) end
      local units = territory.get_segmented_units()
      local names = {}
      for i, u in ipairs(units) do names[i] = string.format("%q", u.prototype.name) end
      parts[#parts + 1] = string.format('{"units":[%s],"chunks":[%s]}', table.concat(names, ","), table.concat(chunks, ","))
    end
    helpers.write_file("territories.json", "[" .. table.concat(parts, ",") .. "]")
    if req.entities.tiles then
      -- One row of tile names per line, as indexes into a name list.
      local index, names, rows = {}, {}, {}
      for y = a[2], a[4] - 1 do
        local row = {}
        for x = a[1], a[3] - 1 do
          local name = surface.get_tile(x, y).name
          if not index[name] then names[#names + 1] = name; index[name] = #names - 1 end
          row[#row + 1] = index[name]
        end
        rows[#rows + 1] = "[" .. table.concat(row, ",") .. "]"
      end
      local quoted = {}
      for i, n in ipairs(names) do quoted[i] = string.format("%q", n) end
      helpers.write_file("tiles.json", '{"names":[' .. table.concat(quoted, ",") .. '],"rows":[' .. table.concat(rows, ",") .. "]}")
    end
  end
end)
`;

export interface OracleRequest {
  seed: number;
  names: string[];
  positions: [number, number][];
  /** Extra named noise expressions to define for this run. */
  define?: Record<string, string>;
  /** Also generate this area for real and list the entities placed in it. */
  entities?: { area: [number, number, number, number]; types: string[]; tiles?: boolean };
  /** Planet to evaluate on; Nauvis when absent. */
  planet?: string;
  /** Extra Lua for the mod's data stage and final-fixes stage, for
   *  experiments that need their own prototypes. */
  dataLua?: string;
  finalFixesLua?: string;
  /** A map-gen-settings file for the new map, as the game's own
   *  `--map-gen-settings` takes it: sliders, starting area, map size. */
  mapGenSettings?: Record<string, unknown>;
  /** One of the game's map presets, applied as the New Game screen applies
   *  it (the game's own `--preset`). */
  gamePreset?: string;
}

/** An entity the game placed. `o` is a cliff's orientation, `a` a resource's amount. */
export interface OracleEntity {
  name: string;
  x: number;
  y: number;
  o?: string;
  a?: number;
}

function run(args: string[]): string {
  return execFileSync(FACTORIO, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

/** Config file pointing the game at a private write directory. */
export function oracleConfig(): string {
  const write = path.join(ORACLE_DIR, "write");
  mkdirSync(path.join(write, "saves"), { recursive: true });
  mkdirSync(path.join(ORACLE_DIR, "mods-empty"), { recursive: true });
  const config = path.join(ORACLE_DIR, "config.ini");
  writeFileSync(config, `[path]\nread-data=${READ_DATA}\nwrite-data=${write}\n`);
  return config;
}

/** Exact values of `names` at `positions`. The positions form one batch, so
 *  `random_penalty` is seeded from the first of them. */
export function queryOracle(req: OracleRequest): Record<string, number[]> {
  const config = oracleConfig();
  const write = path.join(ORACLE_DIR, "write");
  const mod = path.join(ORACLE_DIR, "mods", "mapgen-oracle");
  mkdirSync(mod, { recursive: true });

  writeFileSync(
    path.join(mod, "info.json"),
    JSON.stringify({ name: "mapgen-oracle", version: "0.0.1", title: "mapgen oracle", author: "dev", factorio_version: "2.0", dependencies: ["base"] }),
  );
  const defs = Object.entries(req.define ?? {})
    .map(([name, expr]) => `  {type = "noise-expression", name = ${JSON.stringify(name)}, expression = ${JSON.stringify(expr)}},`)
    .join("\n");
  writeFileSync(path.join(mod, "data.lua"), (defs ? `data:extend{\n${defs}\n}\n` : "") + (req.dataLua ?? ""));
  writeFileSync(path.join(mod, "data-final-fixes.lua"), req.finalFixesLua ?? "");
  writeFileSync(path.join(mod, "control.lua"), CONTROL_LUA);
  const positions = req.positions.map(([x, y]) => `{x=${x},y=${y}}`).join(",");
  const entities = req.entities
    ? `, entities = { area = {${req.entities.area.join(",")}}, types = {${req.entities.types.map((t) => JSON.stringify(t)).join(",")}}, tiles = ${req.entities.tiles ? "true" : "false"} }`
    : "";
  const planet = req.planet ? `, planet = ${JSON.stringify(req.planet)}` : "";
  writeFileSync(path.join(mod, "requests.lua"), `return { names = {${req.names.map((n) => JSON.stringify(n)).join(",")}}, positions = {${positions}}${entities}${planet} }\n`);

  const save = path.join(write, "saves", "oracle.zip");
  const output = path.join(write, "script-output", "oracle.json");
  rmSync(save, { force: true });
  rmSync(output, { force: true });
  rmSync(ENTITIES_FILE(), { force: true });

  const common = ["-c", config, "--mod-directory", path.join(ORACLE_DIR, "mods")];
  const settingsArgs: string[] = [];
  if (req.mapGenSettings) {
    const file = path.join(ORACLE_DIR, "map-gen-settings.json");
    writeFileSync(file, JSON.stringify(req.mapGenSettings));
    settingsArgs.push("--map-gen-settings", file);
  }
  if (req.gamePreset) settingsArgs.push("--preset", req.gamePreset);
  const created = run([...common, "--create", save, "--map-gen-seed", String(req.seed >>> 0), ...settingsArgs]);
  if (!existsSync(save)) throw new Error(`oracle: map creation failed\n${created.slice(-3000)}`);
  const ran = run([...common, "--benchmark", save, "--benchmark-ticks", "2"]);
  if (!existsSync(output)) throw new Error(`oracle: no output\n${ran.slice(-3000)}`);
  const parsed = JSON.parse(readFileSync(output, "utf8")) as Record<string, (number | null)[]>;
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v.map((x) => (x === null ? NaN : x));
  return out;
}

const ENTITIES_FILE = (): string => path.join(ORACLE_DIR, "write", "script-output", "entities.json");

/** What the game actually placed in an area: generates the chunks for real. */
export function queryEntities(
  seed: number,
  area: [number, number, number, number],
  types: string[],
  extra: Pick<OracleRequest, "dataLua" | "finalFixesLua" | "define" | "mapGenSettings" | "planet" | "gamePreset"> = {},
): OracleEntity[] {
  queryOracle({ seed, names: ["elevation"], positions: [[0, 0]], entities: { area, types }, ...extra });
  return JSON.parse(readFileSync(ENTITIES_FILE(), "utf8")) as OracleEntity[];
}

/** The territories the game made once an area is generated: each one's
 *  chunks (which may reach beyond the area) and the units guarding it. */
export function queryTerritories(seed: number, area: [number, number, number, number], planet: string): { units: string[]; chunks: [number, number][] }[] {
  queryOracle({ seed, names: ["elevation"], positions: [[0, 0]], entities: { area, types: ["segmented-unit"] }, planet });
  return JSON.parse(readFileSync(path.join(ORACLE_DIR, "write", "script-output", "territories.json"), "utf8"));
}

/** The tiles the game actually generated in an area, row by row. */
export function queryTiles(seed: number, area: [number, number, number, number], planet?: string): { names: string[]; rows: number[][] } {
  queryOracle({ seed, names: ["elevation"], positions: [[0, 0]], entities: { area, types: ["cliff"], tiles: true }, planet });
  return JSON.parse(readFileSync(path.join(ORACLE_DIR, "write", "script-output", "tiles.json"), "utf8"));
}

