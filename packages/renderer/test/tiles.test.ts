import assert from "node:assert/strict";
import type { BpTile, TileProto } from "@factoriotools/engine";
import { collectTiles } from "../src/draw/tiles.js";

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

const sheet = (size: number, probability: number, repeats?: boolean) => ({
  sheet: `s${size}.png`, size, count: 16, x: 0, y: 0, lineLength: 16, tilePx: 64, probability, repeats,
});
const protos: Record<string, TileProto> = {
  slab: { name: "slab", mapColor: "rgb(1,2,3)", variants: [sheet(2, 1), sheet(1, 1)] },
  material: { name: "material", mapColor: "rgb(4,5,6)", variants: [sheet(8, 1, true)] },
  bare: { name: "bare", mapColor: "rgb(7,8,9)", variants: [] },
};
const rect = (name: string, x0: number, y0: number, w: number, h: number): BpTile[] => {
  const tiles: BpTile[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles.push({ name, position: { x, y } });
  return tiles;
};

test("every tile is covered exactly once", () => {
  const scene = collectTiles(rect("slab", -3, -3, 7, 5), protos);
  const covered = new Map<string, number>();
  for (const c of scene.commands) {
    for (let dy = 0; dy < c.size; dy++) for (let dx = 0; dx < c.size; dx++) {
      const key = `${c.x + dx},${c.y + dy}`;
      covered.set(key, (covered.get(key) ?? 0) + 1);
    }
  }
  assert.equal(covered.size, 35);
  assert.ok([...covered.values()].every((n) => n === 1));
  assert.deepEqual(scene.bounds, { minX: -3, minY: -3, maxX: 4, maxY: 2 });
});

test("a whole aligned block takes the larger picture, a ragged edge the small one", () => {
  const scene = collectTiles(rect("slab", 0, 0, 3, 2), protos);
  assert.deepEqual(scene.commands.map((c) => c.size).sort(), [1, 1, 2]);
  const big = scene.commands.find((c) => c.size === 2)!;
  assert.deepEqual([big.x, big.y, big.sw, big.sheet], [0, 0, 128, "s2.png"]);
});

test("a material texture samples each tile's own cell of its block", () => {
  const [c] = collectTiles([{ name: "material", position: { x: -1, y: 10 } }], protos).commands;
  assert.equal(c!.size, 1);
  assert.equal(c!.sx % 512, 7 * 64);
  assert.equal(c!.sy, 2 * 64);
});

test("tiles without art fall back to a flat colour", () => {
  const scene = collectTiles([{ name: "bare", position: { x: 0, y: 0 } }, { name: "modded", position: { x: 1, y: 0 } }], protos);
  assert.equal(scene.commands[0]!.sheet, undefined);
  assert.equal(scene.commands[0]!.color, "rgb(7,8,9)");
  assert.equal(scene.commands[1]!.sheet, undefined);
});

test("the same tiles always pick the same pictures", () => {
  const tiles = rect("slab", 0, 0, 6, 6);
  const sorted = (list: BpTile[]) => collectTiles(list, protos).commands.sort((p, q) => p.y - q.y || p.x - q.x);
  assert.deepEqual(sorted(tiles), sorted([...tiles].reverse()));
});

test("no tiles, no floor", () => {
  assert.deepEqual(collectTiles([], protos), { commands: [], bounds: null });
});

console.log(`${passed} passed`);
