/** Top-level dispatch: picks which EntityRenderer (see entityRenderers.ts)
 *  draws a given entity, plus the alt-mode icon overlay pass, which is a
 *  separate UI-like layer over the world rather than part of any one
 *  entity's own sprite composition. Per-building draw logic itself lives in
 *  entityRenderers.ts, grouped by rendering strategy (Sprite4Way,
 *  LayeredStatic, ConnectionArt, ...) rather than one function per building
 *  — see that file's own top-of-file doc comment for why. */
import type { PlacedEntity } from "@factoriotools/engine";
import type { ResolvedVisual } from "./entityLookup.js";
import type { IconAtlas } from "./iconAtlas.js";
import type { BeltLookupEntity, BeltFrame } from "./beltGraph.js";
import type { PipeLookupEntity, PipeVariant } from "./pipeGraph.js";
import type { WallLookupEntity, WallSprite } from "./wallGraph.js";
import {
  type DrawContext,
  type RenderContext,
  type EntityRenderer,
  Sprite4WayRenderer,
  LayeredStaticRenderer,
  BeltRenderer,
  UndergroundBeltRenderer,
  SplitterRenderer,
  DirectionalSpriteRenderer,
  WallRenderer,
  InserterRenderer,
  DirectionalStaticRenderer,
  RailRenderer,
  pipeRenderer,
} from "./entityRenderers.js";

const sprite4WayRenderer = new Sprite4WayRenderer();
const layeredStaticRenderer = new LayeredStaticRenderer();
const beltRenderer = new BeltRenderer();
const undergroundBeltRenderer = new UndergroundBeltRenderer();
const splitterRenderer = new SplitterRenderer();
const directionalSpriteRenderer = new DirectionalSpriteRenderer();
const wallRenderer = new WallRenderer();
const inserterRenderer = new InserterRenderer();
const directionalStaticRenderer = new DirectionalStaticRenderer();
const railRenderer = new RailRenderer();

/** Selects the EntityRenderer instance for a resolved visual — the only
 *  place that maps "what kind of thing is this" to "which rendering
 *  strategy draws it", so adding a new EntityGraphics `kind` (or a new
 *  isXxx flag like isInserter) means adding one branch here, not a new
 *  draw function plus a new dispatch branch in two places. Order matters:
 *  belts/undergrounds/splitters are matched before the generic
 *  isBeltLike-agnostic pipe/inserter/layered-static/sprite-4way fallthrough,
 *  same precedence the original hand-written if-chain used. */
function rendererFor(visual: ResolvedVisual): EntityRenderer {
  if (visual.isBeltLike && visual.graphics?.kind === "belt") return beltRenderer;
  if (visual.graphics?.kind === "underground") return undergroundBeltRenderer;
  if (visual.graphics?.kind === "splitter") return splitterRenderer;
  if (visual.graphics?.kind === "gate" || visual.graphics?.kind === "fusion-generator") return directionalSpriteRenderer;
  if (visual.graphics?.kind === "wall") return wallRenderer;
  if (visual.graphics?.kind === "straight-rail") return railRenderer;
  if (visual.graphics?.kind === "pipe-to-ground" || visual.graphics?.kind === "valve") return directionalStaticRenderer;
  if (visual.isPipeLike && visual.graphics?.kind === "pipe") return pipeRenderer;
  if (visual.isInserter) return inserterRenderer;
  if (visual.graphics?.kind === "layered-static") return layeredStaticRenderer;
  return sprite4WayRenderer;
}

export function drawEntity(
  dc: DrawContext,
  entity: PlacedEntity,
  visual: ResolvedVisual,
  positionIndex: Map<string, BeltLookupEntity>,
  pipePositionIndex: Map<string, PipeLookupEntity>,
  beltFrameCache: Map<number, BeltFrame> = new Map(),
  pipeVariantCache: Map<number, PipeVariant> = new Map(),
  wallPositionIndex: Map<string, WallLookupEntity> = new Map(),
  wallVariantCache: Map<number, WallSprite> = new Map(),
): void {
  const rc: RenderContext = { ...dc, positionIndex, pipePositionIndex, beltFrameCache, pipeVariantCache, wallPositionIndex, wallVariantCache };
  rendererFor(visual).draw(rc, entity, visual, entity.x, entity.y);
}

/** Icon badge size, in tile units. Confirmed by spike against real
 *  Factorio alt-mode screenshots (forums.factorio.com/viewtopic.php?t=64803
 *  — a stock assembling-machine-3's own recipe badge measured directly off
 *  the posted screenshot) that recipe icons read as noticeably larger than
 *  this renderer previously drew them: the earlier RECIPE_ICON_SIZE (0.5)
 *  made the badge blend into the machine's own sprite at any zoom level
 *  short of an extreme close-up, especially for grey/metallic recipes like
 *  iron-gear-wheel sitting on a grey/metallic machine — not just a size
 *  problem but a legibility one, which is why the badge is also given a
 *  darker, more opaque backing disc below (drawIcon) rather than only being
 *  scaled up. */
const RECIPE_ICON_SIZE = 0.8;
const MODULE_ICON_SIZE = 0.42;
const MODULE_ICON_GAP = 0.05;

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
  if (!visual.isMachine && !visual.isBeacon) return;
  const [fw, fh] = visual.tileFootprint;

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
