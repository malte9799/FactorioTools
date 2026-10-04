import type { GameData, PlacedEntity, QualityName, RenderCatalog, WireColor, WireLink } from "@factoriotools/engine";
import { Camera } from "./camera.js";
import { getSharedSpriteAtlas } from "./spriteAtlas.js";
import { getSharedIconAtlas } from "./iconAtlas.js";
import { activeFluidConnections, autoUnderground, buildVisualLookup, effectiveFootprint, hasAnimatedLayer, isPoleLike, isTwoDirectionOnly, isUndergroundLike, makeConnectorPredicates, rotateAroundCenter, rotationStep, undergroundPartner, type ResolvedVisual } from "./entityLookup.js";
import { ALL_ALT_MODE_LAYERS, drawAltModeOverlay, drawQualityBadge, type AltModeLayers } from "./entityDraw.js";
import { buildGrid, NeighbourGrid, step, toCardinal } from "./neighbours/grid.js";
import { buildFluidNetwork, FluidNetwork } from "./neighbours/fluid.js";
import { buildHeatNetwork, HeatNetwork } from "./neighbours/heat.js";
import type { PlatformBox } from "./neighbours/platform.js";
import { buildWireNetwork, resolveWires, terminalFor, terminalSideAt, type ResolvedWire, type WireNetwork } from "./neighbours/wires.js";
import { drawSupplyAreas, drawWires, type SupplyArea } from "./draw/wireDraw.js";
import { collectEntity, collectInserterPlatform, type CollectContext } from "./draw/collect.js";
import { paint, paintPlain, drawOutline, drawDirectionArrows, drawHoverHighlight, drawInserterIndication, drawRailStartArrow, drawBlockedCross, drawSignalHandle, drawStopHandle, drawRailBlockLine, drawRailBlockMarker, trimPolyline, RAIL_BLOCK_MARKER_INSET, drawUndergroundLine, type PaintTally } from "./draw/paint.js";
import { getHoverHighlightSprite, getIndicationSprites, getUndergroundLinesSprite } from "./hoverHighlightSprite.js";
import { compareDrawCommands, type DrawCommand } from "./draw/commands.js";
import { planBake, type BakePlan } from "./draw/bake.js";
import { drawInserter } from "./sprites/inserter.js";
import { SpatialIndex, type IndexedBox } from "./spatialIndex.js";
import { boxHitsEntity, entitiesCollide } from "./collision.js";
import { RAIL_BLOCK_COLORS } from "./railBlocks.js";
import { isRail, railCentreline, railHighlightBox, type RailEnd, type RailPiece } from "./railGeometry.js";
import {
  buildRailIndex,
  isRailPlannerItem,
  isRailSnapped,
  railStartAt,
  signalSlotsNear,
  stopSlotsNear,
  plannerTargetsElevated,
  previewRail,
  railsideSlot,
  startPiece,
  type RailIndex,
  type RailPreview,
} from "./railPlacement.js";

/** Milliseconds spent in each phase of one draw(). */
export interface FramePhases {
  /** Clearing the canvas and painting the tile grid. */
  grid: number;
  /** Spatial-index query plus turning ids back into entities. */
  cull: number;
  /** Classifying entities into draw commands and sorting them. 0 on a frame
   *  that reused the cached list. */
  collect: number;
  /** Patching the animated commands' source rects. */
  animate: number;
  /** drawImage calls for the scene sprites. */
  paint: number;
  /** Procedurally drawn inserters. */
  inserters: number;
  /** Highlight tint and alt-mode badge passes. */
  overlays: number;
  /** The placement ghost, including its preview networks. */
  ghost: number;
}

/** What the sprite atlas was doing during a recorded frame. Decoding a large
 *  sheet blocks the main thread outside draw(), so a frame can be slow with a
 *  cheap `renderMs`; without these a log cannot tell "expensive to draw" apart
 *  from "the browser was busy decoding". */
export interface FrameAtlasState {
  /** Sheets fully decoded and ready to draw from. */
  ready: number;
  /** Loads started but not yet settled. */
  pending: number;
  /** Loads actively fetching/decoding (capped by DECODE_CONCURRENCY). */
  decoding: number;
  /** Loads waiting for a decode slot. */
  queued: number;
}

/** What a frame actually put on the canvas, as opposed to what it intended
 *  to. See PaintTally in draw/paint.ts. */
export interface FramePaint {
  drawn: number;
  skipped: number;
  sheets: number;
  /** Painted area in CSS px², i.e. how much pixel-pushing the frame asked
   *  for. Divided by the viewport area this is the overdraw factor. */
  area: number;
  compositeSwitches: number;
}

/** One recorded frame. */
export interface FrameRecord {
  /** Milliseconds since the recording started. */
  t: number;
  /** Wall-clock gap since the previous drawn frame — what the user feels.
   *  This is the gap BEFORE this frame, i.e. how long the browser took to
   *  get back to us after the previous one. */
  frameMs: number;
  /** Time inside draw(). */
  renderMs: number;
  /** frameMs minus renderMs: time the browser spent on everything that is
   *  not our drawing — its own compositing, image decoding, GC, other tabs.
   *  A large gap here with a small renderMs is the signature of a stall that
   *  the renderer is not causing. */
  outsideMs: number;
  phases: FramePhases;
  visibleEntities: number;
  drawCommands: number;
  paint: FramePaint;
  atlas: FrameAtlasState;
  sceneRebuilt: boolean;
  /** Why the scene cache missed, when it did — the single most useful field
   *  for telling a legitimate rebuild from a cache that is thrashing. */
  rebuildReason: RebuildReason;
  /** Frames the loop deliberately skipped since the previous record because
   *  nothing was dirty. High values here are healthy: it means the dirty-flag
   *  optimisation is working. */
  skippedSince: number;
  /** JS heap in MB where the browser exposes it (Chromium only), so a
   *  recording can show a leak or a GC pause building up. */
  heapMB: number | null;
  /** What the camera was doing, so a spike can be attributed to panning,
   *  zooming or neither. */
  cameraX: number;
  cameraY: number;
  pixelsPerTile: number;
}

/** Why buildSceneCache ran for a frame. "none" means the cache was reused. */
export type RebuildReason =
  | "none"
  | "first"
  /** The blueprint's entities changed (edit, undo, load). */
  | "entities"
  /** setHighlight changed which entities are dimmed. */
  | "highlight"
  /** The set of visible entities changed — pan, zoom, or a resize. */
  | "visibility";

/** A statistical summary of a finished recording. Computed from the frame log
 *  rather than accumulated live, so it costs nothing while recording and can
 *  be recomputed over any subset later. */
export interface RecordingSummary {
  frames: number;
  /** Wall-clock span the recording covers, in ms. */
  durationMs: number;
  /** Frames the loop skipped because nothing was dirty. */
  framesSkipped: number;
  frameMs: Percentiles;
  renderMs: Percentiles;
  /** Time spent outside draw() — browser compositing, decoding, GC. */
  outsideMs: Percentiles;
  /** Total ms per phase across the whole recording, worst phase first. */
  phaseTotals: { phase: keyof FramePhases; ms: number; share: number }[];
  /** Frames slower than one 60 Hz vsync interval. */
  janky: number;
  /** Sum of frameMs over janky frames — how much of the session felt bad. */
  jankyMs: number;
  rebuilds: { reason: RebuildReason; count: number }[];
  /** Frames whose sheets were not all loaded — their paint is not
   *  representative, and their `skipped` count says how much was missing. */
  framesWithMissingSprites: number;
  /** Peak values worth knowing at a glance. */
  peakDrawCommands: number;
  peakVisibleEntities: number;
  peakHeapMB: number | null;
  /** Highest overdraw seen: painted area divided by viewport area. */
  peakOverdraw: number;
}

export interface Percentiles {
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Aggregated cost of one entity name in the last scene rebuild. */
export interface EntityCost {
  name: string;
  count: number;
  drawCommands: number;
  /** Total classification time for all instances of this name, in ms. */
  collectMs: number;
}

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
export type InteractionMode =
  | { kind: "idle" }
  | { kind: "place"; entityName: string; direction?: number; quality?: QualityName }
  /** A wire of this colour is "on the cursor" (Alt+C/R/G). A left-click on
   *  an entity reports it through onWireClick instead of opening it — two
   *  clicks make or break a wire between the pair. Clicks that miss an
   *  entity are inert rather than cancelling, so a stray click into empty
   *  space never silently drops a half-finished connection. */
  | { kind: "wire"; color: WireColor }
  /** The three box-drag action tools: a left-drag draws a marquee, and on
   *  release every entity whose footprint overlaps it is acted on
   *  IMMEDIATELY (no intermediate "selected, now confirm" state) — a plain
   *  click (no drag) acts on just the one entity under the cursor. Mode
   *  stays the same afterward, ready for another box, EXCEPT copyBox/
   *  cutBox: those hand off to 'paste' once a box completes (see onCopyBox/
   *  onCutBox), since the whole point is to arm a ghost with what was just
   *  grabbed. deleteBox has no such handoff — it just keeps deleting. */
  | { kind: "copyBox" }
  | { kind: "cutBox" }
  | { kind: "deleteBox" }
  /** A copied/cut selection "on the cursor", ready to stamp — the
   *  multi-entity equivalent of 'place'. `entities`/`wires` are the
   *  ORIGINAL copied entities (placeholder entityNumbers, untouched
   *  positions) offset from `anchor` (their bounding box's CENTER at copy
   *  time — the ghost is held from its middle, not a corner); the app
   *  remaps to fresh entityNumbers on every commit (see onPaste), since the
   *  ghost stays armed for repeated stamping rather than being consumed by
   *  one click. `groupRotation` is an extra 90°-step rotation (0/4/8/12 in
   *  the 16-way scheme) applied on top of the copied data at draw/commit
   *  time (see rotatePasteGhost) — kept separate from mutating
   *  `entities`/`anchor` directly so repeated R presses compose exactly
   *  (no drift) and `entities` always stays an honest, stable copy of what
   *  was actually selected. */
  | {
      kind: "paste";
      entities: PlacedEntity[];
      wires: WireLink[];
      anchor: { x: number; y: number };
      groupRotation: 0 | 4 | 8 | 12;
      /** A held blueprint's snap-to-grid (see snapPasteAnchor). `entities`
       *  are then in the blueprint's own frame: the grid cell spans
       *  [0, size.x) × [0, size.y). */
      snap?: PasteSnap;
    };

export interface PasteSnap {
  size: { x: number; y: number };
  /** Cells line up with the world grid, shifted by `offset`. Otherwise
   *  relative: the first stamp goes anywhere and later ones line up with it. */
  absolute: boolean;
  offset: { x: number; y: number };
}

export interface BlueprintRenderer {
  canvas: HTMLCanvasElement;
  camera: Camera;
  loadBlueprint(entities: PlacedEntity[], wires?: WireLink[]): void;
  /** Rebuilds the spatial/position indices for a mutated entity list WITHOUT
   *  reframing the camera — what every edit (place/remove/rotate/configure)
   *  calls, so the view never jumps mid-edit. loadBlueprint additionally
   *  reframes; use that only for first load / switching blueprints. */
  updateEntities(entities: PlacedEntity[], wires?: WireLink[]): void;
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
  /** Which badges alt mode draws (all of them by default). */
  setAltModeLayers(layers: AltModeLayers): void;
  /** Changes the render quality while running (resolution, animation,
   *  shadows, frame cap). */
  setQuality(quality: RenderQuality): void;
  getQuality(): RenderQuality;
  /** Quarter-turns the ghost's facing while in 'place' mode (no-op
   *  otherwise) — what the 'r'/Shift+R keyboard shortcut calls, mirroring
   *  Factorio's own "rotate what you're holding" convention. Uses the
   *  8-way scheme (step 2 of a full turn of 8), matching every other
   *  direction value this renderer produces for freshly-placed entities.
   *  `reverse` turns counter-clockwise (Shift+R) instead of the default
   *  clockwise (R). */
  rotateGhost(reverse?: boolean): void;
  /** Rotates the armed paste ghost as a whole — both each entity's position
   *  (orbiting the group's center, `mode.anchor`) and its own facing — by
   *  one 90° step. `reverse` turns counter-clockwise. A no-op while not in
   *  'paste' mode; unlike a single pole's own in-place rotate (rotateGhost,
   *  which refuses), a pole inside a GROUP still orbits with everything
   *  else when the group rotates — only its own facing has no visual
   *  effect, which is harmless. Free rotation has no per-entity
   *  restrictions (flip, separately, is meant to). */
  rotatePasteGhost(reverse?: boolean): void;
  hitTest(clientX: number, clientY: number): number | undefined;
  /** Fires on pointermove while not panning, with the entity under the
   *  cursor (or undefined). */
  onHover(callback: (entityNumber: number | undefined, e: PointerEvent) => void): void;
  /** Fires on a left-click in 'place' mode, with the (already
   *  grid-snapped-by-caller — see index.ts) world position and the ghost's
   *  current facing (see rotateGhost) at the moment of the click. */
  onPlace(callback: (worldX: number, worldY: number, direction: number) => void): void;
  /** Fires when the rail planner lays track: the pieces in order from the
   *  start (some may already exist — the app keeps those as they are) and
   *  the supports that carry any elevated part. */
  onPlaceRails(callback: (pieces: RailPiece[], supports: RailPiece[]) => void): void;
  /** Drops the rail planner's start point, if one is set. True when there
   *  was one, so Escape can cancel the plan before it puts the item away. */
  cancelRailPlan(): boolean;
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
  /** Fires on Alt+right-click over an entity, INSTEAD of onErase — an
   *  alt-modified right-click is a distinct gesture, not a removal, so the
   *  renderer reports it separately and leaves what it means to the app
   *  (today: stamping a held module across every slot of that machine). No
   *  erase-drag starts, so the modifier can't accidentally mine a row of
   *  buildings. */
  onAltRightClickEntity(callback: (entityNumber: number) => void): void;
  /** Fires for each left-click on an entity while a wire is on the cursor
   *  (InteractionMode's 'wire' kind), INSTEAD of onSelect — the app pairs
   *  two of these into one connect/disconnect. Clicks that hit no entity
   *  never fire it, and never cancel anything (see onPointerDown). */
  onWireClick(callback: (entityNumber: number, world: { x: number; y: number }) => void): void;
  /** Arms (or disarms, with null) the entity an in-progress wire trails
   *  from, so the renderer can draw the dangling end to the cursor while a
   *  two-click connect is half-finished. The app owns the pick itself; this
   *  only tells the renderer what to draw. */
  setPendingWire(entityNumber: number | null, side?: 1 | 2): void;
  /** Fires when a box drawn in 'deleteBox' mode completes (drag-release or
   *  a plain click) and hits at least one entity — the app deletes them
   *  immediately. Mode stays 'deleteBox' afterward; the renderer does not
   *  change it. */
  onDeleteBox(callback: (entityNumbers: ReadonlySet<number>) => void): void;
  /** Fires when a box drawn in 'cutBox' mode completes and hits at least
   *  one entity — the app is expected to both copy (clipboard) and delete
   *  the entities, then arm 'paste' with them (via setInteractionMode),
   *  mirroring onCopyBox. The renderer does not change mode on its own. */
  onCutBox(callback: (entityNumbers: ReadonlySet<number>) => void): void;
  /** Fires when a box drawn in 'copyBox' mode completes and hits at least
   *  one entity — the app is expected to copy (clipboard) and arm 'paste'
   *  with them (via setInteractionMode). The renderer does not change mode
   *  on its own. */
  onCopyBox(callback: (entityNumbers: ReadonlySet<number>) => void): void;
  /** Fires on a left-click while a copied/cut selection is on the cursor
   *  ('paste' mode) — the app resolves collisions (via `collisionMode`,
   *  read from the click's modifier keys: plain = block the whole stamp on
   *  any collision, Shift = place only the non-colliding entities, Shift+Alt
   *  = place everything, replacing whatever it overlaps) and adds the
   *  placed entities to the blueprint. The ghost stays armed afterward for
   *  another stamp — the app does not need to re-arm it. `newAnchor` is the
   *  snapped world position the group's bounding-box CENTER should land at;
   *  `origAnchor` is the same point in the original copied positions.
   *  `groupRotation` is the ghost's current R/Shift+R rotation (0/4/8/12) —
   *  the app must apply it (e.g. via rotateAroundCenter from entityLookup)
   *  BEFORE offsetting, so `entity.(x|y) - origAnchor.(x|y) + newAnchor.(x|y)`
   *  is only correct once each entity has already been rotated around
   *  `origAnchor` by `groupRotation`. */
  onPaste(
    callback: (
      entities: PlacedEntity[],
      wires: WireLink[],
      newAnchor: { x: number; y: number },
      origAnchor: { x: number; y: number },
      groupRotation: 0 | 4 | 8 | 12,
      collisionMode: "block" | "skip" | "replace",
    ) => void,
  ): void;
  /** Fires whenever the shared sprite atlas's pending-load count changes —
   *  `loading` is true while at least one sheet is still fetching/decoding
   *  (a pan/zoom bringing new entities into view, or the initial burst on
   *  loading a blueprint). Drives a small, non-blocking "still loading
   *  sprites" badge rather than a full-screen spinner — the canvas keeps
   *  drawing outline fallbacks for not-yet-loaded entities the whole time,
   *  nothing is actually blocked. */
  onLoadingChange(callback: (loading: boolean) => void): void;
  /** Snapshot of live performance/scene numbers — for the app's own debug
   *  panel (not shown by default), not read anywhere in the renderer
   *  itself. fps/frameTimeMs/renderTimeMs average the last 30 frames;
   *  everything else is read fresh at call time. */
  getDebugStats(): {
    fps: number;
    frameTimeMs: number;
    renderTimeMs: number;
    totalEntities: number;
    visibleEntities: number;
    drawCommands: number;
    /** Chrome-only (performance.memory); undefined everywhere else,
     *  including Safari/Firefox, which don't expose it at all. */
    jsHeapUsedMb: number | undefined;
    /** Where the last frame's time actually went, in milliseconds. These are
     *  the phases of draw(); they sum to a little under renderTimeMs (the
     *  remainder is bookkeeping between them). */
    phases: FramePhases;
    /** How the last frame was served. A frame that rebuilt the scene did the
     *  full classify-and-sort; a reused one only patched animation. Watching
     *  this while panning is how you tell whether the cache is helping. */
    sceneRebuilt: boolean;
    /** Rebuilds since the blueprint was loaded, and frames drawn — their ratio
     *  is the cache's hit rate. */
    sceneRebuildCount: number;
    framesDrawn: number;
    /** Frames the loop skipped entirely because nothing had changed. */
    framesSkipped: number;
    /** Whether the last frame blitted baked static layers instead of
     *  repainting the whole scene, how many layers the current scene splits
     *  into, and how many times layers have been (re)baked in total. */
    baked: boolean;
    bakedLayers: number;
    bakeCount: number;
  };
  /** Starts recording one entry per drawn frame, for at most `seconds`.
   *  Recording is off by default and costs nothing when off: a profiling tool
   *  that is always on distorts what it measures, and this one is meant to be
   *  aimed at a specific stutter. Returns immediately; poll isRecording(). */
  startFrameRecording(seconds?: number): void;
  stopFrameRecording(): void;
  isRecording(): boolean;
  /** The recorded frames, oldest first. Empty until a recording has run. */
  getFrameLog(): readonly FrameRecord[];
  /** Per-entity-name cost from the last full scene rebuild: how many of each
   *  were visible, how many draw commands they produced, and how long their
   *  classification took. Answers "which machine is expensive here".
   *  Empty until a rebuild happens while accounting is enabled. */
  getEntityCostBreakdown(): EntityCost[];
  /** Per-entity accounting makes a scene rebuild measurably slower, so it is
   *  opt-in and off by default. */
  setEntityAccounting(enabled: boolean): void;
  /** The renderer's own resolved-visual table, so the app layer can answer
   *  "how big is this entity, what does it look like" without building a
   *  second copy from the same inputs — which then had to be rebuilt in
   *  lockstep whenever the dataset was swapped. */
  getVisualLookup(): ReadonlyMap<string, ResolvedVisual>;
  destroy(): void;
}

const FALLBACK_FOOTPRINT: [number, number] = [1, 1];

/** Upper bound on how far the scene cache probes for an animation's cycle
 *  length. Vanilla's longest belt cycle is well under this; anything that
 *  does not repeat within it is treated as non-animating and left static. */
const MAX_ANIM_PERIOD = 256;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Placement-ghost valid/invalid tint — matches the real game's own
 *  green-means-go, red-means-blocked cursor-item convention. */
const GHOST_VALID_TINT = "#4caf50";
const GHOST_INVALID_TINT = "#e53935";


/** Mounts a self-contained Canvas2D blueprint renderer into `container`,
 *  wiring up Factorio-feel pan/zoom (see camera.ts) and hover hit-testing
 *  (spatialIndex.ts) without any external rendering library. */
/** How much work the renderer may spend per frame. A phone gets a cheaper
 *  set than a desktop; the app picks one (see the site's render presets)
 *  and can change it while running. */
export interface RenderQuality {
  /** Upper bound on the canvas's pixels per CSS pixel. A 3× phone screen
   *  drawn at 1× paints a ninth of the pixels. */
  maxPixelRatio: number;
  /** Belts and other animated sprites move. Off, they hold still and a
   *  static view is never redrawn. */
  animation: boolean;
  /** Ground shadows under buildings. */
  shadows: boolean;
  /** Most frames drawn per second, while something is moving. */
  maxFps: number;
}

export const FULL_QUALITY: RenderQuality = { maxPixelRatio: Infinity, animation: true, shadows: true, maxFps: 60 };

export function mountRenderer(container: HTMLElement, data: GameData, catalog: RenderCatalog, initialQuality: RenderQuality = FULL_QUALITY): BlueprintRenderer {
  let quality: RenderQuality = { ...initialQuality };
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.cursor = "default";
  // Stops the browser's own native pan/pinch-zoom/double-tap-zoom gestures
  // from firing alongside (and fighting) the pointer-event-driven pan/pinch
  // handling below — without this, touch input on mobile double-zooms (once
  // from the browser's own viewport zoom, once from our camera) or scrolls
  // the page instead of panning the canvas.
  canvas.style.touchAction = "none";
  // Stops the browser's own drag-select and drag-image from fighting the
  // pointer-capture pan.
  canvas.style.userSelect = "none";
  (canvas.style as CSSStyleDeclaration & { webkitUserDrag?: string }).webkitUserDrag = "none";
  canvas.draggable = false;
  container.replaceChildren(canvas);

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // crisp pixel art, matching the game's own look at high zoom

  const atlas = getSharedSpriteAtlas();
  const iconAtlas = getSharedIconAtlas();
  const visualLookup = buildVisualLookup(data, catalog);
  const camera = new Camera({ x: 0, y: 0, pixelsPerTile: 32 });

  const connectors = makeConnectorPredicates(visualLookup);

  // Debug-panel stats (getDebugStats) — a rolling 30-frame window for fps/
  // render time, everything else read fresh at query time. Cheap enough
  // (a handful of numbers, no allocation in the hot path beyond the fixed-
  // size ring buffers below) to always maintain rather than gate behind
  // the panel being open, so the panel shows real history from the moment
  // it's opened rather than starting from zero.
  const FRAME_HISTORY = 30;
  const frameTimes: number[] = [];
  const renderTimes: number[] = [];
  let lastTickAt = 0;
  let lastDrawCommandCount = 0;
  let lastVisibleEntityCount = 0;

  let entities: PlacedEntity[] = [];
  let entityById = new Map<number, PlacedEntity>();
  let wires: WireLink[] = [];
  let wireNetwork: WireNetwork = buildWireNetwork([], [], isPoleLike);
  let resolvedWires: ResolvedWire[] = [];
  /** The entity whose terminal an in-progress wire trails from, while the
   *  user is part-way through a two-click connect. Null whenever no pick is
   *  armed. The app owns the pick itself; this is only what the renderer
   *  needs to draw the dangling end. */
  let pendingWireFrom: number | null = null;
  let pendingWireSide: 1 | 2 = 1;
  let grid = new NeighbourGrid();
  let fluidNetwork = new FluidNetwork();
  let heatNetwork = new HeatNetwork();
  let spatialIndex = new SpatialIndex([]);
  let platformBoxes: PlatformBox[] = [];
  let highlight: HighlightRole | null = null;
  /** The entity under the cursor right now, tracked independently of
   *  hoverCallback (an app-level subscriber, which may not even be set) so
   *  the hover-highlight overlay always has something to draw from. */
  let hoveredEntityNumber: number | undefined;
  /** Which half of the hovered entity the cursor is over — only ever 2 on
   *  the output half of a combinator. A held wire attaches to this half, so
   *  wire mode highlights just it. */
  let hoveredSide: 1 | 2 = 1;
  let altMode = false;
  let altModeLayers: AltModeLayers = ALL_ALT_MODE_LAYERS;
  let animationFrame = 0;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
  let dpr = pixelRatio();
  let rafHandle = 0;
  /** When the last frame was drawn, for the maxFps cap. */
  let lastDrawAt = 0;
  /** Set whenever something that affects the picture changes; cleared once
   *  the frame is drawn. Without it draw() ran unconditionally 60 times a
   *  second — a full spatial query, classification and sort pass — even on a
   *  completely static view where every frame was identical to the last. */
  let needsRedraw = true;
  /** How many entities in the last drawn frame pick a sprite by the animation
   *  clock. Zero means advancing that clock cannot change anything on screen,
   *  so the loop leaves it alone and stops redrawing entirely. */
  let animatedVisibleCount = 0;

  /* ---------- profiling (see startFrameRecording / getDebugStats) ---------- */

  const emptyPhases = (): FramePhases => ({
    grid: 0, cull: 0, collect: 0, animate: 0, paint: 0, inserters: 0, overlays: 0, ghost: 0,
  });
  let phases: FramePhases = emptyPhases();
  let sceneRebuiltThisFrame = false;
  let rebuildReasonThisFrame: RebuildReason = "none";
  /** Filled by the paint pass while a recording runs; null otherwise so an
   *  unrecorded frame pays nothing for the accounting. */
  let paintTally: PaintTally | null = null;
  /** framesSkipped as of the previous recorded frame, so each record can
   *  report how many frames the loop skipped in between. */
  let skippedAtLastRecord = 0;
  let sceneRebuildCount = 0;
  let framesDrawn = 0;
  let framesSkipped = 0;

  /** Fixed-capacity ring so a forgotten recording cannot grow without bound:
   *  30 s at 60 fps is 1800 frames, and the cap is generous over that. */
  const FRAME_LOG_CAPACITY = 4000;
  let frameLog: FrameRecord[] = [];
  let recording = false;
  let recordingStartedAt = 0;
  let recordingStopsAt = 0;

  /** Per-entity-name accounting, opt-in: timing every entity separately makes
   *  a rebuild noticeably slower, which would distort the very thing the
   *  panel is measuring. */
  let entityAccounting = false;
  let entityCosts: EntityCost[] = [];

  /** The three neighbour networks the placement ghost previews against.
   *  Rebuilding them means walking every entity in the blueprint, and they
   *  were rebuilt on every single frame while something was in hand — even
   *  with the pointer completely still. They only actually change when the
   *  ghost lands on a different cell, turns, becomes a different entity, or
   *  the blueprint itself is edited, so they are cached against exactly that.
   *  entitiesVersion is bumped by rebuildIndices. */
  /** The collected, sorted scene commands, reused across frames.
   *
   *  Everything that decides this list — which entities are visible, how they
   *  classify, their sort order — is unchanged from frame to frame while the
   *  camera and blueprint sit still. The only field that moves is `sx`, the
   *  belt animation's column offset, so the list is built once and those
   *  entries are patched in place instead of reclassifying and re-sorting the
   *  whole scene 60 times a second.
   *
   *  Each animated command carries its OWN period: a blueprint mixing belt
   *  tiers has several (turbo/express/fast run at different rates via the
   *  layer's `slowdown`), and patching them all on one shared cycle would
   *  visibly desynchronise the slower tiers. base/stride/period are measured
   *  per command when the cache is built, from the classifier itself, so no
   *  assumption about the animation scheme is baked in here. */
  interface SceneCache {
    key: string;
    commands: DrawCommand[];
    /** Indices into `commands` of the entries whose sx moves. */
    animated: number[];
    /** The sx of column 0, the width of one column, how many frames before
     *  the cycle repeats, the starting column at animationFrame 0, and how
     *  many columns the row holds — parallel to `animated`. sx wraps within
     *  the row rather than ramping linearly, so a sprite whose phase starts
     *  partway through its sheet (a turbo belt's odd-parity tile) still
     *  animates instead of being rejected as non-linear. */
    animOrigin: number[];
    animStride: number[];
    animPeriod: number[];
    animPhase0: number[];
    animColumns: number[];
    /** How many columns the command walks through over one period — a
     *  multiple of animColumns when a fast belt skips cells (a red belt steps
     *  two columns a tick, a blue one three). */
    animSteps: number[];
    /** How to split `commands` into baked and live layers — worked out the
     *  first time this scene is baked. */
    bakePlan?: BakePlan;
  }
  let sceneCache: SceneCache | null = null;

  let ghostPreviewKey: string | null = null;
  let ghostPreviewGrid: NeighbourGrid | null = null;
  let ghostPreviewFluid: FluidNetwork | null = null;
  let ghostPreviewHeat: HeatNetwork | null = null;
  let ghostUnderground: { undergroundType: "input" | "output"; direction: number } | undefined;
  let entitiesVersion = 0;
  let highlightVersion = 0;

  /** Dimming factor for an entity while a highlight is active. Lives out here
   *  rather than inside draw() because buildSceneCache bakes it into each
   *  command's alpha, and highlightVersion is what tells the cache to rebuild
   *  when the highlight changes. */
  function alphaFor(entity: PlacedEntity): number {
    if (highlight === null) return 1;
    const lit =
      highlight.producers.has(entity.entityNumber) ||
      highlight.consumers.has(entity.entityNumber) ||
      (highlight.beacons?.has(entity.entityNumber) ?? false);
    return lit ? 1 : 0.28;
  }

  /** The facing to actually DRAW an entity at.
   *
   *  For everything except a pole this is the blueprint's own direction. A
   *  pole has no meaningful stored direction — the game derives its facing
   *  from the wires hanging off it, so that a run of poles visibly leans
   *  along the line it carries — so its wire-derived facing wins whenever it
   *  has one. An unwired pole falls back to its stored direction, which is
   *  north for anything the game itself produced. */
  function directionOf(entity: PlacedEntity): number {
    const fromWires = wireNetwork.poleDirection.get(entity.entityNumber);
    return fromWires ?? entity.direction;
  }

  /** True while the thing in hand is a pole, which is when the game shows
   *  every pole's supply area — the ghost's own and every placed one's — so
   *  coverage gaps and overlap are visible while laying out a run. */
  function supplyAreasVisible(): boolean {
    return mode.kind === "place" && visualFor(mode.entityName)?.supplyAreaDistance !== undefined;
  }

  function invalidate(): void {
    needsRedraw = true;
  }

  /** True for the three box-drag action modes (copyBox/cutBox/deleteBox) —
   *  they share the same drag-tracking/marquee/pointer-handling shape and
   *  differ only in what onPointerUp does with the resulting entity set. */
  function isBoxMode(kind: InteractionMode["kind"]): boolean {
    return kind === "copyBox" || kind === "cutBox" || kind === "deleteBox";
  }

  // The camera announces its own pans/zooms rather than every gesture handler
  // remembering to invalidate (see Camera.onChange).
  camera.onChange(invalidate);
  let isPanning = false;
  let lastPointer = { x: 0, y: 0 };
  let destroyed = false;

  // 'idle'-mode press-on-an-entity: the real game lets you drag the camera
  // starting from on top of a building just as freely as from empty ground —
  // only a press that never moves opens that building. downPointerId tracks
  // which pointer started the current idle-mode press/pan gesture (so a
  // second, unrelated pointer's move/up can't affect it); pendingSelect
  // holds the entity that was under the cursor at press time, fired from
  // onPointerUp only if the gesture stayed within CLICK_MOVE_THRESHOLD the
  // whole time — otherwise it was a pan, and no entity opens.
  let downPointerId: number | undefined;
  let pendingSelect: number | undefined;
  let pressMovedPastThreshold = false;
  let downScreenPos = { x: 0, y: 0 };
  const CLICK_MOVE_THRESHOLD = 5; // screen px, matches typical OS drag-start thresholds

  // WASD keyboard pan: held keys accumulate here and are applied once per
  // frame in tick() (not on keydown itself), so holding a key pans smoothly
  // and continuously like the real game's own camera keys rather than
  // stepping once per keystroke/repeat event.
  const heldKeys = new Set<string>();
  // Screen px/second, fed through the same panByScreenDelta a mouse drag
  // uses — since that divides by pixelsPerTile, a fixed screen-px rate here
  // covers a fixed fraction of the current view per second at any zoom,
  // rather than crawling across a zoomed-out map or overshooting a
  // zoomed-in one.
  const KEYBOARD_PAN_SPEED = 900;

  // Two-finger touch: pinch to zoom, drag the midpoint to pan. Tracks every
  // currently-down touch pointer by id so the second finger landing can be
  // detected regardless of arrival order, and the gesture cleanly falls back
  // to a single-finger pan if one finger lifts while the other stays down.
  // The distance/midpoint tracked here are the PREVIOUS move's, not the
  // gesture-start values — each move zooms by the incremental ratio since
  // last frame (mirroring onWheel's own per-tick factor), so it can reuse
  // zoomAt's existing clamping and cursor-anchoring instead of duplicating
  // either.
  const activeTouches = new Map<number, { x: number; y: number }>();
  let lastPinchDistance = 0;
  let mode: InteractionMode = { kind: "idle" };
  let ghostWorldPos: { x: number; y: number } | null = null;
  /** Where relative snap-to-grid's grid starts: the first stamp's cell
   *  corner. Cleared whenever a different thing is put in hand. */
  let relativeSnapOrigin: { x: number; y: number } | null = null;

  /** The held blueprint's grid cell, as its top-left corner relative to the
   *  ghost's anchor plus its size — both after the ghost's rotation. */
  function pasteCell(): { offset: { x: number; y: number }; size: { x: number; y: number } } | null {
    if (mode.kind !== "paste" || !mode.snap) return null;
    const { size } = mode.snap;
    const { anchor } = mode;
    const steps = mode.groupRotation / 4;
    const corners = [
      { x: 0, y: 0 },
      { x: size.x, y: 0 },
      { x: 0, y: size.y },
      { x: size.x, y: size.y },
    ].map((c) => {
      // Same quarter-turn as rotateAroundCenter, applied to the cell corners.
      let rx = c.x - anchor.x;
      let ry = c.y - anchor.y;
      for (let i = 0; i < steps; i++) [rx, ry] = [-ry, rx];
      return { x: rx, y: ry };
    });
    return {
      offset: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) },
      size: steps % 2 === 1 ? { x: size.y, y: size.x } : { ...size },
    };
  }

  function pasteCellOffset(): { x: number; y: number } {
    return pasteCell()?.offset ?? { x: 0, y: 0 };
  }

  /** Where the paste ghost's anchor lands for a cursor at `cursor`: on a
   *  whole tile, or — for a blueprint with snap-to-grid — wherever puts its
   *  grid cell on the nearest grid position (the world grid, shifted by the
   *  blueprint's offset, when absolute; the first stamp's grid when
   *  relative). */
  function snapPasteAnchor(cursor: { x: number; y: number }): { x: number; y: number } {
    const cell = pasteCell();
    if (!cell || mode.kind !== "paste" || !mode.snap) return { x: Math.round(cursor.x), y: Math.round(cursor.y) };
    const { offset, size } = cell;
    const origin = mode.snap.absolute ? mode.snap.offset : relativeSnapOrigin;
    // The cell's top-left if the ghost were centred on the cursor.
    const cand = { x: cursor.x + offset.x, y: cursor.y + offset.y };
    const snapped = origin
      ? {
          x: origin.x + Math.round((cand.x - origin.x) / size.x) * size.x,
          y: origin.y + Math.round((cand.y - origin.y) / size.y) * size.y,
        }
      : { x: Math.round(cand.x), y: Math.round(cand.y) };
    return { x: snapped.x - offset.x, y: snapped.y - offset.y };
  }
  let ghostDirection = 0;

  // Rail planner state. railAnchor is where the next track starts — set by
  // pressing on a free rail end (or anywhere, which lays the held straight
  // piece first), then moved to the end of each placement so track can be
  // laid on in stages, like the game's own rail item.
  let railAnchor: RailEnd | null = null;
  let railIndex: RailIndex | null = null;
  let railIndexVersion = -1;
  let railPreviewKey = "";
  let railPreviewCache: RailPreview | null = null;
  let railDragMoved = false;
  // The current press started on open ground: a plain click there lays just
  // the held piece and leaves no plan behind; only a drag plans on from it.
  let railPressOnGround = false;
  // The current press began with a plan already set: its release lays it.
  let railPressAnchored = false;
  // The held piece a press on open ground starts from, laid on release.
  let railPendingPiece: RailPiece | null = null;
  // Shift plans all the way to the cursor, past the rail item's length limit.
  let shiftHeld = false;

  function currentRailIndex(): RailIndex {
    if (!railIndex || railIndexVersion !== entitiesVersion) {
      railIndex = buildRailIndex(entities, (e) => {
        const visual = visualFor(e.name);
        return visual ? effectiveFootprint(visual, e.direction) : FALLBACK_FOOTPRINT;
      });
      railIndexVersion = entitiesVersion;
    }
    return railIndex;
  }

  /** The track the planner would lay from the anchor to the cursor. */
  function currentRailPreview(): RailPreview | null {
    if (mode.kind !== "place" || !railAnchor || !ghostWorldPos) return null;
    const target = { x: Math.round(ghostWorldPos.x), y: Math.round(ghostWorldPos.y) };
    const elevated = plannerTargetsElevated(mode.entityName);
    const key = `${entitiesVersion}|${railAnchor.x},${railAnchor.y},${railAnchor.dir},${railAnchor.elevated}|${target.x},${target.y}|${elevated}|${shiftHeld}`;
    if (key !== railPreviewKey) {
      railPreviewKey = key;
      railPreviewCache = previewRail(currentRailIndex(), railAnchor, target, elevated, shiftHeld);
    }
    return railPreviewCache;
  }

  /** Lays the previewed track and moves the anchor to where it ends. */
  function commitRailPreview(): void {
    const preview = currentRailPreview();
    if (!preview || preview.pieces.length === 0) return;
    railPlaceCallback?.(preview.pieces, preview.supports);
    railAnchor = preview.end;
    invalidate();
  }

  function railPress(): void {
    if (mode.kind !== "place" || !ghostWorldPos) return;
    railDragMoved = false;
    railPressOnGround = false;
    // With a plan already going, the press only starts the gesture: the
    // release lays the preview where the cursor ends up, so a drag never
    // lays the old preview first and then a second one.
    if (railAnchor) {
      railPressAnchored = true;
      return;
    }
    railPressAnchored = false;
    const start = railStartAt(currentRailIndex(), ghostWorldPos.x, ghostWorldPos.y);
    if (start) {
      railAnchor = start.end;
    } else {
      // Nothing to continue: the held straight piece is the start. It's laid
      // on release, not now, so a cancelled press leaves nothing behind; a
      // drag plans on from its end facing the held direction, a click lays
      // just the piece.
      const elevated = plannerTargetsElevated(mode.entityName) && mode.entityName !== "rail-ramp";
      const { piece, end } = startPiece(ghostWorldPos.x, ghostWorldPos.y, ghostDirection, elevated);
      railPendingPiece = piece;
      railAnchor = end;
      railPressOnGround = true;
    }
    invalidate();
  }

  // Shared drag-box state for the three box-drag action modes (copyBox/
  // cutBox/deleteBox). The box is tracked in world space (converted once per
  // pointer event via worldAtPointer) rather than screen space, since world
  // coordinates are what both the draw loop and spatialIndex.queryRect need
  // — screen space would mean re-deriving world coords a second time just to
  // query/draw. boxDownScreenPos is the one exception: the click-vs-drag
  // threshold itself is inherently a screen-space distance
  // (CLICK_MOVE_THRESHOLD, shared with idle-mode's own click/drag check).
  let boxDownPointerId: number | undefined;
  let boxDownWorldPos: { x: number; y: number } | undefined;
  let boxDownScreenPos: { x: number; y: number } | undefined;
  let boxDragCurrentWorldPos: { x: number; y: number } | undefined;
  let boxDragMoved = false;

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
    dpr = pixelRatio();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // Setting canvas.width/height also clears the canvas, so the frame must
    // be redrawn whatever else is going on.
    invalidate();
  }

  function visualFor(name: string): ResolvedVisual | undefined {
    return visualLookup.get(name);
  }

  function footprintOfEntity(e: PlacedEntity): [number, number] {
    const visual = visualFor(e.name);
    return visual ? effectiveFootprint(visual, e.direction) : FALLBACK_FOOTPRINT;
  }

  /** Entities a box-drag selection touches: the spatial index's footprint
   *  boxes narrowed to what each entity really covers, so dragging beside a
   *  curve doesn't pick it up. */
  function entitiesInBox(left: number, top: number, right: number, bottom: number): Set<number> {
    const box = { left, top, right, bottom };
    const out = new Set<number>();
    for (const id of spatialIndex.queryRect(left, top, right, bottom)) {
      const e = entityById.get(id);
      if (e && boxHitsEntity(box, e, footprintOfEntity)) out.add(id);
    }
    return out;
  }

  /** Which terminal of entity `entityNumber` a held wire would attach to
   *  at a world point — the same question the app's wire click asks, so the
   *  half that is highlighted is the half that gets wired. */
  function sideAt(entityNumber: number, world: { x: number; y: number }): 1 | 2 {
    const entity = entityById.get(entityNumber);
    if (!entity || mode.kind !== "wire" || mode.color === "copper") return 1;
    return terminalSideAt(entity, visualFor(entity.name), entity.direction, mode.color, world);
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
    phases = emptyPhases();
    sceneRebuiltThisFrame = false;
    rebuildReasonThisFrame = "none";
    paintTally = recording
      ? { drawn: 0, skipped: 0, sheets: 0, area: 0, compositeSwitches: 0 }
      : null;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    // The background and grid are painted further down, once it is known
    // whether they go straight onto the canvas or into the bottom bake.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    applyWorldTransform(ctx);

    const tCull = performance.now();

    // Only entities overlapping the viewport are drawn; the padding covers
    // sprites that overhang their own footprint.
    const viewTopLeft = camera.screenToWorld(0, 0, w, h);
    const viewBottomRight = camera.screenToWorld(w, h, w, h);
    const CULL_PADDING = 4;
    const visibleIds = spatialIndex.queryRect(
      viewTopLeft.x - CULL_PADDING,
      viewTopLeft.y - CULL_PADDING,
      viewBottomRight.x + CULL_PADDING,
      viewBottomRight.y + CULL_PADDING,
    );
    const visibleEntities: PlacedEntity[] = [];
    for (const id of visibleIds) {
      const e = entityById.get(id);
      if (e) visibleEntities.push(e);
    }
    lastVisibleEntityCount = visibleEntities.length;
    phases.cull = performance.now() - tCull;

    const hasHighlight = highlight !== null;

    // A belt-family ghost needs to know about its own real neighbours to
    // classify itself correctly (curve into an existing run, no spurious
    // cap where it would connect) — previewGrid adds the ghost on top of
    // the placed-only grid for exactly that. It's used ONLY for the ghost's
    // own draw call below, deliberately not for the main collection pass
    // just below this: an already-placed belt must keep looking exactly as
    // placed, however the ghost hovering nearby would connect to it, right
    // up until it's actually placed — only the ghost previews the
    // hypothetical connected result.
    const tGhost = performance.now();
    let ghost: PlacedEntity | undefined;
    let ghostCanPlace = true;
    let previewGrid = grid;
    let previewFluidNetwork = fluidNetwork;
    let previewHeatNetwork = heatNetwork;
    // Rail planner preview: the whole planned track, green, laid in full on
    // the next press or release.
    const railGhosts: { entity: PlacedEntity; tint: string }[] = [];
    let railArrow: { x: number; y: number; dir: number } | null = null;
    let railBlocked: { x: number; y: number } | null = null;
    if (mode.kind === "place" && ghostWorldPos && isRailPlannerItem(mode.entityName)) {
      const preview = currentRailPreview();
      const index = currentRailIndex();
      const asGhost = (p: RailPiece): PlacedEntity => ({ entityNumber: -1, name: p.name, x: p.x, y: p.y, direction: p.direction, quality: "normal", modules: [], filterItems: [] });
      if (railPendingPiece) railGhosts.push({ entity: asGhost(railPendingPiece), tint: GHOST_VALID_TINT });
      if (preview) {
        // No track can get any closer to the cursor: a red X says so.
        if (preview.pieces.length === 0) railBlocked = { x: ghostWorldPos.x, y: ghostWorldPos.y };
        for (const p of preview.pieces) railGhosts.push({ entity: asGhost(p), tint: GHOST_VALID_TINT });
        for (const sp of preview.supports) railGhosts.push({ entity: asGhost(sp), tint: GHOST_VALID_TINT });
      } else {
        // No plan yet: on a placed rail an arrow shows where a press would
        // start building — toward the end on the cursor's half of it; over
        // open ground just the held straight piece, which R turns 8 ways.
        const start = railStartAt(index, ghostWorldPos.x, ghostWorldPos.y);
        if (start) {
          railArrow = { x: start.piece.x, y: start.piece.y, dir: start.end.dir };
        } else {
          const elevated = plannerTargetsElevated(mode.entityName) && mode.entityName !== "rail-ramp";
          const { piece } = startPiece(ghostWorldPos.x, ghostWorldPos.y, ghostDirection, elevated);
          railGhosts.push({ entity: asGhost(piece), tint: GHOST_VALID_TINT });
        }
      }
    } else if (mode.kind === "place" && ghostWorldPos) {
      const ghostVisual = visualFor(mode.entityName);
      if (ghostVisual) {
        const [gfw, gfh] = effectiveFootprint(ghostVisual, ghostDirection);
        // Signals and train stops snap onto the slots beside placed track
        // and take the slot's facing.
        const slot = isRailSnapped(mode.entityName)
          ? railsideSlot(currentRailIndex(), mode.entityName, ghostWorldPos.x, ghostWorldPos.y, ghostDirection)
          : undefined;
        const snapped = slot ? { x: slot.x, y: slot.y } : { x: snapAxis(ghostWorldPos.x, gfw), y: snapAxis(ghostWorldPos.y, gfh) };
        const previewKey = `${entitiesVersion}|${mode.entityName}|${snapped.x},${snapped.y}|${ghostDirection}`;
        const previewStale = previewKey !== ghostPreviewKey;
        if (previewStale) {
          ghostUnderground = isUndergroundLike(mode.entityName)
            ? autoUnderground(entities, mode.entityName, snapped.x, snapped.y, ghostDirection, data.undergroundBelts?.[mode.entityName]?.maxDistance ?? 0)
            : undefined;
        }
        ghost = {
          entityNumber: -1,
          name: mode.entityName,
          x: snapped.x,
          y: snapped.y,
          // A paired exit is stored with its travel direction, the
          // reverse of how it's held (see autoUnderground).
          direction: slot?.direction ?? ghostUnderground?.direction ?? ghostDirection,
          quality: mode.quality ?? "normal",
          modules: [],
          filterItems: [],
          // Every underground-belt/loader tier MUST carry a real
          // undergroundType — collect.ts's resolveFrame branches on it being
          // defined at all to pick the entrance/exit structure art over
          // plain belt row/cap art. Previews the same auto-pairing
          // placeEntity (index.ts) applies: an entrance in range behind it
          // makes this ghost its exit.
          undergroundType: ghostUnderground?.undergroundType,
        };
        if (previewStale) {
          ghostPreviewKey = previewKey;
          const withGhost = [...entities, ghost];
          ghostPreviewGrid = connectors.isBeltLike(mode.entityName) ? buildGrid(withGhost) : null;
          ghostPreviewFluid = buildFluidNetwork(withGhost, (e) => {
            const points = visualFor(e.name)?.pipeConnections;
            return points && activeFluidConnections(points, e.recipe, data);
          });
          ghostPreviewHeat = buildHeatNetwork(withGhost, (name) => visualFor(name)?.heatConnections);
        }
        if (ghostPreviewGrid) previewGrid = ghostPreviewGrid;
        // A ghost with its own fluid box needs its pipe-cover patches (and
        // a neighbouring ghost/placed pipe needs the ghost's own connection
        // points) reflected live too, the same way previewGrid does for
        // belts above — otherwise a ghost building always shows every cover
        // regardless of what it's actually being placed next to. A reactor
        // ghost likewise needs its heat-connection patches to react to a
        // neighbouring heat pipe. Both come from the cache built above.
        previewFluidNetwork = ghostPreviewFluid ?? previewFluidNetwork;
        previewHeatNetwork = ghostPreviewHeat ?? previewHeatNetwork;

        // Valid iff nothing else's footprint overlaps the ghost's own —
        // queryRect already returns entityNumbers whose box overlaps a
        // rect, which is exactly Factorio's own placement rule (no two
        // colliding footprints), so no separate collision routine is
        // needed. -1 (the ghost's own placeholder id, never in the real
        // spatial index) never appears here, so nothing to exclude.
        //
        // queryRect's own edge comparisons are inclusive (>=/<=) by design —
        // right for its original job, frustum culling, where an entity
        // exactly on the viewport boundary must still be included so it
        // doesn't pop in/out. That same inclusiveness is wrong here: two
        // footprints that only TOUCH (e.g. a ghost placed directly beside an
        // existing belt, sharing one edge with no actual overlap) would
        // register as colliding and wrongly tint the ghost red. Insetting
        // the query rect by a small epsilon excludes exact-edge touches
        // while still catching any real overlap.
        const epsilon = 0.01;
        const left = snapped.x - gfw / 2 + epsilon;
        const top = snapped.y - gfh / 2 + epsilon;
        const right = snapped.x + gfw / 2 - epsilon;
        const bottom = snapped.y + gfh / 2 - epsilon;
        const overlapping = spatialIndex.queryRect(left, top, right, bottom);
        // The spatial index is only the broad phase: track blocks just the
        // tiles it runs over, not its whole square footprint.
        const blockers = [...overlapping].filter((id) => {
          const other = entityById.get(id);
          return other !== undefined && entitiesCollide(ghost!, other, footprintOfEntity);
        });
        // A ghost exactly on top of a same-named entity at its own tile is
        // still a valid placement — it rebuilds that entity in place with
        // the ghost's own facing/quality (see index.ts's placeEntity), the
        // same "build over it to reconfigure" move the real game allows.
        // Only that one specific overlap is forgiven: two or more
        // overlapping entities, or one of a different name, still blocks —
        // there's no single existing entity a click there could sensibly
        // rebuild.
        ghostCanPlace = isRailSnapped(mode.entityName)
          ? railsideOk(slot, overlapping)
          : blockers.length === 0 ||
          (blockers.length === 1 &&
            (() => {
              const only = entityById.get(blockers[0]!);
              return only?.name === mode.entityName && only.x === snapped.x && only.y === snapped.y;
            })());
      }
    }

    // Multi-entity paste ghost ('paste' mode — a copied/cut selection on the
    // cursor). Kept as its own block rather than folding into the
    // single-entity ghost above: the two differ in shape (one validity flag
    // vs. an array, no same-entity "rebuild in place" exception here) enough
    // that a shared abstraction would be more convoluted than the
    // duplication.
    let pasteGhosts: PlacedEntity[] = [];
    let pasteGhostValid: boolean[] = [];
    if (mode.kind === "paste" && ghostWorldPos) {
      // The group anchor (the copied selection's bounding-box CENTER) snaps
      // to a whole grid tile; each entity keeps its exact original offset
      // from the anchor, rotated by groupRotation first if the ghost has
      // been turned. A group can mix odd- and even-footprint entities, so
      // there is no single "snap parity" for the whole group the way a
      // single ghost's own footprint determines — only the anchor point
      // itself needs a rule, and a whole-tile snap is the simplest one that
      // behaves reasonably for every mix.
      const snappedAnchor = snapPasteAnchor(ghostWorldPos);
      const { entities: copiedEntities, anchor: origAnchor, groupRotation } = mode;
      const rotationSteps = groupRotation / 4;
      pasteGhosts = copiedEntities.map((e) => {
        const rotated = rotationSteps === 0 ? e : rotateAroundCenter(e, origAnchor, rotationSteps);
        return {
          ...rotated,
          x: snappedAnchor.x + (rotated.x - origAnchor.x),
          y: snappedAnchor.y + (rotated.y - origAnchor.y),
        };
      });
      const previewKey = `${entitiesVersion}|paste|${snappedAnchor.x},${snappedAnchor.y}|${groupRotation}`;
      if (previewKey !== ghostPreviewKey) {
        ghostPreviewKey = previewKey;
        const withGhosts = [...entities, ...pasteGhosts];
        ghostPreviewGrid = buildGrid(withGhosts);
        ghostPreviewFluid = buildFluidNetwork(withGhosts, (e) => {
          const points = visualFor(e.name)?.pipeConnections;
          return points && activeFluidConnections(points, e.recipe, data);
        });
        ghostPreviewHeat = buildHeatNetwork(withGhosts, (name) => visualFor(name)?.heatConnections);
      }
      if (ghostPreviewGrid) previewGrid = ghostPreviewGrid;
      previewFluidNetwork = ghostPreviewFluid ?? previewFluidNetwork;
      previewHeatNetwork = ghostPreviewHeat ?? previewHeatNetwork;

      // Per-entity validity (unlike the single ghost's one flag): each piece
      // of the group is checked against the REAL placed entities only — a
      // copied group never legitimately overlaps itself, so no
      // self-exclusion is needed the way the single ghost forgives
      // rebuilding the exact same entity in place.
      const epsilon = 0.01;
      pasteGhostValid = pasteGhosts.map((pg) => {
        const visual = visualFor(pg.name);
        if (!visual) return true;
        const [gfw, gfh] = effectiveFootprint(visual, pg.direction);
        const overlapping = spatialIndex.queryRect(
          pg.x - gfw / 2 + epsilon,
          pg.y - gfh / 2 + epsilon,
          pg.x + gfw / 2 - epsilon,
          pg.y + gfh / 2 - epsilon,
        );
        for (const id of overlapping) {
          const other = entityById.get(id);
          if (other && entitiesCollide(pg, other, footprintOfEntity)) return false;
        }
        return true;
      });
    }

    // Collect every sprite first, then paint them in one globally sorted
    // pass, so no entity's shadow can land on a neighbour drawn before it.
    // Real entities always classify against the placed-only grid, never
    // previewGrid — an already-placed belt must not change how it looks
    // just because a ghost is hovering nearby; only the ghost itself (drawn
    // separately below, against previewGrid) shows the connected preview.
    const procedural: PlacedEntity[] = [];
    // Entities with no graphics draw as a plain outline, under everything.
    const outlined: PlacedEntity[] = [];
    // Counted while walking the visible set: this is what tells tick()
    // whether the next frame could differ from this one.
    let animatedVisible = 0;
    for (const entity of visibleEntities) {
      const visual = visualFor(entity.name);
      if (!visual) continue;
      if (hasAnimatedLayer(visual)) animatedVisible++;
      if (visual.inserterGraphics) {
        procedural.push(entity);
      } else if (!visual.graphics) {
        outlined.push(entity);
      }
    }
    animatedVisibleCount = animatedVisible;

    // Which entities are visible depends on the camera; how they classify
    // depends on the blueprint (entitiesVersion) and on the highlight, which
    // feeds each command's alpha.
    //
    // The visible set is identified by its size plus its first and last id
    // rather than by joining every id into a string: that join allocated a
    // multi-kilobyte string every frame purely to compare it, which is real
    // work during exactly the pan and zoom this cache is meant to make cheap.
    // queryRect returns ids in a stable insertion order, so for a set to
    // change while keeping its size and both ends is possible but harmless —
    // the mistake it could cause is reusing a command list for a set of the
    // same size with the same outermost entities, and the sceneEpoch below
    // bounds how long any such reuse could last.
    phases.ghost = performance.now() - tGhost;

    const tCollect = performance.now();
    const firstVisible = visibleIds.size > 0 ? visibleEntities[0]?.entityNumber ?? 0 : 0;
    const lastVisible = visibleIds.size > 0 ? visibleEntities[visibleEntities.length - 1]?.entityNumber ?? 0 : 0;
    const sceneKey = `${entitiesVersion}|${highlightVersion}|${visibleIds.size}|${firstVisible}|${lastVisible}`;
    if (!sceneCache || sceneCache.key !== sceneKey) {
      // Attribute the miss before overwriting the cache. The key's three
      // parts are independent, so comparing them one at a time says which
      // one actually moved — the difference between "the user panned" and
      // "something is invalidating the cache needlessly", which a boolean
      // sceneRebuilt flag alone cannot express.
      if (!sceneCache) {
        rebuildReasonThisFrame = "first";
      } else {
        const [prevEntities, prevHighlight] = sceneCache.key.split("|");
        if (prevEntities !== String(entitiesVersion)) rebuildReasonThisFrame = "entities";
        else if (prevHighlight !== String(highlightVersion)) rebuildReasonThisFrame = "highlight";
        else rebuildReasonThisFrame = "visibility";
      }
      sceneCache = buildSceneCache(sceneKey, visibleEntities, {
        grid, fluidNetwork, heatNetwork, ...connectors, platformBoxes, animationFrame: 0,
      });
      sceneRebuiltThisFrame = true;
      sceneRebuildCount++;
    }
    phases.collect = performance.now() - tCollect;

    const tAnimate = performance.now();
    const commands = sceneCache.commands;
    for (let i = 0; i < sceneCache.animated.length; i++) {
      const command = commands[sceneCache.animated[i]!]!;
      const columns = sceneCache.animColumns[i]!;
      const advanced = Math.floor(((animationFrame % sceneCache.animPeriod[i]!) * sceneCache.animSteps[i]!) / sceneCache.animPeriod[i]!);
      const column = (sceneCache.animPhase0[i]! + advanced) % columns;
      command.sx = sceneCache.animOrigin[i]! + column * sceneCache.animStride[i]!;
    }
    lastDrawCommandCount = commands.length;
    // Device pixels per world tile — matches the resolution every placed
    // entity already draws at via the ctx transform above (dpr * zoom), so
    // a tinted ghost's offscreen buffer (paintTinted) is exactly as sharp
    // as the rest of the canvas instead of a fixed, zoom-independent size.
    const tintedRes = dpr * camera.state.pixelsPerTile;
    // Scene commands are never tinted — only the ghost is, and it paints via
    // its own paint() call below — so skip paint()'s tinted/untinted split.
    phases.animate = performance.now() - tAnimate;

    // Everything from the background up to the inserter arms either paints
    // straight onto the canvas, or — while sprites are animating under a
    // camera that has stopped moving — comes from baked layers with only the
    // animated sprites painted live between them. See bakedLayersFor.
    const showSupplyAreas = supplyAreasVisible();
    const baked = showSupplyAreas ? null : bakedLayersFor(sceneCache, outlined, procedural, w, h);
    lastFrameBaked = baked !== null;

    const tGrid = performance.now();
    // The base goes into the bottom bake, unless the bottom run is live.
    if (!baked || baked.plan.runs[0]!.live) paintBase(ctx, outlined, w, h);
    phases.grid = performance.now() - tGrid;

    // Supply areas are an UNDERLAY: the game shows them under the machines
    // they power, so a pole's square never hides what is standing on it.
    // Shown only while a pole is in hand — the ghost's own area plus every
    // placed pole's, which is how the game lets you see coverage gaps and
    // overlap while laying out a run.
    if (showSupplyAreas) {
      const areas: SupplyArea[] = [];
      for (const entity of visibleEntities) {
        const distance = visualFor(entity.name)?.supplyAreaDistance;
        if (distance !== undefined) areas.push({ x: entity.x, y: entity.y, distance });
      }
      if (ghost) {
        const distance = visualFor(ghost.name)?.supplyAreaDistance;
        if (distance !== undefined) areas.push({ x: ghost.x, y: ghost.y, distance });
      }
      drawSupplyAreas(ctx, areas, camera.state.pixelsPerTile);
    }

    const tPaint = performance.now();
    let armsBaked = false;
    if (baked) {
      const { plan, canvases } = baked;
      let layer = 0;
      for (const run of plan.runs) {
        if (run.live) {
          paintPlain(ctx, atlas, run.commands, paintTally ?? undefined, !quality.shadows);
        } else {
          blitBake(canvases[layer++]!);
        }
      }
      armsBaked = !plan.runs[plan.runs.length - 1]!.live;
    } else {
      paintPlain(ctx, atlas, commands, paintTally ?? undefined, !quality.shadows);
    }
    phases.paint = performance.now() - tPaint;

    const tInserters = performance.now();
    if (!armsBaked) paintArms(ctx, procedural);
    phases.inserters = performance.now() - tInserters;
    const tOverlays = performance.now();

    // Wires hang ABOVE the entities they join — a power line crosses over a
    // machine standing between two poles, it does not disappear behind it.
    // Drawn from the resolved list rather than per visible entity so a wire
    // whose far pole is off screen is still drawn to its real endpoint,
    // instead of stopping at the viewport edge.
    // A wire being drawn right now trails from the armed entity's terminal to
    // the cursor, so you can see what you are about to connect. Resolved per
    // frame rather than cached: the cursor end moves continuously, and it
    // leaves from exactly the terminal resolveWires would use for the
    // finished wire (terminalFor), so nothing jumps when the second end
    // lands. Appended to the same list so it sorts and strokes identically.
    const trailing: ResolvedWire[] = [];
    if (mode.kind === "wire" && pendingWireFrom !== null) {
      const from = entityById.get(pendingWireFrom);
      const start = from && terminalFor(from, visualFor(from.name), directionOf(from), mode.color, pendingWireSide);
      if (start) {
        const cursor = worldAtScreenPoint(lastPointer.x, lastPointer.y);
        trailing.push({ color: mode.color, x1: start.x, y1: start.y, x2: cursor.x, y2: cursor.y, reaches: true });
      }
    }
    drawWires(ctx, trailing.length ? [...resolvedWires, ...trailing] : resolvedWires, camera.state.pixelsPerTile);

    if (hasHighlight) {
      for (const entity of visibleEntities) {
        const visual = visualFor(entity.name);
        if (!visual) continue;
        const isProducer = highlight!.producers.has(entity.entityNumber);
        const isConsumer = highlight!.consumers.has(entity.entityNumber);
        if (!isProducer && !isConsumer) continue;
        const [fw, fh] = effectiveFootprint(visual, entity.direction);
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = isProducer ? "#93d977" : "#ffcc80";
        ctx.fillRect(entity.x - fw / 2, entity.y - fh / 2, fw, fh);
        ctx.restore();
      }
    }

    // An underground under the cursor — hovered, or the ghost about to be
    // built — also shows its paired other half (green brackets) and the
    // tunnel between them, the way the game does.
    const drawUndergroundPair = (target: PlacedEntity, corner: HTMLImageElement) => {
      if (target.undergroundType === undefined) return;
      const partner = undergroundPartner(entities, target, data.undergroundBelts?.[target.name]?.maxDistance ?? 0);
      if (!partner) return;
      const lines = getUndergroundLinesSprite();
      if (lines) {
        const facing = toCardinal(target.direction);
        const { dx, dy } = step(facing);
        const gap = Math.abs(partner.x - target.x) + Math.abs(partner.y - target.y);
        const sign = target.undergroundType === "output" ? -1 : 1;
        for (let k = 1; k < gap; k++) {
          drawUndergroundLine(ctx, lines, target.x + dx * k * sign, target.y + dy * k * sign, facing);
        }
      }
      drawHoverHighlight(ctx, corner, partner.x, partner.y, 1, 1, "pair");
    };

    // Track gets its brackets turned to lie along the rail, as in the game.
    const highlightEntity = (entity: PlacedEntity, visual: ResolvedVisual, sheet: HTMLImageElement) => {
      if (isRail(entity.name)) {
        const box = railHighlightBox(entity.name, entity.direction);
        drawHoverHighlight(ctx, sheet, entity.x + box.cx, entity.y + box.cy, box.w, box.h, "regular", box.angle, Math.min(box.w, box.h));
        return;
      }
      const [fw, fh] = effectiveFootprint(visual, entity.direction);
      drawHoverHighlight(ctx, sheet, entity.x, entity.y, fw, fh);
    };

    const corner = getHoverHighlightSprite();
    if (hoveredEntityNumber !== undefined && corner) {
      const hovered = entityById.get(hoveredEntityNumber);
      const visual = hovered && visualFor(hovered.name);
      if (hovered && visual) {
        drawUndergroundPair(hovered, corner);
        if (mode.kind === "wire" && visual.outputWireConnections) {
          // A held wire attaches to one half of a combinator — bracket just
          // the half under the cursor (input behind, output ahead).
          const { dx, dy } = step(toCardinal(hovered.direction));
          const sign = hoveredSide === 2 ? 0.5 : -0.5;
          drawHoverHighlight(ctx, corner, hovered.x + dx * sign, hovered.y + dy * sign, 1, 1);
        } else {
          highlightEntity(hovered, visual, corner);
        }
        // A combinator shows which way signals flow through it.
        const arrows = visual.outputWireConnections && getIndicationSprites();
        if (arrows) drawDirectionArrows(ctx, arrows.arrow, hovered.x, hovered.y, toCardinal(hovered.direction));
        // An inserter also shows where it picks up (bar) and drops (arrow).
        const indication = visual.inserterGraphics && getIndicationSprites();
        if (indication) {
          const reach = hovered.name === "long-handed-inserter" ? 2 : 1;
          drawInserterIndication(ctx, indication, hovered.x, hovered.y, toCardinal(hovered.direction), reach);
        }
      }
    }
    // The ghost itself gets no yellow brackets — only its would-be pair.
    if (ghost && corner) drawUndergroundPair(ghost, corner);

    // Marquee rectangle while a box-drag action (copyBox/cutBox/deleteBox)
    // is in progress — tinted per mode so the color itself hints at what
    // releasing the drag will do (reddish = delete, blue = copy/cut,
    // matching the cursor badge drawn further below). Line width is 1
    // screen px expressed in world units (matches the grid's own
    // zoom-independent line width elsewhere in this file) so the outline
    // stays a hairline regardless of zoom instead of thickening at high
    // zoom the way a world-unit constant would.
    if (isBoxMode(mode.kind) && boxDragMoved && boxDownWorldPos && boxDragCurrentWorldPos) {
      const left = Math.min(boxDownWorldPos.x, boxDragCurrentWorldPos.x);
      const right = Math.max(boxDownWorldPos.x, boxDragCurrentWorldPos.x);
      const top = Math.min(boxDownWorldPos.y, boxDragCurrentWorldPos.y);
      const bottom = Math.max(boxDownWorldPos.y, boxDragCurrentWorldPos.y);
      const [fill, stroke] =
        mode.kind === "deleteBox" ? ["rgba(255,100,90,0.15)", "rgba(255,100,90,0.9)"] : ["rgba(120,170,255,0.15)", "rgba(120,170,255,0.9)"];
      ctx.save();
      ctx.fillStyle = fill;
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1 / camera.state.pixelsPerTile;
      ctx.strokeRect(left, top, right - left, bottom - top);
      ctx.restore();

      // Live preview of what releasing the drag right now would act on —
      // every entity the box currently overlaps gets the same corner
      // highlight as a hover, reusing drawHoverHighlight as-is. Recomputed
      // every frame the box is visible rather than cached: cheap (one
      // spatial query) and always exactly matches what onPointerUp would
      // hit-test if the drag ended this instant.
      const corner = getHoverHighlightSprite();
      if (corner) {
        const inBox = entitiesInBox(left, top, right, bottom);
        for (const num of inBox) {
          const entity = entityById.get(num);
          const visual = entity && visualFor(entity.name);
          if (!entity || !visual) continue;
          highlightEntity(entity, visual, corner);
        }
      }
    }

    // Alt-mode badges: a separate pass over every entity, after all sprites
    // are drawn, so a badge never gets painted over by a neighboring
    // entity's own sprite depending on entity list order — matches the
    // real game's alt-mode reading as a UI-like layer over the world.
    if (altMode) {
      for (const entity of visibleEntities) {
        const visual = visualFor(entity.name);
        if (visual) drawAltModeOverlay(ctx, iconAtlas, entity, visual, altModeLayers);
      }
    }

    phases.overlays = performance.now() - tOverlays;

    const tGhostDraw = performance.now();
    // A held signal shows the rail blocks signals divide track into, as a
    // line down the middle of the track in each block's colour, and a handle
    // at every free slot along nearby track. Both go under the ghost, so the
    // snapped ghost sits on top of its own handle. A held train stop shows
    // its own, larger handles.
    if (mode.kind === "place" && ghostWorldPos && (mode.entityName === "rail-signal" || mode.entityName === "rail-chain-signal")) {
      const index = currentRailIndex();
      const blocks = index.blocks();
      for (const { piece, block, cut } of blocks.pieces) {
        const color = RAIL_BLOCK_COLORS[blocks.colors[block]!]!;
        const line = railCentreline(piece.name, piece.direction, 12).map(([x, y]): [number, number] => [piece.x + x, piece.y + y]);
        drawRailBlockLine(ctx, trimPolyline(line, cut[0] ? RAIL_BLOCK_MARKER_INSET : 0, cut[1] ? RAIL_BLOCK_MARKER_INSET : 0), color);
      }
      for (const m of blocks.markers) drawRailBlockMarker(ctx, m.x, m.y, m.dir, m.kind, RAIL_BLOCK_COLORS[blocks.colors[m.block]!]!);
      for (const slot of signalSlotsNear(index, ghostWorldPos.x, ghostWorldPos.y)) {
        drawSignalHandle(ctx, slot);
      }
    }
    if (mode.kind === "place" && ghostWorldPos && mode.entityName === "train-stop") {
      for (const slot of stopSlotsNear(currentRailIndex(), ghostWorldPos.x, ghostWorldPos.y)) drawStopHandle(ctx, slot);
    }
    if (ghost) {
      const visual = visualFor(ghost.name);
      const ghostTint = ghostCanPlace ? GHOST_VALID_TINT : GHOST_INVALID_TINT;
      if (visual) {
        if (visual.inserterGraphics) {
          // Full alpha — the green/red tint itself is what marks this as a
          // ghost rather than a placed entity, so fading it out on top would
          // just hide the texture detail the tint is supposed to sit over.
          drawInserter(ctx, atlas, ghost, visual.inserterGraphics, ghostTint, tintedRes);
        } else if (visual.graphics) {
          const ghostCommands: DrawCommand[] = [];
          collectEntity(ghostCommands, ghost, visual, { grid: previewGrid, fluidNetwork: previewFluidNetwork, heatNetwork: previewHeatNetwork, ...connectors, platformBoxes, animationFrame }, 1);
          for (const c of ghostCommands) c.tint = ghostTint;
          paint(ctx, atlas, ghostCommands, tintedRes);
        }
        // Always shown, regardless of alt-mode — what quality you're about
        // to place should stay visible the whole time it's in hand, not
        // only when alt-mode also happens to be on.
        drawQualityBadge(ctx, iconAtlas, ghost, visual);
      }
    }

    for (let i = 0; i < pasteGhosts.length; i++) {
      const pg = pasteGhosts[i]!;
      const visual = visualFor(pg.name);
      if (!visual) continue;
      const ghostTint = pasteGhostValid[i] ? GHOST_VALID_TINT : GHOST_INVALID_TINT;
      if (visual.inserterGraphics) {
        drawInserter(ctx, atlas, pg, visual.inserterGraphics, ghostTint, tintedRes);
      } else if (visual.graphics) {
        const ghostCommands: DrawCommand[] = [];
        collectEntity(ghostCommands, pg, visual, { grid: previewGrid, fluidNetwork: previewFluidNetwork, heatNetwork: previewHeatNetwork, ...connectors, platformBoxes, animationFrame }, 1);
        for (const c of ghostCommands) c.tint = ghostTint;
        paint(ctx, atlas, ghostCommands, tintedRes);
      }
      drawQualityBadge(ctx, iconAtlas, pg, visual);
    }

    if (railGhosts.length > 0) {
      // One paint call per tint for the whole plan, so every piece's bed
      // sorts under every piece's rails, same as placed track (a tinted
      // batch is washed in a single colour, so tints can't share one).
      const byTint = new Map<string, DrawCommand[]>();
      for (const { entity, tint } of railGhosts) {
        const visual = visualFor(entity.name);
        if (!visual?.graphics) continue;
        const commands = byTint.get(tint) ?? byTint.set(tint, []).get(tint)!;
        const start = commands.length;
        collectEntity(commands, entity, visual, { grid: previewGrid, fluidNetwork: previewFluidNetwork, heatNetwork: previewHeatNetwork, ...connectors, platformBoxes, animationFrame }, 1);
        for (let i = start; i < commands.length; i++) commands[i]!.tint = tint;
      }
      for (const commands of byTint.values()) paint(ctx, atlas, commands, tintedRes);
    }
    if (railArrow) drawRailStartArrow(ctx, railArrow.x, railArrow.y, railArrow.dir);
    if (railBlocked) drawBlockedCross(ctx, railBlocked.x, railBlocked.y);

    phases.ghost += performance.now() - tGhostDraw;

    ctx.restore();

    // Cursor-mode badge for the three box-drag action modes: a small icon
    // near the pointer so the active tool is legible without checking a
    // toolbar. Drawn in SCREEN space (outside the world transform above,
    // hence after ctx.restore()) so it stays a fixed pixel size at any zoom
    // — a world-space draw would grow/shrink with the camera the way the
    // hover-highlight corners deliberately do, which is wrong for a cursor
    // badge that represents the tool, not something anchored to the map.
    if (isBoxMode(mode.kind)) {
      const iconId = mode.kind === "deleteBox" ? "deconstruction-planner" : mode.kind === "cutBox" ? "cut-paste-tool" : "copy-paste-tool";
      const icon = iconAtlas.get(iconId);
      if (icon) {
        // lastPointer is in CLIENT coordinates (matches every other
        // pointer-event field this file reads) — canvas-relative like the
        // 0,0-anchored transform just set above needs getBoundingClientRect
        // subtracted first, the same conversion setInteractionMode/onWheel
        // already do for their own screenToWorld calls.
        const rect = canvas.getBoundingClientRect();
        const size = 28;
        const offset = 14; // clear of the actual cursor hotspot
        ctx.drawImage(
          icon.sheet,
          icon.cell.x, icon.cell.y, icon.cell.w, icon.cell.h,
          lastPointer.x - rect.left + offset, lastPointer.y - rect.top + offset, size, size,
        );
      }
    }
  }

  let animationFrozen = false;

  function applyKeyboardPan(dtMs: number): void {
    if (heldKeys.size === 0) return;
    let dx = 0;
    let dy = 0;
    if (heldKeys.has("a")) dx += 1;
    if (heldKeys.has("d")) dx -= 1;
    if (heldKeys.has("w")) dy += 1;
    if (heldKeys.has("s")) dy -= 1;
    if (dx === 0 && dy === 0) return;
    // Diagonal movement (e.g. W+D) is normalized so it isn't faster than a
    // single direction — matches the real game's own WASD camera feel.
    const length = Math.hypot(dx, dy);
    const distance = (KEYBOARD_PAN_SPEED * dtMs) / 1000;
    camera.panByScreenDelta((dx / length) * distance, (dy / length) * distance);

    // Panning moves the world under a stationary screen cursor, so anything
    // keyed off "the world point under the cursor" — the placement ghost,
    // an active place/erase drag — goes stale unless it's recomputed here
    // too, exactly as onPointerMove would if the mouse itself had moved.
    // Without this, holding left/right-click and panning with WASD left the
    // ghost frozen at its pre-pan world position (visually "hiding" behind
    // the scrolling map) and placed/erased nothing along the way.
    if (isErasing) eraseAtScreenPoint(lastPointer.x, lastPointer.y);
    if (mode.kind === "place") {
      ghostWorldPos = worldAtScreenPoint(lastPointer.x, lastPointer.y);
      invalidate();
      if (isPlacingDrag) placeAtGhost();
    }
  }

  /** Per-entity-type animation profile: for one entity of this name+direction,
   *  which of its commands move, and how.
   *
   *  Probing is done ONCE per entity type and memoised, not per scene. Probing
   *  the whole visible set on every cache miss made panning and zooming
   *  catastrophically slow — the visible set changes every frame while moving,
   *  so a 257-pass probe over thousands of entities ran 60 times a second. */
  interface AnimProfile {
    /** Indices into one entity's own command list, and their sx behaviour. */
    animated: number[];
    stride: number[];
    period: number[];
    /** The column index (not pixels) this command sits on at animation frame
     *  0, and how many columns its sheet row holds. sx is reconstructed as
     *  origin + ((phase0 + frame/slowdown) % columns) * stride, mirroring the
     *  `rawColumn % sprite.columns` wrap push() itself applies — a plain
     *  base + frame * stride ramp cannot express a phase-shifted sprite,
     *  because such a sprite wraps partway through its cycle rather than at
     *  the end of it. */
    phase0: number[];
    columns: number[];
    /** Columns advanced over one full period (see SceneCache.animSteps). */
    steps: number[];
    origin: number[];
    /** How many commands the probed (isolated) entity emitted. The caller
     *  compares this against what the same entity emitted in the real scene:
     *  the indices above only mean anything when the two agree. */
    commandCount: number;
  }
  const animProfiles = new Map<string, AnimProfile>();

  const NO_ANIMATION: AnimProfile = { animated: [], stride: [], period: [], phase0: [], columns: [], steps: [], origin: [], commandCount: -1 };

  /** Collects a single entity at one animation frame, against whatever
   *  neighbour context it is handed.
   *
   *  Neighbours do not change how a sprite's own frames advance, but they do
   *  change HOW MANY commands the entity emits — a belt or splitter alone
   *  draws end caps that the same entity mid-run does not. The profile's
   *  indices are therefore only valid for a command list of the same length,
   *  which buildSceneCache checks before using them. */
  function collectAt(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext, frame: number): DrawCommand[] {
    const out: DrawCommand[] = [];
    collectEntity(out, entity, visual, { ...baseCtx, animationFrame: frame }, 1);
    return out;
  }

  /** Re-probes one entity against its real neighbours, for the minority whose
   *  isolated shape did not match. Deliberately not memoised on the shared
   *  key: the whole reason it is being called is that this entity's shape
   *  differs from its type's, so caching it under the type would poison the
   *  fast path for every other instance. */
  function probeShape(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext, expected: number): AnimProfile {
    const profile = probe(entity, visual, baseCtx);
    return profile.commandCount === expected ? profile : NO_ANIMATION;
  }

  function animProfileFor(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext): AnimProfile {
    // Direction matters: the same entity facing two ways can lay its frames out
    // differently, and turbo belts offset alternate tiles by parity. So does an
    // underground's end: entrance and exit keep opposite halves of the belt
    // frame, so their lane's frame origin differs by half a frame.
    const key = `${entity.name}|${entity.direction}|${Math.abs(Math.round(entity.x) + Math.round(entity.y)) % 2}|${entity.undergroundType ?? ""}`;
    const cached = animProfiles.get(key);
    if (cached) return cached;

    if (!hasAnimatedLayer(visual)) {
      animProfiles.set(key, NO_ANIMATION);
      return NO_ANIMATION;
    }

    const profile = probe(entity, visual, baseCtx);
    animProfiles.set(key, profile);
    return profile;
  }

  /** Works out, by sampling, which of one entity's commands animate and how.
   *  Shared by the memoised per-type path and the per-entity fallback. */
  function probe(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext): AnimProfile {
    const base = collectAt(entity, visual, baseCtx, 0);
    const animated: number[] = [];
    const stride: number[] = [];
    const period: number[] = [];

    const samples: DrawCommand[][] = [];
    let structural = false;
    for (let frame = 1; frame <= MAX_ANIM_PERIOD; frame++) {
      const at = collectAt(entity, visual, baseCtx, frame);
      if (at.length !== base.length) { structural = true; break; }
      samples.push(at);
    }

    const phase0: number[] = [];
    const columnCount: number[] = [];
    const stepCount: number[] = [];
    const origin: number[] = [];

    if (!structural) {
      for (let i = 0; i < base.length; i++) {
        // The frame width is the greatest common divisor of every sx step
        // the command takes across the cycle, wraps included. Reading it from
        // the samples rather than from the sprite keeps this independent of
        // how the layer was described; a gcd rather than the smallest step
        // because a fast belt moves several columns a tick (a blue belt's
        // +3 and its -29 wrap only agree on one column).
        let width = 0;
        for (let frame = 0; frame < samples.length; frame++) {
          const delta = Math.abs(samples[frame]![i]!.sx - (frame === 0 ? base[i]!.sx : samples[frame - 1]![i]!.sx));
          if (delta > 0) width = gcd(width, delta);
        }
        if (width === 0) continue;

        // How many frames before the command returns to its frame-0 cell.
        let cycle = 0;
        for (let frame = 1; frame <= samples.length; frame++) {
          if (samples[frame - 1]![i]!.sx === base[i]!.sx) { cycle = frame; break; }
        }
        if (cycle <= 0) continue;

        // The lowest sx the command ever reaches is its row's column 0; the
        // frame-0 offset above it is the sprite's starting phase. For a turbo
        // belt's odd-parity tile that phase is half the sheet, which is
        // exactly the case the old linear-only model had to reject.
        let low = base[i]!.sx;
        for (let frame = 0; frame < cycle; frame++) low = Math.min(low, samples[frame]![i]!.sx);
        const startPhase = (base[i]!.sx - low) / width;
        if (!Number.isInteger(startPhase)) continue;

        // Derive the column count from the widest sx actually reached.
        let high = base[i]!.sx;
        for (let frame = 0; frame < cycle; frame++) high = Math.max(high, samples[frame]![i]!.sx);
        const columns = (high - low) / width + 1;

        // How many columns the command walks through over one cycle: a
        // forward step from one frame to the next, modulo the row. Frames
        // advance `speedup / slowdown` columns a tick, so this is cycle /
        // slowdown for a slowed sprite and a multiple of `columns` for a
        // belt faster than one column a tick.
        let steps = 0;
        let previous = startPhase;
        for (let frame = 1; frame <= cycle; frame++) {
          const current = (samples[frame - 1]![i]!.sx - low) / width;
          steps += (((current - previous) % columns) + columns) % columns;
          previous = current;
        }
        if (steps === 0) continue;

        // Accept only an exact wrapping ramp with nothing else moving;
        // anything else stays on its frame-0 art rather than risking wrong
        // sprites.
        let matches = true;
        for (let frame = 1; frame <= samples.length && matches; frame++) {
          const sample = samples[frame - 1]![i]!;
          const column = (startPhase + Math.floor(((frame % cycle) * steps) / cycle)) % columns;
          matches =
            sample.sx === low + column * width &&
            sample.sheet === base[i]!.sheet &&
            sample.sy === base[i]!.sy &&
            sample.layer === base[i]!.layer &&
            sample.order === base[i]!.order;
        }
        if (!matches) continue;

        animated.push(i);
        stride.push(width);
        period.push(cycle);
        phase0.push(startPhase);
        columnCount.push(columns);
        stepCount.push(steps);
        origin.push(low);
      }
    }

    return { animated, stride, period, phase0, columns: columnCount, steps: stepCount, origin, commandCount: base.length };
  }

  /** Maps world tiles onto the canvas: camera center to viewport center,
   *  y-down, which matches both screen space and Factorio's own convention.
   *  Expects the dpr scale to be set already. */
  function applyWorldTransform(target: CanvasRenderingContext2D): void {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    target.translate(w / 2, h / 2);
    target.scale(camera.state.pixelsPerTile, camera.state.pixelsPerTile);
    target.translate(-camera.state.x, -camera.state.y);
  }

  /** The bottom of every frame: background, grid, and the outline stand-ins
   *  for entities that have no sprites. Called in world space. */
  function paintBase(target: CanvasRenderingContext2D, outlined: PlacedEntity[], w: number, h: number): void {
    target.save();
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    target.fillStyle = "#1f1e1c";
    target.fillRect(0, 0, w, h);
    target.restore();
    drawGrid(target, camera, w, h);
    for (const entity of outlined) {
      const [fw, fh] = effectiveFootprint(visualFor(entity.name)!, entity.direction);
      drawOutline(target, entity.x, entity.y, fw, fh);
    }
  }

  /** Inserter arms always paint over the whole Y-sorted scene. */
  function paintArms(target: CanvasRenderingContext2D, procedural: PlacedEntity[]): void {
    for (const entity of procedural) {
      const visual = visualFor(entity.name)!;
      target.globalAlpha = alphaFor(entity);
      drawInserter(target, atlas, entity, visual.inserterGraphics);
    }
    target.globalAlpha = 1;
  }

  /* ---------- baked layers ----------
   *
   * With belts on screen every frame is redrawn, and before baking every
   * redraw repainted the whole scene — every building, shadow and pipe —
   * just to move the belt art along one column. Baking paints the static
   * sprites once into offscreen canvases the size of the viewport and
   * reuses them until the scene or the camera changes; a frame then costs a
   * couple of blits plus the animated sprites alone.
   *
   * The bakes are in screen space, pixel for pixel the same as painting
   * directly, so nothing shifts or blurs between baked and live sprites.
   * The price is that any camera move invalidates them, so a frame whose
   * view differs from the previous frame's paints directly instead — a pan
   * costs exactly what it did before, and baking starts the first frame
   * the camera holds still. */

  interface BakeState {
    scene: SceneCache;
    viewKey: string;
    /** False when a sheet was still loading while baking: that sprite is
     *  missing from the bake, so it is rebaked next frame rather than kept. */
    complete: boolean;
  }
  let bakeState: BakeState | null = null;
  const bakeCanvases: HTMLCanvasElement[] = [];
  /** The previous frame's scene and view, to tell a held camera from a
   *  moving one. */
  let prevScene: SceneCache | null = null;
  let prevViewKey = "";
  let lastFrameBaked = false;
  let bakeCount = 0;

  function bakeCanvas(index: number): HTMLCanvasElement {
    let c = bakeCanvases[index];
    if (!c) bakeCanvases[index] = c = document.createElement("canvas");
    if (c.width !== canvas.width || c.height !== canvas.height) {
      c.width = canvas.width;
      c.height = canvas.height;
    }
    return c;
  }

  function blitBake(source: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  /** Returns the baked layers for this frame, (re)baking them first when
   *  needed, or null when this frame should paint directly: nothing
   *  animates (so the frame is not redrawn continuously and baking would
   *  only add work), or the view is still moving. */
  function bakedLayersFor(
    scene: SceneCache,
    outlined: PlacedEntity[],
    procedural: PlacedEntity[],
    w: number,
    h: number,
  ): { plan: BakePlan; canvases: HTMLCanvasElement[] } | null {
    const viewKey = `${camera.state.x}|${camera.state.y}|${camera.state.pixelsPerTile}|${canvas.width}x${canvas.height}|${dpr}|${quality.shadows}`;
    const settled = scene === prevScene && viewKey === prevViewKey;
    prevScene = scene;
    prevViewKey = viewKey;
    if (scene.animated.length === 0 || !quality.animation || !settled) return null;

    const plan = (scene.bakePlan ??= planBake(scene.commands, scene.animated));
    if (plan.bakedCount === 0) return null;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < plan.bakedCount; i++) canvases.push(bakeCanvas(i));

    if (bakeState && bakeState.scene === scene && bakeState.viewKey === viewKey && bakeState.complete) {
      return { plan, canvases };
    }

    let complete = true;
    let layer = 0;
    for (let r = 0; r < plan.runs.length; r++) {
      const run = plan.runs[r]!;
      if (run.live) continue;
      const target = canvases[layer]!.getContext("2d")!;
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, canvas.width, canvas.height);
      target.imageSmoothingEnabled = false;
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      applyWorldTransform(target);
      if (r === 0) paintBase(target, outlined, w, h);
      for (const c of run.commands) if (!atlas.get(c.sheet)) complete = false;
      paintPlain(target, atlas, run.commands, undefined, !quality.shadows);
      if (r === plan.runs.length - 1) {
        for (const entity of procedural) {
          const g = visualFor(entity.name)?.inserterGraphics;
          if (g && (!atlas.get(g.platform.sheet) || !atlas.get(g.handBase.sheet) || !atlas.get(g.handOpen.sheet))) complete = false;
        }
        paintArms(target, procedural);
      }
      layer++;
    }
    bakeState = { scene, viewKey, complete };
    bakeCount++;
    return { plan, canvases };
  }

  /** Collects and sorts the visible scene once, recording which of the
   *  resulting commands animate so later frames only patch their sx.
   *
   *  Cost is one collect pass plus one sort — the same work the renderer did
   *  every frame before caching existed. The expensive part, working out how
   *  each sprite animates, is memoised per entity type by animProfileFor. */
  function buildSceneCache(key: string, visibleEntities: PlacedEntity[], baseCtx: CollectContext): SceneCache {
    const commands: DrawCommand[] = [];
    const animated: number[] = [];
    const animOrigin: number[] = [];
    const animStride: number[] = [];
    const animPeriod: number[] = [];
    const animPhase0: number[] = [];
    const animColumns: number[] = [];
    const animSteps: number[] = [];

    // Collect entity by entity so each command's index is known while its
    // profile is still in hand; the sort afterwards moves them, so the
    // recorded indices are remapped below.
    const preSort: { command: DrawCommand; stride: number; period: number; columns: number; steps: number; phase0: number; origin: number }[] = [];
    // Only allocated when the panel asked for it — see setEntityAccounting.
    const costByName = entityAccounting ? new Map<string, EntityCost>() : null;
    for (const entity of visibleEntities) {
      const visual = visualFor(entity.name);
      if (visual?.inserterGraphics) {
        // The platform Y-sorts with everything else here; only the arm/hand
        // (drawn separately, see the `procedural` pass below) always paints
        // on top regardless of depth — see collectInserterPlatform's own
        // doc comment for why the two are split.
        collectInserterPlatform(commands, entity, visual.inserterGraphics, alphaFor(entity));
        continue;
      }
      if (!visual?.graphics) continue;
      const before = commands.length;
      const tEntity = costByName ? performance.now() : 0;
      collectEntity(commands, entity, visual, baseCtx, alphaFor(entity));
      if (costByName) {
        let cost = costByName.get(entity.name);
        if (!cost) costByName.set(entity.name, (cost = { name: entity.name, count: 0, drawCommands: 0, collectMs: 0 }));
        cost.count++;
        cost.drawCommands += commands.length - before;
        cost.collectMs += performance.now() - tEntity;
      }
      const profile = animProfileFor(entity, visual, baseCtx);
      // The profile is probed on an ISOLATED copy of the entity, so its
      // command indices only line up with the real scene's when this entity
      // emitted the same number of commands there. Neighbours decide that
      // count: a belt or splitter surrounded by its own kind drops the end
      // caps a lone one draws, so index `local` can land on a different
      // sprite entirely — for a splitter, on one of the two lanes' caps,
      // whose sx was then patched to a column its row does not have. That
      // is the flicker: a frame addressing an empty cell of the sheet.
      // Falling back to a per-entity probe keeps such an entity animating
      // correctly instead of guessing; it only runs for the entities whose
      // shape actually differs, so the memoised fast path still covers the
      // overwhelming majority.
      const emitted = commands.length - before;
      const usable = profile.animated.length === 0 || profile.commandCount === emitted
        ? profile
        : probeShape(entity, visual, baseCtx, emitted);
      for (let k = 0; k < usable.animated.length; k++) {
        const local = usable.animated[k]!;
        const command = commands[before + local];
        if (command) {
          preSort.push({
            command,
            stride: usable.stride[k]!,
            period: usable.period[k]!,
            columns: usable.columns[k]!,
            steps: usable.steps[k]!,
            phase0: usable.phase0[k]!,
            origin: usable.origin[k]!,
          });
        }
      }
    }

    commands.sort(compareDrawCommands);

    // Re-find each animated command's post-sort index. A Map keyed on the
    // command object keeps this O(n) rather than a scan per entry.
    const indexOf = new Map<DrawCommand, number>();
    for (let i = 0; i < commands.length; i++) indexOf.set(commands[i]!, i);
    for (const entry of preSort) {
      const index = indexOf.get(entry.command);
      if (index === undefined) continue;
      animated.push(index);
      // The scene was collected at animationFrame 0, so the command's own sx
      // IS its frame-0 cell — the probe's origin/phase0 describe the same
      // sheet row and transfer directly. Asserting that rather than trusting
      // it: a mismatch means the profile was matched to the wrong command,
      // and leaving such a command unpatched (static art) is far better than
      // walking it across cells its row does not have.
      const expectedSx = entry.origin + entry.phase0 * entry.stride;
      if (entry.command.sx !== expectedSx) { animated.pop(); continue; }
      animOrigin.push(entry.origin);
      animStride.push(entry.stride);
      animPeriod.push(entry.period);
      animPhase0.push(entry.phase0);
      animColumns.push(entry.columns);
      animSteps.push(entry.steps);
    }

    if (costByName) {
      entityCosts = [...costByName.values()].sort((a, b) => b.collectMs - a.collectMs);
    }

    return { key, commands, animated, animOrigin, animStride, animPeriod, animPhase0, animColumns, animSteps };
  }

  /** The one place a frame is drawn and accounted for. Both the rAF loop and
   *  stepAnimationFrame go through it, so a recording captures manually
   *  stepped frames too rather than silently missing them. */
  function drawAndAccount(): void {
    const drawStart = performance.now();
    draw();
    const renderMs = performance.now() - drawStart;
    renderTimes.push(renderMs);
    if (renderTimes.length > FRAME_HISTORY) renderTimes.shift();
    framesDrawn++;
    if (recording) recordFrame(performance.now(), renderMs);
  }

  /** Appends one entry to the frame log, and stops the recording once its
   *  time is up. Called only while recording, so an idle renderer pays
   *  nothing for the feature. */
  function recordFrame(now: number, renderMs: number): void {
    if (frameLog.length < FRAME_LOG_CAPACITY) {
      const frameMs = frameTimes.length > 0 ? frameTimes[frameTimes.length - 1]! : 0;
      // Chromium-only; every other browser leaves performance.memory undefined.
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      frameLog.push({
        t: now - recordingStartedAt,
        frameMs,
        renderMs,
        // Never negative: frameMs is measured at the top of the tick and
        // renderMs inside it, so on the very first recorded frame (frameMs 0)
        // the subtraction would otherwise report a nonsensical deficit.
        outsideMs: Math.max(0, frameMs - renderMs),
        phases: { ...phases },
        visibleEntities: lastVisibleEntityCount,
        drawCommands: lastDrawCommandCount,
        paint: paintTally
          ? { ...paintTally }
          : { drawn: 0, skipped: 0, sheets: 0, area: 0, compositeSwitches: 0 },
        atlas: atlas.stats(),
        sceneRebuilt: sceneRebuiltThisFrame,
        rebuildReason: rebuildReasonThisFrame,
        skippedSince: framesSkipped - skippedAtLastRecord,
        heapMB: heap ? Math.round(heap.usedJSHeapSize / 1e6) : null,
        cameraX: camera.state.x,
        cameraY: camera.state.y,
        pixelsPerTile: camera.state.pixelsPerTile,
      });
      skippedAtLastRecord = framesSkipped;
    }
    if (now >= recordingStopsAt || frameLog.length >= FRAME_LOG_CAPACITY) recording = false;
  }

  function tick(): void {
    if (destroyed) return;
    const now = performance.now();
    if (lastTickAt !== 0) {
      frameTimes.push(now - lastTickAt);
      if (frameTimes.length > FRAME_HISTORY) frameTimes.shift();
    }
    lastTickAt = now;
    // Advance the belt clock only while something on screen actually reads
    // it. On a scene with no animated entity visible this leaves the frame
    // clean, and nothing is redrawn until the user does something.
    // The frame cap only holds back drawing: a skipped frame stays dirty
    // and is drawn on the next tick that's allowed to. The belt clock moves
    // by the 60 Hz frames that passed since the last drawn frame (at most a
    // few, so coming back from idle doesn't jump), so belts keep their speed
    // at 30 fps and just move in bigger steps.
    const mayDraw = now - lastDrawAt >= 1000 / quality.maxFps - 2;
    if (mayDraw && quality.animation && !animationFrozen && animatedVisibleCount > 0) {
      const steps = lastDrawAt === 0 ? 1 : Math.min(4, Math.max(1, Math.round((now - lastDrawAt) / (1000 / 60))));
      animationFrame = (animationFrame + steps) % 1_000_000;
      needsRedraw = true;
    }
    applyKeyboardPan(16); // pans through the camera, which invalidates itself
    if (needsRedraw && mayDraw) {
      lastDrawAt = now;
      drawAndAccount();
      needsRedraw = false;
    } else {
      framesSkipped++;
    }
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

  function worldAtScreenPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return camera.screenToWorld(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
  }

  function worldAtPointer(e: PointerEvent): { x: number; y: number } {
    return worldAtScreenPoint(e.clientX, e.clientY);
  }

  function eraseAtScreenPoint(clientX: number, clientY: number): void {
    const world = worldAtScreenPoint(clientX, clientY);
    const hit = spatialIndex.hitTest(world.x, world.y);
    if (hit === undefined || erasedThisGesture.has(hit)) return;
    erasedThisGesture.add(hit);
    eraseCallback?.(hit);
  }

  function eraseAtPointer(e: PointerEvent): void {
    eraseAtScreenPoint(e.clientX, e.clientY);
  }

  /** A signal/stop slot is free when nothing but track already stands on
   *  it. `overlapping` is the spatial query over the ghost's own box, when
   *  the caller already has one. */
  function railsideOk(slot: { x: number; y: number } | undefined, overlapping?: ReadonlySet<number>): boolean {
    if (!slot) return false;
    const index = currentRailIndex();
    if (index.railsideTaken.has(`${slot.x},${slot.y}`)) return false;
    const hits = overlapping ?? spatialIndex.queryRect(slot.x - 0.49, slot.y - 0.49, slot.x + 0.49, slot.y + 0.49);
    for (const id of hits) {
      const e = entityById.get(id);
      if (e && !isRailPlannerItem(e.name)) {
        // A footprint that only brushes the slot from a neighbouring tile
        // (track, or a signal next door) doesn't block it.
        if (Math.abs(e.x - slot.x) < 0.5 && Math.abs(e.y - slot.y) < 0.5) return false;
        if (!isRailSnapped(e.name)) {
          const visual = visualFor(e.name);
          const [w, h] = visual ? effectiveFootprint(visual, e.direction) : FALLBACK_FOOTPRINT;
          if (Math.abs(e.x - slot.x) < w / 2 && Math.abs(e.y - slot.y) < h / 2) return false;
        }
      }
    }
    return true;
  }

  /** Places at the ghost's current snapped grid cell if that cell hasn't
   *  already been placed into during this drag — matching the real game's
   *  drag-to-place-a-line-of-belts/walls feel: hold left-click and drag to
   *  keep placing wherever the ghost lands, one placement per cell instead
   *  of one per pointermove event (which would fire many times over the
   *  same cell at normal drag speeds). */
  function placeAtGhost(): void {
    if (mode.kind !== "place" || !ghostWorldPos) return;
    if (isRailSnapped(mode.entityName)) {
      const index = currentRailIndex();
      const slot = railsideSlot(index, mode.entityName, ghostWorldPos.x, ghostWorldPos.y, ghostDirection);
      if (!slot || !railsideOk(slot)) return;
      const key = `${slot.x},${slot.y}`;
      if (placedThisGesture.has(key)) return;
      placedThisGesture.add(key);
      placeCallback?.(slot.x, slot.y, slot.direction);
      return;
    }
    const visual = visualFor(mode.entityName);
    const [fw, fh] = visual ? effectiveFootprint(visual, ghostDirection) : FALLBACK_FOOTPRINT;
    const snapped = { x: snapAxis(ghostWorldPos.x, fw), y: snapAxis(ghostWorldPos.y, fh) };
    const key = `${snapped.x},${snapped.y}`;
    if (placedThisGesture.has(key)) return;
    placedThisGesture.add(key);
    placeCallback?.(snapped.x, snapped.y, ghostDirection);
  }

  /** Commits the paste ghost's current stamp. Unlike placeAtGhost, the
   *  ghost is not consumed by this — mode stays 'paste' so the next click
   *  stamps again, matching the real game's own "keep the item in hand
   *  until you put it away" convention. Modifier keys read at commit time
   *  (not copy time) decide how the app should resolve any collision. */
  function placePasteGhost(e: PointerEvent): void {
    if (mode.kind !== "paste" || !ghostWorldPos) return;
    const snappedAnchor = snapPasteAnchor(ghostWorldPos);
    // Relative snapping: the first stamp fixes the grid later ones line up with.
    if (mode.snap && !mode.snap.absolute && !relativeSnapOrigin) {
      relativeSnapOrigin = { x: snappedAnchor.x + pasteCellOffset().x, y: snappedAnchor.y + pasteCellOffset().y };
    }
    const collisionMode: "block" | "skip" | "replace" = e.shiftKey && e.altKey ? "replace" : e.shiftKey ? "skip" : "block";
    pasteCallback?.(mode.entities, mode.wires, snappedAnchor, mode.anchor, mode.groupRotation, collisionMode);
  }

  /** Midpoint (screen px) and distance (screen px) between the two active
   *  touches — undefined unless exactly two fingers are down. */
  function pinchGeometry(): { mid: { x: number; y: number }; distance: number } | undefined {
    if (activeTouches.size !== 2) return undefined;
    const [a, b] = [...activeTouches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  function onPointerDown(e: PointerEvent): void {
    // Stops the browser's own left-click text-selection drag from starting
    // alongside pointer-capture panning/placing/opening — confirmed by
    // spike this was the source of pan sometimes feeling like the native
    // browser gesture was still "coming through" underneath it.
    e.preventDefault();

    if (e.pointerType === "touch") {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size === 2) {
        // A second finger landing starts a pinch — cancel whatever the first
        // finger's own single-touch pan was doing so the two gestures don't
        // fight (a pan delta computed from the wrong finger).
        isPanning = false;
        const geo = pinchGeometry()!;
        lastPinchDistance = geo.distance;
        lastPointer = geo.mid;
        return;
      }
      if (activeTouches.size > 2) return; // ignore a third finger entirely
    }

    if (e.button === 2 && railAnchor) {
      // While track is being planned, right-click drops the plan rather
      // than mining whatever is under the cursor.
      railAnchor = null;
      railPendingPiece = null;
      invalidate();
      return;
    }
    if (e.button === 2) {
      if (e.altKey) {
        // Alt+right-click is its own gesture (see onAltRightClickEntity) —
        // report the entity under the cursor and start no erase drag, so
        // the modifier can never mass-mine by accident.
        const world = worldAtPointer(e);
        const hit = spatialIndex.hitTest(world.x, world.y);
        if (hit !== undefined) altRightClickCallback?.(hit);
        return;
      }
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
      shiftHeld = e.shiftKey;
      if (isRailPlannerItem(mode.entityName)) {
        // Captured so a drag that ends off the canvas still lays its track.
        canvas.setPointerCapture(e.pointerId);
        railPress();
      } else {
        placeAtGhost();
      }
      return;
    }

    if (isBoxMode(mode.kind)) {
      const world = worldAtPointer(e);
      boxDownPointerId = e.pointerId;
      boxDownWorldPos = world;
      boxDownScreenPos = { x: e.clientX, y: e.clientY };
      boxDragCurrentWorldPos = world;
      boxDragMoved = false;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (mode.kind === "paste") {
      placePasteGhost(e);
      return;
    }

    // Wire mode: a click on an entity is a wire pick, never a pan or an
    // "open the building" select. Reported on press rather than deferred to
    // release like a select, because there is no click-vs-drag ambiguity to
    // resolve — wire mode does not pan. A click that misses every entity is
    // swallowed deliberately: it neither cancels the pending pick nor drags
    // the camera, so a stray click into empty space cannot silently discard
    // a half-finished connection.
    if (mode.kind === "wire") {
      const world = worldAtPointer(e);
      const hit = spatialIndex.hitTest(world.x, world.y);
      if (hit !== undefined) wireClickCallback?.(hit, world);
      return;
    }

    // 'idle' mode: always starts a pan, whether the press landed on an
    // entity or empty ground — matches the real game, where you can grab
    // the camera from on top of a building just as freely as from open
    // space. Opening the building is deferred to onPointerUp: it only fires
    // if the whole gesture stayed within CLICK_MOVE_THRESHOLD, i.e. it
    // really was a click and not the start of a drag.
    const world = worldAtPointer(e);
    pendingSelect = spatialIndex.hitTest(world.x, world.y);
    downPointerId = e.pointerId;
    pressMovedPastThreshold = false;
    downScreenPos = { x: e.clientX, y: e.clientY };

    isPanning = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch" && activeTouches.has(e.pointerId)) {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size === 2) {
        const geo = pinchGeometry()!;
        const rect = canvas.getBoundingClientRect();
        if (lastPinchDistance > 0) {
          const factor = geo.distance / lastPinchDistance;
          // zoomAt anchors on the pinch midpoint and clamps to the camera's
          // own zoom limits — same call onWheel makes, just with a
          // frame-to-frame factor instead of a wheel-tick one.
          camera.zoomAt(factor, geo.mid.x - rect.left, geo.mid.y - rect.top, rect.width, rect.height);
        }
        // A genuine two-finger drag (the midpoint itself moving, not just
        // the fingers spreading apart) pans on top of that.
        camera.panByScreenDelta(geo.mid.x - lastPointer.x, geo.mid.y - lastPointer.y);
        lastPinchDistance = geo.distance;
        lastPointer = geo.mid;
        return;
      }
    }
    if (isErasing) {
      eraseAtPointer(e);
    }
    if (mode.kind === "place") {
      ghostWorldPos = worldAtPointer(e);
      shiftHeld = e.shiftKey;
      invalidate(); // the ghost follows the cursor, so the picture changed
      if (isPlacingDrag) {
        if (isRailPlannerItem(mode.entityName)) railDragMoved = true;
        else placeAtGhost();
      }
    }
    if (mode.kind === "paste") {
      ghostWorldPos = worldAtPointer(e); // reuses the same field the single ghost uses
      invalidate();
    }
    if (isBoxMode(mode.kind)) {
      if (boxDownWorldPos) {
        boxDragCurrentWorldPos = worldAtPointer(e);
        if (!boxDragMoved && boxDownScreenPos) {
          const dx = e.clientX - boxDownScreenPos.x;
          const dy = e.clientY - boxDownScreenPos.y;
          if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) boxDragMoved = true;
        }
      }
      // The cursor-mode badge (drawn near lastPointer) follows the cursor
      // even before any drag starts, same as the ghost sprites do.
      lastPointer = { x: e.clientX, y: e.clientY };
      invalidate();
      return; // box-drag modes never pan
    }
    // An armed wire trails to the cursor, so the picture changes on every
    // move even though nothing in the scene itself did.
    if (mode.kind === "wire" && pendingWireFrom !== null) invalidate();
    if (isPanning) {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      camera.panByScreenDelta(dx, dy);
      lastPointer = { x: e.clientX, y: e.clientY };
      if (e.pointerId === downPointerId && !pressMovedPastThreshold) {
        const totalDx = e.clientX - downScreenPos.x;
        const totalDy = e.clientY - downScreenPos.y;
        if (Math.hypot(totalDx, totalDy) > CLICK_MOVE_THRESHOLD) pressMovedPastThreshold = true;
      }
      return;
    }
    // Only reached on a plain hover move (no pan/pinch in progress, which
    // already track lastPointer themselves for their own delta math) —
    // setMode's own "show the ghost immediately at the cursor" needs the
    // actual live mouse position even when nothing else here touches it.
    lastPointer = { x: e.clientX, y: e.clientY };
    onHoverMove?.(e);
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType === "touch" && activeTouches.has(e.pointerId)) {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size < 2) lastPinchDistance = 0;
      if (activeTouches.size === 1) {
        // One finger remains: resume a plain single-finger pan from here,
        // not from wherever that finger started — otherwise the camera would
        // jump by the gap between the pinch's last midpoint and this
        // finger's current position.
        const remaining = [...activeTouches.values()][0]!;
        isPanning = true;
        lastPointer = remaining;
        return;
      }
    }
    if (e.button === 2) {
      isErasing = false;
      return;
    }
    if (isBoxMode(mode.kind)) {
      if (e.pointerId === boxDownPointerId) {
        let hitSet: ReadonlySet<number> = new Set<number>();
        if (boxDragMoved && boxDownWorldPos && boxDragCurrentWorldPos) {
          const left = Math.min(boxDownWorldPos.x, boxDragCurrentWorldPos.x);
          const right = Math.max(boxDownWorldPos.x, boxDragCurrentWorldPos.x);
          const top = Math.min(boxDownWorldPos.y, boxDragCurrentWorldPos.y);
          const bottom = Math.max(boxDownWorldPos.y, boxDragCurrentWorldPos.y);
          hitSet = entitiesInBox(left, top, right, bottom);
        } else if (boxDownWorldPos) {
          const hit = spatialIndex.hitTest(boxDownWorldPos.x, boxDownWorldPos.y);
          if (hit !== undefined) hitSet = new Set([hit]);
        }
        // Acted on immediately — nothing is stored for later. delete stays
        // in deleteBox mode (the callback has no mode-changing side effect
        // here); copy/cut's app-side handlers arm 'paste' themselves via
        // setInteractionMode, same as any other cross-mode transition.
        if (hitSet.size > 0) {
          if (mode.kind === "deleteBox") deleteBoxCallback?.(hitSet);
          else if (mode.kind === "cutBox") cutBoxCallback?.(hitSet);
          else copyBoxCallback?.(hitSet);
        }
        invalidate();
      }
      boxDownPointerId = undefined;
      boxDownWorldPos = undefined;
      boxDownScreenPos = undefined;
      boxDragCurrentWorldPos = undefined;
      boxDragMoved = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      return;
    }
    if (isPlacingDrag && mode.kind === "place" && isRailPlannerItem(mode.entityName)) {
      // A press-drag-release lays the dragged track in one go, and a click
      // with a plan going lays that plan. A cancelled gesture (the browser
      // took the pointer away) lays nothing.
      const cancelled = e.type === "pointercancel";
      const hasPlan = (currentRailPreview()?.pieces.length ?? 0) > 0;
      const laysPlan = !cancelled && hasPlan && (railDragMoved || railPressAnchored);
      if (railPendingPiece && !cancelled) {
        // The start piece goes down with the dragged plan, as one step.
        const preview = laysPlan ? currentRailPreview()! : null;
        railPlaceCallback?.(preview ? [railPendingPiece, ...preview.pieces] : [railPendingPiece], preview?.supports ?? []);
        railAnchor = preview ? preview.end : null;
      } else if (laysPlan) {
        commitRailPreview();
      } else if (railPressOnGround) {
        railAnchor = null;
      }
      railPendingPiece = null;
      railPressOnGround = false;
      railPressAnchored = false;
      invalidate();
    }
    if (isPlacingDrag && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    isPlacingDrag = false;
    railDragMoved = false;
    if (!isPanning) return;
    isPanning = false;
    // The deferred idle-mode click-vs-drag decision (see onPointerDown):
    // only open the entity that was under the cursor at press time if this
    // exact gesture never moved past the threshold — a real drag, even one
    // that started on a building and released back over it, must not pop
    // the building's window open.
    if (e.pointerId === downPointerId && !pressMovedPastThreshold && pendingSelect !== undefined) {
      selectCallback?.(pendingSelect);
    }
    downPointerId = undefined;
    pendingSelect = undefined;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  let hoverCallback: ((entityNumber: number | undefined, e: PointerEvent) => void) | null = null;
  let placeCallback: ((worldX: number, worldY: number, direction: number) => void) | null = null;
  let railPlaceCallback: ((pieces: RailPiece[], supports: RailPiece[]) => void) | null = null;
  let selectCallback: ((entityNumber: number) => void) | null = null;
  let eraseCallback: ((entityNumber: number) => void) | null = null;
  let altRightClickCallback: ((entityNumber: number) => void) | null = null;
  let wireClickCallback: ((entityNumber: number, world: { x: number; y: number }) => void) | null = null;
  let deleteBoxCallback: ((entityNumbers: ReadonlySet<number>) => void) | null = null;
  let cutBoxCallback: ((entityNumbers: ReadonlySet<number>) => void) | null = null;
  let copyBoxCallback: ((entityNumbers: ReadonlySet<number>) => void) | null = null;
  let pasteCallback:
    | ((
        entities: PlacedEntity[],
        wires: WireLink[],
        newAnchor: { x: number; y: number },
        origAnchor: { x: number; y: number },
        groupRotation: 0 | 4 | 8 | 12,
        collisionMode: "block" | "skip" | "replace",
      ) => void)
    | null = null;
  const onHoverMove = (e: PointerEvent) => {
    const world = worldAtPointer(e);
    const hit = spatialIndex.hitTest(world.x, world.y);
    const side = hit === undefined ? 1 : sideAt(hit, world);
    if (hit !== hoveredEntityNumber || side !== hoveredSide) {
      hoveredEntityNumber = hit;
      hoveredSide = side;
      invalidate(); // the highlighted corners moved (or appeared/vanished)
    }
    hoverCallback?.(hit, e);
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

  // WASD camera pan: listens on window (not the canvas) so it works the
  // same way the app layer's own 'r'/'q'/'e' shortcuts do — no need to
  // click/focus the canvas first — and is guarded the same way they are:
  // ignored while a text input has focus, and while any modifier is held
  // (so Cmd+D bookmark, Ctrl+W close-tab, etc. pass through untouched).
  const isTypingTarget = () =>
    document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Shift" && !shiftHeld) {
      shiftHeld = true;
      if (railAnchor) invalidate();
    }
    const key = e.key.toLowerCase();
    if (key !== "w" && key !== "a" && key !== "s" && key !== "d") return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget()) return;
    e.preventDefault();
    heldKeys.add(key);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift" && shiftHeld) {
      shiftHeld = false;
      if (railAnchor) invalidate();
    }
    heldKeys.delete(e.key.toLowerCase());
  };
  // A key can go down, then the window loses focus (alt-tab, DevTools)
  // before its keyup ever fires — without this the camera would pan forever
  // in whatever direction was held at the moment focus was lost.
  const onBlur = () => heldKeys.clear();

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
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  rafHandle = requestAnimationFrame(tick);

  /** Rebuilds the neighbour and spatial indices and preloads sprites. Leaves
   *  the camera alone, so edits never jump the view. */
  function rebuildIndices(newEntities: PlacedEntity[], newWires?: WireLink[]): void {
    entities = newEntities;
    entityById = new Map(entities.map((e) => [e.entityNumber, e]));
    // Undefined means "unchanged" (an edit that only moved entities), an
    // empty array means "this blueprint has no wires" — an edit must not
    // silently drop the wires a load established.
    if (newWires) wires = newWires;
    wireNetwork = buildWireNetwork(wires, entities, isPoleLike);

    // A pole's facing comes from its wires, not from the blueprint, so it is
    // baked onto the entity rather than resolved at each draw. Every consumer
    // below (sprite pick, footprint, spatial index) then sees one consistent
    // facing, and the scene cache — which keys on the entity list, not on the
    // wire list — cannot serve a stale pre-rotation sprite.
    //
    // The rotated pole is a COPY: `entities` is the caller's own array (the
    // app's blueprint state), and turning a pole is a rendering decision, not
    // an edit to the blueprint. Mutating in place would make a pole's stored
    // direction drift every time a wire changed, and that drift would then be
    // written back out on export.
    if (wireNetwork.poleDirection.size > 0) {
      entities = entities.map((entity) => {
        const facing = wireNetwork.poleDirection.get(entity.entityNumber);
        return facing === undefined || facing === entity.direction ? entity : { ...entity, direction: facing };
      });
      entityById = new Map(entities.map((e) => [e.entityNumber, e]));
    }

    resolvedWires = resolveWires(wireNetwork, entities, visualFor, directionOf);
    grid = buildGrid(entities);
    fluidNetwork = buildFluidNetwork(entities, (e) => {
      const points = visualFor(e.name)?.pipeConnections;
      return points && activeFluidConnections(points, e.recipe, data);
    });
    heatNetwork = buildHeatNetwork(entities, (name) => visualFor(name)?.heatConnections);

    const boxes: IndexedBox[] = [];
    platformBoxes = [];
    for (const e of entities) {
      const visual = visualFor(e.name);
      const [w, h] = visual ? effectiveFootprint(visual, e.direction) : FALLBACK_FOOTPRINT;
      const rail = isRail(e.name) ? railHighlightBox(e.name, e.direction) : undefined;
      const box: IndexedBox = {
        entityNumber: e.entityNumber,
        left: e.x - w / 2,
        top: e.y - h / 2,
        right: e.x + w / 2,
        bottom: e.y + h / 2,
        // Track is hovered by the same turned box its brackets draw round,
        // not by its (mostly empty) axis-aligned footprint.
        turned: rail && { cx: e.x + rail.cx, cy: e.y + rail.cy, w: rail.w, h: rail.h, angle: rail.angle },
      };
      boxes.push(box);
      if (connectors.isPlatformLike(e.name)) platformBoxes.push(box);
    }
    spatialIndex = new SpatialIndex(boxes);
    // Any edit changes what the ghost previews against, so drop its cache.
    entitiesVersion++;
    ghostPreviewKey = null;
    sceneCache = null;
    invalidate();

    // Preload every sheet the visible entities reference, so nothing flashes
    // as an outline on first paint.
    for (const e of entities) {
      const visual = visualFor(e.name);
      for (const layer of visual?.graphics?.layers ?? []) {
        const sprites = !("per" in layer)
          ? [layer.sprites]
          : layer.per === "heat-connection-patches"
            ? [...layer.connected, ...layer.disconnected]
            : layer.per === "module-slot"
              ? layer.slots.flatMap((slot) => [slot.empty, ...slot.filled.map((piece) => piece.sprite)])
              : Object.values(layer.sprites);
        for (const sprite of sprites) atlas.get(sprite.sheet);
      }
      const ins = visual?.inserterGraphics;
      if (ins) {
        atlas.get(ins.platform.sheet);
        atlas.get(ins.handBase.sheet);
        atlas.get(ins.handOpen.sheet);
      }
    }
    // A sheet finishing its load changes what the next frame can paint, so
    // mark dirty rather than drawing straight away — the loop picks it up.
    void atlas.whenIdle().then(invalidate);
  }

  function loadBlueprint(newEntities: PlacedEntity[], newWires: WireLink[] = []): void {
    rebuildIndices(newEntities, newWires);
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
      // Alpha is baked into the cached commands, so the scene must be
      // recollected when the highlight changes.
      highlightVersion++;
      invalidate();
    },
    /** Dev-only: freeze/unfreeze the belt animation clock and step it by an
     *  exact frame count, for deterministic frame-by-frame comparison
     *  (e.g. via window.__debug in the app layer) instead of eyeballing a
     *  live 60fps animation. */
    setAnimationFrozen(frozen: boolean) {
      animationFrozen = frozen;
      invalidate();
    },
    stepAnimationFrame(delta = 1) {
      animationFrame = (animationFrame + delta + 1_000_000) % 1_000_000;
      drawAndAccount();
      needsRedraw = false;
    },
    getAnimationFrame() {
      return animationFrame;
    },
    setQuality(next) {
      quality = { ...next };
      resize(); // picks up the new pixel ratio and redraws
    },
    getQuality() {
      return { ...quality };
    },
    setAltMode(enabled) {
      altMode = enabled;
      invalidate();
    },
    setAltModeLayers(layers) {
      altModeLayers = { ...layers };
      invalidate();
    },
    setInteractionMode(newMode) {
      if (newMode.kind !== "paste" || mode.kind !== "paste" || newMode.entities !== mode.entities) relativeSnapOrigin = null;
      if (newMode.kind === "place") {
        // An explicit direction (the 'q' pipette carrying over the picked
        // entity's own facing) always wins; otherwise entering place mode,
        // or switching entity, resets the facing.
        if (newMode.direction !== undefined) {
          ghostDirection = newMode.direction;
        } else if (mode.kind !== "place" || mode.entityName !== newMode.entityName) {
          ghostDirection = 0;
        }
      }
      // Leaving any box-drag mode (including a copy/cut box handing off to
      // 'paste' once it completes) drops an in-progress drag rather than
      // letting a stale box linger into an unrelated mode.
      if (isBoxMode(mode.kind) && !isBoxMode(newMode.kind)) {
        boxDownPointerId = undefined;
        boxDownWorldPos = undefined;
        boxDownScreenPos = undefined;
        boxDragCurrentWorldPos = undefined;
        boxDragMoved = false;
      }
      // A rail plan belongs to the item that started it: putting the item
      // away, or swapping between ground and elevated track, drops it.
      if (newMode.kind !== "place" || mode.kind !== "place" || newMode.entityName !== mode.entityName) {
        railAnchor = null;
        railPendingPiece = null;
      }
      mode = newMode;
      invalidate();
      if (mode.kind !== "place" && mode.kind !== "paste") {
        ghostWorldPos = null;
      } else {
        // Entering place/paste mode (e.g. the 'q' pipette, or a fresh
        // Cmd+C, both of which arm on a keypress rather than a pointer
        // move) needs the ghost to draw at the cursor's current position
        // right away — otherwise it stays invisible until the next actual
        // mousemove recomputes ghostWorldPos, since that's normally the
        // only place this gets set.
        const rect = canvas.getBoundingClientRect();
        ghostWorldPos = camera.screenToWorld(lastPointer.x - rect.left, lastPointer.y - rect.top, rect.width, rect.height);
      }
    },
    rotateGhost(reverse) {
      // Quarter-turn in the 16-way scheme (step 4 of 16) for most entities
      // — matches toCardinal()'s own commitment to 16-way-only (see its doc
      // comment in beltGraph.ts): every direction value this renderer
      // produces is 16-way, since that's the only scheme Factorio 2.0
      // blueprint exports use. A previous 8-way step here (+2 of 8) was
      // inconsistent with that and silently produced directions
      // toCardinal() would then misinterpret. rotationStep gives a finer
      // step (1 of 16) for rail-signal/rail-chain-signal, matching the
      // real game's own 22.5° rotate gesture for those two.
      if (mode.kind !== "place" || isPoleLike(mode.entityName)) return;
      if (isTwoDirectionOnly(mode.entityName)) {
        // Only two facings exist at all (north=0, east=4) — R just
        // toggles between them, `reverse` is a no-op (there's no
        // meaningful "other way" between only two choices).
        ghostDirection = ghostDirection === 0 ? 4 : 0;
        invalidate();
        return;
      }
      const step = rotationStep(mode.entityName);
      ghostDirection = (ghostDirection + (reverse ? -step : step) + 16) % 16;
      invalidate();
    },
    rotatePasteGhost(reverse) {
      if (mode.kind !== "paste") return;
      // Unlike a single pole's own in-place rotate (rotateGhost, which
      // refuses — a lone pole's facing is meaningless, later derived from
      // its wires), rotating a GROUP always turns the whole arrangement:
      // a pole inside the group still orbits to its new position along
      // with everything else, even though its own facing has no visual
      // effect. Only flip (a separate, more restrictive gesture — not yet
      // implemented) is meant to have per-entity eligibility limits; free
      // rotation is unrestricted here by design.
      const delta = reverse ? -4 : 4;
      mode = { ...mode, groupRotation: (((mode.groupRotation + delta) % 16) + 16) % 16 as 0 | 4 | 8 | 12 };
      invalidate();
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
    onPlaceRails(callback) {
      railPlaceCallback = callback;
    },
    cancelRailPlan() {
      if (!railAnchor) return false;
      railAnchor = null;
      railPendingPiece = null;
      invalidate();
      return true;
    },
    onSelect(callback) {
      selectCallback = callback;
    },
    onErase(callback) {
      eraseCallback = callback;
    },
    onAltRightClickEntity(callback) {
      altRightClickCallback = callback;
    },
    onWireClick(callback) {
      wireClickCallback = callback;
    },
    setPendingWire(entityNumber, side = 1) {
      if (pendingWireFrom === entityNumber && pendingWireSide === side) return;
      pendingWireFrom = entityNumber;
      pendingWireSide = side;
      invalidate();
    },
    onDeleteBox(callback) {
      deleteBoxCallback = callback;
    },
    onCutBox(callback) {
      cutBoxCallback = callback;
    },
    onCopyBox(callback) {
      copyBoxCallback = callback;
    },
    onPaste(callback) {
      pasteCallback = callback;
    },
    onLoadingChange(callback) {
      atlas.setOnPendingChange((pending) => callback(pending > 0));
    },
    getVisualLookup() {
      return visualLookup;
    },
    startFrameRecording(seconds = 30) {
      frameLog = [];
      recordingStartedAt = performance.now();
      recordingStopsAt = recordingStartedAt + seconds * 1000;
      // Baseline the skip counter, so the first record reports frames
      // skipped since the recording began rather than since page load.
      skippedAtLastRecord = framesSkipped;
      recording = true;
      // A recording is only interesting if frames are actually being drawn.
      invalidate();
    },
    stopFrameRecording() {
      recording = false;
    },
    isRecording() {
      return recording;
    },
    getFrameLog() {
      return frameLog;
    },
    getEntityCostBreakdown() {
      return entityCosts;
    },
    setEntityAccounting(enabled: boolean) {
      entityAccounting = enabled;
      entityCosts = [];
      // The breakdown is filled during a rebuild, so force one rather than
      // leaving the panel empty until the user happens to pan.
      sceneCache = null;
      invalidate();
    },
    getDebugStats() {
      const avg = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
      const avgFrameMs = avg(frameTimes);
      // performance.memory is a non-standard Chrome extension; every other
      // browser (Safari, Firefox) has no such property at all.
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      return {
        fps: avgFrameMs > 0 ? 1000 / avgFrameMs : 0,
        frameTimeMs: avgFrameMs,
        renderTimeMs: avg(renderTimes),
        totalEntities: entities.length,
        visibleEntities: lastVisibleEntityCount,
        drawCommands: lastDrawCommandCount,
        jsHeapUsedMb: memory ? memory.usedJSHeapSize / (1024 * 1024) : undefined,
        phases: { ...phases },
        sceneRebuilt: sceneRebuiltThisFrame,
        sceneRebuildCount,
        framesDrawn,
        framesSkipped,
        baked: lastFrameBaked,
        bakedLayers: sceneCache?.bakePlan?.bakedCount ?? 0,
        bakeCount,
      };
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
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      atlas.setOnPendingChange(null);
      camera.clearListeners();
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

/** A 2x2-tile checkerboard cell, tiled via CanvasPattern instead of one
 *  fillRect call per visible tile — at the camera's own minimum zoom
 *  (6px/tile, see camera.ts's DEFAULT_LIMITS), a large viewport can have
 *  tens of thousands of tiles on screen at once, which meant drawGrid alone
 *  was doing tens of thousands of fillRect calls every single frame just
 *  for the floor. Built lazily (once, cached) at a fixed 64px-per-tile
 *  resolution — plenty crisp since the pattern is drawn in world-space
 *  tile units via the same ctx transform everything else uses, so it scales
 *  with zoom exactly like the per-tile fills it replaces did. */
let checkerPatternCache: CanvasPattern | null = null;
function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  if (checkerPatternCache) return checkerPatternCache;
  const cellPx = 64;
  const tile = document.createElement("canvas");
  tile.width = cellPx * 2;
  tile.height = cellPx * 2;
  const tileCtx = tile.getContext("2d")!;
  tileCtx.fillStyle = CHECKER_LIGHT;
  tileCtx.fillRect(0, 0, cellPx * 2, cellPx * 2);
  tileCtx.fillStyle = CHECKER_DARK;
  tileCtx.fillRect(cellPx, 0, cellPx, cellPx);
  tileCtx.fillRect(0, cellPx, cellPx, cellPx);
  const pattern = ctx.createPattern(tile, "repeat")!;
  // The pattern's own pixels are cellPx px/tile; scaling it down to 1
  // world-space unit per tile here means drawImage-free `fillRect` calls
  // downstream render it at whatever zoom the current ctx transform is
  // already applying, matching every other world-space draw in this file.
  pattern.setTransform(new DOMMatrix().scale(1 / cellPx));
  checkerPatternCache = pattern;
  return pattern;
}

function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, viewportW: number, viewportH: number): void {
  const topLeft = camera.screenToWorld(0, 0, viewportW, viewportH);
  const bottomRight = camera.screenToWorld(viewportW, viewportH, viewportW, viewportH);
  const startX = Math.floor(topLeft.x);
  const endX = Math.ceil(bottomRight.x);
  const startY = Math.floor(topLeft.y);
  const endY = Math.ceil(bottomRight.y);

  ctx.save();
  ctx.fillStyle = checkerPattern(ctx);
  ctx.fillRect(startX, startY, endX - startX, endY - startY);

  // Chunk boundary every 8 tiles, hidden when zoomed out far enough to be
  // noise.
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
