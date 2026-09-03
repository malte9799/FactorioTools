import { ROTATION_TEST_BLUEPRINT, DEBUG_BLUEPRINT, BUG_REPRO_BLUEPRINT } from "@factoriotools/engine";
import { listSaved, saveToLibrary, deleteFromLibrary, type SavedBlueprint } from "./blueprint-library.js";

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
  { id: "builtin-bug-repro", label: "Bug repro", bpString: BUG_REPRO_BLUEPRINT },
];

/** Which categories are currently expanded — module-level so the sidebar
 *  remembers disclosure state across re-renders within a session (every
 *  mutation re-renders the whole list from scratch, see refresh() below).
 *  Debug/Saved start open since they're the two most commonly used;
 *  per-book folders start closed to keep a library of many saved books
 *  scannable at a glance. */
const expanded = new Set<string>(["debug", "saved"]);

/** Every category header currently on screen, keyed the same as `expanded`
 *  — repopulated at the start of each refresh() so "collapse/expand all"
 *  (see the titlebar button wired in index.ts) can act on exactly what's
 *  rendered right now, book folders included, without needing to walk the
 *  DOM back apart. */
const liveHeaders = new Map<string, { header: HTMLButtonElement; body: HTMLElement }>();

function toggleExpanded(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}

function setAllExpanded(open: boolean): void {
  for (const [key, { header, body }] of liveHeaders) {
    if (open) expanded.add(key);
    else expanded.delete(key);
    header.classList.toggle("is-open", open);
    body.hidden = !open;
  }
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

  liveHeaders.set(key, { header, body });
  section.append(header, body);
  return { section, body };
}

function makeRow(label: string, options: { onClick(): void; onDelete?: () => void; title?: string }): HTMLElement {
  const row = document.createElement("div");
  row.className = "library-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "library-row-label";
  button.textContent = label;
  if (options.title) button.title = options.title;
  button.addEventListener("click", options.onClick);
  row.appendChild(button);

  if (options.onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-row-delete";
    del.setAttribute("aria-label", `Delete ${label}`);
    del.title = "Delete";
    del.textContent = "✕";
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
 *  with no `bookId` render as plain rows directly in the category body. */
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

  for (const entry of flat) {
    body.appendChild(
      makeRow(entry.label, {
        onClick: () => callbacks.onLoad(entry.bpString),
        onDelete: () => {
          deleteFromLibrary(entry.id);
          refresh();
        },
      }),
    );
  }

  for (const [bookId, book] of books) {
    const { section, body: bookBody } = makeCategory(`book-${bookId}`, `📘 ${book.label}`);
    for (const entry of book.entries) {
      bookBody.appendChild(
        makeRow(entry.label, {
          onClick: () => callbacks.onLoad(entry.bpString),
          onDelete: () => {
            deleteFromLibrary(entry.id);
            refresh();
          },
        }),
      );
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
 *  a per-row delete button, and a save form for stashing whatever's
 *  currently on the canvas under a name. Re-renders its full row list on
 *  every mutation (save/delete) rather than patching the DOM — the list is
 *  small enough that this is simpler than diffing, matching this file's
 *  sibling edit-palette.ts's own rebuild-on-change style. */
export function buildLibrarySidebar(
  container: HTMLElement,
  callbacks: LibraryCallbacks,
): { refresh(): void; setAllExpanded(open: boolean): void } {
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

  const debugCheckboxRow = document.createElement("label");
  debugCheckboxRow.className = "library-debug-checkbox";
  const debugCheckbox = document.createElement("input");
  debugCheckbox.type = "checkbox";
  debugCheckboxRow.append(debugCheckbox, document.createTextNode(" Save under Debug"));

  const status = document.createElement("p");
  status.className = "sub library-status";

  const list = document.createElement("div");
  list.className = "library-list";

  const { section: debugSection, body: debugBody } = makeCategory("debug", "Debug");
  const { section: savedSection, body: savedBody } = makeCategory("saved", "Saved");
  list.append(debugSection, savedSection);

  function refresh(): void {
    // Book folders are rebuilt from scratch every refresh (see
    // renderEntries), so their liveHeaders entries from the previous render
    // are stale — drop everything except the two fixed top-level categories
    // before rebuilding, or collapse/expand-all would keep acting on
    // book folders that no longer exist in the DOM.
    for (const key of [...liveHeaders.keys()]) {
      if (key !== "debug" && key !== "saved") liveHeaders.delete(key);
    }
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
      saveToLibrary(bpString, label, debugCheckbox.checked ? "debug" : undefined);
      nameInput.value = "";
      debugCheckbox.checked = false;
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

  container.append(newButton, saveRow, debugCheckboxRow, status, list);
  refresh();
  return { refresh, setAllExpanded };
}
