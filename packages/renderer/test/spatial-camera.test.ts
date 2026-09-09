import assert from "node:assert/strict";
import { SpatialIndex, type IndexedBox } from "../src/spatialIndex.js";
import { Camera } from "../src/camera.js";

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

function box(entityNumber: number, left: number, top: number, right: number, bottom: number): IndexedBox {
  return { entityNumber, left, top, right, bottom };
}

/* ---------- SpatialIndex.hitTest ---------- */

test("hitTest finds a box containing the point", () => {
  const index = new SpatialIndex([box(1, 0, 0, 2, 2)]);
  assert.equal(index.hitTest(1, 1), 1);
  assert.equal(index.hitTest(0, 0), 1, "edges count as inside");
  assert.equal(index.hitTest(2, 2), 1);
});

test("hitTest misses outside the box", () => {
  const index = new SpatialIndex([box(1, 0, 0, 2, 2)]);
  assert.equal(index.hitTest(3, 1), undefined);
  assert.equal(index.hitTest(-0.1, 1), undefined);
});

test("hitTest returns the last-added box when several overlap", () => {
  // Documented: topmost means last added, matching draw order.
  const index = new SpatialIndex([box(1, 0, 0, 4, 4), box(2, 1, 1, 3, 3)]);
  assert.equal(index.hitTest(2, 2), 2);
});

test("hitTest works far from the origin and at negative coordinates", () => {
  // Bucket keys are derived by flooring a division, so negatives are the
  // classic place for an off-by-one.
  const index = new SpatialIndex([box(7, -105.5, -63.25, -103.5, -61.25)]);
  assert.equal(index.hitTest(-104.5, -62.25), 7);
  assert.equal(index.hitTest(-99, -62.25), undefined);
});

/* ---------- SpatialIndex.queryRect ---------- */

test("queryRect returns every overlapping box, deduplicated", () => {
  // A box wider than one 8-tile bucket is pushed into several buckets; it
  // must still come back exactly once.
  const index = new SpatialIndex([box(1, 0, 0, 30, 2)]);
  const hits = index.queryRect(-5, -5, 40, 5);
  assert.equal(hits.size, 1);
  assert.ok(hits.has(1));
});

test("queryRect excludes boxes outside the rect", () => {
  const index = new SpatialIndex([box(1, 0, 0, 2, 2), box(2, 100, 100, 102, 102)]);
  const hits = index.queryRect(-1, -1, 3, 3);
  assert.deepEqual([...hits], [1]);
});

test("queryRect edges are inclusive, which frustum culling relies on", () => {
  // An entity exactly on the viewport boundary must still be drawn, or it
  // pops in and out while panning.
  const index = new SpatialIndex([box(1, 10, 10, 12, 12)]);
  assert.equal(index.queryRect(0, 0, 10, 10).size, 1, "touching at a corner still counts");
  assert.equal(index.queryRect(0, 0, 9.99, 9.99).size, 0);
});

test("an empty index yields no hits and a null bounding box", () => {
  const index = new SpatialIndex([]);
  assert.equal(index.hitTest(0, 0), undefined);
  assert.equal(index.queryRect(-100, -100, 100, 100).size, 0);
  assert.equal(index.boundingBox, null);
});

test("boundingBox spans every box", () => {
  const index = new SpatialIndex([box(1, -4, -2, 0, 0), box(2, 6, 3, 10, 9)]);
  assert.deepEqual(index.boundingBox, { minX: -4, minY: -2, maxX: 10, maxY: 9 });
});

/* ---------- Camera ---------- */

test("screenToWorld and worldToScreen are inverses", () => {
  const camera = new Camera({ x: 12, y: -7, pixelsPerTile: 24 });
  const world = camera.screenToWorld(300, 200, 800, 600);
  const back = camera.worldToScreen(world.x, world.y, 800, 600);
  assert.ok(Math.abs(back.x - 300) < 1e-9, `x round-trip: ${back.x}`);
  assert.ok(Math.abs(back.y - 200) < 1e-9, `y round-trip: ${back.y}`);
});

test("the viewport centre maps to the camera's own position", () => {
  const camera = new Camera({ x: 5, y: 9, pixelsPerTile: 32 });
  const world = camera.screenToWorld(400, 300, 800, 600);
  assert.deepEqual(world, { x: 5, y: 9 });
});

test("zoomAt keeps the anchored screen point fixed in world space", () => {
  // The whole point of zoom-to-cursor: whatever was under the pointer stays
  // under the pointer.
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  const before = camera.screenToWorld(120, 480, 800, 600);
  camera.zoomAt(1.7, 120, 480, 800, 600);
  const after = camera.screenToWorld(120, 480, 800, 600);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted: ${before.x} -> ${after.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted: ${before.y} -> ${after.y}`);
});

test("zoom is clamped to the camera's own limits", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  camera.zoomAt(1000, 400, 300, 800, 600);
  assert.equal(camera.state.pixelsPerTile, 256);
  camera.zoomAt(0.00001, 400, 300, 800, 600);
  assert.equal(camera.state.pixelsPerTile, 6);
});

test("panByScreenDelta moves 1:1 with the cursor at any zoom", () => {
  for (const pixelsPerTile of [8, 32, 128]) {
    const camera = new Camera({ x: 0, y: 0, pixelsPerTile });
    const before = camera.worldToScreen(3, 4, 800, 600);
    camera.panByScreenDelta(50, -20);
    const after = camera.worldToScreen(3, 4, 800, 600);
    assert.ok(Math.abs(after.x - before.x - 50) < 1e-9, `x at ${pixelsPerTile}px/tile`);
    assert.ok(Math.abs(after.y - before.y + 20) < 1e-9, `y at ${pixelsPerTile}px/tile`);
  }
});

test("frame centres a box and fits it inside the viewport", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  camera.frame({ minX: 0, minY: 0, maxX: 40, maxY: 20 }, 800, 600, 4);
  assert.deepEqual({ x: camera.state.x, y: camera.state.y }, { x: 20, y: 10 });
  // With 4 tiles of padding each side: 48 x 28 tiles into 800 x 600 px.
  const topLeft = camera.screenToWorld(0, 0, 800, 600);
  const bottomRight = camera.screenToWorld(800, 600, 800, 600);
  assert.ok(topLeft.x <= 0 && topLeft.y <= 0, "box must be fully visible");
  assert.ok(bottomRight.x >= 40 && bottomRight.y >= 20, "box must be fully visible");
});

test("framing a huge box still respects the minimum zoom", () => {
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  camera.frame({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, 800, 600);
  assert.equal(camera.state.pixelsPerTile, 6);
});

console.log(`\n${passed} passing`);
