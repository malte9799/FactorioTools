/** `spot_noise`: cones scattered over square regions. Resource patches and
 *  enemy bases are both spots; the irregular outline is added around this by
 *  ordinary noise in the calling expression. */
import { Rng, regionSeed } from "./rng.js";
import { pow } from "./fastmath.js";

const f = Math.fround;
const ONE_THIRD = f(1 / 3);

export interface SpotParams {
  density: number;
  quantity: number;
  radius: number;
  favorability: number;
  seed0: number;
  seed1: number;
  basement: number;
  maxRadius: number;
  regionSize: number;
  skipOffset: number;
  skipSpan: number;
  hardTarget: boolean;
  spotCount: number;
  spacing: number;
}

export interface Spot {
  x: number;
  y: number;
  radius: number;
  quantity: number;
  /** Height at the centre, the cone holding `quantity` as its volume. */
  peak: number;
  /** Height lost per tile of distance: peak / radius. */
  slope: number;
}

/** A third of pi, as the game writes it in the volume of a cone. Not
 *  `Math.PI / 3`: patch heights only come out bit-exact with this value. */
const CONE_VOLUME_FACTOR = 1.0472;

function makeSpot(x: number, y: number, radius: number, quantity: number): Spot {
  // The one place the game leaves single precision: the division is done in
  // doubles and rounded once.
  const peak = f(quantity / (CONE_VOLUME_FACTOR * radius * radius));
  return { x, y, radius, quantity, peak, slope: f(peak / radius) };
}

/** Candidate points of one region. The series depends only on the seeds,
 *  region size and spacing, so spot noises that differ only in skip_offset
 *  draw disjoint points from the same list and never overlap. */
export function candidatePoints(
  seed0: number,
  seed1: number,
  regionSize: number,
  spacing: number,
  regionX: number,
  regionY: number,
  count: number,
): { xs: Int32Array; ys: Int32Array } {
  const rng = new Rng(regionSeed(regionX, regionY, seed0, seed1));
  const xs = new Int32Array(count);
  const ys = new Int32Array(count);
  const originX = regionSize * regionX - (regionSize >> 1);
  const originY = regionSize * regionY - (regionSize >> 1);
  // Each rejected point relaxes the spacing a little, so a crowded region
  // still fills up.
  let spacingSq = f(f(spacing) * f(spacing));
  let n = 0;
  while (n < count) {
    const x = (rng.next() % regionSize) + originX;
    const y = (rng.next() % regionSize) + originY;
    let ok = true;
    if (spacingSq > 0) {
      for (let j = 0; j < n; j++) {
        const dx = x - xs[j]!;
        const dy = y - ys[j]!;
        if (dx * dx + dy * dy < spacingSq) {
          spacingSq = f(spacingSq * 0.9375);
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      xs[n] = x;
      ys[n] = y;
      n++;
    }
  }
  return { xs, ys };
}

/** Choose the spots of one region from the per-candidate expression values. */
export function selectSpots(
  p: SpotParams,
  xs: Float32Array,
  ys: Float32Array,
  density: Float32Array,
  quantity: Float32Array,
  radius: Float32Array,
  favorability: Float32Array,
): Spot[] {
  const n = xs.length;
  let densitySum = 0;
  for (let i = 0; i < n; i++) densitySum = f(densitySum + density[i]!);
  const target = f(f(p.regionSize * p.regionSize * densitySum) / n);

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => favorability[b]! - favorability[a]! || a - b);

  const spots: Spot[] = [];
  let total = 0;
  for (const i of order) {
    let q = quantity[i]!;
    let r = radius[i]!;
    // Spots are taken until the region's target is met: a region that wants
    // nothing gets none.
    if (!(total < target)) break;
    if (p.hardTarget) {
      // The spot that would overshoot the region's target is shrunk to fit.
      // The radius of every spot goes through the same cube-root scaling,
      // and the game's approximate pow does not return exactly 1 for 1, so
      // even untouched spots come out a hair wider.
      let scale = 1;
      if (f(total + q) > target) {
        const rest = f(target - total);
        scale = f(rest / q);
        q = rest;
      }
      r = f(r * pow(scale, ONE_THIRD));
    }
    total = f(total + q);
    if (r > 0 && q > 0) spots.push(makeSpot(xs[i]!, ys[i]!, r, q));
  }
  return spots;
}
