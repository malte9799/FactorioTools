/** Drawing wires and the electric supply-area overlay.
 *
 *  Both are painted in world space, on the same transformed context the
 *  entity sprites use, so a wire's thickness and a supply square's edge
 *  scale with zoom exactly as the sprites do.
 */
import type { ResolvedWire } from "../neighbours/wires.js";

/** Wire colours, taken from the reference editor rather than eyedropped from
 *  a screenshot: copper is the warm orange of a real power line, and the red
 *  and green are the muted circuit-wire shades the game uses, not primaries. */
const WIRE_COLOR: Record<string, string> = {
  copper: "#cf7c00",
  red: "#c83718",
  green: "#588c38",
};

/** Wire thickness in tiles. The game draws wires at a constant on-screen
 *  weight, but this renderer has no screen-space stroke, so a tile-space
 *  width is used and clamped at draw time (see drawWires) to stay visible
 *  when zoomed out and stay thin when zoomed in. */
const WIRE_WIDTH_TILES = 1 / 24;

/** Deepest a wire ever hangs, in tiles.
 *
 *  Half the reference editor's own 30 px (at its 32 px/tile scale), a
 *  deliberate divergence: at full depth the arch read as too heavy against
 *  this renderer's sprites, so the cable is pulled up to half the droop.
 *  Only the DEPTH is halved — the curve's shape, its proportionality to the
 *  horizontal span, and the long-span clamp are all still the reference's. */
const MAX_SAG_TILES = 15 / 32;

/** Span at which the sag reaches MAX_SAG_TILES and stops growing. */
const SAG_FULL_AT_TILES = 3;

/** How far a wire's midpoint hangs below the straight line between its ends,
 *  in tiles.
 *
 *  Ported from the reference editor, whose own formula is
 *  `sin(atan2(dX, -dY)) * min(1, d / 32 / 3) * 30` in pixels — at 32 px per
 *  tile, a 30/32-tile droop. MAX_SAG_TILES halves that; see its own comment.
 *  Two things fall out of the shape and both still hold:
 *
 *  - The `sin` term makes the droop proportional to the HORIZONTAL span, so
 *    a purely vertical wire hangs dead straight (a cable seen end-on has no
 *    visible sag) and a diagonal sags less than a horizontal one of the same
 *    length.
 *  - The `min(1, ...)` clamp caps the droop once a run passes 3 tiles, so a
 *    big pole's 32-tile span hangs like a power line rather than a skipping
 *    rope. Below 3 tiles the sag tapers off with length, which keeps two
 *    adjacent poles from showing a deep loop over a short gap.
 */
export function sagFor(dx: number, dy: number): number {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return 0;
  // sin(atan2(dx, -dy)) reduces exactly to |dx| / distance.
  const horizontalShare = Math.abs(dx) / distance;
  return horizontalShare * Math.min(1, distance / SAG_FULL_AT_TILES) * MAX_SAG_TILES;
}

/** Draws every wire, sagging each one the way a hanging cable does.
 *
 *  A vertical wire is drawn straight: a quadratic sag on a line with no
 *  horizontal span would bow it sideways, which reads as a bent pipe rather
 *  than a hanging cable.
 */
export function drawWires(
  ctx: CanvasRenderingContext2D,
  wires: ResolvedWire[],
  pixelsPerTile: number,
): void {
  if (wires.length === 0) return;

  ctx.save();
  ctx.lineCap = "round";
  // Keep the stroke readable across the whole zoom range: at least a hairline
  // on screen when zoomed far out, and never fatter than the tile-space
  // width when zoomed in.
  const width = Math.max(WIRE_WIDTH_TILES, 1 / pixelsPerTile);

  // Group by colour so the canvas state changes once per colour rather than
  // once per wire — a big blueprint can carry thousands.
  for (const color of ["copper", "red", "green"]) {
    const of = wires.filter((w) => w.color === color);
    if (of.length === 0) continue;

    ctx.strokeStyle = WIRE_COLOR[color] ?? "#cf7c00";
    ctx.lineWidth = width;

    // A wire that cannot reach is drawn faded — the game's own signal that
    // the connection would not survive being built.
    for (const reaches of [true, false]) {
      const group = of.filter((w) => w.reaches === reaches);
      if (group.length === 0) continue;
      ctx.globalAlpha = reaches ? 1 : 0.3;
      ctx.beginPath();
      for (const w of group) {
        const dx = w.x2 - w.x1;
        const dy = w.y2 - w.y1;
        ctx.moveTo(w.x1, w.y1);
        const sag = sagFor(dx, dy);
        if (sag === 0) {
          // A vertical wire (or a zero-length one) hangs straight — bending
          // it would bow the cable sideways, which reads as a bent pipe.
          ctx.lineTo(w.x2, w.y2);
          continue;
        }
        // One control point at the midpoint, pushed straight down by twice
        // the sag: a quadratic curve reaches half its control offset, so 2x
        // here makes the lowest point of the cable sit `sag` below the chord.
        ctx.quadraticCurveTo(w.x1 + dx / 2, w.y1 + dy / 2 + sag * 2, w.x2, w.y2);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The blue supply-area square the game shows while a pole is in hand.
 *
 *  `supply_area_distance` is a half-width, so a medium pole's 3.5 covers the
 *  7x7 the game highlights. Colour and alpha match the reference editor's
 *  own pole visualisation. */
const SUPPLY_FILL = "#3755d9";
const SUPPLY_ALPHA = 0.25;

export interface SupplyArea {
  x: number;
  y: number;
  /** Half-width in tiles (`supply_area_distance`). */
  distance: number;
}

/** Fills each pole's supply square, then outlines the union of them.
 *
 *  Drawn as one path per pass so overlapping squares do not darken where
 *  they cross — with a per-square fill, two overlapping poles would show a
 *  noticeably denser patch, which reads as coverage the area does not have.
 */
export function drawSupplyAreas(
  ctx: CanvasRenderingContext2D,
  areas: SupplyArea[],
  pixelsPerTile: number,
): void {
  if (areas.length === 0) return;

  ctx.save();
  ctx.globalAlpha = SUPPLY_ALPHA;
  ctx.fillStyle = SUPPLY_FILL;
  ctx.beginPath();
  for (const a of areas) {
    const side = a.distance * 2;
    ctx.rect(a.x - a.distance, a.y - a.distance, side, side);
  }
  // "nonzero" would still overdraw where squares overlap; filling the whole
  // path in one operation is what keeps the tint flat.
  ctx.fill();

  // A faint edge makes the boundary legible against a busy blueprint, which
  // a 25%-alpha fill alone does not manage.
  ctx.globalAlpha = SUPPLY_ALPHA * 1.6;
  ctx.strokeStyle = SUPPLY_FILL;
  ctx.lineWidth = Math.max(1 / 32, 1 / pixelsPerTile);
  ctx.stroke();
  ctx.restore();
}
