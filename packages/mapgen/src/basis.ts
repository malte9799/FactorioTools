/** Factorio's basis noise and the three multi-octave variants built on it.
 *
 *  Basis noise is a gradient noise on a 256-periodic integer lattice. `seed0`
 *  shuffles three permutation tables and a table of 256 gradients; `seed1`
 *  picks a row of the first table, so one `seed0` yields 256 unrelated
 *  layers for the cost of one shuffle.
 *
 *  Everything works on whole batches: map generation spends nearly all its
 *  time here, and one call per sample is several times slower. */
import { Rng } from "./rng.js";
import { fastLog2, fastPow2 } from "./fastmath.js";
import { defaultGradients } from "./gradients.js";

const f = Math.fround;

export interface NoiseTables {
  p1: Uint8Array;
  p2: Uint8Array;
  p3: Uint8Array;
  /** Interleaved gradient x,y, indexed by hash * 2. */
  grad: Float32Array;
}

/** Fisher-Yates from the top, one draw per element (none for the last). */
function shuffleBytes(a: Uint8Array, rng: Rng): void {
  for (let i = 255; i >= 1; i--) {
    const j = rng.next() % (i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
}

function shufflePairs(a: Float32Array, rng: Rng): void {
  for (let i = 255; i >= 1; i--) {
    const j = rng.next() % (i + 1);
    const tx = a[i * 2]!;
    const ty = a[i * 2 + 1]!;
    a[i * 2] = a[j * 2]!;
    a[i * 2 + 1] = a[j * 2 + 1]!;
    a[j * 2] = tx;
    a[j * 2 + 1] = ty;
  }
}

export function makeNoiseTables(seed0: number): NoiseTables {
  const rng = new Rng(seed0 >>> 0);
  const p1 = new Uint8Array(256);
  const p2 = new Uint8Array(256);
  const p3 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p1[i] = p2[i] = p3[i] = i;
  const grad = defaultGradients();
  shuffleBytes(p1, rng);
  shuffleBytes(p2, rng);
  shuffleBytes(p3, rng);
  shufflePairs(grad, rng);
  return { p1, p2, p3, grad };
}

/** One octave at lattice coordinates (sx[i], sy[i]), unscaled, into `out`.
 *  The top and bottom pairs of corners are summed separately, as the game
 *  does; the order of the additions is part of the result. */
function lattice(t: NoiseTables, seed1: number, sx: Float32Array, sy: Float32Array, out: Float32Array, n: number): void {
  const p2 = t.p2;
  const p3 = t.p3;
  const grad = t.grad;
  const row = t.p1[seed1]!;
  for (let i = 0; i < n; i++) {
    const xs = sx[i]!;
    const ys = sy[i]!;
    const x0 = Math.floor(xs);
    const y0 = Math.floor(ys);
    const fx = f(xs - x0);
    const fy = f(ys - y0);
    const fx1 = f(fx - 1);
    const fy1 = f(fy - 1);
    const hx0 = p3[x0 & 255]!;
    const hx1 = p3[(x0 + 1) & 255]!;
    const rowTop = row ^ p2[y0 & 255]!;
    const rowBottom = row ^ p2[(y0 + 1) & 255]!;
    const xx0 = f(fx * fx);
    const xx1 = f(fx1 * fx1);
    const yy0 = f(fy * fy);
    const yy1 = f(fy1 * fy1);

    let h = (rowTop ^ hx0) << 1;
    let r = f(xx0 + yy0);
    let d = r < 1 ? f(1 - r) : 0;
    let top = f(f(f(fx * grad[h]!) + f(fy * grad[h + 1]!)) * f(f(d * d) * d));

    h = (rowTop ^ hx1) << 1;
    r = f(xx1 + yy0);
    d = r < 1 ? f(1 - r) : 0;
    top = f(top + f(f(f(fx1 * grad[h]!) + f(fy * grad[h + 1]!)) * f(f(d * d) * d)));

    h = (rowBottom ^ hx0) << 1;
    r = f(xx0 + yy1);
    d = r < 1 ? f(1 - r) : 0;
    let bottom = f(f(f(fx * grad[h]!) + f(fy1 * grad[h + 1]!)) * f(f(d * d) * d));

    h = (rowBottom ^ hx1) << 1;
    r = f(xx1 + yy1);
    d = r < 1 ? f(1 - r) : 0;
    bottom = f(bottom + f(f(f(fx1 * grad[h]!) + f(fy1 * grad[h + 1]!)) * f(f(d * d) * d)));

    out[i] = top + bottom;
  }
}

export interface NoiseParams {
  tables: NoiseTables;
  /** seed1 & 255. */
  seed1: number;
  inputScale: number;
  outputScale: number;
  offsetX: number;
  offsetY: number;
}

/** Working arrays for one batch length; the caller owns and reuses them. */
export interface NoiseScratch {
  sx: Float32Array;
  sy: Float32Array;
  v: Float32Array;
}

export function makeNoiseScratch(n: number): NoiseScratch {
  return { sx: new Float32Array(n), sy: new Float32Array(n), v: new Float32Array(n) };
}

/** `basis_noise`. */
export function basisNoise(p: NoiseParams, x: Float32Array, y: Float32Array, out: Float32Array, n: number, s: NoiseScratch): void {
  const { sx, sy } = s;
  const { inputScale, outputScale, offsetX, offsetY } = p;
  for (let i = 0; i < n; i++) {
    sx[i] = f(x[i]! + offsetX) * inputScale;
    sy[i] = f(y[i]! + offsetY) * inputScale;
  }
  lattice(p.tables, p.seed1, sx, sy, out, n);
  for (let i = 0; i < n; i++) out[i] = out[i]! * outputScale;
}

/** Scale applied to the finest octave so that the octaves, each stronger than
 *  the last by `growth`, sum to roughly the requested amplitude. */
function octaveStartAmplitude(outputScale: number, octaves: number, growth: number): number {
  if (growth === 1) return f(outputScale / Math.sqrt(octaves));
  if (growth === 0) return outputScale;
  const g2 = f(growth * growth);
  const total = fastPow2(f(fastLog2(g2) * octaves));
  return f(Math.sqrt(f(f(g2 - 1) / f(total - 1))) * outputScale);
}

/** `multioctave_noise`: finest octave first, each next one twice as wide and
 *  `1 / persistence` times as strong, shifted 17.17 lattice cells in x. */
export function multioctaveNoise(
  p: NoiseParams,
  octaves: number,
  persistence: number,
  x: Float32Array,
  y: Float32Array,
  out: Float32Array,
  n: number,
  s: NoiseScratch,
): void {
  const { sx, sy, v } = s;
  const { offsetX, offsetY } = p;
  const growth = f(1 / persistence);
  let inputScale = p.inputScale;
  let outputScale = octaveStartAmplitude(p.outputScale, octaves, growth);
  out.fill(0, 0, n);
  for (let o = 0; o < octaves; o++) {
    const shift = 17.17 * o;
    for (let i = 0; i < n; i++) {
      sx[i] = f(f(inputScale * x[i]!) + shift) + offsetX;
      sy[i] = f(inputScale * y[i]!) + offsetY;
    }
    lattice(p.tables, p.seed1, sx, sy, v, n);
    for (let i = 0; i < n; i++) out[i] = out[i]! + f(v[i]! * outputScale);
    inputScale = f(inputScale * 0.5);
    outputScale = f(outputScale * growth);
  }
}

/** `variable_persistence_multioctave_noise`: finest octave first, the running
 *  sum multiplied by the (per-tile) persistence before each wider octave. */
export function variablePersistenceNoise(
  p: NoiseParams,
  octaves: number,
  persistence: Float32Array,
  x: Float32Array,
  y: Float32Array,
  out: Float32Array,
  n: number,
  s: NoiseScratch,
): void {
  const { sx, sy, v } = s;
  const { offsetX, offsetY } = p;
  let inputScale = f(p.inputScale * 0.5);
  out.fill(0, 0, n);
  for (let o = 1; o <= octaves; o++) {
    for (let i = 0; i < n; i++) {
      sx[i] = f(x[i]! + offsetX) * inputScale;
      sy[i] = f(y[i]! + offsetY) * inputScale;
    }
    lattice(p.tables, p.seed1, sx, sy, v, n);
    if (o < octaves) for (let i = 0; i < n; i++) out[i] = f(out[i]! + v[i]!) * persistence[i]!;
    else for (let i = 0; i < n; i++) out[i] = out[i]! + v[i]!;
    inputScale = f(inputScale * 0.5);
  }
  let scale = p.outputScale;
  for (let o = 0; o < octaves; o++) scale = f(scale * 2);
  for (let i = 0; i < n; i++) out[i] = out[i]! * scale;
}

export interface QuickParams {
  /** One table set per octave: seed0 + octave * octave_seed0_shift. */
  tables: NoiseTables[];
  seed1: number;
  inputScale: number;
  outputScale: number;
  offsetX: number;
  offsetY: number;
  inputScaleMultiplier: number;
  outputScaleMultiplier: number;
}

/** `quick_multioctave_noise`: every octave reads its own seed. */
export function quickMultioctaveNoise(p: QuickParams, x: Float32Array, y: Float32Array, out: Float32Array, n: number, s: NoiseScratch): void {
  const { sx, sy, v } = s;
  const { offsetX, offsetY } = p;
  let inputScale = p.inputScale;
  let outputScale = p.outputScale;
  out.fill(0, 0, n);
  for (const tables of p.tables) {
    for (let i = 0; i < n; i++) {
      sx[i] = f(x[i]! + offsetX) * inputScale;
      sy[i] = f(y[i]! + offsetY) * inputScale;
    }
    lattice(tables, p.seed1, sx, sy, v, n);
    for (let i = 0; i < n; i++) out[i] = out[i]! + f(v[i]! * outputScale);
    inputScale = f(inputScale * p.inputScaleMultiplier);
    outputScale = f(outputScale * p.outputScaleMultiplier);
  }
}
