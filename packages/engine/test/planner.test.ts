import assert from "node:assert/strict";
import fs from "node:fs";
import { buildPlannerData, DEFAULT_SETTINGS, simplex, solvePlan, type PlanSettings } from "../src/planner/index.js";
import type { GameData, RenderCatalog } from "../src/types.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const dataDir = new URL("../../../apps/site/public/data/", import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL("game-data.json", dataDir), "utf8")) as GameData;
const catalog = JSON.parse(fs.readFileSync(new URL("render-catalog.json", dataDir), "utf8")) as RenderCatalog;
const pd = buildPlannerData(data, catalog);

function settings(patch: Partial<PlanSettings> = {}): PlanSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch };
}

const close = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

function step(result: ReturnType<typeof solvePlan>, recipe: string) {
  const s = result.steps.find((x) => x.recipe.id === recipe);
  assert.ok(s, `no step for ${recipe}; have ${result.steps.map((x) => x.recipe.id).join(", ")}`);
  return s;
}

/** Every item's sources equal its sinks: production + import = use + target + leftover. */
function assertBalanced(result: ReturnType<typeof solvePlan>) {
  for (const b of Object.values(result.items)) {
    const used = result.steps.reduce((sum, s) => sum + (s.inputs.find((i) => i.item === b.item)?.rate ?? 0), 0);
    const made = result.steps.reduce((sum, s) => sum + (s.outputs.find((o) => o.item === b.item)?.rate ?? 0), 0);
    close(made + b.imported, used + b.target + b.surplus, 1e-6);
  }
}

console.log("planner");

test("simplex finds the cheaper of two ways to meet a demand", () => {
  // Rows: one item, demand 10. Columns: way A (cost 3), way B (cost 2), import (cost 100).
  const r = simplex([[1, 2, 1]], [10], [3, 2, 100], [2]);
  assert.equal(r.status, "optimal");
  close(r.x[0]!, 0);
  close(r.x[1]!, 5);
  close(r.objective, 10);
});

test("red science: 4 assembler 3s per pack a second, and the ore behind it", () => {
  const r = solvePlan(pd, settings(), [{ item: "automation-science-pack", rate: 1 }]);
  assert.ok(r.ok);
  close(step(r, "automation-science-pack").machines, 4);
  close(step(r, "copper-plate").machines, 1.6);
  close(step(r, "iron-plate").machines, 3.2);
  close(r.resources.find((x) => x.item === "iron-ore")!.rate, 2);
  close(r.resources.find((x) => x.item === "copper-ore")!.rate, 1);
  assert.equal(r.surplus.length, 0);
  assert.equal(r.imports.length, 0);
  assert.equal(r.buildings["assembling-machine-3"], 5);
  assertBalanced(r);
});

test("plastic cracks its heavy and light oil instead of wasting them", () => {
  const r = solvePlan(pd, settings(), [{ item: "plastic-bar", rate: 10 }]);
  assert.ok(r.ok);
  step(r, "advanced-oil-processing");
  step(r, "heavy-oil-cracking");
  step(r, "light-oil-cracking");
  assert.equal(r.surplus.length, 0, `leftovers: ${r.surplus.map((s) => s.item).join(", ")}`);
  assertBalanced(r);
});

test("flows from producers to consumers add up to each item's use", () => {
  const r = solvePlan(pd, settings(), [{ item: "advanced-circuit", rate: 2 }]);
  for (const s of r.steps) {
    for (const input of s.inputs) {
      const into = r.flows.filter((f) => f.to === s.id && f.item === input.item).reduce((sum, f) => sum + f.rate, 0);
      close(into, input.rate);
    }
  }
});

test("Kovarex: a loop that makes U-235 from U-238 balances", () => {
  const r = solvePlan(pd, settings({ recipeFor: { "uranium-235": "kovarex-enrichment-process" } }), [{ item: "uranium-235", rate: 1 }]);
  assert.ok(r.ok);
  const kovarex = step(r, "kovarex-enrichment-process");
  const processing = step(r, "uranium-processing");
  // Kovarex nets one U-235 a craft; the processing that feeds it U-238 makes a little U-235 too.
  const fromProcessing = processing.outputs.find((o) => o.item === "uranium-235")?.rate ?? 0;
  close(kovarex.crafts + fromProcessing, 1);
  assert.ok(kovarex.crafts > 0.9);
  // Kovarex eats 3 U-238 net per craft.
  close(processing.outputs.find((o) => o.item === "uranium-238")!.rate, 3 * kovarex.crafts, 1e-6);
  assertBalanced(r);
});

test("productivity modules: fewer inputs per output, slower machines", () => {
  const r = solvePlan(pd, settings({ defaultModule: "productivity-module-3" }), [{ item: "electronic-circuit", rate: 1 }]);
  const s = step(r, "electronic-circuit");
  close(s.effects.productivity, 0.4);
  close(s.effects.speed, -0.6);
  close(s.crafts, 1 / 1.4);
  // Assembler 3 at 1.25 × 0.4 speed, 0.5 s a craft.
  close(s.machines, (1 / 1.4) * 0.5 / (1.25 * 0.4));
  // Drills take productivity modules too.
  assert.ok(step(r, "mine:copper-ore").effects.productivity > 0);
});

test("productivity is not allowed on non-intermediates; speed modules go in instead", () => {
  const r = solvePlan(pd, settings({ defaultModule: "productivity-module-3" }), [{ item: "inserter", rate: 1 }]);
  const s = step(r, "inserter");
  close(s.effects.productivity, 0);
  assert.deepEqual(s.modules, Array(4).fill("speed-module-3"));
});

test("burner furnaces burn the chosen fuel", () => {
  const r = solvePlan(pd, settings({ furnace: "stone-furnace" }), [{ item: "iron-plate", rate: 1 }]);
  const s = step(r, "iron-plate");
  assert.equal(s.machine?.name, "stone-furnace");
  // 90 kW for 3.2 s per plate, from 4 MJ coal.
  close(s.fuel!.rate, 90e3 * 3.2 / 4e6);
  assert.equal(s.fuel!.item, "coal");
  assertBalanced(r);
});

test("an item marked as imported is brought in, not made", () => {
  const r = solvePlan(pd, settings({ recipeFor: { "iron-plate": "import" } }), [{ item: "iron-gear-wheel", rate: 1 }]);
  assert.ok(!r.steps.some((s) => s.recipe.id === "iron-plate" || s.recipe.id === "mine:iron-ore"));
  close(r.imports.find((i) => i.item === "iron-plate")!.rate, 2);
});

test("mining productivity research cuts the drills needed", () => {
  const base = step(solvePlan(pd, settings(), [{ item: "iron-ore", rate: 10 }]), "mine:iron-ore").machines;
  const researched = step(solvePlan(pd, settings({ miningProductivity: 10 }), [{ item: "iron-ore", rate: 10 }]), "mine:iron-ore").machines;
  close(base, 20);
  close(researched, 10);
});

test("Space Age machines are used when preferred", () => {
  const r = solvePlan(pd, settings({ preferSpaceAge: true }), [{ item: "electronic-circuit", rate: 1 }]);
  assert.equal(step(r, "electronic-circuit").machine?.name, "electromagnetic-plant");
  // The EM plant's own +50% productivity applies.
  close(step(r, "electronic-circuit").effects.productivity, 0.5);
});

test("Space Age science chains solve without imports", () => {
  for (const item of ["metallurgic-science-pack", "electromagnetic-science-pack", "agricultural-science-pack", "cryogenic-science-pack", "space-science-pack"]) {
    const r = solvePlan(pd, settings(), [{ item, rate: 1 }]);
    assert.ok(r.ok, item);
    assert.equal(r.imports.length, 0, `${item} imports ${r.imports.map((i) => i.item).join(", ")}`);
    assertBalanced(r);
  }
});

test("every item the picker offers can be planned", () => {
  for (const item of Object.keys(pd.producers)) {
    const r = solvePlan(pd, settings(), [{ item, rate: 1 }]);
    assert.ok(r.ok, `${item}: ${r.message}`);
    assertBalanced(r);
  }
});

console.log(`${passed} passed`);
