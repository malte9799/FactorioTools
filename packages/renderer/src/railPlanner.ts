/** The rail planner: lays a chain of straight, half-diagonal and curved rail
 *  pieces from one rail end toward a target point, the way Factorio's own
 *  rail item does when dragged. Pure functions over railGeometry, no DOM.
 *
 *  The search walks rail ends. Standing on an end heading some direction,
 *  the next piece is any piece one of whose ends sits exactly here facing
 *  back at us; its other end is the next state. A* over those states, costed
 *  by track length plus the prototypes' extra_planner_penalty, finds the
 *  shortest buildable track that gets within reach of the target. */

import {
  isElevatedRail,
  railEnds,
  railLength,
  railName,
  railShape,
  railTiles,
  RAMP_SUPPORT_RANGE,
  SUPPORT_RANGE,
  supportDirection,
  type RailEnd,
  type RailPiece,
  type RailShape,
} from "./railGeometry.js";

/** What a piece stands on, which decides what it collides with: track on
 *  the ground, track up on the deck, or a ramp, which is solid from the
 *  ground to the deck. */
export type RailLevel = "ground" | "elevated" | "ramp";

export function railLevel(name: string): RailLevel {
  return name === "rail-ramp" ? "ramp" : isElevatedRail(name) ? "elevated" : "ground";
}

/** Track pieces per layer, each with its prototype's extra_planner_penalty. */
const SHAPES: { shape: Exclude<RailShape, "ramp">; penalty: number }[] = [
  { shape: "straight", penalty: 0 },
  { shape: "half-diagonal", penalty: 0 },
  { shape: "curved-a", penalty: 0.5 },
  { shape: "curved-b", penalty: 0.5 },
];
const RAMP_PENALTY = 0.5;

interface Step {
  name: string;
  direction: number;
  /** Piece position relative to the end we stand on. */
  dx: number;
  dy: number;
  /** The far end, relative to the end we stand on. */
  ex: number;
  ey: number;
  heading: number;
  elevated: boolean;
  cost: number;
}

/** steps[layer][heading]: every piece that can follow an end heading that
 *  way, on that layer. Built once from railEnds. */
const STEPS: Step[][][] = [0, 1].map((layer) => {
  const elevated = layer === 1;
  const byHeading: Step[][] = Array.from({ length: 16 }, () => []);
  const pieces: { name: string; penalty: number; directions: number[] }[] = SHAPES.map(({ shape, penalty }) => ({
    name: railName(shape, elevated),
    penalty,
    // Straight and half-diagonal pieces repeat after 8; listing 0..6 once
    // keeps the search from trying each placement twice.
    directions: shape === "straight" || shape === "half-diagonal" ? [0, 2, 4, 6] : [0, 2, 4, 6, 8, 10, 12, 14],
  }));
  pieces.push({ name: "rail-ramp", penalty: RAMP_PENALTY, directions: [0, 4, 8, 12] });
  for (const { name, penalty, directions } of pieces) {
    for (const direction of directions) {
      const ends = railEnds(name, direction);
      ends.forEach((near, i) => {
        if (near.elevated !== elevated) return;
        const far = ends[1 - i]!;
        byHeading[(near.dir + 8) % 16]!.push({
          name,
          direction,
          dx: -near.dx,
          dy: -near.dy,
          ex: far.dx - near.dx,
          ey: far.dy - near.dy,
          heading: far.dir,
          elevated: far.elevated,
          cost: railLength(name, direction) + penalty,
        });
      });
    }
  }
  return byHeading;
});

/** The rail item's manual_length_limit: how much track one placement lays
 *  without Shift — 11 straight pieces, or 3–4 curves (9–12 rail items). */
export const RAIL_PLAN_LENGTH_LIMIT = 22.5;

export interface PlanRequest {
  /** Where the track starts: an end point, heading the way the new track
   *  should leave it. */
  start: RailEnd;
  target: { x: number; y: number };
  /** The layer the track should finish on; ramps are inserted to get there. */
  targetElevated: boolean;
  /** True when a piece on this level may not cover this tile. */
  blocked: (tx: number, ty: number, level: RailLevel) => boolean;
  /** True for a piece that is already placed: the plan runs along it
   *  rather than being blocked by it. */
  exists?: (piece: RailPiece) => boolean;
  maxNodes?: number;
  /** Track length one placement may lay. Within it the search finds the
   *  track that gets closest to the target, so a far cursor gets a plan
   *  that heads its way and stops at the limit; one that can't get any
   *  closer gets no plan at all. Unlimited when undefined. */
  maxLength?: number;
}

interface Node {
  key: string;
  x: number;
  y: number;
  heading: number;
  elevated: boolean;
  g: number;
  /** Track laid so far (g without the curve penalties). */
  length: number;
  f: number;
  parent: Node | undefined;
  step: Step | undefined;
}

/** Minimal binary heap on f. */
class Heap {
  private items: Node[] = [];
  get size(): number {
    return this.items.length;
  }
  push(n: Node): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** How close the track's last end must get to the target to count as there. */
const GOAL_RADIUS = 1.5;

/** Plans track from `start` toward `target`. Returns the pieces in order
 *  from the start; when the target can't be reached within the node budget
 *  (boxed in, or too far round obstacles) it returns the track that gets
 *  closest, so the preview still shows how far it can go. */
export function planRail(req: PlanRequest): RailPiece[] {
  const { start, target, targetElevated, blocked } = req;
  const maxNodes = req.maxNodes ?? 20000;
  const maxLength = req.maxLength ?? Infinity;
  const dist = (x: number, y: number) => Math.hypot(target.x - x, target.y - y);
  const pieceFree = (piece: RailPiece) => {
    if (req.exists?.(piece)) return true;
    const level = railLevel(piece.name);
    for (const [tx, ty] of railTiles(piece)) if (blocked(tx, ty, level)) return false;
    return true;
  };

  const startNode: Node = {
    key: `${start.x},${start.y},${start.dir},${start.elevated ? 1 : 0}`,
    x: start.x,
    y: start.y,
    heading: start.dir,
    elevated: start.elevated,
    g: 0,
    length: 0,
    f: dist(start.x, start.y),
    parent: undefined,
    step: undefined,
  };
  const open = new Heap();
  open.push(startNode);
  const best = new Map<string, number>([[startNode.key, 0]]);
  let closest: Node = startNode;
  let closestScore = Infinity;
  let expanded = 0;

  while (open.size > 0 && expanded < maxNodes) {
    const node = open.pop()!;
    if ((best.get(node.key) ?? Infinity) < node.g) continue;
    expanded++;
    const d = dist(node.x, node.y);
    const onLayer = node.elevated === targetElevated;
    // Rank partial results: right layer first, then distance.
    const score = d + (onLayer ? 0 : 1000);
    if (score < closestScore) {
      closestScore = score;
      closest = node;
    }
    if (onLayer && d <= GOAL_RADIUS && node.step) break;

    for (const step of STEPS[node.elevated ? 1 : 0]![node.heading]!) {
      const isRamp = step.name === "rail-ramp";
      // A ramp only ever takes the track toward the layer it should end on.
      if (isRamp && node.elevated === targetElevated) continue;
      const piece: RailPiece = { name: step.name, x: node.x + step.dx, y: node.y + step.dy, direction: step.direction };
      if (!pieceFree(piece)) continue;
      const x = node.x + step.ex;
      const y = node.y + step.ey;
      const key = `${x},${y},${step.heading},${step.elevated ? 1 : 0}`;
      const g = node.g + step.cost;
      // The limit counts track laid, not the curves' planner penalty.
      if (node.length + railLength(step.name, step.direction) > maxLength + 1e-6) continue;
      if ((best.get(key) ?? Infinity) <= g) continue;
      best.set(key, g);
      const length = node.length + railLength(step.name, step.direction);
      open.push({ key, x, y, heading: step.heading, elevated: step.elevated, g, length, f: g + dist(x, y), parent: node, step });
    }
  }

  const pieces: RailPiece[] = [];
  for (let n: Node | undefined = closest; n?.step; n = n.parent) {
    pieces.push({ name: n.step.name, x: n.parent!.x + n.step.dx, y: n.parent!.y + n.step.dy, direction: n.step.direction });
  }
  return pieces.reverse();
}

/** The end the track leaves off at, heading onward — where the next
 *  placement continues from. */
export function planEnd(start: RailEnd, pieces: RailPiece[]): RailEnd {
  let at = start;
  for (const p of pieces) {
    const ends = railEnds(p.name, p.direction).map((e) => ({ x: p.x + e.dx, y: p.y + e.dy, dir: e.dir, elevated: e.elevated }));
    const near = ends.findIndex((e) => e.x === at.x && e.y === at.y && e.dir === (at.dir + 8) % 16);
    at = ends[near === 0 ? 1 : 0]!;
  }
  return at;
}

/** What already holds planned elevated track up, and where a support may go. */
export interface SupportSite {
  /** How much further the deck is already held at the plan's start, by a
   *  support or ramp on the track it continues from. Negative when nothing
   *  holds it. */
  startReach: number;
  /** True when a placed support at this joint carries track running along `dir`. */
  supported: (x: number, y: number, dir: number) => boolean;
  /** True when a support for track running along `dir` can't stand at this joint. */
  blocked: (x: number, y: number, dir: number) => boolean;
}

/** Rail supports to carry planned track's elevated stretches. Every point
 *  of the deck has to lie within support_range of a support along the
 *  track, or within a ramp's (shorter) range of its top. Supports stand
 *  under the joints between pieces; as few as possible are added, each as
 *  far along as it can go. `covered` is false when some stretch can't be
 *  held up because every joint near it is blocked. */
export function supportsFor(start: RailEnd, pieces: RailPiece[], site: SupportSite): { supports: RailPiece[]; covered: boolean } {
  const supports: RailPiece[] = [];
  let covered = true;

  /** One unbroken stretch of deck: its joints by distance along it, and the
   *  parts something already holds. */
  interface Run {
    joints: { end: RailEnd; pos: number; free: boolean }[];
    held: [number, number][];
    length: number;
  }
  const finish = (run: Run) => {
    const held = run.held;
    for (const j of run.joints) {
      if (site.supported(j.end.x, j.end.y, j.end.dir)) {
        held.push([j.pos - SUPPORT_RANGE, j.pos + SUPPORT_RANGE]);
        j.free = false;
      }
    }
    for (;;) {
      // The first point of the deck nothing holds yet.
      held.sort((a, b) => a[0] - b[0]);
      let need = 0;
      for (const [lo, hi] of held) {
        if (lo > need + 1e-6) break;
        need = Math.max(need, hi);
      }
      if (need >= run.length - 1e-6) return;
      let pick: Run["joints"][number] | undefined;
      for (const j of run.joints) {
        if (!j.free || j.pos > need + SUPPORT_RANGE + 1e-6 || j.pos + SUPPORT_RANGE <= need + 1e-6) continue;
        if (!pick || j.pos > pick.pos) pick = j;
      }
      if (!pick) {
        covered = false;
        return;
      }
      pick.free = false;
      held.push([pick.pos - SUPPORT_RANGE, pick.pos + SUPPORT_RANGE]);
      supports.push({ name: "rail-support", x: pick.end.x, y: pick.end.y, direction: supportDirection(pick.end.dir) });
    }
  };

  let at = start;
  let run: Run | undefined;
  let previous: RailPiece | undefined;
  for (const p of pieces) {
    const next = planEnd(at, [p]);
    if (isElevatedRail(p.name)) {
      if (!run) {
        run = { joints: [], held: [], length: 0 };
        const fromRamp = previous !== undefined && railShape(previous.name) === "ramp";
        if (fromRamp) run.held.push([-Infinity, RAMP_SUPPORT_RANGE]);
        else if (!previous && site.startReach > 0) run.held.push([-Infinity, site.startReach]);
        // A ramp's top is the ramp itself: no support fits under it.
        run.joints.push({ end: at, pos: 0, free: !fromRamp && !site.blocked(at.x, at.y, at.dir) });
      }
      run.length += railLength(p.name, p.direction);
      run.joints.push({ end: next, pos: run.length, free: !site.blocked(next.x, next.y, next.dir) });
    } else if (run) {
      // The deck ends at a ramp back down, which holds its own top.
      if (railShape(p.name) === "ramp") {
        run.held.push([run.length - RAMP_SUPPORT_RANGE, Infinity]);
        run.joints[run.joints.length - 1]!.free = false;
      }
      finish(run);
      run = undefined;
    }
    previous = p;
    at = next;
  }
  if (run) finish(run);
  return { supports, covered };
}
