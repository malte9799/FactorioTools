/** The blueprint open in the Blueprint Viewer, for other tools (the Overlay
 *  Lab) to work on rather than loading their own. Held in memory while the
 *  app runs; after a reload it comes back from the viewer's autosave. */
import { decodeBlueprintString, normaliseEntities, type PlacedEntity } from "@factoriotools/engine";

/** Where the viewer keeps its autosave (see persistEntities there). */
export const VIEWER_AUTOSAVE_KEY = "factoriotools.blueprint-viewer.autosave";

let current: PlacedEntity[] | undefined;

/** The viewer calls this after every load and edit. */
export function setCurrentBlueprint(entities: PlacedEntity[]): void {
  current = entities;
}

export function getCurrentBlueprint(): PlacedEntity[] {
  if (current) return current;
  try {
    const saved = localStorage.getItem(VIEWER_AUTOSAVE_KEY);
    const blueprint = saved ? decodeBlueprintString(saved).blueprint : undefined;
    return blueprint ? normaliseEntities(blueprint) : [];
  } catch {
    // No storage, or a save that no longer decodes: nothing to show.
    return [];
  }
}
