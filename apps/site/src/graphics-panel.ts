/** The Graphics window's contents: pick a render preset (or leave it on
 *  auto, from the device guess), then switch single settings on top. */
import "./rate-overlay/rate-overlay.css"; // the lab-* form styles it shares
import type { RenderQuality } from "@factoriotools/renderer";
import { activePreset, deviceClass, graphicsSettings, PRESET_LABELS, PRESETS, setGraphics, type PresetChoice } from "./render-presets.js";

export const GRAPHICS_WINDOW_HTML = `
  <div class="gui-titlebar"><span>Graphics</span><span class="grip" aria-hidden="true"></span></div>
  <div class="gui-body"><div class="graphics-panel"></div></div>`;

const RATIOS: [number, string][] = [[1, "1×"], [1.5, "1.5×"], [2, "2×"], [Infinity, "Full"]];
const FPS: [number, string][] = [[30, "30"], [60, "60"]];

function seg<T>(attr: string, items: [T, string][], cur: T) {
  return `<div class="segmented lab-seg" ${attr}>${items
    .map(([v, l]) => `<button type="button" data-value="${String(v)}" class="${v === cur ? "is-active" : ""}">${l}</button>`)
    .join("")}</div>`;
}

export function renderGraphicsPanel(el: HTMLElement) {
  const s = graphicsSettings();
  const detected = deviceClass();
  const preset = activePreset();
  const q: RenderQuality = { ...PRESETS[preset], ...s.overrides };
  const custom = Object.keys(s.overrides).length > 0;
  const choices: [PresetChoice, string][] = [
    ["auto", `Auto (${PRESET_LABELS[detected.preset]})`],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
  ];
  el.innerHTML = `
    <p class="lab-note">This device: ${detected.summary}. Auto picks <strong>${PRESET_LABELS[detected.preset]}</strong>.</p>
    <span class="lab-field-label">Preset</span>
    ${seg("data-gfx-preset", choices, s.choice)}
    <span class="lab-field-label">Settings${custom ? ` <span class="graphics-custom">changed from ${PRESET_LABELS[preset]}</span>` : ""}</span>
    <label class="lab-check"><input type="checkbox" data-gfx="animation" ${q.animation ? "checked" : ""}> Belt animation</label>
    <label class="lab-check"><input type="checkbox" data-gfx="shadows" ${q.shadows ? "checked" : ""}> Shadows</label>
    <span class="lab-field-label">Resolution</span>
    ${seg("data-gfx-ratio", RATIOS, q.maxPixelRatio)}
    <span class="lab-field-label">Frame rate cap</span>
    ${seg("data-gfx-fps", FPS, q.maxFps)}
    ${custom ? `<div class="lab-row graphics-reset"><button type="button" data-gfx-reset>Back to ${PRESET_LABELS[preset]}</button></div>` : ""}
    <p class="lab-note">Lower settings draw fewer pixels and less often, which keeps phones cool and responsive. Moving belts need animation on.</p>`;
}

/** Sets one setting on top of the preset, dropping it again when it
 *  matches the preset anyway. */
function override<K extends keyof RenderQuality>(key: K, value: RenderQuality[K]) {
  const s = graphicsSettings();
  if (PRESETS[activePreset()][key] === value) delete s.overrides[key];
  else s.overrides[key] = value;
  setGraphics(s);
}

export function wireGraphicsPanel(el: HTMLElement, signal: AbortSignal) {
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLButtonElement>("[data-value]");
    const group = b?.parentElement;
    if (b && group?.hasAttribute("data-gfx-preset")) {
      // A preset replaces everything set by hand.
      setGraphics({ choice: b.dataset.value as PresetChoice, overrides: {} });
    } else if (b && group?.hasAttribute("data-gfx-ratio")) {
      override("maxPixelRatio", Number(b.dataset.value));
    } else if (b && group?.hasAttribute("data-gfx-fps")) {
      override("maxFps", Number(b.dataset.value));
    } else if (t.closest("[data-gfx-reset]")) {
      setGraphics({ choice: graphicsSettings().choice, overrides: {} });
    } else return;
    renderGraphicsPanel(el);
  }, { signal });
  el.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.gfx as "animation" | "shadows" | undefined;
    if (!key) return;
    override(key, input.checked);
    renderGraphicsPanel(el);
  }, { signal });
  renderGraphicsPanel(el);
}
