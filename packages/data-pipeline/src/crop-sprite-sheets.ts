#!/usr/bin/env tsx
/**
 * Crops every entity sprite sheet down to the cells the renderer actually
 * samples, and rewrites the sprite descriptors so nothing else has to change.
 *
 * Why this exists: Factorio ships one sheet per entity holding every
 * animation frame and facing, but this viewer draws a single static frame
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
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { GameData, RenderCatalog, PlacedEntity } from "@factoriotools/engine";
// Imported from their own modules rather than the package index: these are
// internal renderer pieces, and widening the public surface just so a build
// script can reach them would be the wrong trade.
import {
  buildVisualLookup,
  makeConnectorPredicates,
  activeFluidConnections,
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

const DRY = process.argv.includes("--dry-run");

const gameData: GameData = JSON.parse(readFileSync(GAMEDATA_PATH, "utf-8"));
const catalog: RenderCatalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

const sheetPath = (sheet: string) => path.join(SHEET_DIR, path.basename(sheet));

/** Every sprite object reachable from a layer, whatever its `per` shape. */
function spritesOfLayer(layer: any): any[] {
  if (!("per" in layer)) return [layer.sprites];
  if (layer.per === "heat-connection-patches") return [...(layer.connected ?? []), ...(layer.disconnected ?? [])];
  if (layer.per === "module-slot") return (layer.slots ?? []).flatMap((s: any) => [s.empty, ...(s.filled ?? [])]);
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
      for (const sh of (sp.sheets ?? (sp.sheet ? [sp.sheet] : [])) as string[]) mark(sh, sp.x ?? 0, sp.y ?? 0);
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
  for (let dir = 0; dir < 16; dir++) {
    const self = () => entity(name, 0.5, 0.5, dir);
    for (const f of FRAMES) for (const c of collect(self(), [], f)) mark(c.sheet, c.sx, c.sy);
    for (let filled = 1; filled <= slots; filled++) {
      const e = entity(name, 0.5, 0.5, dir, { modules: [{ name: "productivity-module", quality: "normal", count: filled }] } as any);
      for (const c of collect(e, [], 0)) mark(c.sheet, c.sx, c.sy);
    }
    for (const kind of NEIGHBOURS) {
      const around = [entity(kind, 3.5, 0.5, 0), entity(kind, -2.5, 0.5, 0),
                      entity(kind, 0.5, 3.5, 0), entity(kind, 0.5, -2.5, 0)];
      for (const n of around) for (const c of collect(self(), [n], 0)) mark(c.sheet, c.sx, c.sy);
      for (const c of collect(self(), around, 0)) mark(c.sheet, c.sx, c.sy);
    }
    // Walls, pipes and belts change art when they chain into their own kind.
    const same = [entity(name, 3.5, 0.5, dir), entity(name, -2.5, 0.5, dir),
                  entity(name, 0.5, 3.5, dir), entity(name, 0.5, -2.5, dir)];
    for (const c of collect(self(), same, 0)) mark(c.sheet, c.sx, c.sy);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Decide what is safe to crop
 * ------------------------------------------------------------------ */
type Plan = { file: string; frameWidth: number; frameHeight: number; cols: number[]; rows: number[] };
const plan = new Map<string, Plan>();
let skippedHoles = 0, skippedFull = 0, skippedConflict = 0;

for (const [sheet, cells] of used) {
  const sp = spriteOf.get(sheet);
  const file = sheetPath(sheet);
  if (!sp || !existsSync(file)) continue;

  const header = readFileSync(file);
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  const fw = sp.frameWidth, fh = sp.frameHeight;
  const totalCols = Math.max(1, Math.floor(width / fw));
  const totalRows = Math.max(1, Math.floor(height / fh));

  const coords = [...cells].map((k) => {
    const [sx, sy] = k.split(",").map(Number);
    return { cx: sx! / fw, cy: sy! / fh };
  });
  // Non-integer indices mean some path addresses part of a frame (the halved
  // belt lanes of `keepSide` do). Such sheets are not cropped.
  if (coords.some((c) => !Number.isInteger(c.cx) || !Number.isInteger(c.cy))) { skippedConflict++; continue; }
  if (conflicting.has(sheet)) { skippedConflict++; continue; }

  const cols = [...new Set(coords.map((c) => c.cx))].sort((a, b) => a - b);
  const rows = [...new Set(coords.map((c) => c.cy))].sort((a, b) => a - b);
  const isPrefix = (l: number[]) => l.every((v, i) => v === i);
  if (!isPrefix(cols) || !isPrefix(rows)) { skippedHoles++; continue; }
  if (cols.length === totalCols && rows.length === totalRows) { skippedFull++; continue; }

  plan.set(path.basename(sheet), { file, frameWidth: fw, frameHeight: fh, cols, rows });
}

/* ------------------------------------------------------------------ *
 * 3. Crop the PNGs
 * ------------------------------------------------------------------ */
let before = 0, after = 0, cropped = 0, alreadyDone = 0;
for (const [, p] of plan) {
  const targetW = p.frameWidth * p.cols.length, targetH = p.frameHeight * p.rows.length;
  const bytes = statSync(p.file).size;
  const head = readFileSync(p.file);
  if (head.readUInt32BE(16) === targetW && head.readUInt32BE(20) === targetH) { alreadyDone++; continue; }

  before += bytes;
  if (DRY) { after += bytes * (p.cols.length * p.rows.length) / Math.max(1, (head.readUInt32BE(16) / p.frameWidth) * (head.readUInt32BE(20) / p.frameHeight)); cropped++; continue; }

  const src = PNG.sync.read(head);
  const out = new PNG({ width: targetW, height: targetH });
  out.data.fill(0);
  p.rows.forEach((srcRow, destRow) =>
    p.cols.forEach((srcCol, destCol) =>
      PNG.bitblt(src, out, srcCol * p.frameWidth, srcRow * p.frameHeight,
                 p.frameWidth, p.frameHeight, destCol * p.frameWidth, destRow * p.frameHeight)));
  writeFileSync(p.file, PNG.sync.write(out));
  after += statSync(p.file).size;
  cropped++;
}

/* ------------------------------------------------------------------ *
 * 4. Rewrite the sprite descriptors
 * ------------------------------------------------------------------ *
 * Both files carry them: render-catalog.json holds the curated layers,
 * game-data.json holds machines/beacons/belts/inserters. Rewriting only one
 * leaves the other pointing into the old grid. */
let rewritten = 0;
function rewriteSprite(sp: any): void {
  const sheets: string[] = sp.sheets ?? (sp.sheet ? [sp.sheet] : []);
  if (!sheets.length || !sp.frameWidth) return;
  const plans = sheets.map((s) => plan.get(path.basename(s)));
  if (plans.some((p) => !p)) return;
  const p = plans[0]!;
  if (plans.some((q) => q!.cols.length !== p.cols.length || q!.rows.length !== p.rows.length)) return;

  // Contiguous prefixes mean index i maps to i, so only the origin moves —
  // and since the origin itself is inside the kept block, it stays put.
  // `columns`/`rowsPerSheet` bound the modulo in push() and must not point
  // past the smaller sheet.
  if (typeof sp.columns === "number") sp.columns = Math.min(sp.columns, p.cols.length);
  if (typeof sp.rowsPerSheet === "number") sp.rowsPerSheet = Math.min(sp.rowsPerSheet, p.rows.length);
  rewritten++;
}
function walk(node: any): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) walk(n); return; }
  if (typeof node.sheet === "string" || Array.isArray(node.sheets)) rewriteSprite(node);
  for (const v of Object.values(node)) walk(v);
}
for (const e of Object.values<any>(catalog.entities)) walk(e.graphics);
walk(gameData);
if (!DRY) {
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
  writeFileSync(GAMEDATA_PATH, JSON.stringify(gameData));
}

const MB = (b: number) => (b / 1048576).toFixed(1) + " MB";
console.log(`Sprite sheets cropped: ${cropped}${alreadyDone ? `, ${alreadyDone} already cropped` : ""}`);
console.log(`  ${MB(before)} -> ${MB(after)}${before ? `  (-${(100 - after / before * 100).toFixed(1)}%)` : ""}`);
console.log(`  left whole: ${skippedFull} fully used, ${skippedHoles} with gaps, ${skippedConflict} ambiguous`);
console.log(`  descriptors bounded: ${rewritten}${DRY ? "  (dry run — nothing written)" : ""}`);
