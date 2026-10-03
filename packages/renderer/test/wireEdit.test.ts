/**
 * The wire-EDITING primitives: auto-connect on place, and the manual
 * connect/disconnect toggle.
 *
 * autoConnectPole is the part worth pinning down hardest. The obvious rule —
 * "wire every pole in reach" — is wrong in a way that only shows up on a
 * dense field, where it produces a cobweb instead of a power line. The real
 * rule (ported from the reference editor) has two limiters that are easy to
 * drop and hard to notice missing:
 *
 *   - a pole already carrying 5 copper wires is not a candidate, and
 *   - each pole picked also blacklists everything IT is already wired to,
 *     so a new pole joins an existing clump ONCE rather than once per member.
 *
 * Both are asserted directly below, because a regression in either still
 * looks plausible on a two-pole test and only falls apart at scale.
 */
import assert from "node:assert/strict";
import type { PlacedEntity, WireLink } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, isPoleLike } from "../src/entityLookup.js";
import { autoConnectPole, canWire, dropWiresFor, toggleWire, wireExists } from "../src/neighbours/wires.js";

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

const { gameData, catalog } = requireDataset("wireEdit");
const lookup = buildVisualLookup(gameData, catalog);
const visualFor = (name: string) => lookup.get(name);

function pole(entityNumber: number, x: number, y: number, name = "medium-electric-pole"): PlacedEntity {
  return {
    entityNumber, name, x, y, direction: 0,
    quality: "normal", modules: [], filterItems: [],
  } as unknown as PlacedEntity;
}

const copper = (from: number, to: number): WireLink =>
  ({ color: "copper", from, fromSide: 1, to, toSide: 1 });

/* ---------- Auto-connect on place ---------- */

test("a pole placed alone connects to nothing", () => {
  const p = pole(1, 0, 0);
  assert.deepEqual(autoConnectPole(p, [p], [], visualFor, isPoleLike), []);
});

test("a pole placed in reach of one pole connects to it", () => {
  const existing = pole(1, 0, 0);
  const placed = pole(2, 6, 0); // medium reach is 9
  const wires = autoConnectPole(placed, [existing, placed], [], visualFor, isPoleLike);
  assert.equal(wires.length, 1);
  assert.ok(wireExists(wires, "copper", 1, 2));
});

test("a pole out of reach connects to nothing", () => {
  const existing = pole(1, 0, 0);
  const placed = pole(2, 20, 0); // beyond medium's 9
  assert.deepEqual(autoConnectPole(placed, [existing, placed], [], visualFor, isPoleLike), []);
});

test("reach uses the SHORTER of the two poles' limits", () => {
  // A big pole reaches 32, a small one 7.5. At 12 apart the big pole could
  // reach but the small one cannot, so no wire may be created.
  const big = pole(1, 0, 0, "big-electric-pole");
  const placed = pole(2, 12, 0, "small-electric-pole");
  assert.deepEqual(autoConnectPole(placed, [big, placed], [], visualFor, isPoleLike), []);
});

test("a non-pole is never auto-connected", () => {
  const chest = { ...pole(1, 0, 0), name: "wooden-chest" } as PlacedEntity;
  const placed = { ...pole(2, 2, 0), name: "wooden-chest" } as PlacedEntity;
  assert.deepEqual(autoConnectPole(placed, [chest, placed], [], visualFor, isPoleLike), []);
});

test("a pole never wires to a non-pole neighbour", () => {
  // Copper is pole-to-pole only; a chest in reach must be ignored even
  // though it sits well inside the radius.
  const chest = { ...pole(1, 2, 0), name: "wooden-chest" } as PlacedEntity;
  const placed = pole(2, 0, 0);
  assert.deepEqual(autoConnectPole(placed, [chest, placed], [], visualFor, isPoleLike), []);
});

test("an already-wired pair is not wired a second time", () => {
  const a = pole(1, 0, 0);
  const b = pole(2, 6, 0);
  const existing = [copper(1, 2)];
  const after = autoConnectPole(b, [a, b], existing, visualFor, isPoleLike);
  assert.equal(after.length, 1, "no duplicate wire added");
});

test("a new pole joins a connected clump ONCE, not once per member", () => {
  // Three poles all in reach of each other AND already wired into a chain.
  // Without the blacklist the newcomer would wire to all three.
  const a = pole(1, 0, 0);
  const b = pole(2, 4, 0);
  const c = pole(3, 8, 0);
  const existing = [copper(1, 2), copper(2, 3)];
  const placed = pole(4, 4, 4); // within 9 of all three
  const after = autoConnectPole(placed, [a, b, c, placed], existing, visualFor, isPoleLike);
  const added = after.length - existing.length;
  assert.equal(added, 1, `expected one new wire into the clump, got ${added}`);
});

test("two separate clumps each get one wire", () => {
  // Two chains far apart from each other but both in reach of the newcomer:
  // it must join BOTH networks, one wire each, since they are not already
  // connected to one another.
  const a = pole(1, -8, 0);
  const b = pole(2, -6, 0);
  const c = pole(3, 6, 0);
  const d = pole(4, 8, 0);
  const existing = [copper(1, 2), copper(3, 4)];
  const placed = pole(5, 0, 0);
  const after = autoConnectPole(placed, [a, b, c, d, placed], existing, visualFor, isPoleLike);
  const added = after.length - existing.length;
  assert.equal(added, 2, `expected one wire into each clump, got ${added}`);
});

test("a pole already carrying 5 copper wires is not a candidate", () => {
  // `hub` is saturated; `spare` is not. The newcomer must pick the spare.
  const hub = pole(1, 0, 0);
  const spare = pole(2, 3, 0);
  const others = [pole(10, 0, 3), pole(11, 0, -3), pole(12, 3, 3), pole(13, -3, 0), pole(14, -3, 3)];
  const existing = others.map((o) => copper(1, o.entityNumber));
  assert.equal(existing.length, 5, "hub starts saturated");

  const placed = pole(3, 1, 1);
  const after = autoConnectPole(placed, [hub, spare, ...others, placed], existing, visualFor, isPoleLike);
  const added = after.filter((w) => w.from === 3 || w.to === 3);
  assert.ok(!added.some((w) => w.from === 1 || w.to === 1),
    "must not wire into a pole that already has 5 copper wires");
});

test("a new pole takes at most 5 copper wires itself", () => {
  // Eight unconnected poles, all in reach, none wired to each other — so the
  // blacklist never fires and only the per-pole cap can limit the count.
  const ring = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    pole(i + 1, Math.round(Math.cos((i / 8) * Math.PI * 2) * 4), Math.round(Math.sin((i / 8) * Math.PI * 2) * 4)),
  );
  const placed = pole(99, 0, 0);
  const after = autoConnectPole(placed, [...ring, placed], [], visualFor, isPoleLike);
  assert.ok(after.length <= 5, `expected at most 5 wires, got ${after.length}`);
});

test("the nearest pole is preferred", () => {
  const near = pole(1, 2, 0);
  const far = pole(2, 8, 0);
  const placed = pole(3, 0, 0);
  const after = autoConnectPole(placed, [near, far, placed], [], visualFor, isPoleLike);
  assert.ok(wireExists(after, "copper", 3, 1), "wires to the nearest pole");
});

/* ---------- Manual connect / disconnect ---------- */

test("toggleWire connects when absent and disconnects when present", () => {
  const first = toggleWire([], "red", 1, 2);
  assert.equal(first.connected, true);
  assert.equal(first.wires.length, 1);

  const second = toggleWire(first.wires, "red", 1, 2);
  assert.equal(second.connected, false);
  assert.equal(second.wires.length, 0, "the same pair toggles back off");
});

test("toggleWire is direction-agnostic", () => {
  const { wires } = toggleWire([], "green", 7, 3);
  // Clicking the same two entities in the opposite order must remove the
  // wire, not add a mirrored duplicate.
  const back = toggleWire(wires, "green", 3, 7);
  assert.equal(back.connected, false);
  assert.equal(back.wires.length, 0);
});

test("toggleWire keeps colours independent", () => {
  const red = toggleWire([], "red", 1, 2).wires;
  const both = toggleWire(red, "green", 1, 2);
  assert.equal(both.connected, true);
  assert.equal(both.wires.length, 2, "red and green coexist on one pair");
});

test("an entity cannot be wired to itself", () => {
  const result = toggleWire([], "copper", 1, 1);
  assert.equal(result.connected, false);
  assert.equal(result.wires.length, 0);
});

test("toggleWire treats a combinator's two sides as separate terminals", () => {
  const input = toggleWire([], "red", 1, 2, 1, 1).wires;
  const both = toggleWire(input, "red", 1, 2, 1, 2);
  assert.equal(both.connected, true);
  assert.equal(both.wires.length, 2, "input and output of the same pair coexist");

  const back = toggleWire(both.wires, "red", 2, 1, 2, 1);
  assert.equal(back.connected, false);
  assert.deepEqual(back.wires, input, "only the output-side wire is removed");

  const loop = toggleWire([], "green", 5, 5, 1, 2);
  assert.equal(loop.connected, true, "a combinator's input can feed from its own output");
});

/* ---------- Which entities accept which colours ---------- */

test("poles accept copper and circuit wires", () => {
  const p = visualFor("medium-electric-pole");
  assert.equal(canWire(p, "copper"), true);
  assert.equal(canWire(p, "red"), true);
  assert.equal(canWire(p, "green"), true);
});

test("a combinator accepts circuit wires but not copper", () => {
  const c = visualFor("arithmetic-combinator");
  assert.equal(canWire(c, "red"), true);
  assert.equal(canWire(c, "green"), true);
  assert.equal(canWire(c, "copper"), false, "copper is poles and power switches only");
});

test("a plain belt accepts no wires at all", () => {
  const belt = visualFor("transport-belt");
  for (const color of ["copper", "red", "green"] as const) {
    assert.equal(canWire(belt, color), false);
  }
});

test("an unknown entity accepts nothing rather than throwing", () => {
  assert.equal(canWire(undefined, "red"), false);
});

/* ---------- Erasing ---------- */

test("dropWiresFor removes every wire touching a removed entity", () => {
  const wires = [copper(1, 2), copper(2, 3), copper(3, 4)];
  const after = dropWiresFor(wires, new Set([2]));
  assert.equal(after.length, 1, "both wires touching entity 2 are dropped");
  assert.ok(wireExists(after, "copper", 3, 4));
});

test("dropWiresFor leaves an untouched network alone", () => {
  const wires = [copper(1, 2), copper(2, 3)];
  assert.equal(dropWiresFor(wires, new Set([99])).length, 2);
});

console.log(`\n${passed} passed`);
