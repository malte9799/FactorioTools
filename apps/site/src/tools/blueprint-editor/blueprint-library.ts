import { BlueprintError, collectBlueprints, decodeBlueprintString, encodeBlueprintString } from "@factoriotools/engine";
import type { Blueprint, BpIcon } from "@factoriotools/engine";
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

function readAll(): SavedBlueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedBlueprint) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: SavedBlueprint[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable or quota exceeded — not worth surfacing here */
  }
}

export function listSaved(): SavedBlueprint[] {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
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

  for (const leaf of leaves) {
    entries.push({
      id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      label: isBook && leaves.length > 1 ? leaf.label || "Untitled blueprint" : isBook ? leaf.label || "Blueprint" : label,
      bpString: encodeLeaf(leaf),
      category,
      bookId,
      bookLabel: isBook ? label : undefined,
      savedAt: now,
    });
  }
  writeAll(entries);
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
  entries.push({ ...source, id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`, label: `${source.label} copy`, savedAt: now });
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
  writeAll(entries);
  return entries;
}

/** Removes every entry of a saved book — the trash button on a book's own
 *  section header in the sidebar. */
export function deleteBookFromLibrary(bookId: string): SavedBlueprint[] {
  const entries = readAll().filter((e) => e.bookId !== bookId);
  writeAll(entries);
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
  for (const member of members) {
    entries.push({
      ...member,
      id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      bookId: newBookId,
      bookLabel: `${member.bookLabel || "Untitled book"} copy`,
      savedAt: now,
    });
  }
  writeAll(entries);
  return entries;
}
