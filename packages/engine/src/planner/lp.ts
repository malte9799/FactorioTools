/** A small dense simplex solver for the production planner.
 *
 *  Solves   minimise c·x   subject to   A x = b,  x ≥ 0,  b ≥ 0
 *  given a starting basis: one column per row that is the identity column
 *  for that row. The planner always has one (every item can be imported, and
 *  an import column is +1 in its own item's row only), so the problem starts
 *  feasible and needs no phase one.
 *
 *  Problems are tiny — tens of items, tens of recipes — so a full tableau is
 *  simpler and fast enough. Dantzig's rule picks the entering column; after
 *  a run of degenerate pivots it switches to Bland's rule, which cannot
 *  cycle. */

export interface LpResult {
  status: "optimal" | "unbounded" | "iteration-limit";
  x: Float64Array;
  objective: number;
}

const EPS = 1e-9;

export function simplex(A: number[][], b: number[], c: number[], basis: number[]): LpResult {
  const m = A.length;
  const n = c.length;
  const width = n + 1;
  // Constraint rows, then the reduced-cost row; the last column is the RHS.
  const T = new Float64Array((m + 1) * width);
  for (let i = 0; i < m; i++) {
    const row = A[i]!;
    for (let j = 0; j < n; j++) T[i * width + j] = row[j] ?? 0;
    T[i * width + n] = b[i]!;
  }
  const z = m * width;
  for (let j = 0; j < n; j++) T[z + j] = c[j]!;
  // Price out the starting basis so its reduced costs are zero.
  for (let i = 0; i < m; i++) {
    const cb = c[basis[i]!]!;
    if (cb === 0) continue;
    for (let j = 0; j <= n; j++) T[z + j] = T[z + j]! - cb * T[i * width + j]!;
  }

  const B = basis.slice();
  let status: LpResult["status"] = "iteration-limit";
  let degenerate = 0;
  const maxIterations = 50 * (m + n) + 1000;

  for (let iter = 0; iter < maxIterations; iter++) {
    const bland = degenerate > 50;
    let enter = -1;
    let best = -EPS;
    for (let j = 0; j < n; j++) {
      const r = T[z + j]!;
      if (r < best) {
        enter = j;
        if (bland) break;
        best = r;
      }
    }
    if (enter < 0) {
      status = "optimal";
      break;
    }

    let leave = -1;
    let bestRatio = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i * width + enter]!;
      if (a <= EPS) continue;
      const ratio = T[i * width + n]! / a;
      if (ratio < bestRatio - EPS || (ratio < bestRatio + EPS && leave >= 0 && B[i]! < B[leave]!)) {
        bestRatio = ratio;
        leave = i;
      }
    }
    if (leave < 0) {
      status = "unbounded";
      break;
    }
    degenerate = bestRatio < EPS ? degenerate + 1 : 0;

    // Pivot on (leave, enter).
    const p = leave * width;
    const pivot = T[p + enter]!;
    for (let j = 0; j <= n; j++) T[p + j] = T[p + j]! / pivot;
    for (let i = 0; i <= m; i++) {
      if (i === leave) continue;
      const r = i * width;
      const f = T[r + enter]!;
      if (f === 0) continue;
      for (let j = 0; j <= n; j++) T[r + j] = T[r + j]! - f * T[p + j]!;
    }
    B[leave] = enter;
  }

  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    const v = T[i * width + n]!;
    x[B[i]!] = v > 0 ? v : 0;
  }
  let objective = 0;
  for (let j = 0; j < n; j++) objective += c[j]! * x[j]!;
  return { status, x, objective };
}
