#!/usr/bin/env tsx
/**
 * Merges every rail entity (ground and elevated rails, ramps, supports,
 * signals, and the locomotives and wagons that run on them) into
 * the committed render-catalog.json from a rail-only prototype export,
 * without needing the full dump or a Factorio install — and copies the
 * sprite sheets those entries reference into the site's public assets.
 *
 * The full pipeline (dump-to-gamedata → extract-sprites) produces the same
 * entries; this exists for when only the rail data is at hand. Inputs:
 *
 *   RAIL_DUMP     a JSON object of prototype tables, e.g. a rail-only
 *                 rail-data/rail-prototypes.json (docs/rails.md says how
 *                 to export one), or the whole data-raw-dump.json
 *   RAIL_SPRITES  root holding the referenced PNGs by mod path
 *                 (rail-data/sprites, or Factorio's Contents/data)
 *
 *   RAIL_DUMP=… RAIL_SPRITES=… npm run merge-rail-catalog --workspace=@factoriotools/data-pipeline
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EntityGraphics, RenderCatalog } from "@factoriotools/engine";
import { buildRenderCatalog } from "./render-catalog.js";
import type { LocaleTables } from "./locale.js";
import { PACKED_PREFIX, ROLLING_STOCK_TABLES, packRollingStock } from "./pack-rolling-stock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../apps/site/public/data");
const CATALOG_PATH = path.join(DATA_DIR, "render-catalog.json");
const MANIFEST_PATH = path.join(DATA_DIR, "sprite-source-manifest.json");
const SPRITE_OUT_DIR = path.join(DATA_DIR, "sprites/entities");

const RAIL_TABLES = [
  "straight-rail",
  "half-diagonal-rail",
  "curved-rail-a",
  "curved-rail-b",
  "elevated-straight-rail",
  "elevated-half-diagonal-rail",
  "elevated-curved-rail-a",
  "elevated-curved-rail-b",
  "rail-ramp",
  "rail-support",
  "rail-signal",
  "rail-chain-signal",
  ...ROLLING_STOCK_TABLES,
];

/** The game's English names — the rail export carries no locale files. */
const NAMES: Record<string, string> = {
  "straight-rail": "Straight rail",
  "half-diagonal-rail": "Half diagonal rail",
  "curved-rail-a": "Curved rail",
  "curved-rail-b": "Curved rail",
  "elevated-straight-rail": "Elevated straight rail",
  "elevated-half-diagonal-rail": "Elevated half diagonal rail",
  "elevated-curved-rail-a": "Elevated curved rail",
  "elevated-curved-rail-b": "Elevated curved rail",
  "rail-ramp": "Rail ramp",
  "rail-support": "Rail support",
  "rail-signal": "Rail signal",
  "rail-chain-signal": "Rail chain signal",
  locomotive: "Locomotive",
  "cargo-wagon": "Cargo wagon",
  "fluid-wagon": "Fluid wagon",
  "artillery-wagon": "Artillery wagon",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see this script's header`);
  return value;
}

function sheetsOf(graphics: EntityGraphics | undefined): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.sheet === "string") out.add(o.sheet);
    if (Array.isArray(o.sheets)) for (const s of o.sheets) if (typeof s === "string") out.add(s);
    for (const child of Object.values(o)) visit(child);
  };
  visit(graphics);
  return [...out];
}

const dump = JSON.parse(readFileSync(required("RAIL_DUMP"), "utf-8")) as Record<string, Record<string, unknown>>;
const spriteRoot = required("RAIL_SPRITES");

// RAIL_ONLY (comma-separated table names) narrows the merge, leaving every
// other entry of the committed catalog as it is.
const only = process.env.RAIL_ONLY?.split(",");
const raw = Object.fromEntries(RAIL_TABLES.filter((t) => dump[t] && (!only || only.includes(t))).map((t) => [t, dump[t]]));
const locale: LocaleTables = {
  entityName: new Map(Object.entries(NAMES)),
  itemName: new Map(),
  recipeName: new Map(),
  fluidName: new Map(),
  virtualSignalName: new Map(),
  itemGroupName: new Map(),
  technologyName: new Map(),
};

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as RenderCatalog;
const rails = buildRenderCatalog(raw as never, locale, catalog.version);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as { dataRoot: string; files: string[] };
const files = new Set(manifest.files);
// Sheets are copied, and later looked up, by file name alone; two different
// sheets sharing a name would silently load the same image.
const sheetByBasename = new Map<string, string>();
const claimBasename = (sheet: string) => {
  const basename = path.basename(sheet);
  const previous = sheetByBasename.get(basename);
  if (previous && previous !== sheet) throw new Error(`sprite file name collision: ${previous} and ${sheet}`);
  sheetByBasename.set(basename, sheet);
  return basename;
};
for (const sheet of files) claimBasename(sheet);

let copied = 0;
for (const [name, entry] of Object.entries(rails.entities)) {
  if (!entry.graphics) {
    console.warn(`  no graphics: ${name}`);
    continue;
  }
  catalog.entities[name] = entry;
  for (const sheet of sheetsOf(entry.graphics)) {
    // Packed sheets are written below, not copied from the game.
    if (sheet.startsWith(PACKED_PREFIX)) continue;
    const basename = claimBasename(sheet);
    files.add(sheet);
    const src = path.join(spriteRoot, sheet);
    const dest = path.join(SPRITE_OUT_DIR, basename);
    if (existsSync(dest)) continue;
    if (!existsSync(src)) throw new Error(`missing sprite sheet: ${src}`);
    copyFileSync(src, dest);
    copied++;
  }
  console.log(`  ${name}: ${entry.graphics.layers.length} layers`);
}

// A rail export keeps the game's __mod__ folders; the install itself drops
// the underscores.
const resolveSprite = (modPath: string) => {
  const direct = path.join(spriteRoot, modPath);
  return existsSync(direct) ? direct : path.join(spriteRoot, modPath.replace(/^__([a-z0-9_-]+)__\//, "$1/"));
};
const stock = ROLLING_STOCK_TABLES.flatMap((t) => Object.values(raw[t] ?? {}));
const packed = packRollingStock(stock, resolveSprite, SPRITE_OUT_DIR, process.argv.includes("--force"));
if (stock.length > 0) console.log(`packed ${packed} rolling stock sheets`);

writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, files: [...files].sort() }, null, 2));
console.log(`merged ${Object.keys(rails.entities).length} rail entities, copied ${copied} sheets`);
