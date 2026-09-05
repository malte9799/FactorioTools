/** Alt mode: recipe and module badges drawn over the world as a UI layer. */
import type { PlacedEntity } from "@factoriotools/engine";
import type { ResolvedVisual } from "./entityLookup.js";
import type { IconAtlas } from "./iconAtlas.js";

/** Badge sizes in tile units, matched to the real game's alt mode. */
const RECIPE_ICON_SIZE = 0.8;
const MODULE_ICON_SIZE = 0.42;
const MODULE_ICON_GAP = 0.05;
const QUALITY_ICON_SIZE = 0.3;

function drawIcon(ctx: CanvasRenderingContext2D, iconAtlas: IconAtlas, name: string, cx: number, cy: number, size: number): boolean {
  const found = iconAtlas.get(name);
  if (!found) return false;
  const { sheet, cell } = found;
  // A dark backing disc with a light rim, matching the real game's
  // alt-mode icon badges (a dark circular chip with a visible edge behind
  // the icon) so the badge stays legible against any entity sprite color
  // underneath — confirmed by spike this needed more than just a bigger
  // icon: a grey/metallic recipe icon (e.g. iron-gear-wheel) on a grey/
  // metallic machine sprite was still hard to pick out with only a
  // translucent disc and no rim, even at the larger RECIPE_ICON_SIZE.
  ctx.save();
  const radius = size / 2 + size * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(15,14,12,0.82)";
  ctx.fill();
  ctx.lineWidth = size * 0.045;
  ctx.strokeStyle = "rgba(235,225,205,0.55)";
  ctx.stroke();
  ctx.restore();
  ctx.drawImage(sheet, cell.x, cell.y, cell.w, cell.h, cx - size / 2, cy - size / 2, size, size);
  return true;
}

/** Plain icon, no backing disc/rim — the quality badge's own diamond
 *  sprite already reads fine on its own at this small size (unlike the
 *  larger recipe/module badges, which need the disc for contrast), and a
 *  circular backing looked visually wrong behind a diamond shape. */
function drawPlainIcon(ctx: CanvasRenderingContext2D, iconAtlas: IconAtlas, name: string, cx: number, cy: number, size: number): boolean {
  const found = iconAtlas.get(name);
  if (!found) return false;
  const { sheet, cell } = found;
  ctx.drawImage(sheet, cell.x, cell.y, cell.w, cell.h, cx - size / 2, cy - size / 2, size, size);
  return true;
}

/** Quality badge: bottom-left corner of the entity's own footprint,
 *  matching the real game's alt-mode. "normal" quality has no badge
 *  in-game either (it's the default, nothing to call out) — every other
 *  tier does, on ANY entity (not gated to machines/beacons the way the
 *  recipe/module badges are). Exported standalone (not folded into
 *  drawAltModeOverlay below) so the placement ghost can show it too —
 *  what quality you're about to place should always be visible, not only
 *  in alt-mode, matching the real game's own cursor-stack quality icon. */
export function drawQualityBadge(
  ctx: CanvasRenderingContext2D,
  iconAtlas: IconAtlas,
  entity: PlacedEntity,
  visual: ResolvedVisual,
): void {
  if (entity.quality === "normal") return;
  const [fw, fh] = visual.tileFootprint;
  const size = Math.min(QUALITY_ICON_SIZE, fw * 0.3, fh * 0.3);
  drawPlainIcon(ctx, iconAtlas, entity.quality, entity.x - fw / 2 + size / 2, entity.y + fh / 2 - size / 2, size);
}

/** Alt-mode overlay (Factorio's own Alt-key view): a recipe icon centered
 *  on crafting machines, and a row of module icons beneath — for machines
 *  AND beacons, since both can carry modules. Drawn as a separate pass
 *  after every entity sprite (see render.ts), not interleaved into
 *  drawEntity's per-entity draw, so badges always sit on top regardless of
 *  paint order between neighboring entities — matching how the real game's
 *  alt-mode reads as a UI-like layer over the world, not part of it. */
export function drawAltModeOverlay(
  ctx: CanvasRenderingContext2D,
  iconAtlas: IconAtlas,
  entity: PlacedEntity,
  visual: ResolvedVisual,
): void {
  drawQualityBadge(ctx, iconAtlas, entity, visual);

  const [fw, fh] = visual.tileFootprint;
  if (!visual.isMachine && !visual.isBeacon) return;

  // Recipe badge: centered on the machine, or nudged up a touch when a
  // module row will also be drawn so the two don't overlap.
  if (visual.isMachine && entity.recipe) {
    const hasModules = entity.modules.length > 0;
    const recipeCy = entity.y - (hasModules ? RECIPE_ICON_SIZE * 0.35 : 0);
    drawIcon(ctx, iconAtlas, entity.recipe, entity.x, recipeCy, Math.min(RECIPE_ICON_SIZE, fw * 0.6, fh * 0.6));
  }

  // Module row: one icon per module instance (ModuleStack.count expands,
  // matching how the real game shows one visible module per slot rather
  // than a count badge), centered as a horizontal strip under the recipe
  // badge (machines) or under the entity center (beacons, which have no
  // recipe badge to make room for).
  if (entity.modules.length > 0) {
    const instances: string[] = [];
    for (const stack of entity.modules) {
      for (let i = 0; i < stack.count; i++) instances.push(stack.name);
    }
    if (instances.length > 0) {
      const step = MODULE_ICON_SIZE + MODULE_ICON_GAP;
      const totalWidth = instances.length * step - MODULE_ICON_GAP;
      const startX = entity.x - totalWidth / 2 + MODULE_ICON_SIZE / 2;
      const rowY = visual.isMachine ? entity.y + RECIPE_ICON_SIZE * 0.55 : entity.y;
      instances.forEach((moduleName, i) => {
        drawIcon(ctx, iconAtlas, moduleName, startX + i * step, rowY, Math.min(MODULE_ICON_SIZE, fw / Math.max(instances.length, 1)));
      });
    }
  }
}
