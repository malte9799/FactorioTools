import type { BottleneckSubgroup, GameData, ModuleStack, PlacedEntity, QualityName, RenderCatalog } from "@factoriotools/engine";
import { buildVisualLookup, mountEntityPreview } from "@factoriotools/renderer";
import { icon } from "./legacy-view/icons.js";
import { buildCircuitSection, buildCircuitStatus, buildConnectionBar, hasCircuitGui, isCircuitFirst, type CircuitCallbacks } from "./edit-circuit.js";
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
  /** Left-click on a filter slot — opens the item picker for that slot, the
   *  same separate-window flow the recipe gear and module slots use. */
  onFilterSlotClick(slotIndex: number): void;
  /** Right-click on a filled filter slot empties it — same "right-click
   *  removes" gesture as a module slot. */
  onClearFilterSlot(slotIndex: number): void;
  /** The "Use filters" checkbox toggled. */
  onToggleUseFilters(enabled: boolean): void;
  /** The Whitelist/Blacklist switch toggled. */
  onSetFilterMode(mode: "whitelist" | "blacklist"): void;
  /** The "Override stack size" checkbox toggled — `false` clears the
   *  override entirely (undefined, not left at whatever the slider showed). */
  onToggleOverrideStackSize(enabled: boolean): void;
  /** The override-stack-size slider/number field changed, while the
   *  checkbox is on. */
  onSetOverrideStackSize(value: number): void;
  /** One of the Spoiled first / Fresh first radios picked, or neither
   *  (clearing back to "no preference") — undefined clears it. */
  onSetSpoilPriority(priority: "spoiled-first" | "fresh-first" | undefined): void;
  /** Circuit settings: shown for combinators, display panels, lamps and
   *  anything with a red or green wire. */
  circuit?: CircuitCallbacks;
}

/** Bottleneck lookup this GUI needs to show its status line — pass in
 *  whatever `latestBottlenecks` currently holds; absent/no-match means
 *  "haven't computed a bottleneck for this entity" (recipe-less or
 *  otherwise unrated), not an error. */
export type BottleneckLookup = Map<string, BottleneckSubgroup[]>;

export function localisedNameOf(data: GameData, catalog: RenderCatalog, name: string): string {
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

/** Builds the item-picker menu for ONE inserter/loader filter slot — same
 *  grid-menu body as the others, but drawn from catalog.itemNames (every
 *  real item prototype, ores and intermediates included), not just the
 *  placeable/module/recipe subsets those other pickers cover, since an
 *  inserter can filter for literally any item. No quality strip: a filter
 *  slot names an item, not a specific quality of it (matches the real game's
 *  own filter-inserter GUI, which has no quality picker on its filter
 *  slots). */
export function buildFilterItemMenu(
  container: HTMLElement,
  catalog: RenderCatalog,
  onPick: (itemName: string) => void,
  onCancel: () => void,
): GridMenuHandle {
  const entries: GridMenuEntry[] = Object.entries(catalog.itemNames).map(([name, localised]) => ({
    name,
    localised,
    position: catalog.itemMenuPositions[name],
  }));

  return buildGridMenu(container, {
    entries,
    groups: catalog.menuGroups,
    filterLabel: "Filter items",
    showQuality: false,
    onConfirm: ({ name }) => onPick(name),
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
): (() => void) | undefined {
  container.replaceChildren();
  const circuit = callbacks.circuit;
  // Combinators, lamps and display panels are their circuit GUI, laid out
  // like the game's: connection bar, status, preview, settings.
  const circuitFirst = circuit !== undefined && isCircuitFirst(entity.name);
  const refreshers: (() => void)[] = [];

  // An inserter's window follows the game's: its own settings in the main
  // column and, once a wire reaches it, a "Circuit connection" panel beside
  // them instead of everything stacked in one column.
  const inserter = data.inserters[entity.name];
  let main = container;
  let side: HTMLElement | undefined;
  if (inserter) {
    const layout = document.createElement("div");
    layout.className = "inserter-gui";
    main = document.createElement("div");
    main.className = "inserter-gui-main";
    layout.appendChild(main);
    if (circuit?.wired) {
      layout.classList.add("has-side");
      side = document.createElement("div");
      side.className = "inserter-gui-side f-panel";
      const title = document.createElement("div");
      title.className = "circuit-heading";
      title.textContent = "Circuit connection";
      side.appendChild(title);
      layout.appendChild(side);
    }
    container.appendChild(layout);
  }

  if (circuit && (circuitFirst || circuit.wired)) refreshers.push(buildConnectionBar(side ?? container, entity, catalog, circuit));
  // The game shows a display panel without a status line.
  if (circuit && circuitFirst && !/display-panel/.test(entity.name)) refreshers.push(buildCircuitStatus(container, entity, circuit));

  const localised = localisedNameOf(data, catalog, entity.name);
  const machine = data.machines[entity.name];
  const beacon = data.beacons[entity.name];
  const moduleSlots = machine?.moduleSlots ?? beacon?.moduleSlots ?? 0;

  // Preview pane — a real rendered sprite of the entity, checkered
  // transparent background, matching the game's own machine-GUI thumbnail.
  const previewWrap = document.createElement("div");
  previewWrap.className = "entity-preview";
  main.appendChild(previewWrap);
  const visualLookup = buildVisualLookup(data, catalog);
  const visual = visualLookup.get(entity.name);
  let destroyPreview: (() => void) | undefined;
  if (visual) destroyPreview = mountEntityPreview(previewWrap, entity.name, entity.direction, visual, entity.controlBehavior);

  // Name + status line.
  const header = document.createElement("div");
  header.className = "entity-gui-header";
  header.appendChild(icon(entity.name, localised, 28));
  const nameEl = document.createElement("span");
  nameEl.className = "entity-gui-name";
  nameEl.textContent = localised;
  header.appendChild(nameEl);
  // The window's title already names it in a circuit GUI, and an inserter's.
  if (!circuitFirst && !inserter) container.appendChild(header);

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

  // Inserter-only settings: filters (whitelist/blacklist + up to 5 item
  // slots), override stack size, and spoil priority — matching the real
  // game's own inserter GUI (see the user's own reference screenshot): one
  // ruled row per setting, its checkbox on the left and its controls beside
  // it, always visible and greyed out while the checkbox is off.
  // Every field here round-trips through the blueprint's own flat
  // `filters`/`filter_mode`/`use_filters`/`override_stack_size`/
  // `spoil_priority` fields (see blueprint.ts's normaliseEntities/
  // denormaliseEntities) — this panel is the only place that writes them.
  // Each checkbox only fires its callback: the edit rebuilds this panel,
  // which is what enables or greys out the controls beside it.
  if (inserter) {
    const settingRow = (text: string, checked: boolean, onChange: (on: boolean) => void): { row: HTMLDivElement; lead: HTMLDivElement } => {
      const row = document.createElement("div");
      row.className = "inserter-gui-row";
      row.classList.toggle("is-off", !checked);
      const lead = document.createElement("div");
      lead.className = "inserter-gui-lead";
      const label = document.createElement("label");
      label.className = "entity-gui-checkbox-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = checked;
      box.addEventListener("change", () => onChange(box.checked));
      label.append(box, document.createTextNode(` ${text}`));
      lead.appendChild(label);
      row.appendChild(lead);
      main.appendChild(row);
      return { row, lead };
    };

    const FILTER_SLOT_COUNT = 5;
    const useFilters = entity.useFilters ?? false;
    const filters = settingRow("Use filters", useFilters, (on) => callbacks.onToggleUseFilters(on));

    const modeRow = document.createElement("div");
    modeRow.className = "entity-gui-filter-mode-row";
    const whitelistLabel = document.createElement("span");
    whitelistLabel.className = "filter-mode-label";
    whitelistLabel.textContent = "Whitelist";
    const modeToggle = document.createElement("button");
    modeToggle.type = "button";
    modeToggle.className = "filter-mode-switch";
    const isBlacklist = entity.filterMode === "blacklist";
    modeToggle.classList.toggle("is-blacklist", isBlacklist);
    modeToggle.setAttribute("role", "switch");
    modeToggle.setAttribute("aria-checked", String(isBlacklist));
    modeToggle.title = "Toggle whitelist/blacklist";
    modeToggle.disabled = !useFilters;
    modeToggle.addEventListener("click", () => callbacks.onSetFilterMode(isBlacklist ? "whitelist" : "blacklist"));
    const blacklistLabel = document.createElement("span");
    blacklistLabel.className = "filter-mode-label";
    blacklistLabel.textContent = "Blacklist";
    modeRow.append(whitelistLabel, modeToggle, blacklistLabel);
    filters.lead.appendChild(modeRow);

    const filterSlotsRow = document.createElement("div");
    filterSlotsRow.className = "entity-gui-filter-slots";
    for (let i = 0; i < FILTER_SLOT_COUNT; i++) {
      const itemName = entity.filterItems[i] || undefined;
      const slotButton = document.createElement("button");
      slotButton.type = "button";
      slotButton.className = "filter-slot-button";
      slotButton.disabled = !useFilters;
      const localisedItem = itemName ? (catalog.itemNames[itemName] ?? itemName) : undefined;
      slotButton.title = localisedItem ? `${localisedItem} — right-click to remove` : "Empty filter slot";
      if (itemName) slotButton.appendChild(icon(itemName, localisedItem ?? itemName, 28));
      slotButton.addEventListener("click", () => callbacks.onFilterSlotClick(i));
      slotButton.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (itemName) callbacks.onClearFilterSlot(i);
      });
      filterSlotsRow.appendChild(slotButton);
    }
    filters.row.appendChild(filterSlotsRow);

    // Override stack size: checkbox + slider + numeric readout. The real
    // game's own max depends on the force's stack-size research, which this
    // tool has no notion of (no research/force model) — MAX_OVERRIDE_STACK
    // is a generous fixed ceiling covering every vanilla tech tier instead.
    const MAX_OVERRIDE_STACK = 20;
    const stackEnabled = entity.overrideStackSize !== undefined;
    const stack = settingRow("Override stack size", stackEnabled, (on) => callbacks.onToggleOverrideStackSize(on));

    const stackBody = document.createElement("div");
    stackBody.className = "entity-gui-stack-body";
    const stackSlider = document.createElement("input");
    stackSlider.type = "range";
    stackSlider.min = "1";
    stackSlider.max = String(MAX_OVERRIDE_STACK);
    stackSlider.step = "1";
    stackSlider.value = String(entity.overrideStackSize ?? 1);
    stackSlider.className = "stack-size-slider";
    stackSlider.disabled = !stackEnabled;
    const stackValue = document.createElement("input");
    stackValue.type = "number";
    stackValue.min = "1";
    stackValue.max = String(MAX_OVERRIDE_STACK);
    stackValue.step = "1";
    stackValue.value = String(entity.overrideStackSize ?? 1);
    stackValue.className = "stack-size-value";
    stackValue.disabled = !stackEnabled;
    // `input` only updates the live numeric readout — no callback there, and
    // therefore no applyEdit/full-panel-rebuild — because onSetOverrideStackSize
    // triggers renderPropertiesPanel(), which replaceChildren()s this very
    // slider. Doing that on every `input` tick (dozens per second while
    // dragging) swapped the DOM node out from under the pointer mid-drag,
    // which is what broke dragging outright: the browser's own slider-drag
    // gesture doesn't survive its element being replaced. `change` (fires
    // once, on release) is the only point this commits the edit — matching
    // the number field's own commit-on-change below, so a whole drag is one
    // undo step, not one per pixel moved.
    stackSlider.addEventListener("input", () => {
      stackValue.value = stackSlider.value;
    });
    stackSlider.addEventListener("change", () => {
      callbacks.onSetOverrideStackSize(Number(stackSlider.value));
    });
    stackValue.addEventListener("change", () => {
      const clamped = Math.min(MAX_OVERRIDE_STACK, Math.max(1, Math.round(Number(stackValue.value)) || 1));
      stackValue.value = String(clamped);
      stackSlider.value = String(clamped);
      callbacks.onSetOverrideStackSize(clamped);
    });
    stackBody.append(stackSlider, stackValue);
    stack.row.appendChild(stackBody);

    // Spoiled priority: a main "Spoiled priority" checkbox (matching the
    // Use filters/Override stack size rows above it) gates two
    // mutually-exclusive radios. Unchecking the main box clears the
    // preference entirely (undefined); checking it defaults to
    // "spoiled-first" — the game's own first/emphasised option — rather
    // than leaving the radios both unset with no way to tell which one a
    // bare click would land on.
    const spoilEnabled = entity.spoilPriority !== undefined;
    const spoil = settingRow("Spoiled priority", spoilEnabled, (on) => callbacks.onSetSpoilPriority(on ? "spoiled-first" : undefined));

    const spoilBody = document.createElement("div");
    spoilBody.className = "entity-gui-spoil-body";

    function makeSpoilRadio(value: "spoiled-first" | "fresh-first", text: string): HTMLLabelElement {
      const label = document.createElement("label");
      label.className = "spoil-priority-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `spoil-priority-${entity.entityNumber}`;
      radio.checked = entity.spoilPriority === value;
      radio.disabled = !spoilEnabled;
      radio.addEventListener("change", () => callbacks.onSetSpoilPriority(value));
      label.append(radio, document.createTextNode(` ${text}`));
      return label;
    }
    spoilBody.appendChild(makeSpoilRadio("spoiled-first", "Spoiled first"));
    spoilBody.appendChild(makeSpoilRadio("fresh-first", "Fresh first"));
    spoil.row.appendChild(spoilBody);
  }

  if (circuit && hasCircuitGui(entity, circuit.wired)) refreshers.push(buildCircuitSection(side ?? container, entity, data, catalog, circuit, { bare: side !== undefined }));

  // mountEntityPreview's teardown fires when this panel is next rebuilt or
  // the container is cleared — matches every other rebuild-on-change spot
  // in this codebase not tracking per-call cleanup explicitly, since the
  // next buildPropertiesPanel() call's container.replaceChildren() removes
  // the canvas anyway. Kept as a variable rather than immediately
  // discarded so it's clear the return value is intentionally unused here,
  // not an oversight.
  void destroyPreview;
  return refreshers.length ? () => refreshers.forEach((r) => r()) : undefined;
}
