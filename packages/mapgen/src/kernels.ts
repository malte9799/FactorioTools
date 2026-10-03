/** Scalar float32 kernels for every arithmetic operation. The compiler folds
 *  constants with them and the evaluator maps them over a batch, so a folded
 *  constant and a per-tile value can never disagree. */
import { cos, pow, sin } from "./fastmath.js";

const f = Math.fround;

export type UnaryOp = "neg" | "bnot" | "abs" | "sqrt" | "floor" | "ceil" | "log2" | "sin" | "cos";
export type BinaryOp =
  | "add" | "sub" | "mul" | "div" | "pow" | "pow_precise" | "mod" | "rem"
  | "lt" | "le" | "gt" | "ge" | "eq" | "ne" | "band" | "bxor" | "bor" | "min" | "max" | "atan2";
export type TernaryOp = "clamp" | "if" | "ridge";

export const UNARY_KERNELS: Record<UnaryOp, (a: number) => number> = {
  neg: (a) => -a,
  bnot: (a) => ~(a | 0),
  abs: Math.abs,
  sqrt: (a) => f(Math.sqrt(a)),
  floor: Math.floor,
  ceil: Math.ceil,
  log2: (a) => f(Math.log2(a)),
  sin,
  cos,
};

export const BINARY_KERNELS: Record<BinaryOp, (a: number, b: number) => number> = {
  add: (a, b) => f(a + b),
  sub: (a, b) => f(a - b),
  mul: (a, b) => f(a * b),
  div: (a, b) => f(a / b),
  pow,
  pow_precise: (a, b) => f(Math.pow(a, b)),
  mod: (a, b) => f(a - f(Math.floor(f(a / b)) * b)),
  rem: (a, b) => f(a % b),
  lt: (a, b) => (a < b ? 1 : 0),
  le: (a, b) => (a <= b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  ge: (a, b) => (a >= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0),
  ne: (a, b) => (a !== b ? 1 : 0),
  band: (a, b) => (a | 0) & (b | 0),
  bxor: (a, b) => (a | 0) ^ (b | 0),
  bor: (a, b) => a | 0 | (b | 0),
  min: (a, b) => (b < a ? b : a),
  max: (a, b) => (a < b ? b : a),
  atan2: (a, b) => f(Math.atan2(a, b)),
};

/** Constant folding is not always the per-tile kernel: a constant `a ^ b`
 *  is folded with a precise pow, while the per-tile operator approximates. */
export const FOLD_KERNELS: Partial<Record<BinaryOp, (a: number, b: number) => number>> = {
  pow: (a, b) => f(Math.pow(a, b)),
};

export const TERNARY_KERNELS: Record<TernaryOp, (a: number, b: number, c: number) => number> = {
  clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
  if: (c, a, b) => (c > 0 ? a : b),
  // No vanilla expression uses ridge; this folds correctly but has not been
  // matched to the game bit for bit like the rest.
  ridge: (v, lo, hi) => {
    const span = f(hi - lo);
    if (!(span > 0)) return lo;
    const period = f(span * 2);
    let t = f(v - lo);
    t = f(t - f(Math.floor(f(t / period)) * period));
    return t > span ? f(hi - f(t - span)) : f(lo + t);
  },
};
