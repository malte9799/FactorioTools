import type { GameData, RenderCatalog } from "../types.js";
import { vanilla } from "./vanilla.js";

const EMPTY_CATALOG: RenderCatalog = {
  version: "none",
  entities: {},
  menuGroups: [],
  menuPositions: {},
  itemMenuPositions: {},
  recipeMenuPositions: {},
};

let active: GameData = vanilla;
let activeCatalog: RenderCatalog = EMPTY_CATALOG;

export function getData(): GameData {
  return active;
}

/** Visual-only entities (poles, pipes, chests, ...) for the renderer — see
 *  RenderCatalog's own doc comment in types.ts. Empty until loadData()'s own
 *  dataset (not the vanilla fallback, which carries no catalog) has loaded
 *  successfully. */
export function getRenderCatalog(): RenderCatalog {
  return activeCatalog;
}

/** Swap in a generated dataset at runtime. */
export function setData(data: GameData): void {
  active = data;
}

/** Loads the site's own generated dataset (packages/data-pipeline's output,
 *  committed at apps/site/public/data/game-data.json + a sibling
 *  render-catalog.json). Falls back to the hand-written vanilla set if the
 *  fetch fails, so the app always has something to calculate with — though
 *  only the site's own dataset carries a render catalog, so the sprite
 *  renderer only lights up once that specific fetch succeeds. */
export async function loadData(gameDataUrl = "/data/game-data.json"): Promise<GameData> {
  try {
    const res = await fetch(gameDataUrl);
    if (res.ok) {
      const data = (await res.json()) as GameData;
      active = data;
      const catalogUrl = gameDataUrl.replace(/game-data\.json$/, "render-catalog.json");
      try {
        const catalogRes = await fetch(catalogUrl);
        if (catalogRes.ok) activeCatalog = (await catalogRes.json()) as RenderCatalog;
      } catch {
        // Renderer just falls back to outline boxes for everything.
      }
      return data;
    }
  } catch {
    // Not generated yet, or fetch blocked — fall through to vanilla.
  }
  return active;
}

export function machineFor(name: string) {
  return active.machines[name];
}

export function isCalculable(name: string): boolean {
  return name in active.machines;
}
