import assert from "node:assert/strict";
import type { PlacedEntity } from "@factoriotools/engine";
import { boxHitsEntity, entitiesCollide } from "../src/collision.js";
import { railFootprint, signalSlots } from "../src/railGeometry.js";

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

const at = (name: string, x: number, y: number, direction = 0): PlacedEntity => ({
  entityNumber: 0,
  name,
  x,
  y,
  direction,
  quality: "normal",
  modules: [],
  filterItems: [],
});

const SIZES: Record<string, [number, number]> = { "assembling-machine-1": [3, 3], "rail-signal": [1, 1], "train-stop": [2, 2], "small-electric-pole": [1, 1] };
const footprintOf = (e: PlacedEntity): [number, number] => (e.name.includes("rail") && !e.name.includes("signal") ? railFootprint(e.name, e.direction) : SIZES[e.name] ?? [1, 1]);

// Curve A facing north: its track runs from (0,2) up to (-1,-3), bending
// left, so the right side of its square footprint is empty.
const curve = at("curved-rail-a", 0, 0, 0);

test("something beside a curve, inside its square, doesn't collide", () => {
  assert.equal(entitiesCollide(at("small-electric-pole", 1.5, -2.5), curve, footprintOf), false);
  assert.equal(entitiesCollide(curve, at("small-electric-pole", 1.5, -2.5), footprintOf), false);
});

test("something on the track does", () => {
  assert.equal(entitiesCollide(at("small-electric-pole", -0.5, 0.5), curve, footprintOf), true);
  assert.equal(entitiesCollide(at("assembling-machine-1", 0.5, -0.5), curve, footprintOf), true);
});

test("a signal on its slot doesn't collide with the track", () => {
  const rail = at("straight-rail", 1, 1, 0);
  const [slot] = signalSlots([rail]);
  assert.ok(slot);
  assert.equal(entitiesCollide(at("rail-signal", slot.x, slot.y, slot.direction), rail, footprintOf), false);
});

test("signals collide only on the very same spot", () => {
  assert.equal(entitiesCollide(at("rail-signal", 0.5, 0.5), at("rail-signal", 0.5, 1.5), footprintOf), false);
  assert.equal(entitiesCollide(at("rail-signal", 0.5, 0.5), at("rail-signal", 0.5, 0.5), footprintOf), true);
});

test("track crosses track, and elevated track stands over the ground", () => {
  assert.equal(entitiesCollide(at("straight-rail", 1, 1, 0), at("straight-rail", 1, 1, 4), footprintOf), false);
  assert.equal(entitiesCollide(at("elevated-straight-rail", 1, 1, 0), at("assembling-machine-1", 1.5, 1.5), footprintOf), false);
});

test("the very same rail twice collides; distinct rails don't", () => {
  assert.equal(entitiesCollide(at("straight-rail", 1, 1, 0), at("straight-rail", 1, 1, 8), footprintOf), true, "a straight facing back is the same piece");
  assert.equal(entitiesCollide(at("curved-rail-a", 0, 0, 2), at("curved-rail-a", 0, 0, 2), footprintOf), true);
  assert.equal(entitiesCollide(at("curved-rail-a", 0, 0, 2), at("curved-rail-a", 0, 0, 0), footprintOf), false);
});

test("box selection beside a curve misses it, across its track hits it", () => {
  assert.equal(boxHitsEntity({ left: 1.2, top: -3, right: 2, bottom: -2 }, curve, footprintOf), false);
  assert.equal(boxHitsEntity({ left: -0.8, top: 0.2, right: -0.2, bottom: 0.8 }, curve, footprintOf), true);
});

console.log(`${passed} passed`);
