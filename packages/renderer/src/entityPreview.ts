import type { PlacedEntity } from "@factoriotools/engine";
import { SpriteAtlas } from "./spriteAtlas.js";
import type { ResolvedVisual } from "./entityLookup.js";
import { collectEntity } from "./draw/collect.js";
import { paint } from "./draw/paint.js";
import { drawInserter } from "./sprites/inserter.js";
import { NeighbourGrid } from "./neighbours/grid.js";
import type { DrawCommand } from "./draw/commands.js";

/** A small standalone canvas that draws exactly one entity, centered and
 *  scaled to fill the canvas — the real game's own machine-GUI preview pane
 *  (a checkered-transparent thumbnail of the building) reused here for the
 *  properties GUI's header. Shares the exact drawEntity() dispatch the main
 *  blueprint canvas uses (same sprite atlas convention, same alt-mode-free
 *  static pose) rather than a second rendering path, so the preview always
 *  matches what the entity actually looks like on the grid. Owns its own
 *  SpriteAtlas instance — previews are opened one at a time (a single
 *  selection's GUI), so sharing the main renderer's atlas isn't worth the
 *  coupling. */
export function mountEntityPreview(container: HTMLElement, entityName: string, direction: number, visual: ResolvedVisual): () => void {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.replaceChildren(canvas);

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const atlas = new SpriteAtlas();

  const entity: PlacedEntity = {
    entityNumber: -1,
    name: entityName,
    x: 0,
    y: 0,
    direction,
    quality: "normal",
    modules: [],
    filterItems: [],
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

    // Fit the entity's footprint (plus its own sprite overhang margin) into
    // the available space, centered — mirrors camera.frame()'s own
    // fit-to-viewport math in render.ts, simplified since there's only ever
    // one entity and no pan/zoom state to preserve.
    const [fw, fh] = visual.tileFootprint;
    const margin = 1.6; // overhang allowance so sprites that spill past their footprint (most of them) aren't clipped
    const pixelsPerTile = Math.min(rect.width / (fw * margin), rect.height / (fh * margin));

    ctx.save();
    ctx.translate(rect.width / 2, rect.height / 2);
    ctx.scale(pixelsPerTile, pixelsPerTile);
    if (visual.inserterGraphics) {
      drawInserter(ctx, atlas, entity, visual.inserterGraphics);
    } else if (visual.graphics) {
      const commands: DrawCommand[] = [];
      const never = () => false;
      collectEntity(commands, entity, visual, { grid: new NeighbourGrid(), isPipeLike: never, isWallLike: never, isBeltLike: never, animationFrame: 0 }, 1);
      paint(ctx, atlas, commands);
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
