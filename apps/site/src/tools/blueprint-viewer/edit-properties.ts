import type { BottleneckSubgroup, GameData, ModuleStack, PlacedEntity, QualityName, RecipeProto, RenderCatalog } from "@factoriotools/engine";
import { buildVisualLookup, mountEntityPreview } from "@factoriotools/renderer";
import { icon } from "./legacy-view/icons.js";

export interface PropertiesCallbacks {
  onRecipeChange(recipeName: string | undefined): void;
  onModuleSlotChange(slotIndex: number, module: { name: string; quality: QualityName } | null): void;
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

/** Recipe picker grid state, scoped to one buildRecipePicker() call. */
function buildRecipePicker(
  container: HTMLElement,
  data: GameData,
  categories: string[],
  currentRecipe: string | undefined,
  onPick: (recipeName: string) => void,
): void {
  container.replaceChildren();
  container.className = "recipe-picker";

  const tabStrip = document.createElement("div");
  tabStrip.className = "palette-tabs";
  const grid = document.createElement("div");
  grid.className = "palette-grid";
  grid.style.setProperty("--palette-columns", "10");

  // Only categories with at least one recipe become a tab — a machine's
  // crafting_categories list is often much broader than what it actually
  // has recipes for in this dataset (e.g. assembling-machine-2 lists 13
  // categories, most matching zero recipes here), and an empty tab would
  // just be a dead click.
  const byCategory = categories
    .map((category) => ({
      category,
      recipes: Object.values(data.recipes)
        .filter((r) => r.category === category)
        .sort((a, b) => a.localised.localeCompare(b.localised)),
    }))
    .filter((c) => c.recipes.length > 0);

  let activeIndex = byCategory.findIndex((c) => c.recipes.some((r) => r.name === currentRecipe));
  if (activeIndex < 0) activeIndex = 0;

  function renderGrid(recipes: RecipeProto[]): void {
    grid.replaceChildren();
    if (recipes.length === 0) {
      grid.innerHTML = `<p class="empty">No recipes.</p>`;
      return;
    }
    for (const recipe of recipes) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "palette-cell";
      cell.classList.toggle("is-active", recipe.name === currentRecipe);
      cell.title = recipe.localised;
      cell.setAttribute("aria-label", recipe.localised);
      // Recipes and their main product usually share an icon id in the
      // manifest (the icon() lookup falls back to the same graceful
      // "blank until found" behavior either way).
      cell.appendChild(icon(recipe.name, recipe.localised, 36));
      cell.addEventListener("click", () => onPick(recipe.name));
      grid.appendChild(cell);
    }
  }

  function renderTabs(): void {
    tabStrip.replaceChildren();
    // Only one tab needed (no real category choice to make) — skip the
    // strip entirely rather than showing a lone, unclickable-feeling tab.
    if (byCategory.length <= 1) return;
    byCategory.forEach((entry, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "palette-tab";
      tab.classList.toggle("is-active", i === activeIndex);
      tab.title = entry.category;
      // Represents the category by its first recipe's icon (mirrors the
      // build palette's own "one representative icon per tab" convention)
      // rather than an abbreviated category-name label, which read as
      // cryptic two-letter codes (e.g. "CR", "AD") in practice.
      const representative = entry.recipes[0]!;
      tab.appendChild(icon(representative.name, entry.category, 28));
      tab.addEventListener("click", () => {
        activeIndex = i;
        renderTabs();
        renderGrid(entry.recipes);
      });
      tabStrip.appendChild(tab);
    });
  }

  renderTabs();
  renderGrid(byCategory[activeIndex]?.recipes ?? []);
  container.append(tabStrip, grid);
}

/** Builds the real game's own machine-GUI look (per the user's reference
 *  screenshots): a checkered-background sprite preview, the entity name, a
 *  status line (recipe-shortage/working/no-recipe, from the bottleneck
 *  engine), a gear button that expands into a recipe-picker grid (tabbed by
 *  recipe category, matching the build palette's own tab-strip-plus-grid
 *  convention rather than a plain <select>), and one icon button per module
 *  slot that expands into a module-picker grid the same way. There is
 *  deliberately no rotate/quality-change/delete UI here anymore — those
 *  moved to in-world interaction (the 'r' key, building over an existing
 *  entity with a different quality selected, and right-click respectively),
 *  matching the real game's own controls more closely than a form ever did.
 *  Rebuilt (full replaceChildren) whenever selection or the selected
 *  entity's own fields change, matching renderResults()'s own
 *  rebuild-on-change pattern. */
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

  // Recipe row: current recipe icon + a gear button that expands the picker
  // grid below it, matching the real GUI's gear-opens-recipe-list flow.
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

    const pickerHost = document.createElement("div");
    pickerHost.hidden = true;
    container.appendChild(pickerHost);

    gearButton.addEventListener("click", () => {
      pickerHost.hidden = !pickerHost.hidden;
      if (!pickerHost.hidden) {
        buildRecipePicker(pickerHost, data, machine.categories, entity.recipe, (recipeName) => {
          callbacks.onRecipeChange(recipeName);
          pickerHost.hidden = true;
        });
      }
    });
  }

  // Module slots: one icon button per slot, each expanding its own
  // module-picker grid — mirrors the recipe gear's expand-in-place pattern
  // rather than a <select>, keeping the whole GUI grid-and-icon-driven like
  // the real game's.
  if (moduleSlots > 0) {
    const slotsRow = document.createElement("div");
    slotsRow.className = "entity-gui-module-slots";
    const currentSlots = expandModules(entity.modules);
    const moduleOptions = Object.values(data.modules).sort((a, b) => a.localised.localeCompare(b.localised));

    for (let i = 0; i < moduleSlots; i++) {
      const slot = currentSlots[i] ?? null;
      const slotButton = document.createElement("button");
      slotButton.type = "button";
      slotButton.className = "module-slot-button";
      slotButton.title = slot ? (data.modules[slot.name]?.localised ?? slot.name) : "Empty module slot";
      if (slot) slotButton.appendChild(icon(slot.name, slotButton.title, 28));

      const pickerHost = document.createElement("div");
      pickerHost.hidden = true;

      slotButton.addEventListener("click", () => {
        const alreadyOpen = !pickerHost.hidden;
        container.querySelectorAll<HTMLDivElement>(".module-picker-host").forEach((h) => (h.hidden = true));
        pickerHost.hidden = alreadyOpen;
        if (!pickerHost.hidden) {
          pickerHost.replaceChildren();
          pickerHost.className = "module-picker-host palette-grid";
          pickerHost.style.setProperty("--palette-columns", "8");
          const clearCell = document.createElement("button");
          clearCell.type = "button";
          clearCell.className = "palette-cell";
          clearCell.title = "Empty";
          clearCell.textContent = "✕";
          clearCell.addEventListener("click", () => {
            callbacks.onModuleSlotChange(i, null);
            pickerHost.hidden = true;
          });
          pickerHost.appendChild(clearCell);
          for (const mod of moduleOptions) {
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "palette-cell";
            cell.title = mod.localised;
            cell.appendChild(icon(mod.name, mod.localised, 32));
            cell.addEventListener("click", () => {
              callbacks.onModuleSlotChange(i, { name: mod.name, quality: slot?.quality ?? "normal" });
              pickerHost.hidden = true;
            });
            pickerHost.appendChild(cell);
          }
        }
      });

      const cell = document.createElement("div");
      cell.className = "module-slot-cell";
      cell.append(slotButton, pickerHost);
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
