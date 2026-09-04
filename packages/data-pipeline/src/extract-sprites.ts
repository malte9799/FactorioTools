#!/usr/bin/env tsx
/**
 * Copies the entity sprite sheets referenced by game-data.json (see
 * sprite-source-manifest.json, written by dump-to-gamedata.ts) out of the
 * Factorio install and into the site's public assets, and builds one packed
 * icon atlas for panel/tooltip icons from each item/entity's `icon` field.
 *
 * Only copies what's referenced, not the whole graphics tree. Run manually,
 * never in CI:
 *   npm run extract-sprites --workspace=@factoriotools/data-pipeline
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FACTORIO_DATA_ROOT =
  process.env.FACTORIO_DATA ?? "/Applications/factorio.app/Contents/data";
const DUMP_PATH =
  process.env.FACTORIO_DUMP ??
  path.join(
    process.env.HOME ?? "",
    "Library/Application Support/factorio/script-output/data-raw-dump.json",
  );

const SITE_PUBLIC = path.resolve(__dirname, "../../../apps/site/public");
const MANIFEST_PATH = path.join(SITE_PUBLIC, "data/sprite-source-manifest.json");
const ENTITY_SPRITE_OUT_DIR = path.join(SITE_PUBLIC, "data/sprites/entities");
const ICON_ATLAS_OUT = path.join(SITE_PUBLIC, "data/sprites/icons.png");
const ICON_MANIFEST_OUT = path.join(SITE_PUBLIC, "data/sprite-icon-manifest.json");

/** Factorio prototype paths are namespaced by mod, e.g.
 *  "__base__/graphics/entity/...", "__space-age__/graphics/...". Maps
 *  directly onto Contents/data/<mod>/... once the __mod__ wrapper is
 *  stripped — confirmed by the dump spike (assembling-machine-2's sheet
 *  filename resolved exactly this way against the real install). */
function resolveModPath(modPath: string): string {
  const match = /^__([a-z0-9_-]+)__\/(.+)$/.exec(modPath);
  if (!match) throw new Error(`Unrecognised mod-relative path: ${modPath}`);
  const [, mod, rest] = match;
  return path.join(FACTORIO_DATA_ROOT, mod!, rest!);
}

function extractEntitySheets(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
    dataRoot: string;
    files: string[];
  };

  mkdirSync(ENTITY_SPRITE_OUT_DIR, { recursive: true });
  let copied = 0;
  let missing = 0;
  for (const file of manifest.files) {
    const src = resolveModPath(file);
    if (!existsSync(src)) {
      console.warn(`  missing: ${src}`);
      missing++;
      continue;
    }
    // Flatten into one directory, keeping the basename — collisions are
    // avoided because Factorio's own filenames are already unique per
    // entity (e.g. "assembling-machine-2.png", not "sheet.png").
    const dest = path.join(ENTITY_SPRITE_OUT_DIR, path.basename(src));
    copyFileSync(src, dest);
    copied++;
  }
  console.log(`Entity sprites: copied ${copied}, missing ${missing} -> ${ENTITY_SPRITE_OUT_DIR}`);
}

/** Icons are one small PNG per prototype (confirmed by spike: `icon` is a
 *  plain file path, not a spritesheet with a frame index) — pack them into a
 *  single local atlas with a uniform grid. A naive grid is enough at this
 *  scale (a few hundred icons). */
function extractIconAtlas(): void {
  const raw = JSON.parse(readFileSync(DUMP_PATH, "utf-8")) as Record<string, Record<string, any>>;

  const ICON_TABLES = [
    "item",
    "fluid",
    "recipe",
    "assembling-machine",
    "furnace",
    "mining-drill",
    "lab",
    "module",
    "beacon",
    "transport-belt",
    "underground-belt",
    "splitter",
    "inserter",
    "pipe",
    "electric-pole",
    "rocket-silo",
  ];

  const entries: { id: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const table of ICON_TABLES) {
    for (const proto of Object.values(raw[table] ?? {})) {
      if (seen.has(proto.name)) continue;
      const icon = proto.icon;
      if (typeof icon !== "string") continue;
      const resolved = resolveModPath(icon);
      if (!existsSync(resolved)) continue;
      entries.push({ id: proto.name, file: resolved });
      seen.add(proto.name);
    }
  }

  console.log(`Packing icon atlas: ${entries.length} icons`);

  const CELL = 64;
  const columns = Math.ceil(Math.sqrt(entries.length));
  const rows = Math.ceil(entries.length / columns);
  const atlas = new PNG({ width: columns * CELL, height: rows * CELL });
  // Fully transparent background so unfilled cells (packing failures,
  // partial last row) don't render as opaque black.
  atlas.data.fill(0);

  const positions: { id: string; x: number; y: number; w: number; h: number }[] = [];
  entries.forEach((entry, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const destX = col * CELL;
    const destY = row * CELL;
    try {
      const png = PNG.sync.read(readFileSync(entry.file));
      // Icon files are mipmap strips (confirmed by spike: iron-plate.png is
      // 120x64 with no icon_size/icon_mipmaps override — that's the base
      // 64px level plus 32+16+8px levels concatenated horizontally, summing
      // to 120). Only the leftmost 64x64 (the full-res level) is wanted.
      const copyW = Math.min(png.width, CELL);
      const copyH = Math.min(png.height, CELL);
      PNG.bitblt(png, atlas, 0, 0, copyW, copyH, destX, destY);
      positions.push({ id: entry.id, x: destX, y: destY, w: CELL, h: CELL });
    } catch (err) {
      console.warn(`  skip ${entry.id}: ${(err as Error).message}`);
    }
  });

  mkdirSync(path.dirname(ICON_ATLAS_OUT), { recursive: true });
  writeFileSync(ICON_ATLAS_OUT, PNG.sync.write(atlas));
  writeFileSync(ICON_MANIFEST_OUT, JSON.stringify({ cell: CELL, sheetWidth: columns * CELL, sheetHeight: rows * CELL, icons: positions }));
  console.log(`Wrote ${ICON_ATLAS_OUT} (${columns}x${rows} cells) and ${ICON_MANIFEST_OUT}`);
}

/** Build-menu tab icons (item-group.icon) are each their own whole-image
 *  PNG (logistics.png, production.png, ...) — confirmed by spike, NOT a
 *  cell in the shared item/recipe icon sheet extractIconAtlas() builds.
 *  Cropped to the prototype's own `icon_size` (defaulting to 64, Factorio's
 *  own documented default) the same way extractIconAtlas() strips mipmaps
 *  off regular item icons — confirmed by spike that e.g. logistics.png is
 *  192x128 while its own icon_size is 128: the real icon is only the
 *  leftmost icon_size x icon_size square, the rest a smaller mipmap level
 *  the game ignores by default (no icon_mipmaps override here), which a
 *  plain file copy left in the image and rendered squeezed into the tab
 *  alongside the real icon. */
function extractItemGroupIcons(): void {
  const raw = JSON.parse(readFileSync(DUMP_PATH, "utf-8")) as Record<string, Record<string, any>>;
  const outDir = path.join(SITE_PUBLIC, "data/sprites/item-groups");
  mkdirSync(outDir, { recursive: true });

  let copied = 0;
  let missing = 0;
  for (const proto of Object.values(raw["item-group"] ?? {})) {
    const icon = (proto as any).icon;
    if (typeof icon !== "string") continue;
    const src = resolveModPath(icon);
    if (!existsSync(src)) {
      console.warn(`  missing item-group icon: ${src}`);
      missing++;
      continue;
    }
    const iconSize = typeof (proto as any).icon_size === "number" ? (proto as any).icon_size : 64;
    const png = PNG.sync.read(readFileSync(src));
    const cropped = new PNG({ width: iconSize, height: iconSize });
    cropped.data.fill(0);
    PNG.bitblt(png, cropped, 0, 0, Math.min(png.width, iconSize), Math.min(png.height, iconSize), 0, 0);
    writeFileSync(path.join(outDir, path.basename(src)), PNG.sync.write(cropped));
    copied++;
  }
  console.log(`Item-group icons: copied ${copied}, missing ${missing} -> ${outDir}`);
}

extractEntitySheets();
extractIconAtlas();
extractItemGroupIcons();
