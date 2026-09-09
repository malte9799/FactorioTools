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
