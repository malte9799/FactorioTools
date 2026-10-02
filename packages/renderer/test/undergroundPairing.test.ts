import assert from "node:assert/strict";
import { autoUnderground, undergroundPartner } from "../src/entityLookup.js";
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
const EAST = 4;
const WEST = 12;
function ug(x: number, direction: number, undergroundType: "input" | "output", name = "underground-belt"): PlacedEntity {
  return { entityNumber: nextId++, name, x: x + 0.5, y: 0.5, direction, quality: "normal", modules: [], filterItems: [], undergroundType };
}

const type = (...args: Parameters<typeof autoUnderground>) => autoUnderground(...args).undergroundType;

test("held facing back at an entrance in range, the new one becomes its exit", () => {
  assert.deepEqual(autoUnderground([ug(0, EAST, "input")], "underground-belt", 4.5, 0.5, WEST, 5), { undergroundType: "output", direction: EAST });
  assert.equal(type([ug(0, EAST, "input")], "underground-belt", 5.5, 0.5, WEST, 5), "output");
});

test("held the same way as the entrance, out of range, or a different tier stays an entrance", () => {
  assert.deepEqual(autoUnderground([ug(0, EAST, "input")], "underground-belt", 4.5, 0.5, EAST, 5), { undergroundType: "input", direction: EAST });
  assert.equal(type([ug(0, EAST, "input")], "underground-belt", 6.5, 0.5, WEST, 5), "input");
  assert.equal(type([ug(0, EAST, "input", "fast-underground-belt")], "underground-belt", 3.5, 0.5, WEST, 5), "input");
  // Behind the entrance, not ahead of it.
  assert.equal(type([ug(4, EAST, "input")], "underground-belt", 0.5, 0.5, WEST, 5), "input");
});

test("the nearest same-way underground decides", () => {
  // Exit at 2 (nearer) wins over the entrance at 0 — so a new entrance.
  assert.equal(type([ug(0, EAST, "input"), ug(2, EAST, "output")], "underground-belt", 4.5, 0.5, WEST, 5), "input");
  // One travelling the other way in between is passed over.
  assert.equal(type([ug(0, EAST, "input"), ug(2, WEST, "input")], "underground-belt", 4.5, 0.5, WEST, 5), "output");
});

test("undergroundPartner finds the other half from either end", () => {
  const entrance = ug(0, EAST, "input");
  const exit = ug(4, EAST, "output");
  const all = [entrance, exit];
  assert.equal(undergroundPartner(all, entrance, 5), exit);
  assert.equal(undergroundPartner(all, exit, 5), entrance);
  assert.equal(undergroundPartner([entrance, ug(4, EAST, "input")], entrance, 5), undefined);
});

console.log(`${passed} passed`);
