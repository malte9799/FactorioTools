import assert from "node:assert/strict";
import {
  decodeBlueprintString,
  encodeBlueprintString,
  normaliseEntities,
} from "../src/blueprint.js";
import { calculate } from "../src/calc/rates.js";
import { attachBottlenecks, type ThroughputContext } from "../src/calc/throughput.js";
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

/**
 * Inserter geometry note (verified against the real prototype's
 * insert_position/pickup_position before writing these tests): at
 * direction 0, an inserter's PICKUP tile is one tile north (-Y) of its own
 * position and its DROP tile is one tile south (+Y). So an inserter placed
 * just north of a machine at direction 0 has its drop land ON the machine
 * (an input inserter); one placed just south of a machine at direction 0
 * has its pickup land ON the machine (an output inserter) — the same
 * direction value works on either side, only the inserter's own position
 * relative to the machine determines input-vs-output.
 *
 * stone-furnace is 2x2 (half-extent 1, spans [-1,1]); assembling-machine-2/3
 * are 3x3 (half-extent 1.5, spans [-1.5,1.5]). Inserters are placed one
 * clear tile beyond the machine edge to stay unambiguous.
 */

test("furnace with adequate inserters on both sides is not bottlenecked", () => {
  const { result, ctx } = setup([
    { entity_number: 1, name: "stone-furnace", position: { x: 0, y: 0 }, recipe: "iron-plate" },
    { entity_number: 2, name: "inserter", position: { x: 0, y: -2 }, direction: 0 }, // input (north)
    { entity_number: 3, name: "inserter", position: { x: 0, y: 2 }, direction: 0 }, // output (south)
  ]);
  const subgroups = attachBottlenecks(ctx, result.groups);
  const group = result.groups.find((g) => g.machineName === "stone-furnace")!;
  const sub = subgroups.get(group.key)![0]!;
  // Furnace needs 1/3.2 = 0.3125 ore in, produces 0.3125 plate out; a
  // regular inserter (0.86/s) comfortably covers both sides.
  close(sub.bottleneck.actualCraftsPerSecond, group.craftsPerSecond, "adequate inserters: actual == theoretical");
  assert.equal(sub.bottleneck.limitedBy, "machine");
});

test("a beacon-boosted assembler is output-bottlenecked by a single burner inserter", () => {
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
    { entity_number: 2, name: "inserter", position: { x: 0, y: -2.5 }, direction: 0 }, // input (north)
    { entity_number: 3, name: "burner-inserter", position: { x: 0, y: 2.5 }, direction: 0 }, // output (south)
  ]);
  const group = result.groups[0]!;
  // Speed 1.25 base * (1 + 4*0.5) = 3.75; crafts/s = 3.75/0.5 = 7.5.
  close(group.craftsPerSecond, 7.5, "boosted craft rate sanity check");
  const subgroups = attachBottlenecks(ctx, result.groups);
  const sub = subgroups.get(group.key)![0]!;
  // iron-gear-wheel needs 2 iron-plate/craft: a regular inserter's input
  // (0.86/s) caps this at 0.86/2 = 0.43 crafts/s, TIGHTER than the output
  // side's single burner inserter (0.79/s, 1 gear/craft) — so the input
  // side is actually the binding constraint here, not the output, despite
  // the weaker inserter being on the output side. This is exactly the kind
  // of non-obvious result the bottleneck engine exists to surface: naively
  // assuming "the weakest inserter tier wins" would get this wrong.
  close(sub.bottleneck.actualCraftsPerSecond, 0.43, "input-inserter-limited rate (2 iron-plate/craft)");
  assert.equal(sub.bottleneck.limitedBy, "ingredient");
  assert.equal(sub.bottleneck.limitingItem, "iron-plate");
});

test("swapping the output inserter to a stack inserter raises the bottlenecked rate", () => {
  const build = (outputInserter: string) =>
    setup([
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
      { entity_number: 2, name: "stack-inserter", position: { x: 0, y: -2.5 }, direction: 0 },
      { entity_number: 3, name: outputInserter, position: { x: 0, y: 2.5 }, direction: 0 },
    ]);

  const weak = build("burner-inserter");
  const strong = build("stack-inserter");
  const weakGroup = weak.result.groups[0]!;
  const strongGroup = strong.result.groups[0]!;
  const weakSub = attachBottlenecks(weak.ctx, weak.result.groups).get(weakGroup.key)![0]!;
  const strongSub = attachBottlenecks(strong.ctx, strong.result.groups).get(strongGroup.key)![0]!;

  assert.ok(
    strongSub.bottleneck.actualCraftsPerSecond > weakSub.bottleneck.actualCraftsPerSecond,
    "stack inserter output should raise the achievable rate over a burner inserter",
  );
  close(strongSub.bottleneck.actualCraftsPerSecond, 7.5, "stack inserter (15/s) no longer the constraint, machine speed is");
  assert.equal(strongSub.bottleneck.limitedBy, "machine");
});

test("multi-ingredient recipe: bottleneck attributes to the specific starved ingredient", () => {
  // electronic-circuit needs iron-plate (1) and copper-cable (3) per craft.
  // A shared input-inserter pool of burner (0.79) + regular (0.86) = 1.65
  // items/s splits by per-craft amount: iron-plate limit 1.65 crafts/s,
  // copper-cable limit 1.65/3 = 0.55 crafts/s — copper-cable is the
  // tighter constraint and must be the one named, not iron-plate.
  const { result, ctx } = setup([
    {
      entity_number: 1,
      name: "assembling-machine-2",
      position: { x: 0, y: 0 },
      recipe: "electronic-circuit",
      items: [
        {
          id: { name: "speed-module-3", quality: "normal" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }] },
        },
      ],
    },
    // Two separate input sides (north and west) both feeding the shared
    // input-capacity pool — this engine's documented simplification, since
    // a blueprint carries no per-inserter item filter to say which
    // ingredient each one actually carries.
    { entity_number: 2, name: "burner-inserter", position: { x: 0, y: -2.5 }, direction: 0 }, // north, input
    { entity_number: 3, name: "inserter", position: { x: -2.5, y: 0 }, direction: 12 }, // west, input (16-way scheme)
    { entity_number: 4, name: "inserter", position: { x: 0, y: 2.5 }, direction: 0 }, // south, output
  ]);
  const group = result.groups[0]!;
  const subgroups = attachBottlenecks(ctx, result.groups);
  const sub = subgroups.get(group.key)![0]!;
  assert.equal(sub.bottleneck.limitedBy, "ingredient");
  assert.equal(sub.bottleneck.limitingItem, "copper-cable");
  close(sub.bottleneck.actualCraftsPerSecond, (0.79 + 0.86) / 3, "copper-cable-limited crafts/s");
});

test("no adjacent inserters at all leaves the machine unconstrained (unknown, not zero)", () => {
  const { result, ctx } = setup([
    { entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 }, recipe: "iron-gear-wheel" },
  ]);
  const group = result.groups[0]!;
  const subgroups = attachBottlenecks(ctx, result.groups);
  const sub = subgroups.get(group.key)![0]!;
  close(sub.bottleneck.actualCraftsPerSecond, group.craftsPerSecond, "no inserters found -> theoretical stands");
  assert.equal(sub.bottleneck.limitedBy, "machine");
});

test("identical machines fed by different inserter tiers split into subgroups", () => {
  const { result, ctx } = setup([
    { entity_number: 1, name: "stone-furnace", position: { x: 0, y: 0 }, recipe: "iron-plate" },
    { entity_number: 2, name: "inserter", position: { x: 0, y: -2 }, direction: 0 },
    { entity_number: 3, name: "stack-inserter", position: { x: 0, y: 2 }, direction: 0 },

    { entity_number: 4, name: "stone-furnace", position: { x: 6, y: 0 }, recipe: "iron-plate" },
    { entity_number: 5, name: "burner-inserter", position: { x: 6, y: -2 }, direction: 0 },
    { entity_number: 6, name: "burner-inserter", position: { x: 6, y: 2 }, direction: 0 },
  ]);
  // Same machine/recipe/quality/modules/beacons -> one theoretical group...
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.count, 2);
  // ...but two bottleneck subgroups, since their adjacency differs.
  const subgroups = attachBottlenecks(ctx, result.groups)!.get(result.groups[0]!.key)!;
  assert.equal(subgroups.length, 2);
});

console.log(`\n${passed} passing`);
