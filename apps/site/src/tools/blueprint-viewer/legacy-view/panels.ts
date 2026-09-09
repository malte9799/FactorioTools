import type { CalculationResult, ItemFlow, MachineGroup, RecipeLine, ResearchLevels, Timescale } from "@factoriotools/engine";
import { TIMESCALE_FACTOR } from "@factoriotools/engine";
import type { BeltProto, BottleneckSubgroup, GameData, InserterProto, QualityName, ScaleWarning } from "@factoriotools/engine";
import {
  formatMachines,
  formatPercent,
  formatPower,
  formatRate,
  formatSigned,
} from "@factoriotools/engine";
import { icon } from "./icons.js";
import { html, raw } from "../html.js";

export type Measure =
  | { kind: "none" }
  | { kind: "belt"; belt: BeltProto; stackSize: number }
  | { kind: "inserter"; inserter: InserterProto; quality: QualityName };

export interface ViewOptions {
  timescale: Timescale;
  /** Manual "what if I built N copies" knob. */
  multiplier: number;
  /** Derived "hit this target" knob from a production-target input — kept
   *  conceptually separate from `multiplier` even though both multiply
   *  together at render time, so the UI doesn't fight itself if a user sets
   *  both. 1 when no target is set. */
  scaleFactor: number;
  measure: Measure;
  /** Item name the rocket silo is loaded with — not recorded in the
   *  blueprint, so the UI asks. Null until the user picks one. */
  rocketCargo: string | null;
  /** Researched level per recipe-productivity technology — not recorded in
   *  the blueprint (research is per-save, not per-blueprint), so the UI
   *  asks. Missing entries mean level 0 (unresearched). Mutated in place by
   *  the research panel's inputs, like rocketCargo above. */
  researchLevels: ResearchLevels;
}

export interface FlowHover {
  producers: Set<number>;
  consumers: Set<number>;
}

const UNIT: Record<Timescale, string> = {
  second: "/s",
  minute: "/m",
  hour: "/h",
};

/** "14.62 → 15 machines" — the exact scaled count plus the buildable
 *  (rounded up) count, extending formatMachines' existing fractional-display
 *  convention rather than introducing a new one. Plain "N×" when there's no
 *  scaling to show. */
function machineCountLabel(baseCount: number, scaleFactor: number): string {
  if (Math.abs(scaleFactor - 1) < 1e-9) return `${baseCount}×`;
  const exact = baseCount * scaleFactor;
  const rounded = Math.ceil(exact - 1e-9);
  return `${exact.toFixed(2)} → ${rounded}×`;
}

function entityNumbersFor(flow: ItemFlow): FlowHover {
  return {
    producers: new Set(flow.producers.flatMap((p) => p.group.entityNumbers)),
    consumers: new Set(flow.consumers.flatMap((c) => c.group.entityNumbers)),
  };
}

/** `ratePerSecond` must be unscaled — belt/inserter throughput are physical
 *  constants in items/second, independent of the display timescale. */
function measureLine(kind: "item" | "fluid", ratePerSecond: number, data: GameData, measure: Measure): string {
  if (kind !== "item") return "";
  if (measure.kind === "belt") {
    const perBelt = measure.belt.throughput * Math.max(measure.stackSize, 1);
    const count = Math.abs(ratePerSecond) / perBelt;
    return html`<span class="sub measure-sub">${count.toFixed(2)} × ${measure.belt.localised}${measure.stackSize > 1 ? ` (×${measure.stackSize} stack)` : ""}</span>`;
  }
  if (measure.kind === "inserter") {
    const qualityRatio = data.qualityMachineSpeed[measure.quality] ?? 1;
    const perInserter = measure.inserter.throughput * qualityRatio;
    const count = Math.abs(ratePerSecond) / perInserter;
    return html`<span class="sub measure-sub">${count.toFixed(2)} × ${measure.inserter.localised}${measure.quality !== "normal" ? ` (${measure.quality})` : ""}</span>`;
  }
  return "";
}

function recipeLineRow(
  line: RecipeLine,
  count: number,
  data: GameData,
  options: ViewOptions,
  sign: "" | "+" | "-",
): HTMLElement {
  const factor = TIMESCALE_FACTOR[options.timescale] * options.multiplier * options.scaleFactor;
  const scaled = line.ratePerMachine * count * factor;
  const row = document.createElement("div");
  row.className = "flow";
  row.innerHTML = html`
    <div class="flow-name">
      <span class="dot dot-${line.kind}"></span>
      <span>${line.label}</span>
    </div>
    <div class="flow-rate">
      <span class="value">${sign}${formatRate(scaled)}<span class="unit">${UNIT[options.timescale]}</span></span>
      ${raw(measureLine(line.kind, line.ratePerMachine * count * options.multiplier * options.scaleFactor, data, options.measure))}
    </div>
  `;
  row.querySelector(".flow-name")!.prepend(icon(line.name, line.label, 22));
  const measureName = options.measure.kind === "belt" ? options.measure.belt.name
    : options.measure.kind === "inserter" ? options.measure.inserter.name
    : null;
  const measureSub = row.querySelector(".measure-sub");
  if (measureSub && measureName) {
    measureSub.prepend(icon(measureName, measureName, 16));
  }
  return row;
}

/** The same ingredients/products a hovered machine's group would show in the
 *  Machines panel, laid out as a standalone card — used by the schematic's
 *  hover tooltip so it reads exactly like the numbers on the right. */
export function buildRecipeCard(group: MachineGroup, data: GameData, options: ViewOptions): HTMLElement {
  const bonuses = [
    group.effects.speed ? `speed ${formatPercent(group.effects.speed)}` : "",
    group.effects.productivity ? `prod ${formatPercent(group.effects.productivity)}` : "",
    group.beaconCount ? `${group.beaconCount} beacon${group.beaconCount > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");

  const card = document.createElement("div");
  card.className = "recipe-card";
  card.innerHTML = html`
    <div class="recipe-card-header">
      <div>
        <span class="recipe-card-title">${group.recipeLabel}</span>
        <span class="sub">${group.count}× ${group.machineLabel}${group.quality !== "normal" ? ` (${group.quality})` : ""} · ${group.moduleLabel}${bonuses ? ` · ${bonuses}` : ""}</span>
      </div>
    </div>
  `;
  card.querySelector(".recipe-card-header")!.prepend(icon(group.machineName, group.machineLabel, 28));

  if (group.ingredients.length) {
    const list = document.createElement("div");
    list.className = "flow-list";
    for (const line of group.ingredients) list.appendChild(recipeLineRow(line, group.count, data, options, "-"));
    card.appendChild(list);
  }
  if (group.products.length) {
    const list = document.createElement("div");
    list.className = "flow-list";
    for (const line of group.products) list.appendChild(recipeLineRow(line, group.count, data, options, "+"));
    card.appendChild(list);
  }
  return card;
}

function flowRow(
  flow: ItemFlow,
  data: GameData,
  options: ViewOptions,
  onHover: (hover: FlowHover | null) => void,
): HTMLElement {
  const factor = TIMESCALE_FACTOR[options.timescale] * options.multiplier * options.scaleFactor;
  const showNet = flow.category === "intermediate";
  const value = showNet ? flow.net : flow.category === "product" ? flow.produced : flow.consumed;
  const scaled = value * factor;

  const row = document.createElement("div");
  row.className = "flow";
  if (showNet) {
    row.classList.add(
      Math.abs(flow.net) < 1e-9 ? "is-balanced" : flow.net > 0 ? "is-surplus" : "is-deficit",
    );
  }

  const machines = flow.producers.reduce((sum, p) => sum + p.group.count, 0);
  const netMachines =
    showNet && flow.netMachines !== undefined
      ? html`<span class="net-machines">${formatMachines(flow.netMachines)}</span>`
      : "";

  row.innerHTML = html`
    <div class="flow-name">
      <span class="dot dot-${flow.kind}"></span>
      <span>${flow.label}</span>
      ${raw(machines ? html`<span class="count">×${machines}${raw(netMachines)}</span>` : "")}
    </div>
    <div class="flow-rate">
      <span class="value">${showNet ? formatSigned(scaled) : formatRate(scaled)}<span class="unit">${UNIT[options.timescale]}</span></span>
      ${raw(measureLine(flow.kind, value * options.multiplier * options.scaleFactor, data, options.measure))}
    </div>
  `;
  row.querySelector(".flow-name")!.prepend(icon(flow.name, flow.label, 26));

  const distinctProducers = [...new Set(flow.producers.map((p) => p.group.machineName))];
  const countBadge = row.querySelector(".count");
  if (countBadge && distinctProducers.length === 1) {
    countBadge.prepend(icon(distinctProducers[0]!, distinctProducers[0]!, 18));
  }

  const measureName = options.measure.kind === "belt" ? options.measure.belt.name
    : options.measure.kind === "inserter" ? options.measure.inserter.name
    : null;
  const measureSub = row.querySelector(".measure-sub");
  if (measureSub && measureName) {
    measureSub.prepend(icon(measureName, measureName, 16));
  }

  const hover = entityNumbersFor(flow);
  row.addEventListener("pointerenter", () => onHover(hover));
  row.addEventListener("pointerleave", () => onHover(null));
  row.tabIndex = 0;
  row.addEventListener("focus", () => onHover(hover));
  row.addEventListener("blur", () => onHover(null));
  row.title = `Produced ${formatRate(flow.produced * factor)}${UNIT[options.timescale]}, consumed ${formatRate(flow.consumed * factor)}${UNIT[options.timescale]}`;
  return row;
}

function section(
  title: string,
  hint: string,
  flows: ItemFlow[],
  data: GameData,
  options: ViewOptions,
  onHover: (hover: FlowHover | null) => void,
): HTMLElement | null {
  if (flows.length === 0) return null;
  const el = document.createElement("section");
  el.className = "panel";
  el.innerHTML = html`<h2>${title}<span class="hint">${hint}</span></h2>`;
  const list = document.createElement("div");
  list.className = "flow-list";
  for (const flow of flows) list.appendChild(flowRow(flow, data, options, onHover));
  el.appendChild(list);
  return el;
}

/** Recipe-productivity research (Steel plate productivity, Processing unit
 *  productivity, ...) isn't recorded in the blueprint — research is per-save,
 *  not per-blueprint — so this asks the user how many levels of each
 *  relevant technology they've researched. Only lists technologies whose
 *  recipe is actually running somewhere in this blueprint, so an unrelated
 *  build doesn't show all 8 vanilla entries. */
function researchPanel(
  data: GameData,
  result: CalculationResult,
  options: ViewOptions,
  onOptionsChange: () => void,
): HTMLElement | null {
  const recipeNames = new Set(result.groups.map((g) => g.recipeName));
  const relevant = Object.values(data.productivityTechnologies).filter((tech) =>
    tech.recipes.some((r) => recipeNames.has(r)),
  );
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => a.localised.localeCompare(b.localised));

  const el = document.createElement("section");
  el.className = "panel";
  el.innerHTML = `<h2>Research<span class="hint">productivity research isn't in the blueprint — enter what you've unlocked</span></h2>`;

  const list = document.createElement("div");
  list.className = "flow-list";
  for (const tech of relevant) {
    const level = options.researchLevels[tech.name] ?? 0;
    const row = document.createElement("div");
    row.className = "flow";
    row.innerHTML = `
      <div class="flow-name">
        <span>${tech.localised}</span>
        <span class="sub">${formatPercent(tech.changePerLevel)} productivity per level, on ${tech.recipes.map((r) => data.recipes[r]?.localised ?? r).join(", ")}</span>
      </div>
      <div class="flow-rate">
        <input type="number" min="0" step="1" value="${level}" aria-label="${tech.localised} level" class="research-level-input" />
      </div>
    `;
    const inputEl = row.querySelector<HTMLInputElement>(".research-level-input")!;
    inputEl.addEventListener("change", () => {
      const parsed = Math.max(0, Math.round(Number(inputEl.value)));
      inputEl.value = String(parsed);
      if (parsed === 0) delete options.researchLevels[tech.name];
      else options.researchLevels[tech.name] = parsed;
      onOptionsChange();
    });
    list.appendChild(row);
  }
  el.appendChild(list);
  return el;
}

/** A rocket silo's cargo isn't recorded in the blueprint — same gap as a
 *  furnace's recipe — so this asks the user what it's loaded with, then
 *  reports launches/min and how many of that item reach space per minute. */
function rocketPanel(
  data: GameData,
  result: CalculationResult,
  options: ViewOptions,
  onOptionsChange: () => void,
): HTMLElement {
  const siloParts =
    result.groups
      .map((g) => data.machines[g.machineName]?.siloParts)
      .find((p): p is number => !!p) ?? 50;
  const launchesPerSecond = result.rocketPartsPerSecond / siloParts;

  const cargoOptions = Object.values(data.items)
    .filter((item) => (item.rocketCapacity ?? 0) > 0)
    .sort((a, b) => a.localised.localeCompare(b.localised));

  const el = document.createElement("section");
  el.className = "panel";
  el.innerHTML = `<h2>Rocket<span class="hint">what a launch sends to space — cargo isn't in the blueprint, so pick it</span></h2>`;

  const picker = document.createElement("div");
  picker.className = "flow";
  picker.innerHTML = `
    <div class="flow-name">
      <span>Cargo</span>
      <select id="rocket-cargo" aria-label="Rocket cargo item">
        <option value="">choose an item</option>
      </select>
    </div>
  `;
  const select = picker.querySelector("select")!;
  for (const item of cargoOptions) {
    select.appendChild(new Option(item.localised, item.name));
  }
  if (options.rocketCargo && data.items[options.rocketCargo]?.rocketCapacity) {
    select.value = options.rocketCargo;
  }
  select.addEventListener("change", () => {
    options.rocketCargo = select.value || null;
    onOptionsChange();
  });
  el.appendChild(picker);

  const list = document.createElement("div");
  list.className = "flow-list";

  const launchRow = document.createElement("div");
  launchRow.className = "flow";
  const factor = TIMESCALE_FACTOR[options.timescale] * options.multiplier * options.scaleFactor;
  launchRow.innerHTML = `
    <div class="flow-name"><span>Launches</span></div>
    <div class="flow-rate"><span class="value">${formatRate(launchesPerSecond * factor)}<span class="unit">${UNIT[options.timescale]}</span></span></div>
  `;
  list.appendChild(launchRow);

  const cargo = options.rocketCargo ? data.items[options.rocketCargo] : null;
  if (cargo?.rocketCapacity) {
    const toSpaceRow = document.createElement("div");
    toSpaceRow.className = "flow";
    toSpaceRow.innerHTML = `
      <div class="flow-name">
        <span>${cargo.localised} to space</span>
      </div>
      <div class="flow-rate">
        <span class="value">${formatRate(launchesPerSecond * cargo.rocketCapacity * factor)}<span class="unit">${UNIT[options.timescale]}</span></span>
        <span class="sub">${cargo.rocketCapacity} per launch</span>
      </div>
    `;
    toSpaceRow.querySelector(".flow-name")!.prepend(icon(cargo.name, cargo.localised, 26));
    list.appendChild(toSpaceRow);
  }

  el.appendChild(list);
  return el;
}

export function renderResults(
  hosts: { results: HTMLElement; summary: HTMLElement },
  data: GameData,
  result: CalculationResult,
  options: ViewOptions,
  onHover: (hover: FlowHover | null) => void,
  onOptionsChange: () => void,
  bottlenecks?: Map<string, BottleneckSubgroup[]>,
  scaleWarnings?: ScaleWarning[],
): void {
  const container = hosts.results;
  container.replaceChildren();

  const machineTotal = result.groups.reduce((sum, g) => sum + g.count, 0) * options.scaleFactor;
  hosts.summary.className = "summary";
  hosts.summary.innerHTML = `
    <div><span class="k">Machines</span><span class="v">${options.scaleFactor === 1 ? machineTotal : machineTotal.toFixed(1)}</span></div>
    <div><span class="k">Entities</span><span class="v">${result.entityCount}</span></div>
    <div><span class="k">Peak power</span><span class="v">${formatPower(result.totalPower * options.multiplier * options.scaleFactor)}</span></div>
  `;

  if (scaleWarnings && scaleWarnings.length > 0) {
    const banner = document.createElement("section");
    banner.className = "panel scale-warning";
    banner.innerHTML = html`
      <h2>Target may not be met<span class="hint">these machines, fed as currently placed, would fall short of their scaled-up share</span></h2>
      <div class="flow-list">
        ${raw(scaleWarnings
          .map(
            (w) => html`
          <div class="flow warning">
            <div class="flow-name"><span>${w.recipeLabel}</span><span class="sub">${w.machinesNeeded}× sized for this target</span></div>
            <div class="flow-rate">
              <span class="value">${formatRate(w.actualDeliveredPerSecond)}<span class="unit">/s actual</span></span>
              <span class="sub">vs ${formatRate(w.targetSharePerSecond)}/s needed — consider stronger inserters</span>
            </div>
          </div>
        `,
          )
          .join(""))}
      </div>
    `;
    container.appendChild(banner);
  }

  const research = researchPanel(data, result, options, onOptionsChange);
  if (research) container.appendChild(research);

  for (const s of [
    section("Products", "made here and not used here", result.products, data, options, onHover),
    section("Intermediates", "net rate — aim for zero or above", result.intermediates, data, options, onHover),
    section("Ingredients", "must be supplied from outside", result.ingredients, data, options, onHover),
  ]) {
    if (s) container.appendChild(s);
  }

  if (result.groups.length) {
    const el = document.createElement("section");
    el.className = "panel";
    el.innerHTML = `<h2>Machines<span class="hint">grouped by identical configuration${bottlenecks ? " — actual rate accounts for adjacent inserters" : ""}</span></h2>`;
    const list = document.createElement("div");
    list.className = "flow-list";
    const factor = TIMESCALE_FACTOR[options.timescale] * options.multiplier * options.scaleFactor;
    for (const group of result.groups) {
      const bonuses = [
        group.effects.speed ? `speed ${formatPercent(group.effects.speed)}` : "",
        group.effects.productivity ? `prod ${formatPercent(group.effects.productivity)}` : "",
        group.beaconCount ? `${group.beaconCount} beacon${group.beaconCount > 1 ? "s" : ""}` : "",
      ].filter(Boolean).join(" · ");

      const subgroups = bottlenecks?.get(group.key);
      // No subgroup split (bottleneck feature off, or every entity in this
      // group has identical adjacency) — one row, theoretical rate only,
      // exactly like before the bottleneck engine existed.
      if (!subgroups || subgroups.length <= 1) {
        const sub = subgroups?.[0];
        const row = document.createElement("div");
        row.className = "flow group";
        const theoreticalRate = group.craftsPerSecond * group.count * factor;
        const isBottlenecked = sub && sub.bottleneck.limitedBy !== "machine";
        const actualRate = sub ? sub.bottleneck.actualCraftsPerSecond * group.count * factor : theoreticalRate;
        row.innerHTML = html`
          <div class="flow-name">
            <div>
              <span>${group.recipeLabel}</span>
              <span class="sub">${machineCountLabel(group.count, options.scaleFactor)} ${group.machineLabel}${group.quality !== "normal" ? ` (${group.quality})` : ""} · ${group.moduleLabel}${bonuses ? ` · ${bonuses}` : ""}</span>
            </div>
          </div>
          <div class="flow-rate">
            ${raw(isBottlenecked ? html`<span class="value bottleneck-actual">${formatRate(actualRate)}<span class="unit">${UNIT[options.timescale]}</span></span>
            <span class="sub bottleneck-theoretical">theoretical ${formatRate(theoreticalRate)}${UNIT[options.timescale]} · limited by ${sub!.bottleneck.limitingItem ?? sub!.bottleneck.limitedBy}</span>`
            : html`<span class="value">${formatRate(theoreticalRate)}<span class="unit">${UNIT[options.timescale]}</span></span>
            <span class="sub">crafts</span>`)}
          </div>
        `;
        row.querySelector(".flow-name")!.prepend(icon(group.machineName, group.machineLabel, 26));
        const hover: FlowHover = {
          producers: new Set(group.entityNumbers),
          consumers: new Set(),
        };
        row.addEventListener("pointerenter", () => onHover(hover));
        row.addEventListener("pointerleave", () => onHover(null));
        list.appendChild(row);
        continue;
      }

      // Mixed adjacency within one theoretical group (e.g. some furnaces fed
      // by a regular inserter, others by a stack inserter) — split into
      // sub-rows so the difference is visible, exactly the case the
      // bottleneck engine exists to surface.
      for (const sub of subgroups) {
        const row = document.createElement("div");
        row.className = "flow group";
        const count = sub.entityNumbers.length;
        const theoreticalRate = group.craftsPerSecond * count * factor;
        const actualRate = sub.bottleneck.actualCraftsPerSecond * count * factor;
        const isBottlenecked = sub.bottleneck.limitedBy !== "machine";
        row.innerHTML = html`
          <div class="flow-name">
            <div>
              <span>${group.recipeLabel}</span>
              <span class="sub">${machineCountLabel(count, options.scaleFactor)} ${group.machineLabel}${group.quality !== "normal" ? ` (${group.quality})` : ""} · ${group.moduleLabel}${bonuses ? ` · ${bonuses}` : ""}</span>
            </div>
          </div>
          <div class="flow-rate">
            ${raw(isBottlenecked ? html`<span class="value bottleneck-actual">${formatRate(actualRate)}<span class="unit">${UNIT[options.timescale]}</span></span>
            <span class="sub bottleneck-theoretical">theoretical ${formatRate(theoreticalRate)}${UNIT[options.timescale]} · limited by ${sub.bottleneck.limitingItem ?? sub.bottleneck.limitedBy}</span>`
            : html`<span class="value">${formatRate(theoreticalRate)}<span class="unit">${UNIT[options.timescale]}</span></span>
            <span class="sub">crafts</span>`)}
          </div>
        `;
        row.querySelector(".flow-name")!.prepend(icon(group.machineName, group.machineLabel, 26));
        const hover: FlowHover = {
          producers: new Set(sub.entityNumbers),
          consumers: new Set(),
        };
        row.addEventListener("pointerenter", () => onHover(hover));
        row.addEventListener("pointerleave", () => onHover(null));
        list.appendChild(row);
      }
    }
    el.appendChild(list);
    container.appendChild(el);
  }

  if (result.rocketPartsPerSecond > 0) {
    container.appendChild(rocketPanel(data, result, options, onOptionsChange));
  }

  if (result.warnings.length) {
    const el = document.createElement("section");
    el.className = "panel warnings";
    el.innerHTML = `<h2>Not counted<span class="hint">these entities were left out of the totals</span></h2>`;
    const list = document.createElement("div");
    list.className = "flow-list";
    for (const warning of result.warnings) {
      const row = document.createElement("div");
      row.className = "flow warning";
      row.innerHTML = html`
        <div class="flow-name">
          <span>${warning.entityName}</span>
          <span class="sub">${warning.detail}</span>
        </div>
        <div class="flow-rate"><span class="value">×${warning.count}</span></div>
      `;
      list.appendChild(row);
    }
    el.appendChild(list);
    container.appendChild(el);
  }

  const footnote = document.createElement("p");
  footnote.className = "dataset-note";
  footnote.textContent = `Dataset: ${data.version}. Rates are theoretical maxima — belt and inserter throughput are not simulated by default, see "measure against" above.`;
  container.appendChild(footnote);
}
