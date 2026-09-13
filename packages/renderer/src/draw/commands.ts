import { Layer } from "@factoriotools/engine";

/** Factorio's base resolution: a sprite's on-screen tile size is
 *  pixels * scale / 32. */
export const PIXELS_PER_TILE = 32;

/** One sprite ready to paint: a source rect in a sheet, a destination rect in
 *  world tiles, and the keys it sorts by. Produced by collect.ts, consumed by
 *  paint.ts — nothing in between touches the canvas. */
export interface DrawCommand {
  sheet: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  layer: Layer;
  /** Sort key within a layer: entities lower on screen paint over those
   *  behind them. */
  y: number;
  /** Sort key within one entity, preserving its own layer order. */
  order: number;
  alpha: number;
  /** CSS color washed over the sprite's own silhouette (source-atop, so only
   *  pixels the sprite already painted are affected) — the placement
   *  ghost's green/red valid/invalid tint. Undefined for every ordinary
   *  entity, which paints untinted. */
  tint?: string;
  /** Clockwise degrees, about (dx+dw/2, dy+dh/2) — see Sprite.rotationDeg's
   *  own doc comment for why this exists and why it should stay rare.
   *  Undefined (the common case) skips the extra save/rotate/restore in
   *  paint.ts entirely. */
  rotationDeg?: number;
}

/** Global paint order: layer, then screen depth, then the entity's own layer
 *  order. Two entities never interleave within a layer at the same y. */
export function compareDrawCommands(a: DrawCommand, b: DrawCommand): number {
  return a.layer - b.layer || a.y - b.y || a.order - b.order;
}
