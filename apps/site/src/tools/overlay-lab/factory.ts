/** The lab's live model: the exact belt simulation from packages/sim, plus a
 *  PROVISIONAL machine and inserter model layered on top so the overlays
 *  have something real-looking to show until phase 2 of the simulation
 *  lands. Machines craft at the engine's calculated speed (modules, beacons
 *  and quality included); inserters are a fixed-time swing derived from
 *  the dataset's chest-to-chest throughput, one item per swing. */
import { calculate, type GameData, type PlacedEntity } from "@factoriotools/engine";
import { BeltSim, beltSpecResolver, buildBeltNetwork, cardOf, DX, DY, laneSide, type BeltLine, type BeltNetwork, type BeltNode, type Card, type Lane, type LaneFeed } from "@factoriotools/sim";

const EMA = 1 / 300; // ~5 s at 60 ticks/s

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

export type Target = { kind: "machine"; machine: MachineSim } | { kind: "belt"; node: BeltNode; lane: Lane } | { kind: "other" };

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

  constructor(readonly data: GameData, readonly entities: PlacedEntity[]) {
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
          craftTicks: Math.max(1, 60 / g.craftsPerSecond),
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

    const machineAt = (x: number, y: number) =>
      this.machines.find((m) => x > m.box.left && x < m.box.right && y > m.box.top && y < m.box.bottom);
    for (const e of entities) {
      const proto = data.inserters[e.name];
      if (!proto) continue;
      const reach = e.name.includes("long-handed") ? 2 : 1;
      const facing = cardOf(e.direction);
      // An inserter faces its pickup: at direction 0 (north) it takes from
      // the tile above and drops on the tile below — the same tiles the
      // engine's bottleneck check (calc/throughput.ts) uses.
      const pickupAt = { x: e.x + DX[facing] * reach, y: e.y + DY[facing] * reach };
      const dropAt = { x: e.x - DX[facing] * reach, y: e.y - DY[facing] * reach };
      const target = (p: { x: number; y: number }, isDrop: boolean): Target => {
        const m = machineAt(p.x, p.y);
        if (m) return { kind: "machine", machine: m };
        const node = this.net.nodeAt(Math.floor(p.x), Math.floor(p.y));
        if (node?.line) {
          // An inserter drops on the lane farther from itself.
          const away = (isDrop ? facing : ((facing + 2) % 4)) as Card;
          const lane: Lane = laneSide(node.dir, 0) === away ? 0 : 1;
          return { kind: "belt", node, lane };
        }
        return { kind: "other" };
      };
      // Rough hand sizes: the dataset's throughput already includes them,
      // so the swing time is hand / throughput.
      const handSize = e.overrideStackSize ?? (e.name.includes("stack") ? 8 : e.name.includes("bulk") ? 4 : 1);
      const ins: InserterSim = {
        entity: e,
        pickup: target(pickupAt, false),
        drop: target(dropAt, true),
        pickupAt,
        dropAt,
        tripTicks: Math.max(4, Math.round((60 * handSize) / proto.throughput)),
        maxRate: proto.throughput,
        handSize,
        phase: "home",
        t: 0,
        handCount: 0,
        busy: 0,
        moved: 0,
      };
      if (ins.drop.kind === "machine") ins.drop.machine.feeders.push(ins);
      if (ins.pickup.kind === "machine") ins.pickup.machine.takers.push(ins);
      this.inserters.push(ins);
    }

    const items = new Set<string>();
    for (const m of this.machines) for (const i of [...m.ingredients, ...m.products]) items.add(i.name);
    this.knownItems = [...items].sort();
    this.guessInputs();
    // Every open belt end takes everything by default: a pasted blueprint is
    // usually a piece of a bigger factory whose belts carry on off the edge.
    // The Ports window can turn one into a dead end.
    for (const port of this.net.ports) if (port.kind === "output") this.setOutput(port.id, "sink");
  }

  /** Blueprints don't record what's on a belt. Guess each input port's
   *  lanes from what the inserters downstream of it pick up for their
   *  machines — the most wanted item on the left lane, the next on the
   *  right — skipping anything the blueprint makes itself. */
  guessInputs() {
    const madeHere = new Set(this.machines.flatMap((m) => m.products.map((p) => p.name)));
    for (const port of this.net.ports) {
      // The synthetic input behind an unfed splitter half starts empty:
      // nothing is placed there in the blueprint.
      if (port.kind !== "input" || port.line.nodes.length === 0) continue;
      const wanted = new Map<string, number>();
      const seen = new Set<BeltLine>();
      const walk = (line: BeltLine) => {
        if (seen.has(line)) return;
        seen.add(line);
        for (const ins of this.inserters) {
          if (ins.pickup.kind !== "belt" || ins.pickup.node.line !== line || ins.drop.kind !== "machine") continue;
          for (const ing of ins.drop.machine.ingredients) {
            if (!madeHere.has(ing.name)) wanted.set(ing.name, (wanted.get(ing.name) ?? 0) + 1);
          }
        }
        const end = line.end;
        if (end.kind === "line") walk(end.to);
        else if (end.kind === "sideload") end.target.forEach((t) => t && walk(t.line));
        else if (end.kind === "splitter") end.splitter.outputs.forEach(walk);
      };
      walk(port.line);
      const ranked = [...wanted.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      const feed = (name: string | undefined): LaneFeed | null => (name ? { item: name, rate: "full" } : null);
      this.setInput(port.id, feed(ranked[0]), feed(ranked[1] ?? ranked[0]));
    }
  }

  readonly inputs = new Map<string, [LaneFeed | null, LaneFeed | null]>();
  readonly outputs = new Map<string, "sink" | "blocked">();

  setInput(portId: string, left: LaneFeed | null, right: LaneFeed | null) {
    this.inputs.set(portId, [left, right]);
    this.belts.setInput(portId, left, right);
  }

  setOutput(portId: string, mode: "sink" | "blocked") {
    this.outputs.set(portId, mode);
    this.belts.setOutput(portId, mode);
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

  private limitFor(m: MachineSim, name: string): number {
    const ing = m.ingredients.find((i) => i.name === name);
    const hands = Math.max(1, ...m.feeders.map((f) => f.handSize));
    return ing ? Math.max(2, Math.ceil(ing.amount * 2), hands) : 0;
  }

  /** A machine stops once its output holds a few crafts' worth — or two
   *  hands' worth for whatever arm empties it, so big hands still fill. */
  private outputFull(m: MachineSim): boolean {
    const hands = Math.max(1, ...m.takers.map((t) => t.handSize));
    return m.products.some((p) => (m.out.get(p.name) ?? 0) >= Math.max(4, Math.ceil(p.amount * 3), hands * 2));
  }

  private stepMachine(m: MachineSim) {
    const tryStart = () => {
      if (m.crafting || this.outputFull(m)) return;
      for (const ing of m.ingredients) {
        if ((m.buffer.get(ing.name) ?? 0) < Math.ceil(ing.amount - 1e-9)) {
          m.missing = ing.name;
          return;
        }
      }
      for (const ing of m.ingredients) m.buffer.set(ing.name, (m.buffer.get(ing.name) ?? 0) - Math.ceil(ing.amount - 1e-9));
      m.crafting = true;
      m.progress = 0;
    };
    tryStart();
    if (m.crafting) {
      m.progress++;
      if (m.progress >= m.craftTicks) {
        for (const p of m.products) {
          const total = (m.outFraction.get(p.name) ?? 0) + p.amount;
          const whole = Math.floor(total + 1e-9);
          m.outFraction.set(p.name, total - whole);
          m.out.set(p.name, (m.out.get(p.name) ?? 0) + whole);
        }
        m.crafting = false;
        tryStart();
      }
    }
    const working = m.crafting ? 1 : 0;
    let arm = 0;
    let starved = 0;
    let full = 0;
    if (!working) {
      if (this.outputFull(m)) full = 1;
      else if (m.feeders.some((f) => f.phase !== "home")) arm = 1;
      else starved = 1;
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
    if (d.kind === "machine") return d.machine.ingredients.some((i) => i.name === item) && (d.machine.buffer.get(item) ?? 0) < this.limitFor(d.machine, item);
    return true;
  }

  private stepInserter(ins: InserterSim) {
    const half = ins.tripTicks / 2;
    let delivered = 0;
    if (ins.phase === "home") {
      const p = ins.pickup;
      let got: string | undefined;
      let count = 0;
      if (p.kind === "machine") {
        for (const prod of p.machine.products) {
          const have = p.machine.out.get(prod.name) ?? 0;
          if (have > 0 && this.wants(ins, prod.name)) {
            count = Math.min(have, ins.handSize);
            p.machine.out.set(prod.name, have - count);
            got = prod.name;
            break;
          }
        }
      } else if (p.kind === "belt") {
        got = this.belts.takeFromTile(p.node, (item) => this.wants(ins, item));
        if (got) {
          count = 1;
          while (count < ins.handSize && this.belts.takeFromTile(p.node, (item) => item === got && this.wants(ins, item))) count++;
        }
      }
      if (got) {
        ins.hand = got;
        ins.handCount = count;
        ins.phase = "out";
        ins.t = half;
      }
    } else if (ins.phase === "out") {
      if (--ins.t <= 0) ins.phase = "drop";
    } else if (ins.phase === "drop") {
      const d = ins.drop;
      if (d.kind === "machine") {
        d.machine.buffer.set(ins.hand!, (d.machine.buffer.get(ins.hand!) ?? 0) + ins.handCount);
        delivered = ins.handCount;
        ins.handCount = 0;
      } else if (d.kind === "belt") {
        // One item per tick, as space opens up under the hand.
        if (this.belts.dropOnTile(d.node, d.lane, ins.hand!)) {
          ins.handCount--;
          delivered = 1;
        }
      } else {
        delivered = ins.handCount;
        ins.handCount = 0;
      }
      if (ins.handCount === 0) {
        ins.hand = undefined;
        ins.phase = "back";
        ins.t = half;
      }
    } else if (--ins.t <= 0) ins.phase = "home";
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
