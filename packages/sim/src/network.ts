import type { BpSplitterSide, PlacedEntity } from "@factoriotools/engine";
import { cardOf, DX, DY, laneSide, leftOf, opposite, rightOf, type Card } from "./dir.js";
import type { BeltSpecResolver } from "./protos.js";
import { CURVE_INNER_LENGTH, CURVE_OUTER_LENGTH, TILE } from "./units.js";

export type Lane = 0 | 1;

/** One belt-like tile. A splitter contributes two, one per half. */
export interface BeltNode {
  id: number;
  entityNumber: number;
  name: string;
  x: number;
  y: number;
  /** Direction items travel. Both ends of an underground pair store the
   *  travel direction in a 2.0 blueprint (checked against every example
   *  blueprint: 6,400 of 6,735 undergrounds pair that way, 30 the other). */
  dir: Card;
  kind: "belt" | "undergroundIn" | "undergroundOut" | "splitter";
  speed: number;
  /** Undergrounds: the other end of the pair, if one was found in range. */
  pair?: BeltNode;
  /** Splitter halves: which splitter and which half (0 = left of travel). */
  splitter?: Splitter;
  splitterSide?: Lane;
  /** Where this node's output goes. */
  out?: { node: BeltNode; how: "rear" | "side" | "tunnel" | "splitter" };
  /** Node feeding this one straight from behind. */
  rear?: BeltNode;
  /** Nodes feeding into this one's sides. */
  sideIn: BeltNode[];
  /** Set when exactly one side input and no rear input make a belt curve. */
  curveFrom?: BeltNode;
  line?: BeltLine;
}

export interface LaneSegment {
  /** Undefined for the synthetic tile behind an unfed splitter input. */
  node?: BeltNode;
  kind: "straight" | "curve" | "tunnel";
  start: number;
  length: number;
  /** World-space lane centre where the segment starts and ends. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Curves only: the tile corner the lane arcs around. */
  corner?: { x: number; y: number };
  /** Items between these two positions are under an underground's hood or
   *  in its tunnel, so a renderer should not draw them. */
  hidden?: [number, number];
}

export interface LaneGeometry {
  length: number;
  segments: LaneSegment[];
}

export type LineStart =
  | { kind: "open"; port: Port }
  | { kind: "line"; from: BeltLine }
  | { kind: "splitter"; splitter: Splitter; side: Lane };

export type LineEnd =
  | { kind: "open"; port: Port }
  | { kind: "line"; to: BeltLine }
  | { kind: "sideload"; target: SideloadEntry[] }
  | { kind: "splitter"; splitter: Splitter; side: Lane };

/** Where one feeder lane joins a target lane from the side. Index = feeder
 *  lane; undefined when that feeder lane cannot get in (the underground
 *  lane-filter). */
export type SideloadEntry = { line: BeltLine; lane: Lane; pos: number } | undefined;

/** A run of belt pieces items move along without a hand-over: straights,
 *  curves and underground tunnels of one speed. */
export interface BeltLine {
  id: number;
  nodes: BeltNode[];
  speed: number;
  lanes: [LaneGeometry, LaneGeometry];
  start: LineStart;
  end: LineEnd;
}

export interface Splitter {
  id: number;
  entityNumber: number;
  name: string;
  dir: Card;
  speed: number;
  /** [left half, right half], relative to travel. */
  halves: [BeltNode, BeltNode];
  inputs: [BeltLine, BeltLine];
  outputs: [BeltLine, BeltLine];
  inputPriority?: BpSplitterSide;
  outputPriority?: BpSplitterSide;
  filter?: string;
}

/** An open end of the network: somewhere items can enter or leave. */
export interface Port {
  id: string;
  kind: "input" | "output";
  line: BeltLine;
  /** Tile and travel direction at the open end, for placing a UI tab. */
  x: number;
  y: number;
  dir: Card;
}

export interface BeltNetwork {
  nodes: BeltNode[];
  lines: BeltLine[];
  splitters: Splitter[];
  ports: Port[];
  nodeAt(x: number, y: number): BeltNode | undefined;
}

const key = (x: number, y: number) => `${x},${y}`;
const center = (n: { x: number; y: number }) => ({ x: n.x + 0.5, y: n.y + 0.5 });
const add = (p: { x: number; y: number }, d: Card, k: number) => ({ x: p.x + DX[d] * k, y: p.y + DY[d] * k });

/** Lane centre offset: a quarter tile toward that lane's side. */
const laneOffset = (p: { x: number; y: number }, travel: Card, lane: Lane) => add(p, laneSide(travel, lane), 0.25);

export function buildBeltNetwork(entities: PlacedEntity[], resolve: BeltSpecResolver): BeltNetwork {
  const nodes: BeltNode[] = [];
  const byTile = new Map<string, BeltNode>();
  const splitters: Splitter[] = [];
  const undergroundMax = new Map<BeltNode, number>();

  const addNode = (n: Omit<BeltNode, "id" | "sideIn">) => {
    const node: BeltNode = { ...n, id: nodes.length, sideIn: [] };
    nodes.push(node);
    byTile.set(key(node.x, node.y), node);
    return node;
  };

  for (const e of entities) {
    const spec = resolve(e.name);
    if (!spec) continue;
    const facing = cardOf(e.direction);
    if (spec.kind === "belt") {
      addNode({ entityNumber: e.entityNumber, name: e.name, x: Math.floor(e.x), y: Math.floor(e.y), dir: facing, kind: "belt", speed: spec.speed });
    } else if (spec.kind === "underground") {
      const isOut = e.undergroundType === "output";
      const node = addNode({
        entityNumber: e.entityNumber,
        name: e.name,
        x: Math.floor(e.x),
        y: Math.floor(e.y),
        dir: facing,
        kind: isOut ? "undergroundOut" : "undergroundIn",
        speed: spec.speed,
      });
      undergroundMax.set(node, spec.maxDistance ?? 0);
    } else {
      const splitter = {
        id: splitters.length,
        entityNumber: e.entityNumber,
        name: e.name,
        dir: facing,
        speed: spec.speed,
        inputPriority: e.splitterInputPriority,
        outputPriority: e.splitterOutputPriority,
        filter: e.splitterFilter,
      } as Splitter;
      const halves = ([leftOf(facing), rightOf(facing)] as const).map((side, i) => {
        const c = add({ x: e.x, y: e.y }, side, 0.5);
        return addNode({
          entityNumber: e.entityNumber,
          name: e.name,
          x: Math.floor(c.x),
          y: Math.floor(c.y),
          dir: facing,
          kind: "splitter",
          speed: spec.speed,
          splitter,
          splitterSide: i as Lane,
        });
      });
      splitter.halves = [halves[0]!, halves[1]!];
      splitters.push(splitter);
    }
  }

  // Underground pairing: walk forward from each entrance; the first
  // same-name underground on the axis travelling the same way decides it —
  // an exit pairs, another entrance ends the search. Ones travelling the
  // other way are passed over.
  for (const n of nodes) {
    if (n.kind !== "undergroundIn") continue;
    const max = undergroundMax.get(n) ?? 0;
    for (let k = 1; k <= max; k++) {
      const other = byTile.get(key(n.x + DX[n.dir] * k, n.y + DY[n.dir] * k));
      if (!other || other.name !== n.name || other.dir !== n.dir) continue;
      if (other.kind === "undergroundOut" && !other.pair) {
        n.pair = other;
        other.pair = n;
      }
      break;
    }
  }

  // Outputs.
  for (const t of nodes) {
    if (t.kind === "undergroundIn") {
      if (t.pair) t.out = { node: t.pair, how: "tunnel" };
      continue;
    }
    const n = byTile.get(key(t.x + DX[t.dir], t.y + DY[t.dir]));
    if (!n) continue;
    if (n.dir === t.dir) {
      if (n.kind === "belt" || n.kind === "undergroundIn") t.out = { node: n, how: "rear" };
      else if (n.kind === "splitter") t.out = { node: n, how: "splitter" };
      // An underground exit's back is its hood: nothing enters there.
    } else if (n.dir !== opposite(t.dir) && n.kind !== "splitter") {
      t.out = { node: n, how: "side" };
    }
  }
  for (const t of nodes) {
    if (!t.out) continue;
    if (t.out.how === "rear") t.out.node.rear = t;
    else if (t.out.how === "side") t.out.node.sideIn.push(t);
  }
  // A plain belt with no rear input and exactly one side input curves.
  for (const n of nodes) {
    if (n.kind === "belt" && !n.rear && n.sideIn.length === 1) {
      n.curveFrom = n.sideIn[0]!;
      n.sideIn = [];
    }
  }

  const mainPred = (n: BeltNode): BeltNode | undefined => {
    if (n.kind === "splitter") return undefined;
    if (n.kind === "undergroundOut") return n.pair;
    return n.rear ?? n.curveFrom;
  };
  const mainSucc = (t: BeltNode): BeltNode | undefined => {
    const n = t.out?.node;
    if (!n || n.kind === "splitter" || mainPred(n) !== t || n.speed !== t.speed) return undefined;
    return n;
  };

  // Chains.
  const lines: BeltLine[] = [];
  const chains: BeltNode[][] = [];
  const visited = new Set<BeltNode>();
  const walk = (head: BeltNode) => {
    const chain: BeltNode[] = [];
    for (let n: BeltNode | undefined = head; n && !visited.has(n); n = mainSucc(n)) {
      visited.add(n);
      chain.push(n);
    }
    chains.push(chain);
  };
  for (const n of nodes) {
    const p = mainPred(n);
    if (!p || p.speed !== n.speed) walk(n);
  }
  // Whatever is left sits on a closed loop.
  for (const n of nodes) if (!visited.has(n)) walk(n);

  const ports: Port[] = [];
  for (const chain of chains) {
    const line = { id: lines.length, nodes: chain, speed: chain[0]!.speed } as BeltLine;
    line.lanes = [laneGeometry(chain, 0), laneGeometry(chain, 1)];
    for (const n of chain) n.line = line;
    lines.push(line);
  }

  // Synthetic one-tile input behind any splitter half nothing feeds, so the
  // splitter still has something a port can fill.
  for (const s of splitters) {
    for (const half of s.halves) {
      const behind = byTile.get(key(half.x - DX[half.dir], half.y - DY[half.dir]));
      if (behind?.out?.node === half) continue;
      const line = { id: lines.length, nodes: [], speed: s.speed } as unknown as BeltLine;
      const tile = { x: half.x - DX[half.dir], y: half.y - DY[half.dir] };
      line.lanes = [0, 1].map((lane) => {
        const c = center(tile);
        const seg: LaneSegment = {
          kind: "straight",
          start: 0,
          length: TILE,
          from: laneOffset(add(c, half.dir, -0.5), half.dir, lane as Lane),
          to: laneOffset(add(c, half.dir, 0.5), half.dir, lane as Lane),
        };
        return { length: TILE, segments: [seg] };
      }) as [LaneGeometry, LaneGeometry];
      const port: Port = { id: `in:${half.x},${half.y}`, kind: "input", line, x: tile.x, y: tile.y, dir: half.dir };
      line.start = { kind: "open", port };
      line.end = { kind: "splitter", splitter: s, side: half.splitterSide! };
      ports.push(port);
      lines.push(line);
      s.inputs ??= [] as unknown as Splitter["inputs"];
      s.inputs[half.splitterSide!] = line;
    }
  }

  // Starts and ends.
  for (const line of lines) {
    const head = line.nodes[0];
    const tail = line.nodes[line.nodes.length - 1];
    if (!head || !tail) continue;

    if (head.kind === "splitter") {
      line.start = { kind: "splitter", splitter: head.splitter!, side: head.splitterSide! };
      head.splitter!.outputs ??= [] as unknown as Splitter["outputs"];
      head.splitter!.outputs[head.splitterSide!] = line;
    } else {
      const p = mainPred(head);
      if (p?.line) line.start = { kind: "line", from: p.line };
      else {
        const port: Port = { id: `in:${head.x},${head.y}`, kind: "input", line, x: head.x, y: head.y, dir: head.dir };
        line.start = { kind: "open", port };
        ports.push(port);
      }
    }

    const out = tail.out;
    const next = out?.node;
    if (next && out.how === "splitter") {
      line.end = { kind: "splitter", splitter: next.splitter!, side: next.splitterSide! };
      next.splitter!.inputs ??= [] as unknown as Splitter["inputs"];
      next.splitter!.inputs[next.splitterSide!] = line;
    } else if (next?.line && mainPred(next) === tail) {
      // Straight on or round a curve into another line (a speed change) or
      // back into this one (a closed loop).
      line.end = { kind: "line", to: next.line };
    } else if (next && out.how === "side") {
      line.end = { kind: "sideload", target: sideloadEntries(tail, next) };
    } else {
      const port: Port = { id: `out:${tail.x},${tail.y}`, kind: "output", line, x: tail.x, y: tail.y, dir: tail.dir };
      line.end = { kind: "open", port };
      ports.push(port);
    }
  }

  return { nodes, lines, splitters, ports, nodeAt: (x, y) => byTile.get(key(x, y)) };
}

/** Where each lane of feeder `t` joins `n` from the side. Both feeder lanes
 *  land on `n`'s near lane. A plain belt takes both; an underground end only
 *  has half a tile of open belt (the entrance's back half, the exit's front
 *  half), so only the feeder lane lined up with that half gets in — the
 *  classic underground lane filter. */
function sideloadEntries(t: BeltNode, n: BeltNode): [SideloadEntry, SideloadEntry] {
  const line = n.line!;
  const fromSide = DX[leftOf(n.dir)] === t.x - n.x && DY[leftOf(n.dir)] === t.y - n.y ? leftOf(n.dir) : rightOf(n.dir);
  const lane: Lane = fromSide === leftOf(n.dir) ? 0 : 1;
  const seg = line.lanes[lane].segments.find((s) => s.node === n && s.kind !== "tunnel")!;
  if (n.kind === "belt") {
    const entry = { line, lane, pos: seg.start + seg.length / 2 };
    return [entry, entry];
  }
  const open = n.kind === "undergroundIn" ? opposite(n.dir) : n.dir;
  const pos = seg.start + (n.kind === "undergroundIn" ? TILE / 4 : (TILE * 3) / 4);
  return [laneSide(t.dir, 0) === open ? { line, lane, pos } : undefined, laneSide(t.dir, 1) === open ? { line, lane, pos } : undefined];
}

function laneGeometry(chain: BeltNode[], lane: Lane): LaneGeometry {
  const segments: LaneSegment[] = [];
  let pos = 0;
  const push = (seg: Omit<LaneSegment, "start">) => {
    segments.push({ ...seg, start: pos });
    pos += seg.length;
  };
  for (const n of chain) {
    const c = center(n);
    if (n.kind === "undergroundOut" && n.pair) {
      const gap = Math.max(Math.abs(n.x - n.pair.x), Math.abs(n.y - n.pair.y)) - 1;
      if (gap > 0) {
        push({
          node: n,
          kind: "tunnel",
          length: gap * TILE,
          from: laneOffset(add(center(n.pair), n.dir, 0.5), n.dir, lane),
          to: laneOffset(add(c, n.dir, -0.5), n.dir, lane),
          hidden: [0, gap * TILE],
        });
      }
    }
    if (n.curveFrom) {
      const side = (n.curveFrom.x - n.x === DX[leftOf(n.dir)] && n.curveFrom.y - n.y === DY[leftOf(n.dir)] ? leftOf(n.dir) : rightOf(n.dir)) as Card;
      const heading = opposite(side);
      const from = laneOffset(add(c, side, 0.5), heading, lane);
      const to = laneOffset(add(c, n.dir, 0.5), n.dir, lane);
      const corner = add(add(c, side, 0.5), n.dir, 0.5);
      const inner = Math.hypot(from.x - corner.x, from.y - corner.y) < 0.5;
      push({ node: n, kind: "curve", length: inner ? CURVE_INNER_LENGTH : CURVE_OUTER_LENGTH, from, to, corner });
      continue;
    }
    const seg: Omit<LaneSegment, "start"> = {
      node: n,
      kind: "straight",
      length: TILE,
      from: laneOffset(add(c, n.dir, -0.5), n.dir, lane),
      to: laneOffset(add(c, n.dir, 0.5), n.dir, lane),
    };
    if (n.kind === "undergroundIn" && n.pair) seg.hidden = [TILE / 2, TILE];
    if (n.kind === "undergroundOut" && n.pair) seg.hidden = [0, TILE / 2];
    push(seg);
  }
  return { length: pos, segments };
}

/** World position of a point `pos` along a lane, and whether an
 *  underground hides it there. */
export function lanePoint(geo: LaneGeometry, pos: number): { x: number; y: number; hidden: boolean } {
  const segs = geo.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.start <= pos) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo]!;
  const local = Math.min(Math.max(pos - s.start, 0), s.length);
  const t = local / s.length;
  const hidden = s.hidden !== undefined && local > s.hidden[0] && local < s.hidden[1];
  if (s.kind === "curve" && s.corner) {
    const a0 = Math.atan2(s.from.y - s.corner.y, s.from.x - s.corner.x);
    let a1 = Math.atan2(s.to.y - s.corner.y, s.to.x - s.corner.x);
    if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    if (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const r = Math.hypot(s.from.x - s.corner.x, s.from.y - s.corner.y);
    const a = a0 + (a1 - a0) * t;
    return { x: s.corner.x + Math.cos(a) * r, y: s.corner.y + Math.sin(a) * r, hidden };
  }
  return { x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t, hidden };
}
