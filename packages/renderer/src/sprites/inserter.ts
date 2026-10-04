import type { InserterGraphics, PlacedEntity } from "@factoriotools/engine";
import type { SpriteAtlas, SpriteSurface } from "../spriteAtlas.js";
import { step, toCardinal, type Cardinal } from "../neighbours/grid.js";
import { PIXELS_PER_TILE } from "../draw/commands.js";
import { drawOutline, TINT_ALPHA } from "../draw/paint.js";

const tiles = (pixels: number, scale = 1) => (pixels * scale) / PIXELS_PER_TILE;

/** The arm is two static sprites — handBase from the pivot to the elbow,
 *  handOpen from the elbow to the hand — each stretched and rotated to span
 *  its own two end points. Posed the way a powered, idle inserter rests in
 *  the game: hand hovering over the pickup spot a full reach out, elbow
 *  raised over the midpoint. (A freshly placed, still unpowered one holds
 *  its hand in closer — the reference editor's pose, and what this drew
 *  before.) Numbers measured off an in-game screenshot of all four facings,
 *  in tiles, for the default hand_size. */
const REACH = 1;
/** How far up the screen the raised elbow sits from the midpoint. */
const ELBOW_LIFT = 0.26;
/** The hand hovers slightly above the ground it reaches over. */
const HAND_LIFT = 0.03;

/** Factorio's own default `hand_size` (confirmed via InserterPrototype docs:
 *  "Used to determine how long the arm of the inserter is when drawing it.
 *  ... Default value: 0.75") — every vanilla inserter except long-handed
 *  leaves this field unset. */
const DEFAULT_HAND_SIZE = 0.75;

/** Long-handed-inserter is the one vanilla inserter with a non-default
 *  hand_size (1.5, i.e. exactly 2× DEFAULT_HAND_SIZE) — its pickup/insert
 *  positions are ~2× a regular inserter's too, so the whole pose scales. */
const LONG_HANDED_RATIO = 1.5 / DEFAULT_HAND_SIZE;

interface Point {
  x: number;
  y: number;
}

/** Elbow and hand, in tiles from the pivot, for an arm reaching toward
 *  `cardinal`. */
function armPose(cardinal: Cardinal, ratio: number): { elbow: Point; hand: Point } {
  const { dx, dy } = step(cardinal);
  const hand = { x: dx * REACH * ratio, y: (dy * REACH - HAND_LIFT) * ratio };
  const elbow = { x: hand.x / 2, y: hand.y / 2 - ELBOW_LIFT * ratio };
  return { elbow, hand };
}

/** Inserters are composited from a platform plate and a hand rotated to face
 *  the drop side, rather than drawn from a packed sheet — so the arm bypasses
 *  the draw-command pipeline and paints directly (the platform itself DOES go
 *  through that pipeline now, see collectInserterPlatform's own doc comment
 *  for why: it needs to Y-sort against neighbours like any other entity's
 *  body, only the arm always draws on top regardless of depth). For a real,
 *  already-placed inserter this draws ONLY the arm — the platform was already
 *  painted by the Y-sorted pass this call happens after. `tint`, when given,
 *  washes a CSS color over the composited PLATFORM+ARM silhouette
 *  (source-atop) instead — the placement ghost's green/red valid/invalid
 *  cast, which (unlike a real placed entity) has no separate Y-sorted pass to
 *  paint its own platform in, so drawTintedInserter composites both parts
 *  itself. Applying the tint here rather than after the fact matters because
 *  source-atop composites against whatever the target canvas already holds:
 *  painting straight onto the main canvas would tint every entity already
 *  drawn underneath too, not just this inserter, so the hand/platform are
 *  composited onto a same-size offscreen canvas first and only that gets
 *  tinted, then the whole tinted result is drawn onto the main canvas in one
 *  call. */
export function drawInserter(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  entity: PlacedEntity,
  g: InserterGraphics | undefined,
  tint?: string,
  tintedOffscreenRes?: number,
): void {
  const platform = g && atlas.get(g.platform.sheet);
  const handBase = g && atlas.get(g.handBase.sheet);
  const handOpen = g && atlas.get(g.handOpen.sheet);
  if (!g || !platform || !handBase || !handOpen) {
    // The platform's own Y-sorted pass already falls back to an outline (via
    // collectEntity's usual "no sprite loaded yet" handling) when its sheet
    // isn't ready, so this would double up; only the tint path (which needs
    // the whole composited shape) still draws its own outline here.
    if (tint) drawOutline(ctx, entity.x, entity.y, 1, 1);
    return;
  }

  if (tint) {
    drawTintedInserter(ctx, entity, g, platform, handBase, handOpen, tint, tintedOffscreenRes ?? PIXELS_PER_TILE);
    return;
  }

  drawArm(ctx, entity, g, handBase, handOpen);
}

/** Generous upper bound on how far the hand's far tip can land past the
 *  pivot (the worst case, long-handed, is 2 tiles out plus half the claw's
 *  width) — a footprint big enough to hold the whole composited inserter
 *  (platform + outstretched hand) at any rotation is a square
 *  (2*MAX_REACH + platform span) on a side, centered on the entity. */
const MAX_REACH = 2.5;

function inserterOffscreenSpan(g: InserterGraphics): number {
  const platformSpan = Math.max(tiles(g.platform.frameWidth, g.platform.scale), tiles(g.platform.frameHeight, g.platform.scale));
  return platformSpan + MAX_REACH * 2;
}

function drawTintedInserter(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  platform: SpriteSurface,
  handBase: SpriteSurface,
  handOpen: SpriteSurface,
  tint: string,
  res: number,
): void {
  const span = inserterOffscreenSpan(g);
  // World units -> offscreen pixels, at `res` (the caller's current device-
  // pixels-per-tile, i.e. dpr * camera.state.pixelsPerTile) rather than a
  // fixed constant — a hardcoded 32px/tile buffer stretched to fill the
  // screen at, say, 4x zoom looked visibly blurrier/blockier than a placed
  // inserter right next to it, which draws straight from the full-
  // resolution sprite atlas at whatever zoom is current.
  const off = document.createElement("canvas");
  off.width = Math.ceil(span * res);
  off.height = Math.ceil(span * res);
  const offCtx = off.getContext("2d")!;
  offCtx.translate(off.width / 2, off.height / 2);
  offCtx.scale(res, res);
  // drawInserterParts draws relative to `entity.{x,y}` in world space;
  // offsetting a fake entity to (0,0) centers the composited result at the
  // offscreen canvas's own center, matching the translate above.
  drawInserterParts(offCtx, { ...entity, x: 0, y: 0 }, g, platform, handBase, handOpen);

  offCtx.globalCompositeOperation = "source-atop";
  offCtx.globalAlpha = TINT_ALPHA;
  offCtx.fillStyle = tint;
  offCtx.fillRect(-span / 2, -span / 2, span, span);

  ctx.drawImage(off, entity.x - span / 2, entity.y - span / 2, span, span);
}

/** Draws one arm segment running from `from` to `to` (tiles from the
 *  entity's centre): the sprite's bottom edge sits on `from`, its top edge on
 *  `to`, at its natural width — so the stretch along its length is what
 *  foreshortens a segment pointing toward or away from the camera. */
function drawArmSegment(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  img: SpriteSurface,
  sprite: { frameWidth: number; frameHeight: number; scale?: number },
  from: Point,
  to: Point,
): void {
  const w = tiles(sprite.frameWidth, sprite.scale);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  ctx.save();
  ctx.translate(entity.x + from.x, entity.y + from.y);
  ctx.rotate(Math.atan2(dx, -dy));
  const length = Math.hypot(dx, dy);
  ctx.drawImage(img, -w / 2, -length, w, length);
  ctx.restore();
}

function drawPlatform(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  platform: SpriteSurface,
): void {
  const cardinal = toCardinal(entity.direction);
  const column = Math.round(cardinal / 4) % g.platformDirections;
  const pw = tiles(g.platform.frameWidth, g.platform.scale);
  const ph = tiles(g.platform.frameHeight, g.platform.scale);
  // The platform art's own shift (the prototype's shift field) nudges the
  // image to align its visual center with the entity's true center — the
  // arm below pivots at entity.x/y unshifted (that's the mechanical
  // pickup/insert pivot), so skipping this made the platform look off-
  // center under the arm's pivot even though each was individually correct.
  const [shiftX, shiftY] = g.platform.shift ?? [0, 0];
  ctx.drawImage(
    platform,
    column * g.platform.frameWidth, 0, g.platform.frameWidth, g.platform.frameHeight,
    entity.x + shiftX - pw / 2, entity.y + shiftY - ph / 2, pw, ph,
  );
}

/** The arm alone: two independently rotated/squished static sprites, not a
 *  single stretched piece — see armPose. hand (handOpen, the grabber) lands
 *  on the side the inserter faces; arm (handBase) stays near the pivot and
 *  is drawn LAST so it overlaps the hand, matching the real game's
 *  foreground arm. Always drawn on top of whatever else is on screen — see
 *  drawInserter's own doc comment for why that's correct for the arm but not
 *  for the platform. */
function drawArm(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  handBase: SpriteSurface,
  handOpen: SpriteSurface,
): void {
  const ratio = entity.name === "long-handed-inserter" ? LONG_HANDED_RATIO : 1;
  const { elbow, hand } = armPose(toCardinal(entity.direction), ratio);
  drawArmSegment(ctx, entity, handOpen, g.handOpen, elbow, hand);
  drawArmSegment(ctx, entity, handBase, g.handBase, { x: 0, y: 0 }, elbow);
}

/** Platform + arm together, for the placement ghost's tinted preview — which
 *  has no separate Y-sorted pass to paint its own platform in (a ghost isn't
 *  a real committed entity), so drawTintedInserter needs both parts in one
 *  composited silhouette. */
function drawInserterParts(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  g: InserterGraphics,
  platform: SpriteSurface,
  handBase: SpriteSurface,
  handOpen: SpriteSurface,
): void {
  drawPlatform(ctx, entity, g, platform);
  drawArm(ctx, entity, g, handBase, handOpen);
}
