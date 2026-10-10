/** The production planner's view of the game: every way an item can be
 *  made, every machine that can make it, and the raw resources at the
 *  bottom of the chain.
 *
 *  GameData only knows crafting recipes. Ore, oil, water, steam and plants
 *  come from entities the dataset does not describe as recipes, so this
 *  file adds those as pseudo-recipes ("mine:iron-ore", "pump:water", ...)
 *  with the numbers the game uses, and pseudo-machines where the dataset has
 *  none (offshore pump, boiler, agricultural tower). */

import type { Effects, GameData, MenuPosition, RenderCatalog } from "../types.js";

export type RecipeKind =
  /** An ordinary recipe from the dataset. */
  | "craft"
  /** A mining drill on a resource patch. */
  | "mine"
  /** A pumpjack on an oil field, geyser or vent. */
  | "well"
  /** An offshore pump on water, lava or ammoniacal ocean. */
  | "pump"
  /** A boiler turning water into steam. */
  | "boil"
  /** Plants grown and harvested by agricultural towers. */
  | "grow"
  /** Something that turns into the item on its own (bacteria spoiling into ore). */
  | "spoil"
  /** Gathered by hand or collected in space; no machine to plan. */
  | "gather";

export interface PlanAmount {
  item: string;
  amount: number;
  /** Chance of the product, 0..1. Absent means always. */
  probability?: number;
  /** Portion productivity does not apply to (catalysts). */
  ignoredByProductivity?: number;
}

export interface PlanRecipe {
  id: string;
  kind: RecipeKind;
  label: string;
  /** Sprite to draw for the recipe. */
  icon: string;
  /** Crafting category; machines advertise the categories they accept. */
  category: string;
  /** Seconds per craft at speed 1. */
  time: number;
  ingredients: PlanAmount[];
  products: PlanAmount[];
  /** Whether productivity modules may go in (the game's allow_productivity). */
  allowProductivity: boolean;
  productivityTechnology?: string;
  /** Mining productivity research applies. */
  mining?: boolean;
  /** One-line note for the inspector (yield assumptions and the like). */
  note?: string;
}

export interface PlanMachine {
  name: string;
  label: string;
  icon: string;
  speed: number;
  categories: string[];
  moduleSlots: number;
  allowedEffects: (keyof Effects)[];
  baseEffect?: Partial<Effects>;
  /** Watts while working. */
  energyUsage: number;
  energySource: "electric" | "burner" | "none";
  /** Watts drawn even when idle (electric only). */
  drain?: number;
  /** Burner machines: what kind of fuel they take. */
  fuelCategory?: "chemical" | "nutrients" | "food";
  size: [number, number];
  /** Shown under the machine's count, e.g. "48 plants per tower". */
  note?: string;
}

export interface PlanItem {
  name: string;
  label: string;
  kind: "item" | "fluid";
  stackSize?: number;
  position?: MenuPosition;
}

export interface PlannerData {
  items: Record<string, PlanItem>;
  recipes: Record<string, PlanRecipe>;
  machines: Record<string, PlanMachine>;
  /** Recipes with a net positive output of the item, best guess first. */
  producers: Record<string, string[]>;
  /** Resource cost the solver minimises, per unit, for items taken from nature. */
  resourceCost: Record<string, number>;
  /** Fuel value in joules of every item the planner offers as fuel. */
  fuelValue: Record<string, number>;
  modules: GameData["modules"];
  beacon?: GameData["beacons"][string];
  belts: { name: string; label: string; throughput: number }[];
  productivityTechnologies: GameData["productivityTechnologies"];
  /** Build-menu tabs for the item picker. */
  groups: { name: string; label: string; icon: string; order: string }[];
}

/** Mining time per resource, and what the drill category is. Resources not
 *  listed here are not on any planet's surface in 2.0. */
const SOLID_RESOURCES: Record<string, { time: number; category: string; fluid?: PlanAmount }> = {
  "iron-ore": { time: 1, category: "basic-solid" },
  "copper-ore": { time: 1, category: "basic-solid" },
  stone: { time: 1, category: "basic-solid" },
  coal: { time: 1, category: "basic-solid" },
  // 10 acid per 10 ore: the drill spends fluid_amount per ten cycles.
  "uranium-ore": { time: 2, category: "basic-solid", fluid: { item: "sulfuric-acid", amount: 1 } },
  calcite: { time: 1, category: "basic-solid" },
  scrap: { time: 0.5, category: "basic-solid" },
  "tungsten-ore": { time: 5, category: "hard-solid" },
};

/** Fluids a pumpjack draws from a well: 10 per cycle at 100% yield. */
const WELLS: Record<string, string> = {
  "crude-oil": "Crude oil field",
  "sulfuric-acid": "Sulfuric acid geyser (Vulcanus)",
  fluorine: "Fluorine vent (Aquilo)",
  "lithium-brine": "Lithium brine (Aquilo)",
};

/** Fluids an offshore pump lifts, 1200/s each. */
const OFFSHORE: Record<string, string> = {
  water: "Water",
  lava: "Lava (Vulcanus)",
  "ammoniacal-solution": "Ammoniacal ocean (Aquilo)",
  "heavy-oil": "Heavy oil ocean (Fulgora)",
};

/** Plants: seed planted, harvest yield, growth time in seconds. */
const PLANTS: Record<string, { seed: string; yield: number; time: number }> = {
  yumako: { seed: "yumako-seed", yield: 50, time: 300 },
  jellynut: { seed: "jellynut-seed", yield: 50, time: 300 },
};

/** Items nothing in the planner makes, but which the world provides. */
const GATHERED: Record<string, string> = {
  wood: "Cut from trees",
  "raw-fish": "Caught from water",
  spoilage: "Left by anything that spoils",
  "metallic-asteroid-chunk": "Collected in space",
  "carbonic-asteroid-chunk": "Collected in space",
  "oxide-asteroid-chunk": "Collected in space",
  "promethium-asteroid-chunk": "Collected in space, past the solar system edge",
};

const SPOILS: { from: string; to: string; minutes: number }[] = [
  { from: "iron-bacteria", to: "iron-ore", minutes: 1 },
  { from: "copper-bacteria", to: "copper-ore", minutes: 1 },
];

/** Fuel values, in joules, of the fuels the planner offers. */
const FUEL_VALUES: Record<string, number> = {
  coal: 4e6,
  wood: 2e6,
  carbon: 2e6,
  "solid-fuel": 12e6,
  "rocket-fuel": 100e6,
  "nuclear-fuel": 1.21e9,
  nutrients: 2e6,
  bioflux: 6e6,
};

/** Which recipe to use for an item before the player picks one. Anything
 *  not listed prefers the recipe named after the item, then a resource,
 *  then the simplest recipe that makes it. */
const PREFERRED: Record<string, string> = {
  "petroleum-gas": "advanced-oil-processing",
  "heavy-oil": "advanced-oil-processing",
  "light-oil": "advanced-oil-processing",
  "solid-fuel": "solid-fuel-from-light-oil",
  "uranium-235": "uranium-processing",
  "uranium-238": "uranium-processing",
  "holmium-ore": "scrap-recycling",
  ice: "oxide-asteroid-crushing",
  nutrients: "nutrients-from-yumako-mash",
  "yumako-seed": "yumako-processing",
  "jellynut-seed": "jellynut-processing",
  "sulfuric-acid": "sulfuric-acid",
  "coal": "mine:coal",
  "iron-ore": "mine:iron-ore",
  "copper-ore": "mine:copper-ore",
  "water": "pump:water",
  "steam": "boil:steam",
  "carbon": "carbon",
  "ammonia": "ammoniacal-solution-separation",
  "fluoroketone-cold": "fluoroketone-cooling",
  "depleted-uranium-fuel-cell": "uranium-fuel-cell",
};

const SPACE_AGE_MACHINES = new Set(["foundry", "electromagnetic-plant", "cryogenic-plant", "biochamber", "big-mining-drill"]);

export function isSpaceAgeMachine(name: string): boolean {
  return SPACE_AGE_MACHINES.has(name);
}

function isExcludedRecipe(name: string, category: string, ingredients: PlanAmount[], products: PlanAmount[]): boolean {
  if (category === "recycling") return true;
  if (category === "recycling-or-hand-crafting" && name !== "scrap-recycling") return true;
  // Barrelling moves fluid around; it never makes anything.
  if (ingredients.some((i) => i.item === "barrel") && name !== "barrel") return true;
  if (products.some((p) => p.item === "barrel")) return true;
  if (name.startsWith("infinity-") || name.startsWith("parameter-")) return true;
  return products.length === 0;
}

/** The dump leaves placeable items and their recipes named by their
 *  prototype ("fast-inserter"); the catalog has their real names. */
function nameFor(name: string, localised: string, catalog?: RenderCatalog): string {
  if (localised && localised !== name) return localised;
  const known = catalog?.itemNames[name];
  if (known && known !== name) return known;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildPlannerData(data: GameData, catalog?: RenderCatalog): PlannerData {
  const items: Record<string, PlanItem> = {};
  for (const item of Object.values(data.items)) {
    if (item.name.startsWith("parameter-") || item.name.endsWith("-unknown")) continue;
    items[item.name] = {
      name: item.name,
      label: nameFor(item.name, item.localised, catalog),
      kind: item.kind,
      stackSize: item.stackSize,
      position: catalog?.itemMenuPositions[item.name] ?? catalog?.signals?.[item.name]?.position,
    };
  }

  const recipes: Record<string, PlanRecipe> = {};
  const recipeGroup = (name: string) => catalog?.recipeMenuPositions[name]?.group;

  for (const r of Object.values(data.recipes)) {
    const ingredients: PlanAmount[] = r.ingredients.map((i) => ({
      item: i.name,
      amount: i.amount,
      ...(i.ignoredByProductivity ? { ignoredByProductivity: i.ignoredByProductivity } : {}),
    }));
    const products: PlanAmount[] = r.results.map((p) => ({
      item: p.name,
      amount: p.amount,
      ...(p.probability !== undefined && p.probability !== 1 ? { probability: p.probability } : {}),
      ...(p.ignoredByProductivity ? { ignoredByProductivity: p.ignoredByProductivity } : {}),
    }));
    if (isExcludedRecipe(r.name, r.category, ingredients, products)) continue;
    if (products.some((p) => !items[p.item]) || ingredients.some((i) => !items[i.item])) continue;
    const group = recipeGroup(r.name);
    recipes[r.name] = {
      id: r.name,
      kind: "craft",
      label: r.localised !== r.name ? r.localised : items[r.results[0]?.name ?? ""]?.label ?? nameFor(r.name, r.localised, catalog),
      icon: r.name,
      category: r.category,
      time: r.energyRequired,
      ingredients,
      products,
      // 2.0 limits productivity to intermediate products; the dataset has
      // no allow_productivity flag, so go by the recipe's menu group.
      allowProductivity: group === undefined || group === "intermediate-products" || group === "fluids" || r.name === "rocket-part",
      ...(r.productivityTechnology ? { productivityTechnology: r.productivityTechnology } : {}),
    };
  }

  const add = (recipe: PlanRecipe) => {
    if (recipe.products.every((p) => items[p.item])) recipes[recipe.id] = recipe;
  };
  for (const [ore, spec] of Object.entries(SOLID_RESOURCES)) {
    add({
      id: `mine:${ore}`,
      kind: "mine",
      label: `Mine ${items[ore]?.label.toLowerCase() ?? ore}`,
      icon: ore,
      category: spec.category,
      time: spec.time,
      ingredients: spec.fluid ? [spec.fluid] : [],
      products: [{ item: ore, amount: 1 }],
      allowProductivity: true,
      mining: true,
      ...(spec.fluid ? { note: "Needs 1 sulfuric acid per ore" } : {}),
    });
  }
  for (const [fluid, label] of Object.entries(WELLS)) {
    add({
      id: `well:${fluid}`,
      kind: "well",
      label,
      icon: fluid,
      category: "basic-fluid",
      time: 1,
      ingredients: [],
      products: [{ item: fluid, amount: 10 }],
      allowProductivity: true,
      mining: true,
      note: "Assumes 100% yield; real wells vary",
    });
  }
  for (const [fluid, label] of Object.entries(OFFSHORE)) {
    add({
      id: `pump:${fluid}`,
      kind: "pump",
      label,
      icon: fluid,
      category: "offshore",
      time: 1,
      ingredients: [],
      products: [{ item: fluid, amount: 1200 }],
      allowProductivity: false,
    });
  }
  add({
    id: "boil:steam",
    kind: "boil",
    label: "Boil water",
    icon: "steam",
    category: "boiling",
    time: 1,
    ingredients: [{ item: "water", amount: 60 }],
    products: [{ item: "steam", amount: 60 }],
    allowProductivity: false,
  });
  for (const [plant, spec] of Object.entries(PLANTS)) {
    if (!items[spec.seed]) continue;
    add({
      id: `grow:${plant}`,
      kind: "grow",
      label: `Grow ${items[plant]?.label.toLowerCase() ?? plant}`,
      icon: plant,
      category: "agriculture",
      time: spec.time,
      ingredients: [{ item: spec.seed, amount: 1 }],
      products: [{ item: plant, amount: spec.yield }],
      allowProductivity: false,
      note: `One seed grows into ${spec.yield} fruit in ${spec.time / 60} min`,
    });
  }
  for (const s of SPOILS) {
    if (!items[s.from]) continue;
    add({
      id: `spoil:${s.to}`,
      kind: "spoil",
      label: `${items[s.from]!.label} spoiling`,
      icon: s.from,
      category: "spoiling",
      time: s.minutes * 60,
      ingredients: [{ item: s.from, amount: 1 }],
      products: [{ item: s.to, amount: 1 }],
      allowProductivity: false,
      note: `Turns into ${items[s.to]?.label.toLowerCase() ?? s.to} after ${s.minutes} min`,
    });
  }
  for (const [item, label] of Object.entries(GATHERED)) {
    add({
      id: `gather:${item}`,
      kind: "gather",
      label,
      icon: item,
      category: "gathering",
      time: 1,
      ingredients: [],
      products: [{ item, amount: 1 }],
      allowProductivity: false,
    });
  }

  const machines: Record<string, PlanMachine> = {};
  for (const m of Object.values(data.machines)) {
    if (m.kind !== "crafting" && m.kind !== "mining-drill") continue;
    const fuelCategory = m.energySource === "burner"
      ? m.name === "biochamber" ? "nutrients" : m.name === "captive-biter-spawner" ? "food" : "chemical"
      : undefined;
    machines[m.name] = {
      name: m.name,
      label: nameFor(m.name, m.localised, catalog),
      icon: m.name,
      speed: m.speed,
      categories: m.categories,
      moduleSlots: m.moduleSlots,
      allowedEffects: (m.allowedEffects ?? ["speed", "productivity", "consumption", "pollution", "quality"]) as (keyof Effects)[],
      ...(m.baseEffect ? { baseEffect: m.baseEffect } : {}),
      energyUsage: m.energyUsage,
      energySource: m.energySource === "burner" ? "burner" : m.energySource === "electric" ? "electric" : "none",
      ...(m.drain ? { drain: m.drain } : {}),
      ...(fuelCategory ? { fuelCategory } : {}),
      size: [m.size[0], m.size[1]],
    };
  }
  machines["offshore-pump"] = {
    name: "offshore-pump", label: "Offshore pump", icon: "offshore-pump", speed: 1, categories: ["offshore"],
    moduleSlots: 0, allowedEffects: [], energyUsage: 0, energySource: "none", size: [1, 2],
  };
  machines["boiler"] = {
    name: "boiler", label: "Boiler", icon: "boiler", speed: 1, categories: ["boiling"],
    moduleSlots: 0, allowedEffects: [], energyUsage: 1.8e6, energySource: "burner", fuelCategory: "chemical", size: [3, 2],
  };
  if (items["agricultural-tower"]) {
    // A tower tends the 7x7 grid of 3x3 plots around it, minus its own: 48 plants.
    machines["agricultural-tower"] = {
      name: "agricultural-tower", label: "Agricultural tower", icon: "agricultural-tower", speed: 48, categories: ["agriculture"],
      moduleSlots: 0, allowedEffects: [], energyUsage: 0, energySource: "none", size: [3, 3],
      note: "48 plants per tower, every plot planted",
    };
  }

  // Producers: every recipe with a net positive output of the item.
  const producers: Record<string, string[]> = {};
  for (const recipe of Object.values(recipes)) {
    for (const p of recipe.products) {
      const out = p.amount * (p.probability ?? 1);
      const back = recipe.ingredients.find((i) => i.item === p.item)?.amount ?? 0;
      if (out - back <= 1e-9) continue;
      (producers[p.item] ??= []).push(recipe.id);
    }
  }
  for (const [item, list] of Object.entries(producers)) {
    const rank = (id: string): number => {
      if (PREFERRED[item] === id) return 0;
      const r = recipes[id]!;
      if (id === item) return 1;
      if (r.kind !== "craft" && r.kind !== "spoil") return 2;
      if (r.products.length === 1 && r.products[0]!.item === item && !r.products[0]!.probability) return 3 + r.ingredients.length / 10;
      if (r.products[0]!.item === item) return 5;
      return 6 + r.products.length / 10;
    };
    list.sort((a, b) => rank(a) - rank(b));
  }

  const resourceCost: Record<string, number> = {};
  for (const ore of Object.keys(SOLID_RESOURCES)) resourceCost[ore] = 1;
  for (const fluid of Object.keys(WELLS)) resourceCost[fluid] = 0.1;
  for (const fluid of Object.keys(OFFSHORE)) resourceCost[fluid] = fluid === "heavy-oil" ? 0.1 : 1e-5;
  for (const item of Object.keys(GATHERED)) resourceCost[item] = 1;

  const fuelValue: Record<string, number> = {};
  for (const [item, value] of Object.entries(FUEL_VALUES)) if (items[item]) fuelValue[item] = value;

  const belts = Object.values(data.belts)
    .map((b) => ({ name: b.name, label: b.localised, throughput: b.throughput }))
    .sort((a, b) => a.throughput - b.throughput);

  const groups = (catalog?.menuGroups ?? [])
    .filter((g) => ["logistics", "production", "intermediate-products", "space", "combat", "fluids"].includes(g.name))
    .map((g) => ({ name: g.name, label: g.localised, icon: g.icon, order: g.order }));

  return {
    items,
    recipes,
    machines,
    producers,
    resourceCost,
    fuelValue,
    modules: data.modules,
    beacon: Object.values(data.beacons)[0],
    belts,
    productivityTechnologies: data.productivityTechnologies,
    groups,
  };
}

/** Items the player can ask the planner for: anything something makes. */
export function plannableItems(pd: PlannerData): PlanItem[] {
  return Object.values(pd.items).filter((item) => pd.producers[item.name]?.length);
}
