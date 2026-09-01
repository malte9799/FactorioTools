import type { GameData, MachineProto, RecipeProto } from "../types.js";

/**
 * Fallback dataset — hand-written, covers enough of vanilla to exercise the
 * engine end to end and to render something if the generated `game-data.json`
 * (see packages/data-pipeline) ever fails to load. Not complete and not
 * checked against a live game dump; the real dataset supersedes this whenever
 * it loads successfully.
 */

const machine = (
  name: string,
  localised: string,
  speed: number,
  categories: string[],
  moduleSlots: number,
  energyUsage: number,
  size: [number, number],
  extra: Partial<MachineProto> = {},
): MachineProto => ({
  name,
  kind: "crafting",
  speed,
  categories,
  moduleSlots,
  energyUsage,
  energySource: "electric",
  size,
  localised,
  ...extra,
});

const recipe = (
  name: string,
  localised: string,
  category: string,
  energyRequired: number,
  ingredients: [string, number][],
  results: [string, number][],
): RecipeProto => ({
  name,
  localised,
  category,
  energyRequired,
  ingredients: ingredients.map(([n, amount]) => ({ name: n, amount })),
  results: results.map(([n, amount]) => ({ name: n, amount })),
});

const item = (name: string, localised: string, stackSize: number) =>
  ({ name, localised, kind: "item" as const, stackSize });
const fluid = (name: string, localised: string) =>
  ({ name, localised, kind: "fluid" as const });

export const vanilla: GameData = {
  version: "starter-0.1 (unverified)",

  items: Object.fromEntries(
    [
      item("iron-ore", "Iron ore", 50),
      item("copper-ore", "Copper ore", 50),
      item("coal", "Coal", 50),
      item("stone", "Stone", 50),
      item("iron-plate", "Iron plate", 100),
      item("copper-plate", "Copper plate", 100),
      item("steel-plate", "Steel plate", 100),
      item("stone-brick", "Stone brick", 100),
      item("iron-gear-wheel", "Iron gear wheel", 100),
      item("copper-cable", "Copper cable", 200),
      item("electronic-circuit", "Electronic circuit", 200),
      item("advanced-circuit", "Advanced circuit", 200),
      item("processing-unit", "Processing unit", 100),
      item("plastic-bar", "Plastic bar", 100),
      item("sulfur", "Sulfur", 50),
      item("pipe", "Pipe", 100),
      item("engine-unit", "Engine unit", 50),
      item("electric-engine-unit", "Electric engine unit", 50),
      item("inserter", "Inserter", 50),
      item("transport-belt", "Transport belt", 100),
      item("low-density-structure", "Low density structure", 50),
      item("automation-science-pack", "Automation science pack", 200),
      item("logistic-science-pack", "Logistic science pack", 200),
      item("chemical-science-pack", "Chemical science pack", 200),
      fluid("water", "Water"),
      fluid("crude-oil", "Crude oil"),
      fluid("petroleum-gas", "Petroleum gas"),
      fluid("light-oil", "Light oil"),
      fluid("heavy-oil", "Heavy oil"),
      fluid("lubricant", "Lubricant"),
      fluid("sulfuric-acid", "Sulfuric acid"),
    ].map((i) => [i.name, i]),
  ),

  recipes: Object.fromEntries(
    [
      recipe("iron-plate", "Iron plate", "smelting", 3.2, [["iron-ore", 1]], [["iron-plate", 1]]),
      recipe("copper-plate", "Copper plate", "smelting", 3.2, [["copper-ore", 1]], [["copper-plate", 1]]),
      recipe("steel-plate", "Steel plate", "smelting", 16, [["iron-plate", 5]], [["steel-plate", 1]]),
      recipe("stone-brick", "Stone brick", "smelting", 3.2, [["stone", 2]], [["stone-brick", 1]]),
      recipe("iron-gear-wheel", "Iron gear wheel", "crafting", 0.5, [["iron-plate", 2]], [["iron-gear-wheel", 1]]),
      recipe("copper-cable", "Copper cable", "crafting", 0.5, [["copper-plate", 1]], [["copper-cable", 2]]),
      recipe("electronic-circuit", "Electronic circuit", "crafting", 0.5,
        [["iron-plate", 1], ["copper-cable", 3]], [["electronic-circuit", 1]]),
      recipe("advanced-circuit", "Advanced circuit", "crafting", 6,
        [["electronic-circuit", 2], ["plastic-bar", 2], ["copper-cable", 4]], [["advanced-circuit", 1]]),
      recipe("processing-unit", "Processing unit", "crafting-with-fluid", 10,
        [["electronic-circuit", 20], ["advanced-circuit", 2], ["sulfuric-acid", 5]], [["processing-unit", 1]]),
      recipe("pipe", "Pipe", "crafting", 0.5, [["iron-plate", 1]], [["pipe", 1]]),
      recipe("engine-unit", "Engine unit", "advanced-crafting", 10,
        [["steel-plate", 1], ["iron-gear-wheel", 1], ["pipe", 2]], [["engine-unit", 1]]),
      recipe("electric-engine-unit", "Electric engine unit", "crafting-with-fluid", 10,
        [["engine-unit", 1], ["lubricant", 15], ["electronic-circuit", 2]], [["electric-engine-unit", 1]]),
      recipe("inserter", "Inserter", "crafting", 0.5,
        [["iron-plate", 1], ["iron-gear-wheel", 1], ["electronic-circuit", 1]], [["inserter", 1]]),
      recipe("transport-belt", "Transport belt", "crafting", 0.5,
        [["iron-gear-wheel", 1], ["iron-plate", 1]], [["transport-belt", 2]]),
      recipe("plastic-bar", "Plastic bar", "chemistry", 1,
        [["coal", 1], ["petroleum-gas", 20]], [["plastic-bar", 2]]),
      recipe("sulfur", "Sulfur", "chemistry", 1,
        [["water", 30], ["petroleum-gas", 30]], [["sulfur", 2]]),
      recipe("sulfuric-acid", "Sulfuric acid", "chemistry", 1,
        [["iron-plate", 1], ["sulfur", 5], ["water", 100]], [["sulfuric-acid", 50]]),
      recipe("lubricant", "Lubricant", "chemistry", 1, [["heavy-oil", 10]], [["lubricant", 10]]),
      recipe("low-density-structure", "Low density structure", "advanced-crafting", 20,
        [["copper-plate", 20], ["steel-plate", 2], ["plastic-bar", 5]], [["low-density-structure", 1]]),
      recipe("automation-science-pack", "Automation science pack", "crafting", 5,
        [["copper-plate", 1], ["iron-gear-wheel", 1]], [["automation-science-pack", 1]]),
      recipe("logistic-science-pack", "Logistic science pack", "crafting", 6,
        [["transport-belt", 1], ["inserter", 1]], [["logistic-science-pack", 1]]),
      recipe("chemical-science-pack", "Chemical science pack", "crafting", 24,
        [["engine-unit", 3], ["advanced-circuit", 2], ["sulfur", 1]], [["chemical-science-pack", 2]]),
    ].map((r) => [r.name, r]),
  ),

  machines: Object.fromEntries(
    [
      machine("assembling-machine-1", "Assembling machine 1", 0.5,
        ["basic-crafting", "crafting"], 0, 75_000, [3, 3]),
      machine("assembling-machine-2", "Assembling machine 2", 0.75,
        ["basic-crafting", "crafting", "advanced-crafting", "crafting-with-fluid"], 2, 150_000, [3, 3]),
      machine("assembling-machine-3", "Assembling machine 3", 1.25,
        ["basic-crafting", "crafting", "advanced-crafting", "crafting-with-fluid"], 4, 375_000, [3, 3]),
      machine("stone-furnace", "Stone furnace", 1, ["smelting"], 0, 90_000, [2, 2],
        { energySource: "burner" }),
      machine("steel-furnace", "Steel furnace", 2, ["smelting"], 0, 90_000, [2, 2],
        { energySource: "burner" }),
      machine("electric-furnace", "Electric furnace", 2, ["smelting"], 2, 180_000, [3, 3]),
      machine("chemical-plant", "Chemical plant", 1, ["chemistry"], 3, 210_000, [3, 3]),
      machine("oil-refinery", "Oil refinery", 1, ["oil-processing"], 3, 420_000, [5, 5]),
      machine("centrifuge", "Centrifuge", 1, ["centrifuging"], 4, 350_000, [3, 3]),
      machine("lab", "Lab", 1, ["lab"], 2, 60_000, [3, 3], { kind: "lab" }),
      machine("electric-mining-drill", "Electric mining drill", 0.5, ["basic-solid"], 3, 90_000, [3, 3],
        { kind: "mining-drill" }),
    ].map((m) => [m.name, m]),
  ),

  modules: Object.fromEntries(
    [
      { name: "speed-module", localised: "Speed module 1", effects: { speed: 0.2, consumption: 0.5 } },
      { name: "speed-module-2", localised: "Speed module 2", effects: { speed: 0.3, consumption: 0.6 } },
      { name: "speed-module-3", localised: "Speed module 3", effects: { speed: 0.5, consumption: 0.7 } },
      { name: "productivity-module", localised: "Productivity module 1", effects: { productivity: 0.04, speed: -0.05, consumption: 0.4, pollution: 0.05 } },
      { name: "productivity-module-2", localised: "Productivity module 2", effects: { productivity: 0.06, speed: -0.1, consumption: 0.6, pollution: 0.07 } },
      { name: "productivity-module-3", localised: "Productivity module 3", effects: { productivity: 0.1, speed: -0.15, consumption: 0.8, pollution: 0.1 } },
      { name: "efficiency-module", localised: "Efficiency module 1", effects: { consumption: -0.3 } },
      { name: "efficiency-module-2", localised: "Efficiency module 2", effects: { consumption: -0.4 } },
      { name: "efficiency-module-3", localised: "Efficiency module 3", effects: { consumption: -0.5 } },
    ].map((m) => [m.name, m]),
  ),

  beacons: {
    beacon: {
      name: "beacon",
      localised: "Beacon",
      distributionEffectiveness: 1.5,
      supplyAreaDistance: 3,
      moduleSlots: 2,
      size: [3, 3],
      profile: [1, 0.7071, 0.5774, 0.5],
      energyUsage: 480_000,
    },
  },

  belts: Object.fromEntries(
    [
      { name: "transport-belt", localised: "Transport belt", throughput: 15 },
      { name: "fast-transport-belt", localised: "Fast transport belt", throughput: 30 },
      { name: "express-transport-belt", localised: "Express transport belt", throughput: 45 },
      { name: "turbo-transport-belt", localised: "Turbo transport belt", throughput: 60 },
    ].map((b) => [b.name, b]),
  ),

  // Chest-to-chest, no capacity-bonus research. Bulk/stack throughput already
  // includes their larger hand size.
  inserters: Object.fromEntries(
    [
      { name: "burner-inserter", localised: "Burner inserter", throughput: 0.79 },
      { name: "inserter", localised: "Inserter", throughput: 0.86 },
      { name: "long-handed-inserter", localised: "Long-handed inserter", throughput: 1.25 },
      { name: "fast-inserter", localised: "Fast inserter", throughput: 2.5 },
      { name: "bulk-inserter", localised: "Bulk inserter", throughput: 4.8 },
      { name: "stack-inserter", localised: "Stack inserter", throughput: 15 },
    ].map((b) => [b.name, b]),
  ),

  qualityMachineSpeed: {
    normal: 1,
    uncommon: 1.3,
    rare: 1.6,
    epic: 1.9,
    legendary: 2.5,
  },
  qualityModuleEffect: {
    normal: 1,
    uncommon: 1.3,
    rare: 1.6,
    epic: 1.9,
    legendary: 2.5,
  },
};
