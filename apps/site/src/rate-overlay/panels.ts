/** Window contents for a rate overlay: layer switches, the simulation's
 *  summary and research, and the list of ports. Each host lays these out in
 *  its own windows; the markup and behaviour live here once. */
import type { LaneFeed } from "@factoriotools/sim";
import { escapeHtml } from "../tools/blueprint-editor/html.js";
import { CELL, getIconPosition, getSheetSize, onIconsReady, SHEET_URL } from "../tools/blueprint-editor/legacy-view/icons.js";
import type { RateOverlay } from "./controller.js";
import { machineStatus, type LabFactory, type MachineStatus, type PortInfo, type Research } from "./factory.js";
import { itemLabel } from "./issues.js";
import { statusColor } from "./overlay.js";
import { formatRate, PALETTES, PER, type LabSettings, type LaneState, type Palette, type RateUnit } from "./settings.js";

type Layer = keyof LabSettings["layers"];

export const LAYER_INFO: { key: Layer; label: string; hint: string; group: "main" | "extra" }[] = [
  { key: "dim", label: "Dim the build", hint: "Pushes the sprites back so the signals read.", group: "main" },
  { key: "lanes", label: "Lane signals", hint: "One mark per lane per tile: flowing, backed up, empty, running dry.", group: "main" },
  { key: "rings", label: "Machine status", hint: "Uptime and why a machine isn't working.", group: "main" },
  { key: "hover", label: "Hover card", hint: "Details for whatever is under the cursor.", group: "main" },
  { key: "items", label: "Render items", hint: "Items on belts and in inserter hands, and how busy each arm is.", group: "extra" },
  { key: "ports", label: "Port tabs", hint: "Where belts enter and leave, with rates.", group: "extra" },
];

/* ---------- layers ---------- */

type Style = LabSettings["style"];

const STATUS_CHIPS: [MachineStatus, string][] = [
  ["working", "Working"],
  ["arm", "Inserter-bound"],
  ["starved", "Starved"],
  ["output", "Output full"],
  ["idle", "Idle"],
];

const LANE_CHIPS: [LaneState, string][] = [
  ["flow", "Flowing"],
  ["held", "Backed up"],
  ["short", "Running dry"],
  ["empty", "Empty"],
];

function laneChipColor(p: Palette, s: LaneState): string {
  return s === "flow" ? p.ok : s === "held" ? p.held : s === "short" ? p.bad : p.idle;
}

function seg<K extends keyof Style>(key: K, label: string, choices: [Style[K], string][], cur: Style[K]) {
  return `<div class="lab-option"><span class="lab-option-label">${label}</span><div class="segmented lab-seg" data-style="${key}">${choices
    .map(([v, l]) => `<button type="button" data-value="${String(v)}" class="${v === cur ? "is-active" : ""}">${l}</button>`)
    .join("")}</div></div>`;
}

function chips(attr: "data-status" | "data-lane-state", label: string, items: [string, string, string][], on: (k: string) => boolean) {
  return `<div class="lab-option"><span class="lab-option-label">${label}</span><div class="lab-chips">${items
    .map(([k, l, col]) => `<button type="button" class="lab-chip ${on(k) ? "is-on" : ""}" ${attr}="${k}" aria-pressed="${on(k)}"><i style="background:${col}"></i>${l}</button>`)
    .join("")}</div></div>`;
}

/** Each layer's own options, shown under it while it's switched on. */
function layerOptions(key: Layer, s: Style): string {
  const pal = PALETTES[s.palette];
  switch (key) {
    case "dim":
      return `<div class="lab-option"><span class="lab-option-label">Strength</span><div class="lab-slider"><input type="range" data-style="dimAmount" min="0" max="0.85" step="0.05" value="${s.dimAmount}"><span class="lab-slider-value" data-value-for="dimAmount">${Math.round(s.dimAmount * 100)}%</span></div></div>`;
    case "lanes":
      return (
        seg("laneStyle", "Style", [["strips", "Strips"], ["edges", "Edges"], ["tint", "Tile tint"]], s.laneStyle) +
        chips("data-lane-state", "Show lanes that are", LANE_CHIPS.map(([k, l]) => [k, l, laneChipColor(pal, k)]), (k) => s.laneStates[k as LaneState])
      );
    case "rings":
      return (
        seg("ringStyle", "Style", [["fill", "Fill"], ["ring", "Ring"], ["bar", "Bar"], ["light", "Light"]], s.ringStyle) +
        seg("ringLabel", "Rate label", [["always", "Always"], ["hover", "On hover"], ["never", "Never"]], s.ringLabel) +
        chips("data-status", "Show machines that are", STATUS_CHIPS.map(([k, l]) => [k, l, statusColor(pal, k)]), (k) => s.statuses[k as MachineStatus])
      );
    case "items":
      return (
        seg("itemStyle", "Items", [["icons", "Icons"], ["dots", "Dots"]], s.itemStyle) +
        seg("armStyle", "Inserters", [["carry", "Carried item"], ["arc", "Swing arc"], ["dot", "Busy dot"]], s.armStyle)
      );
    default:
      return "";
  }
}

export function renderLayerList(el: HTMLElement, settings: LabSettings) {
  const row = (l: (typeof LAYER_INFO)[number]) => {
    const on = settings.layers[l.key];
    const options = layerOptions(l.key, settings.style);
    return `<div class="lab-layer-item">
      <label class="lab-layer">
        <input type="checkbox" data-layer="${l.key}" ${on ? "checked" : ""}>
        <span class="lab-layer-text"><span class="lab-layer-name">${l.label}</span><span class="lab-layer-hint">${l.hint}</span></span>
      </label>
      ${options ? `<div class="lab-layer-options" ${on ? "" : "hidden"}>${options}</div>` : ""}
    </div>`;
  };
  el.innerHTML =
    LAYER_INFO.filter((l) => l.group === "main").map(row).join("") +
    `<h3 class="lab-layer-heading">Extra options</h3>` +
    LAYER_INFO.filter((l) => l.group === "extra").map(row).join("");
}

/** Wires a layer list: the switches, and every option under them. */
export function wireLayerList(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal, onChange?: () => void) {
  const changed = (rerender: boolean) => {
    overlay.saveSettings();
    if (rerender) renderLayerList(el, overlay.settings);
    onChange?.();
  };
  el.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.layer as Layer | undefined;
    if (!key) return;
    overlay.settings.layers[key] = input.checked;
    changed(true);
  }, { signal });
  el.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type !== "range" || input.dataset.style !== "dimAmount") return;
    overlay.settings.style.dimAmount = parseFloat(input.value);
    const label = el.querySelector('[data-value-for="dimAmount"]');
    if (label) label.textContent = `${Math.round(overlay.settings.style.dimAmount * 100)}%`;
    changed(false);
  }, { signal });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const style = overlay.settings.style;
    const segButton = t.closest<HTMLButtonElement>(".lab-seg[data-style] [data-value]");
    const status = t.closest<HTMLButtonElement>("[data-status]")?.dataset.status as MachineStatus | undefined;
    const laneSt = t.closest<HTMLButtonElement>("[data-lane-state]")?.dataset.laneState as LaneState | undefined;
    if (segButton) {
      const key = segButton.parentElement!.dataset.style as keyof Style;
      (style as Record<string, unknown>)[key] = segButton.dataset.value;
    } else if (status) {
      style.statuses[status] = !style.statuses[status];
    } else if (laneSt) {
      style.laneStates[laneSt] = !style.laneStates[laneSt];
    } else return;
    changed(true);
  }, { signal });
}

/* ---------- rate unit ---------- */

export function rateUnitHtml(settings: LabSettings): string {
  const units: [RateUnit, string][] = [["s", "/s"], ["min", "/min"], ["h", "/h"]];
  return `<div class="segmented lab-seg" data-rate-unit role="group" aria-label="Rates per">${units
    .map(([u, l]) => `<button type="button" data-unit="${u}" class="${settings.style.rateUnit === u ? "is-active" : ""}">${l}</button>`)
    .join("")}</div>`;
}

export function wireRateUnit(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal, onChange?: () => void) {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-rate-unit] [data-unit]");
    if (!b) return;
    overlay.settings.style.rateUnit = b.dataset.unit as RateUnit;
    overlay.saveSettings();
    for (const x of b.parentElement!.querySelectorAll("button")) x.classList.toggle("is-active", x === b);
    onChange?.();
  }, { signal });
}

/* ---------- simulation ---------- */

export function clockText(overlay: RateOverlay): string {
  if (overlay.warming) return "warming up";
  const secs = Math.floor((overlay.factory?.tick ?? 0) / 60);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/* ---------- overview ---------- */

// Start loading the icon sheet's manifest; the overview is redrawn a few
// times a second, so icons simply appear once it's in.
onIconsReady(() => {});

function iconHtml(name: string, size = 18): string {
  const pos = getIconPosition(name);
  if (!pos) return `<span class="icon rate-flow-icon" style="--icon-size:${size}px"></span>`;
  const { width, height } = getSheetSize();
  const k = size / CELL;
  return `<span class="icon rate-flow-icon" style="--icon-size:${size}px;background-image:url(${SHEET_URL});background-position:${-pos.x * k}px ${-pos.y * k}px;background-size:${width * k}px ${height * k}px"></span>`;
}

const MAX_FLOW_ROWS = 5;

/** The Rate Calculator's headline: how efficiently the machines run and
 *  why not more, then what the blueprint takes in and puts out. */
export function overviewHtml(overlay: RateOverlay): string {
  const f = overlay.factory;
  if (!f) return `<span class="lab-empty">Nothing to simulate yet.</span>`;
  if (overlay.warming) return `<span class="lab-empty">Warming up the simulation…</span>`;
  const s = overlay.settings.style;
  const pal = PALETTES[s.palette];
  const rate = (perSecond: number) => formatRate(perSecond, s.rateUnit);
  const label = (n: string) => escapeHtml(itemLabel(f.data, n));

  let eff = "";
  if (f.machines.length) {
    const e = f.efficiency();
    const pct = Math.round(e.uptime * 100);
    const col = e.uptime >= 0.9 ? pal.ok : e.uptime >= 0.6 ? pal.warn : pal.bad;
    const worst = (Object.entries(e.lost) as [keyof typeof e.lost, number][]).sort((a, b) => b[1] - a[1])[0]!;
    const why =
      e.uptime >= 0.95 || worst[1] < 0.02 ? "Running at full speed."
      : worst[0] === "starved" ? `Mostly starved${e.short ? `: short on ${label(e.short)}` : ""}.`
      : worst[0] === "arm" ? "Mostly held back by inserters that can't keep up."
      : "Mostly backed up: products can't leave fast enough.";
    eff = `<div class="rate-eff">
      <div class="rate-eff-head"><span class="rate-eff-pct" style="color:${col}">${pct}%</span><span class="rate-eff-word">efficiency</span><span class="rate-eff-why">${why}</span></div>
      <div class="lab-card-bar"><i style="width:${pct}%;background:${col}"></i></div>
    </div>`;
  }

  const { imports, exports } = f.flows();
  const rows = (list: typeof imports, out: boolean) => {
    if (!list.length) return `<div class="rate-flow-empty">${out ? "Nothing leaves yet." : "Nothing comes in."}</div>`;
    const shown = list.slice(0, MAX_FLOW_ROWS).map((x) => {
      const ofMax = out && x.max > 0 ? `<span class="rate-flow-max">${Math.min(100, Math.round((x.rate / x.max) * 100))}%</span>` : "";
      const rocket = x.rocket ? `<span class="rate-flow-tag">rocket</span>` : "";
      return `<div class="rate-flow">${iconHtml(x.item)}<span class="rate-flow-name">${label(x.item)}${rocket}</span><span class="rate-flow-rate">${rate(x.rate)}</span>${ofMax}</div>`;
    });
    const more = list.length > MAX_FLOW_ROWS ? `<div class="rate-flow-empty">and ${list.length - MAX_FLOW_ROWS} more</div>` : "";
    return shown.join("") + more;
  };

  const counts: Record<string, number> = {};
  for (const m of f.machines) counts[machineStatus(m)] = (counts[machineStatus(m)] ?? 0) + 1;
  const statuses = (["working", "arm", "starved", "output", "idle"] as const)
    .filter((k) => counts[k])
    .map((k) => `<span class="lab-swatch"><i style="background:${statusColor(pal, k)}"></i>${counts[k]} ${({ working: "working", arm: "inserter-bound", starved: "starved", output: "output full", idle: "idle" })[k]}</span>`)
    .join("");

  return `${eff}
    <div class="rate-flows">
      <div class="rate-flow-col"><h4>Imports</h4>${rows(imports, false)}</div>
      <div class="rate-flow-col"><h4>Exports <span class="rate-flow-hint">of max</span></h4>${rows(exports, true)}</div>
    </div>
    <div class="lab-swatches">${statuses}</div>`;
}

export const RESEARCH_HTML = `
  <span class="lab-field-label">Inserter capacity research</span>
  <div class="segmented lab-seg" data-research="hands">
    <button type="button" data-value="none">None</button>
    <button type="button" data-value="full">Full</button>
  </div>
  <span class="lab-field-label">Belt stacking (items per slot)</span>
  <div class="segmented lab-seg" data-research="beltStack">
    <button type="button" data-value="1">1</button>
    <button type="button" data-value="2">2</button>
    <button type="button" data-value="3">3</button>
    <button type="button" data-value="4">4</button>
  </div>`;

export function syncResearch(el: HTMLElement, research: Research) {
  for (const b of el.querySelectorAll<HTMLButtonElement>("[data-research] [data-value]")) {
    const key = b.parentElement!.dataset.research as keyof Research;
    b.classList.toggle("is-active", String(research[key]) === b.dataset.value);
  }
}

export function wireResearch(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal) {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-research] [data-value]");
    if (!b) return;
    const key = b.parentElement!.dataset.research as keyof Research;
    const value = key === "beltStack" ? Number(b.dataset.value) : b.dataset.value;
    overlay.setResearch({ ...overlay.research, [key]: value } as Research);
    syncResearch(el, overlay.research);
  }, { signal });
  syncResearch(el, overlay.research);
}

/* ---------- ports ---------- */

/** Markup for one port's editor: its on/off switch and whatever it can be
 *  set to. The same row goes in the ports list and in the popup a tab
 *  opens on the map. */
function portRows(f: LabFactory, overlay: RateOverlay) {
  const label = (n: string) => escapeHtml(itemLabel(f.data, n));
  // The blueprint's own items first, then every other item to override with.
  const known = new Set(f.knownItems);
  const seen = new Set(f.knownItems.map((n) => itemLabel(f.data, n)));
  const others = Object.keys(f.data.items)
    .filter((n) => f.data.items[n]?.kind === "item" && !known.has(n) && !NOT_CARGO.test(n))
    .sort((a, b) => itemLabel(f.data, a).localeCompare(itemLabel(f.data, b)))
    // Some items share a name (two "Vehicle machine gun"s); offer one.
    .filter((n) => !seen.has(itemLabel(f.data, n)) && !!seen.add(itemLabel(f.data, n)));
  const opt = (n: string, cur: string | undefined) => `<option value="${escapeHtml(n)}" ${cur === n ? "selected" : ""}>${label(n)}</option>`;
  const options = (cur: string | undefined, empty = "(empty)") =>
    `<option value="">${empty}</option>` +
    `<optgroup label="In this blueprint">${f.knownItems.map((n) => opt(n, cur)).join("")}</optgroup>` +
    `<optgroup label="Other items">${others.map((n) => opt(n, cur)).join("")}</optgroup>`;
  // An item slot showing the chosen item's icon; clicking it opens a grid
  // of icons to pick from (see wirePortList). The select underneath holds
  // the value and fires the change, so picking works like choosing in it.
  const itemField = (attrs: string, cur: string | undefined, empty?: string) => {
    const title = cur ? itemLabel(f.data, cur) : (empty ?? "(empty)").replace(/[()]/g, "");
    return `<span class="lab-item-field"><select hidden ${attrs}>${options(cur, empty)}</select><button type="button" class="lab-item-slot ${cur ? "" : "is-empty"}" data-pick title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${cur ? slotIcon(cur, title) : ""}</button></span>`;
  };
  const unit = overlay.settings.style.rateUnit;
  const rateField = (p: PortInfo) => {
    const v = p.limit.rate === undefined ? "" : +(p.limit.rate * PER[unit]).toFixed(3);
    return `<label>Rate limit <input type="number" min="0" step="any" data-rate value="${v}" placeholder="none">/${unit}</label>`;
  };
  const head = (p: PortInfo, popup: boolean) =>
    `<label class="lab-port-head"><input type="checkbox" data-toggle-port ${p.enabled ? "checked" : ""}>
      ${popup ? `<span>${p.enabled ? "On" : "Off"}</span><span class="lab-port-where">at ${Math.floor(p.x)}, ${Math.floor(p.y)}</span>` : `<span class="lab-port-where">${p.via === "belt" ? "Belt" : "Arm"} · ${Math.floor(p.x)}, ${Math.floor(p.y)}</span>`}
      ${p.reason ? `<span class="lab-port-why">${escapeHtml(p.reason)}</span>` : ""}</label>`;
  return (p: PortInfo, popup = false) => {
    let body = "";
    if (p.kind === "input" && p.via === "belt") {
      const [l, r] = f.inputs.get(p.id) ?? [null, null];
      const stack = (l ?? r)?.stack ?? 1;
      body = `<div class="lab-port-lanes"><label>Left lane ${itemField(`data-lane="0"`, l?.item)}</label>
        <label>Right lane ${itemField(`data-lane="1"`, r?.item)}</label></div>
        <label>Stacked <select data-stack>${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === stack ? "selected" : ""}>×${n}</option>`).join("")}</select></label>
        ${rateField(p)}`;
    } else if (p.kind === "input") {
      const arm = f.armPorts.find((a) => a.id === p.id)!;
      const onto = arm.onto ? ` from the ${escapeHtml(arm.onto.replace(/-/g, " "))}` : "";
      body = `<label>Brings${onto} ${itemField("data-arm-items", arm.items.length === 1 ? arm.items[0] : undefined, arm.items.length > 1 ? `What the machine needs (${arm.items.length})` : "(nothing)")}</label>
        <label>Per swing <input type="number" min="1" max="${arm.inserter.handSize}" step="1" data-arm-stack value="${p.limit.stack ?? ""}" placeholder="${arm.inserter.handSize}"></label>
        ${rateField(p)}`;
    } else {
      body = rateField(p);
    }
    const now = popup ? `<div class="lab-port-now">Now <b data-port-now>${formatRate(p.rate, unit)}</b></div>` : "";
    return `<div class="lab-port ${popup ? "is-popup" : ""} ${p.enabled ? "" : "is-off"}" data-port="${escapeHtml(p.id)}">${head(p, popup)}${body}${now}</div>`;
  };
}

/** Swaps a port editor's markup for a fresh render without losing the
 *  user's place: unchanged markup is left alone, and otherwise the scroll
 *  position, an open icon grid (its search and scroll too) come back. */
export function replacePortHtml(el: HTMLElement, html: string) {
  // The live rate changes all the time; it alone doesn't need a redraw.
  const key = html.replace(/<b data-port-now>[^<]*<\/b>/, "");
  if (keyOf.get(el) === key) return;
  keyOf.set(el, key);
  const scrollers: [Element, number][] = [];
  for (let a: Element | null = el; a; a = a.parentElement) if (a.scrollTop) scrollers.push([a, a.scrollTop]);
  const slots = [...el.querySelectorAll<HTMLElement>("[data-pick]")];
  const openAt = slots.findIndex((x) => x.classList.contains("is-open"));
  const picker = el.querySelector<HTMLElement>(".lab-item-picker");
  const search = picker?.querySelector<HTMLInputElement>("[data-item-search]");
  const query = search?.value ?? "";
  const pickerScroll = picker?.scrollTop ?? 0;
  const searching = !!search && document.activeElement === search;
  const expanded = !!picker && !picker.querySelector("[data-lazy]");
  el.innerHTML = html;
  const again = openAt >= 0 ? el.querySelectorAll<HTMLButtonElement>("[data-pick]")[openAt] : undefined;
  if (again) {
    toggleItemPicker(again);
    const next = el.querySelector<HTMLElement>(".lab-item-picker")!;
    if (expanded) fillLazyGroups(next);
    const box = next.querySelector<HTMLInputElement>("[data-item-search]")!;
    box.value = query;
    if (query) box.dispatchEvent(new Event("input", { bubbles: true }));
    if (!searching) box.blur();
    next.scrollTop = pickerScroll;
  }
  for (const [a, top] of scrollers) a.scrollTop = top;
}
const keyOf = new WeakMap<HTMLElement, string>();

/** A port's name for a window title: "Belt input". */
export function portTitle(p: PortInfo): string {
  return `${p.via === "belt" ? "Belt" : "Arm"} ${p.kind}`;
}

/** Items that never ride a belt: planners, remotes and placeholders. */
const NOT_CARGO = /^(item-unknown|no-item|science|empty-module-slot)$|blueprint|planner|-tool$|-remote$/;

/** One port's editor, for the popup a tab opens on the map. */
export function portEditorHtml(overlay: RateOverlay, id: string): string | undefined {
  const f = overlay.factory;
  const p = f?.ports().find((q) => q.id === id);
  return f && p ? portRows(f, overlay)(p, true) : undefined;
}

export function renderPortList(el: HTMLElement, overlay: RateOverlay) {
  const f = overlay.factory;
  if (!f) {
    replacePortHtml(el, `<p class="lab-empty">No ports.</p>`);
    return;
  }
  const row = portRows(f, overlay);
  const all = f.ports();
  const group = (title: string, kind: "input" | "output") => {
    const ps = all.filter((p) => p.kind === kind);
    const main = kind === "input" ? ps.filter((p) => p.via === "arm" || p.items.length) : ps;
    const rest = kind === "input" ? ps.filter((p) => p.via === "belt" && !p.items.length) : [];
    return `<div class="lab-port-group"><h3>${title} <span class="lab-port-count">${ps.filter((p) => p.enabled).length} of ${ps.length} on</span></h3>
      <div class="lab-row"><button type="button" data-all="${kind}" data-on="1">All on</button><button type="button" data-all="${kind}" data-on="0">All off</button></div>
      ${main.map((p) => row(p)).join("") || `<p class="lab-empty">None.</p>`}
      ${rest.length ? `<details><summary>${rest.length} belt starts with nothing on them</summary>${rest.map((p) => row(p)).join("")}</details>` : ""}</div>`;
  };
  replacePortHtml(el, group("Inputs", "input") + group("Outputs", "output"));
}

/** Wires a port list; the overlay's onPortsChange should re-render it. */
export function wirePortList(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal) {
  el.addEventListener("change", (e) => {
    const f = overlay.factory;
    if (!f) return;
    const input = e.target as HTMLInputElement & HTMLSelectElement;
    // Typing in an icon grid's search box changes nothing about the port.
    if (input.dataset.itemSearch !== undefined) return;
    const rowEl = input.closest<HTMLElement>("[data-port]");
    const id = rowEl?.dataset.port;
    if (!id || !rowEl) return;
    if (input.dataset.togglePort !== undefined) {
      overlay.setPortEnabled(id, input.checked);
    } else if (input.dataset.rate !== undefined || input.dataset.armStack !== undefined) {
      // Blank means no limit; rates are typed in the overlay's time unit.
      const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) || Number(s) < 0 ? undefined : Number(s));
      const limit = { ...(f.ports().find((p) => p.id === id)?.limit ?? {}) };
      if (input.dataset.rate !== undefined) {
        const v = num(input.value);
        limit.rate = v === undefined ? undefined : v / PER[overlay.settings.style.rateUnit];
      } else {
        const v = num(input.value);
        limit.stack = v === undefined || v < 1 ? undefined : Math.round(v);
      }
      overlay.setPortLimit(id, limit);
    } else if (input.dataset.armItems !== undefined) {
      const arm = f.armPorts.find((a) => a.id === id)!;
      const needs = arm.inserter.drop.kind === "machine" ? arm.inserter.drop.machine.ingredients.map((i) => i.name) : [];
      overlay.setArmPortItems(id, input.value ? [input.value] : needs);
      if (input.value || needs.length) overlay.setPortEnabled(id, true);
    } else {
      const cur = [...(f.inputs.get(id) ?? [null, null])] as [LaneFeed | null, LaneFeed | null];
      const stack = Number(rowEl.querySelector<HTMLSelectElement>("[data-stack]")!.value);
      if (input.dataset.lane !== undefined) cur[Number(input.dataset.lane)] = input.value ? { item: input.value, rate: "full", stack } : null;
      overlay.setInput(id, cur[0] && { ...cur[0], stack }, cur[1] && { ...cur[1], stack });
    }
  }, { signal });
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const slot = target.closest<HTMLButtonElement>("[data-pick]");
    if (slot) return toggleItemPicker(slot);
    const more = target.closest<HTMLElement>("[data-show-all]");
    if (more) return fillLazyGroups(more.closest(".lab-item-picker")!);
    const pick = target.closest<HTMLButtonElement>("[data-item]");
    if (pick) {
      const picker = pick.closest(".lab-item-picker")!;
      const select = pickerFor.get(picker);
      if (!select) return;
      // A pick closes the grid, so the redraw after it doesn't reopen it.
      picker.remove();
      for (const open of el.querySelectorAll(".lab-item-slot.is-open")) open.classList.remove("is-open");
      select.value = pick.dataset.item!;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const b = target.closest<HTMLButtonElement>("[data-all]");
    if (!b || !overlay.factory) return;
    for (const p of overlay.factory.ports()) if (p.kind === b.dataset.all) overlay.setPortEnabled(p.id, b.dataset.on === "1");
  }, { signal });
  el.addEventListener("input", (e) => {
    const search = (e.target as HTMLElement).closest<HTMLInputElement>("[data-item-search]");
    if (!search) return;
    const q = search.value.trim().toLowerCase();
    const picker = search.closest(".lab-item-picker")!;
    if (q) fillLazyGroups(picker);
    for (const b of picker.querySelectorAll<HTMLElement>("[data-item]")) b.hidden = !!q && !b.title.toLowerCase().includes(q);
    for (const g of picker.querySelectorAll<HTMLElement>(".lab-item-group")) g.hidden = !!q && !g.querySelector("[data-item]:not([hidden])");
  }, { signal });
  el.addEventListener("pointerover", (e) => {
    overlay.highlightPort = (e.target as HTMLElement).closest<HTMLElement>("[data-port]")?.dataset.port;
  }, { signal });
  el.addEventListener("pointerleave", () => (overlay.highlightPort = undefined), { signal });
}

/** An item's icon for a slot, or its initials where it has none. */
function slotIcon(name: string, label: string): string {
  return getIconPosition(name) ? iconHtml(name, 28) : `<span class="lab-item-initials">${escapeHtml(label.split(/\s+/).map((w) => w[0]).join("").slice(0, 3))}</span>`;
}

/** Which select each open icon grid sets, and how it draws a cell. */
const pickerFor = new WeakMap<Element, HTMLSelectElement>();
const pickerCell = new WeakMap<Element, (value: string, title: string, inner: string) => string>();

/** Draws the grid's deferred groups (every other item) into it. */
function fillLazyGroups(picker: Element) {
  const select = pickerFor.get(picker);
  const cell = pickerCell.get(picker);
  if (!select || !cell) return;
  for (const g of picker.querySelectorAll<HTMLElement>("[data-lazy]")) {
    const group = select.querySelectorAll("optgroup")[Number(g.dataset.lazy)]!;
    g.innerHTML = `<span class="lab-field-label">${escapeHtml(group.label)}</span><div class="lab-item-grid">${[...group.querySelectorAll("option")].map((o) => cell(o.value, o.text, gridIcon(o.value, o.text))).join("")}</div>`;
    delete g.dataset.lazy;
  }
}

/** The icon sheet shrunk once to the grid's icon size, so painting an
 *  icon is a plain copy rather than a resample of the whole sheet; a
 *  grid of hundreds of icons stays smooth to hover and drag. */
const GRID_ICON = 28;
let gridSheet: string | undefined;
onIconsReady(() => {
  const img = new Image();
  img.src = SHEET_URL;
  img.decode().then(() => {
    const k = GRID_ICON / CELL;
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((b) => b && (gridSheet = URL.createObjectURL(b)));
  }).catch(() => {});
});

function gridIcon(name: string, label: string): string {
  const pos = gridSheet ? getIconPosition(name) : undefined;
  if (!pos) return slotIcon(name, label);
  const k = GRID_ICON / CELL;
  return `<span class="lab-grid-icon" style="background-image:url(${gridSheet});background-position:${-Math.round(pos.x * k)}px ${-Math.round(pos.y * k)}px"></span>`;
}

/** Opens (or closes) the icon grid under an item slot, built from the
 *  options of the select it stands for. One grid open at a time. */
function toggleItemPicker(slot: HTMLButtonElement) {
  const field = slot.closest<HTMLElement>(".lab-item-field")!;
  const open = field.nextElementSibling?.classList.contains("lab-item-picker");
  for (const p of document.querySelectorAll(".lab-item-picker")) p.remove();
  for (const s of document.querySelectorAll(".lab-item-slot.is-open")) s.classList.remove("is-open");
  if (open) return;
  const select = field.querySelector("select")!;
  const cell = (value: string, title: string, inner: string) =>
    `<button type="button" class="lab-item-slot ${value === select.value ? "is-chosen" : ""} ${value ? "" : "is-empty"}" data-item="${escapeHtml(value)}" title="${escapeHtml(title)}">${inner}</button>`;
  const none = select.options[0]!;
  // The blueprint's own items show straight away; the long list of every
  // other item is only drawn once it's asked for (or searched), so the
  // grid stays small and cheap to paint.
  const groups = [...select.querySelectorAll("optgroup")]
    .map((g, i) =>
      i === 0
        ? `<div class="lab-item-group"><span class="lab-field-label">${escapeHtml(g.label)}</span><div class="lab-item-grid">${[...g.querySelectorAll("option")].map((o) => cell(o.value, o.text, gridIcon(o.value, o.text))).join("")}</div></div>`
        : `<div class="lab-item-group" data-lazy="${i}"><button type="button" class="lab-item-more" data-show-all>All items (${g.querySelectorAll("option").length})</button></div>`,
    )
    .join("");
  const picker = document.createElement("div");
  picker.className = "lab-item-picker";
  picker.innerHTML = `<div class="lab-item-picker-head"><input type="search" data-item-search placeholder="Search items" aria-label="Search items">${cell("", none.text, "")}<span class="lab-item-none">${escapeHtml(none.text.replace(/[()]/g, ""))}</span></div>${groups}`;
  // Under the whole lane pair when there are two slots side by side.
  (field.closest(".lab-port-lanes") ?? field.closest("label") ?? field).after(picker);
  pickerFor.set(picker, select);
  pickerCell.set(picker, cell);
  slot.classList.add("is-open");
  picker.querySelector<HTMLInputElement>("[data-item-search]")!.focus();
}
