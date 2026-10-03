/** Factorio's map-generation RNG: three combined Tausworthe generators,
 *  all seeded with the same value (never below 341). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;

  constructor(seed: number) {
    const s = Math.max(341, seed >>> 0);
    this.a = s;
    this.b = s;
    this.c = s;
  }

  /** Next value as an unsigned 32-bit integer. */
  next(): number {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    this.a = (((a & 0xfffffffe) << 12) | (((a << 13) ^ a) >>> 19)) >>> 0;
    this.b = (((b & 0x0ffffff8) << 4) | (((b << 2) ^ b) >>> 25)) >>> 0;
    this.c = (((c & 0xfffffff0) << 17) | (((c << 3) ^ c) >>> 11)) >>> 0;
    return (this.a ^ this.b ^ this.c) >>> 0;
  }
}

/** Seed of the RNG behind `random_penalty` for a batch starting at (x, y). */
export function penaltySeed(x: number, y: number, seed: number): number {
  return (Math.imul((y | 0) + seed, 0x1ee3) + Math.imul(x | 0, 0x1eef) + 0x3fbe2c) >>> 0;
}

/** Seed of the RNG that scatters `spot_noise` candidate points in a region. */
export function regionSeed(regionX: number, regionY: number, seed0: number, seed1: number): number {
  return ((Math.imul(regionY, 0x1ee3) + Math.imul(regionX, 0x1eef) + Math.imul(seed1, 0x1ef7) + 0x3fbe2c) ^ seed0) >>> 0;
}
