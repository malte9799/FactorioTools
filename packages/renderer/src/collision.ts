/** Whether two entities may not stand where they are — Factorio's "nothing
 *  shares a tile" rule, with track as the exception it is in the game.
 *
 *  Most entities collide by their axis-aligned footprints. Track doesn't: a
 *  curve's or diagonal's square footprint is mostly empty, so a ground rail
 *  blocks only the tiles it runs over. Rails cross and run alongside each
 *  other freely — only the very same piece twice collides —
 *  elevated track stands above everything on the ground, and signals and
 *  train stops stand beside track by design. */

import { stockOrientation, type PlacedEntity } from "@factoriotools/engine";
import { isElevatedRail, isRail, isRollingStock, railKey, railTiles } from "./railGeometry.js";

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

/** True when a ground rail covers any tile the box overlaps. */
function railHitsBox(rail: PlacedEntity, box: Box): boolean {
  return railTiles(rail).some(([tx, ty]) => overlap(box, { left: tx, top: ty, right: tx + 1, bottom: ty + 1 }));
}

/** True when the box touches what the entity actually occupies — its rail
 *  tiles for track, its footprint for everything else. What box selection
 *  and rect queries should test after the spatial index's broad phase. */
export function boxHitsEntity(box: Box, e: PlacedEntity, footprintOf: (e: PlacedEntity) => [number, number]): boolean {
  if (isRail(e.name)) {
    return railTiles(e).some(([tx, ty]) => box.left <= tx + 1 && box.right >= tx && box.top <= ty + 1 && box.bottom >= ty);
  }
  const f = footprintBox(e, footprintOf(e));
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
    if (aStock && bStock) return stockOverlap(a, b, footprintOf);
  }
  if (aRail && bRail) return railKey(a) === railKey(b);
  if (aRail || bRail) {
    const rail = aRail ? a : b;
    const other = aRail ? b : a;
    if (isElevatedRail(rail.name) || RAILSIDE.has(other.name)) return false;
    return railHitsBox(rail, footprintBox(other, footprintOf(other)));
  }
  // Signals stand next to each other on adjacent slots; only the very same
  // spot is taken.
  if (RAILSIDE.has(a.name) && RAILSIDE.has(b.name)) return a.x === b.x && a.y === b.y;
  return overlap(footprintBox(a, footprintOf(a)), footprintBox(b, footprintOf(b)));
}
