/** Render presets: how much drawing work the page may do, picked from a
 *  rough read of the device so a phone starts out usable, and changeable
 *  from the Graphics window. The renderer and the rate overlay both follow
 *  whatever is current. */
import { FULL_QUALITY, type RenderQuality } from "@factoriotools/renderer";

export type PresetName = "low" | "medium" | "high";
export type PresetChoice = PresetName | "auto";

export const PRESETS: Record<PresetName, RenderQuality> = {
  // Old or small phones: one device pixel per CSS pixel, no shadows, belts
  // standing still, so a static view costs nothing after the first frame.
  low: { maxPixelRatio: 1, animation: false, shadows: false, maxFps: 30 },
  // Most phones and tablets: sharper, moving belts, still no shadows.
  medium: { maxPixelRatio: 1.5, animation: true, shadows: false, maxFps: 30 },
  high: { ...FULL_QUALITY, maxPixelRatio: 2 },
};

export const PRESET_LABELS: Record<PresetName, string> = { low: "Low", medium: "Medium", high: "High" };

export interface DeviceClass {
  preset: PresetName;
  /** What the guess was based on, for the Graphics window. */
  summary: string;
}

interface NavigatorHints {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

/** A coarse guess from what the browser tells about the device: CPU cores,
 *  memory (Chromium only, capped at 8 GB), touch input, screen size and the
 *  data-saver switch. It only picks a starting point; the Graphics window
 *  overrides it. */
export function classifyDevice(): DeviceClass {
  const nav = navigator as Navigator & NavigatorHints;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory;
  const touch = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width, screen.height) < 600;
  const saveData = nav.connection?.saveData === true;
  const parts = [`${cores} cores`];
  if (memory !== undefined) parts.push(`${memory} GB memory`);
  if (touch) parts.push("touch screen");
  if (small) parts.push("small screen");
  if (saveData) parts.push("data saver on");
  const weak = cores <= 2 || (memory !== undefined && memory <= 2) || saveData;
  const phone = touch && small;
  let preset: PresetName;
  if (weak || (phone && (cores <= 4 || (memory !== undefined && memory <= 4)))) preset = "low";
  else if (phone || touch || cores <= 4 || (memory !== undefined && memory <= 4)) preset = "medium";
  else preset = "high";
  return { preset, summary: parts.join(", ") };
}

/** The saved choice: a preset (or auto), plus any single settings changed
 *  by hand on top of it. */
export interface GraphicsSettings {
  choice: PresetChoice;
  overrides: Partial<RenderQuality>;
}

const KEY = "factoriotools.graphics";

function load(): GraphicsSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<GraphicsSettings> | null;
    if (saved && typeof saved.choice === "string") return { choice: saved.choice, overrides: saved.overrides ?? {} };
  } catch {
    // Storage blocked or unreadable: fall back to auto.
  }
  return { choice: "auto", overrides: {} };
}

let settings = load();
const detected = classifyDevice();
const listeners = new Set<(q: RenderQuality) => void>();

export function deviceClass(): DeviceClass {
  return detected;
}

export function graphicsSettings(): GraphicsSettings {
  return { choice: settings.choice, overrides: { ...settings.overrides } };
}

/** The preset in effect: the chosen one, or the detected one on auto. */
export function activePreset(): PresetName {
  return settings.choice === "auto" ? detected.preset : settings.choice;
}

export function currentQuality(): RenderQuality {
  const q = { ...PRESETS[activePreset()], ...settings.overrides };
  // Respect the system's reduced-motion setting whatever the preset says.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) q.animation = false;
  return q;
}

export function setGraphics(next: GraphicsSettings): void {
  settings = { choice: next.choice, overrides: { ...next.overrides } };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, but still applied for this visit.
  }
  const q = currentQuality();
  for (const l of listeners) l(q);
}

/** Calls `cb` with the new quality whenever the settings change. Returns
 *  an unsubscribe function. */
export function onQualityChange(cb: (q: RenderQuality) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
