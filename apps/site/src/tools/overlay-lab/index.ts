/** Overlay Lab: a playground for the on-map rate calculator. The real
 *  renderer draws the blueprint with the real camera (drag to pan, scroll
 *  to zoom); a transparent canvas above it draws the overlay layers from a
 *  live simulation. Every layer can be toggled and restyled, and the whole
 *  look can be copied out as JSON. Reachable at #/overlay-lab, and built on
 *  its own as lab.html. */
import "./overlay-lab.css";
import { getData, getRenderCatalog, loadData, type PlacedEntity } from "@factoriotools/engine";
import { getSharedIconAtlas, mountRenderer, type BlueprintRenderer } from "@factoriotools/renderer";
import type { LaneFeed, Port } from "@factoriotools/sim";
import { makeFloatingWindow, type FloatingWindow } from "../../window-manager.js";
import { escapeHtml } from "../blueprint-viewer/html.js";
import { BUILDS, entitiesFromString } from "./builds.js";
import { LabFactory, machineStatus, type MachineSim } from "./factory.js";
import { detectIssues, itemLabel, recipeLabel, type Issue } from "./issues.js";
import { drawOverlay, laneState, statusColor, type HoverTarget } from "./overlay.js";
import { DEFAULTS, loadSettings, PALETTES, saveSettings, type LabSettings } from "./settings.js";

const TEMPLATE = `
  <div id="lab-stage" class="schematic-frame"></div>

  <div id="window-toolbar">
    <button type="button" data-toggle="lab-builds">Blueprints</button>
    <button type="button" data-toggle="lab-layers">Layers</button>
    <button type="button" data-toggle="lab-style">Style</button>
    <button type="button" data-toggle="lab-issues">Issues <span class="lab-count" id="lab-issue-count"></span></button>
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

  <div id="lab-issues" class="gui-window floating-window lab-window" hidden>
    <div class="gui-titlebar"><span>Issues</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <p class="lab-note">Ranked by lost output. Pick one to trace it on the map.</p>
      <div id="lab-issue-list" class="lab-issue-list"></div>
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
      <div id="lab-sim-summary" class="lab-summary"></div>
      <p class="lab-note">Belts, splitters and undergrounds are simulated per lane, 1:1. Machines and inserters use a rough stand-in until the simulation's second phase, and belt stacking isn't modelled yet.</p>
    </div>
  </div>

  <div id="lab-ports" class="gui-window floating-window lab-window lab-ports-window" hidden>
    <div class="gui-titlebar"><span>Ports</span><span class="grip" aria-hidden="true"></span></div>
    <div class="gui-body">
      <p class="lab-note">Blueprints don't record what's on a belt, so every open belt end is a port. Inputs start with a guess from what the machines downstream need.</p>
      <div id="lab-port-list" class="lab-port-list"></div>
    </div>
  </div>

  <div id="lab-card" class="machine-tooltip gui-window lab-card" hidden><div class="gui-body" id="lab-card-body"></div></div>
  <div id="lab-loading" class="lab-loading">Loading game data…</div>
`;

const LAYER_INFO: { key: keyof LabSettings["layers"]; label: string; hint: string; concept: string }[] = [
  { key: "dim", label: "Dim the build", hint: "Pushes the sprites back so the signals read.", concept: "A" },
  { key: "lanes", label: "Lane signals", hint: "One mark per lane per tile: flowing, backed up, empty, running dry.", concept: "A" },
  { key: "rings", label: "Machine status", hint: "Uptime and why a machine isn't working.", concept: "A" },
  { key: "items", label: "Items on belts", hint: "The simulated items, per lane.", concept: "sim" },
  { key: "arms", label: "Inserter activity", hint: "What each arm carries, or how busy it is.", concept: "A" },
  { key: "ports", label: "Port tabs", hint: "Where belts enter and leave, with rates.", concept: "A" },
  { key: "issues", label: "Issue markers and trace", hint: "Numbered problems; the selected one is traced.", concept: "D" },
  { key: "hover", label: "Hover card", hint: "Details for whatever is under the cursor.", concept: "A" },
];

type Choice<T extends string> = { value: T; label: string }[];

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
  let issues: Issue[] = [];
  let selected: Issue | undefined;
  let hover: HoverTarget | undefined;
  let pointer: { x: number; y: number } | undefined;
  let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let speed = 1;
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
    "lab-issues": makeFloatingWindow($("#lab-issues"), { x: right, y: 96, width: 340 }),
    "lab-sim": makeFloatingWindow($("#lab-sim"), { x: 16, y: Math.max(96, window.innerHeight - 330), width: 320 }),
    "lab-ports": makeFloatingWindow($("#lab-ports"), { x: 340, y: 96, width: 380 }),
  };
  for (const w of Object.values(windows)) w.hide();
  windows["lab-layers"]!.show();
  windows["lab-issues"]!.show();
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
    $("#lab-layer-list").innerHTML = LAYER_INFO.map(
      (l) => `
      <label class="lab-layer">
        <input type="checkbox" data-layer="${l.key}" ${settings.layers[l.key] ? "checked" : ""}>
        <span class="lab-layer-text"><span class="lab-layer-name">${l.label}<span class="lab-tag">${l.concept}</span></span><span class="lab-layer-hint">${l.hint}</span></span>
      </label>`,
    ).join("");
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
      group("Inserters and items", segmented("armStyle", [
        { value: "carry", label: "Carried item" },
        { value: "arc", label: "Swing arc" },
        { value: "dot", label: "Busy dot" },
      ]) + segmented("itemStyle", [
        { value: "icons", label: "Item icons" },
        { value: "dots", label: "Dots" },
      ])),
      group("Issue trace", segmented("traceStyle", [
        { value: "glow", label: "Glow" },
        { value: "solid", label: "Solid" },
        { value: "quiet", label: "Quiet" },
      ]) + toggle("badges", "Numbered step labels")),
      group("Labels and zoom", slider("labelScale", 0.7, 1.6, 0.05, FORMATS.labelScale!) + `<span class="lab-field-label">Detail appears from</span>` + slider("detailZoom", 6, 48, 1, FORMATS.detailZoom!) + toggle("pulse", "Animate problems")),
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

  function start(entities: PlacedEntity[], feeds?: (typeof BUILDS)[number]["feeds"]) {
    if (destroyed || !renderer) return;
    currentEntities = entities;
    factory = new LabFactory(getData(), entities);
    for (const f of feeds ?? []) {
      const port = factory.net.ports.find((p) => p.kind === "input" && p.x === f.x && p.y === f.y);
      if (port) factory.setInput(port.id, f.left, f.right);
    }
    // Start from a running factory rather than an empty one.
    factory.step(1800);
    selected = undefined;
    hover = undefined;
    issues = detectIssues(factory);
    renderer.loadBlueprint(entities);
    renderIssues();
    renderPorts();
    renderSim();
  }

  /* ---------- issues ---------- */
  function renderIssues() {
    const list = $("#lab-issue-list");
    $("#lab-issue-count").textContent = issues.length ? String(issues.length) : "";
    if (!factory) return;
    if (!issues.length) {
      list.innerHTML = `<p class="lab-empty">Nothing is holding this build back.</p>`;
      return;
    }
    const pal = PALETTES[settings.style.palette];
    const unit = (i: Issue) => itemLabel(factory!.data, i.machines[0]!.products[0]?.name ?? "");
    const html = issues
      .map((issue, i) => {
        const col = issue.tone === "warn" ? pal.warn : issue.tone === "held" ? pal.held : pal.bad;
        return `<button type="button" class="lab-issue ${selected?.id === issue.id ? "is-active" : ""}" data-issue="${escapeHtml(issue.id)}" style="--tone:${col}">
          <span class="lab-issue-rank">${i + 1}</span>
          <span class="lab-issue-text"><span class="lab-issue-title">${escapeHtml(issue.title)}</span><span class="lab-issue-lost">−${issue.lost.toFixed(2)} ${escapeHtml(unit(issue))}/s</span></span>
        </button>`;
      })
      .join("");
    if (list.dataset.last !== html) {
      list.innerHTML = html;
      list.dataset.last = html;
    }
  }
  $("#lab-issue-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-issue]");
    if (!b || !renderer) return;
    const issue = issues.find((i) => i.id === b.dataset.issue);
    if (!issue) return;
    if (selected?.id === issue.id) selected = undefined;
    else {
      selected = issue;
      renderer.camera.frame(issue.focus, stage.clientWidth, stage.clientHeight, 3);
    }
    renderIssues();
  }, { signal });

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
    renderIssues();
    renderSim();
  }, { signal });
  $("#lab-restart").addEventListener("click", () => {
    if (!factory) return;
    const inputs = [...factory.inputs];
    const outputs = [...factory.outputs];
    const entities = currentEntities;
    currentEntities = entities;
    factory = new LabFactory(getData(), entities);
    for (const [id, [l, r]] of inputs) factory.setInput(id, l, r);
    for (const [id, m] of outputs) factory.setOutput(id, m);
    selected = undefined;
    issues = [];
    renderIssues();
    renderSim();
  }, { signal });

  /* ---------- ports ---------- */
  function portPlace(p: Port) {
    return `${p.x}, ${p.y}`;
  }
  function renderPorts() {
    if (!factory) return;
    const f = factory;
    const options = (cur: LaneFeed | null) =>
      `<option value="">(empty)</option>` +
      [...new Set([...f.knownItems, ...(cur ? [cur.item] : [])])]
        .map((n) => `<option value="${escapeHtml(n)}" ${cur?.item === n ? "selected" : ""}>${escapeHtml(itemLabel(f.data, n))}</option>`)
        .join("");
    const inputs = f.net.ports.filter((p) => p.kind === "input");
    const fed = inputs.filter((p) => f.inputs.get(p.id)?.some(Boolean));
    const unfed = inputs.filter((p) => !f.inputs.get(p.id)?.some(Boolean));
    const row = (p: Port) => {
      const [l, r] = f.inputs.get(p.id) ?? [null, null];
      return `<div class="lab-port" data-port="${escapeHtml(p.id)}">
        <span class="lab-port-where">In · ${portPlace(p)}</span>
        <label>Left <select data-lane="0">${options(l)}</select></label>
        <label>Right <select data-lane="1">${options(r)}</select></label>
      </div>`;
    };
    const outputs = f.net.ports.filter((p) => p.kind === "output");
    $("#lab-port-list").innerHTML =
      `<h3>Inputs</h3>${fed.map(row).join("") || `<p class="lab-empty">No belt feeds a machine directly.</p>`}` +
      (unfed.length ? `<details><summary>${unfed.length} more open belt starts</summary>${unfed.map(row).join("")}</details>` : "") +
      `<h3>Outputs</h3><details><summary>${outputs.length} open belt ends (all take everything)</summary>${outputs
        .map((p) => `<div class="lab-port" data-port="${escapeHtml(p.id)}"><span class="lab-port-where">Out · ${portPlace(p)}</span><label>Mode <select data-mode><option value="sink" ${f.outputs.get(p.id) !== "blocked" ? "selected" : ""}>Take everything</option><option value="blocked" ${f.outputs.get(p.id) === "blocked" ? "selected" : ""}>Dead end</option></select></label></div>`)
        .join("")}</details>`;
  }
  $("#lab-port-list").addEventListener("change", (e) => {
    if (!factory) return;
    const el = e.target as HTMLSelectElement;
    const id = el.closest<HTMLElement>("[data-port]")?.dataset.port;
    if (!id) return;
    if (el.dataset.mode !== undefined) factory.setOutput(id, el.value as "sink" | "blocked");
    else {
      const cur = [...(factory.inputs.get(id) ?? [null, null])] as [LaneFeed | null, LaneFeed | null];
      cur[Number(el.dataset.lane)] = el.value ? { item: el.value, rate: "full" } : null;
      factory.setInput(id, cur[0], cur[1]);
    }
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
  stage.addEventListener("click", () => {
    if (hover?.kind !== "machine") return;
    const issue = issues.find((i) => i.machines.includes((hover as { machine: MachineSim }).machine));
    if (issue) {
      selected = issue;
      renderIssues();
    }
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
        ${row("Output", `${f.machineRate(m).toFixed(2)} of ${f.machineMaxRate(m).toFixed(2)} ${escapeHtml(itemLabel(f.data, product))}/s`)}
        ${m.ingredients.map((i) => row(escapeHtml(itemLabel(f.data, i.name)), `${m.buffer.get(i.name) ?? 0} in · needs ${f.machineNeed(m, i.name).toFixed(2)}/s`)).join("")}
        <div class="lab-card-why" style="color:${col}">${why}</div>`;
    } else if (hover.kind === "inserter") {
      const ins = hover.inserter;
      html = `<div class="lab-card-title">${escapeHtml(f.data.inserters[ins.entity.name]?.localised ?? ins.entity.name)}</div>
        ${row("Busy", `${Math.round(ins.busy * 100)}%`)}
        ${row("Moving", `${ins.moved.toFixed(2)}/s of ${ins.maxRate.toFixed(2)}`)}
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
        return row(`${lane ? "Right" : "Left"} · ${escapeHtml(what)}`, `${ls.rate.toFixed(2)}/s · ${word}`);
      });
      const name = f.data.belts[node.name]?.localised ?? node.name;
      html = `<div class="lab-card-title">${escapeHtml(name)}</div>${lanes.join("")}
        <div class="lab-card-why">Up to ${(node.speed * 60 / 64).toFixed(1)}/s per lane.</div>`;
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
      if (selected) selected = issues.find((i) => i.id === selected!.id) ?? selected;
      drawOverlay({ ctx: octx, width: w, height: h, dpr, camera: renderer.camera, factory, settings, issues, selected, hover: settings.layers.hover ? hover : undefined, icons, time: now });
      if (now - lastUi > 400) {
        lastUi = now;
        issues = detectIssues(factory);
        renderIssues();
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
