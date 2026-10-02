import type { Effects, GameData, PlacedEntity, QualityName, RecipeProto } from "../types.js";
import { findBeacons, resolveMachine, type ResolvedMachine } from "./effects.js";

export interface RecipeLine {
  name: string;
  label: string;
  kind: "item" | "fluid";
  /** Units per second, for one machine in the group (not multiplied by count). */
  ratePerMachine: number;
}

export interface MachineGroup {
  key: string;
  machineName: string;
  machineLabel: string;
  recipeName: string;
  recipeLabel: string;
  quality: QualityName;
  moduleLabel: string;
  beaconCount: number;
  count: number;
  /** Crafts per second for a single machine in this group. */
  craftsPerSecond: number;
  effects: Effects;
  /** Watts drawn by a single machine, including drain. */
  powerPerMachine: number;
  entityNumbers: number[];
  /** Rates for a single machine in the group (not multiplied by count) — for
   *  the schematic hover tooltip. */
  ingredients: RecipeLine[];
  products: RecipeLine[];
}

export interface ItemFlow {
  name: string;
  label: string;
  kind: "item" | "fluid";
  /** Units per second across the whole selection. */
  produced: number;
  consumed: number;
  net: number;
  category: "product" | "ingredient" | "intermediate";
  producers: { group: MachineGroup; rate: number }[];
  consumers: { group: MachineGroup; rate: number }[];
  /** How many more (negative) or spare (positive) producing machines the net
   *  rate corresponds to, using the first producing group as the yardstick. */
  netMachines?: number;
}

export interface Warning {
  kind: "unknown-entity" | "no-recipe" | "needs-input" | "unknown-recipe";
  entityName: string;
  count: number;
  detail: string;
}

export interface CalculationResult {
  groups: MachineGroup[];
  flows: ItemFlow[];
  products: ItemFlow[];
  ingredients: ItemFlow[];
  intermediates: ItemFlow[];
  /** Watts. */
  totalPower: number;
  /** Pollution units per second. */
  totalPollution: number;
  warnings: Warning[];
  entityCount: number;
  /** Rocket parts assembled per second, summed across every rocket silo
   *  group. A launch consumes `siloParts` of them, then sends one item
   *  stack's worth of cargo to space — but what cargo isn't recorded in the
   *  blueprint, so the UI asks the user and multiplies in rocketCapacity. */
  rocketPartsPerSecond: number;
  /** entity_number of every beacon reaching a given machine's entity_number.
   *  Per-entity rather than per-group: groupKey collapses on beacon *count*
   *  and effect magnitude, so two machines in the same group can still be in
   *  range of different beacons. */
  beaconsInRange: Map<number, number[]>;
}

function moduleLabel(entity: PlacedEntity): string {
  if (entity.modules.length === 0) return "no modules";
  return entity.modules
    .map((m) => `${m.count}× ${m.name}${m.quality === "normal" ? "" : ` (${m.quality})`}`)
    .join(", ");
}

function ingredientLines(data: GameData, recipe: RecipeProto, craftsPerSecond: number): RecipeLine[] {
  return recipe.ingredients.map((ingredient) => {
    const proto = data.items[ingredient.name];
    return {
      name: ingredient.name,
      label: proto?.localised ?? ingredient.name,
      kind: proto?.kind ?? "item",
      ratePerMachine: ingredient.amount * craftsPerSecond,
    };
  });
}

function productLines(
  data: GameData,
  recipe: RecipeProto,
  craftsPerSecond: number,
  productivity: number,
): RecipeLine[] {
  return recipe.results.map((result) => {
    const proto = data.items[result.name];
    const expected = result.amount * (result.probability ?? 1);
    // ignored_by_productivity is clamped to the expected amount — a recipe
    // can't have more of a product excluded from the bonus than it actually
    // produces (lua-api ItemProductPrototype.ignored_by_productivity).
    const ignored = Math.min(result.ignoredByProductivity ?? 0, expected);
    const boosted = (expected - ignored) * (1 + productivity) + ignored;
    return {
      name: result.name,
      label: proto?.localised ?? result.name,
      kind: proto?.kind ?? "item",
      ratePerMachine: boosted * craftsPerSecond,
    };
  });
}

/** Machines with the same name, quality, recipe, modules and beacon coverage
 *  behave identically, so they collapse into one row. */
function groupKey(entity: PlacedEntity, resolved: ResolvedMachine): string {
  const mods = entity.modules
    .map((m) => `${m.name}:${m.quality}:${m.count}`)
    .sort()
    .join("|");
  return [
    entity.name,
    entity.quality,
    entity.recipe ?? "-",
    mods,
    resolved.beaconCount,
    resolved.totalEffects.speed.toFixed(6),
    resolved.totalEffects.productivity.toFixed(6),
  ].join("/");
}

/** Researched level per productivity technology (e.g. "steel-plate-
 *  productivity" -> 3) — not recorded in a blueprint, so the caller collects
 *  it from the user. Missing entries mean level 0 (unresearched). */
export type ResearchLevels = Record<string, number>;

export function calculate(
  data: GameData,
  entities: PlacedEntity[],
  researchLevels: ResearchLevels = {},
): CalculationResult {
  const beacons = findBeacons(data, entities);
  const groups = new Map<string, MachineGroup>();
  const warnings = new Map<string, Warning>();
  const beaconsInRange = new Map<number, number[]>();

  const warn = (w: Warning) => {
    const existing = warnings.get(w.kind + w.entityName);
    if (existing) existing.count += 1;
    else warnings.set(w.kind + w.entityName, { ...w });
  };

  for (const entity of entities) {
    const machine = data.machines[entity.name];
    if (!machine) {
      // Belts, poles, chests, inserters and everything else with no rate of
      // its own — inserters ARE recognised (calc/throughput.ts reads them
      // for bottleneck analysis), just not machines with a craft rate here.
      if (!(entity.name in data.beacons) && !(entity.name in data.belts) && !(entity.name in data.inserters)) {
        warn({
          kind: "unknown-entity",
          entityName: entity.name,
          count: 1,
          detail: "Not in the dataset — skipped.",
        });
      }
      continue;
    }

    if (machine.kind === "mining-drill") {
      warn({
        kind: "needs-input",
        entityName: entity.name,
        count: 1,
        detail: "Blueprints don't record the ore underneath a drill. Set the resource to include it.",
      });
      continue;
    }

    if (!entity.recipe) {
      warn({
        kind: "no-recipe",
        entityName: entity.name,
        count: 1,
        detail:
          machine.categories.includes("smelting")
            ? "Furnace recipes come from whatever is inserted, so the blueprint has none. Assign one to include it."
            : "No recipe set in the blueprint.",
      });
      continue;
    }

    const recipe = data.recipes[entity.recipe];
    if (!recipe) {
      warn({
        kind: "unknown-recipe",
        entityName: entity.recipe,
        count: 1,
        detail: "Recipe is not in the dataset — skipped.",
      });
      continue;
    }

    const resolved = resolveMachine(data, machine, entity, beacons);
    if (resolved.beaconEntityNumbers.length) {
      beaconsInRange.set(entity.entityNumber, resolved.beaconEntityNumbers);
    }

    const key = groupKey(entity, resolved);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.entityNumbers.push(entity.entityNumber);
      continue;
    }

    const speed = resolved.baseSpeed * (1 + resolved.totalEffects.speed);
    // No per-tick ceiling: 2.0 completes several crafts in one tick when
    // speed allows (verified in-game: a beaconed AM3 on inserters at 92.7/s).
    const craftsPerSecond = speed / recipe.energyRequired;
    const power =
      machine.energySource === "electric"
        ? machine.energyUsage * (1 + resolved.totalEffects.consumption) + (machine.drain ?? 0)
        : 0;
    // Recipe-productivity research (Steel plate productivity, etc) is a
    // flat per-recipe bonus applied by the game engine directly — unlike
    // module/beacon productivity it is NOT gated by the machine's
    // allowed_effects (a restriction on what modules can affect, not on the
    // recipe's own baked-in bonus), so it's added after resolveMachine's
    // effects filtering, not through it.
    const researchLevel = recipe.productivityTechnology ? researchLevels[recipe.productivityTechnology] ?? 0 : 0;
    const researchProductivity =
      researchLevel * (data.productivityTechnologies[recipe.productivityTechnology ?? ""]?.changePerLevel ?? 0);
    const productivity = Math.min(
      resolved.totalEffects.productivity + researchProductivity,
      recipe.maximumProductivity ?? Infinity,
    );

    groups.set(key, {
      key,
      machineName: machine.name,
      machineLabel: machine.localised,
      recipeName: recipe.name,
      recipeLabel: recipe.localised,
      quality: entity.quality,
      moduleLabel: moduleLabel(entity),
      beaconCount: resolved.beaconCount,
      count: 1,
      craftsPerSecond,
      // productivity here is the capped total (modules + beacons + research)
      // used for the actual output math below, so the UI's "prod +X%" badge
      // matches what products[] was computed with rather than omitting
      // research's contribution.
      effects: { ...resolved.totalEffects, productivity },
      powerPerMachine: power,
      entityNumbers: [entity.entityNumber],
      ingredients: ingredientLines(data, recipe, craftsPerSecond),
      products: productLines(data, recipe, craftsPerSecond, productivity),
    });
  }

  // Beacons draw power even though they craft nothing.
  let beaconPower = 0;
  for (const beacon of beacons) {
    beaconPower += data.beacons[beacon.name]?.energyUsage ?? 0;
  }

  const flows = new Map<string, ItemFlow>();
  const flowFor = (name: string): ItemFlow => {
    let flow = flows.get(name);
    if (!flow) {
      const proto = data.items[name];
      flow = {
        name,
        label: proto?.localised ?? name,
        kind: proto?.kind ?? "item",
        produced: 0,
        consumed: 0,
        net: 0,
        category: "ingredient",
        producers: [],
        consumers: [],
      };
      flows.set(name, flow);
    }
    return flow;
  };

  let totalPower = beaconPower;
  let totalPollution = 0;
  let rocketPartsPerSecond = 0;

  for (const group of groups.values()) {
    totalPower += group.powerPerMachine * group.count;
    totalPollution += 0; // wired up once the dataset carries emissions_per_minute

    if (data.machines[group.machineName]?.siloParts) {
      rocketPartsPerSecond += group.craftsPerSecond * group.count;
    }

    for (const ingredient of group.ingredients) {
      const flow = flowFor(ingredient.name);
      flow.consumed += ingredient.ratePerMachine * group.count;
      flow.consumers.push({ group, rate: ingredient.ratePerMachine });
    }

    for (const product of group.products) {
      const flow = flowFor(product.name);
      flow.produced += product.ratePerMachine * group.count;
      flow.producers.push({ group, rate: product.ratePerMachine });
    }
  }

  for (const flow of flows.values()) {
    flow.net = flow.produced - flow.consumed;
    if (flow.produced > 0 && flow.consumed > 0) flow.category = "intermediate";
    else if (flow.produced > 0) flow.category = "product";
    else flow.category = "ingredient";

    if (flow.category === "intermediate" && flow.producers[0]) {
      const perMachine = flow.producers[0].rate;
      if (perMachine > 0) flow.netMachines = flow.net / perMachine;
    }
  }

  const byMagnitude = (a: ItemFlow, b: ItemFlow) =>
    Math.abs(b.net) - Math.abs(a.net) || a.label.localeCompare(b.label);
  const all = [...flows.values()];

  return {
    groups: [...groups.values()].sort(
      (a, b) => b.count - a.count || a.recipeLabel.localeCompare(b.recipeLabel),
    ),
    flows: all,
    products: all.filter((f) => f.category === "product").sort(byMagnitude),
    ingredients: all.filter((f) => f.category === "ingredient").sort(byMagnitude),
    intermediates: all.filter((f) => f.category === "intermediate").sort(byMagnitude),
    totalPower,
    totalPollution,
    warnings: [...warnings.values()],
    entityCount: entities.length,
    rocketPartsPerSecond,
    beaconsInRange,
  };
}

/* ---------- presentation-time scaling ---------- */

export type Timescale = "second" | "minute" | "hour";

export const TIMESCALE_FACTOR: Record<Timescale, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
};

export interface Divisor {
  /** Label such as "express belts" or "cargo wagons". */
  label: string;
  /** Units per second one of these carries, or null for no division. */
  perSecond: number | null;
}

export function scaleRate(
  ratePerSecond: number,
  timescale: Timescale,
  multiplier: number,
): number {
  return ratePerSecond * TIMESCALE_FACTOR[timescale] * multiplier;
}
