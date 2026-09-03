import { BlueprintError, collectBlueprints, decodeBlueprintString, encodeBlueprintString } from "@factoriotools/engine";
import type { Blueprint } from "@factoriotools/engine";

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

function readAll(): SavedBlueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
export function saveToLibrary(bpString: string, label: string, category?: "debug"): SavedBlueprint[] {
  const envelope = decodeBlueprintString(bpString);
  const leaves = collectBlueprints(envelope);
  if (leaves.length === 0) throw new BlueprintError("That decoded fine but contains no blueprints.");

  const entries = readAll();
  const now = Date.now();
  const isBook = leaves.length > 1;
  const bookId = isBook ? `book-${now}-${Math.random().toString(36).slice(2, 8)}` : undefined;

  for (const leaf of leaves) {
    entries.push({
      id: `bp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      label: isBook ? leaf.label || "Untitled blueprint" : label,
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

/** Duplicates an existing saved entry as a new, independent entry (same
 *  book membership if it belonged to one) with " copy" appended to its
 *  label — mirrors the real game's own "copy" convention on its own
 *  blueprint library. */
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
