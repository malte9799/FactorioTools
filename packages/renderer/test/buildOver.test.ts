import assert from "node:assert/strict";
import { canBuildOver, undergroundForPlacement, type ResolvedVisual } from "../src/entityLookup.js";
import type { PlacedEntity } from "@factoriotools/engine";

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

const NORTH = 0;
const EAST = 4;
const WEST = 12;

const GROUPS: Record<string, string> = {
  inserter: "inserter",
  "fast-inserter": "inserter",
  "long-handed-inserter": "inserter",
  "wooden-chest": "container",
  "steel-chest": "container",
  "steam-engine": "steam-engine",
  "steam-turbine": "steam-engine",
  "stone-furnace": "furnace",
  "electric-furnace": "furnace",
  "transport-belt": "transport-belt",
  "underground-belt": "transport-belt",
  "fast-underground-belt": "transport-belt",
};
const FOOTPRINTS: Record<string, [number, number]> = {
  "steam-engine": [3, 5],
  "steam-turbine": [3, 5],
  "stone-furnace": [2, 2],
  "electric-furnace": [3, 3],
  lab: [3, 3],
};
const visualFor = (name: string) =>
  ({ tileFootprint: FOOTPRINTS[name] ?? [1, 1], rotatesFootprint: name.startsWith("steam-") }) as ResolvedVisual;

let nextId = 1;
function placed(name: string, x: number, y: number, direction = NORTH, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entityNumber: nextId++, name, x, y, direction, quality: "normal", modules: [], filterItems: [], ...extra };
}
const over = (existing: PlacedEntity, name: string, direction = NORTH, x = existing.x, y = existing.y) =>
  canBuildOver(existing, name, x, y, direction, visualFor, GROUPS);

test("anything in the same group and footprint builds over", () => {
  assert.ok(over(placed("inserter", 0.5, 0.5), "fast-inserter"));
  assert.ok(over(placed("inserter", 0.5, 0.5), "long-handed-inserter", EAST));
  assert.ok(over(placed("steel-chest", 0.5, 0.5), "wooden-chest"));
  assert.ok(over(placed("steam-engine", 1.5, 2.5), "steam-turbine"));
  assert.ok(over(placed("transport-belt", 0.5, 0.5), "underground-belt"));
});

test("the same entity always builds over itself, grouped or not", () => {
  assert.ok(over(placed("lab", 1.5, 1.5), "lab"));
  assert.ok(over(placed("inserter", 0.5, 0.5), "inserter", EAST));
});

test("a different group, footprint or spot does not", () => {
  assert.ok(!over(placed("inserter", 0.5, 0.5), "wooden-chest"));
  assert.ok(!over(placed("lab", 1.5, 1.5), "electric-furnace"));
  assert.ok(!over(placed("stone-furnace", 1, 1), "electric-furnace"));
  assert.ok(!over(placed("inserter", 0.5, 0.5), "fast-inserter", NORTH, 1.5, 0.5));
  // A turbine held sideways covers different tiles than the upright engine.
  assert.ok(!over(placed("steam-engine", 1.5, 2.5), "steam-turbine", EAST));
});

test("without group data only a same-name rebuild is allowed", () => {
  const inserter = placed("inserter", 0.5, 0.5);
  assert.ok(!canBuildOver(inserter, "fast-inserter", 0.5, 0.5, NORTH, visualFor, undefined));
  assert.ok(canBuildOver(inserter, "inserter", 0.5, 0.5, NORTH, visualFor, undefined));
});

test("an underground swapped for another tier keeps its end and direction", () => {
  const exit = placed("underground-belt", 4.5, 0.5, EAST, { undergroundType: "output" });
  assert.deepEqual(undergroundForPlacement([exit], "fast-underground-belt", 4.5, 0.5, WEST, 7, exit), {
    undergroundType: "output",
    direction: EAST,
  });
});

test("an underground over a belt, or over nothing, pairs as usual", () => {
  const belt = placed("transport-belt", 4.5, 0.5, EAST);
  const entrance = placed("underground-belt", 0.5, 0.5, EAST, { undergroundType: "input" });
  assert.deepEqual(undergroundForPlacement([entrance, belt], "underground-belt", 4.5, 0.5, WEST, 5, belt), {
    undergroundType: "output",
    direction: EAST,
  });
  assert.deepEqual(undergroundForPlacement([], "underground-belt", 4.5, 0.5, WEST, 5, undefined), {
    undergroundType: "input",
    direction: WEST,
  });
});

console.log(`\n${passed} passed`);
