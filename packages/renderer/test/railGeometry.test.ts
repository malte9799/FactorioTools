import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectBlueprints, decodeBlueprintString } from "@factoriotools/engine";
import { DATA_DIR } from "./dataset.js";
import { SpatialIndex } from "../src/spatialIndex.js";
import { buildRailIndex, railsideKey, railsideSlot, railsideSlotTaken, signalSlotsNear, supportSpotNear } from "../src/railPlacement.js";
import {
  isRail,
  railEnds,
  railEndsAt,
  railFootprint,
  railHighlightBox,
  railTileOffsets,
  signalSlots,
  slotGroup,
  snapStraightRail,
  supportDirection,
  supportHolds,
  supportTiles,
  trainStopSlots,
  type RailPiece,
} from "../src/railGeometry.js";

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

/** Every blueprint in the example set, as its raw entity list. */
function exampleBlueprints(): { name: string; position: { x: number; y: number }; direction?: number; rail_layer?: string }[][] {
  const file = path.join(DATA_DIR, "example-blueprints.json");
  if (!existsSync(file)) return [];
  const examples = JSON.parse(readFileSync(file, "utf-8")) as { bp: string }[];
  return examples.flatMap((ex) => collectBlueprints(decodeBlueprintString(ex.bp)).map((bp) => (bp.entities ?? []) as never));
}

const blueprints = exampleBlueprints();
const railsOf = (entities: (typeof blueprints)[number]): RailPiece[] =>
  entities.filter((e) => isRail(e.name)).map((e) => ({ name: e.name, x: e.position.x, y: e.position.y, direction: e.direction ?? 0 }));

test("every piece has two ends facing different ways", () => {
  for (const name of ["straight-rail", "half-diagonal-rail", "curved-rail-a", "curved-rail-b", "rail-ramp"]) {
    for (let d = 0; d < 16; d += 2) {
      const ends = railEnds(name, d);
      assert.equal(ends.length, 2, `${name} ${d}`);
      assert.notEqual(ends[0]!.dir, ends[1]!.dir, `${name} ${d}`);
    }
  }
});

test("a straight rail's ends are a tile either side, facing apart", () => {
  assert.deepEqual(
    railEnds("straight-rail", 0).map((e) => [e.dx, e.dy, e.dir]),
    [[0, -1, 0], [0, 1, 8]],
  );
  assert.deepEqual(
    railEnds("straight-rail", 4).map((e) => [e.dx, e.dy, e.dir]),
    [[1, 0, 4], [-1, 0, 12]],
  );
});

test("curve A turns 22.5° and curve B carries on to 45°", () => {
  // Heading north out of A's cardinal end, B continues from A's other end.
  const a = railEnds("curved-rail-a", 0);
  const b = railEnds("curved-rail-b", 0);
  assert.equal(a[0]!.dir, 8);
  assert.equal(a[1]!.dir, 15);
  assert.equal(b[0]!.dir, 7, "B's 22.5° end faces back into A");
  assert.equal(b[1]!.dir, 14, "B leaves heading north-west");
});

test("a ramp joins a ground end to an elevated end 16 tiles away", () => {
  const ends = railEnds("rail-ramp", 4);
  assert.deepEqual(ends.map((e) => [e.dx, e.dy, e.elevated]), [[-8, 0, false], [8, 0, true]]);
});

test("example blueprints' rails connect end to end", () => {
  if (blueprints.length === 0) return;
  let ends = 0;
  let connected = 0;
  for (const entities of blueprints) {
    const all = railsOf(entities).flatMap((r) => railEndsAt(r));
    const keys = new Set(all.map((e) => `${e.x},${e.y},${e.dir},${e.elevated}`));
    for (const e of all) {
      ends++;
      if (keys.has(`${e.x},${e.y},${(e.dir + 8) % 16},${e.elevated}`)) connected++;
    }
  }
  assert.ok(ends > 1000, `expected a real rail sample, got ${ends} ends`);
  // The rest are genuine dead ends (track that stops at a blueprint's edge).
  assert.ok(connected / ends > 0.9, `only ${connected}/${ends} rail ends connect`);
});

test("example straight rails sit where snapping would put them", () => {
  for (const entities of blueprints) {
    for (const r of railsOf(entities)) {
      if (r.name !== "straight-rail") continue;
      assert.deepEqual(snapStraightRail(r.x + 0.4, r.y - 0.4, r.direction), { x: r.x, y: r.y });
    }
  }
});

test("a straight rail covers exactly its own 2×2 tiles", () => {
  assert.deepEqual(railTileOffsets("straight-rail", 0).sort(), [[-1, -1], [-1, 0], [0, -1], [0, 0]]);
  assert.deepEqual(railFootprint("straight-rail", 0), [2, 2]);
});

test("curves cover a band along their track", () => {
  const tiles = railTileOffsets("curved-rail-a", 0);
  assert.ok(tiles.length >= 8 && tiles.length <= 16, `curve A covers ${tiles.length} tiles`);
  const [w, h] = railFootprint("curved-rail-a", 0);
  assert.ok(h >= 5 && w >= 2, `footprint ${w}×${h}`);
});

test("example signals sit in slots computed from their own rails", () => {
  let total = 0;
  let matched = 0;
  for (const entities of blueprints) {
    const slots = new Set(signalSlots(railsOf(entities)).map((s) => `${s.x},${s.y},${s.direction}`));
    for (const e of entities) {
      if (e.name !== "rail-signal" && e.name !== "rail-chain-signal") continue;
      total++;
      if (slots.has(`${e.position.x},${e.position.y},${e.direction ?? 0}`)) matched++;
    }
  }
  if (total === 0) return;
  assert.ok(matched === total, `${matched}/${total} signals in a slot`);
});

test("example train stops sit in slots beside their straight rails", () => {
  let total = 0;
  let matched = 0;
  for (const entities of blueprints) {
    const slots = new Set(trainStopSlots(railsOf(entities)).map((s) => `${s.x},${s.y},${s.direction}`));
    for (const e of entities) {
      if (e.name !== "train-stop") continue;
      total++;
      if (slots.has(`${e.position.x},${e.position.y},${e.direction ?? 0}`)) matched++;
    }
  }
  if (total === 0) return;
  assert.ok(matched / total > 0.99, `${matched}/${total} train stops in a slot`);
});

test("a rail is hovered by its turned box, not its square footprint", () => {
  const box = railHighlightBox("half-diagonal-rail", 2);
  assert.equal(box.w, 1.5);
  assert.ok(Math.abs(box.h - 4.472) < 0.01);
  const [w, h] = railFootprint("half-diagonal-rail", 2);
  const index = new SpatialIndex([
    { entityNumber: 1, left: -w / 2, top: -h / 2, right: w / 2, bottom: h / 2, turned: { ...box, cx: box.cx, cy: box.cy } },
  ]);
  // On the track: along its north-north-east line.
  assert.equal(index.hitTest(0.5, -1), 1);
  assert.equal(index.hitTest(-0.5, 1), 1);
  // Inside the square footprint, well off the track.
  assert.equal(index.hitTest(1.6, 1.6), undefined);
  assert.equal(index.hitTest(-1.6, -1.6), undefined);
});

test("every signal slot belongs to one of its rail's joints", () => {
  for (const rail of [
    { name: "straight-rail", x: 1, y: 1, direction: 0 },
    { name: "curved-rail-a", x: 0, y: 0, direction: 2 },
    { name: "half-diagonal-rail", x: 1, y: 1, direction: 4 },
  ]) {
    const ends = railEndsAt(rail).map((e) => `${e.x},${e.y}`);
    for (const slot of signalSlots([rail])) assert.ok(ends.includes(`${slot.ex},${slot.ey}`), `${rail.name}: ${slot.ex},${slot.ey}`);
  }
});

test("a signal takes its whole joint side, and only that side", () => {
  const track = [1, 3, 5].map((y, i) => ({ entityNumber: i + 1, name: "straight-rail", x: 1, y, direction: 0, quality: "normal" as const, modules: [], filterItems: [] }));
  const free = signalSlotsNear(buildRailIndex(track, () => [2, 2]), 1, 3, 12);
  const pick = free.find((s) => s.ex === 1 && s.ey === 2)!;
  const side = free.filter((s) => slotGroup(s) === slotGroup(pick));
  assert.equal(side.length, 2, "two slots per joint side");
  const signal = { entityNumber: 9, name: "rail-signal", x: pick.x, y: pick.y, direction: pick.direction, quality: "normal" as const, modules: [], filterItems: [] };
  const after = signalSlotsNear(buildRailIndex([...track, signal], () => [2, 2]), 1, 3, 12);
  assert.equal(after.filter((s) => slotGroup(s) === slotGroup(pick)).length, 0, "both slots of the taken side are gone");
  const otherSide = after.filter((s) => s.ex === 1 && s.ey === 2 && s.direction !== pick.direction);
  assert.equal(otherSide.length, 2, "the other side of the joint stays free");
});

test("a lone curve offers one signal slot per side at each end", () => {
  const slots = signalSlots([{ name: "curved-rail-a", x: 0, y: 0, direction: 0 }]);
  assert.equal(slots.length, 4);
  for (const end of railEndsAt({ name: "curved-rail-a", x: 0, y: 0, direction: 0 })) {
    const here = slots.filter((s) => s.ex === end.x && s.ey === end.y);
    assert.deepEqual(here.map((s) => s.direction).sort((a, b) => a - b), [end.dir, (end.dir + 8) % 16].sort((a, b) => a - b));
  }
});

test("where two straights meet, each side has a slot either side of the joint", () => {
  const rails = [1, 3, 5].map((y) => ({ name: "straight-rail", x: 1, y, direction: 0 }));
  const atJoint = signalSlots(rails).filter((s) => s.ex === 1 && s.ey === 2);
  assert.equal(atJoint.filter((s) => s.direction === 0).length, 2);
  assert.equal(atJoint.filter((s) => s.direction === 8).length, 2);
});

test("a held train stop over a taken slot stays on it, not the free one beside it", () => {
  const rails = [1, 3, 5].map((y, i) => ({ entityNumber: i + 1, name: "straight-rail", x: 1, y, direction: 0, quality: "normal" as const, modules: [], filterItems: [] }));
  const slots = trainStopSlots(rails);
  const taken = slots.find((s) => s.y === 3 && s.direction === 0)!;
  const stop = { entityNumber: 9, name: "train-stop", x: taken.x, y: taken.y, direction: taken.direction, quality: "normal" as const, modules: [], filterItems: [] };
  const index = buildRailIndex([...rails, stop], () => [2, 2]);
  // Just off the placed stop, toward its free neighbour two tiles along.
  const picked = railsideSlot(index, "train-stop", taken.x, taken.y - 0.6, taken.direction);
  assert.deepEqual(picked && [picked.x, picked.y], [taken.x, taken.y]);
  assert.ok(index.railsideTaken.has(railsideKey(taken.x, taken.y, false)), "so the ghost shows red and nothing is placed");
});

test("a held signal over a taken joint side stays on it, not the free slot beside it", () => {
  const rails = [1, 3, 5].map((y, i) => ({ entityNumber: i + 1, name: "straight-rail", x: 1, y, direction: 0, quality: "normal" as const, modules: [], filterItems: [] }));
  const slots = signalSlots(rails).filter((s) => s.ex === 1 && s.ey === 2 && s.direction === 0);
  const [placed, twin] = slots;
  assert.ok(placed && twin);
  const signal = { entityNumber: 9, name: "rail-signal", x: placed.x, y: placed.y, direction: placed.direction, quality: "normal" as const, modules: [], filterItems: [] };
  const index = buildRailIndex([...rails, signal], () => [1, 1]);
  const picked = railsideSlot(index, "rail-signal", placed.x, placed.y + 0.3, placed.direction);
  assert.deepEqual(picked && [picked.x, picked.y], [placed.x, placed.y]);
  assert.ok(railsideSlotTaken(index, picked!), "so the ghost shows red and nothing is placed");
  assert.ok(railsideSlotTaken(index, twin), "the twin slot on the same joint side is taken too");
});

const placed = (name: string, x: number, y: number, direction = 0, entityNumber = 1) => ({ entityNumber, name, x, y, direction, quality: "normal" as const, modules: [], filterItems: [] });

test("every rail support in the examples faces along the elevated track ends above it", () => {
  let checked = 0;
  for (const entities of blueprints) {
    const ends = railsOf(entities).flatMap((r) => railEndsAt(r)).filter((e) => e.elevated);
    for (const s of entities.filter((e) => e.name === "rail-support")) {
      const above = ends.filter((e) => e.x === s.position.x && e.y === s.position.y);
      if (above.length === 0) continue;
      assert.ok((s.direction ?? 0) < 8, "a support only has the first 8 facings");
      assert.ok(above.some((e) => supportHolds(s.direction ?? 0, e.dir)), `support at ${s.position.x},${s.position.y} facing ${s.direction} under ends ${above.map((e) => e.dir)}`);
      checked++;
    }
  }
  if (blueprints.length > 0) assert.ok(checked > 20, `only ${checked} supports under track`);
});

test("every elevated signal in the examples stands on a slot of elevated track", () => {
  let checked = 0;
  for (const entities of blueprints) {
    const signals = entities.filter((e) => e.rail_layer === "elevated");
    if (signals.length === 0) continue;
    const index = buildRailIndex(
      entities.filter((e) => isRail(e.name)).map((e, i) => placed(e.name, e.position.x, e.position.y, e.direction ?? 0, i + 1)),
      () => [2, 2],
    );
    for (const s of signals) {
      assert.ok(
        index.signalSlots.some((slot) => slot.elevated && slot.x === s.position.x && slot.y === s.position.y && slot.direction === (s.direction ?? 0)),
        `${s.name} at ${s.position.x},${s.position.y} facing ${s.direction}`,
      );
      checked++;
    }
  }
  if (blueprints.length > 0) assert.ok(checked > 10, `only ${checked} elevated signals`);
});

test("every elevated end in the examples is within reach of a support or ramp", () => {
  let checked = 0;
  for (const entities of blueprints) {
    if (!entities.some((e) => e.name === "rail-support")) continue;
    const index = buildRailIndex(
      entities.filter((e) => isRail(e.name) || e.name === "rail-support").map((e, i) => placed(e.name, e.position.x, e.position.y, e.direction ?? 0, i + 1)),
      () => [2, 2],
    );
    for (const end of railsOf(entities).flatMap((r) => railEndsAt(r))) {
      if (!end.elevated) continue;
      assert.ok(index.reachAt(end) >= 0, `end at ${end.x},${end.y} facing ${end.dir}`);
      checked++;
    }
  }
  if (blueprints.length > 0) assert.ok(checked > 100, `only ${checked} elevated ends`);
});

test("a support folds the 16 facings into 8 and blocks a 4×4 block, or a diamond when turned", () => {
  assert.equal(supportDirection(12), 4);
  assert.equal(supportDirection(11), 3);
  assert.ok(supportHolds(4, 12) && !supportHolds(4, 0));
  const square = supportTiles({ x: 1, y: 1, direction: 0 });
  assert.equal(square.length, 16);
  assert.ok(square.every(([tx, ty]) => tx >= -1 && tx <= 2 && ty >= -1 && ty <= 2));
  const diamond = supportTiles({ x: 0, y: 0, direction: 2 }).map(([tx, ty]) => `${tx},${ty}`);
  assert.ok(!diamond.includes("1,1") && !diamond.includes("-2,-2"), "the corners of the block are clear");
  assert.ok(diamond.includes("-2,-1") && diamond.includes("1,0"), "its points reach the block's sides");
});

test("elevated track is hovered up on the deck, a ramp on the ground", () => {
  assert.equal(railHighlightBox("elevated-straight-rail", 0).cy, -3);
  assert.equal(railHighlightBox("straight-rail", 0).cy, 0);
  assert.equal(railHighlightBox("rail-ramp", 0).cy, 0);
});

test("a held support snaps under the nearest bare joint of elevated track", () => {
  const rails = [1, 3, 5].map((x, i) => placed("elevated-straight-rail", x, 1, 4, i + 1));
  const index = buildRailIndex(rails, () => [2, 2]);
  // Pointing at the joint up on the deck, or at the ground below it.
  assert.deepEqual(supportSpotNear(index, 2.3, -2.2), { name: "rail-support", x: 2, y: 1, direction: 4 });
  assert.deepEqual(supportSpotNear(index, 4.2, 1.4), { name: "rail-support", x: 4, y: 1, direction: 4 });
  assert.equal(supportSpotNear(index, 20, 20), undefined);
  // A joint that already has its support isn't offered again.
  const held = buildRailIndex([...rails, placed("rail-support", 2, 1, 4, 9)], () => [4, 4]);
  assert.notEqual(supportSpotNear(held, 2.3, 1)?.x, 2);
});

test("a held signal snaps to elevated track where it is seen, and is placed on the deck", () => {
  const rails = [1, 3, 5].map((y, i) => placed("elevated-straight-rail", 1, y, 0, i + 1));
  const index = buildRailIndex(rails, () => [2, 2]);
  const slot = index.signalSlots.find((s) => s.ex === 1 && s.ey === 2 && s.direction === 0)!;
  assert.equal(slot.elevated, true);
  const picked = railsideSlot(index, "rail-signal", slot.x, slot.y - 3, 0);
  assert.deepEqual(picked && [picked.x, picked.y, picked.elevated], [slot.x, slot.y, true]);
  // Down at its ground position nothing is in reach.
  assert.equal(railsideSlot(index, "rail-signal", slot.x, 12, 0), undefined);
  // A ground signal on the same spot leaves the deck slot free, and the other way round.
  const withGround = buildRailIndex([...rails, placed("rail-signal", slot.x, slot.y, 0, 9)], () => [1, 1]);
  assert.equal(railsideSlotTaken(withGround, slot), false);
  const withDeck = buildRailIndex([...rails, { ...placed("rail-signal", slot.x, slot.y, 0, 9), railLayer: "elevated" as const }], () => [1, 1]);
  assert.equal(railsideSlotTaken(withDeck, slot), true);
  assert.equal(index.stopSlots.length, 0, "no train stops up there");
});

console.log(`${passed} passed`);
