import assert from "node:assert/strict";
import { buildGrid, Dir, type NeighbourGrid } from "../src/neighbours/grid.js";
import { classifyPipe, type ConnectionNetwork } from "../src/neighbours/pipe.js";
import { classifyWall } from "../src/neighbours/wall.js";
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

function entity(name: string, x: number, y: number, direction = 0): PlacedEntity {
  return { entityNumber: x * 1000 + y + 1, name, x, y, direction, quality: "normal", modules: [], filterItems: [] };
}

const isPipeLike = (name: string) => name === "pipe" || name === "pipe-to-ground";
const isWallLike = (name: string) => name === "stone-wall" || name === "gate";

/** Grid over the given entities, classifying the pipe at the origin. */
function pipeAt(entities: PlacedEntity[], network?: ConnectionNetwork): string {
  return classifyPipe(0, 0, buildGrid(entities), isPipeLike, network);
}

/* ---------- pipe: the neighbour mask picks the sprite variant ---------- */

test("a lone pipe uses the single-segment sprite", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0)]), "straight_vertical_single");
});

test("one neighbour makes an end cap facing that neighbour", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1)]), "ending_up");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 1, 0)]), "ending_right");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, 1)]), "ending_down");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", -1, 0)]), "ending_left");
});

test("two opposite neighbours make a straight run", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", 0, 1)]), "straight_vertical");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", -1, 0), entity("pipe", 1, 0)]), "straight_horizontal");
});

test("two adjacent neighbours make the matching corner", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", 1, 0)]), "corner_up_right");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", -1, 0)]), "corner_up_left");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, 1), entity("pipe", 1, 0)]), "corner_down_right");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, 1), entity("pipe", -1, 0)]), "corner_down_left");
});

test("three neighbours make a T named for the odd stub", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", -1, 0), entity("pipe", 1, 0)]), "t_up");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, 1), entity("pipe", -1, 0), entity("pipe", 1, 0)]), "t_down");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", 0, 1), entity("pipe", -1, 0)]), "t_left");
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", 0, 1), entity("pipe", 1, 0)]), "t_right");
});

test("four neighbours make a cross", () => {
  assert.equal(
    pipeAt([entity("pipe", 0, 0), entity("pipe", 0, -1), entity("pipe", 0, 1), entity("pipe", -1, 0), entity("pipe", 1, 0)]),
    "cross",
  );
});

test("a non-pipe neighbour does not connect", () => {
  assert.equal(pipeAt([entity("pipe", 0, 0), entity("transport-belt", 0, -1)]), "straight_vertical_single");
});

/* ---------- pipe-to-ground: connects only on the side it faces ---------- */

test("a pipe-to-ground connects only through its own open side", () => {
  // Facing north (0) means its opening points north, i.e. away from a pipe
  // sitting to its north — so the pipe below it must NOT connect upward.
  const facingNorth = entity("pipe-to-ground", 0, -1, Dir.North);
  assert.equal(pipeAt([entity("pipe", 0, 0), facingNorth]), "straight_vertical_single");

  // Facing south, its opening points back down at the pipe, so it connects.
  const facingSouth = entity("pipe-to-ground", 0, -1, Dir.South);
  assert.equal(pipeAt([entity("pipe", 0, 0), facingSouth]), "ending_up");
});

/* ---------- the connection network catches sockets the tile grid cannot ---------- */

test("a machine's fluid socket facing the pipe connects even with no pipe entity there", () => {
  // A pump/assembler's own connection point sits on a tile the grid has no
  // pipe-like entity for; only the network knows about it.
  const network: ConnectionNetwork = {
    hasConnectionFacing: (x, y, direction) => x === 0 && y === -1 && direction === Dir.South,
  };
  assert.equal(pipeAt([entity("pipe", 0, 0)], network), "ending_up");
});

test("a socket facing the wrong way does not connect", () => {
  const network: ConnectionNetwork = {
    hasConnectionFacing: (x, y, direction) => x === 0 && y === -1 && direction === Dir.North,
  };
  assert.equal(pipeAt([entity("pipe", 0, 0)], network), "straight_vertical_single");
});

/* ---------- wall ---------- */

function wallAt(entities: PlacedEntity[]): string {
  const grid: NeighbourGrid = buildGrid(entities);
  return classifyWall(0, 0, grid, isWallLike);
}

test("wall picks its sprite from the east/south/west cascade", () => {
  // Ported from the game's own ordering (see classifyWall's doc comment).
  assert.equal(wallAt([entity("stone-wall", 0, 0)]), "single");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", 1, 0)]), "endingRight");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", -1, 0)]), "endingLeft");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", 0, 1)]), "straightVertical");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", -1, 0), entity("stone-wall", 1, 0)]), "straightHorizontal");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", 1, 0), entity("stone-wall", 0, 1)]), "cornerRight");
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", -1, 0), entity("stone-wall", 0, 1)]), "cornerLeft");
  assert.equal(
    wallAt([entity("stone-wall", 0, 0), entity("stone-wall", -1, 0), entity("stone-wall", 1, 0), entity("stone-wall", 0, 1)]),
    "t",
  );
});

test("a wall ignores a north neighbour entirely", () => {
  // Deliberate asymmetry, documented in classifyWall: Factorio's wall art has
  // no north-only piece and the game's own cascade never tests north. Pinned
  // here so a future "let's make this symmetric" refactor has to argue with a
  // failing test rather than silently changing every wall run's appearance.
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("stone-wall", 0, -1)]), "single");
  assert.equal(
    wallAt([entity("stone-wall", 0, 0), entity("stone-wall", 0, -1), entity("stone-wall", 1, 0)]),
    "endingRight",
  );
});

test("a gate counts as wall-like for a neighbouring wall", () => {
  assert.equal(wallAt([entity("stone-wall", 0, 0), entity("gate", 1, 0)]), "endingRight");
  assert.equal(wallAt([entity("stone-wall", 0, 0)]), "single");
});

console.log(`\n${passed} passing`);
