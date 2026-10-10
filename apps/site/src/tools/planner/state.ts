/** What the planner remembers: the targets, the display unit and every
 *  setting the player changed. Kept in localStorage and in the address bar
 *  (`#/planner?p=...`), so a plan can be shared as a link. */

import { DEFAULT_SETTINGS, type PlanSettings, type PlannerData } from "@factoriotools/engine";

export type TimeUnit = "s" | "min" | "h";
export type View = "flow" | "table";

export interface PlannerState {
  /** Rates are stored per second; the unit only changes how they show. */
  targets: { item: string; rate: number }[];
  unit: TimeUnit;
  view: View;
  belt: string;
  settings: PlanSettings;
}

export const UNIT_SECONDS: Record<TimeUnit, number> = { s: 1, min: 60, h: 3600 };

const STORAGE_KEY = "factoriotools.planner.v1";

export function defaultState(): PlannerState {
  return {
    targets: [],
    unit: "min",
    view: "flow",
    belt: "express-transport-belt",
    settings: structuredClone(DEFAULT_SETTINGS),
  };
}

/** Rebuilds a state from untrusted JSON (a shared link, old storage),
 *  keeping only names the dataset knows. */
function sanitise(raw: unknown, pd: PlannerData): PlannerState {
  const state = defaultState();
  if (!raw || typeof raw !== "object") return state;
  const r = raw as Partial<PlannerState>;
  if (Array.isArray(r.targets)) {
    state.targets = r.targets
      .filter((t) => t && typeof t.item === "string" && pd.items[t.item] && Number.isFinite(t.rate) && t.rate >= 0)
      .slice(0, 24)
      .map((t) => ({ item: t.item, rate: t.rate }));
  }
  if (r.unit === "s" || r.unit === "min" || r.unit === "h") state.unit = r.unit;
  if (r.view === "flow" || r.view === "table") state.view = r.view;
  if (typeof r.belt === "string" && pd.belts.some((b) => b.name === r.belt)) state.belt = r.belt;
  const s = r.settings as Partial<PlanSettings> | undefined;
  if (s && typeof s === "object") {
    const out = state.settings;
    const machine = (v: unknown) => typeof v === "string" && pd.machines[v] ? v : undefined;
    out.assembler = machine(s.assembler) ?? out.assembler;
    out.furnace = machine(s.furnace) ?? out.furnace;
    out.drill = machine(s.drill) ?? out.drill;
    out.preferSpaceAge = s.preferSpaceAge === true;
    if (typeof s.fuel === "string" && pd.fuelValue[s.fuel]) out.fuel = s.fuel;
    if (s.defaultModule === "" || (typeof s.defaultModule === "string" && pd.modules[s.defaultModule])) out.defaultModule = s.defaultModule;
    if (Number.isInteger(s.defaultBeacons) && s.defaultBeacons! >= 0 && s.defaultBeacons! <= 16) out.defaultBeacons = s.defaultBeacons!;
    if (typeof s.defaultBeaconModule === "string" && pd.modules[s.defaultBeaconModule]) out.defaultBeaconModule = s.defaultBeaconModule;
    if (Number.isInteger(s.miningProductivity) && s.miningProductivity! >= 0 && s.miningProductivity! <= 1000) out.miningProductivity = s.miningProductivity!;
    if (s.research && typeof s.research === "object") {
      for (const [k, v] of Object.entries(s.research)) {
        if (pd.productivityTechnologies[k] && Number.isInteger(v) && v >= 0 && v <= 1000) out.research[k] = v;
      }
    }
    if (s.recipeFor && typeof s.recipeFor === "object") {
      for (const [k, v] of Object.entries(s.recipeFor)) {
        if (pd.items[k] && typeof v === "string" && (v === "import" || pd.recipes[v])) out.recipeFor[k] = v;
      }
    }
    if (s.machineFor && typeof s.machineFor === "object") {
      for (const [k, v] of Object.entries(s.machineFor)) if (pd.recipes[k] && machine(v)) out.machineFor[k] = v;
    }
    if (s.modulesFor && typeof s.modulesFor === "object") {
      for (const [k, v] of Object.entries(s.modulesFor)) {
        if (!pd.recipes[k] || !v || typeof v !== "object" || !Array.isArray(v.modules)) continue;
        out.modulesFor[k] = {
          modules: v.modules.filter((m) => typeof m === "string" && pd.modules[m]).slice(0, 16),
          beacons: Number.isInteger(v.beacons) && v.beacons >= 0 && v.beacons <= 16 ? v.beacons : 0,
          beaconModule: typeof v.beaconModule === "string" && pd.modules[v.beaconModule] ? v.beaconModule : "",
        };
      }
    }
    if (Array.isArray(s.excluded)) out.excluded = s.excluded.filter((id) => typeof id === "string" && pd.recipes[id]);
  }
  return state;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Only what differs from the defaults goes into links and storage. */
function compact(state: PlannerState): unknown {
  const d = defaultState();
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state.settings)) {
    const dv = (d.settings as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(v) !== JSON.stringify(dv)) settings[k] = v;
  }
  return {
    targets: state.targets,
    ...(state.unit !== d.unit ? { unit: state.unit } : {}),
    ...(state.view !== d.view ? { view: state.view } : {}),
    ...(state.belt !== d.belt ? { belt: state.belt } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

export function loadState(pd: PlannerData): PlannerState {
  const query = window.location.hash.split("?")[1];
  const param = query ? new URLSearchParams(query).get("p") : null;
  if (param) {
    try {
      return sanitise(JSON.parse(fromBase64Url(param)), pd);
    } catch {
      // A mangled link: fall through to what was here last time.
    }
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return sanitise(JSON.parse(stored), pd);
  } catch {
    // Storage blocked or corrupt.
  }
  return defaultState();
}

export function shareLink(state: PlannerState): string {
  const url = new URL(window.location.href);
  url.hash = `#/planner?p=${toBase64Url(JSON.stringify(compact(state)))}`;
  return url.toString();
}

export function saveState(state: PlannerState): void {
  const json = JSON.stringify(compact(state));
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // Private window or full storage: the link still carries it.
  }
  // Keep the address bar shareable without adding history entries.
  const hash = state.targets.length ? `#/planner?p=${toBase64Url(json)}` : "#/planner";
  if (window.location.hash !== hash) history.replaceState(null, "", hash);
}
