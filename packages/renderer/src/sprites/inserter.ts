import type { InserterGraphics, PlacedEntity } from "@factoriotools/engine";
import type { SpriteAtlas, SpriteSurface } from "../spriteAtlas.js";
import { toCardinal } from "../neighbours/grid.js";
import { PIXELS_PER_TILE } from "../draw/commands.js";
import { drawOutline, TINT_ALPHA } from "../draw/paint.js";

const tiles = (pixels: number, scale = 1) => (pixels * scale) / PIXELS_PER_TILE;

/** Per-direction placement for one of the two arm segments — mirrors the
 *  reference renderer's (teoxoy/factorio-blueprint-editor spriteDataBuilder
 *  draw_inserter) hardcoded transform table, itself reverse-engineered from
 *  the real game: Factorio draws the arm as two independently rotated/
 *  squished static sprites, not a computed IK solve or an animated sheet.
 *  `rotAngle` in degrees, `squishY` divides the sprite's on-screen height
 *  (its length, since these images are tall and thin), `x`/`y` in tiles from
 *  the entity's center — both sprites anchor at their own bottom-center, so
 *  the arm segment's root always stays at the pivot and only its far end
 *  (which is what "reach" means here) moves. */
interface ArmSegment {
  rotAngle: number;
  squishY: number;
  x: number;
  y: number;
}

const NO_OFFSET: ArmSegment = { rotAngle: 0, squishY: 1, x: 0, y: 0 };

/** Standard (short) inserters: 45° elbow bend on the two diagonals, and a
 *  purely-foreshortened (no in-plane angle) bend on north/south. */
const ARM_ANGLE = 45;
const STANDARD_BY_DIR: Record<number, { hand: ArmSegment; arm: ArmSegment }> = {
  12: { // west
    hand: { rotAngle: -ARM_ANGLE - 90, squishY: 2.5, x: -0.325, y: -0.325 },
    arm: { rotAngle: -ARM_ANGLE, squishY: 1.9, x: 0.03, y: 0.03 },
  },
  4: { // east
    hand: { rotAngle: ARM_ANGLE + 90, squishY: 2.5, x: 0.325, y: -0.325 },
    arm: { rotAngle: ARM_ANGLE, squishY: 1.9, x: -0.03, y: 0.03 },
  },
  8: { // south
    hand: { rotAngle: 180, squishY: 1.75, x: 0, y: 0.03 },
    arm: { rotAngle: 180, squishY: 7, x: 0, y: -0.03 },
  },
  0: { // north
    hand: { ...NO_OFFSET, squishY: 3, y: -0.5 },
    arm: { ...NO_OFFSET, squishY: 1.4, y: 0.05 },
  },
};

/** Factorio's own default `hand_size` (confirmed via InserterPrototype docs:
 *  "Used to determine how long the arm of the inserter is when drawing it.
 *  ... Default value: 0.75") — every vanilla inserter except long-handed
 *  leaves this field unset, so this is what STANDARD_BY_DIR's hand-tuned
 *  numbers are implicitly calibrated against. */
const DEFAULT_HAND_SIZE = 0.75;

/** Scales one direction's {hand, arm} segment pair by `ratio` — dividing
 *  squishY (so the sprite renders `ratio` times TALLER, i.e. reaches
 *  further) and multiplying the pivot offset by the same ratio. Angles are
 *  left untouched: hand_size lengthens the arm, it doesn't change the bend,
 *  and STANDARD_BY_DIR's angles are already visually verified. */
function scaleSegment(seg: ArmSegment, ratio: number): ArmSegment {
  return { rotAngle: seg.rotAngle, squishY: seg.squishY / ratio, x: seg.x * ratio, y: seg.y * ratio };
}

/** Long-handed-inserter is the one vanilla inserter with a non-default
 *  hand_size (1.5, i.e. exactly 2× DEFAULT_HAND_SIZE) — confirmed by its
 *  pickup/insert positions also being ~2× a regular inserter's (±2/2.2
 *  tiles vs ±1/1.2). A first attempt at copying the reference renderer's own
 *  hardcoded long-handed numbers looked plausible in isolation but its
 *  offsets don't actually scale to the real ~2-tile reach (confirmed by
 *  placing chests at the true pickup/insert tiles and see the hand fall
 *  short) — deriving the table from the verified STANDARD_BY_DIR by the
 *  real hand_size ratio instead guarantees the reach is correct by
 *  construction, and generalises to any modded inserter's hand_size too
 *  (see buildByDirTable below). */
function scaleByDirTable(
  base: Record<number, { hand: ArmSegment; arm: ArmSegment }>,
  ratio: number,
): Record<number, { hand: ArmSegment; arm: ArmSegment }> {
  const scaled: Record<number, { hand: ArmSegment; arm: ArmSegment }> = {};
  for (const [dir, segs] of Object.entries(base)) {
    scaled[Number(dir)] = { hand: scaleSegment(segs.hand, ratio), arm: scaleSegment(segs.arm, ratio) };
  }
  return scaled;
}

const LONG_HANDED_RATIO = 1.5 / DEFAULT_HAND_SIZE;
const LONG_HANDED_BY_DIR = scaleByDirTable(STANDARD_BY_DIR, LONG_HANDED_RATIO);

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

/** Generous upper bound on how far the hand segment's far tip can land past
 *  the pivot across every direction/inserter-type combination in
 *  STANDARD_BY_DIR/LONG_HANDED_BY_DIR (the worst case, long-handed north, is
 *  about 1.3 tiles) — a footprint big enough to hold the whole composited
 *  inserter (platform + outstretched hand) at any rotation is a square
 *  (2*MAX_REACH + platform span) on a side, centered on the entity. */
const MAX_REACH = 1.5;

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

/** Draws one arm segment (hand or base) anchored bottom-center at the
 *  entity's pivot, per the reference renderer's transform: translate by
 *  `seg.x`/`seg.y` tiles, rotate by `seg.rotAngle` degrees around that
 *  point, then draw the sprite with its bottom edge AT the pivot (anchor
 *  0.5, 1 in Pixi terms) so it extends outward from there — `seg.squishY`
 *  shrinks/stretches that extension, which is what actually varies the
 *  segment's apparent reach per direction. */
function drawArmSegment(
  ctx: CanvasRenderingContext2D,
  entity: PlacedEntity,
  img: SpriteSurface,
  sprite: { frameWidth: number; frameHeight: number; scale?: number },
  seg: ArmSegment,
): void {
  const w = tiles(sprite.frameWidth, sprite.scale);
  const h = tiles(sprite.frameHeight, sprite.scale) / seg.squishY;
  ctx.save();
  ctx.translate(entity.x + seg.x, entity.y + seg.y);
  ctx.rotate((seg.rotAngle * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h, w, h);
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
 *  single stretched piece — see ARM_ANGLE's doc comment. hand (handOpen, the
 *  grabber) lands at the drop side; arm (handBase) stays near the pivot and
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
  const cardinal = toCardinal(entity.direction);
  const byDir = entity.name === "long-handed-inserter" ? LONG_HANDED_BY_DIR : STANDARD_BY_DIR;
  const segs = byDir[cardinal] ?? byDir[0]!;
  drawArmSegment(ctx, entity, handOpen, g.handOpen, segs.hand);
  drawArmSegment(ctx, entity, handBase, g.handBase, segs.arm);
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
