/**
 * The circuit/power wire network: pole rotation, wire endpoint resolution
 * and reach.
 *
 * The rotation half is the part most worth pinning down. A pole has only 4
 * sprites but can be wired in any direction, so the game averages the
 * sectors its neighbours fall into — and the sector boundaries are offset by
 * 1.5 sectors so a facing covers the 90 degrees CENTRED on its direction
 * rather than starting at it. Getting that offset wrong leaves every pole
 * leaning an eighth-turn off true, which looks almost right and is easy to
 * ship by accident, so the cardinal cases are asserted explicitly.
 */
import assert from "node:assert/strict";
import type { PlacedEntity, WireLink } from "@factoriotools/engine";
import { normaliseWires, denormaliseWires, WireConnectorId } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, isPoleLike } from "../src/entityLookup.js";
import { buildWireNetwork, poleDirectionFor, resolveWires } from "../src/neighbours/wires.js";
import { sagFor } from "../src/draw/wireDraw.js";

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

const { gameData, catalog } = requireDataset("wires");
const lookup = buildVisualLookup(gameData, catalog);
const visualFor = (name: string) => lookup.get(name);

function pole(entityNumber: number, x: number, y: number, name = "medium-electric-pole"): PlacedEntity {
  return {
    entityNumber, name, x, y, direction: 0,
    quality: "normal", modules: [], filterItems: [],
  } as unknown as PlacedEntity;
}

/* ---------- Pole rotation ---------- */

test("an unwired pole faces north", () => {
  assert.equal(poleDirectionFor({ x: 0, y: 0 }, []), 0);
});

test("a pole's facing distinguishes the axis its wire runs along", () => {
  const centre = { x: 0, y: 0 };
  // World Y grows downward, so a neighbour at -y is NORTH of the centre.
  const north = poleDirectionFor(centre, [{ x: 0, y: -5 }]);
  const east = poleDirectionFor(centre, [{ x: 5, y: 0 }]);
  const south = poleDirectionFor(centre, [{ x: 0, y: 5 }]);
  const west = poleDirectionFor(centre, [{ x: -5, y: 0 }]);

  for (const d of [north, east, south, west]) {
    assert.ok([0, 4, 8, 12].includes(d), `facing ${d} is not a cardinal direction`);
  }

  // A pole has 4 sprites but they cover 8 sectors: the art is symmetric
  // under a half turn (a pole seen from the north looks like one seen from
  // the south), so opposite neighbours deliberately share a facing. This is
  // the reference editor's behaviour and the game's own — verified against
  // the dump, where a medium pole's four connection_points are identical.
  // What must NOT collapse is the two AXES.
  assert.equal(north, south, "a pole's art is symmetric under a half turn");
  assert.equal(east, west, "a pole's art is symmetric under a half turn");
  assert.notEqual(north, east, "a north-south wire must not look like an east-west one");
});

test("a facing covers the arc centred on its direction, not starting at it", () => {
  // This is what the 1.5-sector offset buys. A neighbour a little either
  // side of due north must still read as the SAME facing as due north; if
  // the offset were missing, one of these would tip into the next sector.
  const centre = { x: 0, y: 0 };
  const due = poleDirectionFor(centre, [{ x: 0, y: -5 }]);
  const slightlyEast = poleDirectionFor(centre, [{ x: 1.5, y: -5 }]);
  const slightlyWest = poleDirectionFor(centre, [{ x: -1.5, y: -5 }]);
  assert.equal(slightlyEast, due, "a neighbour just east of north must not change the facing");
  assert.equal(slightlyWest, due, "a neighbour just west of north must not change the facing");
});

test("a pole mid-run faces along the run, not across it", () => {
  const centre = { x: 0, y: 0 };
  // Wired to both sides of an east-west run.
  const midRun = poleDirectionFor(centre, [{ x: -5, y: 0 }, { x: 5, y: 0 }]);
  assert.equal(midRun, poleDirectionFor(centre, [{ x: 5, y: 0 }]),
    "a pole between two opposed neighbours faces along the run");
  assert.notEqual(midRun, poleDirectionFor(centre, [{ x: 0, y: -5 }]),
    "and not across it");
});

test("the facing is always one of the four the sprite sheet actually has", () => {
  // Poles ship 4 sprites; any other value would index past the sheet.
  for (let angle = 0; angle < 360; angle += 7) {
    const rad = (angle * Math.PI) / 180;
    const d = poleDirectionFor({ x: 0, y: 0 }, [{ x: Math.cos(rad) * 6, y: Math.sin(rad) * 6 }]);
    assert.ok([0, 4, 8, 12].includes(d), `angle ${angle} gave non-cardinal facing ${d}`);
  }
});

/* ---------- Network construction ---------- */

test("buildWireNetwork orients poles and leaves other entities alone", () => {
  const a = pole(1, 0.5, 0.5);
  const b = pole(2, 6.5, 0.5);
  const chest = { ...pole(3, 0.5, 6.5), name: "wooden-chest" } as PlacedEntity;
  const wires: WireLink[] = [{ color: "copper", from: 1, fromSide: 1, to: 2, toSide: 1 }];
  const net = buildWireNetwork(wires, [a, b, chest], isPoleLike);

  assert.equal(net.poleDirection.size, 2, "both poles get a facing");
  assert.ok(!net.poleDirection.has(3), "a non-pole never gets a wire-derived facing");
  // Both ends of one east-west run show the same (half-turn-symmetric) art.
  assert.equal(net.poleDirection.get(1), net.poleDirection.get(2));
  // And that art differs from an unwired pole's default north.
  assert.notEqual(net.poleDirection.get(1), 0);
});

test("a blueprint with no wires produces no facings and no work", () => {
  const net = buildWireNetwork([], [pole(1, 0, 0)], isPoleLike);
  assert.equal(net.wires.length, 0);
  assert.equal(net.poleDirection.size, 0);
});

/* ---------- Endpoint resolution and reach ---------- */

test("a wire resolves to points on the poles' sprites, not their centres", () => {
  const a = pole(1, 0.5, 0.5);
  const b = pole(2, 6.5, 0.5);
  const wires: WireLink[] = [{ color: "copper", from: 1, fromSide: 1, to: 2, toSide: 1 }];
  const net = buildWireNetwork(wires, [a, b], isPoleLike);
  const [resolved] = resolveWires(net, [a, b], visualFor, (e) => net.poleDirection.get(e.entityNumber) ?? e.direction);

  assert.ok(resolved, "the wire resolves");
  // A pole's copper terminal sits at the TOP of its sprite, well above the
  // entity's own centre — a wire drawn centre-to-centre would run through
  // the poles' bases instead of between their tips.
  assert.ok(resolved!.y1 < a.y - 1, `expected the terminal above the pole centre, got ${resolved!.y1} vs ${a.y}`);
  assert.ok(resolved!.y2 < b.y - 1);
  assert.equal(resolved!.color, "copper");
  assert.equal(resolved!.reaches, true);
});

test("a wire longer than the shorter pole's reach is marked as not reaching", () => {
  // Medium poles reach 9 tiles; put them 20 apart.
  const a = pole(1, 0, 0);
  const b = pole(2, 20, 0);
  const wires: WireLink[] = [{ color: "copper", from: 1, fromSide: 1, to: 2, toSide: 1 }];
  const net = buildWireNetwork(wires, [a, b], isPoleLike);
  const [resolved] = resolveWires(net, [a, b], visualFor, () => 0);
  assert.equal(resolved!.reaches, false);
});

test("reach uses the SHORTER of the two poles' limits", () => {
  // A big pole reaches 32, a small one only 7.5. 12 tiles apart is within
  // the big pole's reach but not the small one's, so the wire must not reach.
  const big = pole(1, 0, 0, "big-electric-pole");
  const small = pole(2, 12, 0, "small-electric-pole");
  const wires: WireLink[] = [{ color: "copper", from: 1, fromSide: 1, to: 2, toSide: 1 }];
  const net = buildWireNetwork(wires, [big, small], isPoleLike);
  const [resolved] = resolveWires(net, [big, small], visualFor, () => 0);
  assert.equal(resolved!.reaches, false, "the shorter reach must govern");
});

test("red and green wires attach at different points than copper", () => {
  const a = pole(1, 0.5, 0.5);
  const b = pole(2, 6.5, 0.5);
  const entities = [a, b];
  const at = (color: "copper" | "red" | "green") => {
    const wires: WireLink[] = [{ color, from: 1, fromSide: 1, to: 2, toSide: 1 }];
    const net = buildWireNetwork(wires, entities, isPoleLike);
    return resolveWires(net, entities, visualFor, () => 0)[0]!;
  };
  const copper = at("copper");
  const red = at("red");
  const green = at("green");
  // All three terminals are distinct posts on the pole's head.
  assert.notEqual(red.x1, copper.x1, "red must not share copper's terminal");
  assert.notEqual(green.x1, copper.x1, "green must not share copper's terminal");
  assert.notEqual(red.x1, green.x1, "red and green must be on opposite sides");
});

/* ---------- Blueprint round-trip ---------- */

test("normaliseWires decodes colours and drops wires to missing entities", () => {
  const bp = {
    item: "blueprint",
    entities: [
      { entity_number: 1, name: "medium-electric-pole", position: { x: 0, y: 0 } },
      { entity_number: 2, name: "medium-electric-pole", position: { x: 5, y: 0 } },
    ],
    wires: [
      [1, WireConnectorId.poleCopper, 2, WireConnectorId.poleCopper],
      [1, WireConnectorId.circuitRed, 2, WireConnectorId.circuitRed],
      [1, WireConnectorId.circuitGreen, 2, WireConnectorId.circuitGreen],
      // Names an entity the blueprint does not contain — must be dropped
      // rather than drawn to a phantom position.
      [1, WireConnectorId.poleCopper, 99, WireConnectorId.poleCopper],
      // Colour mismatch between the two ends — malformed, must be dropped.
      [1, WireConnectorId.circuitRed, 2, WireConnectorId.circuitGreen],
    ] as [number, number, number, number][],
  };
  const links = normaliseWires(bp);
  assert.equal(links.length, 3, "three well-formed wires survive");
  assert.deepEqual(links.map((l) => l.color).sort(), ["copper", "green", "red"]);
});

test("wires round-trip through denormaliseWires under entity renumbering", () => {
  // denormaliseEntities renumbers 1-based by array position, so a wire
  // written back out must be remapped or it would name the wrong entities.
  const entities = [pole(7, 0, 0), pole(3, 5, 0)];
  const links: WireLink[] = [{ color: "copper", from: 7, fromSide: 1, to: 3, toSide: 1 }];
  const encoded = denormaliseWires(links, entities);
  assert.deepEqual(encoded, [[1, WireConnectorId.poleCopper, 2, WireConnectorId.poleCopper]],
    "entity 7 is at index 0 so becomes 1; entity 3 is at index 1 so becomes 2");
});

test("a wire to an erased entity is dropped on the way out", () => {
  const entities = [pole(1, 0, 0)];
  const links: WireLink[] = [{ color: "copper", from: 1, fromSide: 1, to: 2, toSide: 1 }];
  assert.deepEqual(denormaliseWires(links, entities), []);
});

/* ---------- The real prototype data actually carries what this needs ---------- */

test("every vanilla pole has supply area, wire reach and 4 attach points", () => {
  const expected: Record<string, [number, number]> = {
    "small-electric-pole": [2.5, 7.5],
    "medium-electric-pole": [3.5, 9],
    "big-electric-pole": [2, 32],
    substation: [9, 18],
  };
  for (const [name, [supply, reach]] of Object.entries(expected)) {
    const v = lookup.get(name);
    assert.ok(v, `${name} is in the catalog`);
    assert.equal(v!.supplyAreaDistance, supply, `${name} supply area`);
    assert.equal(v!.maxWireDistance, reach, `${name} wire reach`);
    assert.equal(v!.wireConnections?.byDirection.length, 4, `${name} has one attach point per facing`);
    for (const point of v!.wireConnections!.byDirection) {
      assert.ok(point?.copper, `${name} declares a copper terminal for every facing`);
    }
  }
});

/* ---------- Wire sag ---------- */

test("sag keeps the reference editor's curve at half its depth", () => {
  // The reference computes, in pixels at 32px/tile:
  //   sin(atan2(dX, -dY)) * min(1, d / 32 / 3) * 30
  // This renderer keeps that SHAPE but halves the depth — the full arch read
  // as too heavy against these sprites. Asserting against half the reference
  // rather than against baked-in numbers keeps the two tied together: the
  // proportionality to horizontal span and the long-span clamp still have to
  // match, so a future change cannot quietly drift the curve's form.
  const SAG_SCALE = 0.5;
  const reference = (dxTiles: number, dyTiles: number): number => {
    const px = 32;
    const dX = dxTiles * px;
    const dY = dyTiles * px;
    const d = Math.hypot(dX, dY);
    if (d === 0) return 0;
    return (Math.sin(Math.atan2(dX, -dY)) * Math.min(1, d / 32 / 3) * 30) / px;
  };
  for (const [dx, dy] of [[7, 0], [0, 7], [20, 0], [7, 7], [3, 0], [1, 0], [0.5, 0]]) {
    const mine = sagFor(dx!, dy!);
    const want = Math.abs(reference(dx!, dy!)) * SAG_SCALE;
    assert.ok(Math.abs(mine - want) < 1e-9, `sag(${dx},${dy}) = ${mine}, expected ${want}`);
  }
});

test("a vertical wire does not sag, a horizontal one does", () => {
  assert.equal(sagFor(0, 9), 0, "a vertical cable seen end-on shows no droop");
  // 15/32 at full droop — the halved depth (see MAX_SAG_TILES).
  assert.ok(sagFor(9, 0) > 0.4, "a horizontal cable droops");
  // A diagonal sags less than a horizontal of the same length.
  assert.ok(sagFor(7, 7) < sagFor(Math.hypot(7, 7), 0));
});

test("sag is capped so a long span hangs like a power line", () => {
  // Past 3 tiles the droop stops growing; a 32-tile big-pole run must not
  // hang ten times deeper than a 4-tile one.
  assert.equal(sagFor(32, 0).toFixed(6), sagFor(4, 0).toFixed(6));
});

console.log(`\n${passed} passed`);
