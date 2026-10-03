#!/usr/bin/env tsx
/**
 * Merges every rail entity (ground and elevated rails, ramps, supports) into
 * the committed render-catalog.json from a rail-only prototype export,
 * without needing the full dump or a Factorio install — and copies the
 * sprite sheets those entries reference into the site's public assets.
 *
 * The full pipeline (dump-to-gamedata → extract-sprites) produces the same
 * entries; this exists for when only the rail data is at hand. Inputs:
 *
 *   RAIL_DUMP     a JSON object of prototype tables, e.g. rail-data/
 *                 rail-prototypes.json from the claude/rail-pipeline-data
 *                 branch, or the whole data-raw-dump.json
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

const raw = Object.fromEntries(RAIL_TABLES.filter((t) => dump[t]).map((t) => [t, dump[t]]));
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

let copied = 0;
for (const [name, entry] of Object.entries(rails.entities)) {
  if (!entry.graphics) {
    console.warn(`  no graphics: ${name}`);
    continue;
  }
  catalog.entities[name] = entry;
  for (const sheet of sheetsOf(entry.graphics)) {
    files.add(sheet);
    const src = path.join(spriteRoot, sheet);
    const dest = path.join(SPRITE_OUT_DIR, path.basename(sheet));
    if (existsSync(dest)) continue;
    if (!existsSync(src)) throw new Error(`missing sprite sheet: ${src}`);
    copyFileSync(src, dest);
    copied++;
  }
  console.log(`  ${name}: ${entry.graphics.layers.length} layers`);
}

writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, files: [...files].sort() }, null, 2));
console.log(`merged ${Object.keys(rails.entities).length} rail entities, copied ${copied} sheets`);
