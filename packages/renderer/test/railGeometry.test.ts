import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectBlueprints, decodeBlueprintString } from "@factoriotools/engine";
import { DATA_DIR } from "./dataset.js";
import { SpatialIndex } from "../src/spatialIndex.js";
import { buildRailIndex, signalSlotsNear } from "../src/railPlacement.js";
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
function exampleBlueprints(): { name: string; position: { x: number; y: number }; direction?: number }[][] {
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
  assert.ok(matched / total > 0.99, `${matched}/${total} signals in a slot`);
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

console.log(`${passed} passed`);
