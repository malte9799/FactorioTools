import type { InserterGraphics, PlacedEntity } from "@factoriotools/engine";
import type { SpriteAtlas } from "../spriteAtlas.js";
import { toCardinal } from "../neighbours/grid.js";
import { PIXELS_PER_TILE } from "../draw/commands.js";
import { drawOutline } from "../draw/paint.js";

/** How far the hand reaches toward its drop side, in tiles. */
const REACH = 1.2;

const tiles = (pixels: number, scale = 1) => (pixels * scale) / PIXELS_PER_TILE;

/** Inserters are composited from a platform plate and a hand rotated to face
 *  the drop side, rather than drawn from a packed sheet — so they bypass the
 *  draw-command pipeline and paint directly. */
export function drawInserter(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  entity: PlacedEntity,
  g: InserterGraphics | undefined,
): void {
  const platform = g && atlas.get(g.platform.sheet);
  const handBase = g && atlas.get(g.handBase.sheet);
  const handOpen = g && atlas.get(g.handOpen.sheet);
  if (!g || !platform || !handBase || !handOpen) {
    drawOutline(ctx, entity.x, entity.y, 1, 1);
    return;
  }

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
  ctx.rotate((cardinal / 16) * 2 * Math.PI);

  const baseW = tiles(g.handBase.frameWidth, g.handBase.scale);
  const baseSpan = Math.max(tiles(g.handBase.frameHeight, g.handBase.scale), REACH);
  ctx.drawImage(handBase, -baseW / 2, 0, baseW, baseSpan);

  const openW = tiles(g.handOpen.frameWidth, g.handOpen.scale);
  const openH = tiles(g.handOpen.frameHeight, g.handOpen.scale);
  ctx.drawImage(handOpen, -openW / 2, REACH - openH, openW, openH);
  ctx.restore();
}
