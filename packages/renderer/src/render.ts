import type { GameData, PlacedEntity, RenderCatalog } from "@factoriotools/engine";
import { Camera, PanMomentum } from "./camera.js";
import { SpriteAtlas } from "./spriteAtlas.js";
import { IconAtlas } from "./iconAtlas.js";
import { buildVisualLookup, effectiveFootprint, type ResolvedVisual } from "./entityLookup.js";
import { drawEntity, drawAltModeOverlay } from "./entityDraw.js";
import { buildPositionIndex, buildBeltFrameCache, type BeltLookupEntity, type BeltFrame } from "./beltGraph.js";
import { buildPipePositionIndex, type PipeLookupEntity } from "./pipeGraph.js";
import { SpatialIndex, type IndexedBox } from "./spatialIndex.js";

export interface HighlightRole {
  producers: Set<number>;
  consumers: Set<number>;
  beacons?: Set<number>;
}

/** Matches the real game's own cursor model instead of a mode toggle the
 *  user has to remember to switch: 'idle' means nothing is "in hand" — a
 *  left-click on empty space pans (drag), a left-click on an entity opens
 *  it (onSelect) instead of panning. 'place' means an entity IS in hand
 *  (picked from the palette or via the 'q' pipette) — left-click places it.
 *  Right-click behaves the same in both modes (see onPointerDown's erase
 *  logic): it removes whatever's under the cursor after a short press-and-
 *  hold, then erases anything the cursor drags across immediately, exactly
 *  like the real game's mine-by-right-click. */
export type InteractionMode = { kind: "idle" } | { kind: "place"; entityName: string };

export interface BlueprintRenderer {
  canvas: HTMLCanvasElement;
  camera: Camera;
  loadBlueprint(entities: PlacedEntity[]): void;
  /** Rebuilds the spatial/position indices for a mutated entity list WITHOUT
   *  reframing the camera — what every edit (place/remove/rotate/configure)
   *  calls, so the view never jumps mid-edit. loadBlueprint additionally
   *  reframes; use that only for first load / switching blueprints. */
  updateEntities(entities: PlacedEntity[]): void;
  setHighlight(role: HighlightRole | null): void;
  setInteractionMode(mode: InteractionMode): void;
  /** Dev-only: freeze/unfreeze the belt animation clock and step it by an
   *  exact frame count, for deterministic frame-by-frame comparison. */
  setAnimationFrozen(frozen: boolean): void;
  stepAnimationFrame(delta?: number): void;
  getAnimationFrame(): number;
  /** Toggles Factorio's own Alt-mode look: recipe icons on crafting
   *  machines, module icons on machines/beacons that have any equipped. */
  setAltMode(enabled: boolean): void;
  /** Quarter-turns the ghost's facing while in 'place' mode (no-op
   *  otherwise) — what the 'r' keyboard shortcut calls, mirroring
   *  Factorio's own "rotate what you're holding" convention. Uses the
   *  8-way scheme (step 2 of a full turn of 8), matching every other
   *  direction value this renderer produces for freshly-placed entities. */
  rotateGhost(): void;
  hitTest(clientX: number, clientY: number): number | undefined;
  /** Fires on pointermove while not panning, with the entity under the
   *  cursor (or undefined). */
  onHover(callback: (entityNumber: number | undefined, e: PointerEvent) => void): void;
  /** Fires on a left-click in 'place' mode, with the (already
   *  grid-snapped-by-caller — see index.ts) world position and the ghost's
   *  current facing (see rotateGhost) at the moment of the click. */
  onPlace(callback: (worldX: number, worldY: number, direction: number) => void): void;
  /** Fires on a left-click in 'idle' mode that landed on an entity —
   *  matches the real game's own "click a building to open it" behavior.
   *  Never fires for a click that misses (that starts a pan instead, see
   *  InteractionMode's own doc comment) or while something's in hand. */
  onSelect(callback: (entityNumber: number) => void): void;
  /** Fires once per entity a right-click removes — after the initial
   *  press-and-hold delay for a stationary right-click, or immediately
   *  (no delay) for every entity the cursor drags across afterward. Mirrors
   *  the real game's mine-by-right-click, including its "hold briefly, then
   *  drag to mass-erase" feel. Fires regardless of 'idle' vs 'place' mode —
   *  holding an item in hand doesn't suppress right-click removal in the
   *  real game either. */
  onErase(callback: (entityNumber: number) => void): void;
  destroy(): void;
}

const FALLBACK_FOOTPRINT: [number, number] = [1, 1];

/** Mounts a self-contained Canvas2D blueprint renderer into `container`,
 *  wiring up Factorio-feel pan/zoom (see camera.ts) and hover hit-testing
 *  (spatialIndex.ts) without any external rendering library. */
export function mountRenderer(container: HTMLElement, data: GameData, catalog: RenderCatalog): BlueprintRenderer {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.cursor = "grab";
  // Without these, the browser's own left-click drag-to-select-text (or, on
  // some browsers, a native drag-image ghost of the canvas element itself)
  // can kick in alongside pointer-capture panning — confirmed by spike, the
  // canvas has no text content to select but is still a draggable element
  // by default, which was enough to make panning feel like it was
  // "fighting" the browser on some left-drags.
  canvas.style.userSelect = "none";
  (canvas.style as CSSStyleDeclaration & { webkitUserDrag?: string }).webkitUserDrag = "none";
  canvas.draggable = false;
  container.replaceChildren(canvas);

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // crisp pixel art, matching the game's own look at high zoom

  const atlas = new SpriteAtlas();
  const iconAtlas = new IconAtlas();
  const visualLookup = buildVisualLookup(data, catalog);
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });
  const momentum = new PanMomentum();

  let entities: PlacedEntity[] = [];
  let positionIndex = new Map<string, BeltLookupEntity>();
  let beltFrameCache = new Map<number, BeltFrame>();
  let pipePositionIndex = new Map<string, PipeLookupEntity>();
  let spatialIndex = new SpatialIndex([]);
  let highlight: HighlightRole | null = null;
  let altMode = false;
  let animationFrame = 0;
  let dpr = window.devicePixelRatio || 1;
  let rafHandle = 0;
  let isPanning = false;
  let lastPointer = { x: 0, y: 0 };
  let destroyed = false;
  let mode: InteractionMode = { kind: "idle" };
  let ghostWorldPos: { x: number; y: number } | null = null;
  let ghostDirection = 0;

  // Right-click erase state: instant on press, then drags across more
  // entities keep erasing for the rest of the gesture — no start delay
  // (removed per user feedback: the initial press-and-hold felt laggy).
  let isErasing = false;
  let erasedThisGesture = new Set<number>();

  // Left-click-drag-to-place state: mirrors the erase state above — instant
  // on press, then drags across more grid cells keep placing for the rest
  // of the gesture (per user feedback, matching the real game's own
  // drag-a-line-of-belts/walls feel instead of one placement per click).
  let isPlacingDrag = false;
  let placedThisGesture = new Set<string>();

  function resize(): void {
    const rect = container.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function visualFor(name: string): ResolvedVisual | undefined {
    return visualLookup.get(name);
  }

  function isBeltLike(name: string): boolean {
    return visualLookup.get(name)?.isBeltLike ?? false;
  }

  function isPipeLike(name: string): boolean {
    const v = visualLookup.get(name);
    return (v?.isPipeLike || v?.isPipeToGround) ?? false;
  }

  function isPipeToGround(name: string): boolean {
    return visualLookup.get(name)?.isPipeToGround ?? false;
  }

  /** Factorio snaps placement so the footprint's edges land on the tile
   *  grid: a footprint dimension's parity determines whether its CENTER
   *  coordinate is an integer or a half-integer. An odd-width footprint
   *  (1, 3, ...) centered at an integer would have edges at a half-tile
   *  offset (wrong); centering it at x.5 puts its edges on whole tiles
   *  (right). An even-width footprint (2, 4, ...) is the other way round. */
  function snapAxis(worldCoord: number, footprintDim: number): number {
    const isOdd = Math.round(footprintDim) % 2 === 1;
    return isOdd ? Math.floor(worldCoord) + 0.5 : Math.round(worldCoord);
  }

  function draw(): void {
    if (destroyed) return;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f1e1c";
    ctx.fillRect(0, 0, w, h);

    // World-space transform: camera center maps to viewport center, y-down
    // matches both screen space and Factorio's own coordinate convention.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(camera.state.pixelsPerTile, camera.state.pixelsPerTile);
    ctx.translate(-camera.state.x, -camera.state.y);

    drawGrid(ctx, camera, w, h);

    // Frustum culling: only entities whose box overlaps the current viewport
    // (padded a bit for sprites that overhang their tile footprint, e.g.
    // belts/inserters) go through the expensive per-entity draw path below.
    // `entities` order is preserved (queryRect returns an unordered Set) so
    // paint order — and with it hit-testing's "topmost = last drawn"
    // convention — stays exactly as before culling was added.
    const viewTopLeft = camera.screenToWorld(0, 0, w, h);
    const viewBottomRight = camera.screenToWorld(w, h, w, h);
    const CULL_PADDING = 2;
    const visibleIds = spatialIndex.queryRect(
      viewTopLeft.x - CULL_PADDING,
      viewTopLeft.y - CULL_PADDING,
      viewBottomRight.x + CULL_PADDING,
      viewBottomRight.y + CULL_PADDING,
    );
    const visibleEntities = entities.filter((e) => visibleIds.has(e.entityNumber));

    const hasHighlight = highlight !== null;
    for (const entity of visibleEntities) {
      const visual = visualFor(entity.name);
      if (!visual) continue;

      let alpha = 1;
      if (hasHighlight) {
        const isProducer = highlight!.producers.has(entity.entityNumber);
        const isConsumer = highlight!.consumers.has(entity.entityNumber);
        const isBeacon = highlight!.beacons?.has(entity.entityNumber) ?? false;
        alpha = isProducer || isConsumer || isBeacon ? 1 : 0.28;
      }
      ctx.globalAlpha = alpha;
      drawEntity({ ctx, atlas, animationFrame }, entity, visual, positionIndex, pipePositionIndex, beltFrameCache);

      if (hasHighlight) {
        const isProducer = highlight!.producers.has(entity.entityNumber);
        const isConsumer = highlight!.consumers.has(entity.entityNumber);
        if (isProducer || isConsumer) {
          const [fw, fh] = effectiveFootprint(visual, entity.direction);
          ctx.save();
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = isProducer ? "#93d977" : "#ffcc80";
          ctx.fillRect(entity.x - fw / 2, entity.y - fh / 2, fw, fh);
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Alt-mode badges: a separate pass over every entity, after all sprites
    // are drawn, so a badge never gets painted over by a neighboring
    // entity's own sprite depending on entity list order — matches the
    // real game's alt-mode reading as a UI-like layer over the world.
    if (altMode) {
      for (const entity of visibleEntities) {
        const visual = visualFor(entity.name);
        if (visual) drawAltModeOverlay(ctx, iconAtlas, entity, visual);
      }
    }

    if (mode.kind === "place" && ghostWorldPos) {
      const visual = visualFor(mode.entityName);
      if (visual) {
        const [fw, fh] = effectiveFootprint(visual, ghostDirection);
        const snapped = {
          x: snapAxis(ghostWorldPos.x, fw),
          y: snapAxis(ghostWorldPos.y, fh),
        };
        const ghost: PlacedEntity = {
          entityNumber: -1,
          name: mode.entityName,
          x: snapped.x,
          y: snapped.y,
          direction: ghostDirection,
          quality: "normal",
          modules: [],
          filterItems: [],
        };
        ctx.globalAlpha = 0.5;
        drawEntity({ ctx, atlas, animationFrame }, ghost, visual, positionIndex, pipePositionIndex);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  let animationFrozen = false;

  function tick(): void {
    if (destroyed) return;
    if (!animationFrozen) animationFrame = (animationFrame + 1) % 1_000_000;
    const step = momentum.step(16);
    if (step) camera.panByScreenDelta(step.dx, step.dy);
    draw();
    rafHandle = requestAnimationFrame(tick);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.pow(1.0015, -e.deltaY);
    camera.zoomAt(factor, sx, sy, rect.width, rect.height);
  }

  function worldAtPointer(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  }

  function eraseAtPointer(e: PointerEvent): void {
    const world = worldAtPointer(e);
    const hit = spatialIndex.hitTest(world.x, world.y);
    if (hit === undefined || erasedThisGesture.has(hit)) return;
    erasedThisGesture.add(hit);
    eraseCallback?.(hit);
  }

  /** Places at the ghost's current snapped grid cell if that cell hasn't
   *  already been placed into during this drag — matching the real game's
   *  drag-to-place-a-line-of-belts/walls feel: hold left-click and drag to
   *  keep placing wherever the ghost lands, one placement per cell instead
   *  of one per pointermove event (which would fire many times over the
   *  same cell at normal drag speeds). */
  function placeAtGhost(): void {
    if (mode.kind !== "place" || !ghostWorldPos) return;
    const visual = visualFor(mode.entityName);
    const [fw, fh] = visual ? effectiveFootprint(visual, ghostDirection) : FALLBACK_FOOTPRINT;
    const snapped = { x: snapAxis(ghostWorldPos.x, fw), y: snapAxis(ghostWorldPos.y, fh) };
    const key = `${snapped.x},${snapped.y}`;
    if (placedThisGesture.has(key)) return;
    placedThisGesture.add(key);
    placeCallback?.(snapped.x, snapped.y, ghostDirection);
  }

  function onPointerDown(e: PointerEvent): void {
    // Stops the browser's own left-click text-selection drag from starting
    // alongside pointer-capture panning/placing/opening — confirmed by
    // spike this was the source of pan sometimes feeling like the native
    // browser gesture was still "coming through" underneath it.
    e.preventDefault();

    if (e.button === 2) {
      // Right-click erase: fires immediately on press (no start delay —
      // removed per user feedback, it felt laggy), then dragging across
      // more entities keeps erasing for the rest of the gesture. Works
      // identically whether or not something's in hand (mode.kind ===
      // "place") — the real game doesn't suppress right-click removal
      // while holding an item either.
      erasedThisGesture = new Set();
      isErasing = true;
      eraseAtPointer(e);
      return;
    }
    if (e.button !== 0) return;

    if (mode.kind === "place") {
      isPlacingDrag = true;
      placedThisGesture = new Set();
      placeAtGhost();
      return;
    }

    // 'idle' mode: a click that lands on an entity opens it (matches the
    // real game's "click a building to open it") instead of panning: only
    // a click on empty space starts a pan/drag.
    const world = worldAtPointer(e);
    const hit = spatialIndex.hitTest(world.x, world.y);
    if (hit !== undefined) {
      selectCallback?.(hit);
      return;
    }

    isPanning = true;
    momentum.stop();
    lastPointer = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  }

  function onPointerMove(e: PointerEvent): void {
    if (isErasing) {
      eraseAtPointer(e);
    }
    if (mode.kind === "place") {
      ghostWorldPos = worldAtPointer(e);
      if (isPlacingDrag) placeAtGhost();
    }
    if (isPanning) {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      camera.panByScreenDelta(dx, dy);
      momentum.recordDelta(dx, dy, performance.now());
      lastPointer = { x: e.clientX, y: e.clientY };
      return;
    }
    onHoverMove?.(e);
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.button === 2) {
      isErasing = false;
      return;
    }
    isPlacingDrag = false;
    if (!isPanning) return;
    isPanning = false;
    canvas.style.cursor = "grab";
    momentum.release(performance.now());
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  let hoverCallback: ((entityNumber: number | undefined, e: PointerEvent) => void) | null = null;
  let placeCallback: ((worldX: number, worldY: number, direction: number) => void) | null = null;
  let selectCallback: ((entityNumber: number) => void) | null = null;
  let eraseCallback: ((entityNumber: number) => void) | null = null;
  const onHoverMove = (e: PointerEvent) => {
    if (!hoverCallback) return;
    const world = worldAtPointer(e);
    const hit = spatialIndex.hitTest(world.x, world.y);
    hoverCallback(hit, e);
  };

  const resizeObserver = new ResizeObserver(() => {
    resize();
  });
  resizeObserver.observe(container);
  resize();

  const onDragStart = (e: DragEvent) => e.preventDefault();
  // Right-click now means "erase" (see onPointerDown), so the browser's own
  // right-click context menu must never appear over the canvas.
  const onContextMenu = (e: MouseEvent) => e.preventDefault();

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  // Backstop for the same native-drag/select interference onPointerDown's
  // preventDefault already targets — belt and braces, since dragstart can
  // fire from a stray mousedown sequence pointerdown doesn't always cover.
  canvas.addEventListener("dragstart", onDragStart);
  canvas.addEventListener("contextmenu", onContextMenu);

  rafHandle = requestAnimationFrame(tick);

  /** Rebuilds the position/spatial indices and kicks off sprite preloading
   *  for a new entity list — everything loadBlueprint/updateEntities share.
   *  Deliberately does NOT touch the camera; loadBlueprint adds that on top
   *  for first-load/switch-blueprint, updateEntities doesn't so edits never
   *  jump the view. */
  function rebuildIndices(newEntities: PlacedEntity[]): void {
    entities = newEntities;
    positionIndex = buildPositionIndex(entities, isBeltLike);
    beltFrameCache = buildBeltFrameCache(entities, isBeltLike, positionIndex);
    pipePositionIndex = buildPipePositionIndex(entities, isPipeLike, isPipeToGround);

    const boxes: IndexedBox[] = [];
    for (const e of entities) {
      const visual = visualFor(e.name);
      const [w, h] = visual ? effectiveFootprint(visual, e.direction) : FALLBACK_FOOTPRINT;
      boxes.push({
        entityNumber: e.entityNumber,
        left: e.x - w / 2,
        top: e.y - h / 2,
        right: e.x + w / 2,
        bottom: e.y + h / 2,
      });
    }
    spatialIndex = new SpatialIndex(boxes);

    // Kick off sprite loads for everything now visible, then redraw once the
    // initial burst settles so entities don't sit as outlines. Exhaustive
    // over EntityGraphics' `kind` so a new variant added later fails to
    // compile here instead of silently never preloading its sheets (they'd
    // still eventually load on first draw-time atlas.get() miss, just with
    // a visible outline-box flash first).
    for (const e of entities) {
      const graphics = visualFor(e.name)?.graphics;
      if (!graphics) continue;
      switch (graphics.kind) {
        case "sprite-4way":
        case "static":
        case "belt":
        case "underground":
          atlas.get(graphics.sheet);
          if (graphics.kind !== "belt" && graphics.kind !== "underground" && graphics.shadow) atlas.get(graphics.shadow.sheet);
          break;
        case "layered-static":
          atlas.get(graphics.base.sheet);
          if (graphics.shadow) atlas.get(graphics.shadow.sheet);
          for (const layer of graphics.layers) atlas.get(layer.sheet);
          break;
        case "pipe":
          for (const layer of Object.values(graphics.connectors)) atlas.get(layer.sheet);
          break;
        case "splitter":
          atlas.get(graphics.belt.sheet);
          atlas.get(graphics.body.north.sheet);
          atlas.get(graphics.body.east.sheet);
          atlas.get(graphics.body.south.sheet);
          atlas.get(graphics.body.west.sheet);
          break;
        case "gate":
          atlas.get(graphics.sprites.north.sheet);
          atlas.get(graphics.sprites.east.sheet);
          atlas.get(graphics.shadows.north.sheet);
          atlas.get(graphics.shadows.east.sheet);
          break;
        case "none":
          break;
      }
    }
    void atlas.whenIdle().then(() => draw());
  }

  function loadBlueprint(newEntities: PlacedEntity[]): void {
    rebuildIndices(newEntities);
    const rect = container.getBoundingClientRect();
    const box = spatialIndex.boundingBox;
    if (box) camera.frame(box, rect.width, rect.height);
  }

  return {
    canvas,
    camera,
    loadBlueprint,
    updateEntities: rebuildIndices,
    setHighlight(role) {
      highlight = role;
    },
    /** Dev-only: freeze/unfreeze the belt animation clock and step it by an
     *  exact frame count, for deterministic frame-by-frame comparison
     *  (e.g. via window.__debug in the app layer) instead of eyeballing a
     *  live 60fps animation. */
    setAnimationFrozen(frozen: boolean) {
      animationFrozen = frozen;
    },
    stepAnimationFrame(delta = 1) {
      animationFrame = (animationFrame + delta + 1_000_000) % 1_000_000;
      draw();
    },
    getAnimationFrame() {
      return animationFrame;
    },
    setAltMode(enabled) {
      altMode = enabled;
    },
    setInteractionMode(newMode) {
      // A fresh entry into 'place' mode (including switching which entity
      // is selected in the palette) starts facing north again — carrying
      // over a stale rotation from whatever was placed previously would be
      // surprising, not convenient.
      if (newMode.kind === "place" && (mode.kind !== "place" || mode.entityName !== newMode.entityName)) {
        ghostDirection = 0;
      }
      mode = newMode;
      if (mode.kind !== "place") ghostWorldPos = null;
      canvas.style.cursor = mode.kind === "place" ? "crosshair" : "grab";
    },
    rotateGhost() {
      // Quarter-turn in the 16-way scheme (step 4 of 16) — matches
      // toCardinal()'s own commitment to 16-way-only (see its doc comment
      // in beltGraph.ts): every direction value this renderer produces is
      // 16-way, since that's the only scheme Factorio 2.0 blueprint exports
      // use. A previous 8-way step here (+2 of 8) was inconsistent with
      // that and silently produced directions toCardinal() would then
      // misinterpret.
      if (mode.kind !== "place") return;
      ghostDirection = (ghostDirection + 4) % 16;
    },
    hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const world = camera.screenToWorld(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
      return spatialIndex.hitTest(world.x, world.y);
    },
    onHover(callback) {
      hoverCallback = callback;
    },
    onPlace(callback) {
      placeCallback = callback;
    },
    onSelect(callback) {
      selectCallback = callback;
    },
    onErase(callback) {
      eraseCallback = callback;
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafHandle);
      resizeObserver.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("dragstart", onDragStart);
      canvas.removeEventListener("contextmenu", onContextMenu);
    },
  };
}

/** Checkerboard tile colors — matches the "transparent background" checker
 *  pattern from the user's own reference screenshots (the entity preview's
 *  backdrop, reused here for the main canvas floor instead of a plain
 *  line-grid), not a real Factorio ground texture. Two shades close enough
 *  in value that they read as a floor, not a strong pattern. */
const CHECKER_LIGHT = "#333230";
const CHECKER_DARK = "#2b2a28";

function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, viewportW: number, viewportH: number): void {
  const topLeft = camera.screenToWorld(0, 0, viewportW, viewportH);
  const bottomRight = camera.screenToWorld(viewportW, viewportH, viewportW, viewportH);
  const startX = Math.floor(topLeft.x);
  const endX = Math.ceil(bottomRight.x);
  const startY = Math.floor(topLeft.y);
  const endY = Math.ceil(bottomRight.y);

  ctx.save();
  // One fillRect per tile is fine at any zoom level actually reachable here
  // (the camera clamps how far you can zoom in, capping the tile count a
  // single frame ever needs to fill) — simpler than batching same-color
  // tiles into one path, and per-tile solid fills is exactly what a
  // checkerboard is.
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // A subtle chunk-boundary line every 8 tiles (Factorio's own chunk size)
  // survives from the old line-grid — still useful for gauging scale/
  // alignment at a glance, just layered over the checker instead of being
  // the whole floor. Skipped once zoomed out far enough that it'd be noise.
  if (camera.state.pixelsPerTile >= 16) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5 / camera.state.pixelsPerTile;
    ctx.beginPath();
    const chunkStart = Math.floor(startX / 8) * 8;
    const chunkEndX = Math.ceil(endX / 8) * 8;
    const chunkStartY = Math.floor(startY / 8) * 8;
    const chunkEndY = Math.ceil(endY / 8) * 8;
    for (let x = chunkStart; x <= chunkEndX; x += 8) {
      ctx.moveTo(x, chunkStartY);
      ctx.lineTo(x, chunkEndY);
    }
    for (let y = chunkStartY; y <= chunkEndY; y += 8) {
      ctx.moveTo(chunkStart, y);
      ctx.lineTo(chunkEndX, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
