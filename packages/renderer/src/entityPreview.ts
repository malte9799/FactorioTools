import { Layer, type PlacedEntity } from "@factoriotools/engine";
import { getSharedSpriteAtlas } from "./spriteAtlas.js";
import type { ResolvedVisual } from "./entityLookup.js";
import { collectEntity, collectInserterPlatform } from "./draw/collect.js";
import { paint } from "./draw/paint.js";
import { drawInserter, LONG_HANDED_RATIO, REACH } from "./sprites/inserter.js";
import { NeighbourGrid } from "./neighbours/grid.js";
import { FluidNetwork } from "./neighbours/fluid.js";
import { HeatNetwork } from "./neighbours/heat.js";
import type { DrawCommand } from "./draw/commands.js";

/** A centered fit box in world tiles: what computeFitBox measures the
 *  viewport around. */
export interface FitBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Measures the box a preview viewport should fit around, in world tiles
 *  centered on the entity's own (0,0). Pure and DOM-free so it can be
 *  covered directly by a test (see entityPreview.test.ts) without a canvas.
 *
 *  Prefers the ACTUAL extent of the given draw commands over a
 *  footprint*margin guess — a fixed margin is only ever as good as its
 *  constant, and silently clips any entity whose art overhangs further
 *  than that: confirmed by spike, the agricultural tower's crane arm
 *  reaches roughly 4.4 tiles from center on a 3x3 footprint, well past a
 *  1.6x margin's 2.4-tile budget, and rendered clipped/mis-scaled in this
 *  panel while the exact same collectEntity()/paint() pair looked correct
 *  in the free-pan main canvas and #/layer-debug (neither of which
 *  pre-sizes a viewport around the entity the way this fixed-size preview
 *  pane must).
 *
 *  The CENTER is measured from non-shadow commands only, then the box is
 *  grown symmetrically around that center to cover every command's full
 *  extent (shadow included) — confirmed by spike, a shadow's shift is
 *  asymmetric (the agricultural tower's own shift is [1.45, 0.30], purely
 *  toward one side), so folding it into a plain min/max alongside
 *  everything else pulls the midpoint off the building's own visual
 *  center; the building itself should sit centered in the panel, with its
 *  shadow trailing off to whichever side it naturally falls, same as it
 *  does on the main canvas — never clipped, but never the thing being
 *  centered on either.
 *
 *  Falls back to footprint*margin when there are no commands to measure —
 *  a defensive floor for an empty/malformed command list, so a tiny edge
 *  case still gets a sane, centered fit instead of dividing by ~0. (An
 *  inserter doesn't use this at all: mountEntityPreview sizes its box from
 *  the arm's reach, which no draw command carries.) */
export function computeFitBox(tileFootprint: [number, number], commands: DrawCommand[]): FitBox {
  const [fw, fh] = tileFootprint;
  const margin = 1.6;
  const fallback = { minX: -(fw * margin) / 2, maxX: (fw * margin) / 2, minY: -(fh * margin) / 2, maxY: (fh * margin) / 2 };

  const extentOf = (cs: DrawCommand[]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cs) {
      minX = Math.min(minX, c.dx);
      maxX = Math.max(maxX, c.dx + c.dw);
      minY = Math.min(minY, c.dy);
      maxY = Math.max(maxY, c.dy + c.dh);
    }
    return { minX, maxX, minY, maxY };
  };

  const content = commands.filter((c) => c.layer !== Layer.Shadow);
  const contentExtent = content.length > 0 ? extentOf(content) : fallback;
  const cx = (contentExtent.minX + contentExtent.maxX) / 2;
  const cy = (contentExtent.minY + contentExtent.maxY) / 2;

  // Grow the box symmetrically around that center so every command
  // (shadow included) stays inside it — the farthest any command's own
  // edge sits from the content center, doubled, is exactly the half-extent
  // a symmetric-about-center box needs to still contain it.
  let halfW = (contentExtent.maxX - contentExtent.minX) / 2;
  let halfH = (contentExtent.maxY - contentExtent.minY) / 2;
  if (commands.length > 0) {
    const all = extentOf(commands);
    halfW = Math.max(halfW, cx - all.minX, all.maxX - cx);
    halfH = Math.max(halfH, cy - all.minY, all.maxY - cy);
  } else {
    halfW = (fallback.maxX - fallback.minX) / 2;
    halfH = (fallback.maxY - fallback.minY) / 2;
  }

  return {
    cx,
    cy,
    w: Math.max(halfW * 2, 0.1),
    h: Math.max(halfH * 2, 0.1),
  };
}

/** A small standalone canvas that draws exactly one entity, centered and
 *  scaled to fill the canvas — the real game's own machine-GUI preview pane
 *  (a checkered-transparent thumbnail of the building) reused here for the
 *  properties GUI's header. Shares the exact drawEntity() dispatch the main
 *  blueprint canvas uses (same sprite atlas convention, same alt-mode-free
 *  static pose) rather than a second rendering path, so the preview always
 *  matches what the entity actually looks like on the grid. Shares the main
 *  renderer's SpriteAtlas (see spriteAtlas.ts's getSharedSpriteAtlas) so
 *  opening a properties panel never re-decodes a sheet the main canvas has
 *  already loaded. */
export function mountEntityPreview(
  container: HTMLElement,
  entityName: string,
  direction: number,
  visual: ResolvedVisual,
  controlBehavior?: PlacedEntity["controlBehavior"],
): () => void {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.replaceChildren(canvas);

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const atlas = getSharedSpriteAtlas();

  const entity: PlacedEntity = {
    entityNumber: -1,
    name: entityName,
    x: 0,
    y: 0,
    direction,
    quality: "normal",
    modules: [],
    filterItems: [],
    // A combinator's display shows the operation it is set to.
    controlBehavior,
  };

  let destroyed = false;

  function draw(): void {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Fit the entity into the available space, centered. Collected FIRST
    // (before any transform is applied) so computeFitBox can measure the
    // actual draw commands' own extents — see its own doc comment for why
    // that beats a footprint*margin guess. An inserter collects only its
    // platform (drawInserter paints the arm straight onto the canvas, not
    // through DrawCommand), so its box is sized by hand below instead.
    let commands: DrawCommand[] = [];
    if (visual.inserterGraphics) {
      collectInserterPlatform(commands, entity, visual.inserterGraphics, 1);
    } else if (visual.graphics) {
      const never = () => false;
      collectEntity(
        commands,
        entity,
        visual,
        { grid: new NeighbourGrid(), fluidNetwork: new FluidNetwork(), heatNetwork: new HeatNetwork(), isPipeLike: never, isHeatPipeLike: never, isWallLike: never, isBeltLike: never, platformBoxes: [], animationFrame: 0 },
        1,
      );
    }

    // An inserter's box is centered on its pivot and wide enough for the
    // arm at full reach in any facing, so rotating it never rescales or
    // shifts the preview, and the hand is never clipped.
    const armSpan = 2 * (REACH * (entityName === "long-handed-inserter" ? LONG_HANDED_RATIO : 1) + 1);
    const box = visual.inserterGraphics ? { cx: 0, cy: 0, w: armSpan, h: armSpan } : computeFitBox(visual.tileFootprint, commands);
    const pixelsPerTile = Math.min(rect.width / box.w, rect.height / box.h);

    ctx.save();
    ctx.translate(rect.width / 2, rect.height / 2);
    ctx.scale(pixelsPerTile, pixelsPerTile);
    ctx.translate(-box.cx, -box.cy);
    if (visual.inserterGraphics) {
      // Platform first, then the arm over it — the main canvas's own order.
      paint(ctx, atlas, commands, dpr * pixelsPerTile);
      drawInserter(ctx, atlas, entity, visual.inserterGraphics);
    } else if (visual.graphics) {
      // Never actually used — this preview's commands carry no .tint, so
      // paint() never reaches the code path that reads it — but paint()
      // still wants a resolution argument, so this passes its own current
      // scale for consistency rather than a magic number.
      paint(ctx, atlas, commands, dpr * pixelsPerTile);
    }
    ctx.restore();
  }

  draw();
  // One redraw once sprites finish loading (they resolve async on first
  // atlas.get() miss) — mirrors render.ts's own atlas.whenIdle() pattern.
  // No animation loop otherwise: this is a static pose, redrawing every
  // frame would be pure waste.
  void atlas.whenIdle().then(draw);

  return () => {
    destroyed = true;
  };
}
