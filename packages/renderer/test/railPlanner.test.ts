import assert from "node:assert/strict";
import { planEnd, planRail, RAIL_PLAN_LENGTH_LIMIT, supportsFor } from "../src/railPlanner.js";
import { railEndsAt, railLength, railTiles, type RailEnd, type RailPiece } from "../src/railGeometry.js";
import { buildRailIndex, railStartAt } from "../src/railPlacement.js";

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

test("a 90° turn takes the tightest corner: curves back to back", () => {
  // The minimal corner: curve A, B, B, A with nothing between.
  const start: RailEnd = { x: 303, y: 276, dir: 8, elevated: false };
  const pieces = planRail({ start, target: { x: 316, y: 289 }, targetElevated: false, blocked: open });
  assert.deepEqual(
    pieces.map((p) => [p.name, p.x, p.y, p.direction]),
    [
      ["curved-rail-a", 303, 278, 8],
      ["curved-rail-b", 305, 283, 8],
      ["curved-rail-b", 309, 287, 14],
      ["curved-rail-a", 314, 289, 14],
    ],
  );
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

test("the start arrow only shows on a placed rail, toward the cursor's half", () => {
  const rail = { entityNumber: 1, name: "straight-rail", x: 1, y: 1, direction: 0, quality: "normal" as const, modules: [], filterItems: [] };
  const index = buildRailIndex([rail], () => [2, 2]);
  assert.deepEqual(railStartAt(index, 1.2, 0.6)?.end, { x: 1, y: 0, dir: 0, elevated: false });
  assert.deepEqual(railStartAt(index, 0.8, 1.6)?.end, { x: 1, y: 2, dir: 8, elevated: false });
  // Beside the track, or just past its end: nothing.
  assert.equal(railStartAt(index, 2.6, 1), undefined);
  assert.equal(railStartAt(index, 1, -0.6), undefined);
});

const trackLength = (pieces: RailPiece[]) => pieces.reduce((sum, p) => sum + railLength(p.name, p.direction), 0);

test("without Shift a placement lays 11 straights toward a far cursor", () => {
  const pieces = planRail({ start: north, target: { x: 1, y: -80 }, targetElevated: false, blocked: open, maxLength: RAIL_PLAN_LENGTH_LIMIT });
  assert.equal(pieces.length, 11);
  assert.ok(pieces.every((p) => p.name === "straight-rail"));
});

test("without Shift a far turn heads the cursor's way and stops at the limit", () => {
  const target = { x: 60, y: -60 };
  const pieces = planRail({ start: north, target, targetElevated: false, blocked: open, maxLength: RAIL_PLAN_LENGTH_LIMIT });
  assert.ok(pieces.length > 0 && connected(north, pieces));
  assert.ok(trackLength(pieces) <= RAIL_PLAN_LENGTH_LIMIT + 1e-6, `laid ${trackLength(pieces)}`);
  const end = planEnd(north, pieces);
  assert.ok(Math.hypot(end.x - target.x, end.y - target.y) < Math.hypot(north.x - target.x, north.y - target.y) - 15, "got well closer");
  assert.ok(pieces.some((p) => p.name.startsWith("curved")), "turns toward the cursor");
});

test("without Shift, a cursor no track can get closer to gets no plan", () => {
  // Just beside the end, at right angles: every piece leads away from it.
  assert.deepEqual(planRail({ start: north, target: { x: 4, y: 1 }, targetElevated: false, blocked: open, maxLength: RAIL_PLAN_LENGTH_LIMIT }), []);
});

console.log(`${passed} passed`);
