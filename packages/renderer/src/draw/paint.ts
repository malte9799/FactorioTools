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

/** What one paintPlain pass actually put on the canvas. A command whose sheet
 *  has not finished loading is skipped silently, so "1401 commands" alone says
 *  nothing about how much drawing really happened — a frame can report a full
 *  command list while painting almost nothing. Recorded per frame so a spike
 *  can be told apart from a frame that merely *looked* busy. */
export interface PaintTally {
  /** Commands whose sheet was ready and which reached drawImage. */
  drawn: number;
  /** Commands skipped because their sheet was still loading. */
  skipped: number;
  /** Distinct sheets sampled — a proxy for how much texture the frame touched. */
  sheets: number;
  /** Sum of |dw*dh| over drawn commands, in CSS pixels squared. Blend cost
   *  scales with covered area, not with the number of calls. */
  area: number;
  /** How often globalCompositeOperation flipped (shadow multiply passes). */
  compositeSwitches: number;
}

/** Paints an already-untinted command list. The main scene pass calls this
 *  directly: only the placement ghost ever carries a tint, and it is painted
 *  by its own separate paint() call, so splitting the scene list into tinted
 *  and untinted halves every frame allocated two arrays to discover that one
 *  of them is always empty. Sorts in place, same as paint().
 *
 *  Returns a tally when `tally` is passed. Collecting it costs a handful of
 *  adds per command and one Set of sheet names, so the caller only asks for
 *  it while a recording is running. */
export function paintPlain(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  commands: DrawCommand[],
  tally?: PaintTally,
  skipShadows = false,
): void {
  commands.sort(compareDrawCommands);
  let alpha = 1;
  let compositeIsMultiply = false;
  const sheets = tally ? new Set<string>() : null;
  for (const c of commands) {
    // Shadows are multiply-blended over large areas, the costliest thing a
    // frame paints on a weak GPU; the low render preset leaves them out.
    if (skipShadows && c.layer === Layer.Shadow) continue;
    const img = c.multiply ? atlas.getTinted(c.sheet, c.multiply) : atlas.get(c.sheet);
    if (!img) {
      if (tally) tally.skipped++;
      continue;
    }
    if (tally) {
      tally.drawn++;
      tally.area += Math.abs(c.dw * c.dh);
      sheets!.add(c.sheet);
    }
    const isShadow = c.layer === Layer.Shadow;
    if (isShadow !== compositeIsMultiply) {
      ctx.globalCompositeOperation = isShadow ? "multiply" : "source-over";
      compositeIsMultiply = isShadow;
      if (tally) tally.compositeSwitches++;
    }
    const wantAlpha = isShadow ? c.alpha * SHADOW_ALPHA : c.alpha;
    if (wantAlpha !== alpha) {
      ctx.globalAlpha = wantAlpha;
      alpha = wantAlpha;
    }
    // Rotation is rare — only a hand-placed static composite like the
    // agricultural tower's crane parts ever sets it (see Sprite.rotationDeg's
    // own doc comment) — so this stays a plain drawImage for every other
    // command, and only pays for save/translate/rotate/restore on the ones
    // that actually need it.
    if (c.rotationDeg) {
      const cx = c.dx + c.dw / 2;
      const cy = c.dy + c.dh / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((c.rotationDeg * Math.PI) / 180);
      ctx.translate(-cx, -cy);
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
      ctx.restore();
    } else {
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
    }
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
  if (compositeIsMultiply) {
    ctx.globalCompositeOperation = "source-over";
    if (tally) tally.compositeSwitches++;
  }
  if (tally && sheets) tally.sheets = sheets.size;
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
    const img = c.multiply ? atlas.getTinted(c.sheet, c.multiply) : atlas.get(c.sheet);
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
    const ox = (c.dx - left) * res, oy = (c.dy - top) * res, ow = c.dw * res, oh = c.dh * res;
    if (c.rotationDeg) {
      const cx = ox + ow / 2, cy = oy + oh / 2;
      offCtx.save();
      offCtx.translate(cx, cy);
      offCtx.rotate((c.rotationDeg * Math.PI) / 180);
      offCtx.translate(-cx, -cy);
      offCtx.drawImage(img, c.sx, c.sy, c.sw, c.sh, ox, oy, ow, oh);
      offCtx.restore();
    } else {
      offCtx.drawImage(img, c.sx, c.sy, c.sw, c.sh, ox, oy, ow, oh);
    }
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

/** How large the corner sprite reads on screen, in world tiles — sized to
 *  read as a bracket around a 1x1 machine without a 6x6 building's corners
 *  drifting apart into four disconnected commas. */
const HOVER_CORNER_SIZE = 0.75;

/** Stamps Factorio's own cursor-box corner art at each corner of an
 *  entity's footprint: the source cell is the sheet's single top-left
 *  bracket (already yellow), cloned and rotated 0/90/180/270deg the same
 *  way the reference renderer's createCorners() builds a full box from one
 *  corner sprite, rather than a spritesheet that already contains all
 *  four. Source art is plain yellow for now; a colour parameter can be
 *  added later (e.g. via paintTinted's source-atop wash technique) once
 *  something other than the default hover colour is needed. */
export function drawHoverHighlight(
  ctx: CanvasRenderingContext2D,
  corner: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const size = HOVER_CORNER_SIZE;
  const left = x - w / 2;
  const top = y - h / 2;
  const right = x + w / 2;
  const bottom = y + h / 2;

  const corners: { cx: number; cy: number; rotationDeg: number }[] = [
    { cx: left, cy: top, rotationDeg: 0 },
    { cx: right, cy: top, rotationDeg: 90 },
    { cx: right, cy: bottom, rotationDeg: 180 },
    { cx: left, cy: bottom, rotationDeg: 270 },
  ];

  ctx.save();
  for (const c of corners) {
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate((c.rotationDeg * Math.PI) / 180);
    ctx.drawImage(corner, 0, 0, corner.width, corner.height, 0, 0, size, size);
    ctx.restore();
  }
  ctx.restore();
}
