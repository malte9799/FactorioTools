/** Turns "this much of these items" into a production plan: which recipes
 *  run, how fast, in how many machines, and what flows between them.
 *
 *  The chain is found by walking back from the targets through the recipe
 *  chosen for each item. Because recipes can have several products (oil
 *  processing) or feed themselves (Kovarex), how hard each one runs is a
 *  linear program rather than a tree walk: every item's production minus
 *  consumption must equal its target, any item may be left over or brought
 *  in, and the plan that takes the least from the world wins. */

import type { Effects } from "../types.js";
import { simplex } from "./lp.js";
import { isSpaceAgeMachine, type PlanMachine, type PlanRecipe, type PlannerData } from "./model.js";

export interface PlanTarget {
  item: string;
  /** Per second. */
  rate: number;
}

export interface ModuleSetup {
  /** One module name per filled slot. */
  modules: string[];
  beacons: number;
  beaconModule: string;
}

export interface PlanSettings {
  assembler: string;
  furnace: string;
  drill: string;
  /** Use the Space Age machine wherever one can make the recipe. */
  preferSpaceAge: boolean;
  /** Fuel for burner machines that burn chemical fuel. */
  fuel: string;
  /** Module put in every slot that takes it ("" for none). */
  defaultModule: string;
  defaultBeacons: number;
  defaultBeaconModule: string;
  /** Mining productivity research level. */
  miningProductivity: number;
  /** Recipe productivity research level per technology. */
  research: Record<string, number>;
  /** Item → recipe id, or "import" to bring it in from elsewhere. */
  recipeFor: Record<string, string>;
  /** Recipe id → machine. */
  machineFor: Record<string, string>;
  /** Recipe id → its own modules and beacons. */
  modulesFor: Record<string, ModuleSetup>;
  /** Recipes the solver may not pick on its own to use up leftovers. */
  excluded: string[];
}

export const DEFAULT_SETTINGS: PlanSettings = {
  assembler: "assembling-machine-3",
  furnace: "electric-furnace",
  drill: "electric-mining-drill",
  preferSpaceAge: false,
  fuel: "coal",
  defaultModule: "",
  defaultBeacons: 0,
  defaultBeaconModule: "speed-module-3",
  miningProductivity: 0,
  research: {},
  recipeFor: {},
  machineFor: {},
  modulesFor: {},
  excluded: [],
};

export interface FlowAmount {
  item: string;
  /** Per second. */
  rate: number;
}

export interface PlanStep {
  id: string;
  recipe: PlanRecipe;
  /** The item this step is in the plan for. */
  item: string;
  machine: PlanMachine | null;
  /** Crafts per second, all machines together. */
  crafts: number;
  /** Machines needed, fractional. */
  machines: number;
  /** Crafts per second of one machine. */
  craftsPerMachine: number;
  effects: Effects;
  modules: string[];
  beacons: number;
  beaconModule: string;
  /** Electric draw, watts, for the fractional machine count. */
  power: number;
  /** Beacon draw, watts, if every machine has its own beacons. */
  beaconPower: number;
  fuel?: FlowAmount;
  inputs: FlowAmount[];
  outputs: FlowAmount[];
  /** Longest distance, in steps, from a target. */
  depth: number;
}

export type NodeId = string;

export interface PlanFlow {
  from: NodeId;
  to: NodeId;
  item: string;
  rate: number;
}

export interface ItemBalance {
  item: string;
  produced: number;
  consumed: number;
  imported: number;
  surplus: number;
  target: number;
}

export interface PlanResult {
  ok: boolean;
  message?: string;
  steps: PlanStep[];
  flows: PlanFlow[];
  items: Record<string, ItemBalance>;
  /** Items the world provides, per second: ore, oil, water, chunks. */
  resources: FlowAmount[];
  /** Items brought in because nothing makes them, or because the player said so. */
  imports: FlowAmount[];
  surplus: FlowAmount[];
  targets: PlanTarget[];
  power: number;
  /** Machine name → whole machines to build. */
  buildings: Record<string, number>;
  /** Module name → count to fill every whole machine and beacon. */
  moduleCounts: Record<string, number>;
  beaconCount: number;
}

const MACHINE_FAMILIES = [
  ["assembling-machine-1", "assembling-machine-2", "assembling-machine-3"],
  ["stone-furnace", "steel-furnace", "electric-furnace"],
  ["burner-mining-drill", "electric-mining-drill", "big-mining-drill"],
];

/** Module kinds by the effect that decides whether a machine accepts them. */
function moduleGate(name: string): keyof Effects {
  if (name.startsWith("productivity")) return "productivity";
  if (name.startsWith("efficiency")) return "consumption";
  if (name.startsWith("quality")) return "quality";
  return "speed";
}

export function machinesFor(pd: PlannerData, recipe: PlanRecipe): PlanMachine[] {
  return Object.values(pd.machines).filter((m) => m.categories.includes(recipe.category));
}

export function pickMachine(pd: PlannerData, settings: PlanSettings, recipe: PlanRecipe): PlanMachine | null {
  const candidates = machinesFor(pd, recipe);
  if (!candidates.length) return null;
  const chosen = settings.machineFor[recipe.id];
  const exact = candidates.find((m) => m.name === chosen);
  if (exact) return exact;

  const spaceAge = candidates.filter((m) => isSpaceAgeMachine(m.name));
  const base = candidates.filter((m) => !isSpaceAgeMachine(m.name));
  // The big drill is the only one that mines tungsten, so it is not a preference there.
  if (settings.preferSpaceAge && spaceAge.length) return spaceAge[0]!;
  const pool = base.length ? base : spaceAge;

  for (const preferred of [settings.assembler, settings.furnace, settings.drill]) {
    const family = MACHINE_FAMILIES.find((f) => f.includes(preferred));
    if (!family) continue;
    // The chosen tier, or the next one up that can make this (an assembler 1
    // takes no fluids), or failing that the next one down.
    const from = family.indexOf(preferred);
    const order = [...family.slice(from), ...family.slice(0, from).reverse()];
    for (const name of order) {
      const m = pool.find((c) => c.name === name);
      if (m) return m;
    }
  }
  return pool.slice().sort((a, b) => b.speed - a.speed)[0]!;
}

export function canUseModule(pd: PlannerData, machine: PlanMachine, recipe: PlanRecipe, module: string): boolean {
  if (!pd.modules[module]) return false;
  const gate = moduleGate(module);
  if (!machine.allowedEffects.includes(gate)) return false;
  if (gate === "productivity" && !recipe.allowProductivity) return false;
  return true;
}

/** The modules and beacons a step runs with: its own, or the defaults
 *  trimmed to what the machine and recipe accept. */
export function moduleSetup(pd: PlannerData, settings: PlanSettings, recipe: PlanRecipe, machine: PlanMachine | null): ModuleSetup {
  if (!machine || machine.moduleSlots === 0) return { modules: [], beacons: 0, beaconModule: "" };
  const own = settings.modulesFor[recipe.id];
  if (own) {
    return {
      modules: own.modules.filter((m) => canUseModule(pd, machine, recipe, m)).slice(0, machine.moduleSlots),
      beacons: own.beacons,
      beaconModule: own.beaconModule,
    };
  }
  let fill = settings.defaultModule;
  // Productivity where the recipe takes it, speed of the same tier elsewhere.
  if (fill && !canUseModule(pd, machine, recipe, fill) && moduleGate(fill) === "productivity") {
    fill = fill.replace("productivity", "speed");
  }
  const modules = fill && canUseModule(pd, machine, recipe, fill) ? Array<string>(machine.moduleSlots).fill(fill) : [];
  return { modules, beacons: settings.defaultBeacons, beaconModule: settings.defaultBeaconModule };
}

const NO_EFFECTS: Effects = { speed: 0, productivity: 0, consumption: 0, pollution: 0, quality: 0 };
const KEYS = Object.keys(NO_EFFECTS) as (keyof Effects)[];
/** 2.0 caps recipe productivity at +300% unless a recipe says otherwise. */
const MAX_PRODUCTIVITY = 3;

export function stepEffects(pd: PlannerData, settings: PlanSettings, recipe: PlanRecipe, machine: PlanMachine | null, setup: ModuleSetup): Effects {
  const total = { ...NO_EFFECTS };
  if (!machine) return total;
  for (const name of setup.modules) {
    const effects = pd.modules[name]?.effects ?? {};
    for (const k of KEYS) total[k] += effects[k] ?? 0;
  }
  const beacon = pd.beacon;
  if (beacon && setup.beacons > 0 && setup.beaconModule && pd.modules[setup.beaconModule]) {
    const profile = beacon.profile?.length ? beacon.profile[Math.min(setup.beacons, beacon.profile.length) - 1]! : 1;
    const share = beacon.distributionEffectiveness * profile * setup.beacons * beacon.moduleSlots;
    const effects = pd.modules[setup.beaconModule]!.effects;
    for (const k of KEYS) if (k !== "productivity") total[k] += (effects[k] ?? 0) * share;
  }
  total.speed = Math.max(total.speed, -0.8);
  total.consumption = Math.max(total.consumption, -0.8);
  for (const k of KEYS) if (!machine.allowedEffects.includes(k)) total[k] = 0;
  if (machine.baseEffect) for (const k of KEYS) total[k] += machine.baseEffect[k] ?? 0;

  if (recipe.mining) total.productivity += settings.miningProductivity * 0.1;
  if (recipe.productivityTechnology) {
    const tech = pd.productivityTechnologies[recipe.productivityTechnology];
    total.productivity += (settings.research[recipe.productivityTechnology] ?? 0) * (tech?.changePerLevel ?? 0);
  }
  total.productivity = recipe.allowProductivity ? Math.min(Math.max(total.productivity, 0), MAX_PRODUCTIVITY) : 0;
  total.pollution = Math.max(total.pollution, -0.8);
  return total;
}

function fuelFor(pd: PlannerData, settings: PlanSettings, machine: PlanMachine): string | undefined {
  if (machine.energySource !== "burner") return undefined;
  if (machine.fuelCategory === "nutrients") return pd.fuelValue["nutrients"] ? "nutrients" : undefined;
  if (machine.fuelCategory === "food") return pd.fuelValue["bioflux"] ? "bioflux" : undefined;
  return pd.fuelValue[settings.fuel] ? settings.fuel : pd.fuelValue["coal"] ? "coal" : undefined;
}

/** How one step converts items, per craft, with its machine's bonuses. */
interface Prepared {
  recipe: PlanRecipe;
  item: string;
  machine: PlanMachine | null;
  setup: ModuleSetup;
  effects: Effects;
  craftsPerMachine: number;
  /** Net per craft, by item. */
  net: Map<string, number>;
  fuel?: { item: string; perCraft: number };
}

function prepare(pd: PlannerData, settings: PlanSettings, recipe: PlanRecipe, item: string): Prepared {
  const machine = pickMachine(pd, settings, recipe);
  const setup = moduleSetup(pd, settings, recipe, machine);
  const effects = stepEffects(pd, settings, recipe, machine, setup);
  const speed = machine ? machine.speed * (1 + effects.speed) : 1;
  const craftsPerMachine = speed / recipe.time;

  const net = new Map<string, number>();
  const bump = (name: string, v: number) => net.set(name, (net.get(name) ?? 0) + v);
  for (const p of recipe.products) {
    const base = p.amount;
    const extra = Math.max(0, base - (p.ignoredByProductivity ?? 0)) * effects.productivity;
    bump(p.item, (base + extra) * (p.probability ?? 1));
  }
  for (const i of recipe.ingredients) bump(i.item, -i.amount);

  let fuel: Prepared["fuel"];
  if (machine) {
    const fuelItem = fuelFor(pd, settings, machine);
    if (fuelItem) {
      const joulesPerCraft = machine.energyUsage * (1 + effects.consumption) / craftsPerMachine;
      const perCraft = joulesPerCraft / pd.fuelValue[fuelItem]!;
      fuel = { item: fuelItem, perCraft };
      bump(fuelItem, -perCraft);
    }
  }
  return { recipe, item, machine, setup, effects, craftsPerMachine, net, ...(fuel ? { fuel } : {}) };
}

function chosenRecipe(pd: PlannerData, settings: PlanSettings, item: string): string | null {
  const picked = settings.recipeFor[item];
  if (picked === "import") return null;
  if (picked && pd.recipes[picked]) return picked;
  const list = pd.producers[item] ?? [];
  return list.find((id) => !settings.excluded.includes(id)) ?? list[0] ?? null;
}

export function solvePlan(pd: PlannerData, settings: PlanSettings, targets: PlanTarget[]): PlanResult {
  const active = new Map<string, Prepared>();
  const userImports = new Set<string>();
  const seen = new Set<string>();
  const queue = targets.filter((t) => pd.items[t.item]).map((t) => t.item);

  // Walk back from the targets through each item's chosen recipe.
  while (queue.length) {
    const item = queue.shift()!;
    if (seen.has(item)) continue;
    seen.add(item);
    if (settings.recipeFor[item] === "import") {
      userImports.add(item);
      continue;
    }
    const id = chosenRecipe(pd, settings, item);
    if (!id) continue;
    if (!active.has(id)) {
      const prepared = prepare(pd, settings, pd.recipes[id]!, item);
      active.set(id, prepared);
      for (const [name, v] of prepared.net) if (v < 0) queue.push(name);
    }
  }

  // Bring in recipes that turn a by-product into something the plan already
  // needs (heavy oil cracked into light oil, light oil into gas). The solver
  // only runs them if they save resources.
  const produced = () => {
    const set = new Set<string>();
    for (const p of active.values()) for (const [name, v] of p.net) if (v > 0) set.add(name);
    return set;
  };
  const needed = () => {
    const set = new Set<string>(targets.map((t) => t.item));
    for (const p of active.values()) for (const [name, v] of p.net) if (v < 0) set.add(name);
    return set;
  };
  for (let round = 0; round < 4; round++) {
    const have = produced();
    const want = needed();
    let added = false;
    for (const recipe of Object.values(pd.recipes)) {
      if (recipe.kind !== "craft" || active.has(recipe.id) || settings.excluded.includes(recipe.id)) continue;
      if (!recipe.ingredients.length) continue;
      const products = recipe.products.map((p) => p.item);
      if (!products.every((p) => want.has(p) && !userImports.has(p))) continue;
      if (recipe.ingredients.some((i) => products.includes(i.item))) continue;
      const usesLeftover = recipe.ingredients.some((i) => have.has(i.item) && !(pd.resourceCost[i.item]! < 0.01));
      const canFeed = recipe.ingredients.every((i) => have.has(i.item) || pd.resourceCost[i.item] !== undefined && pd.resourceCost[i.item]! < 0.01);
      if (!usesLeftover || !canFeed) continue;
      const prepared = prepare(pd, settings, recipe, recipe.products[0]!.item);
      active.set(recipe.id, prepared);
      added = true;
    }
    if (!added) break;
  }

  // Rows: every item touched. Columns: recipes, then an import and a
  // surplus column per item.
  const itemSet = new Set<string>(targets.map((t) => t.item).filter((i) => pd.items[i]));
  for (const p of active.values()) for (const name of p.net.keys()) itemSet.add(name);
  const itemList = [...itemSet];
  const row = new Map(itemList.map((name, i) => [name, i]));
  const steps = [...active.values()];
  const m = itemList.length;
  const nR = steps.length;
  const n = nR + 2 * m;

  const A: number[][] = itemList.map(() => new Array<number>(n).fill(0));
  const c = new Array<number>(n).fill(0);
  steps.forEach((p, j) => {
    for (const [name, v] of p.net) A[row.get(name)!]![j] = v;
    // Resource extraction costs what it takes from the world; every step
    // also costs a little per machine, so a recipe that only saves a
    // trickle of water is not worth building.
    let cost = 1e-3 / p.craftsPerMachine;
    if (p.recipe.kind === "mine" || p.recipe.kind === "well" || p.recipe.kind === "pump" || p.recipe.kind === "gather") {
      for (const prod of p.recipe.products) cost += (pd.resourceCost[prod.item] ?? 1) * (p.net.get(prod.item) ?? 0);
    }
    c[j] = cost;
  });
  itemList.forEach((name, i) => {
    A[i]![nR + i] = 1;
    A[i]![nR + m + i] = -1;
    const hasProducer = steps.some((p) => (p.net.get(name) ?? 0) > 0);
    c[nR + i] = userImports.has(name) ? 0 : hasProducer ? 1e6 : 1e3;
    // Leftovers cost nothing: a by-product is only turned into something
    // else when that saves resources, not just to tidy the balance sheet.
    c[nR + m + i] = 0;
  });
  const b = itemList.map((name) => targets.filter((t) => t.item === name).reduce((s, t) => s + Math.max(0, t.rate), 0));
  const basis = itemList.map((_, i) => nR + i);
  const lp = simplex(A, b, c, basis);

  const x = lp.x;
  const result: PlanResult = {
    ok: lp.status === "optimal",
    ...(lp.status !== "optimal" ? { message: lp.status === "unbounded" ? "The plan has no limit — a loop makes something from nothing." : "The solver gave up on this one." } : {}),
    steps: [],
    flows: [],
    items: {},
    resources: [],
    imports: [],
    surplus: [],
    targets: targets.filter((t) => pd.items[t.item] && t.rate > 0),
    power: 0,
    buildings: {},
    moduleCounts: {},
    beaconCount: 0,
  };

  const TINY = 1e-9;
  steps.forEach((p, j) => {
    const crafts = x[j]!;
    if (crafts <= TINY) return;
    const machines = p.machine ? crafts / p.craftsPerMachine : 0;
    const inputs: FlowAmount[] = [];
    const outputs: FlowAmount[] = [];
    for (const [name, v] of p.net) {
      if (v > TINY) outputs.push({ item: name, rate: v * crafts });
      else if (v < -TINY) inputs.push({ item: name, rate: -v * crafts });
    }
    // Keep the recipe's own order: main product first.
    const order = (list: FlowAmount[], ref: string[]) => list.sort((a, b) => ref.indexOf(a.item) - ref.indexOf(b.item));
    order(outputs, p.recipe.products.map((q) => q.item));
    order(inputs, [...p.recipe.ingredients.map((q) => q.item), p.fuel?.item ?? ""]);
    const electric = p.machine?.energySource === "electric";
    const power = electric ? machines * p.machine!.energyUsage * (1 + p.effects.consumption) + Math.ceil(machines - 1e-6) * (p.machine!.drain ?? 0) : 0;
    const beaconPower = p.setup.beacons > 0 && pd.beacon ? Math.ceil(machines - 1e-6) * p.setup.beacons * pd.beacon.energyUsage : 0;
    result.steps.push({
      id: `step:${p.recipe.id}`,
      recipe: p.recipe,
      item: p.item,
      machine: p.machine,
      crafts,
      machines,
      craftsPerMachine: p.craftsPerMachine,
      effects: p.effects,
      modules: p.setup.modules,
      beacons: p.setup.beacons,
      beaconModule: p.setup.beaconModule,
      power,
      beaconPower,
      ...(p.fuel ? { fuel: { item: p.fuel.item, rate: p.fuel.perCraft * crafts } } : {}),
      inputs,
      outputs,
      depth: 0,
    });
  });

  // Balances and flows. Every item's producers feed its consumers in
  // proportion: a recipe making 30% of the gas gets 30% of every consumer.
  for (const name of itemList) {
    const i = row.get(name)!;
    const imported = x[nR + i]!;
    const surplus = x[nR + m + i]!;
    const target = b[i]!;
    const sources: { id: NodeId; rate: number }[] = [];
    const sinks: { id: NodeId; rate: number }[] = [];
    for (const step of result.steps) {
      const out = step.outputs.find((o) => o.item === name);
      if (out) sources.push({ id: step.id, rate: out.rate });
      const inp = step.inputs.find((o) => o.item === name);
      if (inp) sinks.push({ id: step.id, rate: inp.rate });
    }
    if (imported > TINY) sources.push({ id: `import:${name}`, rate: imported });
    if (target > TINY) sinks.push({ id: `target:${name}`, rate: target });
    if (surplus > TINY) sinks.push({ id: `surplus:${name}`, rate: surplus });
    const produced = sources.reduce((s, v) => s + v.rate, 0);
    const consumed = sinks.reduce((s, v) => s + v.rate, 0);
    result.items[name] = { item: name, produced, consumed, imported, surplus, target };
    if (imported > TINY) result.imports.push({ item: name, rate: imported });
    if (surplus > 1e-7) result.surplus.push({ item: name, rate: surplus });
    if (produced <= TINY) continue;
    for (const src of sources) {
      for (const sink of sinks) {
        const rate = (src.rate * sink.rate) / produced;
        if (rate > TINY) result.flows.push({ from: src.id, to: sink.id, item: name, rate });
      }
    }
  }

  for (const step of result.steps) {
    const kind = step.recipe.kind;
    if (kind === "mine" || kind === "well" || kind === "pump" || kind === "gather") {
      for (const out of step.outputs) result.resources.push({ item: out.item, rate: out.rate });
    }
    result.power += step.power + step.beaconPower;
    if (step.machine && step.machines > TINY) {
      const whole = Math.ceil(step.machines - 1e-6);
      result.buildings[step.machine.name] = (result.buildings[step.machine.name] ?? 0) + whole;
      for (const mod of step.modules) result.moduleCounts[mod] = (result.moduleCounts[mod] ?? 0) + whole;
      if (step.beacons > 0 && step.beaconModule) {
        result.beaconCount += whole * step.beacons;
        result.moduleCounts[step.beaconModule] = (result.moduleCounts[step.beaconModule] ?? 0) + whole * step.beacons * (pd.beacon?.moduleSlots ?? 2);
      }
    }
  }
  result.resources.sort((a, b) => b.rate * (pd.items[b.item]?.kind === "fluid" ? 0.1 : 1) - a.rate * (pd.items[a.item]?.kind === "fluid" ? 0.1 : 1));

  assignDepth(result);
  return result;
}

/** Longest path from each step to a target, ignoring edges that close a loop. */
function assignDepth(result: PlanResult): void {
  const out = new Map<NodeId, NodeId[]>();
  for (const f of result.flows) {
    if (!out.has(f.from)) out.set(f.from, []);
    out.get(f.from)!.push(f.to);
  }
  const depth = new Map<NodeId, number>();
  const visiting = new Set<NodeId>();
  const visit = (id: NodeId): number => {
    if (id.startsWith("target:") || id.startsWith("surplus:")) return 0;
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return -Infinity;
    visiting.add(id);
    let d = 0;
    for (const to of out.get(id) ?? []) d = Math.max(d, visit(to) + 1);
    visiting.delete(id);
    if (!Number.isFinite(d)) d = 1;
    depth.set(id, d);
    return d;
  };
  for (const step of result.steps) step.depth = visit(step.id);
}
