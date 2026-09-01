/** Uniform grid for pointer-to-entity hit-testing. A quadtree is unneeded
 *  here (per the project plan): blueprints are grid-aligned and roughly
 *  uniformly dense, so bucketing by tile coordinate is simpler to implement
 *  and just as fast for the point-query access pattern this needs. Rebuilt
 *  once per loaded blueprint, not per frame — entities don't move. */

export interface IndexedBox {
  entityNumber: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const BUCKET_SIZE = 8; // tiles; larger than any real entity footprint

export class SpatialIndex {
  private buckets = new Map<string, IndexedBox[]>();
  private boxes: IndexedBox[] = [];

  constructor(boxes: IndexedBox[]) {
    this.boxes = boxes;
    for (const box of boxes) {
      const bx0 = Math.floor(box.left / BUCKET_SIZE);
      const by0 = Math.floor(box.top / BUCKET_SIZE);
      const bx1 = Math.floor(box.right / BUCKET_SIZE);
      const by1 = Math.floor(box.bottom / BUCKET_SIZE);
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let by = by0; by <= by1; by++) {
          const key = `${bx},${by}`;
          let bucket = this.buckets.get(key);
          if (!bucket) this.buckets.set(key, (bucket = []));
          bucket.push(box);
        }
      }
    }
  }

  /** Topmost entity (last one added, matching draw order) whose box contains
   *  the given world-space point, or undefined. */
  hitTest(worldX: number, worldY: number): number | undefined {
    const bx = Math.floor(worldX / BUCKET_SIZE);
    const by = Math.floor(worldY / BUCKET_SIZE);
    const bucket = this.buckets.get(`${bx},${by}`);
    if (!bucket) return undefined;
    for (let i = bucket.length - 1; i >= 0; i--) {
      const box = bucket[i]!;
      if (worldX >= box.left && worldX <= box.right && worldY >= box.top && worldY <= box.bottom) {
        return box.entityNumber;
      }
    }
    return undefined;
  }

  /** Every entityNumber whose box overlaps the given world-space rect, in
   *  original insertion order and de-duplicated — used for frustum culling
   *  the draw loop against the current viewport instead of walking every
   *  entity in the blueprint every frame. A box spanning multiple buckets is
   *  deduped via a Set since it's pushed into each bucket it overlaps. */
  queryRect(left: number, top: number, right: number, bottom: number): Set<number> {
    const bx0 = Math.floor(left / BUCKET_SIZE);
    const by0 = Math.floor(top / BUCKET_SIZE);
    const bx1 = Math.floor(right / BUCKET_SIZE);
    const by1 = Math.floor(bottom / BUCKET_SIZE);
    const result = new Set<number>();
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const bucket = this.buckets.get(`${bx},${by}`);
        if (!bucket) continue;
        for (const box of bucket) {
          if (box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom) {
            result.add(box.entityNumber);
          }
        }
      }
    }
    return result;
  }

  get boundingBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.boxes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of this.boxes) {
      minX = Math.min(minX, b.left);
      minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.right);
      maxY = Math.max(maxY, b.bottom);
    }
    return { minX, minY, maxX, maxY };
  }
}
