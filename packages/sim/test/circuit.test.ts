import assert from "node:assert/strict";
import { decodeBlueprintString, normaliseEntities, normaliseWires, type BpControlBehavior, type PlacedEntity, type WireLink } from "@factoriotools/engine";
import { arithmetic, CircuitSim, signalKey, testCondition, type Signals } from "../src/circuit.js";

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

const item = (name: string) => ({ name });
const v = (name: string) => ({ type: "virtual", name });
const EACH = v("signal-each");
const ANY = v("signal-anything");
const ALL = v("signal-everything");

let next = 1;
function ent(name: string, controlBehavior?: BpControlBehavior, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entityNumber: next++, name, x: next, y: 0, direction: 0, quality: "normal", modules: [], filterItems: [], controlBehavior, ...extra };
}
const wire = (color: "red" | "green", a: PlacedEntity, aSide: 1 | 2, b: PlacedEntity, bSide: 1 | 2): WireLink => ({ color, from: a.entityNumber, fromSide: aSide, to: b.entityNumber, toSide: bSide });
const constant = (signals: [{ type?: string; name: string }, number][], on = true) =>
  ent("constant-combinator", { is_on: on ? undefined : false, sections: { sections: [{ index: 1, filters: signals.map(([s, count], i) => ({ index: i + 1, ...s, count })) }] } });
const sig = (entries: [string, number][]): Signals => new Map(entries.map(([n, x]) => [n.startsWith("signal-") ? `virtual:${n}` : `item:${n}`, x]));
const plain = (s: Signals | undefined) => Object.fromEntries([...(s ?? new Map())].map(([k, x]) => [k.replace(/^(item|virtual):/, ""), x]));

/** A constant combinator feeding one combinator's input on red; returns the
 *  combinator's output after the signal has had time to pass through. */
function run(inputs: [{ type?: string; name: string }, number][], combinator: PlacedEntity, steps = 3) {
  const cc = constant(inputs);
  const sim = new CircuitSim([cc, combinator], [wire("red", cc, 1, combinator, 1)]);
  for (let i = 0; i < steps; i++) sim.step();
  return plain(sim.combinatorOutput(combinator.entityNumber));
}

test("the decider clock blueprint counts up to 20 and starts over", () => {
  const clock = "0eNqNUv1qgzAQf5f7O5bqtGuFPUkRiXquB5q4JLaT4rvvErt1LTJGQEwu9/u6XKHqRhwMKQf5FajWykJ+vIKldyU7f6Zkj5BDgzU1aKJa9xUp6bSBWQCpBj8hj2ex0uLBnFRuvSeZCwGoHDnChTNsplKNfYWGQcVfQAIGbblXK8/IeOnLbpMJmCCP9ttNxkTc5ozuygpP8kzcwxct1r7HPv4z+bcTAS11Ds3z6U3KResGVVSf0DrW8DHKjjVzQWnTs3vP2g/SBI05vIWD0acbzwWv2Sf1ZDQRf4S84vPw4LIhs/jg0rrnG2rJtYZ+3P/esdOWjHXlfYZuGryiMxk3Bl83icuNCGV9giXjMBp2sfUD1aMbRvf8hv4FtvqGHvIOfMNUhkTL1ui+JMV0kLeysxjiZQ0XTsQrOMYiFomIC3FMhF9pwVVy2DPw/d0LOPO4Q4DZLjmkh0O2T3ev/JnnL6V9ELU=";
  const bp = decodeBlueprintString(clock).blueprint!;
  const sim = new CircuitSim(normaliseEntities(bp), normaliseWires(bp));
  // The decider's input and output share the green network: the loop.
  assert.equal(sim.network(2, "green", 1), sim.network(2, "green", 2));
  const seen: number[] = [];
  for (let i = 0; i < 30; i++) {
    sim.step();
    seen.push(sim.network(2, "green", 2)!.values.get("item:wooden-chest") ?? 0);
  }
  // Red always carries the constant 1; the decider adds its own output
  // back in each tick until the input reaches 20, then goes quiet once.
  assert.deepEqual(seen.slice(0, 13), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 0, 2]);
  assert.equal(Math.max(...seen), 20);
  assert.equal(sim.network(1, "red")!.values.get("item:wooden-chest"), 1);
});

test("a combinator takes one tick; a constant combinator switched off outputs nothing", () => {
  const cc = constant([[item("iron-plate"), 5]]);
  const ar = ent("arithmetic-combinator", { arithmetic_conditions: { first_signal: item("iron-plate"), second_constant: 2, operation: "*", output_signal: v("signal-A") } });
  const sim = new CircuitSim([cc, ar], [wire("red", cc, 1, ar, 1)]);
  sim.step();
  assert.deepEqual(plain(sim.combinatorOutput(ar.entityNumber)), {});
  sim.step();
  assert.deepEqual(plain(sim.combinatorOutput(ar.entityNumber)), { "signal-A": 10 });
  const off = constant([[item("iron-plate"), 5]], false);
  const s2 = new CircuitSim([off], []);
  s2.step();
  assert.deepEqual(plain(s2.combinatorOutput(off.entityNumber)), {});
});

test("red and green stay separate networks and add up at an input", () => {
  const a = constant([[item("coal"), 3]]);
  const b = constant([[item("coal"), 4]]);
  const lamp = ent("small-lamp", { circuit_enabled: true, circuit_condition: { first_signal: item("coal"), comparator: "=", constant: 7 } });
  const sim = new CircuitSim([a, b, lamp], [wire("red", a, 1, lamp, 1), wire("green", b, 1, lamp, 1)]);
  sim.step();
  assert.equal(sim.network(lamp.entityNumber, "red")!.values.get("item:coal"), 3);
  assert.equal(sim.network(lamp.entityNumber, "green")!.values.get("item:coal"), 4);
  assert.equal(sim.lamp(lamp.entityNumber).on, true);
});

test("arithmetic is 32-bit and never divides by zero", () => {
  assert.equal(arithmetic("*", 2 ** 30, 4), 0);
  assert.equal(arithmetic("+", 2 ** 31 - 1, 1), -(2 ** 31));
  assert.equal(arithmetic("/", 7, -2), -3);
  assert.equal(arithmetic("/", 7, 0), 0);
  assert.equal(arithmetic("%", -7, 3), -1);
  assert.equal(arithmetic("^", 3, 4), 81);
  assert.equal(arithmetic("^", 2, -1), 0);
  assert.equal(arithmetic("<<", 1, 4), 16);
  assert.equal(arithmetic(">>", -16, 2), -4);
  assert.equal(arithmetic("XOR", 6, 3), 5);
});

test("arithmetic Each: per signal, or summed onto one output", () => {
  const each = (output: { type?: string; name: string }) =>
    ent("arithmetic-combinator", { arithmetic_conditions: { first_signal: EACH, second_constant: 10, operation: "+", output_signal: output } });
  const inputs: [{ name: string }, number][] = [[item("iron-plate"), 1], [item("copper-plate"), 2]];
  assert.deepEqual(run(inputs, each(EACH)), { "iron-plate": 11, "copper-plate": 12 });
  assert.deepEqual(run(inputs, each(v("signal-T"))), { "signal-T": 23 });
  // Each on both sides is the signal against itself.
  const sq = ent("arithmetic-combinator", { arithmetic_conditions: { first_signal: EACH, second_signal: EACH, operation: "*", output_signal: EACH } });
  assert.deepEqual(run([[item("coal"), 3], [item("stone"), -4]], sq), { coal: 9, stone: 16 });
});

test("decider Everything is true on an empty input, Anything is false", () => {
  const dec = (first: { type?: string; name: string }) =>
    ent("decider-combinator", { decider_conditions: { conditions: [{ first_signal: first, comparator: ">", constant: 0 }], outputs: [{ signal: v("signal-check"), copy_count_from_input: false }] } });
  assert.deepEqual(run([], dec(ALL)), { "signal-check": 1 });
  assert.deepEqual(run([], dec(ANY)), {});
  assert.deepEqual(run([[item("coal"), 5], [item("stone"), -1]], dec(ALL)), {});
  assert.deepEqual(run([[item("coal"), 5], [item("stone"), -1]], dec(ANY)), { "signal-check": 1 });
});

test("decider Anything as output gives the signal that matched", () => {
  const d = ent("decider-combinator", { decider_conditions: { conditions: [{ first_signal: ANY, comparator: ">", constant: 4 }], outputs: [{ signal: ANY }] } });
  assert.deepEqual(run([[item("coal"), 2], [item("stone"), 7]], d), { stone: 7 });
});

test("decider Everything output passes the whole input, counts or ones", () => {
  const d = (copy: boolean) =>
    ent("decider-combinator", { decider_conditions: { conditions: [{ first_signal: item("coal"), comparator: "≥", constant: 1 }], outputs: [{ signal: ALL, copy_count_from_input: copy }] } });
  assert.deepEqual(run([[item("coal"), 2], [item("stone"), 7]], d(true)), { coal: 2, stone: 7 });
  assert.deepEqual(run([[item("coal"), 2], [item("stone"), 7]], d(false)), { coal: 1, stone: 1 });
});

test("decider Each filters signals, and a named output adds up what passed", () => {
  const d = ent("decider-combinator", {
    decider_conditions: {
      conditions: [{ first_signal: EACH, comparator: ">", constant: 3 }],
      outputs: [{ signal: EACH }, { signal: v("signal-S") }, { signal: v("signal-C"), copy_count_from_input: false }],
    },
  });
  assert.deepEqual(run([[item("coal"), 2], [item("stone"), 7], [item("wood"), 5]], d), { stone: 7, wood: 5, "signal-S": 12, "signal-C": 2 });
});

test("decider AND binds tighter than OR, and rows read only their own wires", () => {
  const red = constant([[v("signal-A"), 1]]);
  const green = constant([[v("signal-B"), 1]]);
  const d = ent("decider-combinator", {
    decider_conditions: {
      conditions: [
        // A = 1 (red only) AND B = 1 (red only: false) OR B = 1 (green only)
        { first_signal: v("signal-A"), comparator: "=", constant: 1, first_signal_networks: { green: false } },
        { first_signal: v("signal-B"), comparator: "=", constant: 1, first_signal_networks: { green: false }, compare_type: "and" },
        { first_signal: v("signal-B"), comparator: "=", constant: 1, first_signal_networks: { red: false }, compare_type: "or" },
      ],
      outputs: [{ signal: v("signal-check"), copy_count_from_input: false, constant: 5 }],
    },
  });
  const sim = new CircuitSim([red, green, d], [wire("red", red, 1, d, 1), wire("green", green, 1, d, 1)]);
  sim.step();
  sim.step();
  assert.deepEqual(plain(sim.combinatorOutput(d.entityNumber)), { "signal-check": 5 });
  // Without the OR row the AND group fails: B isn't on red.
  d.controlBehavior!.decider_conditions!.conditions!.pop();
  sim.step();
  assert.deepEqual(plain(sim.combinatorOutput(d.entityNumber)), {});
});

test("selector picks by rank, counts, and reports stack sizes", () => {
  const inputs: [{ name: string }, number][] = [[item("coal"), 2], [item("stone"), 7], [item("wood"), 5]];
  assert.deepEqual(run(inputs, ent("selector-combinator", { operation: "select", select_max: true, index_constant: 1 })), { wood: 5 });
  assert.deepEqual(run(inputs, ent("selector-combinator", { operation: "select", select_max: false })), { coal: 2 });
  assert.deepEqual(run(inputs, ent("selector-combinator", { operation: "count", count_signal: v("signal-N") })), { "signal-N": 3 });
  const cc = constant(inputs);
  const sel = ent("selector-combinator", { operation: "stack-size" });
  const sim = new CircuitSim([cc, sel], [wire("red", cc, 1, sel, 1)], { stackSizeOf: (n) => (n === "coal" ? 50 : 100) });
  sim.step();
  sim.step();
  assert.deepEqual(plain(sim.combinatorOutput(sel.entityNumber)), { coal: 50, stone: 100, wood: 100 });
});

test("plain conditions: wildcards, a second signal, and no signal set", () => {
  const input = sig([["coal", 5], ["stone", 9]]);
  assert.equal(testCondition({ first_signal: ALL, comparator: ">", constant: 4 }, input), true);
  assert.equal(testCondition({ first_signal: ALL, comparator: ">", constant: 5 }, input), false);
  assert.equal(testCondition({ first_signal: ALL, comparator: ">", constant: 5 }, new Map()), true);
  assert.equal(testCondition({ first_signal: ANY, comparator: "=", constant: 9 }, input), true);
  assert.equal(testCondition({ first_signal: ANY, comparator: "=", constant: 9 }, new Map()), false);
  assert.equal(testCondition({ first_signal: item("coal"), second_signal: item("stone"), comparator: "<" }, input), true);
  assert.equal(testCondition({ comparator: "<", constant: 1 }, input), false);
  assert.equal(signalKey({ name: "coal", quality: "rare" }), "item:coal@rare");
});

test("enable condition only applies while the entity is wired", () => {
  const cb: BpControlBehavior = { circuit_enabled: true, circuit_condition: { first_signal: item("coal"), comparator: ">", constant: 10 } };
  const loose = ent("inserter", cb);
  const wired = ent("inserter", cb);
  const cc = constant([[item("coal"), 20]]);
  const sim = new CircuitSim([loose, wired, cc], [wire("green", cc, 1, wired, 1)]);
  assert.equal(sim.enabled(loose.entityNumber), undefined);
  assert.equal(sim.enabled(wired.entityNumber), false);
  sim.step();
  assert.equal(sim.enabled(wired.entityNumber), true);
});

test("a building's output reaches the network on the next step", () => {
  const belt = ent("transport-belt");
  const lamp = ent("small-lamp", { circuit_condition: { first_signal: item("iron-plate"), comparator: ">", constant: 0 } });
  const sim = new CircuitSim([belt, lamp], [wire("red", belt, 1, lamp, 1)]);
  sim.setOutput(belt.entityNumber, sig([["iron-plate", 3]]));
  assert.equal(sim.lamp(lamp.entityNumber).on, false);
  sim.step();
  assert.equal(sim.lamp(lamp.entityNumber).on, true);
});

test("lamp colours: by signal, by components, and its own", () => {
  const cc = constant([[v("signal-blue"), 1], [v("signal-red"), 0]]);
  const lamp = ent("small-lamp", { use_colors: true });
  const comp = ent("small-lamp", { use_colors: true, color_mode: 1 });
  const cc2 = constant([[v("signal-red"), 255], [v("signal-green"), 128]]);
  const own = ent("small-lamp", undefined, { color: { r: 1, g: 0, b: 0 } });
  const sim = new CircuitSim([cc, lamp, comp, cc2, own], [wire("red", cc, 1, lamp, 1), wire("red", cc2, 1, comp, 1)]);
  sim.step();
  assert.deepEqual(sim.lamp(lamp.entityNumber), { on: true, color: "#3070ff" });
  assert.deepEqual(sim.lamp(comp.entityNumber), { on: true, color: "#ff8000" });
  assert.deepEqual(sim.lamp(own.entityNumber), { on: true, color: "#ff0000" });
});

test("display panel shows the first message whose condition holds", () => {
  const cc = constant([[v("signal-A"), 3]]);
  const panel = ent("display-panel", {
    parameters: [
      { icon: v("signal-deny"), text: "low", condition: { first_signal: v("signal-A"), comparator: "<", constant: 2 } },
      { icon: v("signal-check"), text: "ok", condition: { first_signal: v("signal-A"), comparator: "≥", constant: 2 } },
    ],
  });
  const sim = new CircuitSim([cc, panel], [wire("green", cc, 1, panel, 1)]);
  // Nothing on the wire yet: A is 0, which is below 2.
  assert.deepEqual(sim.display(panel.entityNumber), { icon: v("signal-deny"), text: "low" });
  sim.step();
  assert.deepEqual(sim.display(panel.entityNumber), { icon: v("signal-check"), text: "ok" });
});

test("a decider row lights on its own: named, Each, Everything", () => {
  const cc = constant([[item("coal"), 5], [item("stone"), 9]]);
  const d = ent("decider-combinator", { decider_conditions: { conditions: [], outputs: [] } });
  const sim = new CircuitSim([cc, d], [wire("red", cc, 1, d, 1)]);
  sim.step();
  const n = d.entityNumber;
  assert.equal(sim.rowHolds(n, { first_signal: item("coal"), comparator: "=", constant: 5 }), true);
  assert.equal(sim.rowHolds(n, { first_signal: item("coal"), comparator: "=", constant: 5, first_signal_networks: { red: false } }), false);
  assert.equal(sim.rowHolds(n, { first_signal: EACH, comparator: ">", constant: 8 }), true);
  assert.equal(sim.rowHolds(n, { first_signal: ALL, comparator: ">", constant: 8 }), false);
  assert.equal(sim.rowHolds(n, {}), false);
});

console.log(`\n${passed} passing`);
