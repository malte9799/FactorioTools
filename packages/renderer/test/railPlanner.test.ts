import assert from "node:assert/strict";
import { planEnd, planRail, supportsFor } from "../src/railPlanner.js";
import { railEndsAt, railTiles, type RailEnd, type RailPiece } from "../src/railGeometry.js";

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

const open = () => false;
const north: RailEnd = { x: 1, y: 0, dir: 0, elevated: false };

/** True when every consecutive pair of pieces shares an end, facing apart. */
function connected(start: RailEnd, pieces: RailPiece[]): boolean {
  let at = start;
  for (const p of pieces) {
    const ends = railEndsAt(p);
    const near = ends.findIndex((e) => e.x === at.x && e.y === at.y && e.dir === (at.dir + 8) % 16 && e.elevated === at.elevated);
    if (near < 0) return false;
    at = ends[1 - near]!;
  }
  return true;
}

test("straight ahead plans straight rails only", () => {
  const pieces = planRail({ start: north, target: { x: 1, y: -40 }, targetElevated: false, blocked: open });
  assert.ok(pieces.length >= 19, `${pieces.length} pieces`);
  assert.ok(pieces.every((p) => p.name === "straight-rail" && p.direction % 8 === 0));
  assert.ok(connected(north, pieces));
});

test("a 90° turn is built the way the game builds it", () => {
  // The game's own full curve, south then east: a curve never follows a
  // curve directly, there's always a straight piece of that angle between.
  const start: RailEnd = { x: 221, y: 256, dir: 8, elevated: false };
  const pieces = planRail({ start, target: { x: 244, y: 277 }, targetElevated: false, blocked: open });
  assert.deepEqual(
    pieces.map((p) => [p.name, p.x, p.y, p.direction]),
    [
      ["curved-rail-a", 221, 258, 8],
      ["half-diagonal-rail", 223, 263, 0],
      ["curved-rail-b", 225, 267, 8],
      ["straight-rail", 228, 270, 6],
      ["curved-rail-b", 231, 273, 14],
      ["half-diagonal-rail", 235, 275, 6],
      ["curved-rail-a", 240, 277, 14],
      ["straight-rail", 243, 277, 4],
    ],
  );
});

test("two curves never touch", () => {
  for (const target of [{ x: 30, y: -20 }, { x: -25, y: -25 }, { x: 15, y: -60 }, { x: 40, y: 10 }]) {
    const names = planRail({ start: north, target, targetElevated: false, blocked: open }).map((p) => p.name);
    for (let i = 1; i < names.length; i++) {
      assert.ok(!(names[i - 1]!.includes("curved") && names[i]!.includes("curved")), names.join(" "));
    }
  }
});

test("a shallow slope uses half-diagonal track", () => {
  const pieces = planRail({ start: north, target: { x: 15, y: -60 }, targetElevated: false, blocked: open });
  assert.ok(connected(north, pieces));
  assert.ok(pieces.some((p) => p.name === "half-diagonal-rail"), pieces.map((p) => p.name).join(" "));
});

test("track routes around an obstacle", () => {
  const wall = (tx: number, ty: number) => ty === -20 && tx >= -6 && tx <= 6;
  const pieces = planRail({ start: north, target: { x: 1, y: -40 }, targetElevated: false, blocked: (tx, ty) => wall(tx, ty) });
  assert.ok(connected(north, pieces));
  for (const p of pieces) for (const [tx, ty] of railTiles(p)) assert.ok(!wall(tx, ty), `${p.name} at ${p.x},${p.y} hits the wall`);
  const end = planEnd(north, pieces);
  assert.ok(Math.hypot(end.x - 1, end.y + 40) <= 1.5, `ended at ${end.x},${end.y}`);
});

test("a 100-tile run plans in one go", () => {
  const pieces = planRail({ start: north, target: { x: 1, y: -100 }, targetElevated: false, blocked: open });
  assert.ok(connected(north, pieces));
  assert.ok(pieces.length >= 49);
});

test("going up a layer inserts a ramp and continues elevated", () => {
  const pieces = planRail({ start: north, target: { x: 1, y: -50 }, targetElevated: true, blocked: open });
  assert.ok(connected(north, pieces));
  const ramp = pieces.findIndex((p) => p.name === "rail-ramp");
  assert.ok(ramp >= 0, "has a ramp");
  assert.ok(pieces.slice(ramp + 1).every((p) => p.name.startsWith("elevated-")));
  assert.equal(planEnd(north, pieces).elevated, true);
});

test("a long elevated run gets supports at most 22 tiles apart", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const pieces = planRail({ start, target: { x: 1, y: -80 }, targetElevated: true, blocked: open });
  const supports = supportsFor(start, pieces, () => false, () => false);
  const ys = supports.map((s) => s.y).sort((a, b) => b - a);
  assert.equal(ys[0], 0, "the unsupported start gets one");
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i - 1]! - ys[i]! <= 22, `gap ${ys[i - 1]} → ${ys[i]}`);
  assert.ok(ys[ys.length - 1]! - planEnd(start, pieces).y <= 11, "the far end is held");
});

console.log(`${passed} passed`);
