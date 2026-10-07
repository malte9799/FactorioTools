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
import { openEnds, railEndsAt, railHighlightBox, railJoints, signalShape, signalSlotsForEnd } from "../src/railGeometry.js";

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

function collect(self: PlacedEntity, joints?: ReadonlySet<string>): DrawCommand[] {
  const ctx = {
    railJoints: joints,
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

test("a signal on elevated track wears its own art, hung off the side of the deck", () => {
  const sheets = (commands: DrawCommand[]) => commands.map((c) => c.sheet.split("/").pop()!).sort();
  const on = (name: string, direction: number, railLayer?: "elevated") => collect({ ...entity(name, 0.5, 0.5, direction), railLayer });
  assert.deepEqual(sheets(on("rail-signal", 4)), ["rail-signal-metals.png", "rail-signal.png"]);
  assert.deepEqual(sheets(on("rail-signal", 4, "elevated")), ["elevated-rail-signal-metals.png", "elevated-rail-signal-shadow.png", "elevated-rail-signal.png"]);
  assert.deepEqual(sheets(on("rail-chain-signal", 4, "elevated")), [
    "elevated-rail-chain-signal-metals-upper.png",
    "elevated-rail-chain-signal-metals.png",
    "elevated-rail-chain-signal-shadow.png",
    "elevated-rail-chain-signal.png",
  ]);

  // The signal sits in with the deck's bed, its bracket a tier under it, a
  // chain signal's upper piece over the sleepers; all three tiles up.
  const part = (commands: DrawCommand[], sheet: string) => commands.find((c) => c.sheet.endsWith(`/${sheet}`))!;
  const chain = on("rail-chain-signal", 4, "elevated");
  assert.equal(part(chain, "elevated-rail-chain-signal.png").layer, Layer.ElevatedRailStonePath);
  assert.equal(part(chain, "elevated-rail-chain-signal-metals.png").layer, Layer.ElevatedRailStonePathLower);
  // The arm lies on the sleepers, under the rails, on either side of the track.
  const arm = part(chain, "elevated-rail-chain-signal-metals-upper.png").layer;
  assert.ok(arm > Layer.ElevatedRailScrew && arm < Layer.ElevatedRailMetal);
  assert.equal(part(chain, "elevated-rail-chain-signal-shadow.png").layer, Layer.Shadow);
  const head = part(on("rail-signal", 4, "elevated"), "elevated-rail-signal.png");
  // 126 px at half scale is 1.97 tiles tall, shifted up 0.14.
  assert.ok(Math.abs(head.dy + head.dh / 2 - (0.5 - 3 - 0.140625)) < 1e-9);

  // The sheet has 25 rows for 16 facings (the extra ones are for particular
  // rail shapes): each facing takes the row plain track uses.
  const row = (direction: number) => {
    const c = part(on("rail-signal", direction, "elevated"), "elevated-rail-signal.png");
    return c.sy / c.sh;
  };
  assert.deepEqual(Array.from({ length: 16 }, (_, d) => row(d)), [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 16, 17, 19, 20, 22, 23]);
  const bracket = (direction: number) => {
    const c = part(on("rail-signal", direction, "elevated"), "elevated-rail-signal-metals.png");
    return (c.sy / c.sh) * 9 + c.sx / c.sw;
  };
  assert.deepEqual(Array.from({ length: 16 }, (_, d) => bracket(d)), [0, 1, 4, 5, 8, 9, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30]);
});

test("a signal on elevated track takes the frame for the shape of track it is on", () => {
  // Where the first curve piece off a straight (A) meets the second (B),
  // the track runs 22.5° off north. One of the two signals on B's side of
  // that joint has art of its own; A's side and plain track don't.
  const curve = { name: "elevated-curved-rail-b", x: -1, y: -5, direction: 0 };
  const end = railEndsAt(curve)[0]!;
  const rowOf = (slot: { x: number; y: number; direction: number }, shape: number | undefined) => {
    const self = { ...entity("rail-signal", slot.x, slot.y, slot.direction), railLayer: "elevated" as const };
    const out: DrawCommand[] = [];
    collectEntity(out, self, lookup.get(self.name)!, {
      grid: buildGrid([self]),
      fluidNetwork: buildFluidNetwork([self], () => undefined),
      heatNetwork: buildHeatNetwork([self], () => undefined),
      ...connectors,
      cargoBays: buildCargoBayGrid([self], connectors.cargoBayShapeOf),
      animationFrame: 0,
      signalShape: () => shape,
    }, 1);
    const head = out.find((c) => c.sheet.endsWith("/elevated-rail-signal.png"))!;
    return head.sy / head.sh;
  };
  const plain = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 16, 17, 19, 20, 22, 23];
  const rowsAt = (piece: typeof curve, at: (typeof end)) =>
    signalSlotsForEnd(at).map((slot) => {
      assert.equal(rowOf(slot, undefined), plain[slot.direction]);
      return [slot.direction, rowOf(slot, signalShape(piece, at, slot))];
    }).sort((a, b) => a[0]! - b[0]!);
  const special = rowsAt(curve, end).filter(([d, row]) => row !== plain[d!]);
  assert.equal(special.length, 1, JSON.stringify(rowsAt(curve, end)));
  const first = { name: "elevated-curved-rail-a", x: 1, y: 0, direction: 0 };
  assert.deepEqual(rowsAt(first, railEndsAt(first)[1]!), [[7, plain[7]], [15, plain[15]]]);
  // On straight track every slot is plain.
  const straight = { name: "elevated-straight-rail", x: 1, y: 1, direction: 0 };
  for (const e of railEndsAt(straight)) for (const slot of signalSlotsForEnd(e)) assert.equal(rowOf(slot, signalShape(straight, e, slot)), plain[slot.direction]);
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

test("track stops in an end cap at each end nothing joins, facing out along it", () => {
  const rails = [1, 3, 5].map((x) => entity("straight-rail", x, 1, 4));
  const joints = railJoints(rails);
  const caps = (self: PlacedEntity, sheet: string) =>
    collect(self, joints)
      .filter((c) => c.sheet.endsWith(sheet))
      .map((c) => ({ frame: c.sx / c.sw, x: c.dx + c.dw / 2, y: c.dy + c.dh / 2 }));
  // West end of the run: frame 12 (west) at the end point (0, 1), buffer and rail tips both.
  assert.deepEqual(caps(rails[0]!, "rail-endings-background.png"), [{ frame: 12, x: 0, y: 1 }]);
  assert.deepEqual(caps(rails[0]!, "rail-endings-foreground.png"), [{ frame: 12, x: 0, y: 1 }]);
  assert.deepEqual(caps(rails[1]!, "rail-endings-background.png"), [], "none mid-run");
  assert.deepEqual(caps(rails[2]!, "rail-endings-background.png"), [{ frame: 4, x: 6, y: 1 }]);
  // A piece on its own is capped both ends; a diagonal end uses its own frame.
  assert.deepEqual(collect(entity("curved-rail-a", 0, 0, 0), new Set()).filter((c) => c.sheet.endsWith("rail-endings-background.png")).map((c) => c.sx / c.sw).sort((a, b) => a - b), [8, 15]);
  // Up on the deck the cap is the elevated one, lifted with the track.
  const deck = collect(entity("elevated-straight-rail", 1, 1, 4), new Set()).filter((c) => c.sheet.endsWith("elevated-rail-ending.png"));
  assert.deepEqual(deck.map((c) => c.sx / c.sw).sort((a, b) => a - b), [4, 12]);
  assert.ok(deck.every((c) => Math.abs(c.dy + c.dh / 2 - (1 - 2.921875)) < 1e-9));
  // Track on the other layer, or facing the same way, doesn't join.
  const other = railJoints([entity("elevated-straight-rail", 3, 1, 4)]);
  assert.deepEqual(openEnds(rails[0]!, other), [true, true]);
  assert.deepEqual(openEnds(entity("rail-ramp", 0, 1, 4), new Set()), [false, false], "a ramp has none");
});

test("a rail's hover box takes in its end caps", () => {
  const plain = railHighlightBox("straight-rail", 4);
  assert.deepEqual([plain.cx, plain.cy, plain.h], [0, 0, 2]);
  const ends = railHighlightBox("straight-rail", 4, [true, true]);
  assert.deepEqual([ends.cx, ends.cy, ends.w], [0, 0, plain.w]);
  assert.ok(Math.abs(ends.h - 2.6) < 1e-9);
  // One capped end: longer that way only. A horizontal straight's first end is its east one.
  const one = railHighlightBox("straight-rail", 4, [true, false]);
  assert.ok(Math.abs(one.h - 2.3) < 1e-9 && Math.abs(one.cx - 0.15) < 1e-9 && one.cy === 0);
});


test("rolling stock rides on a set of wheels under each end, below its body", () => {
  for (const name of ["locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon"]) {
    // Heading east: the wheels are two tiles ahead of the centre and two behind.
    const commands = collect(entity(name, 10, 5, 4));
    const wheels = commands.filter((c) => c.sheet.endsWith("train-wheel.png"));
    assert.equal(wheels.length, 2, name);
    const centre = (c: DrawCommand) => c.dx + c.dw / 2;
    assert.deepEqual(wheels.map((c) => Math.round(centre(c))).sort((a, b) => a - b), [8, 12], name);
    // The two sets face opposite ways: frames half a turn (32 of 64) apart.
    const frame = (c: DrawCommand) => (c.sy / c.sh) * 8 + c.sx / c.sw;
    assert.deepEqual(wheels.map(frame).sort((a, b) => a - b), [16, 48], name);
    const body = commands.find((c) => c.layer === Layer.Object)!;
    for (const w of wheels) assert.ok(w.layer < body.layer && w.layer > Layer.Shadow, name);
  }
  // On a bridge the whole wagon is drawn up on the deck, over the track,
  // wheels still under the body; the shadow stays on the ground.
  const ground = collect(entity("cargo-wagon", 10, 5, 4));
  const raised = collect({ ...entity("cargo-wagon", 10, 5, 4), railLayer: "elevated" });
  raised.forEach((c, i) => {
    assert.equal(c.dy, ground[i]!.dy - (c.layer === Layer.Shadow ? 0 : 3));
    if (c.layer !== Layer.Shadow) assert.ok(c.layer >= Layer.ElevatedRailMetal);
  });
  const up = (sheet: string) => raised.find((c) => c.sheet.endsWith(sheet))!.layer;
  assert.ok(up("train-wheel.png") < up("cargo-wagon.png"));
  // The packed sheet has one frame per 64th of a turn as seen on screen,
  // so each of the 16 ways is four frames on from the last.
  const bodyFrame = (direction: number) => {
    const c = collect(entity("locomotive", 0, 0, direction)).find((c) => c.sheet.endsWith("locomotive.png"))!;
    return (c.sy / c.sh) * 8 + c.sx / c.sw;
  };
  assert.deepEqual([0, 2, 4, 6, 8, 10, 12, 14].map(bodyFrame), [0, 8, 16, 24, 32, 40, 48, 56]);
  // Heading north the front set is up the screen.
  const north = collect(entity("locomotive", 0, 0, 0)).filter((c) => c.sheet.endsWith("train-wheel.png"));
  assert.deepEqual(north.map((c) => Math.round(c.dy + c.dh / 2)).sort((a, b) => a - b), [-2, 2]);
});

console.log(`\n${passed} passed`);
