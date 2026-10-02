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
import { BuildCache, reportCache } from "./build-cache.js";

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
const CACHE_PATH = path.join(SITE_PUBLIC, "data/.build-cache.json");

/** Shared by all three extraction steps; written once at the end.
 *
 *  --force rebuilds everything by starting from an empty set of previous
 *  stamps, but still WRITES to the real cache path — so a forced run leaves
 *  the next run fast rather than discarding the cache or littering a second
 *  file next to the data. */
const FORCE = process.argv.includes("--force");
const cache = new BuildCache(CACHE_PATH, { ignorePrevious: FORCE });

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
  let reused = 0;
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
    // Skip sheets whose source has not moved since the last run AND whose
    // copy is still on disk. Deliberately keyed on the file in the Factorio
    // install: crop-sprite-sheets later rewrites `dest` in place, so
    // stamping the destination would make every run see it as changed.
    //
    // A cache hit here means the destination is whatever the last run left
    // — which, after a crop, is the CROPPED file, not a fresh copy. That is
    // the point: re-copying would undo the crop and force it to run again.
    if (cache.isFresh(src, [dest])) {
      reused++;
      continue;
    }
    copyFileSync(src, dest);
    copied++;
  }
  const reusedNote = reused > 0 ? `, reused ${reused}` : "";
  console.log(`Entity sprites: copied ${copied}${reusedNote}, missing ${missing} -> ${ENTITY_SPRITE_OUT_DIR}`);
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
    // The 5 quality tiers (normal/uncommon/rare/epic/legendary) — same
    // {name, icon} shape as every other table here, keyed by tier name
    // rather than an item/entity name (no collision risk, both namespaces
    // are unrelated strings). Used by the build-menu quality strip and
    // alt-mode's per-entity quality badge, both wanting the real diamond
    // icon Factorio itself uses rather than a plain colored dot.
    "quality",
    // Factorio splits "things that go in an inventory slot" across several
    // prototype types beyond plain `item` — confirmed by spike: science
    // packs are `tool`, not `item`, which is why automation-science-pack's
    // icon was missing entirely despite `item` already being in this list.
    // Every one of these tables is referenced by at least one recipe's
    // ingredients/results in the vanilla+Space Age dump (guns, ammo,
    // capsules, armor, science packs, blueprints/planners, vehicles-as-
    // items), so all are real gaps, not speculative additions.
    "tool",
    "ammo",
    "capsule",
    "gun",
    "armor",
    "repair-tool",
    "rail-planner",
    "spidertron-remote",
    "item-with-entity-data",
    "selection-tool",
    "copy-paste-tool",
    "deconstruction-item",
    "upgrade-item",
    "blueprint",
    "blueprint-book",
    "space-platform-starter-pack",
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

  // The atlas packs every icon into ONE image whose cell layout depends on
  // how many icons there are, so a single changed or added icon invalidates
  // the whole thing — there is no per-file skip to be had here. Freshness is
  // therefore all-or-nothing: every source must be unchanged, and both
  // outputs still present. isFresh() is called for all of them (not
  // short-circuited) so each one's stamp is recorded for the next run.
  const atlasOutputs = [ICON_ATLAS_OUT, ICON_MANIFEST_OUT];
  const stale = entries.map((e) => cache.isFresh(e.file, atlasOutputs)).filter((fresh) => !fresh).length;
  if (stale === 0 && entries.length > 0) {
    console.log(`Packing icon atlas: ${entries.length} icons — unchanged, kept`);
    return;
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
  let reused = 0;
  for (const proto of Object.values(raw["item-group"] ?? {})) {
    const icon = (proto as any).icon;
    if (typeof icon !== "string") continue;
    const src = resolveModPath(icon);
    if (!existsSync(src)) {
      console.warn(`  missing item-group icon: ${src}`);
      missing++;
      continue;
    }
    // One source -> one output, so this skips per file like the sheets do.
    if (cache.isFresh(src, [path.join(outDir, path.basename(src))])) {
      reused++;
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

/** The shortcut-bar buttons' own art (undo, redo, the planners, alt mode,
 *  the wires …), straight from every `shortcut` prototype in the dump — the
 *  quickbar's tool grid draws these, never a stand-in. Each prototype names
 *  its icon by `icon` (or the first layer of `icons`) with an `icon_size`;
 *  like item icons the file may carry smaller mipmap levels to the right, so
 *  only the leftmost icon_size square is kept. Written one PNG per shortcut
 *  as data/sprites/shortcuts/<name>.png, plus a manifest carrying each one's
 *  button `style` (default/red/green/blue), which colours the button behind
 *  the white glyph in game. */
function extractShortcutIcons(): void {
  const raw = JSON.parse(readFileSync(DUMP_PATH, "utf-8")) as Record<string, Record<string, any>>;
  const outDir = path.join(SITE_PUBLIC, "data/sprites/shortcuts");
  const manifestOut = path.join(SITE_PUBLIC, "data/shortcut-icons.json");
  mkdirSync(outDir, { recursive: true });

  const manifest: Record<string, { file: string; size: number; style: string }> = {};
  let copied = 0;
  let missing = 0;
  let reused = 0;
  for (const proto of Object.values(raw["shortcut"] ?? {})) {
    const p = proto as any;
    const layer = typeof p.icon === "string" ? p : Array.isArray(p.icons) ? p.icons[0] : undefined;
    if (!layer || typeof layer.icon !== "string") continue;
    const src = resolveModPath(layer.icon);
    if (!existsSync(src)) {
      console.warn(`  missing shortcut icon: ${src}`);
      missing++;
      continue;
    }
    const iconSize: number = typeof layer.icon_size === "number" ? layer.icon_size : typeof p.icon_size === "number" ? p.icon_size : 64;
    const file = `${p.name}.png`;
    const dest = path.join(outDir, file);
    manifest[p.name] = { file, size: iconSize, style: typeof p.style === "string" ? p.style : "default" };
    if (cache.isFresh(src, [dest])) {
      reused++;
      continue;
    }
    const png = PNG.sync.read(readFileSync(src));
    const cropped = new PNG({ width: iconSize, height: iconSize });
    cropped.data.fill(0);
    PNG.bitblt(png, cropped, 0, 0, Math.min(png.width, iconSize), Math.min(png.height, iconSize), 0, 0);
    writeFileSync(dest, PNG.sync.write(cropped));
    copied++;
  }
  writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));
  console.log(`Shortcut icons: copied ${copied}, reused ${reused}, missing ${missing} -> ${outDir}`);
}

extractEntitySheets();
extractIconAtlas();
extractItemGroupIcons();
extractShortcutIcons();

// Written once, after every step has recorded what it looked at. Entries the
// run never touched are dropped rather than accumulating forever.
cache.save();
reportCache(cache, "incremental");
