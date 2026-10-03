/** Runs a compiled noise program over a batch of positions.
 *
 *  Every node produces one Float32Array for the batch. Storing into a
 *  Float32Array rounds to single precision, which for + - * / and sqrt gives
 *  exactly the value 32-bit arithmetic would, so the plain loops below match
 *  the game without an explicit `Math.fround`. */
import type { Node, Program } from "./compiler.js";
import { BINARY_KERNELS, TERNARY_KERNELS, UNARY_KERNELS, type BinaryOp, type TernaryOp, type UnaryOp } from "./kernels.js";
import {
  basisNoise, makeNoiseScratch, makeNoiseTables, multioctaveNoise, quickMultioctaveNoise, variablePersistenceNoise,
  type NoiseParams, type NoiseScratch, type NoiseTables, type QuickParams,
} from "./basis.js";
import { Rng, penaltySeed } from "./rng.js";
import { candidatePoints, selectSpots, type Spot, type SpotParams } from "./spot.js";
import { Voronoi, type VoronoiParams } from "./voronoi.js";

const f = Math.fround;
const TWO_POW_MINUS_32 = 2 ** -32;

/** Buffers for one batch length at one nesting depth. They live as long as
 *  the evaluator, so a run allocates nothing. */
interface Frame {
  n: number;
  values: (Float32Array | undefined)[];
  scratch: NoiseScratch;
}

export class Evaluator {
  private readonly tables = new Map<number, NoiseTables>();
  private readonly voronoi = new Map<number, Voronoi>();
  private readonly plans = new Map<string, number[]>();
  private readonly candidates = new Map<string, { xs: Int32Array; ys: Int32Array }>();
  private readonly regions = new Map<string, Spot[]>();
  /** Per node: its constant parameters with noise tables resolved. */
  private readonly params: unknown[] = [];
  private readonly frames: Frame[][] = [];
  private depth = 0;
  /** Above zero while spots are being chosen: those draws are part of where
   *  a patch is and how big, so they are never skipped. */
  private choosingSpots = 0;

  /** @param penalties Apply `random_penalty` per tile. Turned off, a tile's
   *  penalty is zero and a probability becomes its upper bound: where an
   *  entity *can* appear rather than one random draw of where it does. The
   *  draws that size and rank spots are applied either way. */
  constructor(
    readonly program: Program,
    private readonly penalties = true,
  ) {}

  private tablesFor(seed0: number): NoiseTables {
    let t = this.tables.get(seed0);
    if (!t) {
      t = makeNoiseTables(seed0);
      this.tables.set(seed0, t);
    }
    return t;
  }

  private noiseParams(id: number, node: Node): NoiseParams {
    return (this.params[id] ??= { ...node.p, tables: this.tablesFor(node.p.seed0) }) as NoiseParams;
  }

  /** Nodes needed for `roots`, dependencies first. */
  private plan(roots: number[]): number[] {
    const key = roots.join(",");
    const hit = this.plans.get(key);
    if (hit) return hit;
    const nodes = this.program.nodes;
    const seen = new Uint8Array(nodes.length);
    const order: number[] = [];
    const visit = (id: number): void => {
      if (seen[id]) return;
      seen[id] = 1;
      for (const a of nodes[id]!.args) visit(a);
      order.push(id);
    };
    for (const r of roots) visit(r);
    this.plans.set(key, order);
    return order;
  }

  private frame(n: number): Frame {
    const level = (this.frames[this.depth] ??= []);
    let frame = level.find((fr) => fr.n === n);
    if (!frame) {
      frame = { n, values: [], scratch: makeNoiseScratch(n) };
      level.push(frame);
    }
    return frame;
  }

  /** Evaluate `roots` at every (xs[i], ys[i]); one array per root.
   *
   *  The arrays are owned by the evaluator and overwritten by the next run
   *  with a batch of the same length: read them before calling again. */
  run(roots: number[], xs: Float32Array, ys: Float32Array): Float32Array[] {
    const nodes = this.program.nodes;
    const n = xs.length;
    const frame = this.frame(n);
    const values = frame.values;
    this.depth++;
    try {
      for (const id of this.plan(roots)) {
        const node = nodes[id]!;
        if (node.op === "x") values[id] = xs;
        else if (node.op === "y") values[id] = ys;
        else if (node.op === "const") values[id] ??= new Float32Array(n).fill(node.p as number);
        else this.node(node, id, values, (values[id] ??= new Float32Array(n)), xs, ys, n, frame.scratch);
      }
    } finally {
      this.depth--;
    }
    return roots.map((r) => values[r]!);
  }

  private node(
    node: Node,
    id: number,
    values: (Float32Array | undefined)[],
    out: Float32Array,
    xs: Float32Array,
    ys: Float32Array,
    n: number,
    scratch: NoiseScratch,
  ): void {
    const args = node.args;
    const a = args.length > 0 ? values[args[0]!]! : out;
    const b = args.length > 1 ? values[args[1]!]! : out;
    const c = args.length > 2 ? values[args[2]!]! : out;
    switch (node.op) {
      case "add":
        for (let i = 0; i < n; i++) out[i] = a[i]! + b[i]!;
        return;
      case "sub":
        for (let i = 0; i < n; i++) out[i] = a[i]! - b[i]!;
        return;
      case "mul":
        for (let i = 0; i < n; i++) out[i] = a[i]! * b[i]!;
        return;
      case "div":
        for (let i = 0; i < n; i++) out[i] = a[i]! / b[i]!;
        return;
      case "min":
        for (let i = 0; i < n; i++) out[i] = b[i]! < a[i]! ? b[i]! : a[i]!;
        return;
      case "max":
        for (let i = 0; i < n; i++) out[i] = a[i]! < b[i]! ? b[i]! : a[i]!;
        return;
      case "clamp":
        for (let i = 0; i < n; i++) out[i] = a[i]! < b[i]! ? b[i]! : a[i]! > c[i]! ? c[i]! : a[i]!;
        return;
      case "abs":
        for (let i = 0; i < n; i++) out[i] = Math.abs(a[i]!);
        return;
      case "neg":
        for (let i = 0; i < n; i++) out[i] = -a[i]!;
        return;
      case "lt":
        for (let i = 0; i < n; i++) out[i] = a[i]! < b[i]! ? 1 : 0;
        return;
      case "gt":
        for (let i = 0; i < n; i++) out[i] = a[i]! > b[i]! ? 1 : 0;
        return;
      case "if":
        for (let i = 0; i < n; i++) out[i] = a[i]! > 0 ? b[i]! : c[i]!;
        return;
      case "bnot": case "sqrt": case "floor": case "ceil": case "log2": case "sin": case "cos": {
        const k = UNARY_KERNELS[node.op as UnaryOp];
        for (let i = 0; i < n; i++) out[i] = k(a[i]!);
        return;
      }
      case "pow": case "pow_precise": case "mod": case "rem": case "le": case "ge":
      case "eq": case "ne": case "band": case "bxor": case "bor": case "atan2": {
        const k = BINARY_KERNELS[node.op as BinaryOp];
        for (let i = 0; i < n; i++) out[i] = k(a[i]!, b[i]!);
        return;
      }
      case "ridge": {
        const k = TERNARY_KERNELS[node.op as TernaryOp];
        for (let i = 0; i < n; i++) out[i] = k(a[i]!, b[i]!, c[i]!);
        return;
      }
      case "basis":
        basisNoise(this.noiseParams(id, node), a, b, out, n, scratch);
        return;
      case "multioctave":
        multioctaveNoise(this.noiseParams(id, node), node.p.octaves, node.p.persistence, a, b, out, n, scratch);
        return;
      case "vpm":
        variablePersistenceNoise(this.noiseParams(id, node), node.p.octaves, c, a, b, out, n, scratch);
        return;
      case "quick": {
        let p = this.params[id] as QuickParams | undefined;
        if (!p) {
          const tables: NoiseTables[] = [];
          for (let o = 0; o < node.p.octaves; o++) tables.push(this.tablesFor((node.p.seed0 + o * node.p.seedShift) >>> 0));
          p = this.params[id] = { ...node.p, tables };
        }
        quickMultioctaveNoise(p!, a, b, out, n, scratch);
        return;
      }
      case "random_penalty": {
        // One RNG per batch, seeded from its first position and drawn from
        // the last element backwards.
        if (!this.penalties && this.choosingSpots === 0) {
          out.set(c);
          return;
        }
        const amplitude = node.p.amplitude as number;
        const rng = new Rng(penaltySeed(Math.trunc(a[0]!), Math.trunc(b[0]!), node.p.seed));
        for (let i = n - 1; i >= 0; i--) {
          const s = c[i]!;
          out[i] = s > 0 ? s - rng.next() * TWO_POW_MINUS_32 * amplitude : s;
        }
        return;
      }
      case "nearest": {
        const { mode, points, max } = node.p as { mode: number; points: [number, number][]; max: number };
        for (let i = 0; i < n; i++) {
          let best = Infinity;
          let bestDx = 0;
          let bestDy = 0;
          for (const [px, py] of points) {
            const dx = f(a[i]! - px);
            const dy = f(b[i]! - py);
            const d = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
            if (d < best) {
              best = d;
              bestDx = dx;
              bestDy = dy;
            }
          }
          out[i] = mode === 1 ? bestDx : mode === 2 ? bestDy : best < max ? best : max;
        }
        return;
      }
      case "expression_in_range": {
        // How far inside every range the inputs sit: the smallest margin,
        // measured from the middle of the range, scaled and capped.
        const { multiplier, maximum, mid, half } = node.p as { multiplier: number; maximum: number; mid: number[]; half: number[] };
        out.fill(Infinity);
        for (let k = 0; k < args.length; k++) {
          const v = values[args[k]!]!;
          const m0 = mid[k]!;
          const h0 = half[k]!;
          for (let i = 0; i < n; i++) {
            const m = f(h0 - Math.abs(f(v[i]! - m0)));
            if (m < out[i]!) out[i] = m;
          }
        }
        for (let i = 0; i < n; i++) {
          const scaled = f(out[i]! * multiplier);
          out[i] = scaled < maximum ? scaled : maximum;
        }
        return;
      }
      case "terrace": {
        // Steps of `width` starting at `offset`. Each step is flat for the
        // first `strength` of its width, then climbs to the next.
        const { offset, width } = node.p as { offset: number; width: number };
        for (let i = 0; i < n; i++) {
          const t = f(f(a[i]! - offset) / width);
          const base = Math.floor(t);
          const strength = b[i]!;
          const rise = strength >= 1 ? 0 : Math.max(0, f(f(f(t - base) - strength) / f(1 - strength)));
          out[i] = f(f(base + rise) * width) + offset;
        }
        return;
      }
      case "spot":
        this.spot(node.p as SpotParams, id, a, b, out);
        return;
      case "voronoi": {
        let voronoi = this.voronoi.get(id);
        if (!voronoi) {
          voronoi = new Voronoi(node.p as VoronoiParams);
          this.voronoi.set(id, voronoi);
        }
        voronoi.run(a, b, out, n);
        return;
      }
      case "multisample": {
        const sx = new Float32Array(n);
        const sy = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          sx[i] = xs[i]! + node.p.offsetX;
          sy[i] = ys[i]! + node.p.offsetY;
        }
        out.set(this.run([node.p.expr], sx, sy)[0]!);
        return;
      }
      default:
        throw new Error(`noise operation '${node.op}' is not implemented`);
    }
  }

  /** The spots of one region, computed on first use. */
  regionSpots(p: SpotParams, id: number, regionX: number, regionY: number): Spot[] {
    const key = `${id}|${regionX}|${regionY}`;
    const hit = this.regions.get(key);
    if (hit) return hit;

    const count = p.spotCount * p.skipSpan;
    const candKey = `${p.seed0}|${p.seed1}|${p.regionSize}|${p.spacing}|${regionX}|${regionY}`;
    let cand = this.candidates.get(candKey);
    if (!cand || cand.xs.length < count) {
      cand = candidatePoints(p.seed0, p.seed1, p.regionSize, p.spacing, regionX, regionY, count);
      this.candidates.set(candKey, cand);
    }

    const xs = new Float32Array(p.spotCount);
    const ys = new Float32Array(p.spotCount);
    for (let i = 0; i < p.spotCount; i++) {
      xs[i] = cand.xs[i * p.skipSpan + p.skipOffset]!;
      ys[i] = cand.ys[i * p.skipSpan + p.skipOffset]!;
    }
    this.choosingSpots++;
    let spots: Spot[];
    try {
      const [density, quantity, radius, favorability] = this.run([p.density, p.quantity, p.radius, p.favorability], xs, ys);
      spots = selectSpots(p, xs, ys, density!, quantity!, radius!, favorability!);
    } finally {
      this.choosingSpots--;
    }
    this.regions.set(key, spots);
    return spots;
  }

  private spot(p: SpotParams, id: number, ax: Float32Array, ay: Float32Array, out: Float32Array): void {
    const n = ax.length;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = ax[i]!, y = ay[i]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const half = p.regionSize / 2;
    const reach = p.maxRadius;
    const rx0 = Math.floor((minX - reach + half) / p.regionSize);
    const rx1 = Math.floor((maxX + reach + half) / p.regionSize);
    const ry0 = Math.floor((minY - reach + half) / p.regionSize);
    const ry1 = Math.floor((maxY + reach + half) / p.regionSize);

    out.fill(p.basement);
    for (let ry = ry0; ry <= ry1; ry++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        for (const s of this.regionSpots(p, id, rx, ry)) {
          if (s.x + reach < minX || s.x - reach > maxX || s.y + reach < minY || s.y - reach > maxY) continue;
          const { x: sx, y: sy, peak, slope } = s;
          for (let i = 0; i < n; i++) {
            const dx = f(ax[i]! - sx);
            const dy = f(ay[i]! - sy);
            const d = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
            if (d > reach) continue;
            const h = f(peak - f(d * slope));
            if (h > out[i]!) out[i] = h;
          }
        }
      }
    }
  }
}
