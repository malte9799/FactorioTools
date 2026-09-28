/** Locating the generated dataset, and skipping cleanly when it is absent.
 *
 *  game-data.json, render-catalog.json and the sprite sheets are produced
 *  from a local Factorio install (see the README).
 *
 *  Tests that need real prototype data call requireDataset() at module top
 *  level. Locally, where the dataset exists, it returns the paths and the
 *  suite runs in full. On a machine without it, the suite prints why it is
 *  skipping and exits 0 rather than throwing an unreadable ENOENT — a red CI
 *  badge for a missing local asset says nothing about whether the code is
 *  correct, and would train everyone to ignore the badge.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GameData, RenderCatalog } from "@factoriotools/engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(__dirname, "../../../apps/site/public/data");
export const SPRITE_DIR = path.join(DATA_DIR, "sprites/entities");

const GAME_DATA = path.join(DATA_DIR, "game-data.json");
const CATALOG = path.join(DATA_DIR, "render-catalog.json");

/** True when the generated dataset is present. `needsSprites` also requires
 *  the extracted sheets, which a JSON-only regeneration would not produce. */
export function hasDataset(needsSprites = false): boolean {
  if (!existsSync(GAME_DATA) || !existsSync(CATALOG)) return false;
  return !needsSprites || existsSync(SPRITE_DIR);
}

/** Loads the dataset, or skips the whole suite if it is not there.
 *
 *  Exits the process rather than returning undefined: these suites read the
 *  data at module scope to build a lookup every test shares, so there is no
 *  useful way to continue without it. */
export function requireDataset(suite: string, needsSprites = false): { gameData: GameData; catalog: RenderCatalog } {
  if (!hasDataset(needsSprites)) {
    console.log(`  --  ${suite}: skipped, no generated dataset`);
    console.log(`      Run the data pipeline first (see README): dump-to-gamedata,`);
    console.log(`      extract-sprites, crop-sprite-sheets — in that order.`);
    process.exit(0);
  }
  return {
    gameData: JSON.parse(readFileSync(GAME_DATA, "utf-8")) as GameData,
    catalog: JSON.parse(readFileSync(CATALOG, "utf-8")) as RenderCatalog,
  };
}
