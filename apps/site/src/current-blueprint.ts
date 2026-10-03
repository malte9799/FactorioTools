/** The blueprint open in the Blueprint Editor, for other tools (the Overlay
 *  Lab) to work on rather than loading their own. Held in memory while the
 *  app runs; after a reload it comes back from the editor's autosave. */
import { decodeBlueprintString, normaliseEntities, normaliseWires, type PlacedEntity, type WireLink } from "@factoriotools/engine";

/** Where the editor keeps its autosave (see persistEntities there). The
 *  storage keys still say "blueprint-viewer", the tool's old name: renaming
 *  them would orphan everyone's saved library, quickbar and autosave. */
const SHARED_AUTOSAVE_KEY = "factoriotools.blueprint-viewer.autosave";

/** Branch previews are served from the same origin as the live site
 *  (…/preview/<branch>/), so they share its localStorage. With one shared
 *  autosave, opening any other build — the live site, another preview —
 *  loads the blueprint and writes it straight back in that build's own
 *  format, dropping whatever it doesn't know (circuit settings, say). Each
 *  preview therefore keeps its own autosave; the library and quickbar stay
 *  shared. */
const PREVIEW = typeof location === "undefined" ? undefined : /\/preview\/([^/]+)\//.exec(location.pathname)?.[1];
export const EDITOR_AUTOSAVE_KEY = PREVIEW ? `${SHARED_AUTOSAVE_KEY}:preview:${PREVIEW}` : SHARED_AUTOSAVE_KEY;

/** The autosave to start from: this build's own, or, the first time a
 *  preview is opened, the shared one. */
export function readAutosave(): string | null {
  return localStorage.getItem(EDITOR_AUTOSAVE_KEY) ?? (PREVIEW ? localStorage.getItem(SHARED_AUTOSAVE_KEY) : null);
}

let current: PlacedEntity[] | undefined;
let currentWires: WireLink[] = [];

/** The editor calls this after every load and edit. */
export function setCurrentBlueprint(entities: PlacedEntity[], wires: WireLink[] = []): void {
  current = entities;
  currentWires = wires;
}

/** The wires of the blueprint getCurrentBlueprint() returns. */
export function getCurrentWires(): WireLink[] {
  if (current) return currentWires;
  try {
    const saved = readAutosave();
    const blueprint = saved ? decodeBlueprintString(saved).blueprint : undefined;
    return blueprint ? normaliseWires(blueprint) : [];
  } catch {
    return [];
  }
}

export function getCurrentBlueprint(): PlacedEntity[] {
  if (current) return current;
  try {
    const saved = readAutosave();
    const blueprint = saved ? decodeBlueprintString(saved).blueprint : undefined;
    return blueprint ? normaliseEntities(blueprint) : [];
  } catch {
    // No storage, or a save that no longer decodes: nothing to show.
    return [];
  }
}
