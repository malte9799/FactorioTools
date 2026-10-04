/** fusion-reactor / fusion-generator port art.
 *
 *  Both buildings carry two kinds of port: ordinary fluid (coolant /
 *  fluoroketone, the round pipe cover) and plasma (the angular cap), and a
 *  reactor swaps which sides are which when rotated. Each reactor port is one
 *  5-column sheet whose column is the port's state — see
 *  data-pipeline's fusionReactorConnectionLayers.
 *
 *  Run with: npx tsx test/fusionPorts.test.ts
 */
import assert from "node:assert/strict";
import type { PlacedEntity } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../src/entityLookup.js";
import { buildGrid } from "../src/neighbours/grid.js";
import { buildFluidNetwork } from "../src/neighbours/fluid.js";
import { buildHeatNetwork } from "../src/neighbours/heat.js";
import { collectEntity } from "../src/draw/collect.js";
import type { DrawCommand } from "../src/draw/commands.js";

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

const { gameData, catalog } = requireDataset("fusionPorts");
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

let nextNumber = 1;
function entity(name: string, x: number, y: number, direction = 0): PlacedEntity {
  return { entityNumber: nextNumber++, name, x, y, direction, quality: "normal", modules: [], filterItems: [] } as unknown as PlacedEntity;
}

function collect(self: PlacedEntity, others: PlacedEntity[] = []): DrawCommand[] {
  const all = [self, ...others];
  const ctx = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, undefined, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    platformBoxes: [],
    animationFrame: 0,
  };
  const out: DrawCommand[] = [];
  collectEntity(out, self, lookup.get(self.name)!, ctx, 1);
  return out;
}

/** Column of each reactor connection piece (1..8, clockwise from the
 *  north-west port), shadow sheets excluded. */
function pieceColumns(commands: DrawCommand[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of commands) {
    const m = /fusion-reactor-connection-(\d)\.png$/.exec(c.sheet);
    if (m) out[Number(m[1])] = c.sx / c.sw;
  }
  return out;
}

const sheets = (commands: DrawCommand[]) => commands.map((c) => c.sheet.split("/").pop()!);

// Pieces 1,2 sit on the north edge, 3,4 east, 5,6 south, 7,8 west.
test("a lone north-facing reactor caps plasma (N/S) angular and coolant (E/W) round", () => {
  assert.deepEqual(pieceColumns(collect(entity("fusion-reactor", 3, 3, 0))), { 1: 1, 2: 1, 3: 0, 4: 0, 5: 1, 6: 1, 7: 0, 8: 0 });
});

test("an east-facing reactor swaps them: plasma E/W, coolant N/S", () => {
  assert.deepEqual(pieceColumns(collect(entity("fusion-reactor", 3, 3, 4))), { 1: 0, 2: 0, 3: 1, 4: 1, 5: 0, 6: 0, 7: 1, 8: 1 });
});

test("a pipe opens the coolant port it touches and no other", () => {
  // West edge, upper port: tile (0.5, 1.5), so the pipe sits at (-0.5, 1.5).
  const cols = pieceColumns(collect(entity("fusion-reactor", 3, 3, 0), [entity("pipe", -0.5, 1.5)]));
  assert.deepEqual(cols, { 1: 1, 2: 1, 3: 0, 4: 0, 5: 1, 6: 1, 7: 0, 8: 2 });
});

test("a pipe against a plasma port neither connects nor uncaps it", () => {
  // North edge, left port: tile (1.5, 0.5), pipe at (1.5, -0.5).
  const reactor = entity("fusion-reactor", 3, 3, 0);
  const pipe = entity("pipe", 1.5, -0.5);
  assert.equal(pieceColumns(collect(reactor, [pipe]))[1], 1);
  assert.deepEqual(sheets(collect(pipe, [reactor])), sheets(collect(pipe)), "the pipe must draw as if nothing were there");
  // ...while the same pipe at a coolant port does join it.
  const joined = entity("pipe", -0.5, 1.5);
  assert.notDeepEqual(sheets(collect(joined, [reactor])), sheets(collect(joined)));
});

test("two reactors side by side bridge their touching ports", () => {
  const cols = pieceColumns(collect(entity("fusion-reactor", 3, 3, 0), [entity("fusion-reactor", 9, 3, 0)]));
  assert.deepEqual(cols, { 1: 1, 2: 1, 3: 4, 4: 4, 5: 1, 6: 1, 7: 0, 8: 0 });
});

test("a generator opens the reactor plasma port feeding it, and grows that one intake", () => {
  // Generator north of the reactor, facing north: its intakes are at its
  // south end, local (-1, 2) and (1, 2). Centred at x=2.5 the left one
  // lands on (1.5, -0.5), straight above the reactor's north-west port.
  const reactor = entity("fusion-reactor", 3, 3, 0);
  const generator = entity("fusion-generator", 2.5, -2.5, 0);
  assert.equal(pieceColumns(collect(reactor, [generator]))[1], 3);
  assert.equal(pieceColumns(collect(reactor, [generator]))[2], 1);
  const drawn = sheets(collect(generator, [reactor]));
  assert.ok(drawn.includes("fusion-generator-north-input-1.png"));
  assert.ok(!drawn.includes("fusion-generator-north-input-2.png"));
});

test("a lone generator shows no intake, and round covers only on its two fluoroketone outputs", () => {
  const commands = collect(entity("fusion-generator", 2.5, 2.5, 0));
  const drawn = sheets(commands);
  assert.ok(drawn.every((s) => !s.includes("-input-")));
  assert.equal(drawn.filter((s) => s === "pipe-cover-north.png").length, 2);
  assert.equal(drawn.filter((s) => /^pipe-cover-(north|east|south|west)\.png$/.test(s)).length, 2);
});

console.log(`\n${passed} passed`);
