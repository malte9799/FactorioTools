import { ROTATION_TEST_BLUEPRINT, DEBUG_BLUEPRINT } from "@factoriotools/engine";
import {
  listSaved,
  saveToLibrary,
  deleteFromLibrary,
  duplicateInLibrary,
  renameInLibrary,
  type SavedBlueprint,
} from "./blueprint-library.js";

export interface LibraryCallbacks {
  /** Load this blueprint string as the active one in the viewer. */
  onLoad(bpString: string): void;
  /** Returns the current blueprint string to save, or null if there's nothing to save yet. */
  getCurrentBpString(): string | null;
  /** Clears the canvas back to an empty blueprint, for starting fresh. */
  onNew(): void;
}

interface BuiltinEntry {
  id: string;
  label: string;
  bpString: string;
}

const BUILTINS: BuiltinEntry[] = [
  { id: "builtin-rotation-test", label: "Rotation test", bpString: ROTATION_TEST_BLUEPRINT },
  { id: "builtin-debug-lab", label: "Debug lab", bpString: DEBUG_BLUEPRINT },
];

/** Which categories are currently expanded — module-level so the sidebar
 *  remembers disclosure state across re-renders within a session (every
 *  mutation re-renders the whole list from scratch, see refresh() below).
 *  Debug/Saved start open since they're the two most commonly used;
 *  per-book folders start closed to keep a library of many saved books
 *  scannable at a glance. */
const expanded = new Set<string>(["debug", "saved"]);

function toggleExpanded(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}

function makeCategory(key: string, title: string): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("div");
  section.className = "library-category";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "library-category-header";
  const isOpen = expanded.has(key);
  header.classList.toggle("is-open", isOpen);
  header.innerHTML = `<span class="library-disclosure" aria-hidden="true">▸</span><span>${title}</span>`;

  const body = document.createElement("div");
  body.className = "library-category-body";
  body.hidden = !isOpen;

  header.addEventListener("click", () => {
    toggleExpanded(key);
    const nowOpen = expanded.has(key);
    header.classList.toggle("is-open", nowOpen);
    body.hidden = !nowOpen;
  });

  section.append(header, body);
  return { section, body };
}

/** Closes any open row context menu — module-level since only one can ever
 *  be open at a time (matches native right-click menu behavior: opening a
 *  new one, or clicking elsewhere, dismisses whatever was open). */
let closeOpenMenu: (() => void) | null = null;

function closeAnyOpenMenu(): void {
  closeOpenMenu?.();
  closeOpenMenu = null;
}

interface RowMenuAction {
  label: string;
  onClick(): void;
}

function showRowMenu(x: number, y: number, actions: RowMenuAction[]): void {
  closeAnyOpenMenu();

  const menu = document.createElement("div");
  menu.className = "library-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "library-context-item";
    item.textContent = action.label;
    item.addEventListener("click", () => {
      closeAnyOpenMenu();
      action.onClick();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close(): void {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  closeOpenMenu = close;
  // Deferred so the click that opened the menu (a contextmenu event, but
  // guard anyway) doesn't immediately trigger onOutside via bubbling.
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

/** A saved-blueprint row's rename mode: swaps the label button for a text
 *  input, committing on Enter/blur and cancelling on Escape. */
function startRename(row: HTMLElement, labelButton: HTMLButtonElement, id: string, currentLabel: string, refresh: () => void): void {
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

function makeRow(
  label: string,
  options: {
    onClick(): void;
    onDelete?: () => void;
    onContextMenu?: (e: MouseEvent) => void;
    title?: string;
  },
): HTMLElement {
  const row = document.createElement("div");
  row.className = "library-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "library-row-label";
  button.textContent = label;
  if (options.title) button.title = options.title;
  button.addEventListener("click", options.onClick);
  row.appendChild(button);

  if (options.onContextMenu) {
    row.addEventListener("contextmenu", options.onContextMenu);
  }

  if (options.onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-row-delete";
    del.setAttribute("aria-label", `Delete ${label}`);
    del.title = "Delete";
    del.textContent = "🗑";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onDelete!();
    });
    row.appendChild(del);
  }

  return row;
}

/** Renders the folder/leaf structure shared by both the Debug and Saved
 *  sections: entries that share a `bookId` collapse into one nested,
 *  independently-collapsible folder named after the book, while entries
 *  with no `bookId` render as plain rows directly in the category body.
 *  Only entries actually stored in the library (not the read-only built-in
 *  fixtures) get the right-click Copy/Duplicate/Rename/Delete menu. */
function renderEntries(
  body: HTMLElement,
  builtins: BuiltinEntry[],
  saved: SavedBlueprint[],
  callbacks: LibraryCallbacks,
  refresh: () => void,
): void {
  body.replaceChildren();

  for (const entry of builtins) {
    body.appendChild(makeRow(entry.label, { onClick: () => callbacks.onLoad(entry.bpString) }));
  }

  const flat = saved.filter((e) => !e.bookId);
  const books = new Map<string, { label: string; entries: SavedBlueprint[] }>();
  for (const entry of saved) {
    if (!entry.bookId) continue;
    const book = books.get(entry.bookId) ?? { label: entry.bookLabel || "Untitled book", entries: [] };
    book.entries.push(entry);
    books.set(entry.bookId, book);
  }

  function makeSavedRow(entry: SavedBlueprint): HTMLElement {
    const row = makeRow(entry.label, {
      onClick: () => callbacks.onLoad(entry.bpString),
      onDelete: () => {
        deleteFromLibrary(entry.id);
        refresh();
      },
      onContextMenu: (e) => {
        e.preventDefault();
        showRowMenu(e.clientX, e.clientY, [
          {
            label: "Copy",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(entry.bpString);
              } catch {
                /* clipboard unavailable — silently ignore, not worth surfacing here */
              }
            },
          },
          {
            label: "Duplicate",
            onClick: () => {
              duplicateInLibrary(entry.id);
              refresh();
            },
          },
          {
            label: "Rename",
            onClick: () => {
              const labelButton = row.querySelector<HTMLButtonElement>(".library-row-label");
              if (labelButton) startRename(row, labelButton, entry.id, entry.label, refresh);
            },
          },
          {
            label: "Delete",
            onClick: () => {
              deleteFromLibrary(entry.id);
              refresh();
            },
          },
        ]);
      },
    });
    return row;
  }

  for (const entry of flat) {
    body.appendChild(makeSavedRow(entry));
  }

  for (const [bookId, book] of books) {
    const { section, body: bookBody } = makeCategory(`book-${bookId}`, `📘 ${book.label}`);
    for (const entry of book.entries) {
      bookBody.appendChild(makeSavedRow(entry));
    }
    body.appendChild(section);
  }

  if (flat.length === 0 && books.size === 0 && builtins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty library-empty";
    empty.textContent = "Nothing here yet.";
    body.appendChild(empty);
  }
}

/** Builds the "Blueprint Library" sidebar into `container`: a docked
 *  collapsible-category list (Debug / Saved) mirroring the reference
 *  Surfaces-panel look — dark rows, gold section headers, click-to-load,
 *  a per-row trash-can delete button, a right-click context menu
 *  (Copy/Duplicate/Rename/Delete), and a save form for stashing whatever's
 *  currently on the canvas under a name. Re-renders its full row list on
 *  every mutation (save/delete/duplicate/rename) rather than patching the
 *  DOM — the list is small enough that this is simpler than diffing,
 *  matching this file's sibling edit-palette.ts's own rebuild-on-change
 *  style. */
export function buildLibrarySidebar(container: HTMLElement, callbacks: LibraryCallbacks): { refresh(): void } {
  container.replaceChildren();

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "ghost library-new-button";
  newButton.textContent = "+ New blueprint";
  newButton.addEventListener("click", () => callbacks.onNew());

  const saveRow = document.createElement("div");
  saveRow.className = "library-save-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name…";
  nameInput.className = "library-save-input";
  nameInput.setAttribute("aria-label", "Name for the blueprint to save");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "ghost";
  saveButton.textContent = "Save current";
  saveRow.append(nameInput, saveButton);

  const status = document.createElement("p");
  status.className = "sub library-status";

  const list = document.createElement("div");
  list.className = "library-list";

  const { section: debugSection, body: debugBody } = makeCategory("debug", "Debug");
  const { section: savedSection, body: savedBody } = makeCategory("saved", "Saved");
  list.append(debugSection, savedSection);

  function refresh(): void {
    const saved = listSaved();
    renderEntries(debugBody, BUILTINS, saved.filter((e) => e.category === "debug"), callbacks, refresh);
    renderEntries(savedBody, [], saved.filter((e) => e.category !== "debug"), callbacks, refresh);
  }

  saveButton.addEventListener("click", () => {
    const bpString = callbacks.getCurrentBpString();
    if (!bpString) {
      status.textContent = "Nothing loaded to save yet.";
      status.dataset.kind = "error";
      return;
    }
    const label = nameInput.value.trim() || "Untitled blueprint";
    try {
      saveToLibrary(bpString, label);
      nameInput.value = "";
      status.textContent = `Saved “${label}”.`;
      status.dataset.kind = "info";
      refresh();
    } catch {
      status.textContent = "Couldn't save — the current blueprint doesn't decode.";
      status.dataset.kind = "error";
    }
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveButton.click();
  });

  container.append(newButton, saveRow, status, list);
  refresh();
  return { refresh };
}
