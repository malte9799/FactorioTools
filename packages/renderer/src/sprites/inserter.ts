import type { InserterGraphics, PlacedEntity } from "@factoriotools/engine";
import type { SpriteAtlas } from "../spriteAtlas.js";
import { toCardinal } from "../neighbours/grid.js";
import { PIXELS_PER_TILE } from "../draw/commands.js";
import { drawOutline, TINT_ALPHA } from "../draw/paint.js";

/** How far the hand reaches toward its drop side, in tiles. */
const REACH = 1.2;

const tiles = (pixels: number, scale = 1) => (pixels * scale) / PIXELS_PER_TILE;

/** Inserters are composited from a platform plate and a hand rotated to face
 *  the drop side, rather than drawn from a packed sheet — so they bypass the
 *  draw-command pipeline and paint directly. `tint`, when given, washes a
 *  CSS color over the composited result's own silhouette (source-atop) —
 *  the placement ghost's green/red valid/invalid cast. Applying it here
 *  rather than after the fact matters because source-atop composites
 *  against whatever the target canvas already holds: painting straight onto
 *  the main canvas would tint every entity already drawn underneath too,
 *  not just this inserter, so the hand/platform are composited onto a
 *  same-size offscreen canvas first and only that gets tinted, then the
 *  whole tinted result is drawn onto the main canvas in one call. */
export function drawInserter(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  entity: PlacedEntity,
  g: InserterGraphics | undefined,
  tint?: string,
): void {
  const platform = g && atlas.get(g.platform.sheet);
  const handBase = g && atlas.get(g.handBase.sheet);
  const handOpen = g && atlas.get(g.handOpen.sheet);
  if (!g || !platform || !handBase || !handOpen) {
    drawOutline(ctx, entity.x, entity.y, 1, 1);
    return;
  }

  if (tint) {
    drawTintedInserter(ctx, entity, g, platform, handBase, handOpen, tint);
    return;
  }

  drawInserterParts(ctx, entity, g, platform, handBase, handOpen);
}

/** The hand's reach extends REACH tiles past the pivot on every facing, so a
 *  footprint big enough to hold the whole composited inserter (platform +
 *  outstretched hand) at any rotation is a square (2*REACH + platform span)
 *  on a side, centered on the entity. */
function inserterOffscreenSpan(g: InserterGraphics): number {
  const platformSpan = Math.max(tiles(g.platform.frameWidth, g.platform.scale), tiles(g.platform.frameHeight, g.platform.scale));
  return platformSpan + REACH * 2;
}

function drawTintedInserter(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  platform: HTMLImageElement,
  handBase: HTMLImageElement,
  handOpen: HTMLImageElement,
  tint: string,
): void {
  const span = inserterOffscreenSpan(g);
  // World units -> offscreen pixels: PIXELS_PER_TILE gives plenty of
  // resolution for a ghost preview without needing to match the live
  // camera's own current zoom.
  const res = PIXELS_PER_TILE;
  const off = document.createElement("canvas");
  off.width = Math.ceil(span * res);
  off.height = Math.ceil(span * res);
  const offCtx = off.getContext("2d")!;
  offCtx.imageSmoothingEnabled = false;
  offCtx.translate(off.width / 2, off.height / 2);
  offCtx.scale(res, res);
  // drawInserterParts draws relative to `entity.{x,y}` in world space;
  // offsetting a fake entity to (0,0) centers the composited result at the
  // offscreen canvas's own center, matching the translate above.
  drawInserterParts(offCtx, { ...entity, x: 0, y: 0 }, g, platform, handBase, handOpen);

  offCtx.globalCompositeOperation = "source-atop";
  offCtx.globalAlpha = TINT_ALPHA;
  offCtx.fillStyle = tint;
  offCtx.fillRect(-span / 2, -span / 2, span, span);

  ctx.drawImage(off, entity.x - span / 2, entity.y - span / 2, span, span);
}

function drawInserterParts(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  platform: HTMLImageElement,
  handBase: HTMLImageElement,
  handOpen: HTMLImageElement,
): void {
  const cardinal = toCardinal(entity.direction);
  const column = Math.round(cardinal / 4) % g.platformDirections;
  const pw = tiles(g.platform.frameWidth, g.platform.scale);
  const ph = tiles(g.platform.frameHeight, g.platform.scale);
  ctx.drawImage(
    platform,
    column * g.platform.frameWidth, 0, g.platform.frameWidth, g.platform.frameHeight,
    entity.x - pw / 2, entity.y - ph / 2, pw, ph,
  );

  ctx.save();
  ctx.translate(entity.x, entity.y);
  // The hand's own art extends downward (south) from the pivot at rotation
  // 0, but an inserter's `direction` names the way it FACES — the drop
  // side — so a north-facing (0) inserter needs its unrotated, south-
  // pointing art turned a half turn to point north instead.
  ctx.rotate(((cardinal + 8) / 16) * 2 * Math.PI);

  const baseW = tiles(g.handBase.frameWidth, g.handBase.scale);
  const baseSpan = Math.max(tiles(g.handBase.frameHeight, g.handBase.scale), REACH);
  ctx.drawImage(handBase, -baseW / 2, 0, baseW, baseSpan);

  const openW = tiles(g.handOpen.frameWidth, g.handOpen.scale);
  const openH = tiles(g.handOpen.frameHeight, g.handOpen.scale);
  ctx.drawImage(handOpen, -openW / 2, REACH - openH, openW, openH);
  ctx.restore();
}
