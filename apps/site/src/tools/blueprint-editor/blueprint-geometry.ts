/** Footprint-aware measurements of a decoded blueprint: its content's
 *  bounding box (what snap-to-grid's grid size and grid position are
 *  measured against) and its components list. */

import { getData, getRenderCatalog, normaliseEntities } from "@factoriotools/engine";
import type { Blueprint } from "@factoriotools/engine";
import { buildVisualLookup, effectiveFootprint, type ResolvedVisual } from "@factoriotools/renderer";

let lookup: { data: unknown; catalog: unknown; map: Map<string, ResolvedVisual> } | null = null;
function visuals(): Map<string, ResolvedVisual> {
  const data = getData();
  const catalog = getRenderCatalog();
  // Rebuilt only when the game data itself is swapped (initial fallback →
  // real dataset).
  if (!lookup || lookup.data !== data || lookup.catalog !== catalog) {
    lookup = { data, catalog, map: buildVisualLookup(data, catalog) };
  }
  return lookup.map;
}

export interface ContentBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Tile-aligned box around every entity's footprint and every tile. */
export function contentBox(bp: Blueprint): ContentBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const lookupMap = visuals();
  for (const e of normaliseEntities(bp)) {
    const visual = lookupMap.get(e.name);
    const [w, h] = visual ? effectiveFootprint(visual, e.direction) : [1, 1];
    minX = Math.min(minX, e.x - w / 2);
    minY = Math.min(minY, e.y - h / 2);
    maxX = Math.max(maxX, e.x + w / 2);
    maxY = Math.max(maxY, e.y + h / 2);
  }
  for (const t of bp.tiles ?? []) {
    minX = Math.min(minX, t.position.x);
    minY = Math.min(minY, t.position.y);
    maxX = Math.max(maxX, t.position.x + 1);
    maxY = Math.max(maxY, t.position.y + 1);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX: Math.floor(minX), minY: Math.floor(minY), maxX: Math.ceil(maxX), maxY: Math.ceil(maxY) };
}

/** Moves every entity and tile by a whole number of tiles. */
export function shiftContents(bp: Blueprint, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const e of bp.entities ?? []) e.position = { x: e.position.x + dx, y: e.position.y + dy };
  for (const t of bp.tiles ?? []) t.position = { x: t.position.x + dx, y: t.position.y + dy };
}

/** What the blueprint is made of — entity and tile names with counts,
 *  most numerous first, like the game's Components list. */
export function components(bp: Blueprint): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of bp.entities ?? []) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  for (const t of bp.tiles ?? []) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
