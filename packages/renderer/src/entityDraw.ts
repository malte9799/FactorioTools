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
import type { BeltLookupEntity } from "./beltGraph.js";
import type { PipeLookupEntity } from "./pipeGraph.js";
import {
  type DrawContext,
  type RenderContext,
  type EntityRenderer,
  Sprite4WayRenderer,
  LayeredStaticRenderer,
  BeltRenderer,
  UndergroundBeltRenderer,
  SplitterRenderer,
  GateRenderer,
  InserterRenderer,
  pipeRenderer,
} from "./entityRenderers.js";

const sprite4WayRenderer = new Sprite4WayRenderer();
const layeredStaticRenderer = new LayeredStaticRenderer();
const beltRenderer = new BeltRenderer();
const undergroundBeltRenderer = new UndergroundBeltRenderer();
const splitterRenderer = new SplitterRenderer();
const gateRenderer = new GateRenderer();
const inserterRenderer = new InserterRenderer();

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
  if (visual.graphics?.kind === "gate") return gateRenderer;
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
): void {
  const rc: RenderContext = { ...dc, positionIndex, pipePositionIndex };
  rendererFor(visual).draw(rc, entity, visual, entity.x, entity.y);
}

/** Icon badge size, in tile units — small enough to sit inside even a 1x1
 *  entity's footprint without badly overhanging, matching the real game's
 *  alt-mode badges being a modest fraction of the entity's own size. */
const RECIPE_ICON_SIZE = 0.5;
const MODULE_ICON_SIZE = 0.32;
const MODULE_ICON_GAP = 0.04;

function drawIcon(ctx: CanvasRenderingContext2D, iconAtlas: IconAtlas, name: string, cx: number, cy: number, size: number): boolean {
  const found = iconAtlas.get(name);
  if (!found) return false;
  const { sheet, cell } = found;
  // A translucent dark backing disc, matching the real game's alt-mode icon
  // badges (a dark circular chip behind the icon) so a bright icon stays
  // legible against any entity sprite color underneath.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2 + size * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,18,15,0.72)";
  ctx.fill();
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
