import assert from "node:assert/strict";
import { snapAnchorToTiles } from "../src/pasteSnap.js";

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

/** Where hand placement puts a footprint's centre for a cursor (render.ts's
 *  snapAxis): odd widths on a tile centre, even widths on a tile corner. */
const handPlaced = (cursor: number, width: number) => (width % 2 === 1 ? Math.floor(cursor) + 0.5 : Math.round(cursor));

// Issue #61: copy one building, stamp the ghost anywhere, and it must sit
// where the same building would if placed by hand.
for (const width of [1, 2, 3, 4, 5]) {
  test(`${width}x${width} copy stamps where hand placement would`, () => {
    const copiedAt = handPlaced(10.3, width);
    for (let i = -70; i <= 70; i++) {
      const cursor = i / 10 + 0.003;
      const snapped = snapAnchorToTiles({ x: cursor, y: cursor }, { x: copiedAt, y: copiedAt });
      assert.ok(Math.abs(snapped.x - handPlaced(cursor, width)) < 1e-9, `cursor ${cursor}: ${snapped.x} vs ${handPlaced(cursor, width)}`);
      assert.ok(Math.abs(snapped.y - handPlaced(cursor, width)) < 1e-9);
    }
  });
}

test("a group moves by whole tiles from where it was copied", () => {
  const anchor = { x: 1.75, y: -3.5 };
  for (let i = -13; i <= 13; i++) {
    const cx = i * 0.37;
    const snapped = snapAnchorToTiles({ x: cx, y: cx * 1.3 }, anchor);
    assert.ok(Math.abs(snapped.x - anchor.x - Math.round(snapped.x - anchor.x)) < 1e-9);
    assert.ok(Math.abs(snapped.y - anchor.y - Math.round(snapped.y - anchor.y)) < 1e-9);
  }
});

test("the ghost stays within half a tile of the cursor", () => {
  const anchor = { x: 0.5, y: 0.5 };
  for (let i = -38; i <= 38; i++) {
    const c = i * 0.13;
    const snapped = snapAnchorToTiles({ x: c, y: c }, anchor);
    assert.ok(Math.abs(snapped.x - c) <= 0.5 + 1e-9);
  }
});

console.log(`${passed} passed`);
