/** Per-EntityGraphics-kind draw strategies, one class per real Factorio
 *  sprite-composition pattern rather than one function per building. Before
 *  this file, entityDraw.ts had one hand-written draw function per
 *  EntityGraphics `kind` — reasonable when there were 2-3 kinds, but poles
 *  (a plain Sprite4WayGraphics, just with directionCount 4) and splitters
 *  (a genuinely new composite) both landing in that same flat function list
 *  made it hard to see which entities actually share a rendering strategy
 *  and which are one-offs. This file groups by strategy instead:
 *   - Sprite4WayRenderer: one main sprite (+ optional shadow), directional
 *     or not — covers ordinary machines, chests, walls' `single` fallback,
 *     AND every pole (poles are not a special case, just a
 *     Sprite4WayGraphics with directionCount 4 — see its own doc comment).
 *   - LayeredStaticRenderer: several always-drawn static layers stacked in
 *     order — beacons, electromagnetic-plant-style machines.
 *   - ConnectionArtRenderer: neighbor-classified connection art — pipes
 *     today; the shape any future entity whose sprite depends on which
 *     sides its neighbors connect on (walls, heat-pipes, rails) would slot
 *     into, by providing its own NeighborClassifier (see pipeGraph.ts's
 *     classifyPipe for the shape one takes).
 *   - BeltRenderer / UndergroundBeltRenderer / SplitterRenderer: belts'
 *     family is its own thing (animation-cycle art, connection-shape
 *     dependent on neighbors like ConnectionArtRenderer but keyed by a
 *     facing-relative left/right test rather than a raw neighbor bitmask,
 *     see beltGraph.ts) — kept separate from ConnectionArtRenderer rather
 *     than forced into the same shape, since unifying them would mean
 *     giving pipes a left/right-relative classifier they don't need or
 *     giving belts a bitmask lookup they don't have sprites for.
 *   - InserterRenderer: procedural (no EntityGraphics at all, drawn from
 *     PlacedEntity + InserterGraphics directly).
 *  Each class owns exactly the draw logic its own sprite-composition needs;
 *  drawEntity() at the bottom of entityDraw.ts dispatches to whichever
 *  instance matches the resolved visual, via ENTITY_RENDERERS below. */
import type { PlacedEntity, SpriteLayer } from "@factoriotools/engine";
import { effectiveFootprint, type ResolvedVisual } from "./entityLookup.js";
import type { SpriteAtlas } from "./spriteAtlas.js";
import { classifyBelt, toCardinal, opposite, STRAIGHT_ROW, Dir4, type BeltLookupEntity, type BeltFrame } from "./beltGraph.js";
import { classifyPipe, type PipeLookupEntity, type PipeVariant } from "./pipeGraph.js";

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  atlas: SpriteAtlas;
  /** World-to-screen, already applied as a ctx transform by the caller —
   *  draw calls here work directly in world (tile) units. */
  animationFrame: number;
}

/** Everything a renderer might need beyond the base DrawContext — the two
 *  neighbor-lookup indices belt/pipe classification reads, plus
 *  beltFrameCache/pipeVariantCache (see buildBeltFrameCache in
 *  beltGraph.ts and buildPipeVariantCache in pipeGraph.ts): each
 *  classification precomputed once per rebuildIndices call rather than
 *  re-run every frame for every visible belt/pipe, since the neighbor
 *  structure they depend on only changes when entities are placed/removed/
 *  rotated. Renderers that don't need any of these (most of them) simply
 *  ignore the fields; passing one bag of context rather than threading
 *  optional parameters through every class's draw() keeps the shared
 *  EntityRenderer interface uniform. */
export interface RenderContext extends DrawContext {
  positionIndex: Map<string, BeltLookupEntity>;
  pipePositionIndex: Map<string, PipeLookupEntity>;
  beltFrameCache: Map<number, BeltFrame>;
  pipeVariantCache: Map<number, PipeVariant>;
}

/** One rendering strategy for one family of EntityGraphics `kind`s. Every
 *  concrete renderer below draws at world position (x,y) — dispatch (`kind`
 *  matching, falling back to the outline box on missing/unloaded sprites)
 *  is each renderer's own responsibility, not centralised, since what
 *  counts as "this renderer's kind" varies (some match one `kind`, belts
 *  match `isBeltLike` AND `kind`, inserters match `isInserter` with no
 *  `kind` check at all — see ENTITY_RENDERERS' selection logic in
 *  entityDraw.ts). */
export interface EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void;
}

/** Factorio's base resolution is 32px/tile at scale 1.0; every sprite's
 *  on-screen tile size is its pixel size * its own scale / 32 (confirmed
 *  against assembling-machine-2's own scale-0.5 sprite sizing — a flat
 *  footprint-based fudge badly mis-sized poles and beacons before this). */
export const BASE_PIXELS_PER_TILE = 32;

/** Fallback when no sprite is available yet (still loading) or the entity
 *  has no graphics data at all — an outline box. Shared by every renderer
 *  below rather than each reimplementing it. */
export function drawOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tint: string): void {
  ctx.save();
  ctx.strokeStyle = tint;
  ctx.lineWidth = 0.06;
  ctx.strokeRect(x - w / 2 + 0.05, y - h / 2 + 0.05, w - 0.1, h - 0.1);
  ctx.restore();
}

/** Draws one SpriteLayer (main sprite, shadow, or an extra always-drawn
 *  layer — every EntityGraphics variant is ultimately composed of these)
 *  at world position (x,y), applying its own shift/scale and, for
 *  direction-indexed sheets, picking the column matching `direction`.
 *  `direction` is omitted for layers that never rotate (shadows, beacon's
 *  top piece, a state-machine's idle body) — those always draw column 0.
 *  Centralizing this here (rather than duplicating the shift/scale/column
 *  math per draw function) is what makes LayeredStaticGraphics' multi-layer
 *  composition trivial: it's just calling this once per layer in draw
 *  order, and what every renderer below reaches for instead of hand-rolling
 *  its own drawImage math. */
export function drawLayer(dc: DrawContext, layer: SpriteLayer, x: number, y: number, direction?: number): void {
  const img = dc.atlas.get(layer.sheet);
  if (!img) return;
  const frameW = layer.frameWidth || img.width;
  const frameH = layer.frameHeight || img.height;
  let srcX = 0;
  const directionCount = layer.directionCount ?? 1;
  if (direction !== undefined && directionCount > 1) {
    const cardinal = toCardinal(direction);
    const column = Math.round(cardinal / 4) % directionCount;
    srcX = column * frameW;
  }
  // direction===undefined (static/animated-in-place layers) always draws
  // frame (0,0) — the same static pose the game's own blueprint/ghost
  // preview shows rather than a live animation.
  const scale = layer.scale ?? 1;
  const drawW = (frameW * scale) / BASE_PIXELS_PER_TILE;
  const drawH = (frameH * scale) / BASE_PIXELS_PER_TILE;
  const [shiftX, shiftY] = layer.shift ?? [0, 0];
  const cx = x + shiftX;
  const cy = y + shiftY;
  dc.ctx.drawImage(img, srcX, 0, frameW, frameH, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
}

/** The common case (Sprite4WayGraphics): shadow first (if present), then
 *  the main frame — `directionCount > 1` means one column per facing
 *  (poles: 4 columns, single row — a pole is NOT a special case here, just
 *  a Sprite4WayGraphics whose directionCount happens to be 4 like any other
 *  genuinely directional single-sprite entity) — `entity.direction` picks
 *  the column; `directionCount === 1` with `lineLength > 1` means an
 *  animation-cycle grid (assemblers: frame_count/line_length rows x
 *  columns), always drawn at frame (0,0) (these entities don't visually
 *  rotate). Covers the large majority of entity kinds: machines, chests,
 *  poles, and (today) walls' `single` no-neighbors fallback. */
export class Sprite4WayRenderer implements EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = visual.tileFootprint;
    if (!graphics || (graphics.kind !== "sprite-4way" && graphics.kind !== "static") || !rc.atlas.get(graphics.sheet)) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }
    if (graphics.shadow) drawLayer(rc, graphics.shadow, x, y);
    drawLayer(rc, graphics, x, y, entity.direction);
  }
}

/** LayeredStaticGraphics: shadow, then the base plate, then every extra
 *  always-drawn layer in order — beacons (base pad + top/spike layer) and
 *  electromagnetic-plant-style newer machines (base plate + the
 *  working_visualisations "idle" body) both compose this way. None of these
 *  layers rotate with the entity's own direction (confirmed by spike:
 *  beacons/these machines don't visually rotate at all), so no direction is
 *  passed to drawLayer here. */
export class LayeredStaticRenderer implements EntityRenderer {
  draw(rc: RenderContext, _entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = visual.tileFootprint;
    if (!graphics || graphics.kind !== "layered-static" || !rc.atlas.get(graphics.base.sheet)) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }
    if (graphics.shadow) drawLayer(rc, graphics.shadow, x, y);
    drawLayer(rc, graphics.base, x, y);
    for (const layer of graphics.layers) drawLayer(rc, layer, x, y);
  }
}

const GATE_SLOT: Record<Dir4, "north" | "east" | "south" | "west"> = {
  [Dir4.North]: "north",
  [Dir4.East]: "east",
  [Dir4.South]: "south",
  [Dir4.West]: "west",
};

/** GateGraphics: picks its sprite+shadow pair by facing (see
 *  DirectionalSpriteSet's own doc comment in types.ts for why gates need 4
 *  file-per-direction slots rather than SpriteLayer's directionCount
 *  columns — north/south alias the same vertical file, east/west alias the
 *  same horizontal one), then draws shadow-then-sprite like
 *  Sprite4WayRenderer does, at frame (0,0) — the closed resting pose, no
 *  live open/close animation. */
export class GateRenderer implements EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = visual.tileFootprint;
    if (!graphics || graphics.kind !== "gate") {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }
    const slot = GATE_SLOT[toCardinal(entity.direction)];
    const sprite = graphics.sprites[slot];
    const shadow = graphics.shadows[slot];
    if (!rc.atlas.get(sprite.sheet)) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }
    drawLayer(rc, shadow, x, y);
    drawLayer(rc, sprite, x, y);
  }
}

/** Something that can classify one tile's connection shape from its 4
 *  immediate neighbors, keyed by an opaque variant id — pipeGraph.ts's
 *  classifyPipe today, and the shape any future ConnectionArtRenderer user
 *  (walls, heat-pipes, rails) would implement to plug into this same
 *  renderer rather than hand-rolling another neighbor-inspection draw
 *  function. Decoupled from ConnectionArtGraphics' own `connectors` map
 *  shape only by the variant id both sides agree on. */
export interface NeighborClassifier<TVariant extends string> {
  classify(entity: PlacedEntity, rc: RenderContext): TVariant;
}

/** Neighbor-aware connection art: picks the connector variant matching this
 *  entity's actual neighbors (via the supplied NeighborClassifier) and
 *  draws that one sprite. Used for pipes today — no shadow (confirmed by
 *  spike pipes cast none in the real game) and no direction dispatch (a
 *  pipe's own `direction` is meaningless; its shape is entirely determined
 *  by what it's connected to).
 *
 *  Generic over the classifier, but NOT a drop-in fit for walls: walls use
 *  a smaller sprite set with runtime rotation instead of one file per
 *  neighbor combination (confirmed by spike against data.raw.wall.stone-wall),
 *  so pipeGraph.ts's own bitmask-to-filename lookup doesn't cover them —
 *  a wall renderer would need its own classifier AND its own
 *  connectors-resolution shape, not just a classifier plugged in here. */
export class ConnectionArtRenderer<TVariant extends string> implements EntityRenderer {
  constructor(
    private readonly classifier: NeighborClassifier<TVariant>,
    private readonly fallbackVariant: TVariant,
  ) {}

  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = visual.tileFootprint;
    if (!graphics || graphics.kind !== "pipe") {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.28)");
      return;
    }
    const variant = this.classifier.classify(entity, rc);
    const layer = graphics.connectors[variant] ?? graphics.connectors[this.fallbackVariant] ?? Object.values(graphics.connectors)[0];
    if (!layer || !rc.atlas.get(layer.sheet)) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.28)");
      return;
    }
    drawLayer(rc, layer, x, y);
  }
}

/** pipeGraph.ts's classifyPipe wrapped as a NeighborClassifier, so
 *  ConnectionArtRenderer can be constructed with it instead of hand-calling
 *  classifyPipe from a one-off drawPipe function. Reads
 *  buildPipeVariantCache's precomputed result first (see that function's
 *  own doc comment for why), falling back to a live classify only for the
 *  placement ghost (entityNumber -1, never indexed). */
class PipeClassifier implements NeighborClassifier<string> {
  classify(entity: PlacedEntity, rc: RenderContext): string {
    return rc.pipeVariantCache.get(entity.entityNumber) ?? classifyPipe({ x: Math.round(entity.x), y: Math.round(entity.y) }, rc.pipePositionIndex);
  }
}

export const pipeRenderer = new ConnectionArtRenderer(new PipeClassifier(), "straight_vertical_single");

/** Underground belts share Sprite4WayRenderer's column-per-facing
 *  convention (directionCount 4, one column per cardinal — confirmed by
 *  spike this sheet uses the exact same layout poles do) but ALSO need a
 *  row pick that shape has no concept of: entrance vs. exit is a genuinely
 *  separate axis from facing (PlacedEntity.undergroundType, from the
 *  blueprint's own `type` field — two undergrounds can share a direction
 *  while one is an entrance and the other an exit), packed as two rows in
 *  the same sheet. Falls back to the exit row for a legacy/malformed entity
 *  with no undergroundType rather than refusing to draw. Kept as its own
 *  renderer rather than folded into Sprite4WayRenderer since that row pick
 *  has no equivalent there — forcing it in would mean every other
 *  Sprite4Way entity carrying dead undergroundType-handling code. */
export class UndergroundBeltRenderer implements EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = visual.tileFootprint;
    if (!graphics || graphics.kind !== "underground") {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }
    const img = rc.atlas.get(graphics.sheet);
    if (!img) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.45)");
      return;
    }

    const frameW = graphics.frameWidth || img.width;
    const frameH = graphics.frameHeight || img.height;
    // Factorio's blueprint format encodes an underground pair's OUTPUT half
    // with `direction` pointing back toward the entrance (confirmed by
    // spike against a real N/S pair: the input reads direction 0/North,
    // its paired output reads direction 8/South, even though both ends
    // visually carry items flowing the same way, north) — the exit's own
    // sprite column must be picked from the OPPOSITE cardinal to show it
    // facing the same way the belt actually flows, or it renders backwards
    // (the originally-reported "the output end is rendered wrong" bug,
    // which looked like it needed a 180-degree flip because it did).
    const facing = entity.undergroundType === "output" ? opposite(toCardinal(entity.direction)) : toCardinal(entity.direction);
    const column = Math.round(facing / 4) % Math.max(graphics.directionCount ?? 1, 1);
    const row = entity.undergroundType === "input" ? (graphics.undergroundInRow ?? 1) : (graphics.undergroundOutRow ?? 0);

    const scale = graphics.scale ?? 1;
    const drawW = (frameW * scale) / BASE_PIXELS_PER_TILE;
    const drawH = (frameH * scale) / BASE_PIXELS_PER_TILE;
    rc.ctx.drawImage(img, column * frameW, row * frameH, frameW, frameH, x - drawW / 2, y - drawH / 2, drawW, drawH);
  }
}

/** Belts pack every connection variant (straight/curved/side-loading) into
 *  one sheet as 20 fixed rows (beltGraph.ts's own classifyBelt picks the
 *  row from the belt's neighbors, a facing-relative left/right test rather
 *  than ConnectionArtRenderer's raw neighbor bitmask — belts and pipes
 *  don't share a classifier shape, so belts get their own renderer instead
 *  of being squeezed into ConnectionArtRenderer). */
export class BeltRenderer implements EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    if (!graphics || graphics.kind !== "belt") {
      drawOutline(rc.ctx, x, y, 1, 1, "rgba(230,221,206,0.28)");
      return;
    }
    const img = rc.atlas.get(graphics.sheet);
    if (!img) {
      drawOutline(rc.ctx, x, y, 1, 1, "rgba(230,221,206,0.28)");
      return;
    }
    // The cache (buildBeltFrameCache) covers every real placed belt; a
    // cache miss only happens for the placement ghost (entityNumber -1,
    // never indexed since it isn't part of the loaded blueprint), which
    // falls back to classifying live against its own would-be position.
    const cached = rc.beltFrameCache.get(entity.entityNumber);
    const { row, overlayRow } = cached ?? classifyBelt(
      { entityNumber: entity.entityNumber, name: entity.name, x: Math.round(entity.x), y: Math.round(entity.y), direction: entity.direction, isBeltLike: true },
      rc.positionIndex,
    );
    // graphics.lineLength carries the belt tier's real animation-cycle
    // column count here (16/32/32/64 for yellow/red/blue/turbo, confirmed
    // by spike — faster belts get more frames for smoother motion), not a
    // fixed 16.
    const frameCount = Math.max(1, graphics.lineLength ?? 1);
    const frameW = graphics.frameWidth || img.width / frameCount;
    const frameH = graphics.frameHeight || img.height / 20;
    const col = rc.animationFrame % frameCount;
    // Belt frames are drawn at their real pixel-to-tile scale (128px @
    // scale 0.5 -> 2x2 tiles for fast-transport-belt, confirmed against the
    // dump), NOT a hardcoded 1x1 box — a belt tile's own selection_box is
    // 1x1, but its animation art deliberately overhangs into neighboring
    // tiles so adjacent belts visually blend into one continuous flowing
    // strip instead of showing seams at tile boundaries.
    const scale = graphics.scale ?? 1;
    const drawW = (frameW * scale) / BASE_PIXELS_PER_TILE;
    const drawH = (frameH * scale) / BASE_PIXELS_PER_TILE;
    rc.ctx.drawImage(img, col * frameW, row * frameH, frameW, frameH, x - drawW / 2, y - drawH / 2, drawW, drawH);

    // Side-load rows (12-19) are a thin merge-chevron decal, not a full
    // belt sprite (confirmed by spike, see BeltFrame's own doc comment) —
    // drawn on top of the straight belt frame just painted above, using
    // the same frame geometry (same sheet, same per-frame size).
    if (overlayRow !== undefined) {
      rc.ctx.drawImage(img, col * frameW, overlayRow * frameH, frameW, frameH, x - drawW / 2, y - drawH / 2, drawW, drawH);
    }
  }
}

const SPLITTER_BODY_LAYER: Record<Dir4, "north" | "east" | "south" | "west"> = {
  [Dir4.North]: "north",
  [Dir4.East]: "east",
  [Dir4.South]: "south",
  [Dir4.West]: "west",
};

/** Splitters composite three pieces (confirmed by spike against the real
 *  dump, see SplitterGraphics' own doc comment in types.ts): two belt-lane
 *  animations side by side underneath the body, drawn exactly like a plain
 *  straight belt (a splitter itself never curves/side-loads, so its own
 *  facing's STRAIGHT_ROW is always right — no neighbor classification
 *  needed the way BeltRenderer's classifyBelt call is for plain belts),
 *  then the visible splitter body/case on top (picked by facing from 4
 *  independent whole-file animations, not columns in one shared sheet —
 *  every other direction-indexed layer this renderer draws packs facings as
 *  sheet columns, splitters don't), then east/west's own structurePatch
 *  filling the gap their shorter structure sprite leaves. */
export class SplitterRenderer implements EntityRenderer {
  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const graphics = visual.graphics;
    const [w, h] = effectiveFootprint(visual, entity.direction);
    if (!graphics || graphics.kind !== "splitter") {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.28)");
      return;
    }

    const beltImg = rc.atlas.get(graphics.belt.sheet);
    const facing = toCardinal(entity.direction);
    const bodyLayer = graphics.body[SPLITTER_BODY_LAYER[facing]];
    const bodyImg = rc.atlas.get(bodyLayer.sheet);
    if (!beltImg || !bodyImg) {
      drawOutline(rc.ctx, x, y, w, h, "rgba(230,221,206,0.28)");
      return;
    }

    const beltFrameCount = Math.max(1, graphics.belt.lineLength ?? 1);
    const beltFrameW = graphics.belt.frameWidth || beltImg.width / beltFrameCount;
    const beltFrameH = graphics.belt.frameHeight || beltImg.height / 20;
    const beltCol = rc.animationFrame % beltFrameCount;
    const beltRow = STRAIGHT_ROW[facing];
    const beltScale = graphics.belt.scale ?? 1;
    const beltDrawW = (beltFrameW * beltScale) / BASE_PIXELS_PER_TILE;
    const beltDrawH = (beltFrameH * beltScale) / BASE_PIXELS_PER_TILE;
    // A splitter is two side-by-side belt lanes, each a full belt tile of
    // its own (confirmed by spike against the real collision_box: 1.8
    // tiles across, i.e. two ~1-tile lanes plus a hair of shared frame) —
    // not one belt stretched/centered across the whole footprint. The lane
    // offset runs perpendicular to the direction of travel: across X for a
    // north/south splitter, across Y for east/west.
    const LANE_OFFSET = 0.5;
    const [laneDx, laneDy] = facing === Dir4.North || facing === Dir4.South ? [LANE_OFFSET, 0] : [0, LANE_OFFSET];
    for (const sign of [-1, 1]) {
      const laneX = x + sign * laneDx;
      const laneY = y + sign * laneDy;
      rc.ctx.drawImage(
        beltImg,
        beltCol * beltFrameW, beltRow * beltFrameH, beltFrameW, beltFrameH,
        laneX - beltDrawW / 2, laneY - beltDrawH / 2, beltDrawW, beltDrawH,
      );
    }

    // Drawn directly rather than via drawLayer: the body sheet is its own
    // animation-cycle grid (frame_count/line_length, confirmed by spike —
    // the same shape as an assembler's idle animation, not a
    // direction-column layout drawLayer knows how to slice), and frame
    // (0,0) is the static pose to show, matching this pipeline's existing
    // "no live animation for per-direction whole-file sprites" convention.
    const drawBodyLayer = (layer: SpriteLayer, img: HTMLImageElement) => {
      const frameW = layer.frameWidth || img.width;
      const frameH = layer.frameHeight || img.height;
      const scale = layer.scale ?? 1;
      const drawW = (frameW * scale) / BASE_PIXELS_PER_TILE;
      const drawH = (frameH * scale) / BASE_PIXELS_PER_TILE;
      const [shiftX, shiftY] = layer.shift ?? [0, 0];
      rc.ctx.drawImage(img, 0, 0, frameW, frameH, x + shiftX - drawW / 2, y + shiftY - drawH / 2, drawW, drawH);
    };

    // East/west's own `structure` sprite (unlike north/south's) is shorter
    // than the splitter's real 1.8-tile length — confirmed by spike against
    // the real dump, see SplitterGraphics' own doc comment in types.ts —
    // `structurePatch` is the real, non-empty second sprite that fills in
    // the remainder. Drawn FIRST, underneath `structure`: both sprites
    // carry their own baked-in drop shadow (confirmed by spike opening both
    // PNGs directly), and the two overlap in the middle of the splitter, so
    // whichever is drawn second paints its shadow over the other's body —
    // drawing the patch first means `structure`'s own shadow/body (the
    // piece nearer the viewer along the direction of travel) wins that
    // overlap, matching the real game's layering instead of the patch's
    // shadow incorrectly sitting on top of the main body (the originally-
    // reported "shadow from the top half sits over the bottom half" bug).
    // Undefined for north/south, whose own patch really is empty.png
    // (filtered out already in render-catalog.ts's mapper).
    if (bodyLayer.structurePatch) {
      const patchImg = rc.atlas.get(bodyLayer.structurePatch.sheet);
      if (patchImg) drawBodyLayer(bodyLayer.structurePatch, patchImg);
    }

    drawBodyLayer(bodyLayer, bodyImg);
  }
}

/** Inserters are procedurally drawn in the real game (platform + a hand that
 *  swings through pickup -> insert each cycle) — confirmed by spike, no
 *  direction-indexed sheet exists at all. This draws a fixed pose instead of
 *  the animation: the platform (direction-agnostic, single static sprite)
 *  plus the hand-base and open-claw sprites rotated to point from the
 *  entity's center toward its drop side, matching the general silhouette
 *  the game's own blueprint/ghost preview shows for a stationary inserter.
 *  Has no EntityGraphics `kind` at all — dispatches on `visual.isInserter`
 *  instead (see ENTITY_RENDERERS in entityDraw.ts), reading
 *  visual.inserterGraphics directly. */
export class InserterRenderer implements EntityRenderer {
  // Confirmed by spike against the real dump: every inserter's insert
  // position is [0,1.2] in its own north-facing local space — 1.2 tiles in
  // front of the entity center. hand_base pivots at the center itself (not
  // at the pickup tile), so only the insert distance is needed to size the
  // resting fully-extended arm.
  private static readonly INSERT_DISTANCE = 1.2;

  draw(rc: RenderContext, entity: PlacedEntity, visual: ResolvedVisual, x: number, y: number): void {
    const g = visual.inserterGraphics;
    if (!g) {
      drawOutline(rc.ctx, x, y, 1, 1, "rgba(230,221,206,0.45)");
      return;
    }
    const platform = rc.atlas.get(g.platformSheet);
    const handBase = rc.atlas.get(g.handBaseSheet);
    const handOpen = rc.atlas.get(g.handOpenSheet);
    if (!platform || !handBase || !handOpen) {
      drawOutline(rc.ctx, x, y, 1, 1, "rgba(230,221,206,0.45)");
      return;
    }

    // The platform sheet packs `platformDirections` facings side by side
    // (confirmed by spike: 420px wide = 4 * the dump's declared 105px
    // per-frame width, with no direction_count field to say so explicitly)
    // — slice the column matching this entity's own facing instead of
    // drawing the whole strip.
    const cardinal = toCardinal(entity.direction);
    const platformCol = Math.round(cardinal / 4) % g.platformDirections;
    const platformW = (g.platformWidth * g.platformScale) / BASE_PIXELS_PER_TILE;
    const platformH = (g.platformHeight * g.platformScale) / BASE_PIXELS_PER_TILE;
    rc.ctx.drawImage(
      platform,
      platformCol * g.platformWidth, 0, g.platformWidth, g.platformHeight,
      x - platformW / 2, y - platformH / 2, platformW, platformH,
    );

    // toCardinal's quarter-turn scheme gives the drop-side direction as a
    // rotation angle, pivoting at the entity's own center; the hand always
    // points toward the drop (insert) side in this resting pose.
    const angle = (cardinal / 16) * 2 * Math.PI; // 0=N(-Y), 4=E, 8=S, 12=W

    rc.ctx.save();
    rc.ctx.translate(x, y);
    rc.ctx.rotate(angle);

    // Confirmed by looking at the actual extracted PNGs (not just field
    // names): hand_base shows an eyelet at the image TOP (the pivot bolted
    // to the entity's own center) with its shaft running DOWN from it
    // toward the claw — so top=near/pivot (y=0), bottom=far/reaching
    // (toward insert). hand_open shows the claw fork at the image TOP with
    // a short shaft stub below it that slides along hand_base — so
    // top=far/claw (at the insert point), bottom=near (toward the pivot).
    // Both sprites are drawn in their natural (non-flipped) orientation,
    // just anchored at opposite ends: hand_base's top pinned to center,
    // hand_open's top pinned to the insert point.
    const baseW = (g.handBaseWidth * g.handBaseScale) / BASE_PIXELS_PER_TILE;
    const baseSpan = Math.max((g.handBaseHeight * g.handBaseScale) / BASE_PIXELS_PER_TILE, InserterRenderer.INSERT_DISTANCE);
    rc.ctx.drawImage(handBase, -baseW / 2, 0, baseW, baseSpan);

    const openW = (g.handOpenWidth * g.handOpenScale) / BASE_PIXELS_PER_TILE;
    const openH = (g.handOpenHeight * g.handOpenScale) / BASE_PIXELS_PER_TILE;
    rc.ctx.drawImage(handOpen, -openW / 2, InserterRenderer.INSERT_DISTANCE - openH, openW, openH);
    rc.ctx.restore();
  }
}
