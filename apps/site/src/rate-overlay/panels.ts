/** Window contents for a rate overlay: layer switches, the simulation's
 *  summary and research, and the list of ports. Each host lays these out in
 *  its own windows; the markup and behaviour live here once. */
import type { LaneFeed } from "@factoriotools/sim";
import { escapeHtml } from "../tools/blueprint-viewer/html.js";
import type { RateOverlay } from "./controller.js";
import { machineStatus, type PortInfo, type Research } from "./factory.js";
import { itemLabel } from "./issues.js";
import { statusColor } from "./overlay.js";
import { PALETTES, type LabSettings, type RateUnit } from "./settings.js";

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

export function renderLayerList(el: HTMLElement, settings: LabSettings) {
  const row = (l: (typeof LAYER_INFO)[number]) => `
    <label class="lab-layer">
      <input type="checkbox" data-layer="${l.key}" ${settings.layers[l.key] ? "checked" : ""}>
      <span class="lab-layer-text"><span class="lab-layer-name">${l.label}</span><span class="lab-layer-hint">${l.hint}</span></span>
    </label>`;
  el.innerHTML =
    LAYER_INFO.filter((l) => l.group === "main").map(row).join("") +
    `<h3 class="lab-layer-heading">Extra options</h3>` +
    LAYER_INFO.filter((l) => l.group === "extra").map(row).join("");
}

export function wireLayerList(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal) {
  el.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.layer as Layer | undefined;
    if (!key) return;
    overlay.settings.layers[key] = input.checked;
    overlay.saveSettings();
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

export function simSummaryHtml(overlay: RateOverlay): string {
  const f = overlay.factory;
  if (!f) return `<span class="lab-empty">Nothing to simulate yet.</span>`;
  const counts: Record<string, number> = {};
  for (const m of f.machines) counts[machineStatus(m)] = (counts[machineStatus(m)] ?? 0) + 1;
  const pal = PALETTES[overlay.settings.style.palette];
  const rows = (["working", "arm", "starved", "output", "idle"] as const)
    .filter((k) => counts[k])
    .map((k) => `<span class="lab-swatch"><i style="background:${statusColor(pal, k)}"></i>${counts[k]} ${({ working: "working", arm: "inserter-bound", starved: "starved", output: "output full", idle: "idle" })[k]}</span>`)
    .join("");
  return `${f.machines.length} machines · ${f.inserters.length} inserters · ${f.net.nodes.length} belt tiles<div class="lab-swatches">${rows}</div>`;
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

export function renderPortList(el: HTMLElement, overlay: RateOverlay) {
  const f = overlay.factory;
  if (!f) {
    el.innerHTML = `<p class="lab-empty">No ports.</p>`;
    return;
  }
  const label = (n: string) => escapeHtml(itemLabel(f.data, n));
  const options = (cur: string | undefined, empty = "(empty)") =>
    `<option value="">${empty}</option>` +
    [...new Set([...f.knownItems, ...(cur ? [cur] : [])])].map((n) => `<option value="${escapeHtml(n)}" ${cur === n ? "selected" : ""}>${label(n)}</option>`).join("");
  const all = f.ports();
  const head = (p: PortInfo) =>
    `<label class="lab-port-head"><input type="checkbox" data-toggle-port ${p.enabled ? "checked" : ""}>
      <span class="lab-port-where">${p.via === "belt" ? "Belt" : "Arm"} · ${Math.floor(p.x)}, ${Math.floor(p.y)}</span>
      ${p.reason ? `<span class="lab-port-why">${escapeHtml(p.reason)}</span>` : ""}</label>`;
  const row = (p: PortInfo) => {
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
  el.innerHTML = group("Inputs", "input") + group("Outputs", "output");
}

/** Wires a port list; the overlay's onPortsChange should re-render it. */
export function wirePortList(el: HTMLElement, overlay: RateOverlay, signal: AbortSignal) {
  el.addEventListener("change", (e) => {
    const f = overlay.factory;
    if (!f) return;
    const input = e.target as HTMLInputElement & HTMLSelectElement;
    const rowEl = input.closest<HTMLElement>("[data-port]");
    const id = rowEl?.dataset.port;
    if (!id || !rowEl) return;
    if (input.dataset.togglePort !== undefined) {
      overlay.setPortEnabled(id, input.checked);
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
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-all]");
    if (!b || !overlay.factory) return;
    for (const p of overlay.factory.ports()) if (p.kind === b.dataset.all) overlay.setPortEnabled(p.id, b.dataset.on === "1");
  }, { signal });
  el.addEventListener("pointerover", (e) => {
    overlay.highlightPort = (e.target as HTMLElement).closest<HTMLElement>("[data-port]")?.dataset.port;
  }, { signal });
  el.addEventListener("pointerleave", () => (overlay.highlightPort = undefined), { signal });
}
