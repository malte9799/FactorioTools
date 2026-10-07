import assert from "node:assert/strict";
import { stockOrientation, type PlacedEntity } from "@factoriotools/engine";
import { entitiesCollide } from "../src/collision.js";
import { railEndsAt, type RailEnd, type RailPiece } from "../src/railGeometry.js";
import { buildRailIndex, rollingStockSnap, stockBogie, stockLayer, type RailIndex } from "../src/railPlacement.js";
import { planRail } from "../src/railPlanner.js";

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

let nextId = 1;
const at = (name: string, x: number, y: number, direction = 0, orientation?: number): PlacedEntity => ({
  entityNumber: nextId++,
  name,
  x,
  y,
  direction,
  orientation,
  quality: "normal",
  modules: [],
  filterItems: [],
});

const STOCK: Record<string, { width: number; length: number }> = {
  locomotive: { width: 1.2, length: 5.2 },
  "cargo-wagon": { width: 1.2, length: 4.8 },
};
const footprint = (e: PlacedEntity): [number, number] => (STOCK[e.name] ? [STOCK[e.name]!.width, STOCK[e.name]!.length] : [1, 1]);
const index = (entities: PlacedEntity[]) => buildRailIndex(entities, footprint, (name) => STOCK[name]);

// Straight track running north from y=2 to y=-30, a joint every 2 tiles.
const line: RailPiece[] = Array.from({ length: 16 }, (_, i) => ({ name: "straight-rail", x: 1, y: 1 - 2 * i, direction: 0 }));
const rails = (pieces: RailPiece[]) => pieces.map((p) => at(p.name, p.x, p.y, p.direction));

/** A signal on the slot at joint (x, y) facing `dir`: it stops trains
 *  heading the opposite way. */
function signalAt(track: RailIndex, name: string, x: number, y: number, dir: number): PlacedEntity {
  const slot = track.signalSlots.find((s) => s.ex === x && s.ey === y && s.direction === dir);
  assert.ok(slot, `no signal slot at ${x},${y} facing ${dir}`);
  return at(name, slot.x, slot.y, slot.direction);
}

const bare = index(rails(line));

test("a signal over empty track is green", () => {
  const signal = signalAt(bare, "rail-signal", 1, -10, 8);
  assert.equal(index([...rails(line), signal]).signalStates().get(signal.entityNumber), "green");
});

test("a train in the block behind a signal turns it red; one in front of it doesn't", () => {
  const signal = signalAt(bare, "rail-signal", 1, -10, 8);
  // Northbound trains pass the signal into the track north of y=-10.
  const beyond = index([...rails(line), signal, at("locomotive", 1, -20, 0, 0)]);
  assert.equal(beyond.signalStates().get(signal.entityNumber), "red");
  assert.equal(beyond.occupied().size, 1);
  const before = index([...rails(line), signal, at("locomotive", 1, -4, 0, 0)]);
  assert.equal(before.signalStates().get(signal.entityNumber), "green");
});

test("a train standing across a signal occupies both blocks", () => {
  const north = signalAt(bare, "rail-signal", 1, -10, 8);
  const south = signalAt(bare, "rail-signal", 1, -10, 0);
  const track = index([...rails(line), north, south, at("cargo-wagon", 1, -10, 0, 0)]);
  assert.equal(track.occupied().size, 2);
  assert.equal(track.signalStates().get(north.entityNumber), "red");
  assert.equal(track.signalStates().get(south.entityNumber), "red");
});

test("only the block a train is in closes: the signal two blocks back stays green", () => {
  const first = signalAt(bare, "rail-signal", 1, -6, 8);
  const second = signalAt(bare, "rail-signal", 1, -16, 8);
  const track = index([...rails(line), first, second, at("locomotive", 1, -24, 0, 0)]);
  assert.equal(track.signalStates().get(second.entityNumber), "red");
  assert.equal(track.signalStates().get(first.entityNumber), "green");
});

test("a train beside the track, or facing across it on other rails, occupies nothing here", () => {
  const signal = signalAt(bare, "rail-signal", 1, -10, 8);
  const track = index([...rails(line), signal, at("locomotive", 5, -20, 0, 0)]);
  assert.equal(track.occupied().size, 0);
  assert.equal(track.signalStates().get(signal.entityNumber), "green");
});

test("a signal away from any slot has no state", () => {
  const stray = at("rail-signal", 40.5, 40.5, 0);
  assert.equal(index([...rails(line), stray]).signalStates().has(stray.entityNumber), false);
});

test("a chain signal repeats the signal at its block's exit", () => {
  const chain = signalAt(bare, "rail-chain-signal", 1, -6, 8);
  const exit = signalAt(bare, "rail-signal", 1, -16, 8);
  const open = index([...rails(line), chain, exit]);
  assert.equal(open.signalStates().get(chain.entityNumber), "green");
  const shut = index([...rails(line), chain, exit, at("locomotive", 1, -24, 0, 0)]);
  assert.equal(shut.signalStates().get(exit.entityNumber), "red");
  assert.equal(shut.signalStates().get(chain.entityNumber), "red");
  // A train in the chain signal's own block closes it whatever the exit shows.
  const inside = index([...rails(line), chain, exit, at("locomotive", 1, -11, 0, 0)]);
  assert.equal(inside.signalStates().get(exit.entityNumber), "green");
  assert.equal(inside.signalStates().get(chain.entityNumber), "red");
});

test("a chain signal ignores a signal that only faces oncoming trains", () => {
  const chain = signalAt(bare, "rail-chain-signal", 1, -6, 8);
  // Faces north: it stops southbound trains, and is no exit for northbound.
  const oncoming = signalAt(bare, "rail-signal", 1, -16, 0);
  const track = index([...rails(line), chain, oncoming, at("locomotive", 1, -24, 0, 0)]);
  assert.equal(track.signalStates().get(chain.entityNumber), "green");
});

// A branch leaving the line at the joint y=-12, curving away to the east.
const branchStart: RailEnd = { x: 1, y: -12, dir: 0, elevated: false };
const branch = planRail({ start: branchStart, target: { x: 21, y: -40 }, targetElevated: false, blocked: () => false, maxLength: undefined });

test("the planner gave the test a branch to work with", () => {
  assert.ok(branch.length >= 4);
});

test("a chain signal before a switch is blue when one way out is open and the other isn't", () => {
  const pieces = [...line, ...branch];
  const plain = index(rails(pieces));
  // The joint between the branch's last two pieces, and the way a train
  // from the switch is heading there.
  const last = branch[branch.length - 1]!;
  const before = branch[branch.length - 2]!;
  const joint = railEndsAt(last).find((e) => railEndsAt(before).some((o) => o.x === e.x && o.y === e.y))!;
  const branchExit = signalAt(plain, "rail-signal", joint.x, joint.y, joint.dir);
  const mainExit = signalAt(plain, "rail-signal", 1, -20, 8);
  const chain = signalAt(plain, "rail-chain-signal", 1, -6, 8);
  const base = [...rails(pieces), chain, mainExit, branchExit];

  assert.equal(index(base).signalStates().get(chain.entityNumber), "green");

  const mainBusy = index([...base, at("locomotive", 1, -26, 0, 0)]);
  assert.equal(mainBusy.signalStates().get(mainExit.entityNumber), "red");
  assert.equal(mainBusy.signalStates().get(branchExit.entityNumber), "green");
  assert.equal(mainBusy.signalStates().get(chain.entityNumber), "blue");

  // Stock on the branch's last piece, heading along it.
  const [a, b] = railEndsAt(last) as [RailEnd, RailEnd];
  const heading = (Math.atan2(b.x - a.x, -(b.y - a.y)) / (Math.PI * 2) + 1) % 1;
  const onBranch = at("cargo-wagon", (a.x + b.x) / 2, (a.y + b.y) / 2, Math.round(heading * 16) % 16, heading);
  const bothBusy = index([...base, at("locomotive", 1, -26, 0, 0), onBranch]);
  assert.equal(bothBusy.signalStates().get(branchExit.entityNumber), "red");
  assert.equal(bothBusy.signalStates().get(chain.entityNumber), "red");
});

test("chain signals round a loop of free track don't lock each other shut", () => {
  const first = signalAt(bare, "rail-chain-signal", 1, -6, 8);
  const second = signalAt(bare, "rail-chain-signal", 1, -16, 8);
  const track = index([...rails(line), first, second]);
  assert.equal(track.signalStates().get(first.entityNumber), "green");
  assert.equal(track.signalStates().get(second.entityNumber), "green");
});

test("held stock snaps onto the track, heading along it the way it is held", () => {
  const north = rollingStockSnap(bare, 1.8, -9.25, 0);
  assert.deepEqual(north, { x: 1, y: -9.25, direction: 0, orientation: 0, elevated: false });
  assert.equal(rollingStockSnap(bare, 1.8, -9.3, 8)?.direction, 8);
  assert.equal(rollingStockSnap(bare, 9, -9.3, 0), undefined);
});

test("held stock snaps onto elevated track where it is drawn, and holds the deck's blocks", () => {
  const deck: RailPiece[] = line.map((p) => ({ ...p, name: "elevated-straight-rail" }));
  const bridge = index(rails(deck));
  // The deck is drawn three tiles up: that is where the cursor points.
  const snap = rollingStockSnap(bridge, 1.6, -9.25 - 3, 0);
  assert.deepEqual(snap, { x: 1, y: -9.25, direction: 0, orientation: 0, elevated: true });
  // Three tiles below the far end of the deck's picture there is only its ground shadow.
  assert.equal(rollingStockSnap(bridge, 1.6, 2 + 2, 0), undefined);
  assert.equal(stockLayer(deck, 1, -9.25), "elevated");
  assert.equal(stockLayer([...deck, ...line], 1, -9.25), undefined, "ground track under the bridge keeps it down");
  assert.equal(stockLayer(deck, 5, -9.25), undefined);

  // A train on the bridge closes the deck's signal, not one on the ground under it.
  const both = [...rails(line), ...rails(deck)];
  const bare2 = index(both);
  const up = bare2.signalSlots.find((s) => s.elevated && s.ex === 1 && s.ey === -10 && s.direction === 8)!;
  const upSignal = { ...at("rail-signal", up.x, up.y, up.direction), railLayer: "elevated" as const };
  const downSignal = signalAt(bare2, "rail-signal", 1, -10, 8);
  const train = { ...at("locomotive", 1, -20, 0, 0), railLayer: "elevated" as const };
  const states = index([...both, upSignal, downSignal, train]).signalStates();
  assert.equal(states.get(upSignal.entityNumber), "red");
  assert.equal(states.get(downSignal.entityNumber), "green");
  assert.equal(entitiesCollide(train, at("locomotive", 1, -20, 0, 0), footprint), false, "a train under the bridge is clear of it");
  assert.equal(entitiesCollide(train, { ...train, entityNumber: 999 }, footprint), true);
});

test("on a curve held stock heads the way the track runs there, between the 16 ways", () => {
  const curve = index(rails([{ name: "curved-rail-a", x: 1, y: 0, direction: 0 }]));
  const headings = new Set<number>();
  for (let y = -2.8; y <= 1.8; y += 0.2) {
    const snap = rollingStockSnap(curve, 0.5, y, 0)!;
    assert.equal(snap.direction, Math.round(snap.orientation * 16) % 16);
    assert.equal(stockOrientation(at("locomotive", snap.x, snap.y, snap.direction, snap.orientation)), snap.orientation);
    headings.add(snap.orientation);
  }
  assert.ok(headings.size > 4, `only ${headings.size} headings along the curve`);
  for (const h of headings) assert.ok(h === 0 || h > 1 - 1 / 16 - 0.01, `heading ${h} is off a curve turning from north to north-north-west`);
});

test("a wagon's wheels sit on the track under each end, turned the way it runs there", () => {
  // Straight track: two tiles ahead and behind, heading as the wagon does.
  assert.deepEqual(stockBogie(bare, { x: 1, y: -10, orientation: 0 }, 2), { dx: 0, dy: -2, orientation: 0 });
  assert.deepEqual(stockBogie(bare, { x: 1, y: -10, orientation: 0.5 }, 2), { dx: 0, dy: 2, orientation: 0.5 });
  assert.equal(stockBogie(index([]), { x: 1, y: -10, orientation: 0 }, 2), undefined);
  // A wagon half on a curve: the set on the straight keeps north, the one
  // on the curve turns with it and stays on the rail.
  const bend = index(rails([
    { name: "straight-rail", x: 1, y: 3, direction: 0 },
    { name: "straight-rail", x: 1, y: 5, direction: 0 },
    { name: "curved-rail-a", x: 1, y: 0, direction: 0 },
  ]));
  const wagon = rollingStockSnap(bend, 1, 1.5, 0)!;
  const rear = stockBogie(bend, wagon, -2)!;
  const front = stockBogie(bend, wagon, 2)!;
  assert.equal(rear.orientation, 0);
  // The wagon's centre is itself just onto the curve, a hair left of the straight.
  assert.ok(Math.abs(wagon.x + rear.dx - 1) < 1e-9 && Math.abs(rear.dy - 2) < 0.01);
  assert.ok(front.orientation > 0.93 && front.orientation < 0.99, `front heads ${front.orientation}`);
  assert.ok(front.dx < -0.05 && front.dy < -1.8, `front at ${front.dx},${front.dy}`);
});

test("R turns held stock end for end on track square across it too", () => {
  // East-west track: the held headings R flips between, north and south,
  // are both a quarter turn from it.
  const across = index(rails(Array.from({ length: 8 }, (_, i) => ({ name: "straight-rail", x: 1 + 2 * i, y: 1, direction: 4 }))));
  assert.equal(rollingStockSnap(across, 8.3, 1.4, 0)?.direction, 4);
  assert.equal(rollingStockSnap(across, 8.3, 1.4, 8)?.direction, 12);
});

test("stock rides on rails and past signals, but not through other stock", () => {
  const loco = at("locomotive", 1, -10, 0, 0);
  assert.equal(entitiesCollide(loco, at("straight-rail", 1, -9, 0), footprint), false);
  assert.equal(entitiesCollide(loco, at("rail-signal", 2.5, -10.5, 8), footprint), false);
  // Coupled wagons sit 7 tiles apart; anything closer than their lengths overlaps.
  assert.equal(entitiesCollide(loco, at("cargo-wagon", 1, -3, 0, 0), footprint), false);
  assert.equal(entitiesCollide(loco, at("cargo-wagon", 1, -6, 0, 0), footprint), true);
  // Side by side on parallel track two tiles over.
  assert.equal(entitiesCollide(loco, at("cargo-wagon", 3, -10, 0, 0), footprint), false);
  assert.equal(entitiesCollide(loco, at("assembling-machine-1", 1, -10), footprint), true);
});

console.log(`\n${passed} tests passed`);
