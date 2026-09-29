/** The lab's live model: the exact belt simulation from packages/sim, plus a
 *  PROVISIONAL machine and inserter model layered on top so the overlays
 *  have something real-looking to show until phase 2 of the simulation
 *  lands. Machines craft at the engine's calculated speed (modules, beacons
 *  and quality included); inserters are a fixed-time swing derived from
 *  the dataset's chest-to-chest throughput, one item per swing. */
import { calculate, type GameData, type PlacedEntity } from "@factoriotools/engine";
import { BeltSim, beltSpecResolver, buildBeltNetwork, cardOf, DX, DY, laneSide, type BeltLine, type BeltNetwork, type BeltNode, type Card, type Lane, type LaneFeed } from "@factoriotools/sim";

const EMA = 1 / 300; // ~5 s at 60 ticks/s

/** What research the lab assumes. Hand sizes and belt stacking both come
 *  from research the blueprint can't record. */
export interface Research {
  hands: "none" | "full";
  /** Items per belt slot a stack inserter builds (Space Age belt stacking). */
  beltStack: number;
}

export const FULL_RESEARCH: Research = { hands: "full", beltStack: 4 };

/** Ticks for one pickup-to-drop-and-back swing at normal quality, from the
 *  dataset's chest-to-chest rates for a one-item hand. Fast, bulk and stack
 *  inserters share one arm speed. */
const SWING_TICKS: Record<string, number> = {
  "burner-inserter": 76,
  inserter: 70,
  "long-handed-inserter": 48,
  "fast-inserter": 24,
  "bulk-inserter": 24,
  "stack-inserter": 24,
};

/** Approximate hand sizes without and with full inserter capacity research. */
function handSizeFor(name: string, research: Research): number {
  const full = research.hands === "full";
  if (name.includes("stack")) return full ? 16 : 4;
  if (name.includes("bulk")) return full ? 12 : 2;
  return full ? 3 : 1;
}

export interface MachineSim {
  entity: PlacedEntity;
  recipe: string;
  box: { left: number; top: number; right: number; bottom: number };
  craftTicks: number;
  ingredients: { name: string; amount: number }[];
  products: { name: string; amount: number }[];
  buffer: Map<string, number>;
  out: Map<string, number>;
  outFraction: Map<string, number>;
  crafting: boolean;
  progress: number;
  /** Rolling fractions of time spent crafting / waiting on an arm / starved
   *  / blocked by a full output. */
  uptime: number;
  armBound: number;
  starved: number;
  outFull: number;
  /** The ingredient most recently missing, for the diagnosis. */
  missing?: string;
  feeders: InserterSim[];
  takers: InserterSim[];
}

export type Target =
  | { kind: "machine"; machine: MachineSim }
  | { kind: "belt"; node: BeltNode; lane: Lane }
  /** A chest whose contents the blueprint states — a requester's or buffer's
   *  requests, an infinity or creative chest's filters. An endless source. */
  | { kind: "chest"; items: string[]; next: number }
  /** The arm's other side connects to nothing the lab simulates: the arm
   *  is a port to the world outside the blueprint. */
  | { kind: "port"; port: ArmPort }
  /** A plain chest that arms both fill and empty: a buffer between them. */
  | { kind: "box"; box: Box }
  /** Nothing on either side: the arm never moves. */
  | { kind: "none" };

/** Items held between arms: a plain chest one arm fills and another
 *  empties, or the bare ground where one arm drops and another picks up. */
export interface Box {
  contents: Map<string, number>;
  total: number;
  capacity: number;
  /** The entity it is, or undefined for items lying on the ground. */
  entity?: PlacedEntity;
  /** Tile centre. */
  x: number;
  y: number;
}
/** Roughly a steel chest's worth; enough that a buffer never fills in a
 *  session unless nothing empties it. */
const CHEST_CAPACITY = 1600;
/** An arm only drops onto the ground where there's space under its hand. */
const GROUND_CAPACITY = 16;

/** An inserter whose pickup or drop side is open. An input brings items in
 *  from outside; an output takes them away. */
export interface ArmPort {
  id: string;
  kind: "input" | "output";
  inserter: InserterSim;
  /** Centre of the open tile, where the tab goes. */
  at: { x: number; y: number };
  /** Whatever stands on the open tile, if anything (a chest, a furnace…). */
  onto?: string;
  /** Input ports: what the arm brings, taking whichever the target wants. */
  items: string[];
}

/** One row of the Ports window: a belt end or an arm. */
export interface PortInfo {
  id: string;
  kind: "input" | "output";
  via: "belt" | "arm";
  /** Centre of the port's tile: the belt end, or the arm's open side. */
  x: number;
  y: number;
  /** Belt ports: travel direction at the end, to set the tab beside it. */
  dir?: Card;
  enabled: boolean;
  reason: string;
  /** Items it brings (inputs) — for the tab's icons. */
  items: string[];
  /** Items per second through it right now. */
  rate: number;
}

const isSilo = (m: MachineSim) => m.entity.name.includes("rocket-silo");

/** Things that store items, so an arm next to one is reaching into it. */
const CONTAINER = /chest|container|wagon/;

/** Chests whose blueprint settings say what they hold. */
const KNOWN_CHEST = /requester|buffer|infinity|creative/;
/** Entities players put next to a belt to label what's on it. */
const LABELS = /constant-combinator|display-panel/;

export interface InserterSim {
  entity: PlacedEntity;
  pickup: Target;
  drop: Target;
  pickupAt: { x: number; y: number };
  dropAt: { x: number; y: number };
  tripTicks: number;
  maxRate: number;
  /** Items carried per swing. */
  handSize: number;
  /** Stack inserters put stacks on belts; everything else one item a slot. */
  stacksOnBelt: boolean;
  phase: "home" | "out" | "drop" | "back";
  t: number;
  /** What's in the hand (one item name) and how many. */
  hand?: string;
  handCount: number;
  busy: number;
  moved: number;
}

export type MachineStatus = "working" | "arm" | "starved" | "output" | "idle";

export function machineStatus(m: MachineSim): MachineStatus {
  if (m.uptime > 0.94) return "working";
  const worst = Math.max(m.armBound, m.starved, m.outFull);
  if (worst < 0.02) return "idle";
  if (worst === m.outFull) return "output";
  return worst === m.armBound ? "arm" : "starved";
}

/** Rolling per-tile lane rates, sampled from the belt sim's cumulative
 *  crossing counters so nothing has to reset them. */
class LaneMeter {
  private samples = new Map<BeltLine, [Uint32Array[], Uint32Array[]]>();
  private ticks: number[] = [];
  constructor(private sim: BeltSim, private lines: BeltLine[]) {}

  sample(tick: number) {
    this.ticks.push(tick);
    for (const line of this.lines) {
      let entry = this.samples.get(line);
      if (!entry) this.samples.set(line, (entry = [[], []]));
      for (const lane of [0, 1] as const) {
        entry[lane].push(Uint32Array.from(this.sim.laneCrossings(line, lane)));
        if (entry[lane].length > 7) entry[lane].shift();
      }
    }
    if (this.ticks.length > 7) this.ticks.shift();
  }

  /** Items/second through segment `k` over the last few seconds. */
  rate(line: BeltLine, lane: Lane, k: number): number {
    const entry = this.samples.get(line)?.[lane];
    if (!entry || entry.length < 2) return 0;
    const first = entry[0]!;
    const last = entry[entry.length - 1]!;
    const dt = this.ticks[this.ticks.length - 1]! - this.ticks[0]!;
    return dt > 0 ? ((last[k]! - first[k]!) * 60) / dt : 0;
  }
}

export class LabFactory {
  readonly net: BeltNetwork;
  readonly belts: BeltSim;
  readonly machines: MachineSim[] = [];
  readonly inserters: InserterSim[] = [];
  readonly meter: LaneMeter;
  /** Item names worth offering in the port pickers. */
  readonly knownItems: string[];
  tick = 0;

  constructor(
    readonly data: GameData,
    readonly entities: PlacedEntity[],
    readonly research: Research = FULL_RESEARCH,
    /** Tiles an entity covers (width, height at direction 0), for anything
     *  the dataset doesn't size itself; 1×1 when unknown. */
    footprintOf: (name: string) => [number, number] | undefined = () => undefined,
  ) {
    this.net = buildBeltNetwork(entities, beltSpecResolver(data));
    this.belts = new BeltSim(this.net);
    this.meter = new LaneMeter(this.belts, this.net.lines);

    const calc = calculate(data, entities);
    const byNumber = new Map(entities.map((e) => [e.entityNumber, e] as const));
    for (const g of calc.groups) {
      if (g.craftsPerSecond <= 0) continue;
      const machine = data.machines[g.machineName];
      if (!machine || machine.kind !== "crafting") continue;
      for (const n of g.entityNumbers) {
        const e = byNumber.get(n);
        if (!e) continue;
        const [w0, h0] = machine.tileFootprint ?? machine.size;
        const c = cardOf(e.direction);
        const [w, h] = c === 1 || c === 3 ? [h0, w0] : [w0, h0];
        this.machines.push({
          entity: e,
          recipe: g.recipeName,
          box: { left: e.x - w / 2, top: e.y - h / 2, right: e.x + w / 2, bottom: e.y + h / 2 },
          // Can be under one tick: fast machines finish several crafts a tick.
          craftTicks: 60 / g.craftsPerSecond,
          ingredients: g.ingredients.filter((l) => l.kind === "item").map((l) => ({ name: l.name, amount: l.ratePerMachine / g.craftsPerSecond })),
          products: g.products.filter((l) => l.kind === "item").map((l) => ({ name: l.name, amount: l.ratePerMachine / g.craftsPerSecond })),
          buffer: new Map(),
          out: new Map(),
          outFraction: new Map(),
          crafting: false,
          progress: 0,
          uptime: 0,
          armBound: 0,
          starved: 0,
          outFull: 0,
          feeders: [],
          takers: [],
        });
      }
    }

    const byTile = new Map<string, PlacedEntity>();
    for (const e of entities) byTile.set(`${Math.floor(e.x)},${Math.floor(e.y)}`, e);
    this.entityAt = (x, y) => byTile.get(`${x},${y}`);
    const chestAt = (x: number, y: number): string[] | undefined => {
      const e = byTile.get(`${Math.floor(x)},${Math.floor(y)}`);
      return e && KNOWN_CHEST.test(e.name) ? this.realItems(e.signalItems) : undefined;
    };
    const machineAt = (x: number, y: number) =>
      this.machines.find((m) => x > m.box.left && x < m.box.right && y > m.box.top && y < m.box.bottom);
    const tileKey = (p: { x: number; y: number }) => `${Math.floor(p.x)},${Math.floor(p.y)}`;
    // Plain chests that arms both fill and empty are buffers, not ports.
    const reach = (e: PlacedEntity) => {
      const r = e.name.includes("long-handed") ? 2 : 1;
      const f = cardOf(e.direction);
      return { pickupAt: { x: e.x + DX[f] * r, y: e.y + DY[f] * r }, dropAt: { x: e.x - DX[f] * r, y: e.y - DY[f] * r } };
    };
    const filled = new Set<string>();
    const emptied = new Set<string>();
    for (const e of entities) {
      if (!data.inserters[e.name]) continue;
      const { pickupAt, dropAt } = reach(e);
      emptied.add(tileKey(pickupAt));
      filled.add(tileKey(dropAt));
    }
    const boxes = new Map<string, Box>();
    const madeHere = new Set(this.machines.flatMap((m) => m.products.map((p) => p.name)));
    for (const e of entities) {
      const proto = data.inserters[e.name];
      if (!proto) continue;
      const facing = cardOf(e.direction);
      // An inserter faces its pickup: at direction 0 (north) it takes from
      // the tile above and drops on the tile below — the same tiles the
      // engine's bottleneck check (calc/throughput.ts) uses.
      const { pickupAt, dropAt } = reach(e);
      const target = (p: { x: number; y: number }, isDrop: boolean): Target => {
        const m = machineAt(p.x, p.y);
        if (m) return { kind: "machine", machine: m };
        const node = this.net.nodeAt(Math.floor(p.x), Math.floor(p.y));
        if (node?.line) {
          // An inserter drops on the lane farther from itself. It drops
          // away from its facing, and picks up toward it.
          const away = (isDrop ? (facing + 2) % 4 : facing) as Card;
          const lane: Lane = laneSide(node.dir, 0) === away ? 0 : 1;
          return { kind: "belt", node, lane };
        }
        const chest = chestAt(p.x, p.y);
        if (chest) return { kind: "chest", items: chest, next: 0 };
        const key = tileKey(p);
        const onTile = byTile.get(key);
        // A plain chest, or bare ground, that one arm drops onto and another
        // picks up from passes items between them.
        const container = onTile && CONTAINER.test(onTile.name);
        if ((container || !onTile) && filled.has(key) && emptied.has(key)) {
          let box = boxes.get(key);
          if (!box) {
            box = {
              contents: new Map(),
              total: 0,
              capacity: container ? CHEST_CAPACITY : GROUND_CAPACITY,
              entity: onTile,
              x: Math.floor(p.x) + 0.5,
              y: Math.floor(p.y) + 0.5,
            };
            boxes.set(key, box);
            this.boxes.push(box);
          }
          return { kind: "box", box };
        }
        // Open: filled in below, once both sides are known.
        return { kind: "none" };
      };
      const handSize = e.overrideStackSize ?? handSizeFor(e.name, research);
      // Quality speeds the arm's rotation up the same way it speeds up
      // machines. Kept fractional: a legendary stack arm takes 9.6 ticks.
      const swing = (SWING_TICKS[e.name] ?? Math.round(60 / proto.throughput)) / (data.qualityMachineSpeed[e.quality] ?? 1);
      const tripTicks = Math.max(4, swing);
      const ins: InserterSim = {
        entity: e,
        pickup: target(pickupAt, false),
        drop: target(dropAt, true),
        pickupAt,
        dropAt,
        tripTicks,
        maxRate: (60 * handSize) / tripTicks,
        handSize,
        stacksOnBelt: e.name.includes("stack"),
        phase: "home",
        t: 0,
        handCount: 0,
        busy: 0,
        moved: 0,
      };
      // An arm connected on one side only is a port on its open side.
      const tile = (p: { x: number; y: number }) => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 });
      const where = `${Math.floor(e.x)},${Math.floor(e.y)}`;
      if (ins.pickup.kind === "none" && ins.drop.kind !== "none") {
        const needs = ins.drop.kind === "machine" ? ins.drop.machine.ingredients.map((i) => i.name) : [];
        const outside = needs.filter((n) => !madeHere.has(n));
        const port: ArmPort = { id: `arm-in:${where}`, kind: "input", inserter: ins, at: tile(pickupAt), onto: byTile.get(tileKey(pickupAt))?.name, items: outside.length ? outside : needs };
        ins.pickup = { kind: "port", port };
        this.armPorts.push(port);
        this.portEnabled.set(port.id, port.items.length > 0 && outside.length > 0);
        this.portReason.set(
          port.id,
          !port.items.length ? "Pick what it brings" : outside.length ? "Brings what the machine needs" : "Everything it could bring is made here",
        );
      } else if (ins.drop.kind === "none" && ins.pickup.kind !== "none") {
        const port: ArmPort = { id: `arm-out:${where}`, kind: "output", inserter: ins, at: tile(dropAt), onto: byTile.get(tileKey(dropAt))?.name, items: [] };
        ins.drop = { kind: "port", port };
        this.armPorts.push(port);
        this.portEnabled.set(port.id, true);
        this.portReason.set(port.id, "Takes everything away");
      }
      if (ins.drop.kind === "machine") ins.drop.machine.feeders.push(ins);
      if (ins.pickup.kind === "machine") ins.pickup.machine.takers.push(ins);
      this.inserters.push(ins);
    }

    const items = new Set<string>();
    for (const m of this.machines) for (const i of [...m.ingredients, ...m.products]) items.add(i.name);
    this.knownItems = [...items].sort();
    this.guessInputs();
    // A belt end that points into empty space carries on somewhere off the
    // blueprint, so it starts taking everything. One that points into a
    // building, or that an inserter takes from, is a dead end by design and
    // starts off. Either can be switched in the Ports window.
    const occupied = new Map<string, PlacedEntity>();
    for (const e of entities) {
      const [w0, h0] = data.machines[e.name]?.tileFootprint ?? data.machines[e.name]?.size ?? data.beacons[e.name]?.size ?? footprintOf(e.name) ?? [1, 1];
      const c = cardOf(e.direction);
      const [w, h] = c === 1 || c === 3 ? [h0, w0] : [w0, h0];
      const left = Math.round(e.x - w / 2);
      const top = Math.round(e.y - h / 2);
      for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) occupied.set(`${left + dx},${top + dy}`, e);
    }
    for (const port of this.net.ports) {
      if (port.kind !== "output") continue;
      const ahead = occupied.get(`${port.x + DX[port.dir]},${port.y + DY[port.dir]}`);
      const tail = port.line.nodes[port.line.nodes.length - 1];
      const taken = this.inserters.some((i) => i.pickup.kind === "belt" && i.pickup.node === tail);
      this.portEnabled.set(port.id, !ahead && !taken);
      this.portReason.set(
        port.id,
        ahead ? `Points into the ${(data.items[ahead.name]?.localised ?? ahead.name.replace(/-/g, " ")).toLowerCase()}`
        : taken ? "An inserter takes from its end"
        : "Points into empty space",
      );
      this.applyBeltPort(port.id);
    }
  }

  private readonly entityAt: (x: number, y: number) => PlacedEntity | undefined;

  /** Only names the dataset knows as items (a combinator can also carry
   *  fluids and other signals). */
  private realItems(names: string[] | undefined): string[] | undefined {
    const items = (names ?? []).filter((n) => this.data.items[n]?.kind === "item");
    return items.length ? items : undefined;
  }


  /** Blueprints don't record what's on a belt, so each input port starts
   *  from the best evidence there is, in this order:
   *  1. a constant combinator or display panel next to the belt, or a known
   *     chest right behind where it starts, says what's on it;
   *  2. if the first thing that happens to the belt downstream is an arm in
   *     the blueprint putting items onto it, the belt is filled inside the
   *     blueprint and gets nothing from outside;
   *  3. otherwise, the ingredients the machines it feeds take from it,
   *     skipping anything the blueprint makes itself — the most wanted on
   *     the left lane, the next on the right. */
  guessInputs() {
    const madeHere = new Set(this.machines.flatMap((m) => m.products.map((p) => p.name)));
    // Builds with stack inserters are Space Age builds; assume their input
    // belts arrive stacked too.
    const stack = this.inserters.some((i) => i.stacksOnBelt) ? this.research.beltStack : 1;
    const feed = (name: string | undefined): LaneFeed | null => (name ? { item: name, rate: "full", stack } : null);
    const guessed: { id: string; items: string[] }[] = [];
    for (const port of this.net.ports) {
      // The synthetic input behind an unfed splitter half starts empty:
      // nothing is placed there in the blueprint.
      if (port.kind !== "input" || port.line.nodes.length === 0) continue;

      const labelled = this.labelFor(port.line);
      if (labelled) {
        this.setInput(port.id, feed(labelled.items[0]), feed(labelled.items[1] ?? labelled.items[0]));
        this.portReason.set(port.id, `From the ${labelled.source}`);
        continue;
      }

      const wanted = new Map<string, number>();
      const seen = new Set<BeltLine>();
      let first: "pickup" | "drop" | undefined;
      const walk = (line: BeltLine) => {
        if (seen.has(line)) return;
        seen.add(line);
        const on = (t: Target) => t.kind === "belt" && t.node.line === line;
        const seg = (t: Target) => (t.kind === "belt" ? line.lanes[0].segments.findIndex((s) => s.node === t.node) : -1);
        const events = [
          ...this.inserters.filter((i) => on(i.pickup)).map((i) => ({ kind: "pickup" as const, at: seg(i.pickup), ins: i })),
          ...this.inserters.filter((i) => on(i.drop) && (i.pickup.kind === "machine" || i.pickup.kind === "chest" || i.pickup.kind === "box" || i.pickup.kind === "port")).map((i) => ({ kind: "drop" as const, at: seg(i.drop), ins: i })),
        ].sort((a, b) => a.at - b.at);
        if (!first && events.length) first = events[0]!.kind;
        for (const ev of events) {
          if (ev.kind !== "pickup") continue;
          // Look through a buffer chest to the machines its arms feed.
          const d = ev.ins.drop;
          const machines =
            d.kind === "machine" ? [d.machine]
            : d.kind === "box" ? this.inserters.flatMap((i) => (i.pickup.kind === "box" && i.pickup.box === d.box && i.drop.kind === "machine" ? [i.drop.machine] : []))
            : [];
          for (const m of machines) {
            for (const ing of m.ingredients) {
              if (!madeHere.has(ing.name)) wanted.set(ing.name, (wanted.get(ing.name) ?? 0) + 1);
            }
          }
        }
        const end = line.end;
        if (end.kind === "line") walk(end.to);
        else if (end.kind === "sideload") end.target.forEach((t) => t && walk(t.line));
        else if (end.kind === "splitter") end.splitter.outputs.forEach(walk);
      };
      walk(port.line);
      if (first === "drop") {
        this.setInput(port.id, null, null);
        this.portReason.set(port.id, "Filled inside the blueprint");
        continue;
      }
      const ranked = [...wanted.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      guessed.push({ id: port.id, items: ranked });
    }
    // Belts that feed the same machines share out what those machines need,
    // two items per belt (one per lane), so three belts into rocket silos
    // carry all three ingredients rather than the same two three times.
    const groups = new Map<string, string[]>();
    for (const g of guessed) {
      const key = [...g.items].sort().join("|");
      groups.set(key, [...(groups.get(key) ?? []), g.id]);
    }
    for (const g of guessed) {
      const peers = groups.get([...g.items].sort().join("|"))!;
      const k = peers.indexOf(g.id);
      const m = g.items.length;
      const pick = (slot: number) => (m ? g.items[(k * 2 + slot) % m] : undefined);
      this.setInput(g.id, feed(pick(0)), feed(pick(1)));
      this.portReason.set(g.id, m ? "Guessed from the machines it feeds" : "Nothing downstream takes from it");
    }
  }

  /** A label for what's on a belt line: a constant combinator or display
   *  panel within a tile of any of its belts, or a known chest (or a loader
   *  in front of one) right behind where it starts. */
  private labelFor(line: BeltLine): { items: string[]; source: string } | undefined {
    for (const node of line.nodes) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const e = this.entityAt(node.x + dx, node.y + dy);
          const items = e && LABELS.test(e.name) ? this.realItems(e.signalItems) : undefined;
          if (items) return { items, source: e!.name.includes("display") ? "display panel" : "constant combinator" };
        }
      }
    }
    const head = line.nodes[0]!;
    for (let k = 1; k <= 2; k++) {
      const e = this.entityAt(head.x - DX[head.dir] * k, head.y - DY[head.dir] * k);
      const items = e && KNOWN_CHEST.test(e.name) ? this.realItems(e.signalItems) : undefined;
      if (items) return { items, source: e!.name.replace(/-/g, " ") };
      if (!e || !e.name.includes("loader")) break;
    }
    return undefined;
  }

  /** What each belt input feeds when it's on; kept while it's off. */
  readonly inputs = new Map<string, [LaneFeed | null, LaneFeed | null]>();
  readonly armPorts: ArmPort[] = [];
  /** Chests and ground tiles that pass items between arms. */
  readonly boxes: Box[] = [];
  /** On/off per port, belt or arm. An input that's off brings nothing; an
   *  output that's off is a dead end. */
  readonly portEnabled = new Map<string, boolean>();
  readonly portReason = new Map<string, string>();

  setInput(portId: string, left: LaneFeed | null, right: LaneFeed | null) {
    this.inputs.set(portId, [left, right]);
    if (!this.portEnabled.has(portId)) this.portEnabled.set(portId, true);
    this.applyBeltPort(portId);
  }

  setPortEnabled(portId: string, on: boolean) {
    this.portEnabled.set(portId, on);
    if (!portId.startsWith("arm-")) this.applyBeltPort(portId);
  }

  private applyBeltPort(portId: string) {
    const port = this.net.ports.find((p) => p.id === portId);
    if (!port) return;
    const on = this.portEnabled.get(portId) ?? true;
    if (port.kind === "output") this.belts.setOutput(portId, on ? "sink" : "blocked");
    else {
      const [l, r] = this.inputs.get(portId) ?? [null, null];
      this.belts.setInput(portId, on ? l : null, on ? r : null);
    }
  }

  setArmPortItems(portId: string, items: string[]) {
    const port = this.armPorts.find((p) => p.id === portId);
    if (port) port.items = items;
  }

  /** Every port, belt and arm, for the Ports window and the map tabs. */
  ports(): PortInfo[] {
    const belt = this.net.ports.map((p): PortInfo => {
      const node = p.line.nodes[p.kind === "input" ? 0 : p.line.nodes.length - 1];
      const feed = this.inputs.get(p.id) ?? [null, null];
      return {
        id: p.id,
        kind: p.kind,
        via: "belt",
        x: p.x + 0.5,
        y: p.y + 0.5,
        dir: p.dir,
        enabled: this.portEnabled.get(p.id) ?? true,
        reason: this.portReason.get(p.id) ?? (p.kind === "output" ? "Takes everything away" : ""),
        items: p.kind === "input" ? [...new Set(feed.filter((l): l is LaneFeed => !!l).map((l) => l.item))] : [],
        rate: node ? this.tileRate(node, 0) + this.tileRate(node, 1) : 0,
      };
    });
    const arms = this.armPorts.map((p): PortInfo => ({
      id: p.id,
      kind: p.kind,
      via: "arm",
      x: p.at.x,
      y: p.at.y,
      enabled: this.portEnabled.get(p.id) ?? true,
      reason: this.portReason.get(p.id) ?? "",
      items: p.kind === "input" ? p.items : [],
      rate: p.inserter.moved,
    }));
    return [...belt, ...arms];
  }

  /** Carries every port choice (on/off, belt feeds, arm items) over to a
   *  rebuilt model of the same blueprint. */
  copyPortsTo(next: LabFactory) {
    for (const [id, [l, r]] of this.inputs) next.setInput(id, l, r);
    for (const p of this.armPorts) next.setArmPortItems(p.id, p.items);
    for (const [id, on] of this.portEnabled) next.setPortEnabled(id, on);
  }

  step(ticks = 1) {
    for (let i = 0; i < ticks; i++) {
      this.belts.step();
      for (const m of this.machines) this.stepMachine(m);
      for (const ins of this.inserters) this.stepInserter(ins);
      this.tick++;
      if (this.tick % 30 === 0) this.meter.sample(this.tick);
    }
  }

  /** How much of an ingredient arms keep topping a machine up to: a couple
   *  of crafts' worth, more for a fast machine (the game's insertion limit
   *  grows with crafting speed), and never less than one full hand. */
  private limitFor(m: MachineSim, name: string): number {
    const ing = m.ingredients.find((i) => i.name === name);
    if (!ing) return 0;
    const hands = Math.max(1, ...m.feeders.map((f) => f.handSize));
    const crafts = Math.max(2, Math.ceil((60 / m.craftTicks) * 1.2));
    return Math.max(Math.ceil(ing.amount * crafts), hands);
  }

  /** A machine stops once its output holds a few crafts' worth — or two
   *  hands' worth for whatever arm empties it, so big hands still fill. */
  private outputFull(m: MachineSim): boolean {
    const hands = Math.max(1, ...m.takers.map((t) => t.handSize));
    const crafts = Math.max(3, Math.ceil((60 / m.craftTicks) * 1.2));
    return m.products.some((p) => (m.out.get(p.name) ?? 0) >= Math.max(4, Math.ceil(p.amount * crafts), hands * 2));
  }

  private stepMachine(m: MachineSim) {
    const tryStart = () => {
      if (this.outputFull(m)) return false;
      for (const ing of m.ingredients) {
        if ((m.buffer.get(ing.name) ?? 0) < Math.ceil(ing.amount - 1e-9)) {
          m.missing = ing.name;
          return false;
        }
      }
      for (const ing of m.ingredients) m.buffer.set(ing.name, (m.buffer.get(ing.name) ?? 0) - Math.ceil(ing.amount - 1e-9));
      m.crafting = true;
      return true;
    };
    const finish = () => {
      for (const p of m.products) {
        // A rocket silo builds its parts into the rocket and launches it;
        // nothing is ever taken out.
        if (isSilo(m)) continue;
        const total = (m.outFraction.get(p.name) ?? 0) + p.amount;
        const whole = Math.floor(total + 1e-9);
        m.outFraction.set(p.name, total - whole);
        m.out.set(p.name, (m.out.get(p.name) ?? 0) + whole);
      }
      m.crafting = false;
      m.progress = 0;
    };
    // Spend one tick of work: finish the current craft, start the next,
    // and keep going while the tick lasts — a fast enough machine finishes
    // several crafts in one tick.
    let budget = 1;
    while (budget > 1e-9) {
      if (!m.crafting && !tryStart()) break;
      const need = m.craftTicks - m.progress;
      if (need <= budget) {
        budget -= need;
        finish();
      } else {
        m.progress += budget;
        budget = 0;
      }
    }
    const working = 1 - budget;
    const idle = budget;
    let arm = 0;
    let starved = 0;
    let full = 0;
    if (idle > 0) {
      if (this.outputFull(m)) full = idle;
      else if (m.feeders.some((f) => f.phase !== "home")) arm = idle;
      else starved = idle;
    }
    m.uptime += (working - m.uptime) * EMA;
    m.armBound += (arm - m.armBound) * EMA;
    m.starved += (starved - m.starved) * EMA;
    m.outFull += (full - m.outFull) * EMA;
  }


  private wants(ins: InserterSim, item: string): boolean {
    const e = ins.entity;
    if (e.useFilters && e.filterItems.some(Boolean)) {
      const listed = e.filterItems.includes(item);
      if (e.filterMode === "blacklist" ? listed : !listed) return false;
    }
    const d = ins.drop;
    if (d.kind === "machine") {
      const ingredient = d.machine.ingredients.some((i) => i.name === item);
      // A rocket silo also takes anything else as rocket cargo.
      if (!ingredient) return isSilo(d.machine);
      return (d.machine.buffer.get(item) ?? 0) < this.limitFor(d.machine, item);
    }
    if (d.kind === "none") return false;
    return true;
  }

  /** How many of an item the arm waits for before it swings: a full hand,
   *  or less when the drop target is a chest that can't take a full hand.
   *  A machine gets the whole hand once it's below its insertion limit. */
  private handTarget(ins: InserterSim, item: string): number {
    const d = ins.drop;
    const cap = d.kind === "box" ? d.box.capacity - d.box.total : ins.handSize;
    return Math.max(1, Math.min(ins.handSize, cap));
  }

  private stepInserter(ins: InserterSim) {
    const half = ins.tripTicks / 2;
    let delivered = 0;
    // Travel first. Arriving at either end picks up or drops in the same
    // tick, and the unused part of the tick carries into the next leg, so a
    // round trip takes exactly tripTicks rather than rounding up.
    if (ins.phase === "out" || ins.phase === "back") {
      ins.t -= 1;
      if (ins.t <= 0) ins.phase = ins.phase === "out" ? "drop" : "home";
    }
    if (ins.phase === "home") {
      // An arm tops its hand up tick by tick and only swings once it holds
      // all it can carry — or all the drop target will take. One item kind
      // per hand: once something is held, only more of it is picked.
      const p = ins.pickup;
      const accept = (item: string) => (ins.hand === undefined || item === ins.hand) && this.wants(ins, item);
      const room = (item: string) => Math.max(0, this.handTarget(ins, item) - ins.handCount);
      let got: string | undefined;
      let count = 0;
      if (p.kind === "machine") {
        for (const prod of p.machine.products) {
          const have = p.machine.out.get(prod.name) ?? 0;
          if (have > 0 && accept(prod.name)) {
            count = Math.min(have, room(prod.name));
            p.machine.out.set(prod.name, have - count);
            got = prod.name;
            break;
          }
        }
      } else if (p.kind === "chest") {
        // An endless supply: hand over the next listed item the arm wants.
        for (let k = 0; k < p.items.length; k++) {
          const item = p.items[(p.next + k) % p.items.length]!;
          if (accept(item)) {
            got = item;
            count = room(item);
            p.next = (p.next + k + 1) % p.items.length;
            break;
          }
        }
      } else if (p.kind === "port") {
        // The outside world: an endless supply of the port's items, while
        // the port is on.
        if (this.portEnabled.get(p.port.id)) {
          got = p.port.items.find(accept);
          if (got) count = room(got);
        }
      } else if (p.kind === "box") {
        for (const [item, have] of p.box.contents) {
          if (have > 0 && accept(item)) {
            got = item;
            count = Math.min(have, room(item));
            p.box.contents.set(item, have - count);
            p.box.total -= count;
            break;
          }
        }
      } else if (p.kind === "belt") {
        // The first item decides what the hand carries; then take only as
        // many more as the target allows.
        let took = ins.hand === undefined ? this.belts.takeFromTile(p.node, accept, 1) : undefined;
        const item = took?.item ?? ins.hand;
        if (item !== undefined) {
          const more = room(item) - (took?.count ?? 0);
          const rest = more > 0 ? this.belts.takeFromTile(p.node, (i) => i === item && accept(i), more) : undefined;
          if (rest) took = { item, count: (took?.count ?? 0) + rest.count };
        }
        if (took) {
          got = took.item;
          count = took.count;
        }
      }
      if (got && count > 0) {
        ins.hand = got;
        ins.handCount += count;
      }
      if (ins.hand !== undefined && ins.handCount >= this.handTarget(ins, ins.hand)) {
        ins.phase = "out";
        ins.t += half;
      } else ins.t = 0;
    } else if (ins.phase === "drop") {
      const d = ins.drop;
      if (d.kind === "machine") {
        // Rocket cargo leaves with the rocket; ingredients go in the buffer.
        if (d.machine.ingredients.some((i) => i.name === ins.hand)) {
          d.machine.buffer.set(ins.hand!, (d.machine.buffer.get(ins.hand!) ?? 0) + ins.handCount);
        }
        delivered = ins.handCount;
        ins.handCount = 0;
      } else if (d.kind === "belt") {
        // One slot per tick as space opens up under the hand: a whole stack
        // for a stack inserter, a single item for anything else.
        const n = ins.stacksOnBelt ? Math.min(ins.handCount, this.research.beltStack) : 1;
        if (this.belts.dropOnTile(d.node, d.lane, ins.hand!, n)) {
          ins.handCount -= n;
          delivered = n;
        }
      } else if (d.kind === "box") {
        // As much of the hand as fits; the rest waits for space.
        const n = Math.min(ins.handCount, d.box.capacity - d.box.total);
        if (n > 0) {
          d.box.contents.set(ins.hand!, (d.box.contents.get(ins.hand!) ?? 0) + n);
          d.box.total += n;
          ins.handCount -= n;
          delivered = n;
        }
      } else if (d.kind === "port") {
        // An output port that's off is a dead end: the arm waits.
        if (this.portEnabled.get(d.port.id)) {
          delivered = ins.handCount;
          ins.handCount = 0;
        }
      } else {
        delivered = ins.handCount;
        ins.handCount = 0;
      }
      if (ins.handCount === 0) {
        ins.hand = undefined;
        ins.phase = "back";
        ins.t += half;
      } else ins.t = 0;
    }
    ins.busy += ((ins.phase !== "home" ? 1 : 0) - ins.busy) * EMA;
    ins.moved += (delivered * 60 - ins.moved) * EMA;
  }

  /** Where the arm is between pickup (0) and drop (1). */
  armProgress(ins: InserterSim): number {
    const half = ins.tripTicks / 2;
    if (ins.phase === "home") return 0;
    if (ins.phase === "out") return 1 - ins.t / half;
    if (ins.phase === "drop") return 1;
    return ins.t / half;
  }

  /** Per-tile flow on one lane of a belt tile, items/second. */
  tileRate(node: BeltNode, lane: Lane): number {
    return this.meter.rate(node.line!, lane, this.belts.segmentOf(node, lane));
  }

  /** Output per second of a machine's main product at its current uptime. */
  machineRate(m: MachineSim): number {
    return (m.uptime * 60 * (m.products[0]?.amount ?? 1)) / m.craftTicks;
  }

  machineMaxRate(m: MachineSim): number {
    return (60 * (m.products[0]?.amount ?? 1)) / m.craftTicks;
  }

  /** How much of `item` a machine eats per second at full speed. */
  machineNeed(m: MachineSim, item: string): number {
    return (60 * (m.ingredients.find((i) => i.name === item)?.amount ?? 0)) / m.craftTicks;
  }
}
