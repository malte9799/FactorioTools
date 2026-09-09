import { Layer } from "@factoriotools/engine";
import type { SpriteAtlas } from "../spriteAtlas.js";
import { compareDrawCommands, type DrawCommand } from "./commands.js";

/** Factorio ships shadow art as near-opaque grayscale (its engine composites
 *  shadows with a multiply blend, not plain alpha); painted with drawImage's
 *  default source-over blend they read as flat black smears. Multiply plus
 *  a capped opacity approximates the game's own softer look. */
const SHADOW_ALPHA = 0.45;

/** How strongly a ghost's valid/invalid-placement tint (DrawCommand.tint,
 *  and inserter.ts's own separate offscreen-composited tint) washes over its
 *  sprite — matches the reference look: a clear green/red cast without
 *  hiding the sprite's own detail underneath. */
export const TINT_ALPHA = 0.55;

/** Paints a frame's commands in global order. Sorting here rather than per
 *  entity is what keeps one entity's shadow from landing on top of a
 *  neighbour drawn earlier. Tinted commands (the placement ghost's
 *  green/red valid/invalid wash) are pulled out and composited separately
 *  by paintTinted — source-atop can't be applied per-command against the
 *  live canvas, since by the time a command's tint fill runs, the canvas
 *  already holds whatever unrelated content (floor, neighbouring entities)
 *  sits behind that command's own transparent pixels, and source-atop washes
 *  over all of it, not just this sprite's own silhouette. */
export function paint(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  commands: DrawCommand[],
  tintedOffscreenRes: number,
): void {
  // A ghost's shadow stays untinted — the green/red wash marks the
  // building itself, not the ground shadow it casts, which should keep
  // reading as a plain shadow regardless of placement validity.
  const untinted = commands.filter((c) => !c.tint || c.layer === Layer.Shadow);
  const tinted = commands.filter((c) => c.tint && c.layer !== Layer.Shadow);
  paintPlain(ctx, atlas, untinted);
  if (tinted.length > 0) paintTinted(ctx, atlas, tinted, tintedOffscreenRes);
}

/** Paints an already-untinted command list. The main scene pass calls this
 *  directly: only the placement ghost ever carries a tint, and it is painted
 *  by its own separate paint() call, so splitting the scene list into tinted
 *  and untinted halves every frame allocated two arrays to discover that one
 *  of them is always empty. Sorts in place, same as paint(). */
export function paintPlain(ctx: CanvasRenderingContext2D, atlas: SpriteAtlas, commands: DrawCommand[]): void {
  commands.sort(compareDrawCommands);
  let alpha = 1;
  let compositeIsMultiply = false;
  for (const c of commands) {
    const img = atlas.get(c.sheet);
    if (!img) continue;
    const isShadow = c.layer === Layer.Shadow;
    if (isShadow !== compositeIsMultiply) {
      ctx.globalCompositeOperation = isShadow ? "multiply" : "source-over";
      compositeIsMultiply = isShadow;
    }
    const wantAlpha = isShadow ? c.alpha * SHADOW_ALPHA : c.alpha;
    if (wantAlpha !== alpha) {
      ctx.globalAlpha = wantAlpha;
      alpha = wantAlpha;
    }
    ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
  if (compositeIsMultiply) ctx.globalCompositeOperation = "source-over";
}

/** Composites every tinted command onto its own offscreen canvas (isolated
 *  from the main canvas's existing content), washes a source-atop tint over
 *  ONLY that isolated result — so it follows the union of these sprites'
 *  own silhouettes — then blits the tinted composite onto the main canvas in
 *  one call. All the given commands share one tint (the placement ghost is
 *  one colour throughout), read from the first command. */
function paintTinted(ctx: CanvasRenderingContext2D, atlas: SpriteAtlas, commands: DrawCommand[], res: number): void {
  commands.sort(compareDrawCommands);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const c of commands) {
    left = Math.min(left, c.dx);
    top = Math.min(top, c.dy);
    right = Math.max(right, c.dx + c.dw);
    bottom = Math.max(bottom, c.dy + c.dh);
  }
  const spanW = right - left;
  const spanH = bottom - top;
  if (!(spanW > 0 && spanH > 0)) return;

  // World units -> offscreen pixels, at `res` (the caller's current
  // camera.state.pixelsPerTile, i.e. the SAME resolution a placed entity
  // draws at right now) rather than a fixed constant — a hardcoded 32px/tile
  // buffer stretched to fill the screen at, say, 4x zoom looked visibly
  // blurrier/blockier than every placed entity around it, which draws
  // straight from the full-resolution sprite atlas at whatever zoom is
  // current. Smoothing left on (the default) so any residual scaling still
  // blends like the rest of the canvas instead of looking pixelated.
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.ceil(spanW * res));
  off.height = Math.max(1, Math.ceil(spanH * res));
  const offCtx = off.getContext("2d")!;

  let alpha = 1;
  let compositeIsMultiply = false;
  for (const c of commands) {
    const img = atlas.get(c.sheet);
    if (!img) continue;
    const isShadow = c.layer === Layer.Shadow;
    if (isShadow !== compositeIsMultiply) {
      offCtx.globalCompositeOperation = isShadow ? "multiply" : "source-over";
      compositeIsMultiply = isShadow;
    }
    const wantAlpha = isShadow ? c.alpha * SHADOW_ALPHA : c.alpha;
    if (wantAlpha !== alpha) {
      offCtx.globalAlpha = wantAlpha;
      alpha = wantAlpha;
    }
    offCtx.drawImage(img, c.sx, c.sy, c.sw, c.sh, (c.dx - left) * res, (c.dy - top) * res, c.dw * res, c.dh * res);
  }
  offCtx.globalAlpha = 1;
  offCtx.globalCompositeOperation = "source-atop";
  offCtx.globalAlpha = TINT_ALPHA;
  offCtx.fillStyle = commands[0]!.tint!;
  offCtx.fillRect(0, 0, off.width, off.height);

  ctx.drawImage(off, left, top, spanW, spanH);
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
