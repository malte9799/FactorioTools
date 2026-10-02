import assert from "node:assert/strict";
import { Layer } from "@factoriotools/engine";
import { planBake, MAX_BAKED_RUNS, type BakePlan } from "../src/draw/bake.js";
import { compareDrawCommands, type DrawCommand } from "../src/draw/commands.js";

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

let nextOrder = 0;
function cmd(layer: Layer, x: number, y: number, w = 1, h = 1): DrawCommand {
  return { sheet: "s", sx: 0, sy: 0, sw: 1, sh: 1, dx: x, dy: y, dw: w, dh: h, layer, y: y + h, order: nextOrder++, alpha: 1 };
}

function overlaps(a: DrawCommand, b: DrawCommand): boolean {
  return a.dx < b.dx + b.dw && b.dx < a.dx + a.dw && a.dy < b.dy + b.dh && b.dy < a.dy + a.dh;
}

/** The order the plan actually paints in, flattened. */
function paintOrder(plan: BakePlan): DrawCommand[] {
  return plan.runs.flatMap((r) => r.commands);
}

/** Every overlapping pair paints in the same relative order as the plain
 *  sorted list, and every animated command lands in a live run. */
function assertFaithful(commands: DrawCommand[], animated: number[], plan: BakePlan) {
  const position = new Map<DrawCommand, number>();
  paintOrder(plan).forEach((c, i) => position.set(c, i));
  assert.equal(position.size, commands.length, "every command painted exactly once");
  for (let i = 0; i < commands.length; i++) {
    for (let j = i + 1; j < commands.length; j++) {
      const a = commands[i]!;
      const b = commands[j]!;
      if (overlaps(a, b)) assert.ok(position.get(a)! < position.get(b)!, `overlapping pair ${i},${j} swapped`);
    }
  }
  const live = new Set(plan.runs.filter((r) => r.live).flatMap((r) => r.commands));
  for (const i of animated) assert.ok(live.has(commands[i]!), `animated ${i} is not live`);
  assert.ok(plan.bakedCount <= MAX_BAKED_RUNS);
}

test("belts under buildings: one bake below, the belts live, overhangs baked above", () => {
  const commands = [
    cmd(Layer.Shadow, 0, 0, 4, 3), // machine shadow
    cmd(Layer.LowerObject, 3, 3), // belt in front of the machine
    cmd(Layer.LowerObject, 10, 10), // belt far away
    cmd(Layer.Object, 0, 0, 3.5, 3.5), // machine body, overhangs the belt tile
    cmd(Layer.Object, 20, 20, 3, 3), // machine nowhere near a belt
  ].sort(compareDrawCommands);
  const animated = commands.flatMap((c, i) => (c.layer === Layer.LowerObject ? [i] : []));
  const plan = planBake(commands, animated);
  assertFaithful(commands, animated, plan);
  assert.deepEqual(plan.runs.map((r) => [r.live, r.commands.length]), [[false, 2], [true, 2], [false, 1]]);
});

test("nothing animated bakes everything into one layer", () => {
  const commands = [cmd(Layer.Shadow, 0, 0, 2, 2), cmd(Layer.Object, 0, 0, 2, 2)].sort(compareDrawCommands);
  const plan = planBake(commands, []);
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.bakedCount, 1);
});

test("a shadow that would bake above a live sprite is drawn live instead", () => {
  const commands = [cmd(Layer.Shadow, 0, 0), cmd(Layer.Shadow, 0, 0)].sort(compareDrawCommands);
  const plan = planBake(commands, [0]);
  assertFaithful(commands, [0], plan);
  assert.ok(plan.runs.every((r) => r.live));
});

test("random scenes keep every overlapping pair in order", () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    const commands: DrawCommand[] = [];
    for (let k = 0; k < 60; k++) {
      const layer = Math.floor(rand() * 5) as Layer;
      commands.push(cmd(layer, rand() * 12, rand() * 12, 0.5 + rand() * 3, 0.5 + rand() * 3));
    }
    commands.sort(compareDrawCommands);
    const animated = commands.flatMap((_, i) => (rand() < 0.2 ? [i] : []));
    assertFaithful(commands, animated, planBake(commands, animated));
  }
});

console.log(`\n${passed} passed`);
