import { Layer } from "@factoriotools/engine";
import type { SpriteAtlas } from "../spriteAtlas.js";
import { compareDrawCommands, type DrawCommand } from "./commands.js";

/** Factorio ships shadow art as near-opaque grayscale (its engine composites
 *  shadows with a multiply blend, not plain alpha); painted with drawImage's
 *  default source-over blend they read as flat black smears. Multiply plus
 *  a capped opacity approximates the game's own softer look. */
const SHADOW_ALPHA = 0.45;

/** How strongly a ghost's valid/invalid-placement tint (DrawCommand.tint,
 *  and inserter.ts's own separate offscreen-composited tint) washes over its
 *  sprite — matches the reference look: a clear green/red cast without
 *  hiding the sprite's own detail underneath. */
export const TINT_ALPHA = 0.55;

/** Paints a frame's commands in global order. Sorting here rather than per
 *  entity is what keeps one entity's shadow from landing on top of a
 *  neighbour drawn earlier. Tinted commands (the placement ghost's
 *  green/red valid/invalid wash) are pulled out and composited separately
 *  by paintTinted — source-atop can't be applied per-command against the
 *  live canvas, since by the time a command's tint fill runs, the canvas
 *  already holds whatever unrelated content (floor, neighbouring entities)
 *  sits behind that command's own transparent pixels, and source-atop washes
 *  over all of it, not just this sprite's own silhouette. */
export function paint(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  commands: DrawCommand[],
  tintedOffscreenRes: number,
): void {
  // A ghost's shadow stays untinted — the green/red wash marks the
  // building itself, not the ground shadow it casts, which should keep
  // reading as a plain shadow regardless of placement validity.
  const untinted = commands.filter((c) => !c.tint || c.layer === Layer.Shadow);
  const tinted = commands.filter((c) => c.tint && c.layer !== Layer.Shadow);
  paintPlain(ctx, atlas, untinted);
  if (tinted.length > 0) paintTinted(ctx, atlas, tinted, tintedOffscreenRes);
}

/** What one paintPlain pass actually put on the canvas. A command whose sheet
 *  has not finished loading is skipped silently, so "1401 commands" alone says
 *  nothing about how much drawing really happened — a frame can report a full
 *  command list while painting almost nothing. Recorded per frame so a spike
 *  can be told apart from a frame that merely *looked* busy. */
export interface PaintTally {
  /** Commands whose sheet was ready and which reached drawImage. */
  drawn: number;
  /** Commands skipped because their sheet was still loading. */
  skipped: number;
  /** Distinct sheets sampled — a proxy for how much texture the frame touched. */
  sheets: number;
  /** Sum of |dw*dh| over drawn commands, in CSS pixels squared. Blend cost
   *  scales with covered area, not with the number of calls. */
  area: number;
  /** How often globalCompositeOperation flipped (shadow multiply passes). */
  compositeSwitches: number;
}

/** Paints an already-untinted command list. The main scene pass calls this
 *  directly: only the placement ghost ever carries a tint, and it is painted
 *  by its own separate paint() call, so splitting the scene list into tinted
 *  and untinted halves every frame allocated two arrays to discover that one
 *  of them is always empty. Sorts in place, same as paint().
 *
 *  Returns a tally when `tally` is passed. Collecting it costs a handful of
 *  adds per command and one Set of sheet names, so the caller only asks for
 *  it while a recording is running. */
export function paintPlain(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas,
  commands: DrawCommand[],
  tally?: PaintTally,
  skipShadows = false,
): void {
  commands.sort(compareDrawCommands);
  let alpha = 1;
  let compositeIsMultiply = false;
  const sheets = tally ? new Set<string>() : null;
  for (const c of commands) {
    // Shadows are multiply-blended over large areas, the costliest thing a
    // frame paints on a weak GPU; the low render preset leaves them out.
    if (skipShadows && c.layer === Layer.Shadow) continue;
    const img = c.multiply ? atlas.getTinted(c.sheet, c.multiply) : atlas.get(c.sheet);
    if (!img) {
      if (tally) tally.skipped++;
      continue;
    }
    if (tally) {
      tally.drawn++;
      tally.area += Math.abs(c.dw * c.dh);
      sheets!.add(c.sheet);
    }
    const isShadow = c.layer === Layer.Shadow;
    if (isShadow !== compositeIsMultiply) {
      ctx.globalCompositeOperation = isShadow ? "multiply" : "source-over";
      compositeIsMultiply = isShadow;
      if (tally) tally.compositeSwitches++;
    }
    const wantAlpha = isShadow ? c.alpha * SHADOW_ALPHA : c.alpha;
    if (wantAlpha !== alpha) {
      ctx.globalAlpha = wantAlpha;
      alpha = wantAlpha;
    }
    // Rotation is rare — only a hand-placed static composite like the
    // agricultural tower's crane parts ever sets it (see Sprite.rotationDeg's
    // own doc comment) — so this stays a plain drawImage for every other
    // command, and only pays for save/translate/rotate/restore on the ones
    // that actually need it.
    if (c.rotationDeg) {
      const cx = c.dx + c.dw / 2;
      const cy = c.dy + c.dh / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((c.rotationDeg * Math.PI) / 180);
      ctx.translate(-cx, -cy);
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
      ctx.restore();
    } else {
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
    }
  }
  if (alpha !== 1) ctx.globalAlpha = 1;
  if (compositeIsMultiply) {
    ctx.globalCompositeOperation = "source-over";
    if (tally) tally.compositeSwitches++;
  }
  if (tally && sheets) tally.sheets = sheets.size;
}

/** Composites every tinted command onto its own offscreen canvas (isolated
 *  from the main canvas's existing content), washes a source-atop tint over
 *  ONLY that isolated result — so it follows the union of these sprites'
 *  own silhouettes — then blits the tinted composite onto the main canvas in
 *  one call. All the given commands share one tint (the placement ghost is
 *  one colour throughout), read from the first command. */
function paintTinted(ctx: CanvasRenderingContext2D, atlas: SpriteAtlas, commands: DrawCommand[], res: number): void {
  commands.sort(compareDrawCommands);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const c of commands) {
    left = Math.min(left, c.dx);
    top = Math.min(top, c.dy);
    right = Math.max(right, c.dx + c.dw);
    bottom = Math.max(bottom, c.dy + c.dh);
  }
  const spanW = right - left;
  const spanH = bottom - top;
  if (!(spanW > 0 && spanH > 0)) return;

  // World units -> offscreen pixels, at `res` (the caller's current
  // camera.state.pixelsPerTile, i.e. the SAME resolution a placed entity
  // draws at right now) rather than a fixed constant — a hardcoded 32px/tile
  // buffer stretched to fill the screen at, say, 4x zoom looked visibly
  // blurrier/blockier than every placed entity around it, which draws
  // straight from the full-resolution sprite atlas at whatever zoom is
  // current. Smoothing left on (the default) so any residual scaling still
  // blends like the rest of the canvas instead of looking pixelated.
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.ceil(spanW * res));
  off.height = Math.max(1, Math.ceil(spanH * res));
  const offCtx = off.getContext("2d")!;

  let alpha = 1;
  let compositeIsMultiply = false;
  for (const c of commands) {
    const img = c.multiply ? atlas.getTinted(c.sheet, c.multiply) : atlas.get(c.sheet);
    if (!img) continue;
    const isShadow = c.layer === Layer.Shadow;
    if (isShadow !== compositeIsMultiply) {
      offCtx.globalCompositeOperation = isShadow ? "multiply" : "source-over";
      compositeIsMultiply = isShadow;
    }
    const wantAlpha = isShadow ? c.alpha * SHADOW_ALPHA : c.alpha;
    if (wantAlpha !== alpha) {
      offCtx.globalAlpha = wantAlpha;
      alpha = wantAlpha;
    }
    const ox = (c.dx - left) * res, oy = (c.dy - top) * res, ow = c.dw * res, oh = c.dh * res;
    if (c.rotationDeg) {
      const cx = ox + ow / 2, cy = oy + oh / 2;
      offCtx.save();
      offCtx.translate(cx, cy);
      offCtx.rotate((c.rotationDeg * Math.PI) / 180);
      offCtx.translate(-cx, -cy);
      offCtx.drawImage(img, c.sx, c.sy, c.sw, c.sh, ox, oy, ow, oh);
      offCtx.restore();
    } else {
      offCtx.drawImage(img, c.sx, c.sy, c.sw, c.sh, ox, oy, ow, oh);
    }
  }
  offCtx.globalAlpha = 1;
  offCtx.globalCompositeOperation = "source-atop";
  offCtx.globalAlpha = TINT_ALPHA;
  offCtx.fillStyle = commands[0]!.tint!;
  offCtx.fillRect(0, 0, off.width, off.height);

  ctx.drawImage(off, left, top, spanW, spanH);
}

export function drawOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tint = "rgba(230,221,206,0.45)",
): void {
  ctx.save();
  ctx.strokeStyle = tint;
  ctx.lineWidth = 0.06;
  ctx.strokeRect(x - w / 2 + 0.05, y - h / 2 + 0.05, w - 0.1, h - 0.1);
  ctx.restore();
}

/** Which row of cursor-boxes.png to draw from — utility-sprites.lua's
 *  cursor_box.regular (yellow) and cursor_box.copy (green, what the game
 *  shows on a hovered underground's paired other half). */
export type CursorBoxStyle = "regular" | "pair";
const CURSOR_BOX_ROW: Record<CursorBoxStyle, number> = { regular: 0, pair: 192 };

/** cursor_box's size tiers from utility-sprites.lua: the first tier whose
 *  max_side_length fits the entity's SHORTER side wins, so a bigger building
 *  gets longer, thicker brackets — and a 1x2 one gets the same brackets as a
 *  1x1. Anything past the last tier uses it. */
const CURSOR_BOX_TIERS: { maxSide: number; x: number }[] = [
  { maxSide: 0.4, x: 256 },
  { maxSide: 0.7, x: 192 },
  { maxSide: 1.05, x: 128 },
  { maxSide: 3.5, x: 64 },
  { maxSide: Infinity, x: 0 },
];

/** Stamps Factorio's own cursor-box corner art at each corner of an
 *  entity's footprint. Each 64px cell is the top-left bracket only, drawn
 *  at the game's scale 0.5 (one tile) with its origin on the corner and
 *  rotated 0/90/180/270deg for the other three — the same way the
 *  reference renderer's createCorners() builds a full box from one corner
 *  sprite. */
export function drawHoverHighlight(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  style: CursorBoxStyle = "regular",
  /** Turns the box about its centre, clockwise in radians — rails lie at an
   *  angle, and their brackets follow them. */
  angle = 0,
  /** Side length that picks the bracket size: the shorter side, so a long
   *  thin footprint (track, a long building) keeps small brackets. */
  tierSide = Math.min(w, h),
): void {
  const tier = CURSOR_BOX_TIERS.find((t) => tierSide <= t.maxSide)!;
  const sy = CURSOR_BOX_ROW[style];
  const left = -w / 2;
  const top = -h / 2;
  const right = w / 2;
  const bottom = h / 2;

  const corners: { cx: number; cy: number; rotationDeg: number }[] = [
    { cx: left, cy: top, rotationDeg: 0 },
    { cx: right, cy: top, rotationDeg: 90 },
    { cx: right, cy: bottom, rotationDeg: 180 },
    { cx: left, cy: bottom, rotationDeg: 270 },
  ];

  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  for (const c of corners) {
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate((c.rotationDeg * Math.PI) / 180);
    ctx.drawImage(sheet, tier.x, sy, 64, 64, 0, 0, 1, 1);
    ctx.restore();
  }
  ctx.restore();
}

/** A placement handle, as the game draws them along track for a held signal
 *  or train stop: a green rounded square on the slot, with a stem straight
 *  across to the rail. The stem runs along (towardX, towardY), a unit vector
 *  pointing at the track, and stops `gap` short of the track's centreline —
 *  at the rail — `lateral` tiles away; `half` is half the square's side. */
export function drawRailHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  towardX: number,
  towardY: number,
  lateral: number,
  half: number,
): void {
  const stem = lateral - half - 0.75;
  ctx.save();
  ctx.strokeStyle = "#33d433";
  ctx.lineWidth = half * 0.36;
  ctx.lineJoin = "round";
  if (stem >= 0.1) {
    ctx.beginPath();
    ctx.moveTo(x + towardX * half, y + towardY * half);
    ctx.lineTo(x + towardX * (half + stem), y + towardY * (half + stem));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.roundRect(x - half, y - half, half * 2, half * 2, half * 0.45);
  ctx.stroke();
  ctx.restore();
}

/** A held signal's handle: the rail runs to the right of the signal's
 *  16-way `direction`, through its joint (ex, ey). */
export function drawSignalHandle(ctx: CanvasRenderingContext2D, slot: { x: number; y: number; direction: number; ex?: number; ey?: number }): void {
  const a = (slot.direction * Math.PI) / 8;
  const rx = Math.cos(a);
  const ry = Math.sin(a);
  const lateral = slot.ex !== undefined && slot.ey !== undefined ? Math.abs((slot.ex - slot.x) * rx + (slot.ey - slot.y) * ry) : 1.5;
  drawRailHandle(ctx, slot.x, slot.y, rx, ry, lateral, 0.22);
}

/** A held train stop's handle, about a tile across: the stop stands two
 *  tiles to the right of travel, so the rail is to its left. */
export function drawStopHandle(ctx: CanvasRenderingContext2D, slot: { x: number; y: number; direction: number }): void {
  const a = (slot.direction * Math.PI) / 8;
  drawRailHandle(ctx, slot.x, slot.y, -Math.cos(a), -Math.sin(a), 2, 0.5);
}

/** One block's stretch of track centreline, as a held signal shows it:
 *  `points` in world tiles, drawn as a solid line in the block's colour. */
export function drawRailBlockLine(ctx: CanvasRenderingContext2D, points: [number, number][], color: string): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]![0], points[i]![1]);
  ctx.stroke();
  ctx.restore();
}

/** Where a block line ends at a signalled joint: a triangle pointing into
 *  the joint (a signal there governs trains leaving this way), or a diamond.
 *  `dir` is the outward 16-way direction of the track end at (x, y). */
export function drawRailBlockMarker(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, kind: "arrow" | "diamond", color: string): void {
  const a = (dir * Math.PI) / 8;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  // Sit just inside the end, so the two blocks' markers meet at the joint.
  const cx = x - ux * 0.32;
  const cy = y - uy * 0.32;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.beginPath();
  if (kind === "arrow") {
    ctx.moveTo(0, -0.3);
    ctx.lineTo(0.24, 0.12);
    ctx.lineTo(-0.24, 0.12);
  } else {
    ctx.moveTo(0, -0.26);
    ctx.lineTo(0.2, 0);
    ctx.lineTo(0, 0.26);
    ctx.lineTo(-0.2, 0);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** The game's "can't build" cross: a red X about a tile across, centred on
 *  (x, y) — the rail planner shows it at the cursor when no track can get
 *  any closer. */
export function drawBlockedCross(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = 0.4;
  ctx.save();
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.strokeStyle = "#a01818";
  ctx.lineWidth = 0.28;
  ctx.stroke();
  ctx.strokeStyle = "#f25a5a";
  ctx.lineWidth = 0.17;
  ctx.stroke();
  ctx.restore();
}

/** The rail planner's start arrow, as the game draws it on track: a
 *  rounded green triangle whose flat side runs across the rail's centre
 *  (x, y) and whose tip points along the 16-way `dir`, toward the end the
 *  plan would leave from. */
export function drawRailStartArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((dir * Math.PI) / 8);
  ctx.beginPath();
  ctx.moveTo(0, -0.58);
  ctx.lineTo(0.62, 0.02);
  ctx.lineTo(-0.62, 0.02);
  ctx.closePath();
  ctx.lineJoin = "round";
  // A wide round-joined stroke gives the soft corners; the fill covers its
  // inner half, leaving a darker green rim.
  ctx.lineWidth = 0.16;
  ctx.strokeStyle = "#3a9e2a";
  ctx.stroke();
  ctx.fillStyle = "#56c63b";
  ctx.fill();
  ctx.restore();
}

/** One tile of the underground_sprite tunnel line (underground-lines.png's
 *  x=64 cell: dashed side rails plus an arrow) centred on (x, y) and turned
 *  to point along `travel`, a 16-way direction (the cell's own arrow
 *  points north). */
export function drawUndergroundLine(ctx: CanvasRenderingContext2D, sheet: HTMLImageElement, x: number, y: number, travel: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((travel / 16) * 2 * Math.PI);
  ctx.drawImage(sheet, 64, 0, 64, 64, -0.5, -0.5, 1, 1);
  ctx.restore();
}

/** How far from the inserter's centre its indication line and arrow sit,
 *  in tiles, for a one-tile reach (measured off an in-game screenshot). */
const INDICATION_DISTANCE = 0.87;

/** A hovered inserter's own markers, the way the game shows them: the
 *  indication_line bar across the side it picks up from (`pickup`, a 16-way
 *  direction) and the indication_arrow pointing out of the side it drops
 *  to. Both are 64px cells drawn at the game's scale 0.5 (one tile); the
 *  arrow's own art points north. `reach` is how many tiles out the inserter
 *  works (2 for a long-handed one). */
export function drawInserterIndication(
  ctx: CanvasRenderingContext2D,
  sprites: { line: HTMLImageElement; arrow: HTMLImageElement },
  x: number,
  y: number,
  pickup: number,
  reach = 1,
): void {
  const distance = INDICATION_DISTANCE + reach - 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((pickup / 16) * 2 * Math.PI);
  ctx.drawImage(sprites.line, -0.5, -distance - 0.5, 1, 1);
  ctx.rotate(Math.PI);
  ctx.drawImage(sprites.arrow, -0.5, -distance - 0.5, 1, 1);
  ctx.restore();
}

/** A hovered combinator's two direction arrows, the way the game shows
 *  them: one indication_arrow over the input half and one over the output
 *  half, both pointing the way signals flow (`facing`, a 16-way direction).
 *  Each sits 0.75 tiles from the centre of the 1x2 body (measured off an
 *  in-game screenshot). */
export function drawDirectionArrows(ctx: CanvasRenderingContext2D, arrow: HTMLImageElement, x: number, y: number, facing: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((facing / 16) * 2 * Math.PI);
  ctx.drawImage(arrow, -0.5, -0.75 - 0.5, 1, 1);
  ctx.drawImage(arrow, -0.5, 0.75 - 0.5, 1, 1);
  ctx.restore();
}
