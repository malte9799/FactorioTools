/** The game's "Blueprint in the blueprint library" window, opened by
 *  right-clicking a saved blueprint in the sidebar. Left: the edit form —
 *  name (pencil to rename) with the action buttons beside it, icons,
 *  description, snap to grid, and the components list. Right: a live
 *  preview of the blueprint. "Save blueprint" writes the form back.
 *
 *  Action buttons, as in the game: reassign (reselect the blueprint's
 *  contents with the copy tool), duplicate, upgrade and parametrise (not
 *  supported yet, shown disabled), export string, delete. */

import { getData, getRenderCatalog, normaliseEntities, normaliseWires } from "@factoriotools/engine";
import type { Blueprint, BpIcon, MenuPosition, QualityName } from "@factoriotools/engine";
import { mountRenderer, type BlueprintRenderer } from "@factoriotools/renderer";
import { buildGridMenu, type GridMenuEntry, type GridMenuHandle } from "./grid-menu.js";
import { icon } from "./legacy-view/icons.js";
import { blueprintIcon, qualityBadge } from "./blueprint-icon.js";
import { components, contentBox } from "./blueprint-geometry.js";
import { renderRichLabel } from "./rich-text.js";
import { currentQuality } from "../../render-presets.js";
import type { BlueprintMeta, SnapSettings } from "./blueprint-library.js";

const MAX_ICONS = 4;
const PREVIEW_SIZE = 56;
const GUI = "./data/sprites/gui/";

export interface LibraryWindowOptions {
  meta: BlueprintMeta;
  /** The decoded blueprint, for the preview and the components list. */
  blueprint: Blueprint | undefined;
  onSave(meta: BlueprintMeta): void;
  /** Reassign: the window has already saved and closed itself. */
  onReselect(): void;
  onDuplicate(): void;
  /** Copies the string; resolves false if the clipboard refused. */
  onExport(): Promise<boolean>;
  onDelete(): void;
  /** Set for a blueprint BOOK: the same window, with the book's blueprints
   *  in place of snap-to-grid, components and the preview. */
  book?: BookContents;
}

export interface BookContents {
  entries: { id: string; label: string; icons: BpIcon[] }[];
  /** The one loaded in the editor right now, if it is in this book. */
  activeId?: string;
  /** Click: open that blueprint in the editor. The window has already
   *  saved and closed itself. */
  onOpen(id: string): void;
  /** Right-click: that blueprint's own library window. */
  onEdit(id: string): void;
}

/** How a book's blueprints are laid out — the game's three toggle buttons.
 *  The last choice is remembered. */
type BookLayout = "list" | "grid" | "slots";
const BOOK_LAYOUTS: { layout: BookLayout; title: string; svg: string; iconSize: number }[] = [
  { layout: "list", title: "List", iconSize: 56, svg: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 2h4v3H1zm6 .5h8v2H7zM1 6.5h4v3H1zm6 .5h8v2H7zM1 11h4v3H1zm6 .5h8v2H7z"/></svg>` },
  { layout: "grid", title: "Grid", iconSize: 56, svg: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 1h4v4H1zm5 0h4v4H6zm5 0h4v4h-4zM1 6h4v4H1zm5 0h4v4H6zm5 0h4v4h-4zM1 11h4v4H1zm5 0h4v4H6zm5 0h4v4h-4z"/></svg>` },
  { layout: "slots", title: "Slots", iconSize: 32, svg: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 1h3v3H1zm4 0h3v3H5zm4 0h3v3H9zm4 0h2v3h-2zM1 5h3v3H1zm4 0h3v3H5zm4 0h3v3H9zm4 0h2v3h-2zM1 9h3v3H1zm4 0h3v3H5zm4 0h3v3H9zm4 0h2v3h-2zM1 13h3v2H1zm4 0h3v2H5zm4 0h3v2H9zm4 0h2v2h-2z"/></svg>` },
];
const BOOK_LAYOUT_KEY = "factoriotools.blueprint-viewer.library.book-layout";

function readBookLayout(): BookLayout {
  try {
    const stored = localStorage.getItem(BOOK_LAYOUT_KEY);
    return stored === "list" || stored === "slots" ? stored : "grid";
  } catch {
    return "grid";
  }
}

/** Slots hold the signal by position 1–4; a cleared slot is a gap, kept as
 *  such in the saved `index` values the way the game keeps them. */
type Slots = (BpIcon["signal"] | null)[];

export function openLibraryWindow(options: LibraryWindowOptions): void {
  const slots: Slots = Array.from({ length: MAX_ICONS }, () => null);
  for (const entry of options.meta.icons) {
    const i = entry.index - 1;
    if (i >= 0 && i < MAX_ICONS && entry.signal?.name) slots[i] = entry.signal;
  }
  let label = options.meta.label;
  const book = options.book;
  const itemName = book ? "blueprint-book" : "blueprint";
  const box = options.blueprint ? contentBox(options.blueprint) : null;
  // What a fresh "Snap to grid" starts from: a cell exactly the content's
  // size, the content in its top-left corner, relative snapping.
  const snapDefaults: SnapSettings = options.meta.snap ?? {
    size: { x: box ? box.maxX - box.minX : 1, y: box ? box.maxY - box.minY : 1 },
    position: { x: 0, y: 0 },
    absolute: false,
    offset: { x: 0, y: 0 },
  };

  const backdrop = el("div", "modal-backdrop");
  const win = el("div", "gui-window bp-lib-window");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-modal", "true");

  /* ----- titlebar ----- */
  const titlebar = el("div", "gui-titlebar");
  const close = el("button", "gui-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "✕";
  titlebar.append(text("span", book ? "Blueprint book in the blueprint library" : "Blueprint in the blueprint library"), grip(), close);

  /* ----- left: form ----- */
  const form = el("div", "bp-lib-form");

  const header = el("div", "bp-lib-header");
  const nameBox = el("div", "bp-lib-name");
  const renameButton = el("button", "bp-lib-rename");
  renameButton.type = "button";
  renameButton.title = "Rename";
  renameButton.appendChild(guiImage("rename-icon"));
  const actions = el("div", "bp-lib-actions");
  header.append(nameBox, renameButton, actions);

  function renderName(): void {
    nameBox.replaceChildren(label.trim() ? renderRichLabel(label, 16) : document.createTextNode(book ? "<Unnamed book>" : "<Unnamed blueprint>"));
    nameBox.title = label;
  }
  function startRename(): void {
    const input = el("input", "bp-lib-name-input");
    input.type = "text";
    input.value = label;
    input.maxLength = 200;
    input.spellcheck = false;
    nameBox.replaceChildren(input);
    renameButton.hidden = true;
    input.focus();
    input.select();
    const commit = () => {
      label = input.value;
      renameButton.hidden = false;
      renderName();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        e.preventDefault();
        input.value = label;
        input.blur();
      }
    });
  }
  renameButton.addEventListener("click", startRename);
  nameBox.addEventListener("dblclick", startRename);
  renderName();

  const deleteButton = actionButton("is-red", "trash", "Delete");
  let deleteArmed: ReturnType<typeof setTimeout> | undefined;
  actions.append(
    book
      ? actionButton("is-blue", "reassign", "Reselect contents — only a single blueprint has contents to reselect", undefined, true)
      : actionButton("is-blue", "reassign", "Reselect contents — drag a box over the buildings that should make up this blueprint", () => {
          save();
          dismiss();
          options.onReselect();
        }),
    actionButton("is-grey", "copy", "Duplicate", () => options.onDuplicate()),
    actionButton("is-green", "upgrade-blueprint", "Upgrade — not supported yet", undefined, true),
    actionButton("is-green", "parametrise", "Parametrise — not supported yet", undefined, true),
    actionButton("is-grey", "export-slot", "Export string — copy to clipboard", async (button) => {
      const ok = await options.onExport();
      flash(button, ok ? "Copied" : "Couldn't copy");
    }),
    deleteButton,
  );
  // Two clicks, as a safety: the first arms the button for a few seconds.
  deleteButton.addEventListener("click", () => {
    if (deleteArmed) {
      clearTimeout(deleteArmed);
      dismiss();
      options.onDelete();
      return;
    }
    deleteButton.classList.add("is-armed");
    deleteButton.title = "Click again to delete";
    deleteArmed = setTimeout(() => {
      deleteArmed = undefined;
      deleteButton.classList.remove("is-armed");
      deleteButton.title = "Delete";
    }, 3000);
  });

  // Icon
  const iconPanel = panel("Icon", "Up to four icons. Click a slot to pick one, right-click to clear it.");
  const iconRow = el("div", "bp-edit-icon-row");
  const preview = el("div", "bp-edit-preview");
  const slotWell = el("div", "bp-edit-slots");
  iconRow.append(preview, slotWell);
  iconPanel.appendChild(iconRow);

  // Description
  const descPanel = panel("Description");
  const descInput = el("textarea", "bp-edit-description");
  descInput.value = options.meta.description;
  descInput.rows = 4;
  // Rendered as the game shows it: colours, fonts and icons.
  const descPreview = el("div", "bp-edit-description-preview");
  const renderDescription = () => {
    descPreview.replaceChildren(renderRichLabel(descInput.value, 16));
    descPreview.hidden = !descInput.value.trim();
  };
  descInput.addEventListener("input", renderDescription);
  renderDescription();
  descPanel.append(descInput, descPreview);

  // Snap to grid
  const snapPanel = el("div", "bp-lib-panel bp-lib-snap");
  const snapToggle = el("label", "bp-lib-check");
  const snapCheck = el("input");
  snapCheck.type = "checkbox";
  snapCheck.checked = options.meta.snap !== null;
  snapToggle.append(snapCheck, text("span", "Snap to grid"));
  const sizeX = numberInput(snapDefaults.size.x, 1);
  const sizeY = numberInput(snapDefaults.size.y, 1);
  const posX = numberInput(snapDefaults.position.x, 0);
  const posY = numberInput(snapDefaults.position.y, 0);
  const offX = numberInput(snapDefaults.offset.x);
  const offY = numberInput(snapDefaults.offset.y);
  const absoluteRadio = radio("bp-lib-snap-mode", snapDefaults.absolute);
  const relativeRadio = radio("bp-lib-snap-mode", !snapDefaults.absolute);
  const snapGrid = el("div", "bp-lib-snap-grid");
  snapGrid.append(
    snapLabel("Grid size", "The size of one grid cell, in tiles."),
    text("span", "Width:", "bp-lib-axis"), sizeX, text("span", "Height:", "bp-lib-axis"), sizeY,
    snapLabel("Grid position", "Where the blueprint sits inside its grid cell."),
    text("span", "X:", "bp-lib-axis"), posX, text("span", "Y:", "bp-lib-axis"), posY,
    radioLabel(absoluteRadio, "Absolute", "Cells line up with the world grid, shifted by X/Y."),
    text("span", "X:", "bp-lib-axis"), offX, text("span", "Y:", "bp-lib-axis"), offY,
    radioLabel(relativeRadio, "Relative", "Cells line up with wherever the first copy was placed."),
  );
  snapPanel.append(snapToggle, snapGrid);
  function syncSnapEnabled(): void {
    const on = snapCheck.checked;
    snapPanel.classList.toggle("is-off", !on);
    for (const input of [sizeX, sizeY, posX, posY, absoluteRadio, relativeRadio]) input.disabled = !on;
    offX.disabled = offY.disabled = !on || !absoluteRadio.checked;
  }
  for (const input of [snapCheck, absoluteRadio, relativeRadio]) input.addEventListener("change", syncSnapEnabled);
  syncSnapEnabled();

  // Components
  const compPanel = panel("Components", "Everything this blueprint builds, with counts.");
  const compWell = el("div", "bp-lib-components");
  const catalog = getRenderCatalog();
  for (const { name, count } of options.blueprint ? components(options.blueprint) : []) {
    const slot = el("span", "bp-lib-component");
    slot.title = `${catalog.itemNames[name] ?? name.replace(/-/g, " ")} × ${count}`;
    slot.append(icon(name, slot.title, 28), text("span", formatCount(count), "bp-lib-count"));
    compWell.appendChild(slot);
  }
  // Fill the last row with empty slots, as the game's slot grid does.
  const COLUMNS = 10;
  const filled = compWell.childElementCount;
  for (let i = filled; i < Math.max(COLUMNS, Math.ceil(filled / COLUMNS) * COLUMNS); i++) compWell.appendChild(el("span", "bp-lib-component is-empty"));
  compPanel.appendChild(compWell);

  form.append(header, el("div", "bp-lib-panels"));
  if (book) form.lastElementChild!.append(iconPanel, descPanel);
  else form.lastElementChild!.append(iconPanel, descPanel, snapPanel, compPanel);

  /* ----- right: preview ----- */
  const previewPane = el("div", "bp-lib-preview");
  const previewHead = el("div", "bp-lib-preview-head");
  previewHead.append(text("strong", "Preview"), text("span", "Scroll to zoom, drag to pan.", "bp-lib-hint"));
  const previewCanvas = el("div", "bp-lib-preview-canvas");
  previewPane.append(previewHead, previewCanvas);

  /* ----- right, for a book: its blueprints ----- */
  const contentsPane = el("div", "bp-lib-preview bp-book-contents");
  const contentsHead = el("div", "bp-lib-preview-head");
  const layoutButtons = el("div", "bp-book-layouts");
  contentsHead.append(text("span", "Click a blueprint to open it, right-click to edit it.", "bp-lib-hint"), layoutButtons);
  const contentsBody = el("div", "bp-book-items");
  contentsPane.append(contentsHead, contentsBody);
  let bookLayout = readBookLayout();

  function renderBook(): void {
    if (!book) return;
    const current = BOOK_LAYOUTS.find((l) => l.layout === bookLayout)!;
    layoutButtons.replaceChildren();
    for (const option of BOOK_LAYOUTS) {
      const button = el("button", "bp-book-layout");
      button.type = "button";
      button.title = option.title;
      button.setAttribute("aria-label", `${option.title} view`);
      button.setAttribute("aria-pressed", String(option.layout === bookLayout));
      button.classList.toggle("is-active", option.layout === bookLayout);
      button.innerHTML = option.svg;
      button.addEventListener("click", () => {
        bookLayout = option.layout;
        try {
          localStorage.setItem(BOOK_LAYOUT_KEY, bookLayout);
        } catch {
          /* storage unavailable — the choice still holds while the window is open */
        }
        renderBook();
      });
      layoutButtons.appendChild(button);
    }

    contentsBody.className = `bp-book-items is-${bookLayout}`;
    contentsBody.replaceChildren();
    for (const entry of book.entries) {
      const item = el("button", "bp-book-item");
      item.type = "button";
      item.classList.toggle("is-active", entry.id === book.activeId);
      // The raw name stays the tooltip — the slots view shows nothing else.
      item.title = entry.label;
      const art = el("span", "bp-book-item-icon");
      art.appendChild(blueprintIcon("blueprint", entry.icons, current.iconSize));
      const name = el("span", "bp-book-item-label");
      name.appendChild(renderRichLabel(entry.label, 14));
      item.append(art, name);
      item.addEventListener("click", () => {
        save();
        dismiss();
        book.onOpen(entry.id);
      });
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        save();
        dismiss();
        book.onEdit(entry.id);
      });
      contentsBody.appendChild(item);
    }
    // The grid and slots views pad the last row out with empty slots, as
    // the game's slot grids do. The column count is whatever the layout
    // settled on at this width.
    if (bookLayout !== "list") {
      const columns = getComputedStyle(contentsBody).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
      const filledSlots = book.entries.length;
      for (let i = filledSlots; i < Math.max(columns, Math.ceil(filledSlots / columns) * columns); i++) {
        const empty = el("span", "bp-book-item is-empty");
        empty.appendChild(el("span", "bp-book-item-icon")).style.cssText = `width:${current.iconSize}px;height:${current.iconSize}px`;
        contentsBody.appendChild(empty);
      }
    }
  }

  const columns = el("div", "bp-lib-columns");
  columns.append(form, book ? contentsPane : previewPane);

  /* ----- footer ----- */
  const footer = el("div", "bp-edit-footer");
  const saveButton = el("button", "bp-edit-confirm");
  saveButton.type = "button";
  saveButton.textContent = book ? "Save blueprint book" : "Save blueprint";
  footer.append(grip(), saveButton);

  win.append(titlebar, columns, footer);
  backdrop.appendChild(win);
  document.body.appendChild(backdrop);

  // The preview is a real renderer: mounted once the window has its size.
  let renderer: BlueprintRenderer | null = null;
  if (book) {
    renderBook();
  } else if (options.blueprint) {
    renderer = mountRenderer(previewCanvas, getData(), getRenderCatalog(), currentQuality());
    renderer.loadBlueprint(normaliseEntities(options.blueprint), normaliseWires(options.blueprint));
  } else {
    previewCanvas.appendChild(text("p", "This blueprint doesn't decode.", "bp-lib-empty"));
  }

  /* ----- icon slots ----- */

  let picker: HTMLElement | null = null;
  let pickerMenu: GridMenuHandle | null = null;
  let pickingIndex = -1;

  function renderIcons(): void {
    slotWell.replaceChildren();
    slots.forEach((signal, i) => {
      const slot = el("button", "bp-edit-slot");
      slot.type = "button";
      slot.classList.toggle("is-picking", picker !== null && pickingIndex === i);
      if (signal) {
        slot.appendChild(icon(signal.name, signalLabel(signal.name), 28));
        if (signal.quality && signal.quality !== "normal") slot.appendChild(qualityBadge(signal.quality, 12));
        slot.title = `${signalLabel(signal.name)}${signal.quality && signal.quality !== "normal" ? ` (${signal.quality})` : ""}\nRight-click to clear`;
      } else {
        slot.title = "Pick an icon";
      }
      slot.addEventListener("click", () => openPicker(i, slot));
      slot.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        slots[i] = null;
        renderIcons();
      });
      slotWell.appendChild(slot);
    });
    preview.replaceChildren(blueprintIcon(itemName, currentIcons(), PREVIEW_SIZE));
  }

  function openPicker(index: number, anchor: HTMLElement): void {
    closePicker();
    pickingIndex = index;
    const pickerEl = el("div", "gui-window menu-window bp-edit-picker");
    const bar = el("div", "gui-titlebar");
    bar.append(text("span", "Select icon"), grip());
    const pickerBody = el("div", "gui-body");
    pickerEl.append(bar, pickerBody);
    backdrop.appendChild(pickerEl);

    const current = slots[index];
    pickerMenu = buildGridMenu(pickerBody, {
      entries: signalEntries(),
      groups: catalog.menuGroups,
      filterLabel: "Filter signals",
      initialSelection: current?.name,
      showQuality: true,
      initialQuality: (current?.quality as QualityName | undefined) ?? "normal",
      onConfirm: ({ name, quality }) => {
        const signal = catalog.signals?.[name];
        const picked: BpIcon["signal"] = signal ? { type: signal.type, name } : { type: "item", name };
        // The game writes quality only when it isn't normal.
        if (quality !== "normal") picked.quality = quality;
        slots[index] = picked;
        closePicker();
        renderIcons();
      },
      onCancel: () => {
        closePicker();
        renderIcons();
      },
    });
    pickerMenu.focusFilter();

    // Beside the window when there's room, else over it.
    const winRect = win.getBoundingClientRect();
    const left = winRect.right + 8 + pickerEl.offsetWidth <= window.innerWidth ? winRect.right + 8 : Math.max(8, window.innerWidth - pickerEl.offsetWidth - 8);
    pickerEl.style.left = `${left}px`;
    pickerEl.style.top = `${Math.max(8, Math.min(anchor.getBoundingClientRect().top - 120, window.innerHeight - pickerEl.offsetHeight - 8))}px`;
    picker = pickerEl;
    renderIcons();
  }

  function closePicker(): void {
    picker?.remove();
    picker = null;
    pickerMenu = null;
    pickingIndex = -1;
  }

  function currentIcons(): BpIcon[] {
    const icons: BpIcon[] = [];
    slots.forEach((signal, i) => {
      if (!signal) return;
      const { type, ...rest } = signal;
      icons.push({ index: i + 1, signal: type === "item" ? rest : signal });
    });
    return icons;
  }

  /* ----- save / dismiss ----- */

  function currentSnap(): SnapSettings | null {
    if (!snapCheck.checked) return null;
    return {
      size: { x: Math.max(1, readNumber(sizeX, 1)), y: Math.max(1, readNumber(sizeY, 1)) },
      position: { x: readNumber(posX, 0), y: readNumber(posY, 0) },
      absolute: absoluteRadio.checked,
      offset: { x: readNumber(offX, 0), y: readNumber(offY, 0) },
    };
  }

  function save(): void {
    options.onSave({ label, description: descInput.value, icons: currentIcons(), snap: book ? null : currentSnap() });
  }

  function dismiss(): void {
    closePicker();
    clearTimeout(deleteArmed);
    renderer?.destroy();
    renderer = null;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e: KeyboardEvent): void {
    // Nothing reaches the editor's own shortcuts (E, Q, R, digits…) while
    // the window is open; typing still works since nothing is prevented.
    e.stopPropagation();
    // E in the icon picker, as in every game menu: confirm the picked
    // signal, or close the picker with nothing picked. Typing in the
    // filter box keeps its E.
    if (pickerMenu && e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !e.altKey
      && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      if (pickerMenu.hasSelection()) pickerMenu.confirm();
      else pickerMenu.cancel();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (picker) {
      closePicker();
      renderIcons();
    } else if (!(e.target instanceof HTMLInputElement && e.target.classList.contains("bp-lib-name-input"))) {
      dismiss();
    }
  }

  close.addEventListener("click", dismiss);
  saveButton.addEventListener("click", () => {
    save();
    dismiss();
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey, true);

  renderIcons();
}

/* ---------- small DOM helpers ---------- */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag: keyof HTMLElementTagNameMap, content: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = content;
  return node;
}

function grip(): HTMLElement {
  const g = el("span", "grip");
  g.setAttribute("aria-hidden", "true");
  return g;
}

function guiImage(name: string): HTMLImageElement {
  const img = el("img");
  img.src = `${GUI}${name}.png`;
  img.alt = "";
  img.draggable = false;
  return img;
}

function actionButton(
  tone: string,
  sprite: string,
  title: string,
  onClick?: (button: HTMLButtonElement) => void,
  disabled = false,
): HTMLButtonElement {
  const button = el("button", `bp-lib-action ${tone}`);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.appendChild(guiImage(sprite));
  if (onClick) button.addEventListener("click", () => onClick(button));
  return button;
}

/** A short confirmation on a button, in its tooltip and a brief highlight. */
function flash(button: HTMLButtonElement, message: string): void {
  const title = button.title;
  button.title = message;
  button.classList.add("is-flash");
  setTimeout(() => {
    button.title = title;
    button.classList.remove("is-flash");
  }, 1200);
}

function panel(title: string, info?: string): HTMLElement {
  const p = el("div", "bp-lib-panel");
  const heading = text("div", title, "bp-edit-label");
  if (info) heading.appendChild(infoDot(info));
  p.appendChild(heading);
  return p;
}

function infoDot(info: string): HTMLElement {
  const dot = text("span", "i", "bp-lib-info");
  dot.title = info;
  return dot;
}

function snapLabel(title: string, info: string): HTMLElement {
  const label = text("span", title, "bp-lib-snap-label");
  label.appendChild(infoDot(info));
  return label;
}

function numberInput(value: number, min?: number): HTMLInputElement {
  const input = el("input", "bp-lib-number");
  input.type = "number";
  input.step = "1";
  if (min !== undefined) input.min = String(min);
  input.value = String(value);
  return input;
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const n = Math.round(Number(input.value));
  return Number.isFinite(n) ? n : fallback;
}

function radio(name: string, checked: boolean): HTMLInputElement {
  const input = el("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  return input;
}

function radioLabel(input: HTMLInputElement, title: string, info: string): HTMLElement {
  const label = el("label", "bp-lib-radio");
  label.append(input, text("span", title));
  label.appendChild(infoDot(info));
  return label;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 100) / 10}k` : String(n);
}

function signalLabel(name: string): string {
  const catalog = getRenderCatalog();
  return catalog.signals?.[name]?.localised ?? catalog.itemNames[name] ?? name.replace(/-/g, " ");
}

/** Every item, fluid and virtual signal, in the game's own tabs (fluids and
 *  signals each have their own item-group). */
function signalEntries(): GridMenuEntry[] {
  const catalog = getRenderCatalog();
  const entries: GridMenuEntry[] = Object.entries(catalog.itemNames).map(([name, localised]) => ({
    name,
    localised,
    position: catalog.itemMenuPositions[name] as MenuPosition | undefined,
  }));
  for (const [name, signal] of Object.entries(catalog.signals ?? {})) {
    if (catalog.itemNames[name]) continue;
    entries.push({ name, localised: signal.localised, position: signal.position });
  }
  return entries;
}
