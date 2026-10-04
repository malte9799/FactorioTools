import type { BpTile, TileProto } from "@factoriotools/engine";
import type { SpriteAtlas } from "../spriteAtlas.js";

/** One square of floor ready to paint: `size` x `size` tiles at (x, y),
 *  sampled from a square of `sw` sheet pixels. A tile with no art (or an
 *  unknown one) has no sheet and paints as a flat `color`. */
export interface TileCommand {
  sheet?: string;
  sx: number;
  sy: number;
  sw: number;
  x: number;
  y: number;
  size: number;
  color: string;
}

export interface TileScene {
  commands: TileCommand[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const UNKNOWN_TILE_COLOR = "#4a4844";

/** A stable 0..1 value per block, so the same blueprint always picks the
 *  same floor variants. */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul((x | 0) ^ 0x9e3779b1, 0x85ebca6b);
  h = Math.imul((h ^ (h >>> 15)) + (y | 0), 0x27d4eb2d);
  h = Math.imul((h ^ (h >>> 13)) + salt, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Resolves a blueprint's tiles to paint commands: which picture each one
 *  samples, with the larger pictures (a 2x2 or 4x4 slab) used where a whole
 *  aligned block is the same tile. Done once per tile list, not per frame. */
export function collectTiles(tiles: BpTile[], protos: Record<string, TileProto> | undefined): TileScene {
  const byPosition = new Map<string, string>();
  for (const t of tiles) byPosition.set(`${Math.floor(t.position.x)},${Math.floor(t.position.y)}`, t.name);

  const commands: TileCommand[] = [];
  const done = new Set<string>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [key, name] of byPosition) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1);
    maxY = Math.max(maxY, y + 1);
    if (done.has(key)) continue;

    const proto = protos?.[name];
    const color = proto?.mapColor ?? UNKNOWN_TILE_COLOR;
    let placed = false;
    for (const variant of proto?.variants ?? []) {
      const { size } = variant;
      const bx = Math.floor(x / size) * size;
      const by = Math.floor(y / size) * size;
      const picture = Math.floor(hash(bx, by, size) * variant.count) % variant.count;
      const px = variant.x + (picture % variant.lineLength) * size * variant.tilePx;
      const py = variant.y + Math.floor(picture / variant.lineLength) * size * variant.tilePx;
      if (variant.repeats) {
        commands.push({
          sheet: variant.sheet, sx: px + (x - bx) * variant.tilePx, sy: py + (y - by) * variant.tilePx, sw: variant.tilePx,
          x, y, size: 1, color,
        });
        placed = true;
        break;
      }
      if (size > 1) {
        if (hash(bx, by, size + 101) >= variant.probability) continue;
        let whole = true;
        for (let dy = 0; dy < size && whole; dy++) {
          for (let dx = 0; dx < size; dx++) {
            const k = `${bx + dx},${by + dy}`;
            if (byPosition.get(k) !== name || done.has(k)) {
              whole = false;
              break;
            }
          }
        }
        if (!whole) continue;
        for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) done.add(`${bx + dx},${by + dy}`);
      }
      commands.push({ sheet: variant.sheet, sx: px, sy: py, sw: size * variant.tilePx, x: bx, y: by, size, color });
      placed = true;
      break;
    }
    if (!placed) commands.push({ sx: 0, sy: 0, sw: 0, x, y, size: 1, color });
    done.add(key);
  }
  return { commands, bounds: commands.length ? { minX, minY, maxX, maxY } : null };
}

/** Paints the floor under everything else. Expects the world transform to
 *  be set on `ctx`; draws in device pixels with every edge rounded, so
 *  neighbouring tiles meet exactly instead of leaving a hairline of
 *  background between them at fractional zooms. Returns false while any
 *  visible tile is still waiting on its sheet (painted flat meanwhile; a
 *  sheet that failed to load stays flat and is not waited on). */
export function paintTiles(ctx: CanvasRenderingContext2D, atlas: SpriteAtlas, commands: TileCommand[]): boolean {
  if (commands.length === 0) return true;
  const m = ctx.getTransform();
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  let complete = true;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const c of commands) {
    const x0 = Math.round(m.a * c.x + m.e);
    const y0 = Math.round(m.d * c.y + m.f);
    const x1 = Math.round(m.a * (c.x + c.size) + m.e);
    const y1 = Math.round(m.d * (c.y + c.size) + m.f);
    if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) continue;
    const image = c.sheet ? atlas.get(c.sheet) : undefined;
    if (image) {
      ctx.drawImage(image, c.sx, c.sy, c.sw, c.sw, x0, y0, x1 - x0, y1 - y0);
    } else {
      if (c.sheet && !atlas.hasFailed(c.sheet)) complete = false;
      ctx.fillStyle = c.color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  ctx.restore();
  return complete;
}
