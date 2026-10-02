import { Layer } from "@factoriotools/engine";
import type { DrawCommand } from "./commands.js";

/** One stretch of the scene, painted in order: either baked once into an
 *  offscreen canvas and blitted every frame, or drawn live every frame
 *  because its sprites animate (or must stay above something that does). */
export interface BakeRun {
  live: boolean;
  commands: DrawCommand[];
}

export interface BakePlan {
  runs: BakeRun[];
  /** How many of `runs` are baked — one offscreen canvas each. */
  bakedCount: number;
}

/** Past this many baked layers, everything higher is drawn live instead. A
 *  belt row under buildings needs two (under the belts, over them); every
 *  extra layer is another full-viewport canvas in memory and another blit. */
export const MAX_BAKED_RUNS = 3;

/** Splits an already-sorted command list into baked and live runs without
 *  changing what ends up on screen.
 *
 *  Painting order only matters between sprites that overlap. So each command
 *  gets a stratum: the lowest one at or above every earlier command it
 *  overlaps, with even strata baked and odd strata live. A static sprite no
 *  belt ever lands under stays in stratum 0; a building overhanging a belt
 *  in front of it rises to stratum 2, and so on. Within a stratum the
 *  original sort order is kept, so any overlapping pair still paints in the
 *  same order it did before.
 *
 *  Overlap is tested on a one-tile grid over the destination rects — coarser
 *  than the real rects, which only ever pushes a sprite up a stratum it did
 *  not strictly need, never below one it did.
 *
 *  Shadows multiply onto whatever is already beneath them, and a baked layer
 *  above stratum 0 has nothing beneath it but transparency, so a shadow that
 *  would bake above stratum 0 is drawn live instead, onto the real canvas. */
export function planBake(commands: DrawCommand[], animated: readonly number[]): BakePlan {
  const n = commands.length;
  const live = new Uint8Array(n);
  for (const i of animated) live[i] = 1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const x0s = new Int32Array(n);
  const y0s = new Int32Array(n);
  const x1s = new Int32Array(n);
  const y1s = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = commands[i]!;
    let left = Math.min(c.dx, c.dx + c.dw);
    let top = Math.min(c.dy, c.dy + c.dh);
    let right = Math.max(c.dx, c.dx + c.dw);
    let bottom = Math.max(c.dy, c.dy + c.dh);
    if (c.rotationDeg) {
      // Any rotation fits in the circle through the rect's corners.
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const r = Math.hypot(right - left, bottom - top) / 2;
      left = cx - r; right = cx + r; top = cy - r; bottom = cy + r;
    }
    x0s[i] = Math.floor(left);
    y0s[i] = Math.floor(top);
    x1s[i] = Math.ceil(right) - 1;
    y1s[i] = Math.ceil(bottom) - 1;
    if (x1s[i]! < x0s[i]!) x1s[i] = x0s[i]!;
    if (y1s[i]! < y0s[i]!) y1s[i] = y0s[i]!;
    minX = Math.min(minX, x0s[i]!);
    minY = Math.min(minY, y0s[i]!);
    maxX = Math.max(maxX, x1s[i]!);
    maxY = Math.max(maxY, y1s[i]!);
  }
  if (n === 0) return { runs: [], bakedCount: 0 };

  const gridW = maxX - minX + 1;
  const gridH = maxY - minY + 1;
  // Highest stratum painted into each tile so far; -1 = nothing yet.
  const cells = new Int16Array(gridW * gridH).fill(-1);
  const strata = new Int16Array(n);
  // Anything above the last baked stratum lands in one live tail.
  const tail = 2 * (MAX_BAKED_RUNS - 1) + 1;

  for (let i = 0; i < n; i++) {
    const ax = x0s[i]! - minX;
    const bx = x1s[i]! - minX;
    const ay = y0s[i]! - minY;
    const by = y1s[i]! - minY;
    let floor = -1;
    for (let y = ay; y <= by; y++) {
      const row = y * gridW;
      for (let x = ax; x <= bx; x++) {
        const v = cells[row + x]!;
        if (v > floor) floor = v;
      }
    }
    let s: number;
    if (!live[i]) {
      s = floor <= 0 ? 0 : floor % 2 === 0 ? floor : floor + 1;
      if (s > 0 && commands[i]!.layer === Layer.Shadow) live[i] = 1;
    }
    if (live[i]) s = floor <= 1 ? 1 : floor % 2 === 1 ? floor : floor + 1;
    s = Math.min(s!, tail);
    strata[i] = s;
    for (let y = ay; y <= by; y++) {
      const row = y * gridW;
      for (let x = ax; x <= bx; x++) {
        if (cells[row + x]! < s) cells[row + x] = s;
      }
    }
  }

  const buckets: DrawCommand[][] = Array.from({ length: tail + 1 }, () => []);
  for (let i = 0; i < n; i++) buckets[strata[i]!]!.push(commands[i]!);
  const runs: BakeRun[] = [];
  let bakedCount = 0;
  for (let s = 0; s <= tail; s++) {
    if (buckets[s]!.length === 0) continue;
    const isLive = s % 2 === 1;
    runs.push({ live: isLive, commands: buckets[s]! });
    if (!isLive) bakedCount++;
  }
  return { runs, bakedCount };
}
