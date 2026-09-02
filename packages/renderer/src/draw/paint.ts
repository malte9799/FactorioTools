import type { SpriteAtlas } from "../spriteAtlas.js";
import { compareDrawCommands, type DrawCommand } from "./commands.js";

/** Paints a frame's commands in global order. Sorting here rather than per
 *  entity is what keeps one entity's shadow from landing on top of a
 *  neighbour drawn earlier. */
export function paint(ctx: CanvasRenderingContext2D, atlas: SpriteAtlas, commands: DrawCommand[]): void {
  commands.sort(compareDrawCommands);
  let alpha = 1;
  for (const c of commands) {
    const img = atlas.get(c.sheet);
    if (!img) continue;
    if (c.alpha !== alpha) {
      ctx.globalAlpha = c.alpha;
      alpha = c.alpha;
    }
    ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
}

export function drawOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tint = "rgba(230,221,206,0.45)",
): void {
  ctx.save();
  ctx.strokeStyle = tint;
  ctx.lineWidth = 0.06;
  ctx.strokeRect(x - w / 2 + 0.05, y - h / 2 + 0.05, w - 0.1, h - 0.1);
  ctx.restore();
}
