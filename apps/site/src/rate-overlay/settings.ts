/** Every knob the Overlay Lab exposes: which layers draw, and how. Kept in
 *  one plain object so the whole look can be copied out as JSON and pasted
 *  into a conversation or a later implementation. */

import type { MachineStatus } from "./factory.js";

/** What a lane signal says about one lane of one tile. */
export type LaneState = "flow" | "held" | "empty" | "short";

export interface LabSettings {
  layers: {
    dim: boolean;
    lanes: boolean;
    rings: boolean;
    hover: boolean;
    /** Items on belts and in inserter hands, plus how busy each arm is. */
    items: boolean;
    ports: boolean;
    /** Lamps, display panels, combinator outputs, wires carrying signals
     *  and buildings a circuit switched off. */
    circuits: boolean;
  };
  style: {
    dimAmount: number;
    palette: PaletteName;
    laneStyle: "strips" | "tint" | "edges";
    laneWidth: number;
    /** Which lane states get a mark; switch some off to see only, say,
     *  the lanes that back up. */
    laneStates: Record<LaneState, boolean>;
    ringStyle: "ring" | "light" | "bar" | "fill";
    /** Which machine states get a mark and a label; switch the healthy
     *  ones off to see only what's wrong. */
    statuses: Record<MachineStatus, boolean>;
    ringLabel: "always" | "hover" | "never";
    ringThickness: number;
    armStyle: "carry" | "arc" | "dot";
    itemStyle: "icons" | "dots";
    labelScale: number;
    /** Time unit for every rate shown: machine labels, port tabs, cards. */
    rateUnit: RateUnit;
    /** Below this zoom (screen pixels per tile) labels and small marks fade
     *  out, so a zoomed-out view stays calm. */
    detailZoom: number;
  };
}

export type PaletteName = "factorio" | "colorblind" | "muted";
export type RateUnit = "s" | "min" | "h";

export const PER: Record<RateUnit, number> = { s: 1, min: 60, h: 3600 };

/** An items-per-second rate in the chosen unit, compact: 0.75/s, 45/min,
 *  2.7k/h. */
export function formatRate(perSecond: number, unit: RateUnit): string {
  const v = perSecond * PER[unit];
  const n = v >= 9995 ? `${(v / 1000).toFixed(0)}k` : v >= 999.5 ? `${(v / 1000).toFixed(1)}k` : v >= 99.5 ? v.toFixed(0) : v >= 9.95 ? v.toFixed(1) : v.toFixed(2);
  return `${n}/${unit}`;
}

export interface Palette {
  ok: string;
  warn: string;
  bad: string;
  held: string;
  idle: string;
  accent: string;
}

export const PALETTES: Record<PaletteName, Palette> = {
  factorio: { ok: "#93d977", warn: "#f2c14e", bad: "#e2765a", held: "#86a8ff", idle: "#a5a19a", accent: "#ffcc80" },
  // Okabe–Ito hues, lifted for a dark background.
  colorblind: { ok: "#56b4e9", warn: "#f0e442", bad: "#e69f00", held: "#cc79a7", idle: "#a5a19a", accent: "#ffcc80" },
  muted: { ok: "#7fae6a", warn: "#c9a55a", bad: "#b86f5c", held: "#7d8fbf", idle: "#8d8981", accent: "#d9b27a" },
};

export const DEFAULTS: LabSettings = {
  layers: { dim: true, lanes: true, rings: true, hover: true, items: false, ports: false, circuits: true },
  style: {
    dimAmount: 0.45,
    palette: "factorio",
    laneStyle: "strips",
    laneWidth: 0.14,
    laneStates: { flow: true, held: true, empty: true, short: true },
    ringStyle: "fill",
    statuses: { working: true, arm: true, starved: true, output: true, idle: true },
    ringLabel: "always",
    ringThickness: 0.14,
    armStyle: "carry",
    itemStyle: "icons",
    labelScale: 1,
    rateUnit: "min",
    detailZoom: 18,
  },
};

// v2: new defaults (the chosen look); older saved settings are ignored.
const KEY = "overlay-lab:settings:v2";

export function loadSettings(): LabSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw) as Partial<LabSettings>;
    const style = { ...DEFAULTS.style, ...saved.style } as LabSettings["style"] & { laneHideIdle?: boolean };
    // The two filters are objects: merge them too, so a state added later
    // starts out shown.
    style.statuses = { ...DEFAULTS.style.statuses, ...saved.style?.statuses };
    style.laneStates = { ...DEFAULTS.style.laneStates, ...saved.style?.laneStates };
    // Older settings had a single "hide empty lanes" switch.
    if (style.laneHideIdle) style.laneStates.empty = false;
    delete style.laneHideIdle;
    return { layers: { ...DEFAULTS.layers, ...saved.layers }, style };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: LabSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private window or storage blocked — the lab still works, it just
    // won't remember.
  }
}
