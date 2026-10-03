/** Turns a planet's map-gen settings plus a seed into the constants the
 *  compiler needs. Defaults are the game's "Default" preset. */
import { crc32, type AutoplaceDef, type CompileSettings, type NoiseSource } from "./compiler.js";
import { Rng } from "./rng.js";
import { cos, sin } from "./fastmath.js";
import type { OrientedBox } from "./cliffs.js";

export interface AutoplaceControlValue {
  frequency?: number;
  size?: number;
  richness?: number;
}

export interface ClimateValue {
  frequency?: number;
  bias?: number;
}

export interface AutoplaceEntry extends AutoplaceDef {
  /** Prototype type: "tile", "resource", "tree", "unit-spawner", ... */
  type: string;
  control?: string;
  order?: string;
  map_color?: [number, number, number];
  collision_box?: [[number, number], [number, number]];
  /** Placed anywhere within its tile, not snapped to it. */
  off_grid?: boolean;
  /** Resources: the amount is a yield, with `normal` as 100%. */
  infinite?: boolean;
  normal?: number;
}

export interface CliffEntry {
  map_color?: [number, number, number];
  grid_size?: [number, number];
  grid_offset?: [number, number];
  /** Collision box of each piece, by its name ("west-to-east"). */
  orientations: Record<string, OrientedBox>;
}

/** The contents of `mapgen-data.json`, written by the data pipeline. */
export interface MapGenData extends NoiseSource {
  autoplace: Record<"tile" | "entity", Record<string, AutoplaceEntry>>;
  cliffs?: Record<string, CliffEntry>;
  /** The game's map colours for things that have no colour of their own. */
  colors?: { tree?: [number, number, number]; enemy?: [number, number, number] };
  planets: Record<string, { map_gen_settings?: any; order?: string }>;
  controls: Record<string, { category?: string; richness?: boolean; can_be_disabled?: boolean; order?: string }>;
  /** The presets of the game's map generator. */
  presets?: Record<string, MapGenPreset>;
  /** Named expressions offered as a map type: those meant for `elevation`. */
  mapTypes?: string[];
  /** Game version the data was dumped from, and whether Space Age was on. */
  version?: string;
  spaceAge?: boolean;
  /** The crashed ship, to mark where the player starts: an image beside the
   *  data file, and the rectangle it covers in tiles (centre and size). */
  spawnMarker?: { file: string; x: number; y: number; width: number; height: number };
}

export interface CliffOptions {
  /** Elevation of the first row of cliffs. */
  elevation0?: number;
  /** Elevation between rows; the game's "frequency" slider is 40 / this. */
  interval?: number;
  /** The game's "continuity" slider. */
  richness?: number;
  smoothing?: number;
}

export interface MapGenOptions {
  seed: number;
  planet?: string;
  /** Per-control sliders; anything omitted is 1. */
  controls?: Record<string, AutoplaceControlValue>;
  /** The climate sliders: moisture and "terrain type" (aux). Frequency is
   *  one over the game's "scale"; bias runs from -0.5 to 0.5. */
  climate?: Partial<Record<"moisture" | "aux", ClimateValue>>;
  /** Starting area slider (1 = default). */
  startingArea?: number;
  peacefulMode?: boolean;
  noEnemiesMode?: boolean;
  /** Overrides such as `{ elevation: "elevation_island" }`: the map type,
   *  and whatever else a preset swaps out. A number stands for itself. */
  propertyExpressionNames?: Record<string, string | number | boolean>;
  cliffs?: CliffOptions;
  /** Map size in tiles; 0 or absent is unbounded. */
  width?: number;
  height?: number;
}

/** A preset from the game's map generator, as the dump stores it. */
export interface MapGenPreset {
  order?: string;
  default?: boolean;
  basic_settings?: {
    autoplace_controls?: Record<string, { frequency?: number | string; size?: number | string; richness?: number | string }>;
    property_expression_names?: Record<string, string | number | boolean>;
    cliff_settings?: { cliff_elevation_0?: number; cliff_elevation_interval?: number; richness?: number | string; cliff_smoothing?: number };
    starting_area?: number | string;
    width?: number;
    height?: number;
    peaceful_mode?: boolean;
  };
}

/** The game's named slider positions. */
const SIZE_NAMES: Record<string, number> = {
  none: 0,
  "very-low": 0.5, "very-small": 0.5, "very-poor": 0.5,
  low: Math.SQRT1_2, small: Math.SQRT1_2, poor: Math.SQRT1_2,
  normal: 1, medium: 1, regular: 1,
  high: Math.SQRT2, big: Math.SQRT2, good: Math.SQRT2,
  "very-high": 2, "very-big": 2, "very-good": 2,
};

function sizeValue(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const named = SIZE_NAMES[v];
  if (named === undefined) throw new Error(`unknown map-gen size '${v}'`);
  return named;
}

/** What a preset sets, as options (the seed and planet are left out). */
export function presetOptions(preset: MapGenPreset | undefined): Omit<MapGenOptions, "seed" | "planet"> {
  const basic = preset?.basic_settings ?? {};
  const controls: Record<string, AutoplaceControlValue> = {};
  for (const [name, c] of Object.entries(basic.autoplace_controls ?? {})) {
    controls[name] = { frequency: sizeValue(c.frequency), size: sizeValue(c.size), richness: sizeValue(c.richness) };
  }
  const cliffs = basic.cliff_settings;
  return {
    controls,
    propertyExpressionNames: { ...(basic.property_expression_names ?? {}) },
    startingArea: sizeValue(basic.starting_area),
    cliffs: cliffs && {
      elevation0: cliffs.cliff_elevation_0,
      interval: cliffs.cliff_elevation_interval,
      richness: sizeValue(cliffs.richness),
      smoothing: cliffs.cliff_smoothing,
    },
    width: basic.width,
    height: basic.height,
    peacefulMode: basic.peaceful_mode,
  };
}

const f = Math.fround;

/** Where the guaranteed starting lake sits: 75 tiles from spawn at an angle
 *  drawn from the map seed. */
export function startingLakePosition(seed: number, start: [number, number]): [number, number] {
  const rng = new Rng(seed >>> 0);
  const angle = f(rng.next() * (2 * Math.PI) * 2 ** -32);
  return [start[0] + Math.trunc(75 * cos(angle)), start[1] + Math.trunc(75 * sin(angle))];
}

/** The seed a planet's surface generates with. Nauvis uses the map seed;
 *  every other planet adds the CRC32 of its name, so one map seed gives five
 *  unrelated worlds. */
export function surfaceSeed(seed: number, planet: string): number {
  return planet === "nauvis" ? seed >>> 0 : (seed + crc32(planet)) >>> 0;
}

export function compileSettings(data: MapGenData, options: MapGenOptions): CompileSettings {
  const planet = data.planets[options.planet ?? "nauvis"];
  const seed = surfaceSeed(options.seed, options.planet ?? "nauvis");
  const mgs = planet?.map_gen_settings ?? {};
  const constants: Record<string, number> = {};

  for (const name of Object.keys(data.controls)) {
    const v = options.controls?.[name];
    constants[`control:${name}:frequency`] = v?.frequency ?? 1;
    constants[`control:${name}:size`] = v?.size ?? 1;
    constants[`control:${name}:richness`] = v?.richness ?? 1;
  }
  for (const climate of ["moisture", "aux", "temperature"] as const) {
    const v = climate === "temperature" ? undefined : options.climate?.[climate];
    constants[`control:${climate}:frequency`] = v?.frequency ?? 1;
    constants[`control:${climate}:bias`] = v?.bias ?? 0;
  }

  // A planet's cliffs are tuned through an autoplace control of their own:
  // its frequency divides the spacing between cliff rows and its size
  // scales their continuity.
  const cliffs = mgs.cliff_settings ?? {};
  const cliffControl = options.controls?.[cliffs.control ?? ""];
  constants.cliff_elevation_0 = options.cliffs?.elevation0 ?? cliffs.cliff_elevation_0 ?? 10;
  constants.cliff_elevation_interval = (options.cliffs?.interval ?? cliffs.cliff_elevation_interval ?? 40) / (cliffControl?.frequency ?? 1);
  constants.cliff_smoothing = options.cliffs?.smoothing ?? cliffs.cliff_smoothing ?? 0;
  constants.cliff_richness = (options.cliffs?.richness ?? cliffs.richness ?? 1) * (cliffControl?.size ?? 1);

  constants.starting_area_radius = 150 * (options.startingArea ?? 1);
  constants.map_width = options.width || 2000000;
  constants.map_height = options.height || 2000000;
  constants.peaceful_mode = options.peacefulMode ? 1 : 0;
  constants.no_enemies_mode = options.noEnemiesMode ? 1 : 0;

  const startingPositions: [number, number][] = [[0, 0]];
  return {
    seed,
    constants,
    propertyExpressionNames: Object.fromEntries(
      Object.entries({ ...(mgs.property_expression_names ?? {}), ...(options.propertyExpressionNames ?? {}) }).map(([k, v]) => [
        k,
        typeof v === "boolean" ? (v ? "1" : "0") : String(v),
      ]),
    ),
    startingPositions,
    startingLakePositions: startingPositions.map((p) => startingLakePosition(seed, p)),
  };
}
