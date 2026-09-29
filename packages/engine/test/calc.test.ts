import assert from "node:assert/strict";
import {
  decodeBlueprintString,
  encodeBlueprintString,
  normaliseEntities,
} from "../src/blueprint.js";
import { calculate } from "../src/calc/rates.js";
import { vanilla } from "../src/data/vanilla.js";
import type { BpEntity, BlueprintEnvelope } from "../src/types.js";

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

function bp(entities: BpEntity[]): BlueprintEnvelope {
  return { blueprint: { item: "blueprint", label: "test", entities, version: 562949956435968 } };
}

function ratesOf(entities: BpEntity[]) {
  const roundTripped = decodeBlueprintString(encodeBlueprintString(bp(entities)));
  const placed = normaliseEntities(roundTripped.blueprint!);
  return calculate(vanilla, placed);
}

const close = (actual: number, expected: number, msg: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg}: expected ${expected}, got ${actual}`,
  );

test("blueprint strings round-trip", () => {
  const encoded = encodeBlueprintString(
    bp([{ entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 } }]),
  );
  assert.equal(encoded[0], "0");
  const decoded = decodeBlueprintString(encoded);
  assert.equal(decoded.blueprint?.entities?.[0]?.name, "assembling-machine-2");
});

test("two unmodded assemblers on gears", () => {
  const result = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "assembling-machine-2", position: { x: 4, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  assert.equal(result.groups.length, 1, "identical machines collapse into one group");
  assert.equal(result.groups[0]!.count, 2);
  close(result.groups[0]!.craftsPerSecond, 1.5, "crafts/s per machine");

  const gears = result.products.find((f) => f.name === "iron-gear-wheel")!;
  close(gears.produced, 3, "gears produced");
  const plates = result.ingredients.find((f) => f.name === "iron-plate")!;
  close(plates.consumed, 6, "plates consumed");
  close(result.totalPower, 300_000, "power");
});

test("a very fast machine is not capped at one craft per tick", () => {
  // 2.0 finishes several crafts a tick when speed allows; a machine 100×
  // faster than an assembling machine 2 on gears (0.5 s) makes 150/s, not 60.
  const fast = { ...vanilla, machines: { ...vanilla.machines, "assembling-machine-2": { ...vanilla.machines["assembling-machine-2"]!, speed: 75 } } };
  const placed = normaliseEntities({ item: "blueprint", entities: [{ entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" }] });
  close(calculate(fast, placed).groups[0]!.craftsPerSecond, 150, "crafts/s");
});

test("productivity modules slow the machine and boost output", () => {
  const result = ratesOf([
    {
      entity_number: 1,
      name: "assembling-machine-2",
      position: { x: 0, y: 0 },
      recipe: "iron-gear-wheel",
      items: [
        {
          id: { name: "productivity-module", quality: "normal" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }] },
        },
      ],
    },
  ]);
  const group = result.groups[0]!;
  close(group.effects.speed, -0.1, "speed penalty");
  close(group.effects.productivity, 0.08, "productivity bonus");
  close(group.craftsPerSecond, 1.35, "crafts/s");
  const gears = result.products.find((f) => f.name === "iron-gear-wheel")!;
  close(gears.produced, 1.35 * 1.08, "gears produced");
  // Ingredients are not affected by productivity.
  const plates = result.ingredients.find((f) => f.name === "iron-plate")!;
  close(plates.consumed, 2.7, "plates consumed");
  close(group.powerPerMachine, 150_000 * 1.8, "power with prod modules");
});

test("beacons in range apply, out of range do not", () => {
  const beaconModules = [
    {
      id: { name: "speed-module-3", quality: "normal" as const },
      items: { in_inventory: [{ inventory: 1, stack: 0 }, { inventory: 1, stack: 1 }] },
    },
  ];
  const inRange = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "beacon", position: { x: 4, y: 0 }, items: beaconModules },
  ]);
  // 2 × speed-3 = +1.0, × distribution 1.5, × profile[1 beacon] = 1 → +150%
  close(inRange.groups[0]!.effects.speed, 1.5, "beacon speed bonus");
  close(inRange.groups[0]!.craftsPerSecond, 0.75 * 2.5 / 0.5, "boosted crafts/s");

  const outOfRange = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "beacon", position: { x: 40, y: 0 }, items: beaconModules },
  ]);
  close(outOfRange.groups[0]!.effects.speed, 0, "distant beacon has no effect");
});

test("two beacons share the diminishing profile", () => {
  const beaconModules = [
    {
      id: { name: "speed-module-3", quality: "normal" as const },
      items: { in_inventory: [{ inventory: 1, stack: 0 }, { inventory: 1, stack: 1 }] },
    },
  ];
  const result = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "beacon", position: { x: 4, y: 0 }, items: beaconModules },
    { entity_number: 3, name: "beacon", position: { x: -4, y: 0 }, items: beaconModules },
  ]);
  // 2 beacons × 1.0 effect each × 1.5 × profile[2]=0.7071
  close(result.groups[0]!.effects.speed, 2 * 1.0 * 1.5 * 0.7071, "two-beacon speed bonus");
});

test("shared items become intermediates with a net rate", () => {
  const result = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "assembling-machine-2", position: { x: 4, y: 0 }, recipe: "transport-belt" },
  ]);
  const gears = result.intermediates.find((f) => f.name === "iron-gear-wheel")!;
  assert.equal(gears.category, "intermediate");
  close(gears.produced, 1.5, "gears produced");
  close(gears.consumed, 1.5, "gears consumed by belt assembler");
  close(gears.net, 0, "balanced net rate");
  close(gears.netMachines!, 0, "no spare machines");
});

test("net machine count reports the shortfall", () => {
  const result = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "assembling-machine-2", position: { x: 4, y: 0 }, recipe: "transport-belt" },
    { entity_number: 3, name: "assembling-machine-2", position: { x: 8, y: 0 }, recipe: "transport-belt" },
  ]);
  const gears = result.intermediates.find((f) => f.name === "iron-gear-wheel")!;
  close(gears.net, -1.5, "gear deficit");
  close(gears.netMachines!, -1, "one more gear assembler needed");
});

test("quality raises machine speed and module effects", () => {
  const result = ratesOf([
    {
      entity_number: 1,
      name: "assembling-machine-2",
      position: { x: 0, y: 0 },
      recipe: "iron-gear-wheel",
      quality: "rare",
      items: [
        {
          id: { name: "speed-module", quality: "rare" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }] },
        },
      ],
    },
  ]);
  const group = result.groups[0]!;
  close(group.effects.speed, 0.2 * 1.6, "quality-scaled speed bonus");
  close(group.effects.consumption, 0.5, "drawback is not quality-scaled");
  close(group.craftsPerSecond, (0.75 * 1.6 * (1 + 0.32)) / 0.5, "crafts/s");
});

test("unrecognised and recipe-less entities produce warnings, not crashes", () => {
  const result = ratesOf([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 } },
    { entity_number: 2, name: "electric-mining-drill", position: { x: 4, y: 0 } },
    { entity_number: 3, name: "rocket-silo", position: { x: 8, y: 0 } },
    { entity_number: 4, name: "transport-belt", position: { x: 12, y: 0 } },
  ]);
  const kinds = result.warnings.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ["needs-input", "no-recipe", "unknown-entity"]);
  assert.equal(result.groups.length, 0);
});

test("1.1-style module maps still parse", () => {
  const result = ratesOf([
    {
      entity_number: 1,
      name: "assembling-machine-3",
      position: { x: 0, y: 0 },
      recipe: "iron-gear-wheel",
      items: { "speed-module-3": 4 } as unknown as BpEntity["items"],
    },
  ]);
  close(result.groups[0]!.effects.speed, 2.0, "4 × speed-3");
});

console.log(`\n${passed} passing`);
