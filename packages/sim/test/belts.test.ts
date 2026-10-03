import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBlueprintString, normaliseEntities, type BpSplitterSide, type PlacedEntity } from "@factoriotools/engine";
import { BeltSim, beltSpecResolver, buildBeltNetwork, lanePoint, CURVE_INNER_LENGTH, CURVE_OUTER_LENGTH, ITEM_SPACING, type BeltNetwork, type Lane } from "../src/index.js";

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

/* ---------- fixtures ---------- */

const N = 0, E = 4, S = 8, W = 12;
const YELLOW = "transport-belt";
let nextNumber = 1;

function belt(x: number, y: number, direction: number, name = YELLOW): PlacedEntity {
  return { entityNumber: nextNumber++, name, x: x + 0.5, y: y + 0.5, direction, quality: "normal", modules: [], filterItems: [] };
}
function row(x0: number, x1: number, y: number, direction: number, name = YELLOW): PlacedEntity[] {
  const out: PlacedEntity[] = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push(belt(x, y, direction, name));
  return out;
}
function col(x: number, y0: number, y1: number, direction: number, name = YELLOW): PlacedEntity[] {
  const out: PlacedEntity[] = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push(belt(x, y, direction, name));
  return out;
}
/** `travel` is the way items move; a 2.0 blueprint stores it on both ends. */
function underground(x: number, y: number, travel: number, type: "input" | "output", name = "underground-belt"): PlacedEntity {
  return { ...belt(x, y, travel, name), undergroundType: type };
}
/** An east-facing splitter whose left (north) half is at tile (x, y). */
function splitterEast(x: number, y: number, opts: { input?: BpSplitterSide; output?: BpSplitterSide; filter?: string } = {}): PlacedEntity {
  return {
    entityNumber: nextNumber++,
    name: "splitter",
    x: x + 0.5,
    y: y + 1,
    direction: E,
    quality: "normal",
    modules: [],
    filterItems: [],
    splitterInputPriority: opts.input,
    splitterOutputPriority: opts.output,
    splitterFilter: opts.filter,
  };
}

const resolve = beltSpecResolver();
function sim(entities: PlacedEntity[]) {
  const net = buildBeltNetwork(entities, resolve);
  return { net, sim: new BeltSim(net) };
}
const inputAt = (net: BeltNetwork, x: number, y: number) => net.ports.find((p) => p.kind === "input" && p.x === x && p.y === y)!.id;
const outputAt = (net: BeltNetwork, x: number, y: number) => net.ports.find((p) => p.kind === "output" && p.x === x && p.y === y)!.id;
const lineAt = (net: BeltNetwork, x: number, y: number) => net.nodeAt(x, y)!.line!;
const FULL = (item = "iron-plate") => ({ item, rate: "full" as const });

/** Warm up, then measure over a whole number of seconds. */
function measure(s: BeltSim, warm = 600, window = 3600) {
  s.step(warm);
  s.resetCounters();
  s.step(window);
}
/** The rate through the tile at (x, y) on one lane. */
function tileRate(s: BeltSim, net: BeltNetwork, x: number, y: number, lane: Lane): number {
  const node = net.nodeAt(x, y)!;
  const line = node.line!;
  const k = line.lanes[lane].segments.findIndex((seg) => seg.node === node && seg.kind !== "tunnel");
  return s.laneRates(line, lane)[k]!;
}
const near = (actual: number, expected: number, tol = 0.02) =>
  assert.ok(Math.abs(actual - expected) <= Math.max(tol * expected, 0.02), `expected ≈${expected}, got ${actual}`);

/** No lane ever holds two items closer than the spacing, or items outside
 *  the lane. */
function assertInvariants(s: BeltSim, net: BeltNetwork) {
  for (const line of net.lines) {
    for (const lane of [0, 1] as const) {
      const items = s.laneItems(line, lane);
      for (let i = 0; i < items.length; i++) {
        const p = items[i]!.pos;
        assert.ok(p >= 0 && p <= line.lanes[lane].length, `line ${line.id} lane ${lane}: item at ${p} outside 0..${line.lanes[lane].length}`);
        if (i > 0) assert.ok(items[i - 1]!.pos - p >= ITEM_SPACING, `line ${line.id} lane ${lane}: gap ${items[i - 1]!.pos - p} at ${p}`);
      }
    }
  }
}

/* ---------- straight belts ---------- */

for (const [name, perLane] of [["transport-belt", 7.5], ["fast-transport-belt", 15], ["express-transport-belt", 22.5], ["turbo-transport-belt", 30]] as const) {
  test(`${name}: a straight run carries exactly ${perLane}/s per lane`, () => {
    const { net, sim: s } = sim(row(0, 9, 0, E, name));
    assert.equal(net.lines.length, 1);
    assert.equal(net.ports.length, 2);
    s.setInput(inputAt(net, 0, 0), FULL(), FULL("copper-plate"));
    measure(s);
    near(s.portRate(outputAt(net, 9, 0)), perLane * 2);
    near(tileRate(s, net, 5, 0, 0), perLane);
    near(tileRate(s, net, 5, 0, 1), perLane);
    assertInvariants(s, net);
  });
}

test("a blocked end backs the belt up to exactly four items per lane per tile", () => {
  const { net, sim: s } = sim(row(0, 4, 0, E));
  s.setInput(inputAt(net, 0, 0), FULL(), FULL());
  s.setOutput(outputAt(net, 4, 0), "blocked");
  measure(s, 1200, 600);
  assert.equal(s.portRate(inputAt(net, 0, 0)), 0);
  assert.equal(s.laneItems(net.lines[0]!, 0).length, 20);
  assert.equal(s.laneItems(net.lines[0]!, 1).length, 20);
  assertInvariants(s, net);
});

test("a rate-limited input and a rate-limited output are honoured", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  s.setInput(inputAt(net, 0, 0), { item: "iron-plate", rate: 5 }, null);
  measure(s);
  near(s.portRate(outputAt(net, 5, 0)), 5);

  const b = sim(row(0, 5, 0, E));
  b.sim.setInput(inputAt(b.net, 0, 0), FULL(), FULL());
  b.sim.setOutput(outputAt(b.net, 5, 0), { rate: 4 });
  measure(b.sim);
  near(b.sim.portRate(outputAt(b.net, 5, 0)), 4);
  assertInvariants(b.sim, b.net);
});

test("a slower belt feeding a faster one is two lines, limited by the slower", () => {
  const { net, sim: s } = sim([...row(0, 3, 0, E), ...row(4, 7, 0, E, "fast-transport-belt")]);
  assert.equal(net.lines.length, 2);
  assert.equal(net.ports.length, 2);
  s.setInput(inputAt(net, 0, 0), FULL(), FULL());
  measure(s);
  near(s.portRate(outputAt(net, 7, 0)), 15);
  assertInvariants(s, net);
});

test("belts facing each other head-on don't connect", () => {
  const { net } = sim([belt(0, 0, E), belt(1, 0, W)]);
  assert.equal(net.lines.length, 2);
  assert.equal(net.ports.filter((p) => p.kind === "output").length, 2);
});

/* ---------- curves ---------- */

test("one side input and no rear input makes a curve that keeps both lanes and full throughput", () => {
  // East along y=5, turning north at x=5.
  const { net, sim: s } = sim([...row(0, 4, 5, E), ...col(5, 0, 5, N)]);
  assert.equal(net.lines.length, 1, "the curve continues the same line");
  const curve = net.nodeAt(5, 5)!;
  assert.ok(curve.curveFrom);
  s.setInput(inputAt(net, 0, 5), FULL(), null);
  measure(s);
  near(s.portRate(outputAt(net, 5, 0)), 7.5);
  near(tileRate(s, net, 5, 2, 0), 7.5);
  assert.equal(tileRate(s, net, 5, 2, 1), 0, "the left lane stays the left lane through a curve");
  assertInvariants(s, net);
});

test("a left turn's inner lane is the left lane, and it is shorter than the outer lane", () => {
  const { net } = sim([...row(0, 4, 5, E), ...col(5, 0, 5, N)]);
  const line = net.lines[0]!;
  const segOf = (lane: Lane) => line.lanes[lane].segments.find((seg) => seg.kind === "curve")!;
  assert.equal(segOf(0).length, CURVE_INNER_LENGTH);
  assert.equal(segOf(1).length, CURVE_OUTER_LENGTH);
  // The lane geometry stays inside the curve's own tile.
  for (const lane of [0, 1] as const) {
    const seg = segOf(lane);
    for (let t = 0; t <= 1; t += 0.125) {
      const p = lanePoint(line.lanes[lane], seg.start + t * seg.length);
      assert.ok(p.x >= 5 && p.x <= 6 && p.y >= 5 && p.y <= 6, `lane ${lane} leaves the tile at ${JSON.stringify(p)}`);
    }
  }
});

test("a backed-up curve holds fewer items on its inner lane than its outer lane", () => {
  const { net, sim: s } = sim([...row(0, 4, 5, E), ...col(5, 0, 5, N)]);
  s.setInput(inputAt(net, 0, 5), FULL(), FULL());
  s.setOutput(outputAt(net, 5, 0), "blocked");
  s.step(3000);
  const line = net.lines[0]!;
  const onCurve = (lane: Lane) => {
    const seg = line.lanes[lane].segments.find((x) => x.kind === "curve")!;
    return s.laneItems(line, lane).filter((i) => i.pos >= seg.start && i.pos < seg.start + seg.length).length;
  };
  assert.ok(onCurve(0) < onCurve(1), `inner ${onCurve(0)} vs outer ${onCurve(1)}`);
  assertInvariants(s, net);
});

/* ---------- side-loading ---------- */

test("side-loading puts both feeder lanes onto the near lane only", () => {
  // Main belt east along y=0; feeder comes down from the north at x=5.
  const { net, sim: s } = sim([...row(0, 9, 0, E), ...col(5, -4, -1, S)]);
  assert.equal(net.nodeAt(5, 0)!.curveFrom, undefined, "a belt with a rear input doesn't curve");
  s.setInput(inputAt(net, 5, -4), FULL(), FULL("copper-plate"));
  measure(s);
  near(s.portRate(outputAt(net, 9, 0)), 7.5);
  near(tileRate(s, net, 8, 0, 0), 7.5, 0.03);
  assert.equal(tileRate(s, net, 8, 0, 1), 0);
  near(s.portRate(inputAt(net, 5, -4)), 7.5, 0.03);
  assertInvariants(s, net);
});

test("side-loading has priority over items coming straight through", () => {
  const { net, sim: s } = sim([...row(0, 9, 0, E), ...col(5, -4, -1, S)]);
  s.setInput(inputAt(net, 0, 0), FULL(), FULL());
  s.setInput(inputAt(net, 5, -4), FULL("copper-plate"), FULL("copper-plate"));
  measure(s);
  near(tileRate(s, net, 8, 0, 0), 7.5, 0.03);
  near(tileRate(s, net, 8, 0, 1), 7.5);
  assert.ok(tileRate(s, net, 2, 0, 0) < 0.05, `the straight-through left lane should stall, got ${tileRate(s, net, 2, 0, 0)}`);
  const front = s.laneItems(lineAt(net, 8, 0), 0).filter((i) => i.pos > 6 * 256);
  assert.ok(front.length > 0 && front.every((i) => i.item === "copper-plate"));
  assertInvariants(s, net);
});

test("two side-loads from opposite sides fill both lanes", () => {
  const { net, sim: s } = sim([...col(5, -4, -1, S), ...col(5, 1, 4, N), belt(5, 0, E), ...row(6, 9, 0, E)]);
  s.setInput(inputAt(net, 5, -4), FULL(), FULL());
  s.setInput(inputAt(net, 5, 4), FULL(), FULL());
  measure(s);
  near(s.portRate(outputAt(net, 9, 0)), 15, 0.03);
  assertInvariants(s, net);
});

/* ---------- undergrounds ---------- */

test("an underground pair carries full throughput and hides items in the tunnel", () => {
  const { net, sim: s } = sim([...row(0, 1, 0, E), underground(2, 0, E, "input"), underground(6, 0, E, "output"), ...row(7, 9, 0, E)]);
  assert.equal(net.nodeAt(2, 0)!.pair, net.nodeAt(6, 0));
  assert.equal(net.lines.length, 1);
  s.setInput(inputAt(net, 0, 0), FULL(), FULL());
  measure(s);
  near(s.portRate(outputAt(net, 9, 0)), 15);
  let hidden = 0;
  s.forEachItem((x, _y, _item, h) => {
    if (h) {
      hidden++;
      assert.ok(x > 2.5 && x < 6.5, `hidden item outside the tunnel at x=${x}`);
    }
  });
  assert.ok(hidden > 0);
  assertInvariants(s, net);
});

test("an exit beyond the tier's max distance doesn't pair", () => {
  const { net } = sim([underground(0, 0, E, "input"), underground(6, 0, E, "output")]);
  assert.equal(net.nodeAt(0, 0)!.pair, undefined);
  assert.ok(net.ports.some((p) => p.kind === "output" && p.x === 0), "the entrance becomes a dead end");
  const fast = sim([underground(0, 0, E, "input", "fast-underground-belt"), underground(6, 0, E, "output", "fast-underground-belt")]);
  assert.equal(fast.net.nodeAt(0, 0)!.pair, fast.net.nodeAt(6, 0));
});

test("an entrance pairs with the nearest exit, and different tiers weave past each other", () => {
  const { net } = sim([
    underground(0, 0, E, "input"),
    underground(1, 0, E, "input", "fast-underground-belt"),
    underground(3, 0, E, "output"),
    underground(4, 0, E, "output"),
    underground(5, 0, E, "output", "fast-underground-belt"),
  ]);
  assert.equal(net.nodeAt(0, 0)!.pair, net.nodeAt(3, 0));
  assert.equal(net.nodeAt(1, 0)!.pair, net.nodeAt(5, 0));
  assert.equal(net.nodeAt(4, 0)!.pair, undefined);
});

test("side-loading an underground entrance only lets one feeder lane through (lane filter)", () => {
  // Entrance at (5,0) travelling east; feeder comes down from the north.
  const { net, sim: s } = sim([underground(5, 0, E, "input"), underground(8, 0, E, "output"), ...row(9, 10, 0, E), ...col(5, -4, -1, S)]);
  s.setInput(inputAt(net, 5, -4), FULL(), FULL("copper-plate"));
  measure(s);
  // Feeder travels south: its right lane is on the west side, the
  // entrance's open back half.
  const feeder = lineAt(net, 5, -2);
  near(s.laneRates(feeder, 1)[0]!, 7.5);
  assert.equal(s.laneRates(feeder, 0)[3]!, 0);
  near(tileRate(s, net, 10, 0, 0), 7.5);
  assert.equal(tileRate(s, net, 10, 0, 1), 0);
  assert.ok(s.laneItems(lineAt(net, 10, 0), 0).every((i) => i.item === "copper-plate"));
  assertInvariants(s, net);
});

test("side-loading an underground exit takes the feeder lane on its open front half", () => {
  const { net, sim: s } = sim([underground(2, 0, E, "input"), underground(5, 0, E, "output"), ...row(6, 8, 0, E), ...col(5, -4, -1, S)]);
  s.setInput(inputAt(net, 5, -4), FULL(), FULL("copper-plate"));
  measure(s);
  near(tileRate(s, net, 8, 0, 0), 7.5);
  assert.ok(s.laneItems(lineAt(net, 8, 0), 0).every((i) => i.item === "iron-plate"), "the feeder's left lane is on the east, open side");
  assertInvariants(s, net);
});

/* ---------- splitters ---------- */

function splitterRig(opts: Parameters<typeof splitterEast>[2] = {}) {
  // Input belt along y=0 into a splitter at x=3 (halves y=0 and y=1),
  // outputs along y=0 and y=1.
  const r = sim([...row(0, 2, 0, E), splitterEast(3, 0, opts), ...row(4, 6, 0, E), ...row(4, 6, 1, E)]);
  return { ...r, input: inputAt(r.net, 0, 0), top: outputAt(r.net, 6, 0), bottom: outputAt(r.net, 6, 1) };
}

test("a splitter halves one full belt across both outputs", () => {
  const { net, sim: s, input, top, bottom } = splitterRig();
  assert.equal(net.splitters.length, 1);
  assert.ok(net.ports.some((p) => p.kind === "input" && p.x === 2 && p.y === 1), "the unfed half gets its own input port");
  s.setInput(input, FULL(), FULL("copper-plate"));
  measure(s);
  near(s.portRate(top), 7.5);
  near(s.portRate(bottom), 7.5);
  near(tileRate(s, net, 5, 1, 0), 3.75);
  near(tileRate(s, net, 5, 1, 1), 3.75);
  assertInvariants(s, net);
});

test("a splitter never moves items between lanes", () => {
  const { net, sim: s, input } = splitterRig();
  s.setInput(input, FULL(), null);
  measure(s);
  assert.equal(tileRate(s, net, 5, 0, 1), 0);
  assert.equal(tileRate(s, net, 5, 1, 1), 0);
  near(tileRate(s, net, 5, 0, 0) + tileRate(s, net, 5, 1, 0), 7.5);
});

test("output priority sends everything to one side until it backs up", () => {
  const a = splitterRig({ output: "left" });
  a.sim.setInput(a.input, FULL(), FULL());
  measure(a.sim);
  near(a.sim.portRate(a.top), 15);
  assert.equal(a.sim.portRate(a.bottom), 0);

  const b = splitterRig({ output: "left" });
  b.sim.setInput(b.input, FULL(), FULL());
  b.sim.setOutput(b.top, { rate: 5 });
  measure(b.sim);
  near(b.sim.portRate(b.top), 5);
  near(b.sim.portRate(b.bottom), 10);
  assertInvariants(b.sim, b.net);
});

test("a filter sends its item to the priority side and everything else to the other", () => {
  const { net, sim: s, input, top, bottom } = splitterRig({ output: "right", filter: "iron-plate" });
  s.setInput(input, FULL("iron-plate"), FULL("copper-plate"));
  measure(s);
  near(s.portRate(top), 7.5);
  near(s.portRate(bottom), 7.5);
  assert.ok(s.laneItems(lineAt(net, 5, 1), 0).every((i) => i.item === "iron-plate"));
  assert.ok(s.laneItems(lineAt(net, 5, 0), 1).every((i) => i.item === "copper-plate"));
  assert.equal(s.laneItems(lineAt(net, 5, 0), 0).length, 0);
});

test("with one output blocked, input priority decides which input belt drains", () => {
  const rig = (input?: BpSplitterSide) => {
    const r = sim([...row(0, 2, 0, E), ...row(0, 2, 1, E), splitterEast(3, 0, { input }), ...row(4, 6, 0, E), ...row(4, 6, 1, E)]);
    const top = inputAt(r.net, 0, 0);
    const bottom = inputAt(r.net, 0, 1);
    r.sim.setInput(top, FULL(), FULL());
    r.sim.setInput(bottom, FULL(), FULL());
    r.sim.setOutput(outputAt(r.net, 6, 1), "blocked");
    measure(r.sim);
    return [r.sim.portRate(top), r.sim.portRate(bottom)] as const;
  };
  const [pt, pb] = rig("left");
  near(pt, 15);
  assert.ok(pb < 0.05, `the other input should stall, got ${pb}`);
  const [ft, fb] = rig();
  near(ft, 7.5, 0.03);
  near(fb, 7.5, 0.03);
});

test("two full belts through a splitter stay two full belts", () => {
  const r = sim([...row(0, 2, 0, E), ...row(0, 2, 1, E), splitterEast(3, 0), ...row(4, 6, 0, E), ...row(4, 6, 1, E)]);
  r.sim.setInput(inputAt(r.net, 0, 0), FULL(), FULL());
  r.sim.setInput(inputAt(r.net, 0, 1), FULL(), FULL());
  measure(r.sim);
  near(r.sim.portRate(outputAt(r.net, 6, 0)), 15);
  near(r.sim.portRate(outputAt(r.net, 6, 1)), 15);
  assertInvariants(r.sim, r.net);
});

/* ---------- loops ---------- */

test("a closed loop keeps every item and keeps moving", () => {
  // A 4x4 ring (clockwise) with a feeder side-loading onto its top edge.
  const ring = [...row(0, 3, 0, E), ...col(4, 0, 3, S), ...row(1, 4, 4, W), ...col(0, 1, 4, N)];
  const { net, sim: s } = sim([...ring, ...col(2, -3, -1, S)]);
  assert.ok(net.lines.some((l) => l.start.kind === "line" && l.start.from === l), "the ring is one self-feeding line");
  assert.equal(net.ports.filter((p) => p.kind === "output").length, 0);
  s.setInput(inputAt(net, 2, -3), { item: "iron-plate", rate: 3 }, null);
  s.step(600);
  s.setInput(inputAt(net, 2, -3), null, null);
  s.step(600);
  let before = 0;
  s.forEachItem(() => before++);
  s.resetCounters();
  s.step(1200);
  let after = 0;
  s.forEachItem(() => after++);
  assert.equal(after, before);
  const ringLine = net.nodeAt(0, 0)!.line!;
  assert.ok(s.laneRates(ringLine, 0).some((r) => r > 0), "items keep circulating");
  assertInvariants(s, net);
});

/* ---------- inserter hooks ---------- */

test("taking from a belt tile removes the front-most accepted item on that tile only", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  s.setInput(inputAt(net, 0, 0), FULL(), FULL("copper-plate"));
  s.setOutput(outputAt(net, 5, 0), "blocked");
  s.step(600);
  const tile = net.nodeAt(3, 0)!;
  const before = s.tileLoad(tile, 1).count;
  assert.deepEqual(s.takeFromTile(tile, (i) => i === "copper-plate"), { item: "copper-plate", count: 1 });
  assert.equal(s.tileLoad(tile, 1).count, before - 1);
  assert.equal(s.tileLoad(tile, 0).count, 4, "the iron lane is untouched");
  assert.equal(s.takeFromTile(tile, (i) => i === "stone"), undefined);
});

test("dropping on a belt tile needs a gap, and the item then travels on", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  const tile = net.nodeAt(2, 0)!;
  assert.equal(s.dropOnTile(tile, 1, "iron-gear-wheel"), true);
  assert.equal(s.dropOnTile(tile, 1, "iron-gear-wheel"), false, "no room right on top of the first");
  s.resetCounters();
  s.step(300);
  assert.equal(s.portRate(outputAt(net, 5, 0)) * 300 / 60, 1);
});

test("a spread drop also fits one item just upstream of the middle, then waits for the belt", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  const tile = net.nodeAt(2, 0)!;
  for (let k = 0; k < 2; k++) assert.equal(s.dropOnTile(tile, 1, "iron-gear-wheel", 1, true), true);
  assert.equal(s.dropOnTile(tile, 1, "iron-gear-wheel", 1, true), false, "the next spot is out of the hand's reach");
  assert.equal(s.tileLoad(tile, 1).count, 2);
  s.step(16);
  assert.equal(s.dropOnTile(tile, 1, "iron-gear-wheel", 1, true), true, "once the belt moves on there's room again");
});

/* ---------- belt stacking ---------- */

test("stacked turbo belts carry four times as many items (240/s)", () => {
  const { net, sim: s } = sim(row(0, 9, 0, E, "turbo-transport-belt"));
  s.setInput(inputAt(net, 0, 0), { item: "iron-plate", rate: "full", stack: 4 }, { item: "copper-plate", rate: "full", stack: 4 });
  measure(s);
  near(s.portRate(outputAt(net, 9, 0)), 240);
  near(tileRate(s, net, 5, 0, 0), 120);
  assert.ok(s.laneItems(net.lines[0]!, 0).every((i) => i.count === 4));
  assertInvariants(s, net);
});

test("stacks stay whole through splitters, side-loads and undergrounds", () => {
  const { net, sim: s } = sim([
    ...row(0, 2, 0, E),
    splitterEast(3, 0),
    ...row(4, 6, 0, E),
    underground(7, 0, E, "input"),
    underground(10, 0, E, "output"),
    ...row(11, 13, 0, E),
    ...row(4, 7, 1, E),
    ...col(8, 1, 2, S),
    ...row(7, 12, 3, E),
  ]);
  s.setInput(inputAt(net, 0, 0), { item: "iron-plate", rate: "full", stack: 3 }, { item: "copper-plate", rate: "full", stack: 3 });
  measure(s);
  near(s.portRate(inputAt(net, 0, 0)), 45);
  for (const line of net.lines) for (const lane of [0, 1] as const) assert.ok(s.laneItems(line, lane).every((i) => i.count === 3));
  assertInvariants(s, net);
});

test("a rate-limited stacked input counts items, not slots", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  s.setInput(inputAt(net, 0, 0), { item: "iron-plate", rate: 8, stack: 4 }, null);
  measure(s);
  near(s.portRate(outputAt(net, 5, 0)), 8);
});

test("a rate-limited output counts items, not slots", () => {
  const { net, sim: s } = sim(row(0, 5, 0, E));
  s.setInput(inputAt(net, 0, 0), { item: "iron-plate", rate: "full", stack: 4 }, { item: "iron-plate", rate: "full", stack: 4 });
  s.setOutput(outputAt(net, 5, 0), { rate: 6 });
  measure(s);
  near(s.portRate(outputAt(net, 5, 0)), 6);
  assertInvariants(s, net);
});

test("per-item port totals balance: in = out + still on the belt", () => {
  const { net, sim: s } = sim(row(0, 7, 0, E));
  const inId = inputAt(net, 0, 0);
  const outId = outputAt(net, 7, 0);
  s.setInput(inId, FULL("iron-plate"), { item: "copper-plate", rate: 3 });
  s.step(1200);
  const line = lineAt(net, 0, 0);
  const onBelt = new Map<string, number>();
  for (const lane of [0, 1] as const) for (const it of s.laneItems(line, lane)) onBelt.set(it.item, (onBelt.get(it.item) ?? 0) + it.count);
  const ins = s.portTotals(inId);
  const outs = s.portTotals(outId);
  for (const item of ["iron-plate", "copper-plate"]) {
    assert.ok((outs.get(item) ?? 0) > 0, `${item} reached the end`);
    assert.equal(ins.get(item), (outs.get(item) ?? 0) + (onBelt.get(item) ?? 0), item);
  }
});

test("an inserter-style pickup splits a stack and a drop places one", () => {
  const { net, sim: s } = sim(row(0, 3, 0, E, "turbo-transport-belt"));
  const tile = net.nodeAt(1, 0)!;
  assert.equal(s.dropOnTile(tile, 0, "iron-plate", 4), true);
  assert.deepEqual(s.tileLoad(tile, 0), { count: 1, capacity: 4, items: 4 });
  assert.deepEqual(s.takeFromTile(tile, () => true, 3), { item: "iron-plate", count: 3 });
  assert.deepEqual(s.tileLoad(tile, 0), { count: 1, capacity: 4, items: 1 });
  assert.equal(s.dropOnTile(tile, 1, "copper-plate", 9), true);
  assert.equal(s.laneItems(net.lines[0]!, 1)[0]!.count, 4, "a slot never holds more than four");
});

/* ---------- real blueprints ---------- */

test("every example blueprint builds a network and simulates without breaking an invariant", () => {
  const path = fileURLToPath(new URL("../../../apps/site/public/data/example-blueprints.json", import.meta.url));
  const examples = JSON.parse(readFileSync(path, "utf8")) as { label: string; bp: string }[];
  let withBelts = 0;
  for (const ex of examples) {
    const envelope = decodeBlueprintString(ex.bp);
    if (!envelope.blueprint) continue;
    const entities = normaliseEntities(envelope.blueprint);
    const net = buildBeltNetwork(entities, resolve);
    if (!net.nodes.length) continue;
    withBelts++;
    const s = new BeltSim(net);
    for (const p of net.ports) if (p.kind === "input") s.setInput(p.id, FULL(), FULL("copper-plate"));
    s.step(300);
    try {
      assertInvariants(s, net);
    } catch (e) {
      throw new Error(`${ex.label}: ${(e as Error).message}`);
    }
  }
  assert.ok(withBelts > 10, `only ${withBelts} examples had belts`);
});

console.log(`\n${passed} passing`);
