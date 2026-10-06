import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectBlueprints, decodeBlueprintString, normaliseEntities, type GameData, type PlacedEntity, type RenderCatalog } from "@factoriotools/engine";
import { DATA_DIR, hasDataset } from "./dataset.js";
import { buildVisualLookup, effectiveFootprint } from "../src/entityLookup.js";
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

const SIZES: Record<string, [number, number]> = { "rail-support": [4, 4], substation: [2, 2], "transport-belt": [1, 1], "assembling-machine-1": [3, 3], "rail-signal": [1, 1], "train-stop": [2, 2], "small-electric-pole": [1, 1] };
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

test("a support blocks the 4×4 tiles under a cardinal one, a diamond under a diagonal one", () => {
  const support = at("rail-support", 0, 0, 0);
  assert.equal(entitiesCollide(support, at("transport-belt", -1.5, 0.5), footprintOf), true, "the outer ring of the block");
  assert.equal(entitiesCollide(support, at("transport-belt", -2.5, 0.5), footprintOf), false);
  assert.equal(entitiesCollide(support, at("substation", 2, 2), footprintOf), true);
  // As in the example blueprints: a substation tucked into a diagonal support's corner.
  assert.equal(entitiesCollide(at("rail-support", 0, 0, 2), at("substation", 2, 2), footprintOf), false);
  assert.equal(entitiesCollide(at("rail-support", 0, 0, 2), at("substation", 1, 1), footprintOf), true);
});

test("a support stands on no ground track, under any elevated track", () => {
  const support = at("rail-support", 1, 0, 0);
  assert.equal(entitiesCollide(support, at("straight-rail", 1, 1, 0), footprintOf), true);
  assert.equal(entitiesCollide(support, at("straight-rail", 5, 1, 0), footprintOf), false);
  assert.equal(entitiesCollide(support, at("elevated-straight-rail", 1, 1, 0), footprintOf), false);
  assert.equal(entitiesCollide(support, at("rail-support", 2, 0, 0), footprintOf), true);
});

test("a ramp shares its tiles with no track, only meeting it at its ends", () => {
  const ramp = at("rail-ramp", 0, 1, 4);
  assert.equal(entitiesCollide(ramp, at("straight-rail", 1, 1, 0), footprintOf), true);
  assert.equal(entitiesCollide(ramp, at("elevated-straight-rail", 1, 1, 0), footprintOf), true);
  assert.equal(entitiesCollide(ramp, at("straight-rail", -9, 1, 4), footprintOf), false, "joined to its ground end");
  assert.equal(entitiesCollide(ramp, at("elevated-straight-rail", 9, 1, 4), footprintOf), false, "joined to its top");
  assert.equal(entitiesCollide(ramp, at("assembling-machine-1", 0.5, 1.5), footprintOf), true);
});

test("a signal on elevated track is clear of everything on the ground", () => {
  const signal: PlacedEntity = { ...at("rail-signal", 0.5, 0.5), railLayer: "elevated" };
  assert.equal(entitiesCollide(signal, at("assembling-machine-1", 0.5, 0.5), footprintOf), false);
  assert.equal(entitiesCollide(signal, at("rail-signal", 0.5, 0.5), footprintOf), false, "a ground signal below it");
  assert.equal(entitiesCollide(signal, { ...signal }, footprintOf), true);
});

test("box selection takes elevated track and its signals where they are drawn", () => {
  const rail = at("elevated-straight-rail", 1, 1, 0);
  assert.equal(boxHitsEntity({ left: 0.2, top: -2.8, right: 1.8, bottom: -1.2 }, rail, footprintOf), true);
  assert.equal(boxHitsEntity({ left: 0.2, top: 0.3, right: 1.8, bottom: 1.8 }, rail, footprintOf), false);
  const signal: PlacedEntity = { ...at("rail-signal", 0.5, 0.5), railLayer: "elevated" };
  assert.equal(boxHitsEntity({ left: 0.2, top: -2.8, right: 0.8, bottom: -2.2 }, signal, footprintOf), true);
  assert.equal(boxHitsEntity({ left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 }, signal, footprintOf), false);
});

test("nothing in the example blueprints collides with a ramp, a support or an elevated signal", () => {
  const examples = path.join(DATA_DIR, "example-blueprints.json");
  if (!hasDataset() || !existsSync(examples)) return;
  const read = (file: string) => JSON.parse(readFileSync(path.join(DATA_DIR, file), "utf-8"));
  const lookup = buildVisualLookup(read("game-data.json") as GameData, read("render-catalog.json") as RenderCatalog);
  const real = (e: PlacedEntity): [number, number] => {
    const visual = lookup.get(e.name);
    return visual ? effectiveFootprint(visual, e.direction) : [1, 1];
  };
  let pairs = 0;
  for (const example of JSON.parse(readFileSync(examples, "utf-8")) as { bp: string }[]) {
    for (const blueprint of collectBlueprints(decodeBlueprintString(example.bp))) {
      const entities = normaliseEntities(blueprint);
      for (const a of entities) {
        if (a.name !== "rail-support" && a.name !== "rail-ramp" && !a.railLayer) continue;
        for (const b of entities) {
          if (a === b || Math.abs(a.x - b.x) > 14 || Math.abs(a.y - b.y) > 14) continue;
          pairs++;
          assert.equal(entitiesCollide(a, b, real), false, `${a.name} at ${a.x},${a.y} facing ${a.direction} vs ${b.name} at ${b.x},${b.y}`);
        }
      }
    }
  }
  assert.ok(pairs > 1000, `only ${pairs} pairs checked`);
});

console.log(`${passed} passed`);
