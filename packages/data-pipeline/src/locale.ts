import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** Factorio's display names live in INI-style .cfg locale files, one per mod,
 *  split into sections like [entity-name], [item-name], [recipe-name],
 *  [fluid-name] — not in data.raw itself. Parse the small set of sections the
 *  engine needs display strings for. */

export interface LocaleTables {
  entityName: Map<string, string>;
  itemName: Map<string, string>;
  recipeName: Map<string, string>;
  fluidName: Map<string, string>;
  itemGroupName: Map<string, string>;
  technologyName: Map<string, string>;
}

const SECTIONS_WANTED = new Set(["entity-name", "item-name", "recipe-name", "fluid-name", "item-group-name", "technology-name"]);

function parseCfg(contents: string, into: LocaleTables): void {
  let section: string | null = null;
  const targetFor: Record<string, Map<string, string>> = {
    "entity-name": into.entityName,
    "item-name": into.itemName,
    "recipe-name": into.recipeName,
    "fluid-name": into.fluidName,
    "item-group-name": into.itemGroupName,
    "technology-name": into.technologyName,
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (!section || !SECTIONS_WANTED.has(section)) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    targetFor[section]!.set(key, value);
  }
}

/** `dataRoot` is the Factorio install's Contents/data directory. Reads every
 *  mod's en locale in a fixed order so later mods (space-age, quality,
 *  elevated-rails) can override base's names if they ever redefine one. */
export function loadLocale(dataRoot: string): LocaleTables {
  const tables: LocaleTables = {
    entityName: new Map(),
    itemName: new Map(),
    recipeName: new Map(),
    fluidName: new Map(),
    itemGroupName: new Map(),
    technologyName: new Map(),
  };

  const mods = ["core", "base", "space-age", "quality", "elevated-rails"];
  for (const mod of mods) {
    const file = path.join(dataRoot, mod, "locale", "en", `${mod}.cfg`);
    if (!existsSync(file)) continue;
    parseCfg(readFileSync(file, "utf-8"), tables);
  }
  return tables;
}

/** Factorio falls back to an item/entity's own name if a recipe has no
 *  explicit [recipe-name] entry (common: recipe id === produced item id). */
export function localisedRecipeName(
  locale: LocaleTables,
  recipeName: string,
  firstResultName: string | undefined,
): string {
  return (
    locale.recipeName.get(recipeName) ??
    (firstResultName && locale.itemName.get(firstResultName)) ??
    (firstResultName && locale.fluidName.get(firstResultName)) ??
    recipeName
  );
}
