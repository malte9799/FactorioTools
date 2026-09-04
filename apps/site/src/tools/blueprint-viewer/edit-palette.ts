import type { GameData, MenuGroup, QualityName, RenderCatalog } from "@factoriotools/engine";
import { icon } from "./legacy-view/icons.js";
import { QUALITY_TIERS } from "./quality-options.js";

export interface PaletteEntry {
  name: string;
  localised: string;
  subgroup: string;
}

/** Fixed grid width — matches the real game's own build-menu grid (10
 *  columns), confirmed by counting cells in the user's own reference
 *  screenshots of the actual in-game menu. A fixed column count (not
 *  auto-fill) is deliberate: it's what makes the grid read as a grid
 *  instead of reflowing arbitrarily with window width. */
const GRID_COLUMNS = 10;

interface CategorisedGroup extends MenuGroup {
  entries: PaletteEntry[];
}

/** Builds one flat, correctly-ordered entry list per menu group, using the
 *  real game's own item-group -> item-subgroup -> item.order structure
 *  (RenderCatalog.menuGroups/menuPositions, resolved by the data pipeline
 *  from the dump's item-group table — confirmed by spike this is exactly
 *  what the in-game build menu itself sorts by, not a guessed
 *  categorization). Only groups that actually contain at least one
 *  placeable entity are kept — most of the game's 12 item-groups (fluids,
 *  signals, enemies, tiles, environment, effects) never appear in a
 *  blueprint's placeable-entity set, matching why the reference screenshots
 *  only show 6 tabs. */
function buildCategorisedGroups(data: GameData, catalog: RenderCatalog): CategorisedGroup[] {
  const allNames: { name: string; localised: string }[] = [
    ...Object.values(data.machines),
    ...Object.values(data.beacons),
    ...Object.values(data.belts),
    ...Object.values(data.inserters),
    ...Object.values(catalog.entities),
  ];
  const seen = new Set<string>();

  const byGroup = new Map<string, { entry: PaletteEntry; sortKey: string }[]>();
  for (const proto of allNames) {
    if (seen.has(proto.name)) continue; // GameData takes precedence over catalog duplicates
    seen.add(proto.name);
    const position = catalog.menuPositions[proto.name];
    if (!position) continue; // no item resolves place_result to this entity — not directly placeable
    const sortKey = `${position.subgroupOrder} ${position.subgroup} ${position.order}`;
    const list = byGroup.get(position.group) ?? [];
    list.push({ entry: { name: proto.name, localised: proto.localised, subgroup: position.subgroup }, sortKey });
    byGroup.set(position.group, list);
  }

  const groups: CategorisedGroup[] = [];
  for (const menuGroup of catalog.menuGroups) {
    const ranked = byGroup.get(menuGroup.name);
    if (!ranked || ranked.length === 0) continue;
    ranked.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    groups.push({ ...menuGroup, entries: ranked.map((r) => r.entry) });
  }
  return groups;
}

/** A menu group's tab icon is a whole-image PNG (item-group.icon, extracted
 *  by extract-sprites.ts's extractItemGroupIcons into its own directory),
 *  NOT a cell in the shared item/recipe icon sheet legacy-view/icons.ts's
 *  icon() reads from — so it needs its own tiny element builder instead of
 *  reusing icon(). */
function groupTabIcon(group: MenuGroup, size: number): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "icon palette-group-icon";
  el.style.setProperty("--icon-size", `${size}px`);
  const basename = group.icon.split("/").pop();
  el.style.backgroundImage = `url(/data/sprites/item-groups/${basename})`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", group.localised);
  return el;
}

/** Builds the quality strip shown at the bottom of the build palette (per
 *  the user's own reference screenshot: 5 circles, normal through
 *  legendary) — selects which quality newly-placed entities carry, AND
 *  (per the user's own design: "building over an existing entity with a
 *  different quality selected changes its quality") is read by
 *  index.ts's placeEntity when deciding whether a click on an occupied
 *  tile should upgrade that entity in place instead of adding a new one. */
function buildQualityStrip(container: HTMLElement, initial: QualityName, onChange: (quality: QualityName) => void): void {
  container.className = "palette-quality-strip";
  let active = initial;
  const buttons = QUALITY_TIERS.map((tier) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quality-dot quality-${tier}`;
    button.title = tier;
    button.setAttribute("aria-label", tier);
    button.classList.toggle("is-active", tier === active);
    button.addEventListener("click", () => {
      active = tier;
      for (const b of buttons) b.classList.toggle("is-active", b === button);
      onChange(active);
    });
    container.appendChild(button);
    return button;
  });
}

/** Builds a tabbed, fixed-width-grid placeable-entity picker into
 *  `container` — category tabs across the top (one per real item-group,
 *  e.g. Logistics/Production/Intermediate Products/Space/Combat/Other) with
 *  a 10-column grid of square icon buttons below, ordered by the game's own
 *  subgroup/item order — matching the real in-game "Set ghost cursor" menu
 *  the user's own reference screenshots show, not an invented category
 *  scheme. Typing in the filter searches across every group at once
 *  (matching the real game: the search box overrides tab selection while
 *  non-empty) and flattens results into one grid. Clicking a cell calls
 *  `onPick(entityName, quality)`, quality being whatever the bottom quality
 *  strip currently has selected — the caller wires that to
 *  renderer.setInteractionMode({kind:'place', entityName}) plus tracking
 *  the chosen quality for the next placement. Plain DOM construction, no
 *  template library, matching legacy-view/panels.ts's style. */
export function buildPalette(
  container: HTMLElement,
  data: GameData,
  catalog: RenderCatalog,
  onPick: (entityName: string, quality: QualityName) => void,
): void {
  const groups = buildCategorisedGroups(data, catalog);
  let selectedQuality: QualityName = "normal";

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter…";
  filterInput.className = "palette-filter";
  filterInput.setAttribute("aria-label", "Filter placeable entities");

  const tabStrip = document.createElement("div");
  tabStrip.className = "palette-tabs";
  tabStrip.setAttribute("role", "tablist");

  const grid = document.createElement("div");
  grid.className = "palette-grid";
  grid.style.setProperty("--palette-columns", String(GRID_COLUMNS));

  const qualityStrip = document.createElement("div");
  buildQualityStrip(qualityStrip, selectedQuality, (quality) => {
    selectedQuality = quality;
  });

  let activeGroupIndex = 0;

  function renderGrid(entries: PaletteEntry[]): void {
    grid.replaceChildren();
    if (entries.length === 0) {
      grid.innerHTML = `<p class="empty">No matches.</p>`;
      return;
    }
    // Each subgroup starts its own fresh row — matching the real game's own
    // build menu (confirmed by spike against reference screenshots: belts,
    // inserters, poles+pipes, rails, etc. each begin a new row rather than
    // flowing continuously into whatever column the previous subgroup left
    // off at). Padding the current row out to GRID_COLUMNS with empty
    // placeholder cells before a subgroup change is what forces the CSS
    // grid (a plain left-to-right auto-flow) onto a new row without needing
    // an explicit `grid-row` on every cell.
    let column = 0;
    let previousSubgroup: string | null = null;
    for (const entry of entries) {
      if (previousSubgroup !== null && entry.subgroup !== previousSubgroup) {
        while (column % GRID_COLUMNS !== 0) {
          const filler = document.createElement("div");
          filler.className = "palette-cell-filler";
          grid.appendChild(filler);
          column++;
        }
      }
      previousSubgroup = entry.subgroup;
      column++;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "palette-cell";
      cell.title = entry.localised;
      cell.setAttribute("aria-label", entry.localised);
      cell.appendChild(icon(entry.name, entry.localised, 36));
      cell.addEventListener("click", () => onPick(entry.name, selectedQuality));
      grid.appendChild(cell);
    }
  }

  function renderTabs(): void {
    tabStrip.replaceChildren();
    groups.forEach((group, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "palette-tab";
      tab.classList.toggle("is-active", i === activeGroupIndex);
      tab.title = group.localised;
      tab.setAttribute("aria-label", group.localised);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === activeGroupIndex));
      tab.appendChild(groupTabIcon(group, 32));
      tab.addEventListener("click", () => {
        activeGroupIndex = i;
        filterInput.value = "";
        renderTabs();
        renderGrid(groups[i]!.entries);
      });
      tabStrip.appendChild(tab);
    });
  }

  filterInput.addEventListener("input", () => {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) {
      tabStrip.hidden = false;
      renderGrid(groups[activeGroupIndex]?.entries ?? []);
      return;
    }
    // Search overrides tab selection and flattens every category into one
    // grid, matching the real game's search behavior — hide the tabs while
    // searching since none of them reflect the shown (mixed-category) set.
    tabStrip.hidden = true;
    const matches = groups.flatMap((g) => g.entries).filter((e) => e.localised.toLowerCase().includes(q));
    matches.sort((a, b) => a.localised.localeCompare(b.localised));
    renderGrid(matches);
  });

  renderTabs();
  renderGrid(groups[activeGroupIndex]?.entries ?? []);

  container.replaceChildren(filterInput, tabStrip, grid, qualityStrip);
}
