/** Every knob the Overlay Lab exposes: which layers draw, and how. Kept in
 *  one plain object so the whole look can be copied out as JSON and pasted
 *  into a conversation or a later implementation. */

export interface LabSettings {
  layers: {
    dim: boolean;
    lanes: boolean;
    rings: boolean;
    hover: boolean;
    /** Items on belts and in inserter hands, plus how busy each arm is. */
    items: boolean;
    ports: boolean;
  };
  style: {
    dimAmount: number;
    palette: PaletteName;
    laneStyle: "strips" | "tint" | "edges";
    laneWidth: number;
    laneHideIdle: boolean;
    ringStyle: "ring" | "light" | "bar" | "fill";
    ringLabel: "always" | "hover" | "never";
    ringThickness: number;
    armStyle: "carry" | "arc" | "dot";
    itemStyle: "icons" | "dots";
    labelScale: number;
    /** Below this zoom (screen pixels per tile) labels and small marks fade
     *  out, so a zoomed-out view stays calm. */
    detailZoom: number;
  };
}

export type PaletteName = "factorio" | "colorblind" | "muted";

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
  layers: { dim: true, lanes: true, rings: true, hover: true, items: false, ports: false },
  style: {
    dimAmount: 0.45,
    palette: "factorio",
    laneStyle: "edges",
    laneWidth: 0.14,
    laneHideIdle: false,
    ringStyle: "fill",
    ringLabel: "always",
    ringThickness: 0.14,
    armStyle: "carry",
    itemStyle: "icons",
    labelScale: 1,
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
    return {
      layers: { ...DEFAULTS.layers, ...saved.layers },
      style: { ...DEFAULTS.style, ...saved.style },
    };
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
