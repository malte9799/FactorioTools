import { ROTATION_TEST_BLUEPRINT, DEBUG_BLUEPRINT, RED_SCIENCE_240_BLUEPRINT, GREEN_SCIENCE_240_BLUEPRINT } from "@factoriotools/engine";
import type { BlueprintTreeNode } from "@factoriotools/engine";
import {
  listSaved,
  saveToLibrary,
  deleteFromLibrary,
  deleteBookFromLibrary,
  duplicateInLibrary,
  duplicateBookInLibrary,
  renameInLibrary,
  editInLibrary,
  readEntryMeta,
  decodeEntry,
  replaceContentsInLibrary,
  type SavedBlueprint,
} from "./blueprint-library.js";
import { openLibraryWindow } from "./blueprint-library-window.js";
import { blueprintIcon } from "./blueprint-icon.js";
import type { BpIcon } from "@factoriotools/engine";

/** Each saved entry's own icons, decoded out of its string once and kept
 *  until the string changes — the list re-renders on every click. */
const iconCache = new Map<string, { bpString: string; icons: BpIcon[] }>();
function entryIcons(entry: SavedBlueprint): BpIcon[] {
  const hit = iconCache.get(entry.id);
  if (hit && hit.bpString === entry.bpString) return hit.icons;
  const icons = readEntryMeta(entry).icons;
  iconCache.set(entry.id, { bpString: entry.bpString, icons });
  return icons;
}
import { icon } from "./legacy-view/icons.js";
import { renderRichLabel } from "./rich-text.js";

export interface LibraryCallbacks {
  /** Load this blueprint string as the active one in the editor. */
  onLoad(bpString: string): void;
  /** Returns the current blueprint string to save, or null if there's nothing to save yet. */
  getCurrentBpString(): string | null;
  /** Clears the canvas back to an empty blueprint, for starting fresh. */
  onNew(): void;
  /** The currently-loaded book's folder tree (nested sub-books kept intact),
   *  or null for a loose blueprint / nothing loaded yet — backs the "Current
   *  book" section so an imported-but-not-saved book shows up as nested
   *  collapsible folders too, not just whatever's in the library. */
  getCurrentBookTree(): BlueprintTreeNode | null;
  /** Switches the active sub-blueprint within the currently-loaded book,
   *  by its flat index (matching collectBlueprints' own order) — the
   *  sidebar equivalent of the existing #bp-picker dropdown's change
   *  handler, so a book doesn't need re-importing just to look at a
   *  different one of its blueprints. */
  onSelectCurrent(flatIndex: number): void;
  /** The library window's reassign: arm the copy tool, and hand the boxed
   *  selection (as a blueprint string) to `apply` once one is drawn. */
  onReselect(apply: (bpString: string) => void): void;
  /** Shift+click on a saved blueprint: take it into the cursor to place,
   *  with its snap-to-grid. */
  onPickUp(bpString: string): void;
  /** A short confirmation or error line for the user. */
  notify(message: string, kind?: "info" | "error"): void;
}

interface BuiltinEntry {
  id: string;
  label: string;
  /** Item icon shown in front of the label — built-ins have no rich-text
   *  name of their own to take one from. */
  icon: string;
  bpString: string;
}

/** Debug fixtures, listed loose at the top of the panel the way the game's
 *  Surfaces panel lists "Space map" above its categories. The throughput
 *  builds are known to hit full throughput in game: what the rate
 *  calculator should reproduce. */
const BUILTINS: BuiltinEntry[] = [
  { id: "builtin-rotation-test", label: "Rotation test", icon: "inserter", bpString: ROTATION_TEST_BLUEPRINT },
  { id: "builtin-debug-lab", label: "Debug lab", icon: "lab", bpString: DEBUG_BLUEPRINT },
  { id: "builtin-red-science-240", label: "Red science 240/s", icon: "assembling-machine-1", bpString: RED_SCIENCE_240_BLUEPRINT },
  { id: "builtin-green-science-240", label: "Green science 240/s", icon: "assembling-machine-2", bpString: GREEN_SCIENCE_240_BLUEPRINT },
];

/** Inline line-art for the row action buttons, drawn in currentColor so
 *  the button decides the colour — the game's own trash and plus glyphs are
 *  flat white shapes on a coloured square. */
const TRASH_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6 1h4l.5 1H14v2H2V2h3.5zM3 5h10l-.8 10H3.8zm2.4 2 .3 6h1.2l-.2-6zm2 0v6h1.2V7zm2 0-.2 6h1.2l.3-6z"/></svg>`;
const PLUS_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>`;
const SAVE_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2h9.5L14 4.5V14H2zm2 1.5V6h6V3.5zM4 9v3.5h8V9z"/></svg>`;

/** Sections the user has folded shut — module-level so the panel remembers
 *  disclosure state across re-renders within a session (every mutation
 *  re-renders the whole list from scratch, see refresh() below). Stored as
 *  the collapsed set rather than the open one so a freshly saved book shows
 *  up expanded, like every category in the game's own panel. */
const collapsed = new Set<string>();

/** Which row is the one on screen, highlighted gold like the game's
 *  selected surface. Keyed `builtin:<id>`, `saved:<id>` or
 *  `current:<flatIndex>`; cleared by "New blueprint". */
let activeKey: string | null = null;

function makeIconButton(className: string, svg: string, label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `bp-icon-button ${className}`;
  button.innerHTML = svg;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

interface SectionActions {
  onDelete?: () => void;
  onDuplicate?: () => void;
}

/** A category header and its rows. `title` can carry a blueprint book's own
 *  label — attacker-controlled and persisted in localStorage — so it only
 *  ever reaches the DOM through renderRichLabel's text nodes. */
function makeSection(
  key: string,
  title: string,
  options: { iconName?: string; nested?: boolean; actions?: SectionActions } = {},
): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("div");
  section.className = "bp-section";
  if (options.nested) section.classList.add("is-nested");

  const headerRow = document.createElement("div");
  headerRow.className = "bp-section-row";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "bp-section-header";
  const isOpen = !collapsed.has(key);
  header.classList.toggle("is-open", isOpen);
  header.setAttribute("aria-expanded", String(isOpen));
  if (options.iconName) header.appendChild(icon(options.iconName, "", 16));
  const label = document.createElement("span");
  label.className = "bp-section-label";
  label.appendChild(renderRichLabel(title, 14));
  label.title = title;
  const disclosure = document.createElement("span");
  disclosure.className = "bp-disclosure";
  disclosure.setAttribute("aria-hidden", "true");
  header.append(label, disclosure);
  headerRow.appendChild(header);

  if (options.actions?.onDelete) {
    headerRow.appendChild(makeIconButton("is-danger", TRASH_SVG, "Delete book", options.actions.onDelete));
  }
  if (options.actions?.onDuplicate) {
    headerRow.appendChild(makeIconButton("", PLUS_SVG, "Duplicate book", options.actions.onDuplicate));
  }

  const body = document.createElement("div");
  body.className = "bp-section-body";
  body.hidden = !isOpen;

  header.addEventListener("click", () => {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    const nowOpen = !collapsed.has(key);
    header.classList.toggle("is-open", nowOpen);
    header.setAttribute("aria-expanded", String(nowOpen));
    body.hidden = !nowOpen;
  });

  section.append(headerRow, body);
  return { section, body };
}

/** A saved-blueprint row's rename mode: swaps the label button for a text
 *  input, committing on Enter/blur and cancelling on Escape. */
function startRename(labelButton: HTMLButtonElement, id: string, currentLabel: string, refresh: () => void): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "library-rename-input";
  input.value = currentLabel;
  labelButton.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  function commit(): void {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (next && next !== currentLabel) renameInLibrary(id, next);
    refresh();
  }
  function cancel(): void {
    if (settled) return;
    settled = true;
    refresh();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") cancel();
  });
  input.addEventListener("blur", commit);
}

interface RowOptions {
  key: string;
  iconName: string;
  /** Replaces the plain item icon — a saved blueprint's art with its own
   *  icons drawn on it. */
  iconElement?: HTMLElement;
  onClick(): void;
  /** Trash button; omitted rows show it greyed out, like the game's own
   *  disabled trash beside "Add space platform". */
  onDelete?: () => void;
  onDuplicate?: () => void;
  onContextMenu?: (e: MouseEvent, labelButton: HTMLButtonElement) => void;
  /** Shift+click instead of a plain click. */
  onPickUp?: () => void;
  onRename?: (labelButton: HTMLButtonElement) => void;
}

/** One list block: icon + rich-text label, with the trash/duplicate pair
 *  docked to its right edge on hover and on the selected row. */
function makeRow(label: string, options: RowOptions, refresh: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "bp-row";
  if (options.key === activeKey) row.classList.add("is-active");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "bp-row-main";
  button.appendChild(options.iconElement ?? icon(options.iconName, "", 16));
  const text = document.createElement("span");
  text.className = "bp-row-label";
  text.appendChild(renderRichLabel(label, 14));
  button.appendChild(text);
  // The raw name, `[tag]` markup and all, stays the hover reference for a
  // label whose icons replaced part of the text.
  button.title = label;
  button.addEventListener("click", (e) => {
    if (e.shiftKey && options.onPickUp) {
      options.onPickUp();
      return;
    }
    activeKey = options.key;
    options.onClick();
    refresh();
  });
  if (options.onRename) {
    const onRename = options.onRename;
    button.addEventListener("dblclick", (e) => {
      e.preventDefault();
      onRename(button);
    });
  }
  row.appendChild(button);

  if (options.onContextMenu) {
    const onContextMenu = options.onContextMenu;
    row.addEventListener("contextmenu", (e) => onContextMenu(e, button));
  }

  if (options.onDelete || options.onDuplicate) {
    const actions = document.createElement("div");
    actions.className = "bp-row-actions";
    actions.appendChild(makeIconButton("is-danger", TRASH_SVG, "Delete", () => options.onDelete?.(), !options.onDelete));
    if (options.onDuplicate) actions.appendChild(makeIconButton("", PLUS_SVG, "Duplicate", options.onDuplicate));
    row.appendChild(actions);
  }

  return row;
}

function savedRow(entry: SavedBlueprint, callbacks: LibraryCallbacks, refresh: () => void): HTMLElement {
  const key = `saved:${entry.id}`;
  const remove = () => {
    deleteFromLibrary(entry.id);
    if (activeKey === key) activeKey = null;
    refresh();
  };
  const duplicate = () => {
    duplicateInLibrary(entry.id);
    refresh();
  };
  const rename = (labelButton: HTMLButtonElement) => startRename(labelButton, entry.id, entry.label, refresh);
  return makeRow(
    entry.label,
    {
      key,
      iconName: "blueprint",
      iconElement: blueprintIcon("blueprint", entryIcons(entry), 24),
      onClick: () => callbacks.onLoad(entry.bpString),
      onPickUp: () => callbacks.onPickUp(entry.bpString),
      onDelete: remove,
      onDuplicate: duplicate,
      onRename: rename,
      onContextMenu: (e) => {
        e.preventDefault();
        openEntryWindow(entry.id, callbacks, refresh);
      },
    },
    refresh,
  );
}

/** The game's library window for one saved blueprint, read fresh from
 *  storage so a reopen (after reassign) shows the new contents. */
function openEntryWindow(id: string, callbacks: LibraryCallbacks, refresh: () => void): void {
  const entry = listSaved().find((e) => e.id === id);
  if (!entry) return;
  openLibraryWindow({
    meta: readEntryMeta(entry),
    blueprint: decodeEntry(entry),
    onSave: (meta) => {
      try {
        editInLibrary(id, meta);
      } catch {
        callbacks.notify("Couldn't save — the stored blueprint doesn't decode.", "error");
      }
      refresh();
    },
    onReselect: () => {
      callbacks.onReselect((bpString) => {
        try {
          replaceContentsInLibrary(id, bpString);
        } catch {
          callbacks.notify("Couldn't use that selection as the blueprint's contents.", "error");
        }
        refresh();
        openEntryWindow(id, callbacks, refresh);
      });
    },
    onDuplicate: () => {
      duplicateInLibrary(id);
      refresh();
      callbacks.notify(`Duplicated “${entry.label}”.`);
    },
    onExport: async () => {
      const latest = listSaved().find((e) => e.id === id);
      if (!latest) return false;
      try {
        await navigator.clipboard.writeText(latest.bpString);
        return true;
      } catch {
        return false;
      }
    },
    onDelete: () => {
      deleteFromLibrary(id);
      if (activeKey === `saved:${id}`) activeKey = null;
      refresh();
    },
  });
}

/** Renders the currently-loaded (not necessarily saved) book's own folder
 *  tree into `container`: a blueprint leaf is a plain click-to-select row
 *  (no delete — this isn't a library entry, just what's on screen right
 *  now), a sub-book is a nested section. `path` is the chain of ancestor
 *  labels-so-far, joined into each folder's collapse key — needed because
 *  two sibling sub-books can share a label. */
function renderBookNode(
  container: HTMLElement,
  node: BlueprintTreeNode,
  path: string,
  onSelect: (flatIndex: number) => void,
  refresh: () => void,
): void {
  if (node.kind === "blueprint") {
    container.appendChild(
      makeRow(node.label, { key: `current:${node.flatIndex}`, iconName: "blueprint", onClick: () => onSelect(node.flatIndex) }, refresh),
    );
    return;
  }
  const { section, body } = makeSection(`current-book-${path}`, node.label, { iconName: "blueprint-book", nested: true });
  for (const child of node.children) {
    renderBookNode(body, child, `${path}/${child.label}`, onSelect, refresh);
  }
  container.appendChild(section);
}

/** Builds the "Blueprints" sidebar into `container`, laid out after the
 *  game's Surfaces panel: debug fixtures as loose rows at the top, then a
 *  gold-headed category per group (the book on screen, loose saved
 *  blueprints, and one per saved book), each row a bevelled block with the
 *  trash/duplicate pair on its right, and creation (save current, new) in a
 *  footer at the bottom. Re-renders the whole list on every mutation rather
 *  than patching the DOM — the list is small enough that this is simpler
 *  than diffing. */
export function buildLibrarySidebar(container: HTMLElement, callbacks: LibraryCallbacks): { refresh(): void; clearActive(): void } {
  container.replaceChildren();

  const list = document.createElement("div");
  list.className = "bp-list";

  const footer = document.createElement("div");
  footer.className = "bp-footer";

  const saveRow = document.createElement("div");
  saveRow.className = "bp-save-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name current blueprint…";
  nameInput.className = "library-save-input";
  nameInput.setAttribute("aria-label", "Name for the blueprint to save");
  const saveButton = makeIconButton("is-confirm", SAVE_SVG, "Save current blueprint", () => save());
  saveRow.append(nameInput, saveButton);

  const status = document.createElement("p");
  status.className = "library-status";
  status.hidden = true;

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "bp-new-button";
  newButton.textContent = "+ New blueprint";
  newButton.addEventListener("click", () => {
    activeKey = null;
    callbacks.onNew();
  });

  footer.append(saveRow, status, newButton);

  function refresh(): void {
    // Remember the scroll position: a full rebuild otherwise jumps the list
    // back to the top after every click.
    const scroll = list.scrollTop;
    list.replaceChildren();
    const saved = listSaved();

    for (const entry of BUILTINS) {
      const key = `builtin:${entry.id}`;
      list.appendChild(
        makeRow(
          entry.label,
          {
            key,
            iconName: entry.icon,
            onClick: () => callbacks.onLoad(entry.bpString),
            // A built-in can't be deleted, but duplicating one is how it
            // becomes an editable library entry.
            onDuplicate: () => {
              saveToLibrary(entry.bpString, `${entry.label} copy`);
              refresh();
            },
          },
          refresh,
        ),
      );
    }
    for (const entry of saved.filter((e) => e.category === "debug" && !e.bookId)) {
      list.appendChild(savedRow(entry, callbacks, refresh));
    }

    const bookTree = callbacks.getCurrentBookTree();
    // buildBlueprintTree only ever returns a "book" node (or null) at the
    // top level, but the type is a union, so this narrows it explicitly.
    if (bookTree && bookTree.kind === "book") {
      const { section, body } = makeSection("current-book", "Current book", { iconName: "blueprint-book" });
      for (const child of bookTree.children) {
        renderBookNode(body, child, child.label, callbacks.onSelectCurrent, refresh);
      }
      list.appendChild(section);
    }

    const loose = saved.filter((e) => !e.bookId && e.category !== "debug");
    const books = new Map<string, { label: string; entries: SavedBlueprint[] }>();
    for (const entry of saved) {
      if (!entry.bookId) continue;
      const book = books.get(entry.bookId) ?? { label: entry.bookLabel || "Untitled book", entries: [] };
      book.entries.push(entry);
      books.set(entry.bookId, book);
    }

    const { section: savedSection, body: savedBody } = makeSection("saved", "Saved");
    for (const entry of loose) savedBody.appendChild(savedRow(entry, callbacks, refresh));
    if (loose.length === 0) {
      const empty = document.createElement("p");
      empty.className = "bp-empty";
      empty.textContent = books.size === 0 ? "Nothing saved yet — name the current blueprint below to keep it." : "No loose blueprints.";
      savedBody.appendChild(empty);
    }
    list.appendChild(savedSection);

    for (const [bookId, book] of books) {
      const { section, body } = makeSection(`book-${bookId}`, book.label, {
        iconName: "blueprint-book",
        actions: {
          onDelete: () => {
            if (book.entries.some((e) => activeKey === `saved:${e.id}`)) activeKey = null;
            deleteBookFromLibrary(bookId);
            refresh();
          },
          onDuplicate: () => {
            duplicateBookInLibrary(bookId);
            refresh();
          },
        },
      });
      for (const entry of book.entries) body.appendChild(savedRow(entry, callbacks, refresh));
      list.appendChild(section);
    }

    list.scrollTop = scroll;
  }

  function setStatus(text: string, kind: "info" | "error"): void {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = false;
  }

  function save(): void {
    const bpString = callbacks.getCurrentBpString();
    if (!bpString) {
      setStatus("Nothing loaded to save yet.", "error");
      return;
    }
    const label = nameInput.value.trim() || "Untitled blueprint";
    try {
      saveToLibrary(bpString, label);
      nameInput.value = "";
      setStatus(`Saved “${label}”.`, "info");
      refresh();
    } catch {
      setStatus("Couldn't save — the current blueprint doesn't decode.", "error");
    }
  }

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });

  container.append(list, footer);
  refresh();
  return {
    refresh,
    clearActive() {
      activeKey = null;
      refresh();
    },
  };
}
