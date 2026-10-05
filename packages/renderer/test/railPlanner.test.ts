import assert from "node:assert/strict";
import { planEnd, planRail, RAIL_PLAN_LENGTH_LIMIT, supportsFor } from "../src/railPlanner.js";
import { railEndsAt, railLength, railTiles, supportTiles, type RailEnd, type RailPiece } from "../src/railGeometry.js";
import { buildableRails, buildRailIndex, plannerTargetsElevated, previewRail, railPieceBlocked, railStartAt, startPiece } from "../src/railPlacement.js";

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

const bare = { startReach: -1, supported: () => false, blocked: () => false };

test("a long elevated run gets supports at most 22 tiles apart", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const pieces = planRail({ start, target: { x: 1, y: -80 }, targetElevated: true, blocked: open });
  const { supports, covered } = supportsFor(start, pieces, bare);
  assert.ok(covered);
  assert.ok(supports.every((s) => s.direction === 0 && s.x === 1), "under the joints, facing along the track");
  const ys = supports.map((s) => s.y).sort((a, b) => b - a);
  assert.ok(0 - ys[0]! <= 11, "the start is held");
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i - 1]! - ys[i]! <= 22, `gap ${ys[i - 1]} → ${ys[i]}`);
  assert.ok(ys[ys.length - 1]! - planEnd(start, pieces).y <= 11, "the far end is held");
  // No more of them than the run needs.
  assert.equal(supports.length, Math.ceil(planEnd(start, pieces).y / -22));
});

test("a support faces along the track it carries, whichever way that runs", () => {
  for (const dir of [0, 2, 4, 6, 8, 10, 12, 14]) {
    const { end: start } = startPiece(1, 1, dir, true);
    const [vx, vy] = [Math.round(Math.sin((dir * Math.PI) / 8)), -Math.round(Math.cos((dir * Math.PI) / 8))];
    const pieces = planRail({ start, target: { x: start.x + vx * 30, y: start.y + vy * 30 }, targetElevated: true, blocked: open });
    const { supports } = supportsFor(start, pieces, bare);
    assert.ok(supports.length > 0);
    assert.ok(supports.every((s) => s.direction === dir % 8), `heading ${dir}: ${supports.map((s) => s.direction)}`);
  }
});

test("a ramp holds the deck it leads to: supports start where its reach ends", () => {
  const { piece: ramp, end: top } = startPiece(1, 0, 0, false, true);
  const foot: RailEnd = { x: 1, y: 8, dir: 0, elevated: false };
  const deck = (length: number) => [ramp, ...planRail({ start: top, target: { x: top.x, y: top.y - length }, targetElevated: true, blocked: open })];
  assert.ok(connected(foot, deck(8)));
  assert.deepEqual(supportsFor(foot, deck(8), bare), { supports: [], covered: true }, "8 tiles of deck hang off the ramp alone");
  const { supports, covered } = supportsFor(foot, deck(50), bare);
  assert.ok(covered);
  const ys = supports.map((s) => s.y).sort((a, b) => b - a);
  assert.ok(ys[0]! < top.y, "none under the ramp's own top");
  assert.ok(top.y - ys[0]! <= 20, "the first within the ramp's reach plus its own");
  // Planned up from the ground in one go, the ramp is part of the plan.
  const up = planRail({ start: north, target: { x: 1, y: -60 }, targetElevated: true, blocked: open });
  assert.equal(up.filter((p) => p.name === "rail-ramp").length, 1);
  assert.ok(supportsFor(north, up, bare).covered);
});

test("track already held where it starts needs no support there", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const pieces = planRail({ start, target: { x: 1, y: -10 }, targetElevated: true, blocked: open });
  assert.equal(supportsFor(start, pieces, { ...bare, startReach: 11 }).supports.length, 0);
  assert.equal(supportsFor(start, pieces, { ...bare, supported: (x, y) => x === 1 && y === 0 }).supports.length, 0);
  assert.equal(supportsFor(start, pieces, bare).supports.length, 1);
});

test("a blocked joint moves the support to the nearest free one before it", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const pieces = planRail({ start, target: { x: 1, y: -40 }, targetElevated: true, blocked: open });
  const free = supportsFor(start, pieces, bare).supports.map((s) => s.y);
  const taken = free[0]!;
  const { supports, covered } = supportsFor(start, pieces, { ...bare, blocked: (_x, y) => y === taken });
  assert.ok(covered);
  assert.ok(!supports.some((s) => s.y === taken));
  assert.equal(supports[0]!.y, taken + 2);
});

test("the ramp item crosses to the other layer, the rail item stays on its own", () => {
  assert.equal(plannerTargetsElevated("rail-ramp", false), true);
  assert.equal(plannerTargetsElevated("rail-ramp", true), false);
  assert.equal(plannerTargetsElevated("straight-rail", true), true);
  assert.equal(plannerTargetsElevated("straight-rail", false), false);
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const down = planRail({ start, target: { x: 1, y: -40 }, targetElevated: false, blocked: open });
  assert.ok(connected(start, down));
  assert.equal(down.filter((p) => p.name === "rail-ramp").length, 1);
  assert.equal(planEnd(start, down).elevated, false);
  const { supports, covered } = supportsFor(start, down, bare);
  assert.ok(covered);
  const ramp = down.find((p) => p.name === "rail-ramp")!;
  const top = railEndsAt(ramp).find((e) => e.elevated)!;
  assert.ok(!supports.some((s) => s.x === top.x && s.y === top.y), "no support under the ramp's top");
});

const ent = (name: string, x: number, y: number, direction = 0, entityNumber = 1) => ({ entityNumber, name, x, y, direction, quality: "normal" as const, modules: [], filterItems: [] });
const footprint = (e: { name: string }): [number, number] => (e.name === "rail-support" ? [4, 4] : e.name === "stone-wall" ? [1, 1] : [2, 2]);

test("planned supports stand clear of buildings and ground track", () => {
  // A ground line crossing under the deck exactly where a support would go.
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const open2 = previewRail(buildRailIndex([], footprint), start, { x: 1, y: -40 }, true, true);
  const first = open2.supports.find((s) => s.y < -4)!;
  const crossing = [-3, -1, 1, 3, 5].map((x, i) => ent("straight-rail", x, first.y, 4, i + 1));
  const index = buildRailIndex(crossing, footprint);
  const plan = previewRail(index, start, { x: 1, y: -40 }, true, true);
  assert.ok(plan.pieces.length > 0 && plan.pieces.every((p) => p.name.startsWith("elevated-")), "the deck itself passes over");
  const groundTiles = new Set(crossing.flatMap((r) => railTiles(r).map(([x, y]) => `${x},${y}`)));
  for (const s of plan.supports) assert.ok(!supportTiles(s).some(([x, y]) => groundTiles.has(`${x},${y}`)), `support at ${s.x},${s.y} stands on track`);
});

test("continuing placed elevated track counts the support already under it", () => {
  const rails = [-1, -3, -5].map((y, i) => ent("elevated-straight-rail", 1, y, 0, i + 1));
  const support = ent("rail-support", 1, -2, 0, 9);
  const index = buildRailIndex([...rails, support], footprint);
  const end: RailEnd = { x: 1, y: -6, dir: 0, elevated: true };
  assert.equal(index.reachAt(end), 7, "4 tiles on from the support");
  assert.equal(buildRailIndex(rails, footprint).reachAt(end), -1);
  // Seven more tiles are still held; the eighth needs a new support.
  assert.equal(previewRail(index, end, { x: 1, y: -12 }, true, true).supports.length, 0);
  assert.equal(previewRail(index, end, { x: 1, y: -16 }, true, true).supports.length, 1);
  // Off a ramp's top the ramp's own reach counts.
  const ramp = ent("rail-ramp", 1, 8, 0, 20);
  assert.equal(buildRailIndex([ramp], footprint).reachAt({ x: 1, y: 0, dir: 0, elevated: true }), 9);
});

test("a ramp is solid: nothing is planned through it on either layer", () => {
  const ramp = ent("rail-ramp", 0, 1, 4, 1); // climbing east, x -8..8 along y = 1
  const index = buildRailIndex([ramp], footprint);
  assert.ok(railPieceBlocked(index, { name: "straight-rail", x: 1, y: 1, direction: 0 }));
  assert.ok(railPieceBlocked(index, { name: "elevated-straight-rail", x: 1, y: 1, direction: 0 }));
  assert.ok(railPieceBlocked(index, { name: "rail-ramp", x: 1, y: 2, direction: 0 }));
  assert.ok(!railPieceBlocked(index, { name: "rail-ramp", x: 0, y: 1, direction: 4 }), "the ramp itself is already there");
  // Track joined to its two ends starts where it stops.
  assert.ok(!railPieceBlocked(index, { name: "straight-rail", x: -9, y: 1, direction: 4 }));
  assert.ok(!railPieceBlocked(index, { name: "elevated-straight-rail", x: 9, y: 1, direction: 4 }));
  // Ground track heading for the far side goes round.
  const start: RailEnd = { x: 1, y: 12, dir: 0, elevated: false };
  const pieces = planRail({ start, target: { x: 1, y: -12 }, targetElevated: false, blocked: index.blocked });
  const rampTiles = new Set(railTiles(ramp).map(([x, y]) => `${x},${y}`));
  assert.ok(pieces.length > 0 && pieces.every((p) => railTiles(p).every(([x, y]) => !rampTiles.has(`${x},${y}`))));
});

test("a ramp can't be laid across ground track or a building, elevated track passes over both", () => {
  const index = buildRailIndex([ent("straight-rail", 5, 1, 0, 1), ent("stone-wall", -4.5, 20.5, 0, 2)], footprint);
  assert.ok(railPieceBlocked(index, { name: "rail-ramp", x: 0, y: 1, direction: 4 }));
  assert.ok(railPieceBlocked(index, { name: "rail-ramp", x: 0, y: 21, direction: 4 }));
  assert.ok(!railPieceBlocked(index, { name: "elevated-straight-rail", x: 5, y: 1, direction: 4 }));
  assert.ok(!railPieceBlocked(index, { name: "straight-rail", x: 5, y: 1, direction: 4 }), "ground track still crosses ground track");
});

test("a stale plan lays only what still fits", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const plan = previewRail(buildRailIndex([], footprint), start, { x: 1, y: -30 }, true, true);
  const spot = plan.supports[0]!;
  const wall = ent("stone-wall", spot.x + 0.5, spot.y + 0.5, 0, 1);
  const kept = buildableRails([wall, ent(plan.pieces[0]!.name, plan.pieces[0]!.x, plan.pieces[0]!.y, plan.pieces[0]!.direction, 2)], footprint, plan.pieces, plan.supports);
  assert.equal(kept.pieces.length, plan.pieces.length - 1, "the piece already there isn't laid twice");
  assert.equal(kept.supports.length, plan.supports.length - 1, "the support the wall is under is dropped");
});

test("elevated track is started from where it is seen, and a support starts track either way", () => {
  const rail = ent("elevated-straight-rail", 1, 1, 0, 1);
  const index = buildRailIndex([rail], footprint);
  assert.deepEqual(railStartAt(index, 1.2, -2.4)?.end, { x: 1, y: 0, dir: 0, elevated: true });
  assert.deepEqual(railStartAt(index, 1.2, -2.4)?.arrow, { x: 1, y: -2 });
  assert.equal(railStartAt(index, 1.2, 0.6), undefined, "not at its ground position");
  const support = buildRailIndex([ent("rail-support", 10, 10, 4, 1)], footprint);
  assert.deepEqual(railStartAt(support, 10.8, 7.2)?.end, { x: 10, y: 10, dir: 4, elevated: true });
  assert.deepEqual(railStartAt(support, 9.4, 10.3)?.end, { x: 10, y: 10, dir: 12, elevated: true });
  assert.deepEqual(railStartAt(support, 9.4, 10.3)?.arrow, { x: 10, y: 7 });
});

test("a ramp's top is started from where it is drawn, up beyond its own box", () => {
  const index = buildRailIndex([ent("rail-ramp", 1, 8, 0, 1)], footprint); // foot at y 16, top at y 0
  const top = { x: 1, y: 0, dir: 0, elevated: true };
  assert.deepEqual(railStartAt(index, 1.3, -2.5)?.end, top, "above the ramp's box, on the raised top");
  assert.deepEqual(railStartAt(index, 1.3, 1)?.end, top);
  assert.deepEqual(railStartAt(index, 1, 15)?.end, { x: 1, y: 16, dir: 8, elevated: false });
  assert.equal(railStartAt(index, 1, -4.5), undefined, "past the top");
  assert.equal(railStartAt(index, 4, -2), undefined, "beside it");
});

test("the ramp item's held piece is a ramp on the rail grid, continued from its top", () => {
  const { piece, end } = startPiece(0.3, 0.2, 4, false, true);
  assert.deepEqual(piece, { name: "rail-ramp", x: 0, y: 1, direction: 4 });
  assert.deepEqual(end, { x: 8, y: 1, dir: 4, elevated: true });
  // Dragged on from, the deck leaving it is held by the ramp itself.
  const plan = previewRail(buildRailIndex([], footprint), end, { x: 16, y: 1 }, true, true, piece);
  assert.ok(plan.pieces.length > 0 && plan.pieces.every((p) => p.name === "elevated-straight-rail"));
  assert.equal(plan.supports.length, 0);
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

test("elevated track with nowhere to stand a support isn't covered", () => {
  const start: RailEnd = { x: 1, y: 0, dir: 0, elevated: true };
  const pieces = planRail({ start, target: { x: 1, y: -60 }, targetElevated: true, blocked: open });
  assert.equal(supportsFor(start, pieces, { ...bare, blocked: () => true }).covered, false);
});

console.log(`${passed} passed`);
