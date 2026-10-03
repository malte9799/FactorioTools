import { lanePoint, type BeltLine, type BeltNetwork, type BeltNode, type Lane, type LaneGeometry, type Port, type Splitter } from "./network.js";
import { ITEM_SPACING as SP, TICKS_PER_SECOND } from "./units.js";

/** What an input port pushes onto one lane: an item, either as fast as the
 *  lane accepts ("full", an infinitely compressed belt upstream) or at a
 *  fixed items/second. */
export interface LaneFeed {
  item: string;
  rate: "full" | number;
  /** Items per belt slot (Space Age belt stacking, 1–4). Default 1. A rate
   *  counts items, not slots. */
  stack?: number;
}

/** A belt slot holds one item kind and a stack of 1–4 of it (Space Age belt
 *  stacking). Packed into one number so every hand-over carries the stack
 *  without knowing about it. */
const pack = (id: number, count: number) => id * 8 + count;
const idOf = (v: number) => v >> 3;
const countOf = (v: number) => v & 7;
export const MAX_BELT_STACK = 4;

/** What an output port does with items reaching it: take everything (the
 *  default — a blueprint fragment's belts usually continue off the edge),
 *  take nothing (a real dead end), or take a fixed items/second. */
export type OutputMode = "sink" | "blocked" | { rate: number };

/** Rate-limit token buckets accumulate 1/60ths; compare with a tolerance
 *  so 15 additions of 1/15 count as a whole item. */
const EPS = 1e-9;

const stackOf = (feed: LaneFeed) => Math.max(1, Math.min(MAX_BELT_STACK, Math.round(feed.stack ?? 1)));

interface SplitDecision {
  tick: number;
  assign: [Lane | undefined, Lane | undefined];
}

interface SideloadPoint {
  pos: number;
  feeders: LaneState[];
  /** Recomputed each tick: a feeder item is at or about to reach the join. */
  reserved: boolean;
}

/** Items on one lane, front (largest position) first. `item` holds packed
 *  (item id, stack count) slots. */
class LaneState {
  pos: number[] = [];
  item: number[] = [];
  readonly length: number;
  readonly speed: number;
  readonly starts: number[];
  readonly mids: number[];
  /** Items that crossed each segment's midpoint since the last reset. */
  readonly crossings: Uint32Array;
  readonly joins: SideloadPoint[] = [];

  constructor(readonly geo: LaneGeometry, speed: number) {
    this.length = geo.length;
    this.speed = speed;
    this.starts = geo.segments.map((s) => s.start);
    this.mids = geo.segments.map((s) => s.start + s.length / 2);
    this.crossings = new Uint32Array(geo.segments.length);
  }

  segAt(p: number): number {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]! <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Moves item i forward to p, counting any segment midpoint it passes. */
  moveTo(i: number, p: number) {
    const old = this.pos[i]!;
    for (let k = this.segAt(old); k < this.mids.length && this.starts[k]! <= p; k++) {
      const m = this.mids[k]!;
      if (old < m && p >= m) this.crossings[k]! += countOf(this.item[i]!);
    }
    this.pos[i] = p;
  }

  /** Inserts keeping front-first order; counts the item for its segment if it
   *  lands exactly on that segment's midpoint (a side-load join). */
  insert(p: number, slot: number) {
    let i = 0;
    while (i < this.pos.length && this.pos[i]! > p) i++;
    this.pos.splice(i, 0, p);
    this.item.splice(i, 0, slot);
    const k = this.segAt(p);
    if (this.mids[k] === p) this.crossings[k]! += countOf(slot);
  }

  /** Inserts at `p` if the item ahead is a full spacing away, shoving the
   *  items behind back into the slack behind them as needed. No item moves
   *  back a whole slot (that would make room on a compressed belt) or off
   *  the lane's start. A shove back over a segment's midpoint takes that
   *  crossing back, so the item isn't counted twice. */
  insertShoving(p: number, slot: number): boolean {
    let i = 0;
    while (i < this.pos.length && this.pos[i]! >= p) i++;
    if (i > 0 && this.pos[i - 1]! - p < SP) return false;
    const moved: number[] = [];
    let limit = p;
    for (let k = i; k < this.pos.length; k++) {
      const q = this.pos[k]!;
      const to = Math.min(q, limit - SP);
      if (to === q) break;
      if (q - to >= SP || to < 0) return false;
      moved.push(to);
      limit = to;
    }
    moved.forEach((to, n) => {
      const k = i + n;
      const old = this.pos[k]!;
      for (let s = this.segAt(to); s < this.mids.length && this.starts[s]! <= old; s++) {
        const m = this.mids[s]!;
        if (to < m && old >= m) this.crossings[s] = Math.max(0, this.crossings[s]! - countOf(this.item[k]!));
      }
      this.pos[k] = to;
    });
    this.insert(p, slot);
    return true;
  }

  hasRoomAt(p: number): boolean {
    for (const q of this.pos) {
      if (Math.abs(q - p) < SP) return false;
      if (q < p - SP) break;
    }
    return true;
  }

  /** Where an item handed over `over` units past this lane's start lands:
   *  as far as it got, or less if the rearmost item is in the way (it was
   *  blocked part of the tick). -1 when there is no room at all. */
  landingFor(over: number): number {
    const n = this.pos.length;
    if (n === 0) return over;
    const room = this.pos[n - 1]! - SP;
    return room < 0 ? -1 : Math.min(over, room);
  }

  shift(): number {
    this.pos.shift();
    return this.item.shift()!;
  }
}

export interface PortStats {
  /** Items that entered (input) or left (output) through this port since the
   *  last counter reset. */
  count: number;
}

export class BeltSim {
  tick = 0;
  /** Ticks since the last counter reset. */
  window = 0;
  readonly items: string[] = [];
  private readonly itemIds = new Map<string, number>();
  private readonly lanes = new Map<BeltLine, [LaneState, LaneState]>();
  private readonly inputs = new Map<string, { lanes: [LaneFeed | null, LaneFeed | null]; tokens: [number, number] }>();
  private readonly outputs = new Map<string, { mode: OutputMode; tokens: number }>();
  private readonly portCounts = new Map<string, number>();
  /** Items through each port since the start, by item id. Unlike
   *  portCounts these never reset, so a caller can sample them at its own
   *  pace and take differences. */
  private readonly portItemTotals = new Map<string, Map<number, number>>();
  private readonly splitterState = new Map<
    Splitter,
    { input: [Lane, Lane]; output: [Lane, Lane]; decided: [SplitDecision, SplitDecision] }
  >();
  private readonly sideloadOrder = new Map<BeltLine, Lane>();

  constructor(readonly network: BeltNetwork) {
    this.order = BeltSim.downstreamFirst(network);
    for (const line of network.lines) {
      this.lanes.set(line, [new LaneState(line.lanes[0], line.speed), new LaneState(line.lanes[1], line.speed)]);
    }
    for (const line of network.lines) {
      if (line.end.kind !== "sideload") continue;
      this.sideloadOrder.set(line, 0);
      line.end.target.forEach((entry, feederLane) => {
        if (!entry) return;
        const target = this.lane(entry.line, entry.lane);
        let join = target.joins.find((j) => j.pos === entry.pos);
        if (!join) {
          join = { pos: entry.pos, feeders: [], reserved: false };
          target.joins.push(join);
        }
        join.feeders.push(this.lane(line, feederLane as Lane));
      });
    }
    for (const s of network.splitters) {
      const fresh = (): SplitDecision => ({ tick: -1, assign: [undefined, undefined] });
      this.splitterState.set(s, { input: [0, 0], output: [0, 0], decided: [fresh(), fresh()] });
    }
    for (const p of network.ports) {
      this.portCounts.set(p.id, 0);
      if (p.kind === "output") this.outputs.set(p.id, { mode: "sink", tokens: 0 });
    }
  }

  itemId(name: string): number {
    let id = this.itemIds.get(name);
    if (id === undefined) {
      id = this.items.length;
      this.items.push(name);
      this.itemIds.set(name, id);
    }
    return id;
  }

  private lane(line: BeltLine, lane: Lane): LaneState {
    return this.lanes.get(line)![lane];
  }

  port(id: string): Port {
    const p = this.network.ports.find((q) => q.id === id);
    if (!p) throw new Error(`no port ${id}`);
    return p;
  }

  /** Configures what an input port feeds, per lane (left, right). */
  setInput(portId: string, left: LaneFeed | null, right: LaneFeed | null) {
    if (this.port(portId).kind !== "input") throw new Error(`${portId} is not an input`);
    const prev = this.inputs.get(portId);
    this.inputs.set(portId, { lanes: [left, right], tokens: prev?.tokens ?? [0, 0] });
    for (const f of [left, right]) if (f) this.itemId(f.item);
  }

  setOutput(portId: string, mode: OutputMode) {
    if (this.port(portId).kind !== "output") throw new Error(`${portId} is not an output`);
    this.outputs.set(portId, { mode, tokens: 0 });
  }

  step(ticks = 1) {
    for (let t = 0; t < ticks; t++) this.stepOnce();
  }

  /** Lines ordered downstream first, so by the time a line hands an item
   *  over, the line receiving it has already moved this tick and its gaps
   *  are final. Inside a loop the order is arbitrary. */
  private readonly order: BeltLine[];

  private static downstreamFirst(network: BeltNetwork): BeltLine[] {
    const next = (l: BeltLine): BeltLine[] => {
      const e = l.end;
      if (e.kind === "line") return [e.to];
      if (e.kind === "sideload") return e.target.flatMap((t) => (t ? [t.line] : []));
      if (e.kind === "splitter") return [...e.splitter.outputs];
      return [];
    };
    const out: BeltLine[] = [];
    const seen = new Set<BeltLine>();
    const visit = (l: BeltLine) => {
      if (seen.has(l)) return;
      seen.add(l);
      next(l).forEach(visit);
      out.push(l);
    };
    network.lines.forEach(visit);
    return out;
  }

  private stepOnce() {
    // A side-load holds back the lane it joins while one of its items is at
    // or about to reach the join: side-loading has priority over items
    // coming straight through.
    for (const [a, b] of this.lanes.values()) {
      for (const lane of [a, b]) {
        for (const j of lane.joins) {
          j.reserved = j.feeders.some((f) => f.pos.length > 0 && f.pos[0]! >= f.length - SP);
        }
      }
    }

    for (const line of this.order) {
      let first: Lane = 0;
      if (line.end.kind === "sideload") {
        // Both feeder lanes may merge into one target lane; take turns at
        // who gets the first try.
        first = this.sideloadOrder.get(line)!;
        this.sideloadOrder.set(line, (1 - first) as Lane);
      }
      this.moveLane(line, first);
      this.moveLane(line, (1 - first) as Lane);
    }

    for (const out of this.outputs.values()) {
      // A rate counts items, so the bucket holds up to one full stack.
      if (typeof out.mode === "object") out.tokens = Math.min(MAX_BELT_STACK, out.tokens + out.mode.rate / TICKS_PER_SECOND);
    }

    // Input ports fill in behind whatever just moved.
    for (const line of this.network.lines) {
      if (line.start.kind !== "open") continue;
      const cfg = this.inputs.get(line.start.port.id);
      if (!cfg) continue;
      for (const lane of [0, 1] as const) {
        const feed = cfg.lanes[lane];
        if (!feed) continue;
        const dst = this.lane(line, lane);
        const n = dst.pos.length;
        const rear = n ? dst.pos[n - 1]! : Infinity;
        if (feed.rate === "full") {
          // An endless compressed belt upstream: the next item sits exactly
          // one spacing behind the rearmost as soon as that fits on the lane.
          if (rear >= SP) this.pushRear(dst, n ? rear - SP : 0, feed, line.start.port.id);
        } else {
          const stack = stackOf(feed);
          cfg.tokens[lane] = Math.min(stack, cfg.tokens[lane] + feed.rate / TICKS_PER_SECOND);
          if (cfg.tokens[lane] >= stack - EPS && rear >= SP) {
            cfg.tokens[lane] -= stack;
            this.pushRear(dst, 0, feed, line.start.port.id);
          }
        }
      }
    }

    this.tick++;
    this.window++;
  }

  private pushRear(dst: LaneState, p: number, feed: LaneFeed, portId: string) {
    const stack = stackOf(feed);
    dst.pos.push(p);
    dst.item.push(pack(this.itemId(feed.item), stack));
    this.portCounts.set(portId, this.portCounts.get(portId)! + stack);
    this.addPortTotal(portId, this.itemId(feed.item), stack);
  }

  private addPortTotal(portId: string, itemId: number, count: number) {
    let totals = this.portItemTotals.get(portId);
    if (!totals) this.portItemTotals.set(portId, (totals = new Map()));
    totals.set(itemId, (totals.get(itemId) ?? 0) + count);
  }

  /** Moves every item on one lane, front first. An item reaching the end is
   *  handed over there and then, or waits one unit short of the end, so a
   *  lane of length L holds exactly L / spacing items. */
  private moveLane(line: BeltLine, laneIdx: Lane) {
    const lane = this.lane(line, laneIdx);
    const { pos, speed, length } = lane;
    const capAt = (p: number, cap: number) => {
      for (const j of lane.joins) if (j.reserved && p <= j.pos - SP) cap = Math.min(cap, j.pos - SP);
      return cap;
    };
    let i = 0;
    while (i < pos.length) {
      const p = pos[i]!;
      const want = p + speed;
      if (i === 0) {
        const cap = capAt(p, length - 1);
        if (want >= length && cap === length - 1 && this.handOver(line, laneIdx, want - length, lane.item[0]!)) {
          lane.moveTo(0, length - 1);
          lane.shift();
          continue;
        }
        const next = Math.min(want, cap);
        if (next > p) lane.moveTo(0, next);
      } else {
        const next = Math.min(want, capAt(p, pos[i - 1]! - SP));
        if (next > p) lane.moveTo(i, next);
      }
      i++;
    }
  }

  /** Tries to hand the front item of a lane to whatever its line ends in,
   *  landing `over` units past the receiving point. */
  private handOver(line: BeltLine, laneIdx: Lane, over: number, item: number): boolean {
    const end = line.end;
    switch (end.kind) {
      case "open": {
        const out = this.outputs.get(end.port.id)!;
        let take = out.mode === "sink";
        if (typeof out.mode === "object" && out.tokens >= countOf(item) - EPS) {
          out.tokens -= countOf(item);
          take = true;
        }
        if (take) {
          this.portCounts.set(end.port.id, this.portCounts.get(end.port.id)! + countOf(item));
          this.addPortTotal(end.port.id, idOf(item), countOf(item));
        }
        return take;
      }
      case "line": {
        const target = this.lane(end.to, laneIdx);
        // A closed loop receives into its own rear, which hasn't moved yet
        // this tick — conservative by at most one tick per item. Its front
        // item is the one being handed over, so it is not in the way.
        const at = end.to === line && target.pos.length === 1 ? over : target.landingFor(over);
        if (at < 0) return false;
        target.pos.push(at);
        target.item.push(item);
        return true;
      }
      case "sideload": {
        const entry = end.target[laneIdx];
        if (!entry) return false;
        const target = this.lane(entry.line, entry.lane);
        if (!target.hasRoomAt(entry.pos)) return false;
        target.insert(entry.pos, item);
        return true;
      }
      case "splitter": {
        const outSide = this.splitterDecision(end.splitter, laneIdx)[end.side];
        if (outSide === undefined) return false;
        const dst = this.lane(end.splitter.outputs[outSide], laneIdx);
        dst.pos.push(dst.landingFor(over));
        dst.item.push(item);
        return true;
      }
    }
  }

  /** Decides, once per tick and lane, which output each of a splitter's two
   *  inputs sends its arriving item to (undefined = it waits). The inputs
   *  take turns, or the priority input goes first; each item goes to the
   *  outputs in turn, or to the priority output first; a filter sends its
   *  item only to the priority side and everything else only to the other.
   *  Lanes never mix. Outputs are downstream, so they have already moved
   *  and their room is final. */
  private splitterDecision(s: Splitter, laneIdx: Lane): [Lane | undefined, Lane | undefined] {
    const st = this.splitterState.get(s)!;
    const memo = st.decided[laneIdx];
    if (memo.tick === this.tick) return memo.assign;
    const side = (p: "left" | "right" | undefined) => (p === "right" ? 1 : 0) as Lane;
    const filterId = s.filter !== undefined ? this.itemId(s.filter) : undefined;
    const assign: [Lane | undefined, Lane | undefined] = [undefined, undefined];
    const taken = [false, false];
    const inOrder: Lane[] = s.inputPriority ? [side(s.inputPriority), (1 - side(s.inputPriority)) as Lane] : [st.input[laneIdx], (1 - st.input[laneIdx]) as Lane];
    for (const inSide of inOrder) {
      const src = this.lane(s.inputs[inSide], laneIdx);
      if (!src.pos.length || src.pos[0]! + src.speed < src.length) continue;
      const over = src.pos[0]! + src.speed - src.length;
      const item = src.item[0]!;
      let outOrder: Lane[];
      if (filterId !== undefined) {
        const prio = side(s.outputPriority);
        outOrder = [idOf(item) === filterId ? prio : ((1 - prio) as Lane)];
      } else if (s.outputPriority) {
        const prio = side(s.outputPriority);
        outOrder = [prio, (1 - prio) as Lane];
      } else {
        outOrder = [st.output[laneIdx], (1 - st.output[laneIdx]) as Lane];
      }
      for (const outSide of outOrder) {
        if (taken[outSide] || this.lane(s.outputs[outSide], laneIdx).landingFor(over) < 0) continue;
        assign[inSide] = outSide;
        taken[outSide] = true;
        if (filterId === undefined && !s.outputPriority) st.output[laneIdx] = (1 - outSide) as Lane;
        if (!s.inputPriority) st.input[laneIdx] = (1 - inSide) as Lane;
        break;
      }
    }
    memo.tick = this.tick;
    memo.assign = assign;
    return assign;
  }

  /* ---------- belt tiles, for inserters and overlays ---------- */

  /** Index of the segment that lies on `node`'s own tile (never the tunnel
   *  in front of an underground exit). */
  segmentOf(node: BeltNode, lane: Lane): number {
    return node.line!.lanes[lane].segments.findIndex((s) => s.node === node && s.kind !== "tunnel");
  }

  /** Takes up to `max` items of one kind from one belt tile (either lane,
   *  front-most slot first, splitting a stack if needed) that `accept`
   *  agrees to — an inserter's pickup. */
  takeFromTile(node: BeltNode, accept: (item: string) => boolean, max = 1): { item: string; count: number } | undefined {
    let taken: string | undefined;
    let count = 0;
    for (const laneIdx of [0, 1] as const) {
      const lane = this.lane(node.line!, laneIdx);
      const seg = node.line!.lanes[laneIdx].segments[this.segmentOf(node, laneIdx)]!;
      for (let i = 0; i < lane.pos.length && count < max; i++) {
        const p = lane.pos[i]!;
        if (p >= seg.start + seg.length) continue;
        if (p < seg.start) break;
        const slot = lane.item[i]!;
        const name = this.items[idOf(slot)]!;
        if (taken ? name !== taken : !accept(name)) continue;
        taken = name;
        const n = Math.min(countOf(slot), max - count);
        count += n;
        if (n < countOf(slot)) lane.item[i] = slot - n;
        else {
          lane.pos.splice(i, 1);
          lane.item.splice(i, 1);
          i--;
        }
      }
    }
    return taken ? { item: taken, count } : undefined;
  }

  /** Puts a stack of up to four items down in the middle of one lane of a
   *  belt tile, if there is room — an inserter's drop. With `spread`, the
   *  hand can also let go anywhere up to 3/8 of a tile upstream of the
   *  middle, as close behind the items already there as fits. That's
   *  room for one more item right away on a fresh gap, then one each time
   *  the belt carries the last one a slot further: an arm empties its hand
   *  faster on a faster belt. Fitted to in-game chest-to-belt rates on
   *  yellow and turbo belts.
   *
   *  Items behind the drop spot are shoved back into whatever slack they
   *  have, so a hand fills the gaps a belt speed-up leaves (a compressed
   *  red lane runs onto blue at 1.5 spacings apart) — too small for a whole
   *  item, but enough once the next item gives up the rest. */
  dropOnTile(node: BeltNode, laneIdx: Lane, item: string, count = 1, spread = false): boolean {
    const lane = this.lane(node.line!, laneIdx);
    const seg = node.line!.lanes[laneIdx].segments[this.segmentOf(node, laneIdx)]!;
    const mid = seg.start + seg.length / 2;
    const back = mid - Math.round((seg.length * 3) / 8);
    // Front-most first: the middle, then right behind each item in reach.
    const spots = [mid];
    if (spread) for (const q of lane.pos) if (q - SP < mid && q - SP >= back) spots.push(q - SP);
    const slot = pack(this.itemId(item), Math.max(1, Math.min(MAX_BELT_STACK, count)));
    return spots.some((q) => lane.insertShoving(q, slot));
  }

  /** Slots used on one lane of a belt tile, how many fit, and how many items
   *  those slots hold. */
  tileLoad(node: BeltNode, laneIdx: Lane): { count: number; capacity: number; items: number } {
    const lane = this.lane(node.line!, laneIdx);
    const seg = node.line!.lanes[laneIdx].segments[this.segmentOf(node, laneIdx)]!;
    let count = 0;
    let items = 0;
    lane.pos.forEach((p, i) => {
      if (p >= seg.start && p < seg.start + seg.length) {
        count++;
        items += countOf(lane.item[i]!);
      }
    });
    return { count, capacity: seg.length / SP, items };
  }

  /** Cumulative midpoint crossings per segment of a lane since the last
   *  reset. A caller sampling this over time gets a rolling rate without
   *  resetting anyone else's window. */
  laneCrossings(line: BeltLine, laneIdx: Lane): Readonly<Uint32Array> {
    return this.lane(line, laneIdx).crossings;
  }

  /* ---------- reading results ---------- */

  resetCounters() {
    this.window = 0;
    for (const [a, b] of this.lanes.values()) {
      a.crossings.fill(0);
      b.crossings.fill(0);
    }
    for (const id of this.portCounts.keys()) this.portCounts.set(id, 0);
  }

  /** Items/second through each segment (tile) of a lane over the counter
   *  window, measured at the segment's midpoint. */
  laneRates(line: BeltLine, lane: Lane): number[] {
    const w = Math.max(1, this.window);
    return [...this.lane(line, lane).crossings].map((c) => (c * TICKS_PER_SECOND) / w);
  }

  /** Items/second through a port over the counter window. */
  portRate(portId: string): number {
    return (this.portCounts.get(portId)! * TICKS_PER_SECOND) / Math.max(1, this.window);
  }

  /** Items that have entered (input) or left (output) through a port since
   *  the simulation began, by item name. */
  portTotals(portId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, n] of this.portItemTotals.get(portId) ?? []) out.set(this.items[id]!, n);
    return out;
  }

  /** Current slots on a lane, front first. */
  laneItems(line: BeltLine, lane: Lane): { pos: number; item: string; count: number }[] {
    const l = this.lane(line, lane);
    return l.pos.map((p, i) => ({ pos: p, item: this.items[idOf(l.item[i]!)]!, count: countOf(l.item[i]!) }));
  }

  forEachItem(cb: (x: number, y: number, item: string, hidden: boolean, count: number) => void) {
    for (const [line, [a, b]] of this.lanes) {
      for (const [l, geo] of [[a, line.lanes[0]], [b, line.lanes[1]]] as const) {
        for (let i = 0; i < l.pos.length; i++) {
          const pt = lanePoint(geo, l.pos[i]!);
          cb(pt.x, pt.y, this.items[idOf(l.item[i]!)]!, pt.hidden, countOf(l.item[i]!));
        }
      }
    }
  }
}
