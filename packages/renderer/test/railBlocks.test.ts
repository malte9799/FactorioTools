import assert from "node:assert/strict";
import { computeRailBlocks } from "../src/railBlocks.js";
import type { RailPiece } from "../src/railGeometry.js";

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

// Six straight rails running north from y=1 to y=-9; joints every 2 tiles.
const line: RailPiece[] = [1, -1, -3, -5, -7, -9].map((y) => ({ name: "straight-rail", x: 1, y, direction: 0 }));

test("unsignalled track is one block", () => {
  const blocks = computeRailBlocks(line, () => false);
  assert.equal(new Set(blocks.pieces.map((p) => p.block)).size, 1);
  assert.equal(blocks.markers.length, 0);
});

test("a signal at a joint splits the track into two blocks of different colours", () => {
  // A signal facing south (8) at the joint y=-4 governs northbound trains.
  const blocks = computeRailBlocks(line, (x, y, dir) => x === 1 && y === -4 && dir === 8);
  const below = blocks.pieces.filter((p) => p.piece.y > -4).map((p) => p.block);
  const above = blocks.pieces.filter((p) => p.piece.y < -4).map((p) => p.block);
  assert.equal(new Set(below).size, 1);
  assert.equal(new Set(above).size, 1);
  assert.notEqual(below[0], above[0]);
  assert.notEqual(blocks.colors[below[0]!], blocks.colors[above[0]!]);
  // Northbound trains leave the lower block and enter the upper one there.
  const lower = blocks.markers.find((m) => m.block === below[0]);
  const upper = blocks.markers.find((m) => m.block === above[0]);
  assert.equal(lower?.kind, "exit");
  assert.equal(upper?.kind, "entry");
  // The block lines stop short of the signalled joint, and only there.
  const cuts = blocks.pieces.flatMap((p) => p.cut).filter(Boolean);
  assert.equal(cuts.length, 2);
});

test("signals both ways at a joint give both blocks a diamond", () => {
  const blocks = computeRailBlocks(line, (x, y, dir) => x === 1 && y === -4 && (dir === 0 || dir === 8));
  assert.deepEqual(
    blocks.markers.map((m) => m.kind),
    ["diamond", "diamond"],
  );
});

test("crossing track joins the block it crosses", () => {
  const crossing: RailPiece = { name: "straight-rail", x: 1, y: -3, direction: 4 };
  const blocks = computeRailBlocks([...line, crossing], () => false);
  assert.equal(new Set(blocks.pieces.map((p) => p.block)).size, 1);
});

console.log(`${passed} passed`);
