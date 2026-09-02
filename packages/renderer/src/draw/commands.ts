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
}

/** Global paint order: layer, then screen depth, then the entity's own layer
 *  order. Two entities never interleave within a layer at the same y. */
export function compareDrawCommands(a: DrawCommand, b: DrawCommand): number {
  return a.layer - b.layer || a.y - b.y || a.order - b.order;
}
