/** Seed Viewer: enter a map seed and explore the world it generates.
 *
 *  Nothing is pre-rendered. A pool of workers runs the game's own noise
 *  expressions (packages/mapgen) and fills the map in 256x256-sample tiles;
 *  this file owns the camera, the tile cache and the panel. Each worker
 *  returns raw layers (tile, resource, enemy, trees, cliffs), not pixels, so
 *  toggling a layer repaints from cache without generating anything again.
 *
 *  The map is drawn the way the game's own map draws it: resources as a
 *  checkerboard over the ground, trees as a scatter, cliffs as lines. */
import { presetOptions, unsupportedFunctions, type AutoplaceControlValue, type ClimateValue, type EnemyBase, type LayerColors, type MapGenData, type MapGenOptions, type PatchMeasure, type ResourceLayer, type TileLayer } from "@factoriotools/mapgen";
import type { PatchInfo, WorkerRequest, WorkerResponse } from "./worker.js";

/** Samples along one side of a map tile image. */
const TILE = 256;
const MIN_SCALE = 1 / 256;
const MAX_SCALE = 8;
/** Coarsest sampling: one sample every 2^8 world tiles. */
const MAX_LEVEL = 8;
const CACHE_LIMIT = 320;
/** How far from spawn the patch list reaches, in tiles. */
const SURVEY_RADIUS = 1600;
/** How long the cursor rests on a patch before it is measured. */
const HOVER_DELAY = 60;
/** The crashed ship never draws narrower than this, in screen pixels. */
const SHIP_MIN_WIDTH = 44;
const DATA_DIR = "./data/mapgen";

/** The positions of the game's map-generator sliders. */
const SLIDER_STEPS = [1 / 6, 0.25, 1 / 3, 0.5, 0.75, 1, 4 / 3, 1.5, 2, 3, 4, 6];
/** The positions of the moisture and terrain-type bias sliders. */
const BIAS_STEPS = [-0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5];
/** Largest map side the game accepts, in tiles. */
const MAX_MAP_SIZE = 2000000;
const CLIMATES = ["moisture", "aux"] as const;
type Climate = (typeof CLIMATES)[number];
const CLIMATE_LABELS: Record<Climate, string> = { moisture: "Moisture", aux: "Terrain type" };
/** Names the game shows for controls whose prototype name reads badly. */
const CONTROL_LABELS: Record<string, string> = { nauvis_cliff: "Cliffs", gleba_cliff: "Cliffs", fulgora_cliff: "Cliffs", "enemy-base": "Enemy bases", gleba_enemy_base: "Enemy bases" };
/** The sections of the settings panel, by control category. */
const CONTROL_GROUPS: { title: string; categories: string[]; columns: [string, string, string]; inverse: boolean }[] = [
  { title: "Resources", categories: ["resource"], columns: ["Frequency", "Size", "Richness"], inverse: false },
  // The game shows terrain as a scale, which is one over its frequency.
  { title: "Terrain", categories: ["terrain"], columns: ["Scale", "Coverage", ""], inverse: true },
  { title: "Cliffs", categories: ["cliff"], columns: ["Frequency", "Continuity", ""], inverse: false },
  { title: "Enemies", categories: ["enemy"], columns: ["Frequency", "Size", ""], inverse: false },
];
const MAP_TYPE_LABELS: Record<string, string> = { elevation: "Normal", elevation_lakes: "Lakes", elevation_island: "Island" };

/** One game version's dataset, as listed in the data directory's index. */
interface DatasetEntry {
  id: string;
  version: string;
  spaceAge: boolean;
  file: string;
}

const TEMPLATE = `
  <canvas id="seed-canvas" class="seed-canvas"></canvas>
  <aside class="gui-window seed-panel">
    <div class="gui-titlebar"><span>Seed Viewer</span></div>
    <div class="gui-body seed-panel-body">
      <form id="seed-form" class="seed-row">
        <input id="seed-input" class="seed-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="Map seed" />
        <button type="submit" class="primary">Go</button>
        <button type="button" id="seed-random" title="Pick a random seed">Random</button>
      </form>
      <p class="seed-note" id="seed-status" role="status"></p>

      <div class="seed-fields">
        <label class="seed-field"><span>Game version</span><select id="seed-version"></select></label>
        <label class="seed-field"><span>Planet</span><select id="seed-planet"></select></label>
        <label class="seed-field"><span>Preset</span><select id="seed-preset"></select></label>
        <label class="seed-field"><span>Map type</span><select id="seed-maptype"></select></label>
      </div>
      <details class="seed-advanced">
        <summary>Map settings</summary>
        <div id="seed-controls" class="seed-controls"></div>
      </details>

      <h3 class="seed-heading">Layers</h3>
      <div id="seed-layers" class="seed-layers"></div>

      <h3 class="seed-heading">Nearest patches</h3>
      <div id="seed-patches" class="seed-patches"></div>
    </div>
  </aside>
  <div class="seed-readout" id="seed-readout"></div>
  <div class="seed-tooltip" id="seed-tooltip" role="tooltip" hidden></div>
`;

interface CachedTile {
  key: string;
  level: number;
  tx: number;
  ty: number;
  tile: Uint8Array;
  resource: Uint8Array;
  enemy: Uint8Array;
  trees: Uint8Array;
  cliff: Uint8Array;
  canvas: HTMLCanvasElement;
  used: number;
}

interface PoolWorker {
  worker: Worker;
  /** Generation this worker has a surface for. */
  ready: number;
  busy: boolean;
}

/** The patch under the cursor, with the shapes that draw it. */
interface Highlight {
  patch: PatchMeasure;
  fill: Path2D;
  outline: Path2D;
}

/** "iron-ore" -> "Iron ore". */
function prettyName(name: string): string {
  const s = name.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortNumber(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

const whole = (n: number): string => Math.round(n).toLocaleString("en-US");

const COMPASS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
function bearing(x: number, y: number): string {
  // Map y grows southwards.
  return COMPASS[Math.round(Math.atan2(y, x) / (Math.PI / 4) + 8) % 8]!;
}

function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n <= 0xffffffff ? n : null;
}

/** A stable pseudo-random byte per sample, for scattering trees. */
function speckle(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) & 255;
}

/** View state carried in the URL after the route, so a map can be shared. */
/** What the user changed from the preset: slider values by control, and the
 *  starting area. */
interface CustomSettings {
  controls: Record<string, AutoplaceControlValue>;
  climate: Partial<Record<Climate, ClimateValue>>;
  startingArea: number | null;
  /** Map size in tiles; 0 is unbounded, null follows the preset. */
  width: number | null;
  height: number | null;
}

const noCustom = (): CustomSettings => ({ controls: {}, climate: {}, startingArea: null, width: null, height: null });

function isCustom(c: CustomSettings): boolean {
  return Object.keys(c.controls).length > 0 || Object.keys(c.climate).length > 0 || c.startingArea !== null || c.width !== null || c.height !== null;
}

function readUrl(): { seed: number | null; x: number; y: number; scale: number; preset: string; mapType: string | null; custom: CustomSettings } {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const num = (key: string, fallback: number): number => {
    const v = Number(query.get(key));
    return query.has(key) && Number.isFinite(v) ? v : fallback;
  };
  const custom = noCustom();
  try {
    // Shared links are untrusted input: keep only finite numbers.
    const parsed = JSON.parse(query.get("cfg") ?? "{}") as {
      c?: Record<string, Record<string, unknown>>;
      m?: Record<string, Record<string, unknown>>;
      s?: unknown;
      w?: unknown;
      h?: unknown;
    };
    for (const [name, value] of Object.entries(parsed.c ?? {})) {
      const clean: AutoplaceControlValue = {};
      for (const field of ["frequency", "size", "richness"] as const) {
        const v = value?.[field];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) clean[field] = v;
      }
      custom.controls[name] = clean;
    }
    for (const name of CLIMATES) {
      const value = parsed.m?.[name];
      if (!value) continue;
      const clean: ClimateValue = {};
      if (typeof value.frequency === "number" && Number.isFinite(value.frequency) && value.frequency > 0 && value.frequency <= 100) clean.frequency = value.frequency;
      if (typeof value.bias === "number" && Number.isFinite(value.bias) && Math.abs(value.bias) <= 1) clean.bias = value.bias;
      custom.climate[name] = clean;
    }
    if (typeof parsed.s === "number" && Number.isFinite(parsed.s) && parsed.s > 0 && parsed.s <= 100) custom.startingArea = parsed.s;
    const side = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MAP_SIZE ? v : null);
    custom.width = side(parsed.w);
    custom.height = side(parsed.h);
  } catch {
    // A mangled link falls back to the preset.
  }
  return {
    seed: parseSeed(query.get("seed") ?? ""),
    x: num("x", 0),
    y: num("y", 0),
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, num("z", 1))),
    preset: query.get("preset") ?? "default",
    mapType: query.get("type"),
    custom,
  };
}

/** Outline and fill of a patch mask, in world tiles. Runs of equal cells
 *  become one segment, so a large patch stays a short path. */
function patchPaths(p: PatchMeasure): { fill: Path2D; outline: Path2D } {
  const { x0, y0, width, height, mask } = p;
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= width || j >= height ? 0 : mask[j * width + i]!);
  const fill = new Path2D();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!at(i, j)) continue;
      const start = i;
      while (i < width && at(i, j)) i++;
      fill.rect(x0 + start, y0 + j, i - start, 1);
    }
  }
  const outline = new Path2D();
  // Horizontal edges: between row j-1 and row j.
  for (let j = 0; j <= height; j++) {
    for (let i = 0; i < width; i++) {
      if (at(i, j - 1) === at(i, j)) continue;
      const start = i;
      while (i < width && at(i, j - 1) !== at(i, j)) i++;
      outline.moveTo(x0 + start, y0 + j);
      outline.lineTo(x0 + i, y0 + j);
    }
  }
  for (let i = 0; i <= width; i++) {
    for (let j = 0; j < height; j++) {
      if (at(i - 1, j) === at(i, j)) continue;
      const start = j;
      while (j < height && at(i - 1, j) !== at(i, j)) j++;
      outline.moveTo(x0 + i, y0 + start);
      outline.lineTo(x0 + i, y0 + j);
    }
  }
  return { fill, outline };
}

export function mountSeedViewer(container: HTMLElement): () => void {
  container.innerHTML = TEMPLATE;
  const canvas = container.querySelector<HTMLCanvasElement>("#seed-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const form = container.querySelector<HTMLFormElement>("#seed-form")!;
  const seedInput = container.querySelector<HTMLInputElement>("#seed-input")!;
  const statusEl = container.querySelector<HTMLElement>("#seed-status")!;
  const layersEl = container.querySelector<HTMLElement>("#seed-layers")!;
  const patchesEl = container.querySelector<HTMLElement>("#seed-patches")!;
  const readoutEl = container.querySelector<HTMLElement>("#seed-readout")!;
  const tooltipEl = container.querySelector<HTMLElement>("#seed-tooltip")!;

  const initial = readUrl();
  let seed = initial.seed ?? Math.floor(Math.random() * 2 ** 32);
  let cx = initial.x;
  let cy = initial.y;
  let scale = initial.scale;

  let generation = 0;
  let disposed = false;
  let datasets: DatasetEntry[] = [];
  let dataset: DatasetEntry | null = null;
  let presetName = initial.preset;
  /** Elevation expression in use; null follows the preset. */
  let mapType: string | null = initial.mapType;
  let custom: CustomSettings = initial.custom;
  let planet = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("planet") ?? "nauvis";
  const planetSelect = container.querySelector<HTMLSelectElement>("#seed-planet")!;
  const versionSelect = container.querySelector<HTMLSelectElement>("#seed-version")!;
  const presetSelect = container.querySelector<HTMLSelectElement>("#seed-preset")!;
  const mapTypeSelect = container.querySelector<HTMLSelectElement>("#seed-maptype")!;
  const controlsEl = container.querySelector<HTMLElement>("#seed-controls")!;
  let tiles: TileLayer[] = [];
  let resources: ResourceLayer[] = [];
  let colors: LayerColors = { tree: [48, 99, 48], enemy: [255, 26, 26], cliff: [144, 119, 87] };
  let patches: PatchInfo[] = [];
  let bases: EnemyBase[] = [];
  let showResource: boolean[] = [];
  let showEnemies = true;
  let showTrees = true;
  let showCliffs = true;
  let tileLut = new Uint32Array(0);
  let resourceLut = new Uint32Array(0);

  const cache = new Map<string, CachedTile>();
  const inFlight = new Set<string>();
  let queue: { key: string; level: number; tx: number; ty: number }[] = [];
  let useCounter = 0;
  let frame = 0;

  /** Generation the tile and resource tables were last taken from. */
  let layersFor = -1;
  let highlight: Highlight | null = null;
  let patchRequest = 0;
  let hoverTimer = 0;
  let pointer: [number, number] = [0, 0];

  /* ---------- workers ---------- */

  const poolSize = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const pool: PoolWorker[] = [];
  for (let i = 0; i < poolSize; i++) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const entry: PoolWorker = { worker, ready: -1, busy: true };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => onMessage(entry, event.data);
    pool.push(entry);
  }
  const post = (entry: PoolWorker, message: WorkerRequest): void => entry.worker.postMessage(message);

  let dataSent = false;
  let mapData: MapGenData | null = null;
  const shipImage = new Image();
  shipImage.onload = () => requestDraw();

  /* ---------- settings ---------- */

  // The game's presets are written for Nauvis; elsewhere only the sliders apply.
  const preset = (): ReturnType<typeof presetOptions> => presetOptions(planet === "nauvis" ? mapData?.presets?.[presetName] : undefined);

  /** The elevation expression a preset selects, "elevation" if it has none. */
  const presetMapType = (): string => String(preset().propertyExpressionNames?.elevation ?? "elevation");

  /** A slider's value: what the user set, else the preset's, else 100%. */
  function controlValue(name: string, field: keyof AutoplaceControlValue): number {
    return custom.controls[name]?.[field] ?? preset().controls?.[name]?.[field] ?? 1;
  }

  function currentOptions(): MapGenOptions {
    const base = preset();
    const controls: Record<string, AutoplaceControlValue> = { ...base.controls };
    for (const [name, value] of Object.entries(custom.controls)) controls[name] = { ...controls[name], ...value };
    const names = { ...base.propertyExpressionNames };
    const type = mapType ?? presetMapType();
    if (planet === "nauvis" && type !== "elevation") names.elevation = type;
    return {
      ...base, seed, planet, controls, propertyExpressionNames: names,
      climate: custom.climate,
      startingArea: custom.startingArea ?? base.startingArea,
      width: custom.width ?? base.width,
      height: custom.height ?? base.height,
    };
  }

  function option(value: string, label: string, selected: boolean): HTMLOptionElement {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    el.selected = selected;
    return el;
  }

  /** A slider as a dropdown of the game's positions. A value between them
   *  (a preset's 141%, a shared link's) gets a position of its own. */
  function sliderSelect(value: number, allowNone: boolean, label: string, onChange: (v: number) => void, bias = false): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "seed-slider";
    select.setAttribute("aria-label", label);
    const steps = bias ? [...BIAS_STEPS] : allowNone ? [0, ...SLIDER_STEPS] : [...SLIDER_STEPS];
    if (!steps.some((step) => Math.abs(step - value) < 1e-3)) steps.push(value);
    steps.sort((a, b) => a - b);
    const text = (step: number): string => (bias ? `${step > 0 ? "+" : ""}${Number(step.toFixed(2))}` : step === 0 ? "None" : `${Math.round(step * 100)}%`);
    for (const step of steps) select.append(option(String(step), text(step), Math.abs(step - value) < 1e-3));
    select.addEventListener("change", () => onChange(Number(select.value)));
    return select;
  }

  /** A map side in tiles; empty means the map does not end. */
  function sizeInput(value: number, label: string, onChange: (v: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "seed-size";
    input.min = "0";
    input.max = String(MAX_MAP_SIZE);
    input.step = "1";
    input.placeholder = "Unlimited";
    input.setAttribute("aria-label", label);
    if (value > 0) input.value = String(value);
    input.addEventListener("change", () => {
      const v = Math.floor(Number(input.value));
      onChange(Number.isFinite(v) && v > 0 ? Math.min(MAX_MAP_SIZE, v) : 0);
    });
    return input;
  }

  function renderSettings(): void {
    if (!mapData) return;
    versionSelect.replaceChildren(...datasets.map((d) => option(d.id, `${d.version}${d.spaceAge ? " · Space Age" : ""}`, d.id === dataset?.id)));
    if (!mapData.planets[planet]) planet = "nauvis";
    const planetNames = Object.keys(mapData.planets).sort((a, b) => ((mapData!.planets[a]!.order ?? "") < (mapData!.planets[b]!.order ?? "") ? -1 : 1));
    planetSelect.replaceChildren(
      ...planetNames.map((name) => {
        // A planet built on noise functions that are not implemented yet is
        // listed, so it is clear it exists, but cannot be chosen.
        const missing = unsupportedFunctions(mapData!, name);
        const el = option(name, missing.length ? `${prettyName(name)} (not yet)` : prettyName(name), name === planet);
        el.disabled = missing.length > 0;
        if (missing.length) el.title = `Needs ${missing.join(", ")}`;
        return el;
      }),
    );
    presetSelect.disabled = mapTypeSelect.disabled = planet !== "nauvis";
    const presets = Object.entries(mapData.presets ?? {}).sort(([, a], [, b]) => ((a.order ?? "") < (b.order ?? "") ? -1 : 1));
    if (!mapData.presets?.[presetName]) presetName = "default";
    presetSelect.replaceChildren(...presets.map(([name]) => option(name, prettyName(name), name === presetName)));
    const type = mapType ?? presetMapType();
    mapTypeSelect.replaceChildren(...(mapData.mapTypes ?? ["elevation"]).map((name) => option(name, MAP_TYPE_LABELS[name] ?? prettyName(name), name === type)));

    // One row per control the planet has, in the game's sections. A row
    // has frequency, size, and richness where the control has one.
    const settings = mapData.planets[planet]?.map_gen_settings ?? {};
    const names = Object.keys(settings.autoplace_controls ?? {}).sort((a, b) => ((mapData!.controls[a]?.order ?? "") < (mapData!.controls[b]?.order ?? "") ? -1 : 1));
    const cell = (text: string, className: string): HTMLElement => {
      const el = document.createElement("span");
      el.className = className;
      el.textContent = text;
      return el;
    };
    const heading = (title: string, columns: [string, string, string]): HTMLElement[] => [cell(title, "seed-control-group"), ...columns.map((c) => cell(c, "seed-control-head"))];
    const set = (name: string, field: keyof AutoplaceControlValue, inverse = false) => (v: number): void => {
      custom.controls[name] = { ...custom.controls[name], [field]: inverse ? 1 / v : v };
      startGeneration();
    };
    const startingArea = (): HTMLElement[] => [
      cell("Starting area", "seed-control-name"),
      cell("", ""),
      sliderSelect(custom.startingArea ?? preset().startingArea ?? 1, false, "Starting area size", (v) => {
        custom.startingArea = v;
        startGeneration();
      }),
      cell("", ""),
    ];
    const rows: HTMLElement[] = [];
    for (const group of CONTROL_GROUPS) {
      const members = names.filter((name) => group.categories.includes(mapData!.controls[name]?.category ?? "resource"));
      // Every planet has a starting area, whether or not it has enemies.
      if (!members.length && group.title !== "Enemies") continue;
      rows.push(...heading(group.title, group.columns));
      for (const name of members) {
        const label = CONTROL_LABELS[name] ?? prettyName(name.replace(/_/g, "-"));
        const frequency = controlValue(name, "frequency");
        rows.push(
          cell(label, "seed-control-name"),
          sliderSelect(group.inverse ? 1 / frequency : frequency, false, `${label} ${group.columns[0].toLowerCase()}`, set(name, "frequency", group.inverse)),
          sliderSelect(controlValue(name, "size"), mapData.controls[name]?.can_be_disabled !== false, `${label} ${group.columns[1].toLowerCase()}`, set(name, "size")),
          mapData.controls[name]?.richness ? sliderSelect(controlValue(name, "richness"), false, `${label} richness`, set(name, "richness")) : cell("", ""),
        );
      }
      if (group.title === "Enemies") rows.push(...startingArea());
    }

    // Moisture and terrain type, on the planets whose terrain reads them.
    const climates = CLIMATES.filter((name) => settings[`${name}_climate_control`]);
    if (climates.length) rows.push(...heading("Climate", ["Scale", "Bias", ""]));
    for (const name of climates) {
      const label = CLIMATE_LABELS[name];
      const setClimate = (field: keyof ClimateValue, inverse: boolean) => (v: number): void => {
        custom.climate[name] = { ...custom.climate[name], [field]: inverse ? 1 / v : v };
        startGeneration();
      };
      rows.push(
        cell(label, "seed-control-name"),
        sliderSelect(1 / (custom.climate[name]?.frequency ?? 1), false, `${label} scale`, setClimate("frequency", true)),
        sliderSelect(custom.climate[name]?.bias ?? 0, false, `${label} bias`, setClimate("bias", false), true),
        cell("", ""),
      );
    }

    const setSide = (side: "width" | "height") => (v: number): void => {
      custom[side] = v;
      startGeneration();
    };
    rows.push(
      ...heading("Map size", ["Width", "Height", ""]),
      cell("Tiles", "seed-control-name"),
      sizeInput(custom.width ?? preset().width ?? 0, "Map width in tiles", setSide("width")),
      sizeInput(custom.height ?? preset().height ?? 0, "Map height in tiles", setSide("height")),
      cell("", ""),
    );
    controlsEl.replaceChildren(...rows);
  }

  function startGeneration(): void {
    if (!mapData) return;
    generation++;
    cache.clear();
    inFlight.clear();
    queue = [];
    patches = [];
    bases = [];
    clearHover();
    renderPatches();
    seedInput.value = String(seed);
    statusEl.textContent = "Generating…";
    for (const entry of pool) {
      entry.busy = true;
      post(entry, { type: "init", generation, data: dataSent ? null : mapData, options: currentOptions() });
    }
    dataSent = true;
    writeUrl();
    requestDraw();
  }

  function onMessage(entry: PoolWorker, msg: WorkerResponse): void {
    // A reply for an older seed: the worker has since been re-initialised,
    // and its "ready" for the current one will free it.
    if (disposed || msg.generation !== generation) return;
    switch (msg.type) {
      case "ready": {
        entry.ready = msg.generation;
        entry.busy = false;
        // The first worker to answer for this generation says what the map
        // is made of. Settings can change that (a bounded map gains a void
        // tile), so the tables are rebuilt every time.
        if (layersFor !== generation) {
          layersFor = generation;
          const sameResources = resources.length === msg.resources.length && resources.every((r, i) => r.name === msg.resources[i]!.name);
          tiles = msg.tiles;
          resources = msg.resources;
          colors = msg.colors;
          buildLuts();
          if (!sameResources) {
            showResource = resources.map(() => true);
            renderLayers();
          }
        }
        // One worker surveys the patches around spawn; the rest draw.
        if (entry === pool[0]) {
          entry.busy = pool.length > 1;
          post(entry, { type: "survey", generation, radius: SURVEY_RADIUS });
        }
        statusEl.textContent = "";
        schedule();
        break;
      }
      case "tile": {
        entry.busy = false;
        inFlight.delete(msg.key);
        const [level, tx, ty] = msg.key.split(":").map(Number) as [number, number, number];
        const tileCanvas = document.createElement("canvas");
        tileCanvas.width = tileCanvas.height = TILE;
        const cached: CachedTile = {
          key: msg.key, level, tx, ty, tile: msg.tile, resource: msg.resource, enemy: msg.enemy, trees: msg.trees, cliff: msg.cliff,
          canvas: tileCanvas, used: ++useCounter,
        };
        paint(cached);
        cache.set(msg.key, cached);
        trimCache();
        pump();
        requestDraw();
        break;
      }
      case "survey": {
        entry.busy = false;
        patches = msg.patches.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
        bases = msg.bases;
        renderPatches();
        pump();
        break;
      }
      case "patch": {
        if (msg.request !== patchRequest) return;
        if (!msg.patch) {
          clearHover();
          return;
        }
        highlight = { patch: msg.patch, ...patchPaths(msg.patch) };
        showPatchTooltip(msg.patch);
        requestDraw();
        break;
      }
      case "error":
        entry.busy = false;
        statusEl.textContent = `Generation failed: ${msg.message}`;
        break;
    }
  }

  /* ---------- tiles ---------- */

  /** Sampling level for the current zoom: 2^level world tiles per sample,
   *  chosen so a sample lands on roughly one screen pixel. */
  function currentLevel(): number {
    return Math.min(MAX_LEVEL, Math.max(0, Math.round(Math.log2(1 / scale))));
  }

  const tileKey = (level: number, tx: number, ty: number): string => `${level}:${tx}:${ty}:${showTrees ? 1 : 0}`;

  function schedule(): void {
    const level = currentLevel();
    const span = TILE * 2 ** level;
    const halfW = canvas.clientWidth / 2 / scale;
    const halfH = canvas.clientHeight / 2 / scale;
    const tx0 = Math.floor((cx - halfW) / span);
    const tx1 = Math.floor((cx + halfW) / span);
    const ty0 = Math.floor((cy - halfH) / span);
    const ty1 = Math.floor((cy + halfH) / span);
    const wanted: typeof queue = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(level, tx, ty);
        const hit = cache.get(key);
        if (hit) hit.used = ++useCounter;
        else if (!inFlight.has(key)) wanted.push({ key, level, tx, ty });
      }
    }
    // Centre first: the middle of the screen is what is being looked at.
    const distance = (t: { tx: number; ty: number }): number => Math.hypot((t.tx + 0.5) * span - cx, (t.ty + 0.5) * span - cy);
    queue = wanted.sort((a, b) => distance(a) - distance(b));
    pump();
  }

  function pump(): void {
    for (const entry of pool) {
      if (queue.length === 0) return;
      if (entry.busy || entry.ready !== generation) continue;
      const next = queue.shift()!;
      const step = 2 ** next.level;
      entry.busy = true;
      inFlight.add(next.key);
      post(entry, { type: "tile", generation, key: next.key, x0: next.tx * TILE * step, y0: next.ty * TILE * step, size: TILE, step, trees: showTrees });
    }
  }

  function trimCache(): void {
    if (cache.size <= CACHE_LIMIT) return;
    const oldest = [...cache.values()].sort((a, b) => a.used - b.used).slice(0, cache.size - CACHE_LIMIT);
    for (const t of oldest) cache.delete(t.key);
  }

  /** Colours packed the way a little-endian Uint32 view of ImageData wants. */
  const pack = (r: number, g: number, b: number): number => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

  function buildLuts(): void {
    tileLut = Uint32Array.from(tiles, (t) => pack(...t.color));
    resourceLut = Uint32Array.from(resources, (r) => pack(...r.color));
  }

  function blend(base: number, [r, g, b]: readonly [number, number, number], alpha: number): number {
    const inv = 1 - alpha;
    return pack(Math.round((base & 255) * inv + r * alpha), Math.round(((base >> 8) & 255) * inv + g * alpha), Math.round(((base >> 16) & 255) * inv + b * alpha));
  }

  function paint(t: CachedTile): void {
    const image = new ImageData(TILE, TILE);
    const out = new Uint32Array(image.data.buffer);
    const cliffColor = pack(...colors.cliff);
    const sparse = resources.map((r) => r.chance < 1);
    // Sample coordinates across the whole level, so the checkerboard and the
    // tree scatter run on unbroken from one tile image to the next.
    const gx0 = t.tx * TILE;
    const gy0 = t.ty * TILE;
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const k = j * TILE + i;
        let color = tileLut[t.tile[k]!]!;
        if (showTrees && t.trees[k]! > speckle(gx0 + i, gy0 + j)) color = blend(color, colors.tree, 0.8);
        if (showCliffs && t.cliff[k]) color = cliffColor;
        // One flat wash for "a spawner can stand here". Which tiles get one
        // is a random roll the viewer does not reproduce, so no single
        // spawners are drawn.
        if (showEnemies && t.enemy[k]) color = blend(color, colors.enemy, 0.6);
        const res = t.resource[k]!;
        // The game's map shows an ore on every other tile, the ground through
        // the rest; an oil well is a solid square.
        if (res && showResource[res - 1] && (sparse[res - 1] || ((gx0 + i + gy0 + j) & 1) === 0)) color = resourceLut[res - 1]!;
        out[k] = color;
      }
    }
    t.canvas.getContext("2d")!.putImageData(image, 0, 0);
  }

  function repaintAll(): void {
    for (const t of cache.values()) paint(t);
    requestDraw();
  }

  /** The cached sample covering a world tile at the current zoom, with the
   *  world tile that sample was actually taken at. */
  function sampleAt(x: number, y: number): { t: CachedTile; k: number; x: number; y: number } | null {
    const level = currentLevel();
    const step = 2 ** level;
    const span = TILE * step;
    const tx = Math.floor(x / span);
    const ty = Math.floor(y / span);
    const t = cache.get(tileKey(level, tx, ty));
    if (!t) return null;
    const i = Math.floor((x - tx * span) / step);
    const j = Math.floor((y - ty * span) / step);
    return { t, k: j * TILE + i, x: tx * span + i * step, y: ty * span + j * step };
  }

  /* ---------- drawing ---------- */

  function requestDraw(): void {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw(): void {
    frame = 0;
    if (disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, w, h);

    // Whatever is cached at other zoom levels stands in until the current
    // level arrives: coarse first, the current level on top.
    const level = currentLevel();
    const trees = showTrees ? ":1" : ":0";
    const rank = (t: CachedTile): number => (t.key.endsWith(trees) ? 2 : 0) + (t.level === level ? 1 : 0);
    const visible = [...cache.values()].sort((a, b) => rank(a) - rank(b) || b.level - a.level);
    for (const t of visible) {
      const span = TILE * 2 ** t.level;
      const size = span * scale;
      // Snapped to whole pixels at both edges, so neighbours meet exactly.
      const x0 = Math.round((t.tx * span - cx) * scale + w / 2);
      const y0 = Math.round((t.ty * span - cy) * scale + h / 2);
      const x1 = Math.round(((t.tx + 1) * span - cx) * scale + w / 2);
      const y1 = Math.round(((t.ty + 1) * span - cy) * scale + h / 2);
      if (x0 > w || y0 > h || x1 < 0 || y1 < 0) continue;
      ctx.imageSmoothingEnabled = size < TILE;
      ctx.drawImage(t.canvas, x0, y0, x1 - x0, y1 - y0);
    }

    // The hovered patch: solid, with a white rim, as the game marks a
    // selection on its map.
    if (highlight && showResource[highlight.patch.resource]) {
      const [r, g, b] = resources[highlight.patch.resource]!.color;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      if (highlight.patch.wells.length) {
        // A field is its wells: ring each one.
        for (const well of highlight.patch.wells) {
          ctx.beginPath();
          ctx.arc((well.x + 0.5 - cx) * scale + w / 2, (well.y + 0.5 - cy) * scale + h / 2, Math.max(7, 1.8 * scale), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        ctx.save();
        ctx.translate(w / 2 - cx * scale, h / 2 - cy * scale);
        ctx.scale(scale, scale);
        ctx.fill(highlight.fill);
        ctx.lineWidth = 3 / scale;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(highlight.outline);
        ctx.restore();
      }
    }

    // Spawn: the crashed ship, where the freeplay scenario puts it. Drawn at
    // its real size up close; from far out it stops shrinking, so the start
    // can always be found.
    const marker = mapData?.spawnMarker;
    if (marker && planet === "nauvis" && shipImage.complete && shipImage.naturalWidth > 0) {
      const width = Math.max(marker.width * scale, SHIP_MIN_WIDTH);
      const height = width * (marker.height / marker.width);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(shipImage, (marker.x - cx) * scale + w / 2 - width / 2, (marker.y - cy) * scale + h / 2 - height / 2, width, height);
    } else {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.fillStyle = "#ffe6c0";
      ctx.beginPath();
      ctx.arc((0 - cx) * scale + w / 2, (0 - cy) * scale + h / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /* ---------- hover ---------- */

  function tooltipLine(className: string, text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  function placeTooltip(clientX: number, clientY: number): void {
    const pad = 16;
    const rect = tooltipEl.getBoundingClientRect();
    const left = clientX + pad + rect.width > window.innerWidth ? clientX - pad - rect.width : clientX + pad;
    const top = clientY + pad + rect.height > window.innerHeight ? clientY - pad - rect.height : clientY + pad;
    tooltipEl.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }

  function showPatchTooltip(patch: PatchMeasure): void {
    const layer = resources[patch.resource]!;
    // A field is where its wells are, not where its outline happens to reach.
    const n = patch.wells.length;
    const centreX = n ? patch.wells.reduce((sum, well) => sum + well.x, 0) / n : patch.x0 + patch.width / 2;
    const centreY = n ? patch.wells.reduce((sum, well) => sum + well.y, 0) / n : patch.y0 + patch.height / 2;
    const lines = [tooltipLine("seed-tip-title", prettyName(layer.name))];
    if (layer.normalYield) {
      lines.push(
        tooltipLine("seed-tip-amount", `${whole((patch.amount / layer.normalYield) * 100)}%`),
        tooltipLine("seed-tip-detail", `${patch.wells.length} ${patch.wells.length === 1 ? "well" : "wells"}, total yield`),
      );
    } else {
      lines.push(
        tooltipLine("seed-tip-amount", shortNumber(patch.amount)),
        tooltipLine("seed-tip-detail", `${whole(patch.amount)} in ${whole(patch.entities)} tiles`),
      );
    }
    if (!patch.complete) lines.push(tooltipLine("seed-tip-detail", "too large to measure in full"));
    lines.push(tooltipLine("seed-tip-detail", `${whole(Math.hypot(centreX, centreY))} tiles from spawn`));
    tooltipEl.replaceChildren(...lines);
    tooltipEl.hidden = false;
    placeTooltip(...pointer);
  }

  function clearHover(): void {
    window.clearTimeout(hoverTimer);
    patchRequest++;
    tooltipEl.hidden = true;
    if (highlight) {
      highlight = null;
      requestDraw();
    }
  }

  /** Describe what is under the cursor, and measure the patch if it is one. */
  function hover(clientX: number, clientY: number): void {
    pointer = [clientX, clientY];
    const [wx, wy] = worldAt(clientX, clientY);
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    const parts = [`${x}, ${y}`];
    const hit = tiles.length ? sampleAt(x, y) : null;
    const res = hit ? hit.t.resource[hit.k]! : 0;
    if (hit) {
      parts.push(prettyName(tiles[hit.t.tile[hit.k]!]!.name));
      if (res) parts.push(prettyName(resources[res - 1]!.name));
      if (hit.t.enemy[hit.k]) parts.push("enemies can spawn here");
    }
    parts.push(`${whole(Math.hypot(x, y))} tiles from spawn`);
    readoutEl.textContent = parts.join("  ·  ");

    if (!hit || !res || !showResource[res - 1]) {
      clearHover();
      return;
    }
    // Still on the patch already measured: only the tooltip moves.
    const p = highlight?.patch;
    if (p && p.resource === res - 1) {
      const i = hit.x - p.x0;
      const j = hit.y - p.y0;
      const onPatch = i >= 0 && j >= 0 && i < p.width && j < p.height && p.mask[j * p.width + i] === 1;
      // A well's square reaches a tile past the field it stands in.
      const onWell = p.wells.some((well) => Math.abs(well.x - hit.x) <= 2 && Math.abs(well.y - hit.y) <= 2);
      if (onPatch || onWell) {
        placeTooltip(clientX, clientY);
        return;
      }
    }
    clearHover();
    tooltipEl.replaceChildren(tooltipLine("seed-tip-title", prettyName(resources[res - 1]!.name)), tooltipLine("seed-tip-detail", "measuring…"));
    tooltipEl.hidden = false;
    placeTooltip(clientX, clientY);
    const request = ++patchRequest;
    hoverTimer = window.setTimeout(() => {
      const entry = pool.find((e) => e.ready === generation && !e.busy) ?? pool.find((e) => e.ready === generation);
      if (entry) post(entry, { type: "patch", generation, request, x: hit.x, y: hit.y });
    }, HOVER_DELAY);
  }

  /* ---------- panel ---------- */

  function patchAmountText(p: PatchInfo, layer: ResourceLayer): string {
    if (layer.normalYield) return `${p.entities} ${p.entities === 1 ? "well" : "wells"}`;
    return shortNumber(p.amount);
  }

  function swatch(color: readonly [number, number, number]): HTMLElement {
    const el = document.createElement("span");
    el.className = "seed-swatch";
    el.style.background = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    return el;
  }

  function layerToggle(label: string, color: readonly [number, number, number], checked: boolean, onChange: (on: boolean) => void): HTMLElement {
    const row = document.createElement("label");
    row.className = "seed-layer";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    const text = document.createElement("span");
    text.textContent = label;
    row.append(box, swatch(color), text);
    return row;
  }

  function renderLayers(): void {
    layersEl.replaceChildren(
      ...resources.map((r, i) =>
        layerToggle(prettyName(r.name), r.color, showResource[i]!, (on) => {
          showResource[i] = on;
          clearHover();
          repaintAll();
          renderPatches();
        }),
      ),
      layerToggle("Enemy bases", colors.enemy, showEnemies, (on) => {
        showEnemies = on;
        repaintAll();
      }),
      // Trees are generated per tile image, so switching them fetches the
      // map again; without them it fills in roughly twice as fast.
      layerToggle("Trees", colors.tree, showTrees, (on) => {
        showTrees = on;
        queue = [];
        schedule();
        requestDraw();
      }),
      layerToggle("Cliffs", colors.cliff, showCliffs, (on) => {
        showCliffs = on;
        repaintAll();
      }),
    );
  }

  function renderPatches(): void {
    if (patches.length === 0) {
      const note = document.createElement("p");
      note.className = "seed-note";
      note.textContent = generation ? "Surveying…" : "";
      patchesEl.replaceChildren(note);
      return;
    }
    const rows: HTMLElement[] = [];
    if (bases.length) {
      const nearest = bases.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
      const note = document.createElement("button");
      note.type = "button";
      note.className = "seed-patch";
      const name = document.createElement("span");
      name.className = "seed-patch-name";
      name.textContent = "Nearest enemy base";
      const where = document.createElement("span");
      where.className = "seed-patch-where";
      where.textContent = `${Math.round(Math.hypot(nearest.x, nearest.y))} ${bearing(nearest.x, nearest.y)}`;
      note.append(swatch(colors.enemy), name, where);
      note.addEventListener("click", () => flyTo(nearest.x, nearest.y));
      rows.push(note);
    }
    for (const p of patches.filter((q) => showResource[q.resource]).slice(0, 60)) {
      const layer = resources[p.resource]!;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "seed-patch";
      const name = document.createElement("span");
      name.className = "seed-patch-name";
      name.textContent = `${prettyName(layer.name)}${p.starting ? " (start)" : ""}`;
      const where = document.createElement("span");
      where.className = "seed-patch-where";
      where.textContent = `${Math.round(Math.hypot(p.x, p.y))} ${bearing(p.x, p.y)}`;
      const amount = document.createElement("span");
      amount.className = "seed-patch-amount";
      amount.textContent = patchAmountText(p, layer);
      row.append(swatch(layer.color), name, where, amount);
      row.addEventListener("click", () => flyTo(p.x, p.y));
      rows.push(row);
    }
    patchesEl.replaceChildren(...rows);
  }

  /* ---------- camera ---------- */

  let urlTimer = 0;
  function writeUrl(): void {
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const query = new URLSearchParams({ seed: String(seed), x: String(Math.round(cx)), y: String(Math.round(cy)), z: String(Number(scale.toPrecision(3))) });
      // Only what differs from the defaults, so a plain link stays short.
      if (dataset && dataset.id !== datasets[0]?.id) query.set("v", dataset.id);
      if (planet !== "nauvis") query.set("planet", planet);
      if (presetName !== "default") query.set("preset", presetName);
      if (mapType && mapType !== presetMapType()) query.set("type", mapType);
      if (isCustom(custom)) {
        const has = (o: object): boolean => Object.keys(o).length > 0;
        query.set(
          "cfg",
          JSON.stringify({
            c: has(custom.controls) ? custom.controls : undefined,
            m: has(custom.climate) ? custom.climate : undefined,
            s: custom.startingArea ?? undefined,
            w: custom.width ?? undefined,
            h: custom.height ?? undefined,
          }),
        );
      }
      // replaceState, not location.hash: a hashchange would remount the tool.
      history.replaceState(null, "", `#/seed-viewer?${query}`);
    }, 250);
  }

  function viewChanged(): void {
    cx = Math.max(-1e6, Math.min(1e6, cx));
    cy = Math.max(-1e6, Math.min(1e6, cy));
    schedule();
    requestDraw();
    writeUrl();
  }

  function flyTo(x: number, y: number): void {
    cx = x;
    cy = y;
    scale = Math.max(scale, 1);
    viewChanged();
  }

  const worldAt = (clientX: number, clientY: number): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [cx + (clientX - rect.left - rect.width / 2) / scale, cy + (clientY - rect.top - rect.height / 2) / scale];
  };

  let drag: { id: number; x: number; y: number } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) {
      cx -= (e.clientX - drag.x) / scale;
      cy -= (e.clientY - drag.y) / scale;
      drag.x = e.clientX;
      drag.y = e.clientY;
      viewChanged();
      return;
    }
    hover(e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) drag = null;
  };

  const onPointerLeave = (): void => {
    clearHover();
    readoutEl.textContent = "";
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [wx, wy] = worldAt(e.clientX, e.clientY);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * Math.exp(-e.deltaY * 0.0015)));
    // Keep the tile under the cursor under the cursor.
    cx = wx - ((wx - cx) * scale) / next;
    cy = wy - ((wy - cy) * scale) / next;
    scale = next;
    viewChanged();
  };

  const onSubmit = (e: SubmitEvent): void => {
    e.preventDefault();
    const parsed = parseSeed(seedInput.value);
    if (parsed === null) {
      statusEl.textContent = "A seed is a whole number from 0 to 4294967295.";
      return;
    }
    seed = parsed;
    cx = 0;
    cy = 0;
    startGeneration();
  };

  const onRandom = (): void => {
    seed = Math.floor(Math.random() * 2 ** 32);
    cx = 0;
    cy = 0;
    startGeneration();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  form.addEventListener("submit", onSubmit);
  versionSelect.addEventListener("change", () => {
    const entry = datasets.find((d) => d.id === versionSelect.value);
    if (entry) loadDataset(entry).catch(fail);
  });
  planetSelect.addEventListener("change", () => {
    // Another world: its own controls, and the camera back at its start.
    planet = planetSelect.value;
    custom = noCustom();
    cx = 0;
    cy = 0;
    renderSettings();
    startGeneration();
  });
  presetSelect.addEventListener("change", () => {
    // Choosing a preset starts from it, as in the game: sliders and map
    // type go back to what the preset says.
    presetName = presetSelect.value;
    mapType = null;
    custom = noCustom();
    renderSettings();
    startGeneration();
  });
  mapTypeSelect.addEventListener("change", () => {
    mapType = mapTypeSelect.value;
    startGeneration();
  });
  container.querySelector("#seed-random")!.addEventListener("click", onRandom);
  const resize = new ResizeObserver(() => {
    schedule();
    requestDraw();
  });
  resize.observe(canvas);

  seedInput.value = String(seed);
  statusEl.textContent = "Loading map data…";
  const fetchJson = async <T>(file: string): Promise<T> => {
    const response = await fetch(`${DATA_DIR}/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return (await response.json()) as T;
  };

  /** Load one game version's data and start over with it. */
  async function loadDataset(entry: DatasetEntry): Promise<void> {
    statusEl.textContent = "Loading map data…";
    const loaded = await fetchJson<MapGenData>(entry.file);
    if (disposed) return;
    mapData = loaded;
    dataset = entry;
    // Each worker keeps the data it was first sent; a new version resends it.
    dataSent = false;
    tiles = [];
    if (loaded.spawnMarker) shipImage.src = `${DATA_DIR}/${loaded.spawnMarker.file}`;
    renderSettings();
    startGeneration();
  }

  const fail = (error: unknown): void => {
    statusEl.textContent = `Could not load map data: ${error instanceof Error ? error.message : String(error)}`;
  };

  fetchJson<DatasetEntry[]>("index.json")
    .then((index) => {
      if (disposed) return;
      datasets = index;
      const wanted = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("v");
      const entry = index.find((e) => e.id === wanted) ?? index[0];
      if (!entry) throw new Error("no map data has been generated");
      return loadDataset(entry);
    })
    .catch(fail);

  return () => {
    disposed = true;
    window.clearTimeout(urlTimer);
    window.clearTimeout(hoverTimer);
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    for (const entry of pool) entry.worker.terminate();
    container.innerHTML = "";
  };
}
