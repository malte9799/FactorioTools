/** Markup for the planner's panels: the summary down the left, the
 *  inspector for a picked step, the table view, the item picker and the
 *  settings. Everything here is built from the game dataset; interactions
 *  are wired by delegation in index.ts through data-action attributes. */

import {
  canUseModule,
  machinesFor,
  type PlanResult,
  type PlanStep,
  type PlannerData,
} from "@factoriotools/engine";
import { escapeHtml as e } from "../blueprint-editor/html.js";
import { compressModules } from "./graph.js";
import { fmtBelts, fmtMachines, fmtNumber, fmtPercent, fmtPower, fmtRate, UNIT_LABEL } from "./format.js";
import { groupSprite, itemColor, recipeIcon, sprite } from "./sprites.js";
import type { PlannerState } from "./state.js";

/** An inventory slot: icon with a count in the corner, like the game's. */
export function slot(icon: string, count: string, tip: string, sub = "", attrs = "", extra = ""): string {
  const size = extra.includes("is-small") ? 28 : 32;
  return `<button type="button" class="pl-slot${extra ? ` ${extra}` : ""}" data-tip="${e(tip)}"${sub ? ` data-tip-sub="${e(sub)}"` : ""} data-tip-icon="${e(icon)}" ${attrs}>${sprite(icon, size)}${count ? `<span class="pl-slot-count">${e(count)}</span>` : ""}</button>`;
}

function beltFor(pd: PlannerData, state: PlannerState) {
  return pd.belts.find((b) => b.name === state.belt) ?? pd.belts[pd.belts.length - 1]!;
}

function beltText(pd: PlannerData, state: PlannerState, item: string, rate: number): string {
  if (pd.items[item]?.kind === "fluid") return "";
  const belt = beltFor(pd, state);
  return `${fmtNumber(rate / belt.throughput)} ${belt.label.toLowerCase()}s`;
}

/** Belts as the game draws them: the chosen tier's icon and how many full
 *  belts the flow fills, gold past one (where a line has to split). Empty
 *  for fluids, which go in pipes. */
export function beltTag(pd: PlannerData, state: PlannerState, item: string, rate: number): string {
  if (pd.items[item]?.kind === "fluid") return "";
  const belt = beltFor(pd, state);
  const n = rate / belt.throughput;
  return `<span class="pl-belts${n > 1 + 1e-9 ? " is-over" : ""}" data-tip="${e(belt.label)}" data-tip-sub="${e(beltText(pd, state, item, rate))}" data-tip-icon="${e(belt.name)}">${sprite(belt.name, 18)}<span>${fmtBelts(n)}</span></span>`;
}

const MACHINE_RANK = ["mining-drill", "pump", "furnace", "assembling", "chemical", "refinery", "centrifuge", "foundry", "electromagnetic", "cryogenic", "biochamber", "crusher", "recycler", "rocket-silo"];

/* ------------------------------------------------------------------ summary */

export function summaryHtml(pd: PlannerData, result: PlanResult, state: PlannerState): string {
  const unit = state.unit;
  const machineTotal = Object.entries(result.buildings).reduce((s, [, n]) => s + n, 0);
  const belt = beltFor(pd, state);
  const solid = result.resources.filter((r) => pd.items[r.item]?.kind !== "fluid");
  const oreBelts = solid.reduce((s, r) => s + r.rate, 0) / belt.throughput;
  const topMachine = Object.entries(result.buildings).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "assembling-machine-3";

  const kpis = `
    <div class="pl-kpis">
      <div class="pl-kpi" data-tip="Machines to build" data-tip-sub="Every step rounded up">${sprite(topMachine, 30)}<b>${fmtNumber(machineTotal)}</b><small>machines</small></div>
      <div class="pl-kpi" data-tip="Electricity" data-tip-sub="Machines working flat out, plus beacons">${sprite("signal-lightning", 30)}<b>${fmtPower(result.power).split(" ")[0]}</b><small>${fmtPower(result.power).split(" ")[1] ?? ""}</small></div>
      <div class="pl-kpi" data-tip="Raw solids in" data-tip-sub="${e(`Full ${belt.label.toLowerCase()}s of ore, coal and stone`)}">${sprite(belt.name, 30)}<b>${fmtNumber(oreBelts)}</b><small>belts in</small></div>
    </div>`;

  const maxVis = Math.max(1e-9, ...result.resources.map((r) => r.rate * (pd.items[r.item]?.kind === "fluid" ? 0.1 : 1)));
  const resources = result.resources.map((r) => {
    const step = result.steps.find((s) => s.outputs.some((o) => o.item === r.item) && s.recipe.kind !== "craft" && s.recipe.kind !== "spoil");
    const vis = r.rate * (pd.items[r.item]?.kind === "fluid" ? 0.1 : 1);
    const label = pd.items[r.item]?.label ?? r.item;
    const machine = step?.machine
      ? `<span class="pl-res-machine" data-tip="${e(step.machine.label)}" data-tip-sub="${e(`${fmtMachines(step.machines)} needed`)}">${sprite(step.machine.icon, 18)}×${Math.ceil(step.machines - 1e-6)}</span>`
      : `<span class="pl-res-machine is-dim">${step?.recipe.kind === "gather" ? "gathered" : ""}</span>`;
    const belts = beltText(pd, state, r.item, r.rate);
    return `<button type="button" class="pl-res" data-action="select" data-id="${e(step?.id ?? "")}" style="--c:${itemColor(r.item)}" data-tip="${e(label)}" data-tip-sub="${e(belts || "Fluid")}" data-tip-icon="${e(r.item)}">
      ${sprite(r.item, 32)}
      <span class="pl-res-body">
        <span class="pl-res-top"><b>${fmtRate(r.rate, unit)}</b><small>${UNIT_LABEL[unit]}</small>${beltTag(pd, state, r.item, r.rate)}${machine}</span>
        <span class="pl-res-bar"><i style="width:${Math.max(3, (vis / maxVis) * 100).toFixed(1)}%"></i></span>
      </span>
    </button>`;
  }).join("");

  const buildings = Object.entries(result.buildings)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    .map(([name, count]) => slot(name, String(count), pd.machines[name]?.label ?? name, "", `data-action="highlight-machine" data-machine="${e(name)}"`))
    .join("");
  const beacons = result.beaconCount ? slot("beacon", String(result.beaconCount), "Beacon", "No sharing between machines assumed") : "";
  const modules = Object.entries(result.moduleCounts)
    .map(([name, count]) => slot(name, String(count), pd.modules[name]?.localised ?? name))
    .join("");

  const itemSlots = (list: { item: string; rate: number }[], action: string) => list
    .map((r) => slot(r.item, fmtRate(r.rate, unit), pd.items[r.item]?.label ?? r.item, `${fmtRate(r.rate, unit)}${UNIT_LABEL[unit]}`, `data-action="${action}" data-id="${e(`${action === "select-surplus" ? "surplus" : "import"}:${r.item}`)}"`))
    .join("");

  return `
    ${kpis}
    ${result.resources.length ? `<section class="pl-sec"><h3>Raw resources</h3><div class="pl-res-list">${resources}</div></section>` : ""}
    <section class="pl-sec"><h3>Build list</h3><div class="pl-slots">${buildings}${beacons}${modules}</div></section>
    ${result.imports.length ? `<section class="pl-sec"><h3>Imported</h3><p class="pl-hint">Nothing in the plan makes these, or you chose to bring them in.</p><div class="pl-slots">${itemSlots(result.imports, "select-import")}</div></section>` : ""}
    ${result.surplus.length ? `<section class="pl-sec"><h3>Leftovers</h3><p class="pl-hint">Made as a side product and not used.</p><div class="pl-slots">${itemSlots(result.surplus, "select-surplus")}</div></section>` : ""}
  `;
}

function rank(machine: string): number {
  const i = MACHINE_RANK.findIndex((k) => machine.includes(k));
  return i < 0 ? 99 : i;
}

/* ---------------------------------------------------------------- inspector */

function amountChip(pd: PlannerData, item: string, amount: number, probability?: number): string {
  const text = fmtNumber(amount * (probability ?? 1));
  const label = pd.items[item]?.label ?? item;
  return slot(item, text, label, probability ? `${Math.round(probability * 100)}% chance` : "", "", "is-small");
}

export function inspectorHtml(pd: PlannerData, result: PlanResult, state: PlannerState, id: string): string {
  const unit = state.unit;
  const step = result.steps.find((s) => s.id === id);
  if (step) return stepInspector(pd, result, state, step);

  const [kind, item] = id.split(/:(.*)/s) as [string, string];
  const info = pd.items[item];
  if (!info) return "";
  const balance = result.items[item];
  const title = kind === "target" ? "Output" : kind === "import" ? "Imported" : "Leftover";
  const rate = kind === "target" ? balance?.target ?? 0 : kind === "import" ? balance?.imported ?? 0 : balance?.surplus ?? 0;
  const makers = result.steps.filter((s) => s.outputs.some((o) => o.item === item));
  return `
    <header class="pl-insp-head" style="--c:${itemColor(item)}">
      <span class="pl-insp-icon">${sprite(item, 48)}</span>
      <div><span class="pl-eyebrow">${title}</span><h2>${e(info.label)}</h2><div class="pl-insp-rate">${fmtRate(rate, unit)}<small>${UNIT_LABEL[unit]}</small> ${beltTag(pd, state, item, rate)}</div></div>
    </header>
    ${kind === "import"
      ? `<section class="pl-sec"><h3>Source</h3>${state.settings.recipeFor[item] === "import"
        ? `<p class="pl-hint">You chose to bring this in from elsewhere.</p><button type="button" class="pl-btn" data-action="unimport" data-item="${e(item)}">Make it in this plan</button>`
        : `<p class="pl-hint">Nothing in the dataset makes this here, so it has to come from elsewhere.</p>`}</section>`
      : recipeChoice(pd, state, item)}
    ${makers.length ? `<section class="pl-sec"><h3>Made by</h3><div class="pl-slots">${makers.map((s) => slot(recipeIcon(s.recipe), s.machine ? `×${fmtMachines(s.machines)}` : "", s.recipe.label, s.machine?.label ?? "", `data-action="select" data-id="${e(s.id)}"`)).join("")}</div></section>` : ""}
  `;
}

function recipeChoice(pd: PlannerData, state: PlannerState, item: string): string {
  const options = pd.producers[item] ?? [];
  if (!options.length) return "";
  const current = state.settings.recipeFor[item] ?? options.find((id) => !state.settings.excluded.includes(id)) ?? options[0];
  const slots = options.map((id) => {
    const r = pd.recipes[id]!;
    const io = `${r.ingredients.map((i) => pd.items[i.item]?.label ?? i.item).join(", ") || "nothing"} → ${r.products.map((p) => pd.items[p.item]?.label ?? p.item).join(", ")}`;
    return slot(recipeIcon(r), "", r.label, io, `data-action="recipe" data-item="${e(item)}" data-recipe="${e(id)}" aria-pressed="${id === current}"`, id === current ? "is-on" : "");
  }).join("");
  const imported = state.settings.recipeFor[item] === "import";
  return `<section class="pl-sec"><h3>Recipe</h3><div class="pl-slots">${slots}<button type="button" class="pl-slot is-import${imported ? " is-on" : ""}" data-action="import" data-item="${e(item)}" data-tip="Import instead" data-tip-sub="Bring it in from another part of the base" aria-pressed="${imported}"><span class="pl-import-glyph">⇥</span></button></div></section>`;
}

function stepInspector(pd: PlannerData, result: PlanResult, state: PlannerState, step: PlanStep): string {
  const unit = state.unit;
  const r = step.recipe;
  const whole = Math.ceil(step.machines - 1e-6);
  const util = whole ? step.machines / whole : 0;

  const formula = `
    <div class="pl-formula">
      <div class="pl-formula-side">${r.ingredients.map((i) => amountChip(pd, i.item, i.amount)).join("") || `<span class="pl-dim">—</span>`}</div>
      <div class="pl-formula-time" data-tip="Time per cycle at speed 1">${sprite("signal-clock", 16)}<span>${fmtNumber(r.time)}s</span></div>
      <div class="pl-formula-side">${r.products.map((p) => amountChip(pd, p.item, p.amount, p.probability)).join("")}</div>
    </div>`;

  const machines = machinesFor(pd, r);
  const machineSlots = machines.length > 1
    ? `<div class="pl-slots">${machines.map((m) => slot(m.icon, "", m.label, `Speed ${fmtNumber(m.speed)}${m.moduleSlots ? `, ${m.moduleSlots} module slots` : ""}`, `data-action="machine" data-recipe="${e(r.id)}" data-machine="${e(m.name)}" aria-pressed="${m.name === step.machine?.name}"`, m.name === step.machine?.name ? "is-on" : "")).join("")}</div>`
    : "";

  const count = step.machine
    ? `<div class="pl-count">
        ${sprite(step.machine.icon, 40)}
        <div class="pl-count-body">
          <div><b>${fmtMachines(step.machines)}</b> <span class="pl-dim">→ build</span> <b class="pl-gold">${whole}</b></div>
          <div class="pl-meter" data-tip="${e(`${Math.round(util * 100)}% busy`)}"><i style="width:${(util * 100).toFixed(1)}%"></i></div>
          ${step.machine.note ? `<div class="pl-hint">${e(step.machine.note)}</div>` : ""}
        </div>
      </div>`
    : `<p class="pl-hint">${r.kind === "spoil" ? "Happens on its own while the item waits." : "No machine involved."}</p>`;

  let modules = "";
  const m = step.machine;
  if (m && m.moduleSlots > 0) {
    const usable = Object.keys(pd.modules).filter((name) => canUseModule(pd, m, r, name));
    const slots = Array.from({ length: m.moduleSlots }, (_, i) => {
      const mod = step.modules[i];
      return `<button type="button" class="pl-slot is-module" data-action="modslot" data-recipe="${e(r.id)}" data-slot="${i}" data-tip="${e(mod ? pd.modules[mod]?.localised ?? mod : "Empty slot")}" data-tip-sub="Click to change">${mod ? sprite(mod, 32) : ""}</button>`;
    }).join("");
    const fills = ["", ...usable.filter((n) => /-3$/.test(n))].map((name) =>
      `<button type="button" class="pl-mini" data-action="modfill" data-recipe="${e(r.id)}" data-module="${e(name)}" data-tip="${e(name ? `Fill with ${pd.modules[name]?.localised}` : "Remove all")}">${name ? sprite(name, 20) : "∅"}</button>`).join("");
    const beaconOk = pd.beacon && m.allowedEffects.length > 0;
    const beacon = beaconOk
      ? `<div class="pl-beacon">
          ${sprite("beacon", 32)}
          <div class="pl-stepper"><button type="button" data-action="beacons" data-recipe="${e(r.id)}" data-delta="-1" aria-label="Fewer beacons">−</button><b>${step.beacons}</b><button type="button" data-action="beacons" data-recipe="${e(r.id)}" data-delta="1" aria-label="More beacons">+</button></div>
          <span class="pl-dim">beacons each, with</span>
          <button type="button" class="pl-slot is-module" data-action="beaconmod" data-recipe="${e(r.id)}" data-tip="${e(step.beaconModule ? pd.modules[step.beaconModule]?.localised ?? "" : "Pick a module")}">${step.beaconModule ? sprite(step.beaconModule, 32) : ""}</button>
        </div>`
      : "";
    modules = `<section class="pl-sec"><h3>Modules <span class="pl-fill">${fills}</span></h3><div class="pl-slots">${slots}</div>${beacon}</section>`;
  }

  const fx = step.effects;
  const stats = [
    ["Speed", fx.speed ? fmtPercent(fx.speed) : "—", fx.speed > 0 ? "up" : fx.speed < 0 ? "down" : ""],
    ["Productivity", fx.productivity ? fmtPercent(fx.productivity) : "—", fx.productivity > 0 ? "up" : ""],
    ["Energy", fx.consumption ? fmtPercent(fx.consumption) : "—", fx.consumption > 0 ? "down" : fx.consumption < 0 ? "up" : ""],
    ["Per machine", `${fmtRate(step.craftsPerMachine * (step.outputs.find((o) => o.item === step.item)?.rate ?? 0) / Math.max(step.crafts, 1e-12), unit)}${UNIT_LABEL[unit]}`, ""],
    ...(step.power ? [["Power", fmtPower(step.power + step.beaconPower), ""]] : []),
    ...(step.fuel ? [["Fuel", `${fmtRate(step.fuel.rate, unit)}${UNIT_LABEL[unit]}`, "", step.fuel.item]] : []),
  ].map(([k, v, cls, icon]) => `<div class="pl-stat ${cls}"><span>${k}</span><b>${icon ? sprite(icon, 16) : ""}${v}</b></div>`).join("");

  const flowRows = (list: { item: string; rate: number }[], dir: "in" | "out") => list.map((f) => {
    const other = result.flows
      .filter((fl) => fl.item === f.item && (dir === "in" ? fl.to === step.id : fl.from === step.id))
      .map((fl) => (dir === "in" ? fl.from : fl.to));
    return `<button type="button" class="pl-flow-row" data-action="select" data-id="${e(other[0] ?? "")}" style="--c:${itemColor(f.item)}" data-tip="${e(pd.items[f.item]?.label ?? f.item)}" data-tip-icon="${e(f.item)}">
      ${sprite(f.item, 24)}<span class="pl-flow-name">${e(pd.items[f.item]?.label ?? f.item)}</span>${beltTag(pd, state, f.item, f.rate)}<b>${fmtRate(f.rate, unit)}<small>${UNIT_LABEL[unit]}</small></b>
    </button>`;
  }).join("");

  const overridden = state.settings.machineFor[r.id] || state.settings.modulesFor[r.id];
  const autoAdded = state.settings.recipeFor[step.item] !== r.id && (pd.producers[step.item]?.[0] !== r.id);

  return `
    <header class="pl-insp-head" style="--c:${itemColor(step.item)}">
      <span class="pl-insp-icon">${sprite(recipeIcon(r), 48)}</span>
      <div><span class="pl-eyebrow">${e(kindLabel(r.kind))}</span><h2>${e(r.label)}</h2>
      <div class="pl-insp-rate">${fmtRate(step.outputs.find((o) => o.item === step.item)?.rate ?? 0, unit)}<small>${UNIT_LABEL[unit]}</small> <span class="pl-dim">${e(pd.items[step.item]?.label ?? "")}</span></div></div>
    </header>
    ${formula}
    ${r.note ? `<p class="pl-hint">${e(r.note)}</p>` : ""}
    ${recipeChoice(pd, state, step.item)}
    <section class="pl-sec"><h3>Machines</h3>${machineSlots}${count}</section>
    ${modules}
    <section class="pl-sec"><div class="pl-stats">${stats}</div></section>
    ${step.inputs.length ? `<section class="pl-sec"><h3>In</h3>${flowRows(step.inputs, "in")}</section>` : ""}
    <section class="pl-sec"><h3>Out</h3>${flowRows(step.outputs, "out")}</section>
    <section class="pl-sec pl-insp-foot">
      ${overridden ? `<button type="button" class="pl-btn" data-action="reset-step" data-recipe="${e(r.id)}">Back to defaults</button>` : ""}
      ${autoAdded && r.kind === "craft" ? `<button type="button" class="pl-btn" data-action="exclude" data-recipe="${e(r.id)}" data-tip="The planner added this to use up a by-product">Don't use this recipe</button>` : ""}
    </section>
  `;
}

function kindLabel(kind: string): string {
  return ({ craft: "Recipe", mine: "Mining", well: "Pumpjack", pump: "Offshore pump", boil: "Boiler", grow: "Agriculture", spoil: "Spoiling", gather: "From the world" } as Record<string, string>)[kind] ?? kind;
}

/** A floating chooser of modules for one slot. */
export function moduleChooserHtml(pd: PlannerData, names: string[], current: string): string {
  const cells = ["", ...names].map((name) =>
    `<button type="button" class="pl-slot${name === current ? " is-on" : ""}" data-pick="${e(name)}" data-tip="${e(name ? pd.modules[name]?.localised ?? name : "Empty")}">${name ? sprite(name, 32) : `<span class="pl-import-glyph">∅</span>`}</button>`).join("");
  return `<div class="pl-slots">${cells}</div>`;
}

/* -------------------------------------------------------------------- table */

export function tableHtml(pd: PlannerData, result: PlanResult, state: PlannerState, selected: string | null): string {
  const unit = state.unit;
  const steps = [...result.steps].sort((a, b) => a.depth - b.depth || b.machines - a.machines);
  const rows = steps.map((s) => {
    const main = s.outputs.find((o) => o.item === s.item) ?? s.outputs[0];
    const whole = Math.ceil(s.machines - 1e-6);
    const util = whole ? s.machines / whole : 0;
    const chips = (list: { item: string; rate: number }[]) => list.map((f) =>
      `<span class="pl-chip" style="--c:${itemColor(f.item)}" data-tip="${e(pd.items[f.item]?.label ?? f.item)}" data-tip-sub="${e(beltText(pd, state, f.item, f.rate))}" data-tip-icon="${e(f.item)}">${sprite(f.item, 20)}${fmtRate(f.rate, unit)}</span>`).join("");
    const extra = s.outputs.filter((o) => o !== main);
    return `<tr class="${s.id === selected ? "is-selected" : ""}" data-action="select" data-id="${e(s.id)}" style="--c:${itemColor(s.item)}">
      <td class="pl-t-out">${sprite(recipeIcon(s.recipe), 32)}<div><b>${fmtRate(main?.rate ?? 0, unit)}</b><small>${UNIT_LABEL[unit]}</small><span>${e(s.recipe.label)}</span></div></td>
      <td class="pl-t-machine">${s.machine ? `${sprite(s.machine.icon, 28)}<div><b>${fmtMachines(s.machines)}</b><div class="pl-meter"><i style="width:${(util * 100).toFixed(0)}%"></i></div></div>` : `<span class="pl-dim">—</span>`}</td>
      <td class="pl-t-mods">${compressModules(s.modules).map(([m, c]) => `<span class="pl-modchip">${sprite(m, 18)}${c > 1 ? `<i>${c}</i>` : ""}</span>`).join("")}${s.beacons && s.beaconModule ? `<span class="pl-modchip">${sprite("beacon", 18)}<i>${s.beacons}</i></span>` : ""}</td>
      <td class="pl-t-flows">${chips(s.inputs)}</td>
      <td class="pl-t-flows">${chips(extra)}</td>
      <td class="pl-t-power">${s.power ? fmtPower(s.power + s.beaconPower) : s.fuel ? `${sprite(s.fuel.item, 16)}${fmtRate(s.fuel.rate, unit)}` : ""}</td>
    </tr>`;
  }).join("");
  return `<div class="pl-table-wrap"><table class="pl-table">
    <thead><tr><th>Makes</th><th>Machines</th><th>Modules</th><th>Takes</th><th>Also makes</th><th>Power</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------- picker */

export function pickerHtml(pd: PlannerData, group: string, query: string, plannable: Set<string>): string {
  const q = query.trim().toLowerCase();
  const items = Object.values(pd.items).filter((i) => plannable.has(i.name));
  const inGroup = (name: string) => {
    const g = pd.items[name]?.position?.group ?? "other";
    return pd.groups.some((x) => x.name === g) ? g : "intermediate-products";
  };
  const tabs = pd.groups.map((g) => {
    const count = items.filter((i) => inGroup(i.name) === g.name && (!q || i.label.toLowerCase().includes(q))).length;
    return `<button type="button" class="pl-tab${g.name === group && !q ? " is-on" : ""}${q && !count ? " is-empty" : ""}" data-group="${e(g.name)}" data-tip="${e(g.label)}" aria-pressed="${g.name === group}">${groupSprite(g.icon, 56)}</button>`;
  }).join("");

  const shown = items.filter((i) => (q ? i.label.toLowerCase().includes(q) || i.name.includes(q) : inGroup(i.name) === group));
  const bySub = new Map<string, typeof shown>();
  for (const i of shown) {
    const p = i.position;
    const key = q ? inGroup(i.name) : `${p?.subgroupOrder ?? "z"}|${p?.subgroup ?? "other"}`;
    if (!bySub.has(key)) bySub.set(key, []);
    bySub.get(key)!.push(i);
  }
  const rows = [...bySub.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, list]) => `<div class="pl-pick-row">${list
      .sort((a, b) => ((a.position?.order ?? "") < (b.position?.order ?? "") ? -1 : 1))
      .map((i) => `<button type="button" class="pl-slot" data-pick="${e(i.name)}" data-tip="${e(i.label)}" data-tip-icon="${e(i.name)}">${sprite(i.name, 32)}</button>`).join("")}</div>`)
    .join("");
  return `
    <div class="pl-pick-tabs">${tabs}</div>
    <div class="pl-pick-grid">${rows || `<p class="pl-hint">Nothing called “${e(query)}”.</p>`}</div>`;
}

/* ----------------------------------------------------------------- settings */

export function settingsHtml(pd: PlannerData, state: PlannerState): string {
  const s = state.settings;
  const choice = (key: string, value: string, icon: string, tip: string, on: boolean, sub = "") =>
    slot(icon, "", tip, sub, `data-action="set" data-key="${e(key)}" data-value="${e(value)}" aria-pressed="${on}"`, on ? "is-on" : "");
  const family = (key: "assembler" | "furnace" | "drill", names: string[]) =>
    names.filter((n) => pd.machines[n]).map((n) => choice(key, n, n, pd.machines[n]!.label, s[key] === n, `Speed ${fmtNumber(pd.machines[n]!.speed)}`)).join("");

  const moduleNames = Object.keys(pd.modules);
  const beaconModules = moduleNames.filter((n) => n.startsWith("speed") || n.startsWith("efficiency"));
  const fuels = Object.keys(pd.fuelValue).filter((f) => !["nutrients", "bioflux"].includes(f));

  const research = Object.values(pd.productivityTechnologies).map((t) => {
    const first = t.recipes.map((r) => pd.recipes[r]).find(Boolean);
    const icon = first ? (/asteroid-crushing$/.test(first.id) ? first.ingredients[0]!.item : recipeIcon(first)) : "";
    const level = s.research[t.name] ?? 0;
    return `<div class="pl-research" data-tip="${e(t.localised)}" data-tip-sub="${e(`+${Math.round(t.changePerLevel * 100)}% per level`)}">
      ${sprite(icon, 28)}<span>${e(t.localised.replace(/ productivity$/i, ""))}</span>
      <div class="pl-stepper"><button type="button" data-action="research" data-key="${e(t.name)}" data-delta="-1" aria-label="Lower">−</button><b>${level}</b><button type="button" data-action="research" data-key="${e(t.name)}" data-delta="1" aria-label="Raise">+</button></div>
    </div>`;
  }).join("");

  const overrides = Object.keys(s.recipeFor).length + Object.keys(s.machineFor).length + Object.keys(s.modulesFor).length + s.excluded.length;

  return `
    <section class="pl-sec"><h3>Machines</h3>
      <div class="pl-set-row"><span>Assembler</span><div class="pl-slots">${family("assembler", ["assembling-machine-1", "assembling-machine-2", "assembling-machine-3"])}</div></div>
      <div class="pl-set-row"><span>Furnace</span><div class="pl-slots">${family("furnace", ["stone-furnace", "steel-furnace", "electric-furnace"])}</div></div>
      <div class="pl-set-row"><span>Mining drill</span><div class="pl-slots">${family("drill", ["burner-mining-drill", "electric-mining-drill", "big-mining-drill"])}</div></div>
      <label class="pl-toggle"><input type="checkbox" data-action="toggle" data-key="preferSpaceAge" ${s.preferSpaceAge ? "checked" : ""}/>
        <span>Use Space Age machines where they fit</span><span class="pl-toggle-icons">${["foundry", "electromagnetic-plant", "cryogenic-plant", "biochamber"].filter((n) => pd.machines[n]).map((n) => sprite(n, 22)).join("")}</span></label>
    </section>
    <section class="pl-sec"><h3>Modules</h3>
      <div class="pl-set-row"><span>In machines</span><div class="pl-slots">${choice("defaultModule", "", "", "No modules", s.defaultModule === "")}${moduleNames.map((n) => choice("defaultModule", n, n, pd.modules[n]!.localised, s.defaultModule === n, n.startsWith("productivity") ? "Speed modules where productivity is not allowed" : "")).join("")}</div></div>
      <div class="pl-set-row"><span>Beacons</span>
        <div class="pl-stepper"><button type="button" data-action="default-beacons" data-delta="-1" aria-label="Fewer beacons">−</button><b>${s.defaultBeacons}</b><button type="button" data-action="default-beacons" data-delta="1" aria-label="More beacons">+</button></div>
        <div class="pl-slots">${beaconModules.map((n) => choice("defaultBeaconModule", n, n, pd.modules[n]!.localised, s.defaultBeaconModule === n)).join("")}</div></div>
    </section>
    <section class="pl-sec"><h3>Fuel and belts</h3>
      <div class="pl-set-row"><span>Burner fuel</span><div class="pl-slots">${fuels.map((f) => choice("fuel", f, f, pd.items[f]?.label ?? f, s.fuel === f, `${fmtNumber(pd.fuelValue[f]! / 1e6)} MJ`)).join("")}</div></div>
      <div class="pl-set-row"><span>Count belts as</span><div class="pl-slots">${pd.belts.map((b) => choice("belt", b.name, b.name, b.label, state.belt === b.name, `${fmtNumber(b.throughput)}/s`)).join("")}</div></div>
    </section>
    <section class="pl-sec"><h3>Research</h3>
      <div class="pl-research-list">
        <div class="pl-research" data-tip="Mining productivity" data-tip-sub="+10% per level, drills and pumpjacks">
          ${sprite("electric-mining-drill", 28)}<span>Mining</span>
          <div class="pl-stepper"><button type="button" data-action="mining" data-delta="-1" aria-label="Lower">−</button><b>${s.miningProductivity}</b><button type="button" data-action="mining" data-delta="1" aria-label="Raise">+</button></div>
        </div>
        ${research}
      </div>
    </section>
    <section class="pl-sec pl-insp-foot">
      <button type="button" class="pl-btn" data-action="reset-overrides" ${overrides ? "" : "disabled"}>Forget ${overrides} per-step choice${overrides === 1 ? "" : "s"}</button>
    </section>
  `;
}

/* ---------------------------------------------------------------- welcome */

const QUICK: { title: string; items: string[] }[] = [
  { title: "Science", items: ["automation-science-pack", "logistic-science-pack", "military-science-pack", "chemical-science-pack", "production-science-pack", "utility-science-pack", "space-science-pack"] },
  { title: "Space Age science", items: ["metallurgic-science-pack", "electromagnetic-science-pack", "agricultural-science-pack", "cryogenic-science-pack", "promethium-science-pack"] },
  { title: "Intermediates", items: ["electronic-circuit", "advanced-circuit", "processing-unit", "plastic-bar", "steel-plate", "low-density-structure", "rocket-fuel", "rocket-part", "battery", "electric-engine-unit"] },
];

export function welcomeHtml(pd: PlannerData): string {
  const rows = QUICK.map((q) => {
    const items = q.items.filter((i) => pd.items[i] && pd.producers[i]?.length);
    if (!items.length) return "";
    return `<div class="pl-welcome-row"><h3>${e(q.title)}</h3><div class="pl-slots is-big">${items.map((i) => `<button type="button" class="pl-slot" data-action="quick" data-item="${e(i)}" data-tip="${e(pd.items[i]!.label)}" data-tip-icon="${e(i)}">${sprite(i, 40)}</button>`).join("")}</div></div>`;
  }).join("");
  return `
    <div class="pl-welcome">
      <div class="pl-welcome-card gui-window">
        <div class="gui-titlebar"><span>What do you want to make?</span></div>
        <div class="gui-body">
          <p class="pl-lede">Pick a product and a rate. The planner works out every machine, module, belt and drill behind it, down to the ore — oil cracking, Kovarex and by-products included.</p>
          ${rows}
          <button type="button" class="pl-btn is-primary" data-action="add-target">Browse every item…</button>
        </div>
      </div>
    </div>`;
}
