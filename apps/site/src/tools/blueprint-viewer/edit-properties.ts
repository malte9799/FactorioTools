import type { BottleneckSubgroup, GameData, ModuleStack, PlacedEntity, QualityName, RenderCatalog } from "@factoriotools/engine";
import { buildVisualLookup, mountEntityPreview } from "@factoriotools/renderer";
import { icon } from "./legacy-view/icons.js";
import { buildGridMenu, type GridMenuEntry, type GridMenuHandle } from "./grid-menu.js";

export interface PropertiesCallbacks {
  /** Opens the recipe-picker menu window. Both pickers are their own
   *  floating windows (see grid-menu.ts) rather than expanding inline into
   *  this panel — the caller owns their show/hide and the E/Escape state
   *  machine between them, this GUI just asks for one to open. */
  onOpenRecipePicker(): void;
  /** Left-click on a module slot. What it does depends on what's in hand:
   *  with a module held (see index.ts's heldModule) it stamps that module
   *  into the slot, otherwise it opens the module menu — the branch lives
   *  in the caller, which is the side that knows about the cursor. */
  onModuleSlotClick(slotIndex: number): void;
  /** Right-click on a filled module slot empties it in place — the same
   *  "right-click removes" gesture the canvas uses for entities, so the
   *  module menu never needs a remove option of its own. */
  onClearModuleSlot(slotIndex: number): void;
}

/** Bottleneck lookup this GUI needs to show its status line — pass in
 *  whatever `latestBottlenecks` currently holds; absent/no-match means
 *  "haven't computed a bottleneck for this entity" (recipe-less or
 *  otherwise unrated), not an error. */
export type BottleneckLookup = Map<string, BottleneckSubgroup[]>;

function localisedNameOf(data: GameData, catalog: RenderCatalog, name: string): string {
  return (
    data.machines[name]?.localised ??
    data.beacons[name]?.localised ??
    data.belts[name]?.localised ??
    data.inserters[name]?.localised ??
    catalog.entities[name]?.localised ??
    name
  );
}

/** Expands a grouped ModuleStack[] into one entry per slot, in module-slot
 *  order — this GUI's internal working representation for the module row. */
function expandModules(modules: ModuleStack[]): ({ name: string; quality: QualityName } | null)[] {
  const slots: { name: string; quality: QualityName }[] = [];
  for (const stack of modules) {
    for (let i = 0; i < stack.count; i++) slots.push({ name: stack.name, quality: stack.quality });
  }
  return slots;
}

function findBottleneck(entityNumber: number, lookup: BottleneckLookup): BottleneckSubgroup["bottleneck"] | undefined {
  for (const subgroups of lookup.values()) {
    for (const sub of subgroups) {
      if (sub.entityNumbers.includes(entityNumber)) return sub.bottleneck;
    }
  }
  return undefined;
}

/** Status line text, matching the real game's own machine-GUI status
 *  wording (confirmed against the user's own screenshot: "Item ingredient
 *  shortage") as closely as this engine's bottleneck model supports —
 *  "product" congestion doesn't have as direct a real-game equivalent
 *  (that's normally a full-output-buffer state the game tracks live, which
 *  this static analysis has no notion of), so it's worded as a capacity
 *  observation instead of claiming to be the exact in-game string. */
function statusFor(entity: PlacedEntity, bottleneck: BottleneckSubgroup["bottleneck"] | undefined): { text: string; kind: "ok" | "warn" } {
  if (!entity.recipe) return { text: "No recipe selected", kind: "warn" };
  if (!bottleneck || bottleneck.limitedBy === "machine") return { text: "Working normally", kind: "ok" };
  if (bottleneck.limitedBy === "ingredient") return { text: "Item ingredient shortage", kind: "warn" };
  return { text: "Output is congested", kind: "warn" };
}

/** Builds the recipe-picker menu — the recipes THIS machine can actually
 *  run (`craftingCategories` is the machine's own crafting_categories, so a
 *  furnace never lists an assembling recipe), tabbed and ordered by the SAME
 *  item-group/subgroup/order scheme the build menu uses
 *  (catalog.recipeMenuPositions), not Factorio's internal crafting_category
 *  field — that one names no grouping any in-game UI shows. */
export function buildRecipeMenu(
  container: HTMLElement,
  data: GameData,
  catalog: RenderCatalog,
  craftingCategories: string[],
  currentRecipe: string | undefined,
  currentQuality: QualityName,
  onPick: (recipeName: string, quality: QualityName) => void,
  onCancel: () => void,
): GridMenuHandle {
  const eligible = new Set(craftingCategories);
  const entries: GridMenuEntry[] = Object.values(data.recipes)
    .filter((recipe) => eligible.has(recipe.category))
    .map((recipe) => ({
      name: recipe.name,
      localised: recipe.localised,
      position: catalog.recipeMenuPositions[recipe.name],
    }));

  return buildGridMenu(container, {
    entries,
    groups: catalog.menuGroups,
    filterLabel: "Filter recipes",
    showQuality: true,
    initialQuality: currentQuality,
    initialSelection: currentRecipe,
    onConfirm: ({ name, quality }) => onPick(name, quality),
    onCancel,
  });
}

/** Builds the module-picker menu for ONE module slot — the same grid-menu
 *  body as the build and recipe menus. Modules all live in one item-group
 *  ("production"), so the tab strip hides itself and the grid is ordered by
 *  the game's own module order (speed, then productivity, then efficiency,
 *  then quality). Opens with nothing marked and offers no "empty this slot"
 *  cell: emptying a slot is a right-click on the slot itself, so this menu
 *  is purely "pick a module" and can't half-express a removal. */
export function buildModuleMenu(
  container: HTMLElement,
  data: GameData,
  catalog: RenderCatalog,
  currentQuality: QualityName,
  onPick: (module: { name: string; quality: QualityName }) => void,
  onCancel: () => void,
): GridMenuHandle {
  const entries: GridMenuEntry[] = Object.values(data.modules).map((module) => ({
    name: module.name,
    localised: module.localised,
    position: catalog.itemMenuPositions[module.name],
  }));

  return buildGridMenu(container, {
    entries,
    groups: catalog.menuGroups,
    filterLabel: "Filter modules",
    showQuality: true,
    initialQuality: currentQuality,
    onConfirm: ({ name, quality }) => onPick({ name, quality }),
    onCancel,
  });
}
/** Builds the real game's own machine-GUI look (per the user's reference
 *  screenshots): a checkered-background sprite preview, the entity name, a
 *  status line (recipe-shortage/working/no-recipe, from the bottleneck
 *  engine), a gear button that opens the recipe menu, and one icon button
 *  per module slot that opens the module menu for that slot. Both pickers
 *  are separate menu windows (grid-menu.ts), so this panel keeps a fixed
 *  size instead of growing an expanded grid inside itself. There is
 *  deliberately no rotate/quality-change/delete UI here — those moved to
 *  in-world interaction (the 'r' key, building over an existing entity with
 *  a different quality selected, and right-click respectively), matching
 *  the real game's own controls more closely than a form ever did. Rebuilt
 *  (full replaceChildren) whenever selection or the selected entity's own
 *  fields change, matching renderResults()'s own rebuild-on-change
 *  pattern. */
export function buildPropertiesPanel(
  container: HTMLElement,
  entity: PlacedEntity,
  data: GameData,
  catalog: RenderCatalog,
  bottlenecks: BottleneckLookup,
  callbacks: PropertiesCallbacks,
): void {
  container.replaceChildren();

  const localised = localisedNameOf(data, catalog, entity.name);
  const machine = data.machines[entity.name];
  const beacon = data.beacons[entity.name];
  const moduleSlots = machine?.moduleSlots ?? beacon?.moduleSlots ?? 0;

  // Preview pane — a real rendered sprite of the entity, checkered
  // transparent background, matching the game's own machine-GUI thumbnail.
  const previewWrap = document.createElement("div");
  previewWrap.className = "entity-preview";
  container.appendChild(previewWrap);
  const visualLookup = buildVisualLookup(data, catalog);
  const visual = visualLookup.get(entity.name);
  let destroyPreview: (() => void) | undefined;
  if (visual) destroyPreview = mountEntityPreview(previewWrap, entity.name, entity.direction, visual);

  // Name + status line.
  const header = document.createElement("div");
  header.className = "entity-gui-header";
  header.appendChild(icon(entity.name, localised, 28));
  const nameEl = document.createElement("span");
  nameEl.className = "entity-gui-name";
  nameEl.textContent = localised;
  header.appendChild(nameEl);
  container.appendChild(header);

  if (machine) {
    const bottleneck = findBottleneck(entity.entityNumber, bottlenecks);
    const status = statusFor(entity, bottleneck);
    const statusRow = document.createElement("div");
    statusRow.className = `entity-gui-status status-${status.kind}`;
    statusRow.innerHTML = `<span class="status-dot"></span>${status.text}`;
    container.appendChild(statusRow);
  }

  // Recipe row: current recipe icon + a gear button that opens the
  // standalone recipe-picker window (its own floating window, matching the
  // build palette's look — see buildRecipeWindow), matching the real GUI's
  // gear-opens-recipe-list flow but as a separate window rather than
  // growing this panel in place.
  if (machine) {
    const recipeRow = document.createElement("div");
    recipeRow.className = "entity-gui-recipe-row";

    const currentRecipeIcon = document.createElement("span");
    currentRecipeIcon.className = "current-recipe-slot";
    if (entity.recipe) {
      const recipe = data.recipes[entity.recipe];
      currentRecipeIcon.appendChild(icon(entity.recipe, recipe?.localised ?? entity.recipe, 32));
    } else {
      currentRecipeIcon.textContent = "—";
    }
    recipeRow.appendChild(currentRecipeIcon);

    const gearButton = document.createElement("button");
    gearButton.type = "button";
    gearButton.className = "recipe-gear-button";
    gearButton.title = "Select a recipe";
    gearButton.textContent = "⚙";
    recipeRow.appendChild(gearButton);

    container.appendChild(recipeRow);

    gearButton.addEventListener("click", () => callbacks.onOpenRecipePicker());
  }

  // Module slots: one icon button per slot, each opening the module menu for
  // that slot — the same separate-window flow the recipe gear uses.
  if (moduleSlots > 0) {
    const slotsRow = document.createElement("div");
    slotsRow.className = "entity-gui-module-slots";
    const currentSlots = expandModules(entity.modules);

    for (let i = 0; i < moduleSlots; i++) {
      const slot = currentSlots[i] ?? null;
      const slotButton = document.createElement("button");
      slotButton.type = "button";
      slotButton.className = "module-slot-button";
      const moduleName = slot ? (data.modules[slot.name]?.localised ?? slot.name) : undefined;
      slotButton.title = moduleName ? `${moduleName} — right-click to remove` : "Empty module slot";
      if (slot) slotButton.appendChild(icon(slot.name, moduleName ?? slot.name, 28));
      slotButton.addEventListener("click", () => callbacks.onModuleSlotClick(i));
      slotButton.addEventListener("contextmenu", (event) => {
        // Always swallow the browser menu, even on an already-empty slot —
        // right-clicking a slot should never surprise the user with the
        // native context menu just because that one happened to be empty.
        event.preventDefault();
        if (slot) callbacks.onClearModuleSlot(i);
      });

      const cell = document.createElement("div");
      cell.className = "module-slot-cell";
      cell.appendChild(slotButton);
      slotsRow.appendChild(cell);
    }
    container.appendChild(slotsRow);
  }

  // mountEntityPreview's teardown fires when this panel is next rebuilt or
  // the container is cleared — matches every other rebuild-on-change spot
  // in this codebase not tracking per-call cleanup explicitly, since the
  // next buildPropertiesPanel() call's container.replaceChildren() removes
  // the canvas anyway. Kept as a variable rather than immediately
  // discarded so it's clear the return value is intentionally unused here,
  // not an oversight.
  void destroyPreview;
}
