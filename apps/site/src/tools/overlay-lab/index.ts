/** Overlay Lab: a playground for the on-map rate calculator. The real
 *  renderer draws the blueprint with the real camera (drag to pan, scroll
 *  to zoom); a transparent canvas above it draws the overlay layers from a
 *  live simulation. Every layer can be toggled and restyled, and the whole
 *  look can be copied out as JSON. Reachable at #/overlay-lab, and built on
 *  its own as lab.html. */
import "./overlay-lab.css";
import { getData, getRenderCatalog, loadData, type PlacedEntity } from "@factoriotools/engine";
import { getSharedIconAtlas, mountRenderer, type BlueprintRenderer } from "@factoriotools/renderer";
import type { LaneFeed } from "@factoriotools/sim";
import { makeFloatingWindow, type FloatingWindow } from "../../window-manager.js";
import { escapeHtml } from "../blueprint-viewer/html.js";
import { BUILDS, entitiesFromString } from "./builds.js";
import { FULL_RESEARCH, LabFactory, machineStatus, type Research } from "./factory.js";
import { detectIssues, itemLabel, recipeLabel, type Issue } from "./issues.js";
import { drawOverlay, laneState, statusColor, type HoverTarget } from "./overlay.js";
import { DEFAULTS, formatRate, loadSettings, PALETTES, saveSettings, type LabSettings } from "./settings.js";

const TEMPLATE = `
  <div id="lab-stage" class="schematic-frame"></div>

  <div id="window-toolbar">
    <button type="button" data-toggle="lab-builds">Blueprints</button>
    <button type="button" data-toggle="lab-layers">Layers</button>
    <button type="button" data-toggle="lab-style">Style</button>
    <button type="button" data-toggle="lab-sim">Simulation</button>
    <button type="button" data-toggle="lab-ports">Ports</button>
  </div>

  <div id="lab-builds" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Blueprints</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <div class="lab-build-list" id="lab-build-list"></div>
      <label class="lab-field-label" for="lab-paste">Or paste a blueprint string</label>
      <textarea id="lab-paste" class="lab-paste" rows="3" placeholder="0eNq…" spellcheck="false"></textarea>
      <div class="lab-row"><button type="button" id="lab-paste-load" class="primary">Load</button><span class="lab-note" id="lab-paste-status"></span></div>
    </div>
  </div>

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
      <span class="lab-field-label">Inserter capacity research</span>
      <div class="segmented lab-seg" id="lab-hands">
        <button type="button" data-hands="none">None</button>
        <button type="button" data-hands="full">Full</button>
      </div>
      <span class="lab-field-label">Belt stacking (items per slot)</span>
      <div class="segmented lab-seg" id="lab-stack">
        <button type="button" data-stack="1">1</button>
        <button type="button" data-stack="2">2</button>
        <button type="button" data-stack="3">3</button>
        <button type="button" data-stack="4">4</button>
      </div>
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

  <div id="lab-card" class="machine-tooltip gui-window lab-card" hidden><div class="gui-body" id="lab-card-body"></div></div>
  <div id="lab-loading" class="lab-loading">Loading game data…</div>
`;

const LAYER_INFO: { key: keyof LabSettings["layers"]; label: string; hint: string; group: "main" | "extra" }[] = [
  { key: "dim", label: "Dim the build", hint: "Pushes the sprites back so the signals read.", group: "main" },
  { key: "lanes", label: "Lane signals", hint: "One mark per lane per tile: flowing, backed up, empty, running dry.", group: "main" },
  { key: "rings", label: "Machine status", hint: "Uptime and why a machine isn't working.", group: "main" },
  { key: "hover", label: "Hover card", hint: "Details for whatever is under the cursor.", group: "main" },
  { key: "items", label: "Render items", hint: "Items on belts and in inserter hands, and how busy each arm is.", group: "extra" },
  { key: "ports", label: "Port tabs", hint: "Where belts enter and leave, with rates.", group: "extra" },
];

type Choice<T extends string> = { value: T; label: string }[];

const RESEARCH_KEY = "overlay-lab:research";
function loadResearch(): Research {
  try {
    const saved = JSON.parse(localStorage.getItem(RESEARCH_KEY) ?? "null") as Partial<Research> | null;
    return { ...FULL_RESEARCH, ...saved };
  } catch {
    return { ...FULL_RESEARCH };
  }
}
function saveResearch(r: Research) {
  try {
    localStorage.setItem(RESEARCH_KEY, JSON.stringify(r));
  } catch {
    // Storage blocked: the choice just won't be remembered.
  }
}

export interface LabOptions {
  /** Hide links back into the main app (the standalone lab.html build). */
  standalone?: boolean;
}

export function mountOverlayLab(root: HTMLElement, _options: LabOptions = {}): () => void {
  root.innerHTML = TEMPLATE;
  root.classList.add("overlay-lab-root");
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const controller = new AbortController();
  const { signal } = controller;
  let destroyed = false;
  let settings = loadSettings();

  const stage = $("#lab-stage");
  let renderer: BlueprintRenderer | undefined;
  let factory: LabFactory | undefined;
  // Problems are still found (lane signals use them to mark belts running
  // dry for a starved machine), but the issue list and trace are parked.
  let issues: Issue[] = [];
  let hover: HoverTarget | undefined;
  let pointer: { x: number; y: number } | undefined;
  let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let speed = 1;
  let research: Research = loadResearch();
  let currentFeeds: (typeof BUILDS)[number]["feeds"];
  let currentBuild = 0;
  let currentEntities: PlacedEntity[] = [];
  const icons = getSharedIconAtlas();

  const overlay = document.createElement("canvas");
  overlay.className = "lab-overlay";
  const octx = overlay.getContext("2d")!;

  /* ---------- windows ---------- */
  const right = Math.max(16, window.innerWidth - 356);
  const windows: Record<string, FloatingWindow> = {
    "lab-builds": makeFloatingWindow($("#lab-builds"), { x: 16, y: 96, width: 300 }),
    "lab-layers": makeFloatingWindow($("#lab-layers"), { x: 16, y: 96, width: 320 }),
    "lab-style": makeFloatingWindow($("#lab-style"), { x: right, y: 96, width: 340 }),
    "lab-sim": makeFloatingWindow($("#lab-sim"), { x: 16, y: Math.max(96, window.innerHeight - 330), width: 320 }),
    "lab-ports": makeFloatingWindow($("#lab-ports"), { x: 340, y: 96, width: 380 }),
  };
  for (const w of Object.values(windows)) w.hide();
  windows["lab-layers"]!.show();
  const syncToolbar = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
      b.classList.toggle("is-active", !windows[b.dataset.toggle!]!.el.hidden);
    }
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
    b.addEventListener("click", () => {
      const w = windows[b.dataset.toggle!]!;
      if (w.el.hidden) {
        w.show();
        w.bringToFront();
        if (b.dataset.toggle === "lab-ports") renderPorts();
      } else w.hide();
      syncToolbar();
    }, { signal });
  }
  for (const w of Object.values(windows)) w.el.querySelector(".gui-close")?.addEventListener("click", () => queueMicrotask(syncToolbar), { signal });
  syncToolbar();

  /* ---------- settings UI ---------- */
  const persist = () => saveSettings(settings);

  function renderLayers() {
    const row = (l: (typeof LAYER_INFO)[number]) => `
      <label class="lab-layer">
        <input type="checkbox" data-layer="${l.key}" ${settings.layers[l.key] ? "checked" : ""}>
        <span class="lab-layer-text"><span class="lab-layer-name">${l.label}</span><span class="lab-layer-hint">${l.hint}</span></span>
      </label>`;
    $("#lab-layer-list").innerHTML =
      LAYER_INFO.filter((l) => l.group === "main").map(row).join("") +
      `<h3 class="lab-layer-heading">Extra options</h3>` +
      LAYER_INFO.filter((l) => l.group === "extra").map(row).join("");
  }
  $("#lab-layer-list").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.layer as keyof LabSettings["layers"] | undefined;
    if (!key) return;
    settings.layers[key] = input.checked;
    persist();
  }, { signal });

  function segmented<T extends string>(key: keyof LabSettings["style"], choices: Choice<T>) {
    const cur = settings.style[key];
    return `<div class="segmented lab-seg" data-style="${key}">${choices
      .map((c) => `<button type="button" data-value="${c.value}" class="${c.value === cur ? "is-active" : ""}">${c.label}</button>`)
      .join("")}</div>`;
  }
  function slider(key: keyof LabSettings["style"], min: number, max: number, step: number, fmt: (v: number) => string) {
    const v = settings.style[key] as number;
    return `<div class="lab-slider"><input type="range" id="lab-s-${key}" data-style="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="lab-slider-value" data-value-for="${key}">${fmt(v)}</span></div>`;
  }
  function toggle(key: keyof LabSettings["style"], label: string) {
    return `<label class="lab-check"><input type="checkbox" data-style="${key}" ${settings.style[key] ? "checked" : ""}> ${label}</label>`;
  }
  const FORMATS: Partial<Record<keyof LabSettings["style"], (v: number) => string>> = {
    dimAmount: (v) => `${Math.round(v * 100)}%`,
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
      group("Build dimming", slider("dimAmount", 0, 0.85, 0.05, FORMATS.dimAmount!)),
      group("Lanes", segmented("laneStyle", [
        { value: "strips", label: "Strips" },
        { value: "edges", label: "Edges" },
        { value: "tint", label: "Tile tint" },
      ]) + slider("laneWidth", 0.04, 0.3, 0.01, FORMATS.laneWidth!) + toggle("laneHideIdle", "Hide empty lanes")),
      group("Machines", segmented("ringStyle", [
        { value: "ring", label: "Ring" },
        { value: "light", label: "Light" },
        { value: "bar", label: "Bar" },
        { value: "fill", label: "Fill" },
      ]) + segmented("ringLabel", [
        { value: "always", label: "Label always" },
        { value: "hover", label: "On hover" },
        { value: "never", label: "Never" },
      ]) + slider("ringThickness", 0.06, 0.4, 0.02, FORMATS.ringThickness!)),
      group("Rendered items", segmented("armStyle", [
        { value: "carry", label: "Carried item" },
        { value: "arc", label: "Swing arc" },
        { value: "dot", label: "Busy dot" },
      ]) + segmented("itemStyle", [
        { value: "icons", label: "Item icons" },
        { value: "dots", label: "Dots" },
      ])),
      group("Rates", segmented("rateUnit", [
        { value: "s", label: "Per second" },
        { value: "min", label: "Per minute" },
        { value: "h", label: "Per hour" },
      ])),
      group("Labels and zoom", slider("labelScale", 0.7, 1.6, 0.05, FORMATS.labelScale!) + `<span class="lab-field-label">Detail appears from</span>` + slider("detailZoom", 6, 48, 1, FORMATS.detailZoom!)),
    ].join("");
  }
  function swatches() {
    const p = PALETTES[settings.style.palette];
    return ([["ok", "Working"], ["warn", "Inserter-bound"], ["bad", "Starved"], ["held", "Backed up"]] as const)
      .map(([k, l]) => `<span class="lab-swatch"><i style="background:${p[k]}"></i>${l}</span>`)
      .join("");
  }
  const styleBody = $("#lab-style-body");
  styleBody.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".lab-seg button");
    if (!btn) return;
    const key = btn.parentElement!.dataset.style as keyof LabSettings["style"];
    (settings.style as Record<string, unknown>)[key] = btn.dataset.value;
    persist();
    renderStyle();
  }, { signal });
  styleBody.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.style as keyof LabSettings["style"] | undefined;
    if (!key) return;
    if (input.type === "checkbox") (settings.style as Record<string, unknown>)[key] = input.checked;
    else {
      (settings.style as Record<string, unknown>)[key] = parseFloat(input.value);
      const label = styleBody.querySelector(`[data-value-for="${key}"]`);
      if (label) label.textContent = FORMATS[key]!(parseFloat(input.value));
    }
    persist();
  }, { signal });
  $("#lab-reset-settings").addEventListener("click", () => {
    settings = structuredClone(DEFAULTS);
    persist();
    renderLayers();
    renderStyle();
  }, { signal });
  $("#lab-copy-settings").addEventListener("click", () => {
    const json = JSON.stringify(settings, null, 2);
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
  renderLayers();
  renderStyle();

  /* ---------- blueprints ---------- */
  function renderBuilds() {
    $("#lab-build-list").innerHTML = BUILDS.map(
      (b, i) => `<button type="button" class="lab-build ${i === currentBuild ? "is-active" : ""}" data-build="${i}"><span class="lab-build-name">${escapeHtml(b.label)}</span><span class="lab-build-note">${escapeHtml(b.note)}</span></button>`,
    ).join("");
  }
  $("#lab-build-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-build]");
    if (b) void openBuild(Number(b.dataset.build));
  }, { signal });
  $("#lab-paste-load").addEventListener("click", () => {
    const status = $("#lab-paste-status");
    try {
      const entities = entitiesFromString($<HTMLTextAreaElement>("#lab-paste").value);
      currentBuild = -1;
      renderBuilds();
      start(entities);
      status.textContent = `${entities.length} entities`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "That isn't a blueprint string.";
    }
  }, { signal });

  async function openBuild(i: number) {
    currentBuild = i;
    renderBuilds();
    const build = BUILDS[i]!;
    try {
      start(await build.entities(), build.feeds);
    } catch (err) {
      $("#lab-paste-status").textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function start(entities: PlacedEntity[], feeds?: (typeof BUILDS)[number]["feeds"], reframe = true) {
    if (destroyed || !renderer) return;
    currentEntities = entities;
    currentFeeds = feeds;
    factory = new LabFactory(getData(), entities, research);
    for (const f of feeds ?? []) {
      const port = factory.net.ports.find((p) => p.kind === "input" && p.x === f.x && p.y === f.y);
      if (port) factory.setInput(port.id, f.left, f.right);
    }
    // Start from a running factory rather than an empty one.
    factory.step(1800);
    hover = undefined;
    issues = detectIssues(factory);
    if (reframe) renderer.loadBlueprint(entities);
    renderPorts();
    renderSim();
  }

  /* ---------- simulation window ---------- */
  function renderSim() {
    if (!factory) return;
    const secs = Math.floor(factory.tick / 60);
    $("#lab-clock").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    $("#lab-play").textContent = playing ? "Pause" : "Play";
    const counts: Record<string, number> = {};
    for (const m of factory.machines) counts[machineStatus(m)] = (counts[machineStatus(m)] ?? 0) + 1;
    const pal = PALETTES[settings.style.palette];
    const rows = (["working", "arm", "starved", "output", "idle"] as const)
      .filter((k) => counts[k])
      .map((k) => `<span class="lab-swatch"><i style="background:${statusColor(pal, k)}"></i>${counts[k]} ${({ working: "working", arm: "inserter-bound", starved: "starved", output: "output full", idle: "idle" })[k]}</span>`)
      .join("");
    $("#lab-sim-summary").innerHTML = `${factory.machines.length} machines · ${factory.inserters.length} inserters · ${factory.net.nodes.length} belt tiles<div class="lab-swatches">${rows}</div>`;
  }
  $("#lab-play").addEventListener("click", () => {
    playing = !playing;
    renderSim();
  }, { signal });
  $("#lab-speed").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-speed]");
    if (!b) return;
    speed = Number(b.dataset.speed);
    for (const x of $("#lab-speed").querySelectorAll("button")) x.classList.toggle("is-active", x === b);
    playing = true;
    renderSim();
  }, { signal });
  $("#lab-warm").addEventListener("click", () => {
    factory?.step(3600);
    issues = factory ? detectIssues(factory) : [];
    renderSim();
  }, { signal });
  $("#lab-restart").addEventListener("click", () => {
    if (!factory) return;
    const next = new LabFactory(getData(), currentEntities, research);
    factory.copyPortsTo(next);
    factory = next;
    issues = [];
    renderSim();
  }, { signal });

  const syncResearch = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>("#lab-hands [data-hands]")) b.classList.toggle("is-active", b.dataset.hands === research.hands);
    for (const b of root.querySelectorAll<HTMLButtonElement>("#lab-stack [data-stack]")) b.classList.toggle("is-active", Number(b.dataset.stack) === research.beltStack);
  };
  const changeResearch = (next: Research) => {
    research = next;
    saveResearch(research);
    syncResearch();
    // Hand sizes and stacking change the whole model: rebuild it in place.
    start(currentEntities, currentFeeds, false);
  };
  $("#lab-hands").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-hands]");
    if (b) changeResearch({ ...research, hands: b.dataset.hands as Research["hands"] });
  }, { signal });
  $("#lab-stack").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-stack]");
    if (b) changeResearch({ ...research, beltStack: Number(b.dataset.stack) });
  }, { signal });
  syncResearch();

  /* ---------- ports ---------- */
  let highlightPort: string | undefined;
  const portsOpen = () => !windows["lab-ports"]!.el.hidden;

  function renderPorts() {
    if (!factory) return;
    const f = factory;
    const label = (n: string) => escapeHtml(itemLabel(f.data, n));
    const options = (cur: string | undefined, empty = "(empty)") =>
      `<option value="">${empty}</option>` +
      [...new Set([...f.knownItems, ...(cur ? [cur] : [])])].map((n) => `<option value="${escapeHtml(n)}" ${cur === n ? "selected" : ""}>${label(n)}</option>`).join("");
    const all = f.ports();
    const head = (p: (typeof all)[number]) =>
      `<label class="lab-port-head"><input type="checkbox" data-toggle-port ${p.enabled ? "checked" : ""}>
        <span class="lab-port-where">${p.via === "belt" ? "Belt" : "Arm"} · ${Math.floor(p.x)}, ${Math.floor(p.y)}</span>
        ${p.reason ? `<span class="lab-port-why">${escapeHtml(p.reason)}</span>` : ""}</label>`;
    const row = (p: (typeof all)[number]) => {
      let body = "";
      if (p.kind === "input" && p.via === "belt") {
        const [l, r] = f.inputs.get(p.id) ?? [null, null];
        const stack = (l ?? r)?.stack ?? 1;
        body = `<label>Left <select data-lane="0">${options(l?.item)}</select></label>
          <label>Right <select data-lane="1">${options(r?.item)}</select></label>
          <label>Stacked <select data-stack>${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === stack ? "selected" : ""}>×${n}</option>`).join("")}</select></label>`;
      } else if (p.kind === "input") {
        const arm = f.armPorts.find((a) => a.id === p.id)!;
        const onto = arm.onto ? ` from the ${escapeHtml(arm.onto.replace(/-/g, " "))}` : "";
        body = `<label>Brings${onto} <select data-arm-items>${options(arm.items.length === 1 ? arm.items[0] : undefined, arm.items.length > 1 ? `What the machine needs (${arm.items.length})` : "(nothing)")}</select></label>`;
      }
      return `<div class="lab-port ${p.enabled ? "" : "is-off"}" data-port="${escapeHtml(p.id)}">${head(p)}${body}</div>`;
    };
    const group = (title: string, kind: "input" | "output") => {
      const ps = all.filter((p) => p.kind === kind);
      const main = kind === "input" ? ps.filter((p) => p.via === "arm" || p.items.length) : ps;
      const rest = kind === "input" ? ps.filter((p) => p.via === "belt" && !p.items.length) : [];
      return `<div class="lab-port-group"><h3>${title} <span class="lab-port-count">${ps.filter((p) => p.enabled).length} of ${ps.length} on</span></h3>
        <div class="lab-row"><button type="button" data-all="${kind}" data-on="1">All on</button><button type="button" data-all="${kind}" data-on="0">All off</button></div>
        ${main.map(row).join("") || `<p class="lab-empty">None.</p>`}
        ${rest.length ? `<details><summary>${rest.length} belt starts with nothing on them</summary>${rest.map(row).join("")}</details>` : ""}</div>`;
    };
    $("#lab-port-list").innerHTML = group("Inputs", "input") + group("Outputs", "output");
  }
  const portList = $("#lab-port-list");
  portList.addEventListener("change", (e) => {
    if (!factory) return;
    const el = e.target as HTMLInputElement & HTMLSelectElement;
    const rowEl = el.closest<HTMLElement>("[data-port]");
    const id = rowEl?.dataset.port;
    if (!id || !rowEl) return;
    if (el.dataset.togglePort !== undefined) {
      factory.setPortEnabled(id, el.checked);
    } else if (el.dataset.armItems !== undefined) {
      const arm = factory.armPorts.find((a) => a.id === id)!;
      const needs = arm.inserter.drop.kind === "machine" ? arm.inserter.drop.machine.ingredients.map((i) => i.name) : [];
      factory.setArmPortItems(id, el.value ? [el.value] : needs);
      if (el.value || needs.length) factory.setPortEnabled(id, true);
    } else {
      const cur = [...(factory.inputs.get(id) ?? [null, null])] as [LaneFeed | null, LaneFeed | null];
      const stack = Number(rowEl.querySelector<HTMLSelectElement>("[data-stack]")!.value);
      if (el.dataset.lane !== undefined) cur[Number(el.dataset.lane)] = el.value ? { item: el.value, rate: "full", stack } : null;
      factory.setInput(id, cur[0] && { ...cur[0], stack }, cur[1] && { ...cur[1], stack });
    }
    renderPorts();
  }, { signal });
  portList.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-all]");
    if (!b || !factory) return;
    for (const p of factory.ports()) if (p.kind === b.dataset.all) factory.setPortEnabled(p.id, b.dataset.on === "1");
    renderPorts();
  }, { signal });
  portList.addEventListener("pointerover", (e) => {
    highlightPort = (e.target as HTMLElement).closest<HTMLElement>("[data-port]")?.dataset.port;
  }, { signal });
  portList.addEventListener("pointerleave", () => (highlightPort = undefined), { signal });

  // Clicking a port's tab on the map switches it on or off.
  let portTabs: { id: string; x: number; y: number; w: number; h: number }[] = [];
  let downAt: { x: number; y: number } | undefined;
  stage.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }), { signal, capture: true });
  stage.addEventListener("click", (e) => {
    if (!factory || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const tab = portTabs.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
    if (!tab) return;
    factory.setPortEnabled(tab.id, !factory.portEnabled.get(tab.id));
    if (portsOpen()) renderPorts();
  }, { signal });

  /* ---------- hover ---------- */
  function hitTest(wx: number, wy: number): HoverTarget | undefined {
    if (!factory) return undefined;
    const m = factory.machines.find((m) => wx >= m.box.left && wx < m.box.right && wy >= m.box.top && wy < m.box.bottom);
    if (m) return { kind: "machine", machine: m };
    const ins = factory.inserters.find((i) => Math.abs(i.entity.x - wx) < 0.5 && Math.abs(i.entity.y - wy) < 0.5);
    if (ins) return { kind: "inserter", inserter: ins };
    const node = factory.net.nodeAt(Math.floor(wx), Math.floor(wy));
    if (node?.line) return { kind: "belt", node };
    return undefined;
  }
  stage.addEventListener("pointermove", (e) => {
    if (!renderer) return;
    const r = stage.getBoundingClientRect();
    pointer = { x: e.clientX, y: e.clientY };
    const w = renderer.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top, stage.clientWidth, stage.clientHeight);
    hover = e.buttons ? undefined : hitTest(w.x, w.y);
    renderCard();
  }, { signal });
  stage.addEventListener("pointerleave", () => {
    hover = undefined;
    renderCard();
  }, { signal });
  function renderCard() {
    const card = $("#lab-card");
    if (!hover || !settings.layers.hover || !factory || !pointer) {
      card.hidden = true;
      return;
    }
    const f = factory;
    const pal = PALETTES[settings.style.palette];
    const row = (a: string, b: string) => `<div class="lab-card-row"><span>${a}</span><span>${b}</span></div>`;
    const rate = (perSecond: number) => formatRate(perSecond, settings.style.rateUnit);
    let html = "";
    if (hover.kind === "machine") {
      const m = hover.machine;
      const st = machineStatus(m);
      const col = statusColor(pal, st);
      const product = m.products[0]?.name ?? "";
      const why =
        st === "working" ? "Running at full speed."
        : st === "arm" ? "Waiting on its input inserter between swings."
        : st === "starved" ? `Nothing to take: no ${escapeHtml(itemLabel(f.data, m.missing ?? m.ingredients[0]?.name ?? ""))} reaches its inserter.`
        : st === "output" ? "Its output can't leave fast enough."
        : "Idle.";
      html = `<div class="lab-card-title">${escapeHtml(recipeLabel(f.data, m.recipe))}</div>
        <div class="lab-card-bar"><i style="width:${Math.round(m.uptime * 100)}%;background:${col}"></i></div>
        ${row("Uptime", `${Math.round(m.uptime * 100)}%`)}
        ${row(escapeHtml(itemLabel(f.data, product)), `${rate(f.machineRate(m))} of ${rate(f.machineMaxRate(m))}`)}
        ${m.ingredients.map((i) => row(escapeHtml(itemLabel(f.data, i.name)), `${m.buffer.get(i.name) ?? 0} held · uses ${rate(f.machineNeed(m, i.name))}`)).join("")}
        <div class="lab-card-why" style="color:${col}">${why}</div>`;
    } else if (hover.kind === "inserter") {
      const ins = hover.inserter;
      html = `<div class="lab-card-title">${escapeHtml(f.data.inserters[ins.entity.name]?.localised ?? ins.entity.name)}</div>
        ${row("Busy", `${Math.round(ins.busy * 100)}%`)}
        ${row("Moving", `${rate(ins.moved)} of ${rate(ins.maxRate)}`)}
        ${row("Holding", ins.hand ? `${ins.handCount} × ${escapeHtml(itemLabel(f.data, ins.hand))}` : "nothing")}
        <div class="lab-card-why">${ins.busy > 0.9 ? "Swinging nonstop: this arm is a limit." : ins.pickup.kind === "belt" ? "Mostly waiting for something to pick up." : "Keeping up."}</div>`;
    } else if (hover.kind === "belt") {
      const node = hover.node;
      const lanes = ([0, 1] as const).map((lane) => {
        const ls = laneState(f, node, lane, new Set(issues.flatMap((i) => [...i.nodes])));
        const items = f.belts.laneItems(node.line!, lane);
        const seg = node.line!.lanes[lane].segments[f.belts.segmentOf(node, lane)]!;
        const here = items.filter((i) => i.pos >= seg.start && i.pos < seg.start + seg.length).map((i) => i.item);
        const what = [...new Set(here)].map((n) => itemLabel(f.data, n)).join(", ") || "—";
        const word = { flow: "moving", held: "backed up", empty: "empty", short: "running dry" }[ls.state];
        return row(`${lane ? "Right" : "Left"} · ${escapeHtml(what)}`, `${rate(ls.rate)} · ${word}`);
      });
      const name = f.data.belts[node.name]?.localised ?? node.name;
      html = `<div class="lab-card-title">${escapeHtml(name)}</div>${lanes.join("")}
        <div class="lab-card-why">Up to ${rate((node.speed * 60) / 64)} per lane, times the stack size.</div>`;
    }
    const body = $("#lab-card-body");
    if (body.innerHTML !== html) body.innerHTML = html;
    card.hidden = false;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = pointer.x + 18;
    let y = pointer.y + 16;
    if (x + cw > window.innerWidth - 8) x = pointer.x - cw - 18;
    if (y + ch > window.innerHeight - 8) y = window.innerHeight - ch - 8;
    card.style.transform = `translate(${x}px, ${y}px)`;
  }

  /* ---------- loop ---------- */
  let last = performance.now();
  let acc = 0;
  let lastUi = 0;
  let raf = 0;
  const frame = (now: number) => {
    if (destroyed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (factory && playing) {
      acc += dt * 60 * speed;
      const n = Math.min(600, Math.floor(acc));
      acc -= n;
      factory.step(n);
    }
    if (factory && renderer) {
      const dpr = window.devicePixelRatio || 1;
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
        overlay.width = Math.round(w * dpr);
        overlay.height = Math.round(h * dpr);
      }
      portTabs = drawOverlay({
        ctx: octx,
        width: w,
        height: h,
        dpr,
        camera: renderer.camera,
        factory,
        settings,
        issues,
        hover: settings.layers.hover ? hover : undefined,
        icons,
        showPorts: settings.layers.ports || portsOpen(),
        highlightPort,
      });
      if (now - lastUi > 400) {
        lastUi = now;
        issues = detectIssues(factory);
        renderSim();
        renderCard();
      }
    }
    raf = requestAnimationFrame(frame);
  };

  void (async () => {
    await loadData();
    if (destroyed) return;
    renderer = mountRenderer(stage, getData(), getRenderCatalog());
    stage.appendChild(overlay);
    $("#lab-loading").hidden = true;
    renderBuilds();
    await openBuild(0);
    raf = requestAnimationFrame(frame);
  })();

  return () => {
    destroyed = true;
    cancelAnimationFrame(raf);
    controller.abort();
    renderer?.destroy();
    for (const w of Object.values(windows)) w.destroy();
    root.classList.remove("overlay-lab-root");
    root.innerHTML = "";
  };
}
