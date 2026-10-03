/** Single-precision maths that matches the game bit for bit.
 *
 *  Factorio evaluates noise in 32-bit floats and uses the `fastapprox`
 *  approximations for log2 and 2^x, so `x ^ y` in a noise expression is NOT
 *  `Math.pow`. Every intermediate here is rounded with `Math.fround` in the
 *  same order the game rounds it; a single missing round moves coastlines. */

const f = Math.fround;

const scratch = new ArrayBuffer(8);
const f32 = new Float32Array(scratch);
const u32 = new Uint32Array(scratch);
const i32 = new Int32Array(scratch);
const f64 = new Float64Array(scratch);

function doubleFromBits(hi: number, lo: number): number {
  u32[0] = lo;
  u32[1] = hi;
  return f64[0]!;
}

const LOG2_A = f(1.1920928955078125e-7);
const LOG2_B = f(124.22551499);
const LOG2_C = f(1.498030302);
const LOG2_D = f(1.72587999);
const LOG2_E = f(0.3520887068);

/** fastapprox `fastlog2`. */
export function fastLog2(x: number): number {
  f32[0] = x;
  const bits = u32[0]!;
  const asInt = i32[0]!;
  u32[0] = (bits & 0x007fffff) | 0x3f000000;
  const mx = f32[0]!;
  const y = f(f(asInt) * LOG2_A);
  return f(f(f(y - LOG2_B) - f(LOG2_C * mx)) - f(LOG2_D / f(LOG2_E + mx)));
}

const POW2_A = f(121.2740575);
const POW2_B = f(27.7280233);
const POW2_C = f(4.84252568);
const POW2_D = f(1.49012907);

/** fastapprox `fastpow2`. */
export function fastPow2(p: number): number {
  const offset = p < 0 ? 1 : 0;
  const clipp = p < -126 ? -126 : p;
  const w = Math.trunc(clipp);
  const z = f(f(clipp - w) + offset);
  const v = f(f(f(clipp + POW2_A) + f(POW2_B / f(POW2_C - z))) - f(POW2_D * z));
  i32[0] = Math.trunc(f(8388608 * v));
  return f32[0]!;
}

/** The `^` operator and `pow()`: exact repeated multiplication for integer
 *  exponents, the fast approximation otherwise. */
export function pow(base: number, exponent: number): number {
  if (base === 0) {
    if (exponent === 0) return 1;
    return exponent < 0 ? Infinity : 0;
  }
  // A square root is taken exactly; every other fractional power is not.
  if (exponent === 0.5) return f(Math.sqrt(base));
  if (exponent === Math.floor(exponent)) {
    let e = Math.trunc(exponent) | 0;
    const negative = e < 0;
    if (negative) e = -e;
    let b = base;
    let result = 1;
    while (e > 0) {
      if (e & 1) result = f(result * b);
      b = f(b * b);
      e >>>= 1;
    }
    return negative ? f(1 / result) : result;
  }
  return fastPow2(f(fastLog2(base) * exponent));
}

/** C `round()`: halves away from zero (Math.round sends them towards +inf). */
function roundHalfAway(v: number): number {
  const t = Math.trunc(v);
  return Math.abs(v - t) >= 0.5 ? t + Math.sign(v) : t;
}

const QUARTER = 0.25;
const INV_TAU = doubleFromBits(0x3fc45f30, 0x6dc9c883);
const TRIG_C76 = doubleFromBits(0x40532468, 0x7a27a35e);
const TRIG_C81 = doubleFromBits(0x40546687, 0x6b29f494);
const TRIG_C41 = doubleFromBits(0x4044abbc, 0x02329376);
const TRIG_TAU = doubleFromBits(0x401921fb, 0x51bf1614);
const TRIG_C39 = doubleFromBits(0x4043d424, 0x3780214b);

function trigPolynomial(turns: number): number {
  const s = QUARTER - Math.abs(turns - roundHalfAway(turns));
  const s2 = s * s;
  const s4 = s2 * s2;
  return f((s4 * s4 * TRIG_C39 + (s2 * -TRIG_C76 + TRIG_C81) * s4 + s2 * -TRIG_C41 + TRIG_TAU) * s);
}

/** The game's polynomial sine, evaluated in doubles and rounded once. */
export function sin(x: number): number {
  return trigPolynomial(x * INV_TAU + -QUARTER);
}

export function cos(x: number): number {
  return trigPolynomial(x * INV_TAU);
}
