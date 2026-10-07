/** Whether two entities may not stand where they are — Factorio's "nothing
 *  shares a tile" rule, with track as the exception it is in the game.
 *
 *  Most entities collide by their axis-aligned footprints. Track doesn't: a
 *  curve's or diagonal's square footprint is mostly empty, so a rail blocks
 *  only the tiles it runs over. Rails cross and run alongside each other
 *  freely — only the very same piece twice collides. Elevated track stands
 *  above everything on the ground. A ramp is solid from the ground to the
 *  deck: nothing shares its tiles, track on either layer included. A rail
 *  support blocks by its own turned box, ground track too. Signals and
 *  train stops stand beside track by design, and a signal on elevated track
 *  is up on the deck, clear of the ground. */

import { stockOrientation, type PlacedEntity } from "@factoriotools/engine";
import { isElevatedRail, isRail, isRollingStock, RAIL_DECK_HEIGHT, railKey, railTiles, supportHitsBox } from "./railGeometry.js";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const RAILSIDE = new Set(["rail-signal", "rail-chain-signal", "train-stop"]);

/** Collisions this close to an edge are two boxes only touching. */
const EPSILON = 0.01;

function overlap(a: Box, b: Box): boolean {
  return a.left < b.right - EPSILON && a.right > b.left + EPSILON && a.top < b.bottom - EPSILON && a.bottom > b.top + EPSILON;
}

export function footprintBox(e: { x: number; y: number }, [w, h]: [number, number]): Box {
  return { left: e.x - w / 2, top: e.y - h / 2, right: e.x + w / 2, bottom: e.y + h / 2 };
}

/** True when a rail covers any tile the box overlaps. */
function railHitsBox(rail: PlacedEntity, box: Box): boolean {
  return railTiles(rail).some(([tx, ty]) => overlap(box, { left: tx, top: ty, right: tx + 1, bottom: ty + 1 }));
}

/** Collision boxes sit a little inside the tiles they fill. */
const TILE_INSET = 0.1;

function inset(box: Box): Box {
  return { left: box.left + TILE_INSET, top: box.top + TILE_INSET, right: box.right - TILE_INSET, bottom: box.bottom - TILE_INSET };
}

/** True when the box touches what the entity actually occupies as it is
 *  seen — its rail tiles for track (up on the deck for elevated track), its
 *  footprint for everything else. What box selection and rect queries
 *  should test after the spatial index's broad phase. */
export function boxHitsEntity(box: Box, e: PlacedEntity, footprintOf: (e: PlacedEntity) => [number, number]): boolean {
  if (isRail(e.name)) {
    const lift = isElevatedRail(e.name) ? RAIL_DECK_HEIGHT : 0;
    return railTiles(e).some(([tx, ty]) => box.left <= tx + 1 && box.right >= tx && box.top <= ty - lift + 1 && box.bottom >= ty - lift);
  }
  const lift = e.railLayer === "elevated" ? RAIL_DECK_HEIGHT : 0;
  const f = footprintBox({ x: e.x, y: e.y - lift }, footprintOf(e));
  return box.left <= f.right && box.right >= f.left && box.top <= f.bottom && box.bottom >= f.top;
}

/** Two pieces of rolling stock, each a box turned to its own heading:
 *  separating-axis test over both boxes' axes. The footprint of stock
 *  facing north is its collision box. */
function stockOverlap(a: PlacedEntity, b: PlacedEntity, footprintOf: (e: PlacedEntity) => [number, number]): boolean {
  const boxes = [a, b].map((e) => {
    const [w, l] = footprintOf({ ...e, direction: 0 });
    const t = stockOrientation(e) * Math.PI * 2;
    return { x: e.x, y: e.y, along: [Math.sin(t), -Math.cos(t)] as const, across: [Math.cos(t), Math.sin(t)] as const, w, l };
  });
  const [p, q] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
  for (const axis of [p.along, p.across, q.along, q.across]) {
    const reach = (box: typeof p) =>
      (Math.abs(box.along[0] * axis[0] + box.along[1] * axis[1]) * box.l) / 2 + (Math.abs(box.across[0] * axis[0] + box.across[1] * axis[1]) * box.w) / 2;
    const gap = Math.abs((q.x - p.x) * axis[0] + (q.y - p.y) * axis[1]);
    if (gap > reach(p) + reach(q) - EPSILON) return false;
  }
  return true;
}

/** True when `a` and `b` may not both stand where they are. */
export function entitiesCollide(a: PlacedEntity, b: PlacedEntity, footprintOf: (e: PlacedEntity) => [number, number]): boolean {
  const aRail = isRail(a.name);
  const bRail = isRail(b.name);
  const aStock = isRollingStock(a.name);
  const bStock = isRollingStock(b.name);
  if (aStock || bStock) {
    // Stock rides on track and passes signals and stops beside it.
    if (aRail || bRail || RAILSIDE.has(a.name) || RAILSIDE.has(b.name)) return false;
    // A train on a bridge clears one on the ground under it.
    if (aStock && bStock) return a.railLayer === b.railLayer && stockOverlap(a, b, footprintOf);
  }
  // A signal on the deck only ever shares its spot with another one there,
  // and stock up there is clear of everything on the ground.
  if (a.railLayer === "elevated" || b.railLayer === "elevated") {
    return a.railLayer === b.railLayer && RAILSIDE.has(a.name) && RAILSIDE.has(b.name) && a.x === b.x && a.y === b.y;
  }
  if (aRail && bRail) {
    if (railKey(a) === railKey(b)) return true;
    // Track crosses track, but never a ramp: only the pieces joined to its
    // two ends meet it, and those start where it stops.
    if (a.name !== "rail-ramp" && b.name !== "rail-ramp") return false;
    const tiles = new Set(railTiles(a).map(([tx, ty]) => `${tx},${ty}`));
    return railTiles(b).some(([tx, ty]) => tiles.has(`${tx},${ty}`));
  }
  const aSupport = a.name === "rail-support";
  const bSupport = b.name === "rail-support";
  if (aSupport || bSupport) {
    const support = aSupport ? a : b;
    const other = aSupport ? b : a;
    if (isElevatedRail(other.name)) return false;
    if (isRail(other.name)) return railTiles(other).some(([tx, ty]) => supportHitsBox(support, inset({ left: tx, top: ty, right: tx + 1, bottom: ty + 1 })));
    // Two supports: the other's box, unturned, is close enough.
    if (other.name === "rail-support") return supportHitsBox(support, footprintBox(other, [2.78, 2.78]));
    return supportHitsBox(support, inset(footprintBox(other, footprintOf(other))));
  }
  if (aRail || bRail) {
    const rail = aRail ? a : b;
    const other = aRail ? b : a;
    if (isElevatedRail(rail.name)) return false;
    // A signal stands beside ground track, but not inside a ramp.
    if (RAILSIDE.has(other.name) && rail.name !== "rail-ramp") return false;
    return railHitsBox(rail, footprintBox(other, footprintOf(other)));
  }
  // Signals stand next to each other on adjacent slots; only the very same
  // spot is taken.
  if (RAILSIDE.has(a.name) && RAILSIDE.has(b.name)) return a.x === b.x && a.y === b.y;
  return overlap(footprintBox(a, footprintOf(a)), footprintBox(b, footprintOf(b)));
}
