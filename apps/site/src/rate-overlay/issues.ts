/** Jam trace (concept D): turns the live model into a short, ranked list of
 *  what costs output, each with a path from the symptom to its cause drawn
 *  along the real belt lines. */
import type { GameData } from "@factoriotools/engine";
import { lanePoint, type BeltLine, type BeltNode } from "@factoriotools/sim";
import { machineStatus, type InserterSim, type LabFactory, type MachineSim } from "./factory.js";

export type Tone = "bad" | "warn" | "held" | "ok";

export interface TraceStep {
  at: { x: number; y: number };
  label: string;
  tone: Tone;
}

export interface Issue {
  id: string;
  tone: Tone;
  title: string;
  /** Output lost, in the machines' main product per second. */
  lost: number;
  machines: MachineSim[];
  path: { x: number; y: number }[];
  steps: TraceStep[];
  /** Belt tiles along the trace, highlighted by the lane layer. */
  nodes: Set<BeltNode>;
  focus: { minX: number; minY: number; maxX: number; maxY: number };
}

const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const centre = (m: MachineSim) => ({ x: m.entity.x, y: m.entity.y });
const at = (e: { x: number; y: number }) => ({ x: e.x, y: e.y });

export function itemLabel(data: GameData, name: string): string {
  // Placeable items (an inserter, a belt) carry their bare internal name in
  // the dataset; their building has the real one.
  const own = data.items[name]?.localised;
  if (own && own !== name) return own;
  const building = data.inserters[name]?.localised ?? data.belts[name]?.localised ?? data.machines[name]?.localised;
  return building ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");
}
export function recipeLabel(data: GameData, name: string): string {
  return data.recipes[name]?.localised ?? name;
}

/** Walks a belt upstream from `node` to where its items come from, returning
 *  the lane-centre path and the origin it reached. */
function walkUpstream(node: BeltNode) {
  const path: { x: number; y: number }[] = [];
  const nodes = new Set<BeltNode>();
  let line: BeltLine = node.line!;
  let fromSeg = line.lanes[0].segments.findIndex((s) => s.node === node && s.kind !== "tunnel");
  for (let hops = 0; hops < 8; hops++) {
    const segs = line.lanes[0].segments;
    for (let k = fromSeg; k >= 0; k--) {
      const s = segs[k]!;
      if (s.node) nodes.add(s.node);
      const p = lanePoint(line.lanes[0], s.start + s.length / 2);
      path.push({ x: p.x, y: p.y });
    }
    const start = line.start;
    if (start.kind === "line" && start.from !== line) {
      line = start.from;
      fromSeg = line.lanes[0].segments.length - 1;
      continue;
    }
    return { path, nodes, origin: start, line };
  }
  return { path, nodes, origin: line.start, line };
}

/** Walks a belt downstream from `node` until it ends. */
function walkDownstream(node: BeltNode) {
  const path: { x: number; y: number }[] = [];
  const nodes = new Set<BeltNode>();
  let line: BeltLine = node.line!;
  let fromSeg = line.lanes[0].segments.findIndex((s) => s.node === node && s.kind !== "tunnel");
  for (let hops = 0; hops < 8; hops++) {
    const segs = line.lanes[0].segments;
    for (let k = fromSeg; k < segs.length; k++) {
      const s = segs[k]!;
      if (s.node) nodes.add(s.node);
      const p = lanePoint(line.lanes[0], s.start + s.length / 2);
      path.push({ x: p.x, y: p.y });
    }
    const end = line.end;
    if (end.kind === "line" && end.to !== line) {
      line = end.to;
      fromSeg = 0;
      continue;
    }
    return { path, nodes, end, line };
  }
  return { path, nodes, end: line.end, line };
}

function boxAround(points: { x: number; y: number }[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs) - 2, minY: Math.min(...ys) - 2, maxX: Math.max(...xs) + 2, maxY: Math.max(...ys) + 2 };
}

export function detectIssues(f: LabFactory): Issue[] {
  const data = f.data;
  const issues: Issue[] = [];
  const groups = new Map<string, MachineSim[]>();
  for (const m of f.machines) {
    const st = machineStatus(m);
    if (st === "working" || st === "idle") continue;
    const key = `${st}|${m.recipe}|${st === "starved" ? m.missing ?? "" : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  for (const [key, ms] of groups) {
    const [status, recipe, missing] = key.split("|") as [string, string, string];
    const worst = ms.reduce((a, b) => (b.uptime < a.uptime ? b : a));
    const lost = ms.reduce((s, m) => s + Math.max(0, f.machineMaxRate(m) - f.machineRate(m)), 0);
    const n = ms.length > 1 ? `${ms.length} × ` : "";
    const steps: TraceStep[] = [{ at: centre(worst), label: `${pct(worst.uptime)} up`, tone: status === "arm" ? "warn" : "bad" }];
    let path: { x: number; y: number }[] = [centre(worst)];
    let nodes = new Set<BeltNode>();

    if (status === "starved") {
      const item = missing || worst.ingredients[0]?.name || "";
      const feeder = worst.feeders.find((i) => i.pickup.kind === "belt") ?? worst.feeders[0];
      if (!feeder) {
        steps.push({ at: centre(worst), label: `Nothing brings ${itemLabel(data, item)}`, tone: "bad" });
      } else {
        steps.push({ at: at(feeder.entity), label: `Arm idle ${pct(1 - feeder.busy)}`, tone: "bad" });
        path.push(at(feeder.entity));
        if (feeder.pickup.kind === "belt") {
          const node = feeder.pickup.node;
          const passing = f.tileRate(node, 0) + f.tileRate(node, 1);
          steps.push({ at: { x: node.x + 0.5, y: node.y + 0.5 }, label: `${fmt(passing)}/s passing here`, tone: passing < 0.05 ? "bad" : "warn" });
          const up = walkUpstream(node);
          path = [...path, ...up.path];
          nodes = up.nodes;
          const upstreamTakers = f.inserters.filter((i) => i !== feeder && i.pickup.kind === "belt" && up.nodes.has(i.pickup.node) && i.busy > 0.05);
          if (upstreamTakers.length) {
            const taken = upstreamTakers.reduce((s, i) => s + i.moved, 0);
            const first = upstreamTakers[upstreamTakers.length - 1]!;
            steps.push({ at: at(first.entity), label: `${upstreamTakers.length} arms upstream take ${fmt(taken)}/s`, tone: "warn" });
          }
          const last = up.path[up.path.length - 1] ?? at(feeder.entity);
          if (up.origin.kind === "splitter") {
            const s = up.origin.splitter;
            const pos = { x: (s.halves[0].x + s.halves[1].x) / 2 + 0.5, y: (s.halves[0].y + s.halves[1].y) / 2 + 0.5 };
            path.push(pos);
            steps.push({ at: pos, label: s.outputPriority ? `Splitter favours the ${s.outputPriority}` : "Splitter sends half the other way", tone: "bad" });
          } else if (up.origin.kind === "open") {
            const feed = f.inputs.get(up.origin.port.id);
            const lanes = feed ? feed.filter((l) => l?.item === item).length : 0;
            steps.push({
              at: last,
              label: lanes ? `Enters here on ${lanes} lane${lanes > 1 ? "s" : ""}` : `No ${itemLabel(data, item)} enters here`,
              tone: lanes ? "warn" : "bad",
            });
          }
        }
      }
      issues.push({
        id: key,
        tone: "bad",
        title: `${n}${recipeLabel(data, recipe)} starved of ${itemLabel(data, item)}`,
        lost,
        machines: ms,
        path,
        steps,
        nodes,
        focus: boxAround([...path, ...ms.map(centre)]),
      });
    } else if (status === "arm") {
      const arm = worst.feeders.reduce<InserterSim | undefined>((a, b) => (!a || b.busy > a.busy ? b : a), undefined);
      if (arm) {
        const item = worst.ingredients.reduce((a, b) => (f.machineNeed(worst, b.name) > f.machineNeed(worst, a.name) ? b : a)).name;
        path.push(at(arm.entity));
        steps.push({ at: at(arm.entity), label: `Arm busy ${pct(arm.busy)} · max ${fmt(arm.maxRate)}/s`, tone: "warn" });
        steps.push({ at: { x: worst.box.right, y: worst.box.bottom }, label: `Needs ${fmt(f.machineNeed(worst, item))}/s ${itemLabel(data, item)}`, tone: "warn" });
      }
      issues.push({
        id: key,
        tone: "warn",
        title: `${n}${recipeLabel(data, recipe)} limited by ${ms.length > 1 ? "their inserters" : "its inserter"}`,
        lost,
        machines: ms,
        path,
        steps,
        nodes,
        focus: boxAround([...path, ...ms.map(centre)]),
      });
    } else if (status === "output") {
      const taker = worst.takers[0];
      if (!taker) steps.push({ at: centre(worst), label: "No arm takes the output", tone: "bad" });
      else {
        path.push(at(taker.entity));
        steps.push({ at: at(taker.entity), label: taker.phase === "drop" ? "Arm waits to drop" : `Arm busy ${pct(taker.busy)}`, tone: "bad" });
        if (taker.drop.kind === "belt") {
          const down = walkDownstream(taker.drop.node);
          path = [...path, ...down.path];
          nodes = down.nodes;
          const last = down.path[down.path.length - 1] ?? at(taker.entity);
          const endLabel =
            down.end.kind === "open"
              ? f.portEnabled.get(down.end.port.id) === false ? "Belt ends here, blocked" : "Belt leaves here"
              : down.end.kind === "splitter" ? "Into a splitter" : "Side-loads into a full lane";
          steps.push({ at: last, label: `Lane full · ${endLabel}`, tone: "held" });
        } else if (taker.drop.kind === "machine") {
          steps.push({ at: centre(taker.drop.machine), label: "Next machine is full", tone: "held" });
          path.push(centre(taker.drop.machine));
        }
      }
      issues.push({
        id: key,
        tone: "bad",
        title: `${n}${recipeLabel(data, recipe)} can't get rid of output`,
        lost,
        machines: ms,
        path,
        steps,
        nodes,
        focus: boxAround([...path, ...ms.map(centre)]),
      });
    }
  }
  return issues.sort((a, b) => b.lost - a.lost);
}
