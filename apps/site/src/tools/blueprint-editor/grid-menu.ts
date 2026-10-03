/** The one grid-menu body every picker window in this tool is built from —
 *  the build menu, the recipe picker and the module picker are all the same
 *  thing structurally (filter box, item-group tab strip, subgroup-broken
 *  icon grid, optional quality strip, confirm button), differing only in
 *  what they list and whether quality applies. Keeping that in one builder
 *  is what makes them look identical rather than three hand-built lookalikes
 *  drifting apart, and gives index.ts's menu state machine one uniform
 *  handle (`select`/`confirm`/`hasSelection`) to drive from the keyboard. */

import type { MenuGroup, MenuPosition, QualityName } from "@factoriotools/engine";
import { icon } from "./legacy-view/icons.js";
import { QUALITY_TIERS } from "./quality-options.js";

/** Fixed grid width — matches the real game's own build-menu grid (10
 *  columns), confirmed by counting cells in the user's own reference
 *  screenshots. A fixed column count (not auto-fill) is deliberate: it's
 *  what makes the grid read as a grid instead of reflowing with window
 *  width. */
const GRID_COLUMNS = 10;

export interface GridMenuEntry {
  /** Value handed back on confirm, and the icon id looked up for the cell. */
  name: string;
  localised: string;
  /** Item-group/subgroup/order slot, straight out of the render catalog's
   *  menuPositions / itemMenuPositions / recipeMenuPositions. Entries with
   *  no position land in the "other" group, matching the game's own
   *  catch-all tab. */
  position?: MenuPosition;
}

export interface GridMenuOptions {
  entries: GridMenuEntry[];
  /** Every item-group in the dataset, already sorted — the menu keeps only
   *  the ones its own entries actually fall into. */
  groups: MenuGroup[];
  filterLabel: string;
  /** Adds the 5-tier quality strip below the grid; the confirmed selection
   *  then carries whichever tier is active. */
  showQuality?: boolean;
  initialQuality?: QualityName;
  /** Pre-highlighted entry (the machine's current recipe, the slot's current
   *  module, ...). Does NOT count as a user selection — the confirm button
   *  stays disabled until something is actually clicked, so confirming can
   *  never silently re-apply what was already there. */
  initialSelection?: string;
  onConfirm: (selection: { name: string; quality: QualityName }) => void;
  /** Fired by the X button, Escape, or 'E' with nothing selected. */
  onCancel: () => void;
}

export interface GridMenuHandle {
  /** True once the user has clicked a cell — what gates the confirm button
   *  and what 'E' branches on (confirm vs. cancel). */
  hasSelection(): boolean;
  /** Applies the current selection via onConfirm. No-op with nothing
   *  selected, so a stray call can't confirm an empty menu. */
  confirm(): void;
  cancel(): void;
  /** Focuses the filter box — called when the window opens so typing
   *  filters immediately without a click first. */
  focusFilter(): void;
  /** The quality tier the strip currently has active — read when something
   *  is picked out of this menu by a route other than confirm (index.ts's
   *  'q' pipette over a module cell). Always "normal" on a menu built
   *  without showQuality. */
  quality(): QualityName;
  /** Drives the quality strip from outside (index.ts's Shift+Alt+scroll
   *  quality-cycle shortcut, which can fire while this menu is open) so the
   *  visible highlight never disagrees with the quality a confirm applies.
   *  No-op on a menu built without showQuality. */
  setQuality(quality: QualityName): void;
}

interface RankedEntry extends GridMenuEntry {
  group: string;
  subgroup: string;
  sortKey: string;
}

function rank(entry: GridMenuEntry): RankedEntry {
  const position = entry.position;
  return {
    ...entry,
    group: position?.group ?? "other",
    subgroup: position?.subgroup ?? "other",
    // Same three-part key the build menu has always sorted by: subgroup
    // order first (so subgroups appear in the game's own sequence), then
    // the subgroup name to keep equal-order subgroups stable, then the
    // item/recipe's own order string.
    sortKey: `${position?.subgroupOrder ?? "~"} ${position?.subgroup ?? "~"} ${position?.order ?? ""}`,
  };
}

/** A menu group's tab icon is a whole-image PNG (item-group.icon, extracted
 *  by extract-sprites.ts's extractItemGroupIcons into its own directory),
 *  NOT a cell in the shared item/recipe icon sheet legacy-view/icons.ts's
 *  icon() reads from — so it needs its own tiny element builder instead of
 *  reusing icon(). */
export function groupTabIcon(group: MenuGroup, size: number): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "icon palette-group-icon";
  el.style.setProperty("--icon-size", `${size}px`);
  const basename = group.icon.split("/").pop();
  el.style.backgroundImage = `url(./data/sprites/item-groups/${basename})`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", group.localised);
  return el;
}

export function buildGridMenu(container: HTMLElement, options: GridMenuOptions): GridMenuHandle {
  container.replaceChildren();
  container.className = "grid-menu";

  const ranked = options.entries.map(rank);
  const byGroup = new Map<string, RankedEntry[]>();
  for (const entry of ranked) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.localised.localeCompare(b.localised));
  }

  // Tabs follow the dataset's own item-group order, keeping only groups this
  // menu has entries for. A group the item-group table has no icon for (the
  // "other" catch-all) still gets a tab so its entries stay reachable.
  const tabGroups: MenuGroup[] = options.groups.filter((g) => byGroup.has(g.name));
  for (const group of byGroup.keys()) {
    if (!tabGroups.some((g) => g.name === group)) {
      tabGroups.push({ name: group, icon: "", localised: group, order: "~" });
    }
  }

  let selected: string | undefined;
  let quality: QualityName = options.initialQuality ?? "normal";
  let activeTab = Math.max(
    0,
    tabGroups.findIndex((g) => byGroup.get(g.name)?.some((e) => e.name === options.initialSelection)),
  );

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter…";
  filterInput.className = "palette-filter";
  filterInput.setAttribute("aria-label", options.filterLabel);

  const tabStrip = document.createElement("div");
  tabStrip.className = "palette-tabs";
  tabStrip.setAttribute("role", "tablist");

  const grid = document.createElement("div");
  grid.className = "palette-grid";
  grid.style.setProperty("--palette-columns", String(GRID_COLUMNS));

  const footer = document.createElement("div");
  footer.className = "grid-menu-footer";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "grid-menu-confirm";
  confirmButton.title = "Confirm (E)";
  confirmButton.setAttribute("aria-label", "Confirm selection");
  confirmButton.textContent = "✔";
  confirmButton.disabled = true;

  function markSelected(name: string): void {
    selected = name;
    confirmButton.disabled = false;
    for (const cell of grid.querySelectorAll<HTMLButtonElement>(".palette-cell")) {
      cell.classList.toggle("is-selected", cell.dataset.value === name);
    }
  }

  function cellFor(entry: RankedEntry): HTMLButtonElement {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "palette-cell";
    cell.dataset.value = entry.name;
    // Read by index.ts's 'q' pipette shortcut (elementFromPoint under the
    // cursor -> closest .palette-cell -> this).
    cell.dataset.entityName = entry.name;
    cell.title = entry.localised;
    cell.setAttribute("aria-label", entry.localised);
    cell.classList.toggle("is-active", entry.name === options.initialSelection);
    cell.classList.toggle("is-selected", entry.name === selected);
    cell.appendChild(icon(entry.name, entry.localised, 36));
    cell.addEventListener("click", () => markSelected(entry.name));
    return cell;
  }

  /** `breakSubgroups` off while filtering: a search result set is a mix of
   *  subgroups by definition, so row-breaking it would just scatter matches
   *  across mostly-empty rows. */
  function renderGrid(entries: RankedEntry[], breakSubgroups: boolean): void {
    grid.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No matches.";
      grid.appendChild(empty);
      return;
    }

    // Each subgroup starts its own fresh row — matching the real game's own
    // build menu (belts, inserters, poles+pipes, rails, etc. each begin a
    // new row rather than flowing continuously into whatever column the
    // previous subgroup left off at). Padding the current row out to
    // GRID_COLUMNS with placeholder cells is what forces the CSS grid's
    // plain left-to-right auto-flow onto a new row without needing an
    // explicit grid-row on every cell.
    let column = 0;
    let previousSubgroup: string | null = null;
    for (const entry of entries) {
      if (breakSubgroups && previousSubgroup !== null && entry.subgroup !== previousSubgroup) {
        while (column % GRID_COLUMNS !== 0) {
          const filler = document.createElement("div");
          filler.className = "palette-cell-filler";
          grid.appendChild(filler);
          column++;
        }
      }
      previousSubgroup = entry.subgroup;
      column++;
      grid.appendChild(cellFor(entry));
    }
  }

  function renderTabs(): void {
    tabStrip.replaceChildren();
    // A lone tab is no choice at all — skip the strip rather than show one
    // unclickable-feeling button.
    if (tabGroups.length <= 1) {
      tabStrip.hidden = true;
      return;
    }
    tabStrip.hidden = false;
    tabGroups.forEach((group, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "palette-tab";
      tab.classList.toggle("is-active", i === activeTab);
      tab.title = group.localised;
      tab.setAttribute("aria-label", group.localised);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === activeTab));
      // A synthetic "other" tab has no item-group image of its own, so it
      // borrows its first entry's icon rather than rendering an empty frame.
      tab.appendChild(
        group.icon
          ? groupTabIcon(group, 42)
          : icon(byGroup.get(group.name)?.[0]?.name ?? "", group.localised, 28),
      );
      tab.addEventListener("click", () => {
        activeTab = i;
        filterInput.value = "";
        renderTabs();
        renderGrid(byGroup.get(group.name) ?? [], true);
      });
      tabStrip.appendChild(tab);
    });
  }

  filterInput.addEventListener("input", () => {
    const query = filterInput.value.trim().toLowerCase();
    if (!query) {
      renderTabs();
      renderGrid(byGroup.get(tabGroups[activeTab]?.name ?? "") ?? [], true);
      return;
    }
    // Search overrides tab selection and flattens every group into one grid,
    // matching the real game's search — the tabs are hidden while searching
    // since none of them reflect the shown (mixed-group) set.
    tabStrip.hidden = true;
    const matches = ranked
      .filter((e) => e.localised.toLowerCase().includes(query))
      .sort((a, b) => a.localised.localeCompare(b.localised));
    renderGrid(matches, false);
  });

  renderTabs();
  renderGrid(byGroup.get(tabGroups[activeTab]?.name ?? "") ?? [], true);

  let qualityButtons: HTMLButtonElement[] = [];
  if (options.showQuality) {
    const strip = document.createElement("div");
    strip.className = "palette-quality-strip";
    qualityButtons = QUALITY_TIERS.map((tier) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quality-dot";
      button.title = tier;
      button.setAttribute("aria-label", tier);
      button.appendChild(icon(tier, tier, 24));
      button.classList.toggle("is-active", tier === quality);
      button.addEventListener("click", () => {
        quality = tier;
        for (const b of qualityButtons) b.classList.toggle("is-active", b === button);
      });
      strip.appendChild(button);
      return button;
    });
    footer.appendChild(strip);
  }

  footer.appendChild(confirmButton);

  const handle: GridMenuHandle = {
    hasSelection: () => selected !== undefined,
    confirm() {
      if (selected === undefined) return;
      options.onConfirm({ name: selected, quality });
    },
    cancel: () => options.onCancel(),
    focusFilter: () => filterInput.focus(),
    quality: () => quality,
    setQuality(next) {
      quality = next;
      qualityButtons.forEach((b, i) => b.classList.toggle("is-active", QUALITY_TIERS[i] === next));
    },
  };

  confirmButton.addEventListener("click", () => handle.confirm());
  container.append(filterInput, tabStrip, grid, footer);
  return handle;
}
