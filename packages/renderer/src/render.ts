import type { GameData, PlacedEntity, QualityName, RenderCatalog, WireColor, WireLink } from "@factoriotools/engine";
import { Camera } from "./camera.js";
import { getSharedSpriteAtlas } from "./spriteAtlas.js";
import { getSharedIconAtlas } from "./iconAtlas.js";
import { activeFluidConnections, buildVisualLookup, effectiveFootprint, hasAnimatedLayer, isPoleLike, isTwoDirectionOnly, isUndergroundLike, makeConnectorPredicates, rotationStep, type ResolvedVisual } from "./entityLookup.js";
import { drawAltModeOverlay, drawQualityBadge } from "./entityDraw.js";
import { buildGrid, NeighbourGrid } from "./neighbours/grid.js";
import { buildFluidNetwork, FluidNetwork } from "./neighbours/fluid.js";
import { buildHeatNetwork, HeatNetwork } from "./neighbours/heat.js";
import type { PlatformBox } from "./neighbours/platform.js";
import { buildWireNetwork, resolveWires, type ResolvedWire, type WireNetwork } from "./neighbours/wires.js";
import { drawSupplyAreas, drawWires, type SupplyArea } from "./draw/wireDraw.js";
import { collectEntity, type CollectContext } from "./draw/collect.js";
import { paint, paintPlain, drawOutline, type PaintTally } from "./draw/paint.js";
import { compareDrawCommands, type DrawCommand } from "./draw/commands.js";
import { drawInserter } from "./sprites/inserter.js";
import { SpatialIndex, type IndexedBox } from "./spatialIndex.js";

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
  | { kind: "wire"; color: WireColor };

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
  /** Quarter-turns the ghost's facing while in 'place' mode (no-op
   *  otherwise) — what the 'r'/Shift+R keyboard shortcut calls, mirroring
   *  Factorio's own "rotate what you're holding" convention. Uses the
   *  8-way scheme (step 2 of a full turn of 8), matching every other
   *  direction value this renderer produces for freshly-placed entities.
   *  `reverse` turns counter-clockwise (Shift+R) instead of the default
   *  clockwise (R). */
  rotateGhost(reverse?: boolean): void;
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
  onWireClick(callback: (entityNumber: number) => void): void;
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

/** Placement-ghost valid/invalid tint — matches the real game's own
 *  green-means-go, red-means-blocked cursor-item convention. */
const GHOST_VALID_TINT = "#4caf50";
const GHOST_INVALID_TINT = "#e53935";

/** Mounts a self-contained Canvas2D blueprint renderer into `container`,
 *  wiring up Factorio-feel pan/zoom (see camera.ts) and hover hit-testing
 *  (spatialIndex.ts) without any external rendering library. */
export function mountRenderer(container: HTMLElement, data: GameData, catalog: RenderCatalog): BlueprintRenderer {
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
  let grid = new NeighbourGrid();
  let fluidNetwork = new FluidNetwork();
  let heatNetwork = new HeatNetwork();
  let spatialIndex = new SpatialIndex([]);
  let platformBoxes: PlatformBox[] = [];
  let highlight: HighlightRole | null = null;
  let altMode = false;
  let animationFrame = 0;
  let dpr = window.devicePixelRatio || 1;
  let rafHandle = 0;
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
  }
  let sceneCache: SceneCache | null = null;

  let ghostPreviewKey: string | null = null;
  let ghostPreviewGrid: NeighbourGrid | null = null;
  let ghostPreviewFluid: FluidNetwork | null = null;
  let ghostPreviewHeat: HeatNetwork | null = null;
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

  // The camera announces its own pans/zooms rather than every gesture handler
  // remembering to invalidate (see Camera.setOnChange).
  camera.setOnChange(invalidate);
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
    // Setting canvas.width/height also clears the canvas, so the frame must
    // be redrawn whatever else is going on.
    invalidate();
  }

  function visualFor(name: string): ResolvedVisual | undefined {
    return visualLookup.get(name);
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
    const tGrid = performance.now();
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
    phases.grid = performance.now() - tGrid;

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
    if (mode.kind === "place" && ghostWorldPos) {
      const ghostVisual = visualFor(mode.entityName);
      if (ghostVisual) {
        const [gfw, gfh] = effectiveFootprint(ghostVisual, ghostDirection);
        const snapped = { x: snapAxis(ghostWorldPos.x, gfw), y: snapAxis(ghostWorldPos.y, gfh) };
        ghost = {
          entityNumber: -1,
          name: mode.entityName,
          x: snapped.x,
          y: snapped.y,
          direction: ghostDirection,
          quality: mode.quality ?? "normal",
          modules: [],
          filterItems: [],
          // Every underground-belt/loader tier MUST carry a real
          // undergroundType — collect.ts's resolveFrame branches on it being
          // defined at all to pick the entrance/exit structure art over
          // plain belt row/cap art. A freshly-placed one (and this ghost,
          // previewing exactly that) is always the entrance/input half; you
          // only get an output half by placing a second one that pairs with
          // an existing entrance, which the game (and placeEntity, in
          // index.ts) handles by editing an already-placed entity's own
          // type, not by constructing a fresh one as "output".
          undergroundType: isUndergroundLike(mode.entityName) ? "input" : undefined,
        };
        const previewKey = `${entitiesVersion}|${mode.entityName}|${snapped.x},${snapped.y}|${ghostDirection}`;
        if (previewKey !== ghostPreviewKey) {
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
        // A ghost exactly on top of a same-named entity at its own tile is
        // still a valid placement — it rebuilds that entity in place with
        // the ghost's own facing/quality (see index.ts's placeEntity), the
        // same "build over it to reconfigure" move the real game allows.
        // Only that one specific overlap is forgiven: two or more
        // overlapping entities, or one of a different name, still blocks —
        // there's no single existing entity a click there could sensibly
        // rebuild.
        ghostCanPlace =
          overlapping.size === 0 ||
          (overlapping.size === 1 &&
            (() => {
              const only = entityById.get([...overlapping][0]!);
              return only?.name === mode.entityName && only.x === snapped.x && only.y === snapped.y;
            })());
      }
    }

    // Collect every sprite first, then paint them in one globally sorted
    // pass, so no entity's shadow can land on a neighbour drawn before it.
    // Real entities always classify against the placed-only grid, never
    // previewGrid — an already-placed belt must not change how it looks
    // just because a ghost is hovering nearby; only the ghost itself (drawn
    // separately below, against previewGrid) shows the connected preview.
    const procedural: PlacedEntity[] = [];
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
        const [fw, fh] = effectiveFootprint(visual, entity.direction);
        drawOutline(ctx, entity.x, entity.y, fw, fh);
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
      const advanced = Math.floor((animationFrame % sceneCache.animPeriod[i]!) * (columns / sceneCache.animPeriod[i]!));
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

    // Supply areas are an UNDERLAY: the game shows them under the machines
    // they power, so a pole's square never hides what is standing on it.
    // Shown only while a pole is in hand — the ghost's own area plus every
    // placed pole's, which is how the game lets you see coverage gaps and
    // overlap while laying out a run.
    if (supplyAreasVisible()) {
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
    paintPlain(ctx, atlas, commands, paintTally ?? undefined);
    phases.paint = performance.now() - tPaint;

    const tInserters = performance.now();
    for (const entity of procedural) {
      const visual = visualFor(entity.name)!;
      ctx.globalAlpha = alphaFor(entity);
      drawInserter(ctx, atlas, entity, visual.inserterGraphics);
    }
    ctx.globalAlpha = 1;
    phases.inserters = performance.now() - tInserters;
    const tOverlays = performance.now();

    // Wires hang ABOVE the entities they join — a power line crosses over a
    // machine standing between two poles, it does not disappear behind it.
    // Drawn from the resolved list rather than per visible entity so a wire
    // whose far pole is off screen is still drawn to its real endpoint,
    // instead of stopping at the viewport edge.
    drawWires(ctx, resolvedWires, camera.state.pixelsPerTile);

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

    phases.overlays = performance.now() - tOverlays;

    const tGhostDraw = performance.now();
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

    phases.ghost += performance.now() - tGhostDraw;

    ctx.restore();
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
    origin: number[];
    /** How many commands the probed (isolated) entity emitted. The caller
     *  compares this against what the same entity emitted in the real scene:
     *  the indices above only mean anything when the two agree. */
    commandCount: number;
  }
  const animProfiles = new Map<string, AnimProfile>();

  const NO_ANIMATION: AnimProfile = { animated: [], stride: [], period: [], phase0: [], columns: [], origin: [], commandCount: -1 };

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
    // differently, and turbo belts offset alternate tiles by parity.
    const key = `${entity.name}|${entity.direction}|${Math.abs(Math.round(entity.x) + Math.round(entity.y)) % 2}`;
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
    const origin: number[] = [];

    if (!structural) {
      for (let i = 0; i < base.length; i++) {
        // The frame width is the smallest positive sx step the command takes
        // across the cycle. Reading it from the samples rather than from the
        // sprite keeps this independent of how the layer was described.
        let width = 0;
        for (let frame = 0; frame < samples.length; frame++) {
          const delta = samples[frame]![i]!.sx - (frame === 0 ? base[i]!.sx : samples[frame - 1]![i]!.sx);
          if (delta > 0 && (width === 0 || delta < width)) width = delta;
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

        // Frames advance one column per `slowdown` ticks, so the sheet may
        // hold more columns than the cycle has distinct steps only when
        // slowdown is 1; otherwise columns === cycle / slowdown. Derive the
        // column count from the widest sx actually reached.
        let high = base[i]!.sx;
        for (let frame = 0; frame < cycle; frame++) high = Math.max(high, samples[frame]![i]!.sx);
        const columns = (high - low) / width + 1;

        // Accept only an exact wrapping ramp with nothing else moving;
        // anything else stays on its frame-0 art rather than risking wrong
        // sprites. `step` is how many columns one tick advances, which is
        // 1/slowdown of a column — expressed as cycle/columns so it stays
        // integral.
        const perTick = columns / cycle;
        let matches = true;
        for (let frame = 1; frame <= samples.length && matches; frame++) {
          const sample = samples[frame - 1]![i]!;
          const column = (startPhase + Math.floor(frame * perTick)) % columns;
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
        origin.push(low);
      }
    }

    return { animated, stride, period, phase0, columns: columnCount, origin, commandCount: base.length };
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

    // Collect entity by entity so each command's index is known while its
    // profile is still in hand; the sort afterwards moves them, so the
    // recorded indices are remapped below.
    const preSort: { command: DrawCommand; stride: number; period: number; columns: number; phase0: number; origin: number }[] = [];
    // Only allocated when the panel asked for it — see setEntityAccounting.
    const costByName = entityAccounting ? new Map<string, EntityCost>() : null;
    for (const entity of visibleEntities) {
      const visual = visualFor(entity.name);
      if (!visual?.graphics || visual.inserterGraphics) continue;
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
    }

    if (costByName) {
      entityCosts = [...costByName.values()].sort((a, b) => b.collectMs - a.collectMs);
    }

    return { key, commands, animated, animOrigin, animStride, animPeriod, animPhase0, animColumns };
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
    if (!animationFrozen && animatedVisibleCount > 0) {
      animationFrame = (animationFrame + 1) % 1_000_000;
      needsRedraw = true;
    }
    applyKeyboardPan(16); // pans through the camera, which invalidates itself
    if (needsRedraw) {
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
      placeAtGhost();
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
      if (hit !== undefined) wireClickCallback?.(hit);
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
      invalidate(); // the ghost follows the cursor, so the picture changed
      if (isPlacingDrag) placeAtGhost();
    }
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
    isPlacingDrag = false;
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
  let selectCallback: ((entityNumber: number) => void) | null = null;
  let eraseCallback: ((entityNumber: number) => void) | null = null;
  let altRightClickCallback: ((entityNumber: number) => void) | null = null;
  let wireClickCallback: ((entityNumber: number) => void) | null = null;
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

  // WASD camera pan: listens on window (not the canvas) so it works the
  // same way the app layer's own 'r'/'q'/'e' shortcuts do — no need to
  // click/focus the canvas first — and is guarded the same way they are:
  // ignored while a text input has focus, and while any modifier is held
  // (so Cmd+D bookmark, Ctrl+W close-tab, etc. pass through untouched).
  const isTypingTarget = () =>
    document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key !== "w" && key !== "a" && key !== "s" && key !== "d") return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget()) return;
    e.preventDefault();
    heldKeys.add(key);
  };
  const onKeyUp = (e: KeyboardEvent) => {
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
      const box = {
        entityNumber: e.entityNumber,
        left: e.x - w / 2,
        top: e.y - h / 2,
        right: e.x + w / 2,
        bottom: e.y + h / 2,
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
              ? layer.slots.flatMap((slot) => [slot.empty, ...slot.filled])
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
    setAltMode(enabled) {
      altMode = enabled;
      invalidate();
    },
    setInteractionMode(newMode) {
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
      mode = newMode;
      invalidate();
      if (mode.kind !== "place") {
        ghostWorldPos = null;
      } else {
        // Entering place mode (e.g. the 'q' pipette, which fires on a
        // keypress rather than a pointer move) needs the ghost to draw at
        // the cursor's current position right away — otherwise it stays
        // invisible until the next actual mousemove recomputes
        // ghostWorldPos, since that's normally the only place this gets set.
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
    onAltRightClickEntity(callback) {
      altRightClickCallback = callback;
    },
    onWireClick(callback) {
      wireClickCallback = callback;
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
      camera.setOnChange(null);
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
