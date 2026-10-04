import { BlueprintError, collectBlueprints, decodeBlueprintString, encodeBlueprintString } from "@factoriotools/engine";
import type { Blueprint, BlueprintBook, BpIcon } from "@factoriotools/engine";
import { contentBox, shiftContents } from "./blueprint-geometry.js";

/** One saved leaf blueprint. Books are flattened at save time into their
 *  member blueprints (see saveToLibrary), each tagged with the book it came
 *  from via `bookId`/`bookLabel` so the sidebar can group them back into a
 *  folder — storing the decoded leaf string directly means loading a saved
 *  entry never needs to re-walk a book to find the right index. */
export interface SavedBlueprint {
  id: string;
  label: string;
  bpString: string;
  /** Groups this under the Debug category alongside the built-in fixtures;
   *  undefined means the flat "Saved" category. */
  category?: "debug";
  bookId?: string;
  bookLabel?: string;
  savedAt: number;
}

const STORAGE_KEY = "factoriotools.blueprint-viewer.library";
/** Set once the stored array's own order is the display order (see
 *  readAll). */
const ORDERED_KEY = "factoriotools.blueprint-viewer.library.ordered";

/** Upper bounds for a stored entry. A label longer than this is not something
 *  the rename UI can produce, and a blueprint string past 5 MB is far beyond
 *  the largest real book (the bundled example set peaks around 1.4 MB for 176
 *  blueprints) — both only occur in a hand-written storage entry. */
const MAX_LABEL_LENGTH = 200;
const MAX_BP_STRING_LENGTH = 5_000_000;

/** localStorage is writable by anything running on this origin — including a
 *  payload that got in before the escaping fix landed, or hand-edited devtools
 *  content. `Array.isArray` alone said nothing about the entries themselves, so
 *  malformed objects reached the sidebar and the loader. Entries that do not
 *  match the stored shape are dropped rather than repaired: a half-valid entry
 *  has no meaningful blueprint behind it. */
function isSavedBlueprint(value: unknown): value is SavedBlueprint {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<SavedBlueprint>;
  return (
    typeof e.id === "string" &&
    typeof e.label === "string" &&
    typeof e.bpString === "string" &&
    typeof e.savedAt === "number" &&
    Number.isFinite(e.savedAt) &&
    e.label.length <= MAX_LABEL_LENGTH &&
    e.bpString.length <= MAX_BP_STRING_LENGTH &&
    (e.category === undefined || e.category === "debug") &&
    (e.bookId === undefined || typeof e.bookId === "string") &&
    (e.bookLabel === undefined || (typeof e.bookLabel === "string" && e.bookLabel.length <= MAX_LABEL_LENGTH))
  );
}

/** The stored array in display order. The list used to be shown newest
 *  first whatever order it was stored in; the first read after drag-to-
 *  reorder arrived bakes that order into the array once, so nothing moves
 *  on screen, and from then on the array's own order is what is shown. */
function readAll(): SavedBlueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const entries: SavedBlueprint[] = Array.isArray(parsed) ? parsed.filter(isSavedBlueprint) : [];
    if (localStorage.getItem(ORDERED_KEY) !== "1") {
      entries.sort((a, b) => b.savedAt - a.savedAt);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        localStorage.setItem(ORDERED_KEY, "1");
      } catch {
        /* couldn't bake the order in — the sorted list still reads fine,
         * and the next read tries again */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Whether the write landed — false when storage is unavailable or full. */
function writeAll(entries: SavedBlueprint[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** Thrown by the save actions when the library couldn't be written, so a
 *  caller never reports a save that didn't land. */
export class LibraryWriteError extends Error {
  constructor() {
    super("Couldn't save — the browser's storage is full or unavailable.");
    this.name = "LibraryWriteError";
  }
}

/** The message for a failed save: the storage one when that is what went
 *  wrong, otherwise the caller's own. */
export function saveFailureMessage(err: unknown, fallback: string): string {
  return err instanceof LibraryWriteError ? err.message : fallback;
}

export function listSaved(): SavedBlueprint[] {
  return readAll();
}

/** One thing at the top level of the library: a loose blueprint, or a book
 *  with the blueprints inside it. */
export type LibraryItem =
  | { kind: "entry"; entry: SavedBlueprint }
  | { kind: "book"; bookId: string; label: string; entries: SavedBlueprint[] };

/** Groups the flat stored list into its top-level items, in order. A book
 *  sits where its first blueprint is stored. */
export function groupLibrary(entries: SavedBlueprint[]): LibraryItem[] {
  const items: LibraryItem[] = [];
  const books = new Map<string, Extract<LibraryItem, { kind: "book" }>>();
  for (const entry of entries) {
    if (!entry.bookId) {
      items.push({ kind: "entry", entry });
      continue;
    }
    let book = books.get(entry.bookId);
    if (!book) {
      book = { kind: "book", bookId: entry.bookId, label: entry.bookLabel || "Untitled book", entries: [] };
      books.set(entry.bookId, book);
      items.push(book);
    }
    book.entries.push(entry);
  }
  return items;
}

function flattenLibrary(items: LibraryItem[]): SavedBlueprint[] {
  return items.flatMap((item) => (item.kind === "entry" ? [item.entry] : item.entries));
}

/** What is being dragged in the sidebar: one blueprint, or a whole book. */
export type LibraryDragSource = { entryId: string } | { bookId: string };

/** Where it is dropped: beside a blueprint, beside or into a book, or at
 *  the end of the top level. */
export type LibraryDropTarget =
  | { entryId: string; where: "before" | "after" }
  | { bookId: string; where: "before" | "after" | "into" }
  | { where: "end" };

/** Moves a blueprint or a book to a new place in the library. A blueprint
 *  dropped beside one that is inside a book, or into a book, joins that
 *  book; dropped anywhere else it becomes a loose blueprint. Books stay at
 *  the top level — one dropped on another book lands beside it. A book whose
 *  last blueprint is moved out is gone, since a book only exists as the
 *  blueprints tagged with it. */
export function moveInLibrary(source: LibraryDragSource, target: LibraryDropTarget): SavedBlueprint[] {
  const entries = readAll();
  const items = groupLibrary(entries);

  // Lift the dragged thing out of the tree.
  let moved: LibraryItem | undefined;
  // Set when lifting the blueprint out left its book empty (and so gone).
  let emptied: { bookId: string; at: number } | undefined;
  if ("bookId" in source) {
    const at = items.findIndex((i) => i.kind === "book" && i.bookId === source.bookId);
    if (at >= 0) moved = items.splice(at, 1)[0];
  } else {
    for (let i = 0; i < items.length && !moved; i++) {
      const item = items[i]!;
      if (item.kind === "entry") {
        if (item.entry.id === source.entryId) moved = items.splice(i, 1)[0];
        continue;
      }
      const at = item.entries.findIndex((e) => e.id === source.entryId);
      if (at < 0) continue;
      moved = { kind: "entry", entry: item.entries.splice(at, 1)[0]! };
      if (item.entries.length === 0) {
        items.splice(i, 1);
        emptied = { bookId: item.bookId, at: i };
      }
    }
  }
  if (!moved) return entries;

  const asLoose = (item: LibraryItem): LibraryItem => {
    if (item.kind === "entry") {
      delete item.entry.bookId;
      delete item.entry.bookLabel;
    }
    return item;
  };
  const intoBook = (book: Extract<LibraryItem, { kind: "book" }>, entry: SavedBlueprint, at: number): void => {
    entry.bookId = book.bookId;
    entry.bookLabel = book.label;
    book.entries.splice(at, 0, entry);
  };

  if ("entryId" in target) {
    const after = target.where === "after" ? 1 : 0;
    let placed = false;
    for (let i = 0; i < items.length && !placed; i++) {
      const item = items[i]!;
      if (item.kind === "entry") {
        if (item.entry.id !== target.entryId) continue;
        items.splice(i + after, 0, asLoose(moved));
        placed = true;
        continue;
      }
      const at = item.entries.findIndex((e) => e.id === target.entryId);
      if (at < 0) continue;
      if (moved.kind === "entry") intoBook(item, moved.entry, at + after);
      else items.splice(i + after, 0, moved);
      placed = true;
    }
    if (!placed) return entries; // dropped on itself, or the target is gone
  } else if ("bookId" in target) {
    const at = items.findIndex((i) => i.kind === "book" && i.bookId === target.bookId);
    if (at < 0) {
      // The only blueprint of a book, dropped on that book: into it changes
      // nothing, beside it takes it out — it lands where the book was.
      if (emptied?.bookId !== target.bookId || target.where === "into") return entries;
      items.splice(emptied.at, 0, asLoose(moved));
      writeAll(flattenLibrary(items));
      return flattenLibrary(items);
    }
    const book = items[at] as Extract<LibraryItem, { kind: "book" }>;
    if (target.where === "into" && moved.kind === "entry") intoBook(book, moved.entry, book.entries.length);
    else items.splice(at + (target.where === "before" ? 0 : 1), 0, asLoose(moved));
  } else {
    items.push(asLoose(moved));
  }

  const next = flattenLibrary(items);
  writeAll(next);
  return next;
}

function encodeLeaf(leaf: Blueprint): string {
  // Re-encode just this leaf so a saved book entry loads independently later
  // without needing to re-decode and re-index into the original book string.
  return encodeBlueprintString({ blueprint: leaf });
}

/** Saves `bpString` under `label`. A book (multiple leaf blueprints) is
 *  flattened into one entry per leaf sharing a fresh `bookId`, so the
 *  sidebar can render it as one collapsible folder named `label` containing
 *  each leaf's own label. */
export function saveToLibrary(bpString: string, label: string, category?: "debug", options: { asBook?: boolean } = {}): SavedBlueprint[] {
  const envelope = decodeBlueprintString(bpString);
  const leaves = collectBlueprints(envelope);
  if (leaves.length === 0) throw new BlueprintError("That decoded fine but contains no blueprints.");

  const entries = readAll();
  const now = Date.now();
  // `asBook` makes even a single blueprint a one-entry book folder — the
  // quickbar's "create blueprint book" shortcut.
  const isBook = leaves.length > 1 || options.asBook === true;
  const bookId = isBook ? `book-${now}-${Math.random().toString(36).slice(2, 8)}` : undefined;

  const fresh: SavedBlueprint[] = [];
  for (const leaf of leaves) {
    fresh.push({
      id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      label: isBook && leaves.length > 1 ? leaf.label || "Untitled blueprint" : isBook ? leaf.label || "Blueprint" : label,
      bpString: encodeLeaf(leaf),
      category,
      bookId,
      bookLabel: isBook ? label : undefined,
      savedAt: now,
    });
  }
  // Newest on top, as the list has always shown it.
  entries.unshift(...fresh);
  if (!writeAll(entries)) throw new LibraryWriteError();
  // A real book brings its own description and icons along.
  if (bookId && envelope.blueprint_book) storeBookMeta(bookId, envelope.blueprint_book.description, envelope.blueprint_book.icons);
  return entries;
}

/** Duplicates an existing saved entry as a new, independent entry with
 *  " copy" appended to its label — mirrors the real game's own "copy"
 *  convention in its own blueprint library. */
export function duplicateInLibrary(id: string): SavedBlueprint[] {
  const entries = readAll();
  const source = entries.find((e) => e.id === id);
  if (!source) return entries;
  const now = Date.now();
  const copy = { ...source, id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`, label: `${source.label} copy`, savedAt: now };
  // Right under the original (and so inside the same book, if it is in one).
  entries.splice(entries.indexOf(source) + 1, 0, copy);
  writeAll(entries);
  return entries;
}

export function deleteFromLibrary(id: string): SavedBlueprint[] {
  const entries = readAll().filter((e) => e.id !== id);
  writeAll(entries);
  return entries;
}

export function renameInLibrary(id: string, label: string): SavedBlueprint[] {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (entry) entry.label = label;
  writeAll(entries);
  return entries;
}

/** A blueprint's snap-to-grid, as the library window edits it. `position`
 *  is where the content's top-left sits inside its grid cell (the game's
 *  "Grid position"); `offset` is the absolute grid's shift from the world
 *  grid. */
export interface SnapSettings {
  size: { x: number; y: number };
  position: { x: number; y: number };
  absolute: boolean;
  offset: { x: number; y: number };
}

/** What the library window shows and changes. Description, icons and snap
 *  live inside the blueprint string itself (so they travel with an export,
 *  as in the game). */
export interface BlueprintMeta {
  label: string;
  description: string;
  icons: BpIcon[];
  snap: SnapSettings | null;
}

export function decodeEntry(entry: SavedBlueprint): Blueprint | undefined {
  try {
    return decodeBlueprintString(entry.bpString).blueprint;
  } catch {
    return undefined;
  }
}

export function readEntryMeta(entry: SavedBlueprint): BlueprintMeta {
  const bp = decodeEntry(entry);
  return {
    label: entry.label,
    description: typeof bp?.description === "string" ? bp.description : "",
    icons: Array.isArray(bp?.icons) ? bp.icons : [],
    snap: bp ? readSnap(bp) : null,
  };
}

function readSnap(bp: Blueprint): SnapSettings | null {
  const size = bp["snap-to-grid"];
  if (!size) return null;
  const box = contentBox(bp);
  const offset = bp["position-relative-to-grid"];
  return {
    size: { x: size.x, y: size.y },
    position: box ? { x: box.minX, y: box.minY } : { x: 0, y: 0 },
    absolute: bp["absolute-snapping"] === true,
    offset: { x: offset?.x ?? 0, y: offset?.y ?? 0 },
  };
}

/** Writes snap settings into a blueprint the way the game stores them:
 *  positions in the grid cell's own frame, so the content is moved to sit
 *  at `position` inside the cell. Null clears snapping and leaves the
 *  content where it is. */
function writeSnap(bp: Blueprint, snap: SnapSettings | null): void {
  if (!snap) {
    delete bp["snap-to-grid"];
    delete bp["absolute-snapping"];
    delete bp["position-relative-to-grid"];
    return;
  }
  const box = contentBox(bp);
  if (box) shiftContents(bp, snap.position.x - box.minX, snap.position.y - box.minY);
  bp["snap-to-grid"] = { x: Math.max(1, Math.round(snap.size.x)), y: Math.max(1, Math.round(snap.size.y)) };
  if (snap.absolute) {
    bp["absolute-snapping"] = true;
    if (snap.offset.x || snap.offset.y) bp["position-relative-to-grid"] = { x: snap.offset.x, y: snap.offset.y };
    else delete bp["position-relative-to-grid"];
  } else {
    delete bp["absolute-snapping"];
    delete bp["position-relative-to-grid"];
  }
}

/** Writes name, description, icons and snap back — the label onto the
 *  entry, all of it into its blueprint string (empty description/icons are
 *  dropped from the string, as the game writes them). */
export function editInLibrary(id: string, meta: BlueprintMeta): SavedBlueprint[] {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return entries;
  const label = meta.label.trim().slice(0, MAX_LABEL_LENGTH) || entry.label;
  const bp = decodeEntry(entry);
  if (bp) {
    bp.label = label;
    if (meta.description.trim()) bp.description = meta.description;
    else delete bp.description;
    if (meta.icons.length) bp.icons = meta.icons;
    else delete bp.icons;
    writeSnap(bp, meta.snap);
    entry.bpString = encodeBlueprintString({ blueprint: bp });
  }
  entry.label = label;
  writeAll(entries);
  return entries;
}

/** The game's "reassign": new contents for an existing library blueprint,
 *  keeping its name, description, icons and snap-to-grid. */
export function replaceContentsInLibrary(id: string, newBpString: string): SavedBlueprint[] {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  const fresh = decodeBlueprintString(newBpString).blueprint;
  if (!entry || !fresh) return entries;
  const old = decodeEntry(entry);
  const meta = readEntryMeta(entry);
  fresh.label = entry.label;
  if (meta.description) fresh.description = meta.description;
  else delete fresh.description;
  if (meta.icons.length) fresh.icons = meta.icons;
  else delete fresh.icons;
  // A snapped blueprint keeps its grid; the new content lands where the old
  // one sat in the cell.
  writeSnap(fresh, old ? readSnap(old) : null);
  entry.bpString = encodeBlueprintString({ blueprint: fresh });
  if (!writeAll(entries)) throw new LibraryWriteError();
  return entries;
}

/** Removes every entry of a saved book — the trash button on a book's own
 *  section header in the sidebar. */
export function deleteBookFromLibrary(bookId: string): SavedBlueprint[] {
  const entries = readAll().filter((e) => e.bookId !== bookId);
  writeAll(entries);
  const books = readBooks();
  delete books[bookId];
  writeBooks(books);
  return entries;
}

/** Copies every entry of a saved book under a fresh `bookId`, the book's
 *  label getting the same " copy" suffix duplicateInLibrary gives a single
 *  blueprint. */
export function duplicateBookInLibrary(bookId: string): SavedBlueprint[] {
  const entries = readAll();
  const members = entries.filter((e) => e.bookId === bookId);
  if (members.length === 0) return entries;
  const now = Date.now();
  const newBookId = `book-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const copies = members.map((member) => ({
    ...member,
    id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`,
    bookId: newBookId,
    bookLabel: `${member.bookLabel || "Untitled book"} copy`,
    savedAt: now,
  }));
  // Right under the original book.
  entries.splice(entries.indexOf(members[members.length - 1]!) + 1, 0, ...copies);
  writeAll(entries);
  const original = readBooks()[bookId];
  if (original) storeBookMeta(newBookId, original.description, original.icons);
  return entries;
}

/* ---------- books ----------
 * A book is only the blueprints tagged with its id (see SavedBlueprint), so
 * what belongs to the book itself — its description and icons — is kept in
 * a small map of its own beside the entries. Its name is the `bookLabel`
 * every member carries. */

const BOOKS_KEY = "factoriotools.blueprint-viewer.library.books";
const MAX_DESCRIPTION_LENGTH = 10_000;

interface StoredBook {
  description?: string;
  icons?: BpIcon[];
}

/** Same caution as isSavedBlueprint: anything on this origin can write
 *  localStorage, so only the expected shape is let through. */
function cleanIcons(value: unknown): BpIcon[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (i): i is BpIcon =>
      typeof i === "object" && i !== null && typeof i.index === "number" && typeof i.signal === "object" && i.signal !== null && typeof i.signal.name === "string",
  ).slice(0, 4);
}

function readBooks(): Record<string, StoredBook> {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOOKS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const books: Record<string, StoredBook> = {};
    for (const [id, raw] of Object.entries<any>(parsed)) {
      if (typeof raw !== "object" || raw === null) continue;
      books[id] = {
        description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : undefined,
        icons: cleanIcons(raw.icons),
      };
    }
    return books;
  } catch {
    return {};
  }
}

function writeBooks(books: Record<string, StoredBook>): void {
  try {
    localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
  } catch {
    /* storage unavailable or quota exceeded */
  }
}

function storeBookMeta(bookId: string, description: string | undefined, icons: BpIcon[] | undefined): void {
  const books = readBooks();
  const clean = cleanIcons(icons);
  if (description || clean.length) books[bookId] = { description: description || undefined, icons: clean };
  else delete books[bookId];
  writeBooks(books);
}

/** What the library window shows for a book; undefined when no blueprint
 *  carries that book id any more. */
export function readBookMeta(bookId: string): BlueprintMeta | undefined {
  const first = readAll().find((e) => e.bookId === bookId);
  if (!first) return undefined;
  const stored = readBooks()[bookId];
  return { label: first.bookLabel || "Untitled book", description: stored?.description ?? "", icons: stored?.icons ?? [], snap: null };
}

/** Writes a book's name, description and icons back. */
export function editBookInLibrary(bookId: string, meta: BlueprintMeta): SavedBlueprint[] {
  const entries = readAll();
  const label = meta.label.trim().slice(0, MAX_LABEL_LENGTH);
  if (label) {
    for (const entry of entries) if (entry.bookId === bookId) entry.bookLabel = label;
    writeAll(entries);
  }
  storeBookMeta(bookId, meta.description.slice(0, MAX_DESCRIPTION_LENGTH), meta.icons);
  return entries;
}

/** The whole book as one blueprint-book string, the way the game exports
 *  it: its blueprints in library order, with the book's own name,
 *  description and icons. */
export function exportBookString(bookId: string): string | undefined {
  const members = readAll().filter((e) => e.bookId === bookId);
  const meta = readBookMeta(bookId);
  if (!meta || members.length === 0) return undefined;
  const book: BlueprintBook = { item: "blueprint-book", label: meta.label, blueprints: [], active_index: 0 };
  if (meta.description) book.description = meta.description;
  if (meta.icons.length) book.icons = meta.icons;
  for (const member of members) {
    const blueprint = decodeEntry(member);
    if (blueprint) book.blueprints.push({ index: book.blueprints.length, blueprint });
  }
  return encodeBlueprintString({ blueprint_book: book });
}
