/** Overlay Lab: a playground for the on-map rate calculator. The real
 *  renderer draws the blueprint with the real camera (drag to pan, scroll
 *  to zoom); a transparent canvas above it draws the overlay layers from a
 *  live simulation. Every layer can be toggled and restyled, and the whole
 *  look can be copied out as JSON. Reachable at #/overlay-lab; it works on
 *  whatever blueprint is open in the Blueprint Editor. */
import { getData, getRenderCatalog, loadData } from "@factoriotools/engine";
import { mountRenderer, type BlueprintRenderer } from "@factoriotools/renderer";
import { makeFloatingWindow, type FloatingWindow } from "../../window-manager.js";
import { RateOverlay } from "../../rate-overlay/controller.js";
import { clockText, renderLayerList, renderPortList, RESEARCH_HTML, simSummaryHtml, wireLayerList, wirePortList, wireResearch } from "../../rate-overlay/panels.js";
import { DEFAULTS, PALETTES, type LabSettings } from "../../rate-overlay/settings.js";
import { getCurrentBlueprint } from "../../current-blueprint.js";
import { currentQuality, onQualityChange } from "../../render-presets.js";
import { GRAPHICS_WINDOW_HTML, wireGraphicsPanel } from "../../graphics-panel.js";

const TEMPLATE = `
  <div id="lab-stage" class="schematic-frame"></div>

  <div id="window-toolbar">
    <button type="button" data-toggle="lab-layers">Layers</button>
    <button type="button" data-toggle="lab-style">Style</button>
    <button type="button" data-toggle="lab-sim">Simulation</button>
    <button type="button" data-toggle="lab-ports">Ports</button>
    <button type="button" data-toggle="lab-graphics">Graphics</button>
  </div>

  <div id="lab-graphics" class="gui-window floating-window lab-window" hidden>${GRAPHICS_WINDOW_HTML}</div>

  <div id="lab-layers" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Layers</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body"><div id="lab-layer-list" class="lab-layer-list"></div></div>
  </div>

  <div id="lab-style" class="gui-window floating-window lab-window lab-style-window" hidden>
    <div class="gui-titlebar"><span>Style</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <div id="lab-style-body"></div>
      <div class="lab-row lab-style-actions">
        <button type="button" id="lab-copy-settings">Copy settings</button>
        <button type="button" id="lab-reset-settings">Reset</button>
        <span class="lab-note" id="lab-copy-status"></span>
      </div>
      <textarea id="lab-settings-json" class="lab-paste" rows="6" readonly hidden></textarea>
    </div>
  </div>

  <div id="lab-sim" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Simulation</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <div class="lab-row">
        <button type="button" id="lab-play">Pause</button>
        <div class="segmented" role="group" aria-label="Speed" id="lab-speed">
          <button type="button" data-speed="1" class="is-active">1×</button>
          <button type="button" data-speed="4">4×</button>
          <button type="button" data-speed="16">16×</button>
        </div>
        <span class="lab-clock" id="lab-clock">0:00</span>
      </div>
      <div class="lab-row">
        <button type="button" id="lab-warm">Skip ahead 60 s</button>
        <button type="button" id="lab-restart">Restart</button>
      </div>
      <div id="lab-research">${RESEARCH_HTML}</div>
      <div id="lab-sim-summary" class="lab-summary"></div>
      <p class="lab-note">Belts, splitters, undergrounds and belt stacking are simulated per lane, 1:1. Machines and inserters use a rough stand-in until the simulation's second phase, so their numbers are close, not exact.</p>
    </div>
  </div>

  <div id="lab-ports" class="gui-window floating-window lab-window lab-ports-window" hidden>
    <div class="gui-titlebar"><span>Ports</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <p class="lab-note">Every open belt end is a port, and so is an inserter connected on one side only. Switch any of them on or off here or by clicking its tab on the map. A belt input takes its items from a constant combinator or display panel next to it, or a requester or infinity chest behind it; a belt that machines in the blueprint fill gets nothing from outside; anything else is guessed from what the machines downstream need.</p>
      <div id="lab-port-list" class="lab-port-list"></div>
    </div>
  </div>

  <div id="lab-loading" class="lab-loading">Loading game data…</div>
  <div id="lab-empty" class="lab-empty-state" hidden>
    <p>Nothing to look at yet. The lab works on the blueprint open in the Blueprint Editor.</p>
    <a href="#/blueprint-editor">Open the Blueprint Editor</a>
  </div>
`;

type Choice<T extends string> = { value: T; label: string }[];

export function mountOverlayLab(root: HTMLElement): () => void {
  root.innerHTML = TEMPLATE;
  root.classList.add("overlay-lab-root");
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const controller = new AbortController();
  const { signal } = controller;
  let destroyed = false;
  let renderer: BlueprintRenderer | undefined;

  const stage = $("#lab-stage");
  const overlay = new RateOverlay(stage, {
    cardHost: root,
    onUpdate: () => renderSim(),
    onPortsChange: () => {
      if (portsOpen()) renderPortList($("#lab-port-list"), overlay);
    },
  });
  const persist = () => overlay.saveSettings();

  /* ---------- windows ---------- */
  const right = Math.max(16, window.innerWidth - 356);
  const windows: Record<string, FloatingWindow> = {
    "lab-layers": makeFloatingWindow($("#lab-layers"), { x: 16, y: 96, width: 320 }),
    "lab-style": makeFloatingWindow($("#lab-style"), { x: right, y: 96, width: 340 }),
    "lab-sim": makeFloatingWindow($("#lab-sim"), { x: 16, y: Math.max(96, window.innerHeight - 330), width: 320 }),
    "lab-ports": makeFloatingWindow($("#lab-ports"), { x: 340, y: 96, width: 380 }),
    "lab-graphics": makeFloatingWindow($("#lab-graphics"), { x: right, y: 96, width: 340 }),
  };
  const portsOpen = () => !windows["lab-ports"]!.el.hidden;
  for (const w of Object.values(windows)) w.hide();
  windows["lab-layers"]!.show();
  const syncToolbar = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
      b.classList.toggle("is-active", !windows[b.dataset.toggle!]!.el.hidden);
    }
    overlay.forcePorts = portsOpen();
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
    b.addEventListener("click", () => {
      const w = windows[b.dataset.toggle!]!;
      if (w.el.hidden) {
        w.show();
        w.bringToFront();
        if (b.dataset.toggle === "lab-ports") renderPortList($("#lab-port-list"), overlay);
      } else w.hide();
      syncToolbar();
    }, { signal });
  }
  for (const w of Object.values(windows)) w.el.querySelector(".gui-close")?.addEventListener("click", () => queueMicrotask(syncToolbar), { signal });
  syncToolbar();

  /* ---------- layers and style ---------- */
  wireLayerList($("#lab-layer-list"), overlay, signal);
  function segmented<T extends string>(key: keyof LabSettings["style"], choices: Choice<T>) {
    const cur = overlay.settings.style[key];
    return `<div class="segmented lab-seg" data-style="${key}">${choices
      .map((c) => `<button type="button" data-value="${c.value}" class="${c.value === cur ? "is-active" : ""}">${c.label}</button>`)
      .join("")}</div>`;
  }
  function slider(key: keyof LabSettings["style"], min: number, max: number, step: number, fmt: (v: number) => string) {
    const v = overlay.settings.style[key] as number;
    return `<div class="lab-slider"><input type="range" id="lab-s-${key}" data-style="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="lab-slider-value" data-value-for="${key}">${fmt(v)}</span></div>`;
  }

  const FORMATS: Partial<Record<keyof LabSettings["style"], (v: number) => string>> = {
      laneWidth: (v) => `${v.toFixed(2)} tile`,
    ringThickness: (v) => `${v.toFixed(2)} tile`,
    labelScale: (v) => `${v.toFixed(2)}×`,
    detailZoom: (v) => `${Math.round(v)} px/tile`,
  };
  function renderStyle() {
    const group = (title: string, body: string) => `<section class="lab-group"><h3>${title}</h3>${body}</section>`;
    $("#lab-style-body").innerHTML = [
      group("Colours", segmented("palette", [
        { value: "factorio", label: "Factorio" },
        { value: "colorblind", label: "Colour-blind" },
        { value: "muted", label: "Muted" },
      ]) + `<div class="lab-swatches">${swatches()}</div>`),
      group("Sizes", `<span class="lab-field-label">Lane width</span>` + slider("laneWidth", 0.04, 0.3, 0.01, FORMATS.laneWidth!) + `<span class="lab-field-label">Machine ring and bar</span>` + slider("ringThickness", 0.06, 0.4, 0.02, FORMATS.ringThickness!)),
      group("Rates", segmented("rateUnit", [
        { value: "s", label: "Per second" },
        { value: "min", label: "Per minute" },
        { value: "h", label: "Per hour" },
      ])),
      group("Labels and zoom", slider("labelScale", 0.7, 1.6, 0.05, FORMATS.labelScale!) + `<span class="lab-field-label">Detail appears from</span>` + slider("detailZoom", 6, 48, 1, FORMATS.detailZoom!)),
    ].join("");
  }
  function swatches() {
    const p = PALETTES[overlay.settings.style.palette];
    return ([["ok", "Working"], ["warn", "Inserter-bound"], ["bad", "Starved"], ["held", "Backed up"]] as const)
      .map(([k, l]) => `<span class="lab-swatch"><i style="background:${p[k]}"></i>${l}</span>`)
      .join("");
  }
  const styleBody = $("#lab-style-body");
  styleBody.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".lab-seg button");
    if (!btn) return;
    const key = btn.parentElement!.dataset.style as keyof LabSettings["style"];
    (overlay.settings.style as Record<string, unknown>)[key] = btn.dataset.value;
    persist();
    renderStyle();
    renderLayerList($("#lab-layer-list"), overlay.settings); // chip colours follow the palette
  }, { signal });
  styleBody.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.style as keyof LabSettings["style"] | undefined;
    if (!key) return;
    if (input.type === "checkbox") (overlay.settings.style as Record<string, unknown>)[key] = input.checked;
    else {
      (overlay.settings.style as Record<string, unknown>)[key] = parseFloat(input.value);
      const label = styleBody.querySelector(`[data-value-for="${key}"]`);
      if (label) label.textContent = FORMATS[key]!(parseFloat(input.value));
    }
    persist();
  }, { signal });
  $("#lab-reset-settings").addEventListener("click", () => {
    overlay.settings = structuredClone(DEFAULTS);
    persist();
    renderLayerList($("#lab-layer-list"), overlay.settings);
    renderStyle();
  }, { signal });
  $("#lab-copy-settings").addEventListener("click", () => {
    const json = JSON.stringify(overlay.settings, null, 2);
    const status = $("#lab-copy-status");
    const box = $<HTMLTextAreaElement>("#lab-settings-json");
    navigator.clipboard.writeText(json).then(
      () => {
        status.textContent = "Copied.";
        box.hidden = true;
      },
      () => {
        status.textContent = "Copy blocked. Select the text below.";
        box.value = json;
        box.hidden = false;
        box.select();
      },
    );
  }, { signal });
  renderLayerList($("#lab-layer-list"), overlay.settings);
  renderStyle();

  /* ---------- simulation ---------- */
  function renderSim() {
    $("#lab-clock").textContent = clockText(overlay);
    $("#lab-play").textContent = overlay.playing ? "Pause" : "Play";
    $("#lab-sim-summary").innerHTML = simSummaryHtml(overlay);
  }
  $("#lab-play").addEventListener("click", () => {
    overlay.playing = !overlay.playing;
    renderSim();
  }, { signal });
  $("#lab-speed").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-speed]");
    if (!b) return;
    overlay.speed = Number(b.dataset.speed);
    for (const x of $("#lab-speed").querySelectorAll("button")) x.classList.toggle("is-active", x === b);
    overlay.playing = true;
    renderSim();
  }, { signal });
  $("#lab-warm").addEventListener("click", () => overlay.skip(3600), { signal });
  $("#lab-restart").addEventListener("click", () => overlay.rebuild(), { signal });
  wireResearch($("#lab-research"), overlay, signal);
  wirePortList($("#lab-port-list"), overlay, signal);
  wireGraphicsPanel($(".graphics-panel"), signal);
  const stopQuality = onQualityChange((q) => renderer?.setQuality(q));

  void (async () => {
    await loadData();
    if (destroyed) return;
    renderer = mountRenderer(stage, getData(), getRenderCatalog(), currentQuality());
    overlay.attach(renderer);
    overlay.setEnabled(true);
    $("#lab-loading").hidden = true;
    const entities = getCurrentBlueprint();
    $("#lab-empty").hidden = entities.length > 0;
    renderer.loadBlueprint(entities);
    overlay.load(entities);
  })();

  return () => {
    destroyed = true;
    controller.abort();
    stopQuality();
    overlay.destroy();
    renderer?.destroy();
    for (const w of Object.values(windows)) w.destroy();
    root.classList.remove("overlay-lab-root");
    root.innerHTML = "";
  };
}
