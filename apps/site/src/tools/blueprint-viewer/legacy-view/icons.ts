/** Item/building icons, packed locally from the user's own Factorio install
 *  by packages/data-pipeline/src/extract-sprites.ts — no third-party host
 *  involved. Icon ids match Factorio's prototype names, the same names this
 *  dataset keys everything by, so lookups are a direct hit.
 *
 *  This module is the icon lookup for panel/tooltip icons specifically —
 *  the main blueprint canvas draws full entity sprites via
 *  packages/renderer instead, not just icons. */

const SHEET_URL = "/data/sprites/icons.png";
const MANIFEST_URL = "/data/sprite-icon-manifest.json";

interface IconEntry {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Manifest {
  cell: number;
  sheetWidth: number;
  sheetHeight: number;
  icons: IconEntry[];
}

let CELL = 64;
let SHEET_W = 0;
let SHEET_H = 0;
let positions: Map<string, IconEntry> | null = null;
let loading: Promise<Map<string, IconEntry>> | null = null;

function load(): Promise<Map<string, IconEntry>> {
  if (positions) return Promise.resolve(positions);
  if (loading) return loading;
  loading = fetch(MANIFEST_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`icon manifest ${res.status}`);
      return res.json() as Promise<Manifest>;
    })
    .then((manifest) => {
      CELL = manifest.cell;
      SHEET_W = manifest.sheetWidth;
      SHEET_H = manifest.sheetHeight;
      const map = new Map(manifest.icons.map((icon) => [icon.id, icon]));
      positions = map;
      return map;
    })
    .catch(() => {
      // Not generated yet, offline, or blocked — icons are decoration, not
      // required for the numbers, so fail quiet and fall back to no icon.
      const empty = new Map<string, IconEntry>();
      positions = empty;
      return empty;
    });
  return loading;
}

/** Sprite-sheet cell for a prototype name, once the manifest has loaded.
 *  Returns undefined before load, or if the name has no icon. */
export function getIconPosition(name: string): { x: number; y: number } | undefined {
  return positions?.get(name);
}

/** Run `fn` once the manifest has resolved — immediately if it already has. */
export function onIconsReady(fn: () => void): void {
  void load().then(fn);
}

function applyBackground(el: HTMLElement, entry: IconEntry | undefined, displaySize: number): void {
  if (!entry) {
    el.classList.add("icon-missing");
    return;
  }
  // calc() can't multiply two lengths together, so the scale has to be
  // computed here as a plain number rather than expressed in CSS via a
  // --icon-size custom property.
  const scale = displaySize / CELL;
  el.style.backgroundImage = `url(${SHEET_URL})`;
  el.style.backgroundPosition = `${-entry.x * scale}px ${-entry.y * scale}px`;
  el.style.backgroundSize = `${SHEET_W * scale}px ${SHEET_H * scale}px`;
}

/** Build (or update) an icon element for a prototype name. Renders blank
 *  immediately and fills in once the manifest resolves, so callers don't
 *  need to await anything. `displaySize` must match the element's rendered
 *  px size (set in CSS) since the sprite offset is computed in JS. */
export function icon(name: string, alt: string, displaySize = 26): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "icon";
  el.style.setProperty("--icon-size", `${displaySize}px`);
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", alt);
  void load().then((map) => applyBackground(el, map.get(name), displaySize));
  return el;
}

/** Full sheet pixel size, once the manifest has loaded. Falls back to the
 *  cell size before load, matching the "render blank until ready" pattern
 *  `icon()`/`getIconPosition()` already use. */
export function getSheetSize(): { width: number; height: number } {
  return { width: SHEET_W || CELL, height: SHEET_H || CELL };
}

export { SHEET_URL, CELL };
