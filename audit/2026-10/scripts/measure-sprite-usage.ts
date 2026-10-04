#!/usr/bin/env tsx
/** AUDIT 2026-10: measurement-only copy of the cell-collection half of
 *  packages/data-pipeline/src/crop-sprite-sheets.ts. It records the exact
 *  source rect of every sampled cell and reports how many DECODED bytes per
 *  sheet are ever drawn. Writes nothing.
 *
 *    npx tsx audit/2026-10/scripts/measure-sprite-usage.ts
 *
 * Original header follows.
 *
 * Crops every entity sprite sheet down to the cells the renderer actually
 * samples, and rewrites the sprite descriptors so nothing else has to change.
 *
 * Why this exists: Factorio ships one sheet per entity holding every
 * animation frame and facing, but this editor draws a single static frame
 * per entity. A recycler sheet is 64 cells; exactly one of them is ever
 * sampled. Across the set that is ~143 MB of pixels that are downloaded,
 * decoded and uploaded to the GPU without ever being drawn.
 *
 * That cost is not just bandwidth. A Chrome trace of a 30-second session
 * measured 11.7 s (40.6% of all CPU time) inside `drawImage` itself, with
 * 76% of those samples landing while the GPU process was busy — the texture
 * cache thrashing over hundreds of oversized sheets. Individual frames
 * reached 564 ms. Cutting the pixel volume is the fix at the measured cause.
 *
 * HOW IT STAYS CORRECT
 *
 * `collect.ts` addresses a cell as
 *     sx = sprite.x + column * frameWidth
 *     sy = sprite.y + row    * frameHeight
 * where `column`/`row` are computed at runtime from animation phase, facing
 * and neighbours. Those cannot be rewritten from here — but `sprite.x`/`y`
 * can. So a sheet is only cropped when the cells it uses form a CONTIGUOUS
 * PREFIX (0..n-1) on both axes: then index i still lands on cell i and only
 * unused trailing rows/columns fall away. Sheets with holes (transport-belt
 * uses rows 0-3 and 12-19) are left untouched — compacting them would point
 * every index past the gap at the wrong image.
 *
 * The renderer is not modified at all. Verified two ways: 105,924 draw
 * commands compared old-vs-new address byte-identical pixels, and the
 * render-hash regression check is unchanged.
 *
 * Run after extract-sprites:
 *   npm run crop-sprite-sheets --workspace=@factoriotools/data-pipeline
 *
 * Idempotent: a sheet already at its cropped size is skipped, so a second
 * run is a no-op rather than a second (destructive) crop.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GameData, RenderCatalog, PlacedEntity } from "@factoriotools/engine";
// Imported from their own modules rather than the package index: these are
// internal renderer pieces, and widening the public surface just so a build
// script can reach them would be the wrong trade.
import {
  buildVisualLookup,
  makeConnectorPredicates,
  activeFluidConnections,
  isUndergroundLike,
} from "@factoriotools/renderer/src/entityLookup.js";
import { buildGrid } from "@factoriotools/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "@factoriotools/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "@factoriotools/renderer/src/neighbours/heat.js";
import { collectEntity } from "@factoriotools/renderer/src/draw/collect.js";
import type { DrawCommand } from "@factoriotools/renderer/src/draw/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_PUBLIC = path.resolve(__dirname, "../../../apps/site/public");
const SHEET_DIR = path.join(SITE_PUBLIC, "data/sprites/entities");
const CATALOG_PATH = path.join(SITE_PUBLIC, "data/render-catalog.json");
const GAMEDATA_PATH = path.join(SITE_PUBLIC, "data/game-data.json");


const gameData: GameData = JSON.parse(readFileSync(GAMEDATA_PATH, "utf-8"));
const catalog: RenderCatalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

const sheetPath = (sheet: string) => path.join(SHEET_DIR, path.basename(sheet));

/** Every sprite object reachable from a layer, whatever its `per` shape. */
function spritesOfLayer(layer: any): any[] {
  if (!("per" in layer)) return [layer.sprites];
  if (layer.per === "heat-connection-patches") return [...(layer.connected ?? []), ...(layer.disconnected ?? [])];
  if (layer.per === "module-slot") return (layer.slots ?? []).flatMap((s: any) => [s.empty, ...(s.filled ?? []).map((p: any) => p.sprite)]);
  return Object.values(layer.sprites ?? {});
}

/* ------------------------------------------------------------------ *
 * 1. Which cells does the renderer actually sample?
 * ------------------------------------------------------------------ */

// The cell grid is defined by frame SIZE alone. A `per:"dir4"` layer points
// four sprites at one sheet with different `x` origins (0, 386, 772, 1158) —
// that is four columns of one grid, not a conflict. Differing frame sizes
// would mean no shared grid at all, and those sheets are left alone.
const spriteOf = new Map<string, any>();
const conflicting = new Set<string>();
for (const [, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    for (const sp of spritesOfLayer(layer)) {
      if (!sp?.frameWidth) continue;
      for (const sh of (sp.sheets ?? (sp.sheet ? [sp.sheet] : [])) as string[]) {
        const prev = spriteOf.get(sh);
        if (!prev) { spriteOf.set(sh, sp); continue; }
        if (prev.frameWidth !== sp.frameWidth || prev.frameHeight !== sp.frameHeight) conflicting.add(sh);
      }
    }
  }
}

const used = new Map<string, Set<string>>();
const rects = new Map<string, Set<string>>();
const rect = (sheet: string, sx: number, sy: number, sw: number, sh: number) => {
  let s = rects.get(sheet);
  if (!s) rects.set(sheet, (s = new Set()));
  s.add(`${sx},${sy},${sw},${sh}`);
};
const mark = (sheet: string, sx: number, sy: number) => {
  let s = used.get(sheet);
  if (!s) used.set(sheet, (s = new Set()));
  s.add(`${sx},${sy}`);
};

// Every origin declared in the data counts as used, whether or not the
// simulation below reaches it. `per:"connection"` entities (cargo-landing-pad)
// carry 16 precomputed cell positions that neighbour simulation only partly
// hits; missing one would silently drop a sprite from the finished product.
for (const [, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    for (const sp of spritesOfLayer(layer)) {
      if (!sp?.frameWidth) continue;
      for (const sh of (sp.sheets ?? (sp.sheet ? [sp.sheet] : [])) as string[]) {
        mark(sh, sp.x ?? 0, sp.y ?? 0);
        rect(sh, sp.x ?? 0, sp.y ?? 0, sp.frameWidth, sp.frameHeight);
        // A fluid-point layer names its state columns outright; the
        // neighbour simulation below never builds a second reactor or a
        // plasma feed, so those states would otherwise be cropped away.
        if (layer.per === "fluid-point") {
          for (const col of Object.values<number>(layer.columns ?? {})) mark(sh, (sp.x ?? 0) + col * sp.frameWidth, sp.y ?? 0);
        }
      }
    }
  }
}

function entity(name: string, x: number, y: number, direction: number, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return {
    entityNumber: Math.round(Math.abs(x) * 977 + Math.abs(y) * 131 + direction) + 1,
    name, x, y, direction, quality: "normal", modules: [], filterItems: [], ...extra,
  } as PlacedEntity;
}

function collect(self: PlacedEntity, others: PlacedEntity[], frame: number): DrawCommand[] {
  const all = [self, ...others];
  const ctx: any = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, (e as any).recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    platformBoxes: all.map((e) => ({ entityNumber: e.entityNumber, left: e.x - 1.5, top: e.y - 1.5, right: e.x + 1.5, bottom: e.y + 1.5 })),
    animationFrame: frame,
  };
  const out: DrawCommand[] = [];
  const v = lookup.get(self.name);
  if (!v?.graphics) return out;
  // A state some entity rejects is not interesting here — the other states
  // still contribute, and an unreachable one contributes no cells either.
  try { collectEntity(out, self, v, ctx, 1); } catch { return []; }
  return out;
}

// `animationFrame` is taken modulo each sprite's own column count, so a dense
// low range plus a few large values covers every period the data uses.
const FRAMES = [...Array(64).keys(), 71, 89, 100, 127, 128, 191, 255, 256, 359, 511, 512, 1023];
const NEIGHBOURS = ["pipe", "heat-pipe", "transport-belt", "fast-transport-belt",
                    "express-transport-belt", "turbo-transport-belt", "small-electric-pole"];

for (const [name, visual] of lookup) {
  if (!(visual as any).graphics) continue;
  const slots = (visual as any).moduleSlots ?? 0;
  // An underground/loader only draws as one with a real undergroundType
  // (see isUndergroundLike) — try both halves.
  const types = isUndergroundLike(name) ? (["input", "output"] as const) : [undefined];
  for (let dir = 0; dir < 16; dir++) for (const undergroundType of types) {
    const self = () => entity(name, 0.5, 0.5, dir, { undergroundType });
    for (const f of FRAMES) for (const c of collect(self(), [], f)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
    // Beacon slot art has one column per module tier, so fill with each.
    for (const module of ["speed-module", "speed-module-2", "speed-module-3"]) {
      for (let filled = 1; filled <= slots; filled++) {
        const e = entity(name, 0.5, 0.5, dir, { undergroundType, modules: [{ name: module, quality: "normal", count: filled }] } as any);
        for (const c of collect(e, [], 0)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
      }
    }
    for (const kind of NEIGHBOURS) {
      const around = [entity(kind, 3.5, 0.5, 0), entity(kind, -2.5, 0.5, 0),
                      entity(kind, 0.5, 3.5, 0), entity(kind, 0.5, -2.5, 0)];
      for (const n of around) for (const c of collect(self(), [n], 0)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
      for (const c of collect(self(), around, 0)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
      // Directly adjacent and facing in, one side at a time — an
      // underground fed from the side swaps to its side-loading rows,
      // which the far-off neighbours above never trigger.
      const feeding = [entity(kind, 1.5, 0.5, 12), entity(kind, -0.5, 0.5, 4),
                       entity(kind, 0.5, 1.5, 0), entity(kind, 0.5, -0.5, 8)];
      for (const n of feeding) for (const c of collect(self(), [n], 0)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
    }
    // Walls, pipes and belts change art when they chain into their own kind.
    const same = [entity(name, 3.5, 0.5, dir, { undergroundType }), entity(name, -2.5, 0.5, dir, { undergroundType }),
                  entity(name, 0.5, 3.5, dir, { undergroundType }), entity(name, 0.5, -2.5, dir, { undergroundType })];
    for (const c of collect(self(), same, 0)) (mark(c.sheet, c.sx, c.sy), rect(c.sheet, c.sx, c.sy, c.sw, c.sh));
  }
}

/* ------------------------------------------------------------------ *
 * Measurement: decoded bytes shipped vs decoded bytes ever sampled
 * ------------------------------------------------------------------ *
 * Union of sampled rects per sheet on an 8 px grid (rects of different
 * frame sizes can overlap on one sheet, so cells are not simply counted). */
const G = 8;
let totalDecoded = 0, usedDecoded = 0;
const rows: { file: string; w: number; h: number; disk: number; decoded: number; used: number }[] = [];
for (const [sheet, set] of rects) {
  const file = sheetPath(sheet);
  if (!existsSync(file)) continue;
  const header = readFileSync(file);
  const w = header.readUInt32BE(16), h = header.readUInt32BE(20);
  const gw = Math.ceil(w / G), gh = Math.ceil(h / G);
  const covered = new Uint8Array(gw * gh);
  for (const key of set) {
    const [x, y, rw, rh] = key.split(",").map(Number) as [number, number, number, number];
    const x0 = Math.max(0, Math.floor(Math.min(x, x + rw) / G)), x1 = Math.min(gw, Math.ceil(Math.max(x, x + rw) / G));
    const y0 = Math.max(0, Math.floor(Math.min(y, y + rh) / G)), y1 = Math.min(gh, Math.ceil(Math.max(y, y + rh) / G));
    for (let cy = y0; cy < y1; cy++) for (let cx = x0; cx < x1; cx++) covered[cy * gw + cx] = 1;
  }
  let cells = 0;
  for (const v of covered) cells += v;
  const decoded = w * h * 4;
  const used = Math.min(cells * G * G * 4, decoded);
  totalDecoded += decoded;
  usedDecoded += used;
  rows.push({ file: path.basename(sheet), w, h, disk: statSync(file).size, decoded, used });
}
rows.sort((a, b) => b.decoded - b.used - (a.decoded - a.used));
const MB = (b: number) => (b / 1e6).toFixed(1).padStart(6) + " MB";
console.log(`${rows.length} sheets referenced; decoded ${MB(totalDecoded)}, ever sampled ${MB(usedDecoded)} (${(100 - (usedDecoded / totalDecoded) * 100).toFixed(1)}% never drawn)`);
for (const r of rows.slice(0, 25)) {
  console.log(`${r.file.padEnd(48)} ${`${r.w}x${r.h}`.padEnd(10)} decoded ${MB(r.decoded)}  sampled ${MB(r.used)}  on disk ${MB(r.disk)}`);
}
