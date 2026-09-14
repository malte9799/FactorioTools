import assert from "node:assert/strict";
import type { HeatConnectionPoint, PlacedEntity } from "@factoriotools/engine";
import { HeatNetwork } from "../src/neighbours/heat.js";

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

function entity(name: string, x: number, y: number, direction = 0, entityNumber = 1): PlacedEntity {
  return { entityNumber, name, x, y, direction, quality: "normal", modules: [], filterItems: [] };
}

/* ---------- HeatNetwork must round the SUM of entity position + local
 *  offset, not each independently ----------
 *
 * Regression coverage for a real, reported bug: a heat-exchanger's own
 * heat-network connection never registered as connected to an adjacent
 * heat-pipe, so its patch cap (heat-covers) never appeared — reported live
 * as "missing a patch in the back when a heat pipe is connected".
 *
 * The cause: HeatNetwork.add() computed each point's world position as
 * `Math.round(entity.x) + rotated.x` (rounding the entity's own position,
 * THEN adding the connection's local offset) rather than
 * `Math.round(entity.x + rotated.x)` (rounding the sum) — the same bug
 * class FluidNetwork's own doc comment already calls out and avoids.
 * heat-exchanger's 3x2 footprint means it's placed at a half-integer y
 * (confirmed against a real blueprint: (4.5, -26), with its own single
 * heat connection at local (0, 0.5) south) — exactly the case where the
 * two roundings diverge, silently landing the connection point half a
 * tile away from where an adjacent heat-pipe's own point actually
 * registers. Any half-tile entity position exercises the same bug; this
 * uses the real heat-exchanger numbers so a future refactor that
 * "simplifies" the rounding back to the wrong form fails exactly the case
 * that was reported. */

// heat-exchanger's own real connection: local (0, 0.5), facing south (8).
const HEAT_EXCHANGER_CONNECTION: HeatConnectionPoint = { x: 0, y: 0.5, direction: 8 };
// heat-pipe's own connection at a given facing sits at its own local
// (0, 0) — matching the real prototype (see sprite-shapes.ts's
// heatConnectionsOf), which declares one point per direction, all at the
// entity's own centre.
const HEAT_PIPE_NORTH: HeatConnectionPoint = { x: 0, y: 0, direction: 0 };

test("a heat-exchanger at a half-integer y connects to an adjacent heat-pipe", () => {
  const network = new HeatNetwork();
  // Real coordinates from an actual blueprint (confirmed by hand): a
  // heat-exchanger at (4.5, -26) with an adjacent heat-pipe at (4.5, -24.5).
  const exchanger = entity("heat-exchanger", 4.5, -26, 0, 1);
  const pipe = entity("heat-pipe", 4.5, -24.5, 0, 2);
  network.add(exchanger, [HEAT_EXCHANGER_CONNECTION]);
  network.add(pipe, [HEAT_PIPE_NORTH]);

  const [exchangerPoint] = network.pointsFor(1);
  assert.ok(exchangerPoint, "heat-exchanger should have registered its one connection point");
  assert.equal(network.isConnected(exchangerPoint!), true, "the heat-exchanger's point should register as connected to the adjacent heat-pipe");
});

test("moving the heat-pipe one tile further away leaves the heat-exchanger disconnected", () => {
  const network = new HeatNetwork();
  const exchanger = entity("heat-exchanger", 4.5, -26, 0, 1);
  const farPipe = entity("heat-pipe", 4.5, -23.5, 0, 2); // one tile further south than the connected case
  network.add(exchanger, [HEAT_EXCHANGER_CONNECTION]);
  network.add(farPipe, [HEAT_PIPE_NORTH]);

  const [exchangerPoint] = network.pointsFor(1);
  assert.equal(network.isConnected(exchangerPoint!), false, "a heat-pipe two tiles away must not read as connected");
});

test("the connection point's own offset survives independent of the entity's rounding", () => {
  const network = new HeatNetwork();
  const exchanger = entity("heat-exchanger", 4.5, -26, 0, 1);
  network.add(exchanger, [HEAT_EXCHANGER_CONNECTION]);
  const [point] = network.pointsFor(1);
  // offsetX/Y is the point's own local offset (0, 0.5), unrounded — used
  // by collect.ts to place patch/cover art without re-deriving it from the
  // (necessarily integer) world tile x/y.
  assert.equal(point!.offsetX, 0);
  assert.equal(point!.offsetY, 0.5);
  // The world tile itself is the ROUNDED SUM (4.5 + 0 = 4.5 -> 5 isn't
  // right either in isolation — this asserts the actual value the fixed
  // formula produces, so a regression to the old per-term rounding changes
  // this number and fails loudly).
  assert.equal(point!.x, Math.round(4.5 + 0));
  assert.equal(point!.y, Math.round(-26 + 0.5));
});

console.log(`\n${passed} passed`);
