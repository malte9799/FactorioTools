/** Art a machine's fluid boxes switch on or place.
 *
 *  A thruster's four pipe elbows each belong to one fuel/oxidizer port and
 *  only show while that port is plugged in. A foundry's input and output
 *  pipework shows while its recipe uses a fluid on that side. And a fluid
 *  box's own `pipe_picture` — the stub between a machine's body and the
 *  socket on its edge — draws at every port the recipe has live.
 *
 *  Run with: npx tsx test/fluidArt.test.ts
 */
import assert from "node:assert/strict";
import type { PlacedEntity } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections, effectiveFootprint } from "../src/entityLookup.js";
import { buildGrid } from "../src/neighbours/grid.js";
import { buildFluidNetwork } from "../src/neighbours/fluid.js";
import { buildHeatNetwork } from "../src/neighbours/heat.js";
import { collectEntity } from "../src/draw/collect.js";
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

const { gameData, catalog } = requireDataset("fluidArt");
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

let nextNumber = 1;
function entity(name: string, x: number, y: number, direction = 0, recipe?: string): PlacedEntity {
  return { entityNumber: nextNumber++, name, x, y, direction, quality: "normal", modules: [], filterItems: [], recipe } as unknown as PlacedEntity;
}

/** `self`'s own commands, in paint order. */
function collect(self: PlacedEntity, others: PlacedEntity[] = []): DrawCommand[] {
  const all = [self, ...others];
  const ctx = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, e.recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    platformBoxes: [],
    animationFrame: 0,
  };
  const out: DrawCommand[] = [];
  collectEntity(out, self, lookup.get(self.name)!, ctx, 1);
  return out.sort(compareDrawCommands);
}

const sheets = (commands: DrawCommand[]) => commands.map((c) => c.sheet.split("/").pop()!);
const matching = (commands: DrawCommand[], pattern: RegExp) => sheets(commands).filter((s) => pattern.test(s)).sort();

/* ---------- thruster: an elbow per plugged-in port ---------- */

const elbows = (commands: DrawCommand[]) => matching(commands, /^thruster-pipe-connection-/);

// A thruster stands on 4x5 tiles, so its centre sits on a whole x and a half
// y. Centred at (4, 4.5) its ports open onto x = 1.5 (west) and 6.5 (east),
// at y = 2.5 and 4.5.
const thruster = () => entity("thruster", 4, 4.5);

test("a thruster's footprint is the 4x5 it stands on, not its selection box", () => {
  assert.deepEqual(effectiveFootprint(lookup.get("thruster")!, 0), [4, 5]);
});

test("a bare thruster shows no pipe elbows and no covers", () => {
  const commands = collect(thruster());
  assert.deepEqual(elbows(commands), []);
  assert.deepEqual(matching(commands, /^pipe-cover-/), []);
});

test("a pipe on a thruster port joins it, and grows that port's elbow alone", () => {
  const cases: [number, number, string, string][] = [
    [6.5, 2.5, "thruster-pipe-connection-1.png", "pipe-ending-left.png"],
    [6.5, 4.5, "thruster-pipe-connection-2.png", "pipe-ending-left.png"],
    [1.5, 4.5, "thruster-pipe-connection-3.png", "pipe-ending-right.png"],
    [1.5, 2.5, "thruster-pipe-connection-4.png", "pipe-ending-right.png"],
  ];
  for (const [x, y, elbow, pipeSheet] of cases) {
    const t = thruster();
    const pipe = entity("pipe", x, y);
    assert.deepEqual(elbows(collect(t, [pipe])), [elbow], `pipe at ${x},${y}`);
    assert.deepEqual(sheets(collect(pipe, [t])), [pipeSheet], `pipe at ${x},${y}`);
  }
});

test("a pipe beside a thruster but off its ports changes nothing", () => {
  const t = thruster();
  const pipe = entity("pipe", 6.5, 3.5);
  assert.deepEqual(elbows(collect(t, [pipe])), []);
  assert.deepEqual(sheets(collect(pipe, [t])), sheets(collect(pipe)));
});

test("a thruster can't be turned: a stray direction leaves its ports where its art has them", () => {
  const turned = entity("thruster", 4, 4.5, 4);
  const pipe = entity("pipe", 6.5, 2.5);
  assert.deepEqual(elbows(collect(turned, [pipe])), ["thruster-pipe-connection-1.png"]);
  assert.deepEqual(sheets(collect(pipe, [turned])), ["pipe-ending-left.png"]);
});

test("thrusters flush side by side meet fuel to oxidizer, so neither grows an elbow", () => {
  const left = thruster();
  const right = entity("thruster", 8, 4.5);
  assert.deepEqual(elbows(collect(left, [right])), []);
  assert.deepEqual(elbows(collect(right, [left])), []);
});

/* ---------- foundry: pipework follows the recipe ---------- */

const pipework = (commands: DrawCommand[]) => matching(commands, /^foundry-pipe-connections-/);
const covers = (commands: DrawCommand[]) => matching(commands, /^pipe-cover-(north|east|south|west)\.png$/);

test("a foundry with no recipe, or one without fluids, shows no pipework and no covers", () => {
  // A recipe a foundry can run whose ingredients and products are all solid.
  const solid = Object.values(gameData.recipes).find(
    (r) => gameData.machines.foundry!.categories.includes(r.category) && [...r.ingredients, ...r.results].every((i) => gameData.items[i.name]?.kind !== "fluid"),
  );
  assert.ok(solid, "expected a fluid-free foundry recipe in the dataset");
  for (const recipe of [undefined, solid.name]) {
    const commands = collect(entity("foundry", 2.5, 2.5, 0, recipe));
    assert.deepEqual(pipework(commands), [], String(recipe));
    assert.deepEqual(covers(commands), [], String(recipe));
  }
});

test("a fluid ingredient shows the foundry's input pipework, a fluid product its output", () => {
  // Facing north the inputs are along the south edge, the outputs the north.
  const casting = collect(entity("foundry", 2.5, 2.5, 0, "casting-iron"));
  assert.deepEqual(pipework(casting), ["foundry-pipe-connections-south.png"]);
  assert.deepEqual(covers(casting), ["pipe-cover-south.png"]);

  const smelting = collect(entity("foundry", 2.5, 2.5, 0, "molten-iron"));
  assert.deepEqual(pipework(smelting), ["foundry-pipe-connections-north.png"]);
  assert.deepEqual(covers(smelting), ["pipe-cover-north.png"]);

  const both = collect(entity("foundry", 2.5, 2.5, 0, "molten-iron-from-lava"));
  assert.deepEqual(pipework(both), ["foundry-pipe-connections-north.png", "foundry-pipe-connections-south.png"]);
});

test("the foundry's pipework turns with it", () => {
  // Facing east the inputs are along the west edge.
  assert.deepEqual(pipework(collect(entity("foundry", 2.5, 2.5, 4, "casting-iron"))), ["foundry-pipe-connections-west.png"]);
});

test("a pipe on a foundry port takes its cover, not its pipework", () => {
  // Input port at local (-1, 2) facing south: the pipe sits one tile out.
  const foundry = entity("foundry", 2.5, 2.5, 0, "casting-iron");
  const commands = collect(foundry, [entity("pipe", 1.5, 5.5)]);
  assert.deepEqual(pipework(commands), ["foundry-pipe-connections-south.png"]);
  assert.deepEqual(covers(commands), []);
});

/* ---------- pipe_picture: the stub between body and socket ---------- */

const stubs = (commands: DrawCommand[]) => matching(commands, /^electromagnetic-plant-pipe-(north|east|south|west)\.png$/);

test("an electromagnetic plant with no fluid recipe shows no stubs", () => {
  assert.deepEqual(stubs(collect(entity("electromagnetic-plant", 4, 4))), []);
});

test("each port its recipe uses gets a stub, facing the way the port does", () => {
  // supercapacitor: one fluid ingredient, the west port.
  assert.deepEqual(stubs(collect(entity("electromagnetic-plant", 4, 4, 0, "supercapacitor"))), ["electromagnetic-plant-pipe-west.png"]);
  // electrolyte: two fluid ingredients (west, east) and a fluid product (south).
  assert.deepEqual(stubs(collect(entity("electromagnetic-plant", 4, 4, 0, "electrolyte"))), [
    "electromagnetic-plant-pipe-east.png",
    "electromagnetic-plant-pipe-south.png",
    "electromagnetic-plant-pipe-west.png",
  ]);
  // Turned to face east, the west port now opens north.
  assert.deepEqual(stubs(collect(entity("electromagnetic-plant", 4, 4, 4, "supercapacitor"))), ["electromagnetic-plant-pipe-north.png"]);
});

test("a stub reaches from the body to the cover capping it, and stays when a pipe replaces the cover", () => {
  // West port at local (-1.5, 0.5): the socket opens onto tile x 1..2, y 4..5.
  const plant = entity("electromagnetic-plant", 4, 4, 0, "supercapacitor");
  const alone = collect(plant);
  const stub = alone.find((c) => c.sheet.endsWith("electromagnetic-plant-pipe-west.png"))!;
  assert.ok(stub.dx < 2 && stub.dx + stub.dw > 2, "the stub must straddle the plant's west edge");
  assert.ok(stub.dy >= 4 && stub.dy + stub.dh <= 5.1, "the stub must sit in the port's own row");
  assert.deepEqual(covers(alone), ["pipe-cover-west.png"]);

  const piped = collect(plant, [entity("pipe", 1.5, 4.5)]);
  assert.deepEqual(stubs(piped), ["electromagnetic-plant-pipe-west.png"]);
  assert.deepEqual(covers(piped), []);
});

test("a stub paints over the body it plugs into, except a north one, which tucks in behind", () => {
  const order = (commands: DrawCommand[], stub: string, body: string) => {
    const names = sheets(commands);
    assert.ok(names.includes(stub) && names.includes(body), `${stub} and ${body} must both draw`);
    return names.indexOf(stub) - names.lastIndexOf(body);
  };
  // assembling-machine-2's fluid input is its north port; turning the
  // machine carries the port round with it.
  const facing = (direction: number) => collect(entity("assembling-machine-2", 2.5, 2.5, direction, "electric-engine-unit"));
  assert.ok(order(facing(0), "assembling-machine-2-pipe-N.png", "assembling-machine-2.png") < 0, "north stub under the body");
  assert.ok(order(facing(4), "assembling-machine-2-pipe-E.png", "assembling-machine-2.png") > 0, "east stub over the body");
  assert.ok(order(facing(8), "assembling-machine-2-pipe-S.png", "assembling-machine-2.png") > 0, "south stub over the body");
  assert.ok(order(facing(12), "assembling-machine-2-pipe-W.png", "assembling-machine-2.png") > 0, "west stub over the body");

  // The electromagnetic plant's base plate sits a tier below the rest of
  // it; its north stub has to end up under that too.
  const plant = collect(entity("electromagnetic-plant", 4, 4, 4, "supercapacitor"));
  assert.ok(order(plant, "electromagnetic-plant-pipe-north.png", "electromagnetic-plant-base.png") < 0);
});

console.log(`\n${passed} passed`);
