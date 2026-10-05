/** How elevated rail pieces pick and place their art.
 *
 *  A rail support's sheet holds 8 facings, each standing for two opposite
 *  ones: the 16-way facing wrapped round those 8 picks the frame. A signal
 *  on elevated track draws its ground art up on the deck, over the track.
 *
 *  Run with: npx tsx test/railArt.test.ts
 */
import assert from "node:assert/strict";
import { Layer, type PlacedEntity } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates, effectiveFootprint, rotationCount, rotationStep, rotateAroundCenter } from "../src/entityLookup.js";
import { buildGrid } from "../src/neighbours/grid.js";
import { buildFluidNetwork } from "../src/neighbours/fluid.js";
import { buildHeatNetwork } from "../src/neighbours/heat.js";
import { buildCargoBayGrid } from "../src/neighbours/cargoBay.js";
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

const { gameData, catalog } = requireDataset("railArt");
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

function entity(name: string, x: number, y: number, direction = 0): PlacedEntity {
  return { entityNumber: 1, name, x, y, direction, quality: "normal", modules: [], filterItems: [] };
}

function collect(self: PlacedEntity): DrawCommand[] {
  const ctx = {
    grid: buildGrid([self]),
    fluidNetwork: buildFluidNetwork([self], () => undefined),
    heatNetwork: buildHeatNetwork([self], () => undefined),
    ...connectors,
    cargoBays: buildCargoBayGrid([self], connectors.cargoBayShapeOf),
    animationFrame: 0,
  };
  const out: DrawCommand[] = [];
  collectEntity(out, self, lookup.get(self.name)!, ctx, 1);
  return out;
}

test("a rail support draws the frame of its facing, the same from both sides", () => {
  const frame = (direction: number) => {
    const pylon = collect(entity("rail-support", 0, 0, direction)).find((c) => c.sheet.endsWith("elevated-rail-pylon.png"))!;
    return [pylon.sx / pylon.sw, pylon.sy / pylon.sh];
  };
  // 4 frames to a row: north-south track first, east-west track fifth.
  assert.deepEqual(frame(0), [0, 0]);
  assert.deepEqual(frame(2), [2, 0]);
  assert.deepEqual(frame(3), [3, 0]);
  assert.deepEqual(frame(4), [0, 1]);
  assert.deepEqual(frame(7), [3, 1]);
  assert.deepEqual(frame(12), frame(4));
  assert.equal(collect(entity("rail-support", 0, 0, 5)).length, 2, "the pylon and its shadow");
});

test("a rail support turns in 22.5° steps through its 8 facings, and blocks a 4×4 block", () => {
  assert.equal(rotationStep("rail-support"), 1);
  assert.equal(rotationCount("rail-support"), 8);
  assert.equal(rotationCount("rail-signal"), 16);
  assert.deepEqual(effectiveFootprint(lookup.get("rail-support")!, 0), [4, 4]);
  // Pasted a quarter turn round, an east-west support carries north-south track.
  assert.equal(rotateAroundCenter(entity("rail-support", 2, 0, 4), { x: 0, y: 0 }, 1).direction, 0);
  assert.equal(rotateAroundCenter(entity("rail-support", 2, 0, 6), { x: 0, y: 0 }, 1).direction, 2);
});

test("a signal on elevated track is drawn up on the deck, over the track", () => {
  const ground = collect(entity("rail-signal", 0.5, 0.5, 4));
  const deck = collect({ ...entity("rail-signal", 0.5, 0.5, 4), railLayer: "elevated" });
  assert.equal(deck.length, ground.length);
  deck.forEach((c, i) => {
    const g = ground[i]!;
    if (g.layer === Layer.Shadow) {
      assert.equal(c.dy, g.dy);
      return;
    }
    assert.equal(c.dy, g.dy - 3);
    assert.equal(c.layer, Layer.ElevatedRailMetal);
  });
});

test("elevated track and ramps carry their guard rails on both sides, in every facing", () => {
  const fences = (name: string, direction: number) =>
    collect(entity(name, 0, 0, direction))
      .map((c) => c.sheet.split("/").pop()!)
      .filter((sheet) => sheet.includes("fence"))
      .sort();
  const deck = ["A-shadow", "A-upper", "A", "B-shadow", "B-upper", "B"].map((part) => `elevated-rail-fence-${part}.png`).sort();
  for (const name of ["elevated-straight-rail", "elevated-half-diagonal-rail", "elevated-curved-rail-a", "elevated-curved-rail-b"]) {
    for (let direction = 0; direction < 16; direction += 2) assert.deepEqual([...new Set(fences(name, direction))], deck, `${name} facing ${direction}`);
  }
  // A straight's fence is one frame; a curve's or half-diagonal's is cut
  // into two, side by side in the sheet, and both are drawn.
  const frames = (name: string) =>
    collect(entity(name, 0, 0, 0))
      .filter((c) => c.sheet.endsWith("elevated-rail-fence-A.png"))
      .map((c) => c.sx)
      .sort((a, b) => a - b);
  assert.deepEqual(frames("elevated-straight-rail"), [0]);
  assert.deepEqual(frames("elevated-half-diagonal-rail"), [0, 768]);
  assert.deepEqual(frames("elevated-curved-rail-a"), [1536, 2304]);
  assert.deepEqual(frames("elevated-curved-rail-b"), [3072, 3840]);
  for (const direction of [0, 4, 8, 12]) {
    assert.deepEqual(fences("rail-ramp", direction), ["elevated-rail-ramp-fence-A.png", "elevated-rail-ramp-fence-B.png"]);
  }
  assert.deepEqual(fences("straight-rail", 0), [], "none on the ground");
  // The fence sits on the deck with the track: same facing row, same lift.
  const piece = collect(entity("elevated-curved-rail-a", 0, 0, 6));
  const metals = piece.find((c) => c.sheet.endsWith("elevated-rail-metals.png"))!;
  const fence = piece.find((c) => c.sheet.endsWith("elevated-rail-fence-A.png"))!;
  assert.deepEqual([fence.sy, fence.dx, fence.dy], [metals.sy, metals.dx, metals.dy]);
});

console.log(`\n${passed} passed`);
