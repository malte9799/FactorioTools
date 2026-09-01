import assert from "node:assert/strict";
import {
  decodeBlueprintString,
  encodeBlueprintString,
  normaliseEntities,
} from "../src/blueprint.js";
import { calculate } from "../src/calc/rates.js";
import { attachBottlenecks, type ThroughputContext } from "../src/calc/throughput.js";
import { computeScaleFactor, findScaleWarnings } from "../src/calc/scale.js";
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

function setup(entities: BpEntity[]) {
  const roundTripped = decodeBlueprintString(encodeBlueprintString(bp(entities)));
  const placed = normaliseEntities(roundTripped.blueprint!);
  const result = calculate(vanilla, placed);
  const ctx: ThroughputContext = {
    data: vanilla,
    entities: placed,
    footprintOf: (name) => vanilla.machines[name]?.size ?? vanilla.beacons[name]?.size ?? [1, 1],
  };
  return { result, ctx };
}

const close = (actual: number, expected: number, msg: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${msg}: expected ${expected}, got ${actual}`,
  );

test("no target set: scale factor is 1, nothing changes", () => {
  const { result } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  const scale = computeScaleFactor(result, null);
  assert.equal(scale.factor, 1);
  assert.equal(scale.unreachable, false);
});

test("target below theoretical max scales down", () => {
  const { result } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
    { entity_number: 2, name: "assembling-machine-2", position: { x: 4, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  // Theoretical: 2 machines * 1.5 crafts/s * 1 gear/craft = 3 gear/s.
  const gears = result.products.find((f) => f.name === "iron-gear-wheel")!;
  close(gears.produced, 3, "sanity: theoretical production");

  const scale = computeScaleFactor(result, { itemName: "iron-gear-wheel", ratePerSecond: 1.5 });
  close(scale.factor, 0.5, "half the theoretical max -> factor 0.5");
  close(scale.theoreticalMaxPerSecond, 3, "theoretical max used as the anchor");
});

test("target above theoretical max scales up", () => {
  const { result } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  const scale = computeScaleFactor(result, { itemName: "iron-gear-wheel", ratePerSecond: 3 });
  // Theoretical for 1 machine: 1.5 gear/s. Target 3/s -> factor 2.
  close(scale.factor, 2, "double the theoretical max -> factor 2");
});

test("targeting an item nothing produces is unreachable, not silently factor 1 with no signal", () => {
  const { result } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  const scale = computeScaleFactor(result, { itemName: "processing-unit", ratePerSecond: 10 });
  assert.equal(scale.unreachable, true);
  assert.equal(scale.factor, 1);
});

test("scaling anchors to theoretical, not bottlenecked, rate (confirmed design decision)", () => {
  // A furnace whose actual (bottlenecked) rate is far below theoretical —
  // computeScaleFactor must still size against the THEORETICAL number, per
  // the user's confirmed choice: "how many adequately-fed machines," not
  // "how many of today's underfed machines."
  const { result, ctx } = setup([
    {
      entity_number: 1,
      name: "assembling-machine-3",
      position: { x: 0, y: 0 },
      recipe: "iron-gear-wheel",
      items: [
        {
          id: { name: "speed-module-3", quality: "normal" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }, { inventory: 4, stack: 2 }, { inventory: 4, stack: 3 }] },
        },
      ],
    },
    { entity_number: 2, name: "inserter", position: { x: 0, y: -2.5 }, direction: 0 },
    { entity_number: 3, name: "burner-inserter", position: { x: 0, y: 2.5 }, direction: 0 }, // weak output inserter
  ]);
  const group = result.groups[0]!;
  close(group.craftsPerSecond, 7.5, "sanity: theoretical craft rate");
  const gears = result.products.find((f) => f.name === "iron-gear-wheel")!;
  close(gears.produced, 7.5, "theoretical production, unaffected by bottleneck");

  const bottlenecks = attachBottlenecks(ctx, result.groups);
  const actualRate = bottlenecks.get(group.key)![0]!.bottleneck.actualCraftsPerSecond;
  assert.ok(actualRate < group.craftsPerSecond, "sanity: this machine really is bottlenecked");

  // Target exactly the theoretical max -> factor should be 1 (not scaled
  // relative to the much-lower actual rate).
  const scale = computeScaleFactor(result, { itemName: "iron-gear-wheel", ratePerSecond: 7.5 });
  close(scale.factor, 1, "target == theoretical max -> factor 1, ignoring the bottleneck entirely");
});

test("scale warning fires when the current bottlenecked build can't hit its scaled-up share", () => {
  const { result, ctx } = setup([
    {
      entity_number: 1,
      name: "assembling-machine-3",
      position: { x: 0, y: 0 },
      recipe: "iron-gear-wheel",
      items: [
        {
          id: { name: "speed-module-3", quality: "normal" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }, { inventory: 4, stack: 2 }, { inventory: 4, stack: 3 }] },
        },
      ],
    },
    { entity_number: 2, name: "inserter", position: { x: 0, y: -2.5 }, direction: 0 },
    { entity_number: 3, name: "burner-inserter", position: { x: 0, y: 2.5 }, direction: 0 },
  ]);
  const bottlenecks = attachBottlenecks(ctx, result.groups);
  // findScaleWarnings short-circuits on factor===1 (nothing to scale, so
  // nothing to warn about) — target double the theoretical max instead to
  // exercise a real "scale up" scenario.
  const scaleUp = computeScaleFactor(result, { itemName: "iron-gear-wheel", ratePerSecond: 15 });
  close(scaleUp.factor, 2, "sanity: target double theoretical -> factor 2");
  const warnings = findScaleWarnings(result, scaleUp, bottlenecks);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.machinesNeeded, 2);
  assert.ok(
    warnings[0]!.actualDeliveredPerSecond < warnings[0]!.targetSharePerSecond,
    "the warning's own numbers should show the shortfall",
  );
});

test("no scale warning when the build isn't bottlenecked at all", () => {
  const { result, ctx } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  const bottlenecks = attachBottlenecks(ctx, result.groups);
  const scale = computeScaleFactor(result, { itemName: "iron-gear-wheel", ratePerSecond: 3 });
  const warnings = findScaleWarnings(result, scale, bottlenecks);
  assert.equal(warnings.length, 0, "no inserters placed at all -> 'machine'-limited -> never warns");
});

console.log(`\n${passed} passing`);
