import assert from "node:assert/strict";
import { Camera } from "../src/camera.js";
import { buildVisualLookup, hasAnimatedLayer } from "../src/entityLookup.js";
import { requireDataset } from "./dataset.js";

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

/* ---------- Camera announces its own changes ---------- */
// render.ts relies on this instead of invalidating at each gesture call site,
// so if the notification stops firing the canvas silently freezes mid-pan.

test("zoomAt notifies", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let calls = 0;
  camera.onChange(() => calls++);
  camera.zoomAt(1.5, 100, 100, 800, 600);
  assert.equal(calls, 1);
});

test("panByScreenDelta notifies, but not for a zero-delta move", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let calls = 0;
  camera.onChange(() => calls++);
  camera.panByScreenDelta(10, -4);
  assert.equal(calls, 1);
  // A pointermove that does not actually move must not dirty the frame.
  camera.panByScreenDelta(0, 0);
  assert.equal(calls, 1);
});

test("frame notifies", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let calls = 0;
  camera.onChange(() => calls++);
  camera.frame({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 800, 600);
  assert.equal(calls, 1);
});

test("a zero pan leaves the camera exactly where it was", () => {
  const camera = new Camera({ x: 3, y: -2, pixelsPerTile: 32 });
  camera.panByScreenDelta(0, 0);
  assert.deepEqual(camera.state, { x: 3, y: -2, pixelsPerTile: 32 });
});

test("detaching the callback stops notifications", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let calls = 0;
  const unsubscribe = camera.onChange(() => calls++);
  unsubscribe();
  camera.panByScreenDelta(5, 5);
  assert.equal(calls, 0);
});

test("multiple listeners all fire, independently unsubscribable", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let a = 0;
  let b = 0;
  const unsubscribeA = camera.onChange(() => a++);
  camera.onChange(() => b++);
  camera.panByScreenDelta(1, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  unsubscribeA();
  camera.panByScreenDelta(1, 1);
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test("clearListeners drops every listener", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  let calls = 0;
  camera.onChange(() => calls++);
  camera.onChange(() => calls++);
  camera.clearListeners();
  camera.panByScreenDelta(5, 5);
  assert.equal(calls, 0);
});

/* ---------- hasAnimatedLayer decides whether the loop keeps drawing ---------- */

const { gameData: data, catalog } = requireDataset("redraw");
const lookup = buildVisualLookup(data, catalog);

test("belts report as animated", () => {
  // If this ever returns false, belts would visibly stop moving: the loop
  // would consider the scene static and stop advancing the clock.
  for (const name of ["transport-belt", "fast-transport-belt", "express-transport-belt"]) {
    const visual = lookup.get(name);
    if (!visual) continue; // dataset may not carry every tier
    assert.equal(hasAnimatedLayer(visual), true, `${name} must count as animated`);
  }
});

test("a plain static building does not report as animated", () => {
  // The opposite failure: a static entity wrongly counted as animated keeps
  // the loop redrawing forever, which is the very thing this change removes.
  const candidates = ["stone-wall", "pipe", "medium-electric-pole", "steel-chest"];
  const checked = candidates.map((n) => lookup.get(n)).filter((v) => v !== undefined);
  assert.ok(checked.length > 0, "expected at least one static entity in the dataset");
  for (const visual of checked) {
    assert.equal(hasAnimatedLayer(visual!), false);
  }
});

test("the answer is stable across repeated calls (cache correctness)", () => {
  const visual = lookup.get("transport-belt");
  if (!visual) return;
  const first = hasAnimatedLayer(visual);
  assert.equal(hasAnimatedLayer(visual), first);
  assert.equal(hasAnimatedLayer(visual), first);
});

test("at least one entity in the real dataset animates, and most do not", () => {
  // Sanity on the dataset itself: if everything animated, the dirty-flag
  // optimisation would never trigger and this test would say so.
  const all = [...lookup.values()].filter((v) => v.graphics);
  const animated = all.filter(hasAnimatedLayer).length;
  assert.ok(animated > 0, "expected some animated entities");
  assert.ok(animated < all.length, "expected some static entities");
  console.log(`      (${animated} of ${all.length} catalog entities animate)`);
});

console.log(`\n${passed} passing`);
