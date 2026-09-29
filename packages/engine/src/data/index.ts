import type { GameData, RenderCatalog } from "../types.js";
import { vanilla } from "./vanilla.js";

const EMPTY_CATALOG: RenderCatalog = {
  version: "none",
  entities: {},
  menuGroups: [],
  menuPositions: {},
  itemMenuPositions: {},
  recipeMenuPositions: {},
  itemNames: {},
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
export async function loadData(gameDataUrl = "./data/game-data.json"): Promise<GameData> {
  const catalogUrl = gameDataUrl.replace(/game-data\.json$/, "render-catalog.json");
  // Both requests go out together: neither file's contents feed the other's
  // URL, so awaiting game-data.json to completion (download AND parse) before
  // even asking for the catalog just added its whole transfer time to the
  // wait before the renderer can draw anything but outline boxes.
  // allSettled rather than all so one rejected fetch still leaves the other
  // usable, matching the per-file fallbacks below.
  const [dataResult, catalogResult] = await Promise.allSettled([fetch(gameDataUrl), fetch(catalogUrl)]);

  try {
    if (dataResult.status === "fulfilled" && dataResult.value.ok) {
      const data = (await dataResult.value.json()) as GameData;
      active = data;
      // Still gated on game-data having loaded: a catalog without its dataset
      // describes entities nothing can look up, exactly as before.
      try {
        if (catalogResult.status === "fulfilled" && catalogResult.value.ok) {
          activeCatalog = (await catalogResult.value.json()) as RenderCatalog;
        }
      } catch {
        // Renderer just falls back to outline boxes for everything.
      }
      return data;
    }
  } catch {
    // Not generated yet, or malformed — fall through to vanilla.
  }
  return active;
}

export function machineFor(name: string) {
  return active.machines[name];
}

export function isCalculable(name: string): boolean {
  return name in active.machines;
}
