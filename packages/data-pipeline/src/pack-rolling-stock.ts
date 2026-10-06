/**
 * Packs the art for rolling stock (locomotives and wagons) into one small
 * sheet per layer.
 *
 * The game ships a wagon's body as 128 or 256 headings spread over 4–8
 * files, about 40 MB per kind, for trains that turn smoothly as they drive.
 * A blueprint's trains stand still, mostly on straight track, so the editor
 * keeps every eighth heading: STOCK_HEADINGS around the full turn (half that
 * for stock that looks the same from either end). The colour mask is baked
 * into the body with the prototype's own colour, since the renderer has no
 * runtime tint.
 *
 * rollingStockGraphics (render-catalog.ts) describes the packed sheets;
 * packRollingStock here writes them. Both read the same layout from
 * rollingStockLayout, so they cannot drift apart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

export const ROLLING_STOCK_TABLES = ["locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon"];

/** Headings kept around a full turn. */
export const STOCK_HEADINGS = 32;
/** Frames per row of a packed sheet. */
export const STOCK_LINE_LENGTH = 8;
/** Mod-path prefix of sheets this packer writes rather than the game. */
export const PACKED_PREFIX = "__packed__/";

export interface StockLayerLayout {
  /** The packed sheet's mod-style path; its basename is the file name. */
  sheet: string;
  /** The game layer the frames come from. */
  source: any;
  /** Tint masks baked over `source`. */
  masks: any[];
  shadow: boolean;
  /** Frames kept, and how many source frames lie between two of them. */
  count: number;
  stride: number;
  halfTurn: boolean;
}

/** How a stock prototype's rotated layers map onto packed sheets: one for
 *  the body (with its masks) and one for the shadow. */
export function rollingStockLayout(proto: any): StockLayerLayout[] {
  const layers: any[] = proto.pictures?.rotated?.layers ?? [];
  const isMask = (l: any) => l.apply_runtime_tint || l.flags?.includes("mask");
  const isShadow = (l: any) => l.draw_as_shadow || l.flags?.includes("shadow");
  const out: StockLayerLayout[] = [];
  for (const source of layers) {
    if (isMask(source) || !Array.isArray(source.filenames)) continue;
    const shadow = !!isShadow(source);
    const halfTurn = !!source.back_equals_front;
    const count = halfTurn ? STOCK_HEADINGS / 2 : STOCK_HEADINGS;
    if (source.direction_count % count !== 0) continue;
    out.push({
      sheet: `${PACKED_PREFIX}rolling-stock/${proto.name}${shadow ? "-shadow" : ""}.png`,
      source,
      masks: shadow ? [] : layers.filter((l) => isMask(l) && l.direction_count === source.direction_count),
      shadow,
      count,
      stride: source.direction_count / count,
      halfTurn,
    });
  }
  return out;
}

/** Reads the frames of a multi-file rotated layer, one file at a time. */
function frameReader(layer: any, resolve: (modPath: string) => string) {
  const files = new Map<number, PNG>();
  const perFile = layer.line_length * layer.lines_per_file;
  return (index: number): { png: PNG; x: number; y: number } => {
    const fileIndex = Math.floor(index / perFile);
    let png = files.get(fileIndex);
    if (!png) {
      png = PNG.sync.read(readFileSync(resolve(layer.filenames[fileIndex])));
      files.set(fileIndex, png);
    }
    const within = index % perFile;
    return { png, x: (within % layer.line_length) * layer.width, y: Math.floor(within / layer.line_length) * layer.height };
  };
}

/** Writes every packed sheet the given prototypes need into `outDir`,
 *  skipping ones already there unless `force`. Returns how many it wrote. */
export function packRollingStock(protos: any[], resolve: (modPath: string) => string, outDir: string, force = false): number {
  mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const proto of protos) {
    for (const layout of rollingStockLayout(proto)) {
      const dest = path.join(outDir, path.basename(layout.sheet));
      if (existsSync(dest) && !force) continue;
      const { source, masks, count, stride } = layout;
      const rows = Math.ceil(count / STOCK_LINE_LENGTH);
      const out = new PNG({ width: STOCK_LINE_LENGTH * source.width, height: rows * source.height });
      out.data.fill(0);
      const read = frameReader(source, resolve);
      const maskReads = masks.map((m) => frameReader(m, resolve));
      const tint = proto.color ?? { r: 1, g: 1, b: 1, a: 1 };
      for (let i = 0; i < count; i++) {
        const dx = (i % STOCK_LINE_LENGTH) * source.width;
        const dy = Math.floor(i / STOCK_LINE_LENGTH) * source.height;
        const frame = read(i * stride);
        PNG.bitblt(frame.png, out, frame.x, frame.y, source.width, source.height, dx, dy);
        masks.forEach((mask, m) => {
          const mf = maskReads[m]!(i * stride);
          // Both layers are centred on their own shift; a tile is 32 px at
          // scale 1.
          const pxPerTile = 32 / (source.scale ?? 1);
          const ox = Math.round(source.width / 2 + ((mask.shift?.[0] ?? 0) - (source.shift?.[0] ?? 0)) * pxPerTile - mask.width / 2);
          const oy = Math.round(source.height / 2 + ((mask.shift?.[1] ?? 0) - (source.shift?.[1] ?? 0)) * pxPerTile - mask.height / 2);
          for (let y = 0; y < mask.height; y++) {
            const ty = y + oy;
            if (ty < 0 || ty >= source.height) continue;
            for (let x = 0; x < mask.width; x++) {
              const tx = x + ox;
              if (tx < 0 || tx >= source.width) continue;
              const s = ((mf.y + y) * mf.png.width + mf.x + x) * 4;
              const alpha = mf.png.data[s + 3]! / 255;
              if (alpha === 0) continue;
              const d = ((dy + ty) * out.width + dx + tx) * 4;
              // Only repaint what the body already covers.
              if (out.data[d + 3] === 0) continue;
              const keep = 1 - alpha * (tint.a ?? 1);
              out.data[d] = Math.min(255, mf.png.data[s]! * alpha * tint.r + out.data[d]! * keep);
              out.data[d + 1] = Math.min(255, mf.png.data[s + 1]! * alpha * tint.g + out.data[d + 1]! * keep);
              out.data[d + 2] = Math.min(255, mf.png.data[s + 2]! * alpha * tint.b + out.data[d + 2]! * keep);
            }
          }
        });
      }
      writeFileSync(dest, PNG.sync.write(out));
      written++;
    }
  }
  return written;
}
