import assert from "node:assert/strict";
import { buildGrid, Dir } from "../src/neighbours/grid.js";
import { classifyBeltCell, undergroundSideLoaded, STRAIGHT_ROW } from "../src/neighbours/beltGraph.js";
import type { PlacedEntity } from "@factoriotools/engine";

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

let nextId = 1;
function belt(x: number, y: number, direction: number, name = "transport-belt", undergroundType?: "input" | "output"): PlacedEntity {
  return { entityNumber: nextId++, name, x, y, direction, quality: "normal", modules: [], filterItems: [], undergroundType };
}

const isBeltLike = (name: string) => name.includes("transport-belt") || name.includes("splitter") || name.includes("underground-belt");

function classify(entities: PlacedEntity[], at: PlacedEntity, forceStraight = false) {
  return classifyBeltCell(at.x, at.y, at.direction, buildGrid(entities), isBeltLike, forceStraight);
}

const capKinds = (cell: { caps: { kind: string }[] }) => cell.caps.map((c) => c.kind).sort();

/* ---------- straight runs ---------- */

test("a lone belt gets both caps and its facing's straight row", () => {
  const b = belt(0, 0, Dir.East);
  const cell = classify([b], b);
  assert.equal(cell.row, STRAIGHT_ROW[Dir.East]);
  assert.deepEqual(capKinds(cell), ["end", "start"]);
});

test("a belt fed from behind loses its start cap and stays straight", () => {
  const feeder = belt(-1, 0, Dir.East);
  const target = belt(0, 0, Dir.East);
  const cell = classify([feeder, target], target);
  assert.equal(cell.row, STRAIGHT_ROW[Dir.East]);
  assert.deepEqual(capKinds(cell), ["end"]);
});

test("a belt continuing into another loses its end cap", () => {
  const target = belt(0, 0, Dir.East);
  const next = belt(1, 0, Dir.East);
  const cell = classify([target, next], target);
  assert.deepEqual(capKinds(cell), ["start"]);
});

test("a belt mid-run has no caps at all", () => {
  const before = belt(-1, 0, Dir.East);
  const target = belt(0, 0, Dir.East);
  const after = belt(1, 0, Dir.East);
  const cell = classify([before, target, after], target);
  assert.deepEqual(capKinds(cell), []);
  assert.equal(cell.row, STRAIGHT_ROW[Dir.East]);
});

/* ---------- curves ---------- */

test("a side feed with nothing behind curves the belt", () => {
  // A belt facing east, fed from the north (its left when facing east is
  // north): the run bends rather than running straight.
  const target = belt(0, 0, Dir.East);
  const fromNorth = belt(0, -1, Dir.South);
  const curved = classify([target, fromNorth], target);
  const straight = classify([target], target);
  assert.notEqual(curved.row, straight.row, "a side-fed belt must not use the straight row");
});

test("a side feed PLUS a feed from behind merges and stays straight", () => {
  // Documented behaviour: the art does not distinguish a merge from a
  // straight run, so adding a behind-feed must cancel the curve.
  const target = belt(0, 0, Dir.East);
  const fromNorth = belt(0, -1, Dir.South);
  const fromBehind = belt(-1, 0, Dir.East);
  const cell = classify([target, fromNorth, fromBehind], target);
  assert.equal(cell.row, STRAIGHT_ROW[Dir.East]);
});

test("feeds from both sides cancel out and stay straight", () => {
  const target = belt(0, 0, Dir.East);
  const fromNorth = belt(0, -1, Dir.South);
  const fromSouth = belt(0, 1, Dir.North);
  const cell = classify([target, fromNorth, fromSouth], target);
  assert.equal(cell.row, STRAIGHT_ROW[Dir.East]);
});

test("left and right curves pick different rows", () => {
  const target = belt(0, 0, Dir.East);
  const fromNorth = classify([target, belt(0, -1, Dir.South)], target);
  const fromSouth = classify([target, belt(0, 1, Dir.North)], target);
  assert.notEqual(fromNorth.row, fromSouth.row);
});

/* ---------- cap suppression uses adjacency, not facing agreement ---------- */

test("two belts back-to-back suppress each other's caps despite not connecting", () => {
  // Regression guard for a documented bug: using "does it feed me" here drew
  // both belts' caps stacked at the shared seam. Cap suppression must ask
  // only whether a belt-like entity physically occupies the connection tile.
  const west = belt(0, 0, Dir.West); // faces away, to the west
  const east = belt(1, 0, Dir.East); // faces away, to the east
  const cellWest = classify([west, east], west);
  const cellEast = classify([west, east], east);
  // The shared seam is each belt's own "behind": the west-facing belt at x=0
  // has the east-facing one behind it (to its east) and vice versa. So each
  // keeps only its end cap — the seam-side start cap is suppressed by mere
  // adjacency, which is the point of this regression guard.
  assert.deepEqual(capKinds(cellWest), ["end"], "west-facing belt keeps only its end cap");
  assert.deepEqual(capKinds(cellEast), ["end"], "east-facing belt keeps only its end cap");
});

test("two belts nose-to-nose also suppress the touching caps", () => {
  const east = belt(0, 0, Dir.East);
  const west = belt(1, 0, Dir.West);
  assert.deepEqual(capKinds(classify([east, west], east)), ["start"]);
  assert.deepEqual(capKinds(classify([east, west], west)), ["start"]);
});

/* ---------- forceStraight (splitters, undergrounds) ---------- */

test("forceStraight ignores side feeds entirely", () => {
  const target = belt(0, 0, Dir.East);
  const fromNorth = belt(0, -1, Dir.South);
  const curved = classify([target, fromNorth], target, false);
  const forced = classify([target, fromNorth], target, true);
  assert.notEqual(curved.row, STRAIGHT_ROW[Dir.East], "sanity: it would curve without forceStraight");
  assert.equal(forced.row, STRAIGHT_ROW[Dir.East]);
});

/* ---------- underground side loading ---------- */

test("side loading only applies to east/west-facing undergrounds", () => {
  // Vanilla's side-loading sheet has no art for north/south, so the
  // classifier must not report it there even with a real side feed.
  const ugNorth = belt(0, 0, Dir.North, "underground-belt", "input");
  const feedEast = belt(1, 0, Dir.West);
  assert.equal(
    undergroundSideLoaded(0, 0, Dir.North, buildGrid([ugNorth, feedEast]), isBeltLike),
    false,
  );

  const ugEast = belt(0, 0, Dir.East, "underground-belt", "input");
  const feedNorth = belt(0, -1, Dir.South);
  assert.equal(
    undergroundSideLoaded(0, 0, Dir.East, buildGrid([ugEast, feedNorth]), isBeltLike),
    true,
  );
});

test("an east-facing underground with no side feed is not side loaded", () => {
  const ug = belt(0, 0, Dir.East, "underground-belt", "input");
  const behind = belt(-1, 0, Dir.East);
  assert.equal(undergroundSideLoaded(0, 0, Dir.East, buildGrid([ug, behind]), isBeltLike), false);
});

/* ---------- all four facings behave consistently ---------- */

test("every facing has its own distinct straight row", () => {
  const rows = [Dir.North, Dir.East, Dir.South, Dir.West].map((d) => STRAIGHT_ROW[d]);
  assert.equal(new Set(rows).size, 4, "the four facings must map to four different rows");
});

console.log(`\n${passed} passing`);
