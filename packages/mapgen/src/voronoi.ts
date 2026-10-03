/** The game's Voronoi noise: `voronoi_spot_noise`, `voronoi_facet_noise`,
 *  `voronoi_pyramid_noise` and `voronoi_cell_id`.
 *
 *  The plane is cut into square cells of `grid_size` tiles and each cell
 *  holds one point, placed by an integer hash of the cell's coordinates. A
 *  position is measured against the points of the cells around it:
 *
 *  - spot: distance to the nearest point, in cells.
 *  - facet: distance to the second nearest minus distance to the nearest.
 *  - pyramid: distance to the nearest cell boundary.
 *  - cell id: a random number belonging to the nearest point.
 *
 *  Everything is single precision, in the order the game does it. */
import { fastLog2, fastPow2 } from "./fastmath.js";

const f = Math.fround;

export type VoronoiKind = "spot_noise" | "facet_noise" | "pyramid_noise" | "cell_id";

export const CHEBYSHEV = 0;
export const MANHATTAN = 1;
export const EUCLIDEAN = 2;
export const MINKOWSKI3 = 3;

export interface VoronoiParams {
  kind: VoronoiKind;
  /** Seed of the point hash: seed0 plus the noise layer, wrapped to 32 bits. */
  seed: number;
  /** Cell side in tiles: a 16-bit unsigned integer. */
  gridSize: number;
  distanceType: number;
  /** 0 puts every point at its cell's centre, 1 anywhere in the cell. */
  jitter: number;
}

/** Bob Jenkins' 32-bit integer hash. */
function hash(a: number): number {
  a = (a + 0x7ed55d16 + (a << 12)) | 0;
  a = a ^ 0xc761c23c ^ (a >>> 19);
  a = (a + 0x165667b1 + (a << 5)) | 0;
  a = ((a + 0xd3a2646c) | 0) ^ (a << 9);
  a = (a + 0xfd7046c5 + (a << 3)) | 0;
  a = a ^ 0xb55a4f09 ^ (a >>> 16);
  return a >>> 0;
}

const TO_UNIT = 2 ** -32;

/** The point of one cell: where it sits within the cell (0..1 each way) and
 *  the cell's id. Written to `out[at .. at + 2]`. */
export function voronoiPoint(seed: number, jitter: number, cellX: number, cellY: number, out: Float32Array, at: number): void {
  const h = seed ^ hash(cellX) ^ hash((cellY >>> 16) | (cellY << 16));
  const centre = f(f(1 - jitter) * 0.5);
  out[at] = f(f(hash(h) * TO_UNIT) * jitter) + centre;
  out[at + 1] = f(f(hash(h + 1) * TO_UNIT) * jitter) + centre;
  out[at + 2] = hash(h + 2) * TO_UNIT;
}

/** How many cells out the boundary search looks. The nearest point is always
 *  looked for among the nine cells around the position. */
export function searchRange(distanceType: number, jitter: number): number {
  if (distanceType === CHEBYSHEV && jitter > 0.25) return 2;
  if (distanceType === MANHATTAN && jitter > 0.5) return 2;
  return 1;
}

function distance(type: number, dx: number, dy: number): number {
  switch (type) {
    case CHEBYSHEV: {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      return ax > ay ? ax : ay;
    }
    case MANHATTAN:
      return f(Math.abs(dx) + Math.abs(dy));
    case EUCLIDEAN:
      return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
    default: {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const sum = f(f(f(ax * ax) * ax) + f(f(ay * ay) * ay));
      return sum === 0 ? 0 : fastPow2(f(fastLog2(sum) * f(1 / 3)));
    }
  }
}

/** `max(v, 0)` that turns a NaN into 0, as the processor's fmaxnm does. */
const atLeastZero = (v: number): number => (v > 0 ? v : 0);

/** Distance from `p` to the boundary between the cells of points `a` and `b`
 *  under the Manhattan metric. That boundary is three segments: a diagonal
 *  through the midpoint, and a straight run off each end of it. */
function manhattanBoundary(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const spanX = f(ax - bx);
  const spanY = f(ay - by);
  // Work with x as the axis the two points are further apart on. Swapping
  // the axes changes no result: every sum below is of one x and one y term.
  if (!(f(spanX * spanX) >= f(spanY * spanY))) {
    let t = ax;
    ax = ay;
    ay = t;
    t = bx;
    bx = by;
    by = t;
    t = px;
    px = py;
    py = t;
  }
  const midX = f(f(ax + bx) * 0.5);
  const midY = f(f(ay + by) * 0.5);
  const forward = bx > ax;

  // The ends of the diagonal.
  const halfA = Math.abs(f(ay - midY));
  const startX = f(midX + (forward ? halfA : -halfA));
  const halfB = Math.abs(f(by - midY));
  const endX = f(midX + (forward ? -halfB : halfB));

  const dirX = f(endX - startX);
  const dirY = f(by - ay);
  const along = f(f(f(dirX * f(px - startX)) + f(dirY * f(py - ay))) / f(f(dirX * dirX) + f(dirY * dirY)));
  const t = along > 0 ? (along < 1 ? along : 1) : 0;
  const onX = f(f(startX + f(dirX * t)) - px);
  const onY = f(f(ay + f(dirY * t)) - py);
  const diagonal = f(f(onX * onX) + f(onY * onY));

  // The straight runs leave the diagonal's ends along y, away from the
  // other point.
  const sign = ay >= by ? 1 : -1;
  const beyondStart = atLeastZero(f(sign * f(py - ay)));
  const beyondEnd = atLeastZero(f(-f(sign * f(py - by))));
  const sx = f(startX - px);
  const sy = f(f(ay + f(sign * beyondStart)) - py);
  const fromStart = f(f(sx * sx) + f(sy * sy));
  const ex = f(endX - px);
  const ey = f(f(by - f(sign * beyondEnd)) - py);
  const fromEnd = f(f(ex * ex) + f(ey * ey));

  const runs = fromStart < fromEnd ? fromStart : fromEnd;
  return f(Math.sqrt(diagonal < runs ? diagonal : runs));
}

const FLT_MAX = 3.4028234663852886e38;

/** Evaluates one Voronoi function over a batch of positions. Cell points
 *  are cached, as neighbouring positions ask for the same cells. */
export class Voronoi {
  private readonly points = new Map<number, Float32Array>();
  /** A block of cells per cache entry, so a lookup is rarely a miss. */
  private static readonly BLOCK = 8;

  constructor(private readonly params: VoronoiParams) {}

  /** The points of the block of cells that holds (cellX, cellY). */
  private block(cellX: number, cellY: number): Float32Array {
    const B = Voronoi.BLOCK;
    const bx = Math.floor(cellX / B);
    const by = Math.floor(cellY / B);
    const key = bx * 0x4000000 + by;
    let block = this.points.get(key);
    if (!block) {
      if (this.points.size > 4096) this.points.clear();
      block = new Float32Array(B * B * 3);
      for (let j = 0; j < B; j++) {
        for (let i = 0; i < B; i++) voronoiPoint(this.params.seed, this.params.jitter, (bx * B + i) | 0, (by * B + j) | 0, block, (j * B + i) * 3);
      }
      this.points.set(key, block);
    }
    return block;
  }

  run(xs: Float32Array, ys: Float32Array, out: Float32Array, n: number): void {
    const { kind, gridSize, distanceType, jitter } = this.params;
    const B = Voronoi.BLOCK;
    const range = searchRange(distanceType, jitter);
    const side = 2 * range + 1;
    // The points around the position, relative to it, and their ids.
    const relX = new Float32Array(side * side);
    const relY = new Float32Array(side * side);
    const ids = new Float32Array(side * side);
    // The same points before the position is subtracted. Neighbouring
    // positions mostly share a cell, so these are kept until it changes.
    const baseX = new Float32Array(side * side);
    const baseY = new Float32Array(side * side);
    let haveX = NaN;
    let haveY = NaN;

    for (let s = 0; s < n; s++) {
      const fx = f(xs[s]! / gridSize);
      const fy = f(ys[s]! / gridSize);
      const cellX = Math.floor(fx);
      const cellY = Math.floor(fy);
      const fracX = f(fx - cellX);
      const fracY = f(fy - cellY);
      if (cellX !== haveX || cellY !== haveY) {
        haveX = cellX;
        haveY = cellY;
        for (let j = -range; j <= range; j++) {
          for (let i = -range; i <= range; i++) {
            const x = cellX + i;
            const y = cellY + j;
            const block = this.block(x, y);
            const at = ((y - Math.floor(y / B) * B) * B + (x - Math.floor(x / B) * B)) * 3;
            const k = (j + range) * side + (i + range);
            baseX[k] = block[at]! + i;
            baseY[k] = block[at + 1]! + j;
            ids[k] = block[at + 2]!;
          }
        }
      }
      for (let k = 0; k < relX.length; k++) {
        relX[k] = baseX[k]! - fracX;
        relY[k] = baseY[k]! - fracY;
      }

      // Nearest and second nearest among the nine cells around.
      let nearest = FLT_MAX;
      let second = FLT_MAX;
      let nearestAt = (range + 1) * side + range + 1;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const k = (j + range) * side + (i + range);
          const d = distance(distanceType, relX[k]!, relY[k]!);
          if (d < nearest) {
            second = nearest;
            nearest = d;
            nearestAt = k;
          } else if (d < second) {
            second = d;
          }
        }
      }

      if (kind === "spot_noise") out[s] = nearest;
      else if (kind === "facet_noise") out[s] = second - nearest;
      else if (kind === "cell_id") out[s] = ids[nearestAt]!;
      else out[s] = this.boundary(relX, relY, nearestAt, fracX, fracY);
    }
  }

  /** Distance to the nearest boundary of the cell of point `nearestAt`. */
  private boundary(relX: Float32Array, relY: Float32Array, nearestAt: number, fracX: number, fracY: number): number {
    const { distanceType } = this.params;
    const ax = relX[nearestAt]!;
    const ay = relY[nearestAt]!;
    let best = FLT_MAX;
    for (let k = 0; k < relX.length; k++) {
      if (k === nearestAt) continue;
      const bx = relX[k]!;
      const by = relY[k]!;
      let value: number;
      if (distanceType === EUCLIDEAN || distanceType === MINKOWSKI3) {
        // Along the line from one point to the other, how far the middle
        // between them is.
        let nx = f(bx - ax);
        let ny = f(by - ay);
        if (nx !== 0 || ny !== 0) {
          const length = f(Math.sqrt(f(f(nx * nx) + f(ny * ny))));
          nx = f(nx / length);
          ny = f(ny / length);
        }
        value = f(f(f(f(ay + by) * 0.5) * ny) + f(f(f(ax + bx) * 0.5) * nx));
      } else {
        // The game hands the Manhattan routine the points mirrored through
        // the position.
        const max = f(fracX - ax);
        const may = f(fracY - ay);
        const mbx = f(fracX - bx);
        const mby = f(fracY - by);
        if (distanceType === MANHATTAN) value = manhattanBoundary(max, may, mbx, mby, fracX, fracY);
        else {
          // Chebyshev is Manhattan turned by an eighth of a turn.
          const tax = f(max * 0.75);
          const tay = f(may * 0.75);
          const tbx = f(mbx * 0.75);
          const tby = f(mby * 0.75);
          const tpx = f(fracX * 0.75);
          const tpy = f(fracY * 0.75);
          value = manhattanBoundary(f(tax + tay), f(tay - tax), f(tbx + tby), f(tby - tbx), f(tpx + tpy), f(tpy - tpx));
        }
      }
      if (!(best < value)) best = value;
    }
    return best;
  }
}
