/** The game's bottom-of-screen quickbar: ten switchable bars of ten slots,
 *  each slot holding a placeable entity to take into the cursor as a ghost,
 *  plus the shortcut tool grid to its right (undo/redo, the planner tools,
 *  alt mode, the three wires). Right-clicking the alt-mode button opens a
 *  small menu switching each of its layers on or off.
 *
 *  This module owns the DOM, the slot contents and their persistence; what a
 *  click actually does to the editor is the caller's job, through the
 *  callbacks — the same split edit-palette.ts and library-sidebar.ts use. */

import type { QualityName } from "@factoriotools/engine";
import { icon } from "./legacy-view/icons.js";
import { QUALITY_TIERS } from "./quality-options.js";

export interface QuickbarItem {
  name: string;
  quality: QualityName;
}

export type QuickbarTool =
  | "undo"
  | "redo"
  | "deconstruct"
  | "blueprint"
  | "upgrade"
  | "book"
  | "alt"
  | "copper"
  | "green"
  | "red";

/** What alt mode shows: the renderer's badges, plus the rate overlay's
 *  port tabs. */
export interface AltLayers {
  quality: boolean;
  recipe: boolean;
  modules: boolean;
  ports: boolean;
}

const ALT_LAYERS: { key: keyof AltLayers; label: string }[] = [
  { key: "quality", label: "Quality indicator" },
  { key: "recipe", label: "Recipe" },
  { key: "modules", label: "Modules" },
  { key: "ports", label: "Ports" },
];

const ALT_LAYERS_KEY = "factoriotools.blueprint-viewer.alt-layers";
const DEFAULT_ALT_LAYERS: AltLayers = { quality: true, recipe: true, modules: true, ports: false };

/** The alt-mode layer choice, remembered across visits. Untrusted like any
 *  stored value: only boolean fields are taken. */
export function readAltLayers(): AltLayers {
  const layers = { ...DEFAULT_ALT_LAYERS };
  try {
    const parsed = JSON.parse(localStorage.getItem(ALT_LAYERS_KEY) ?? "null") as Partial<Record<keyof AltLayers, unknown>> | null;
    if (parsed && typeof parsed === "object") {
      for (const { key } of ALT_LAYERS) if (typeof parsed[key] === "boolean") layers[key] = parsed[key];
    }
  } catch {
    /* unreadable — defaults */
  }
  return layers;
}

export function writeAltLayers(layers: AltLayers): void {
  try {
    localStorage.setItem(ALT_LAYERS_KEY, JSON.stringify(layers));
  } catch {
    /* storage unavailable — the choice lasts this session */
  }
}

export interface QuickbarCallbacks {
  /** Click on a filled slot (or its number key): put the item in the
   *  cursor — or put it away again if it is the one already in hand. */
  onPickItem(item: QuickbarItem): void;
  /** Left click on an empty slot: the caller opens its picker and later
   *  answers through the handle's setSlot(). */
  onAssignSlot(bar: number, slot: number): void;
  onTool(tool: QuickbarTool): void;
  /** A layer switched in the alt-mode button's right-click menu. */
  onAltLayers(layers: AltLayers): void;
}

/** Live editor state the tool grid and slots reflect. */
export interface QuickbarState {
  canUndo: boolean;
  canRedo: boolean;
  boxMode: "deleteBox" | "copyBox" | null;
  altMode: boolean;
  altLayers: AltLayers;
  wire: "copper" | "red" | "green" | null;
  /** The entity ghost in the cursor, so its slot can show as the one in hand. */
  held: QuickbarItem | null;
}

export interface QuickbarHandle {
  setSlot(bar: number, slot: number, item: QuickbarItem | null): void;
  sync(state: QuickbarState): void;
  /** Number-key access: picks slot `slot` of the active bar, if filled. */
  pickSlot(slot: number): boolean;
  /** Closes the all-bars panel or the alt-mode menu; true if one was open
   *  (for Escape). */
  closePanel(): boolean;
  destroy(): void;
}

const BARS = 10;
const SLOTS = 10;
const STORAGE_KEY = "factoriotools.blueprint-viewer.quickbar";

interface Stored {
  active: number;
  bars: (QuickbarItem | null)[][];
}

function emptyBars(): (QuickbarItem | null)[][] {
  return Array.from({ length: BARS }, () => Array.from({ length: SLOTS }, () => null));
}

/** Anything in localStorage is untrusted (see blueprint-library.ts), so a
 *  slot only survives the read if it is exactly the stored shape. */
function isItem(value: unknown): value is QuickbarItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<QuickbarItem>;
  return (
    typeof v.name === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,100}$/.test(v.name) &&
    typeof v.quality === "string" &&
    (QUALITY_TIERS as readonly string[]).includes(v.quality)
  );
}

function readStored(): Stored {
  const fallback: Stored = { active: 0, bars: emptyBars() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const bars = emptyBars();
    if (Array.isArray(parsed.bars)) {
      parsed.bars.slice(0, BARS).forEach((bar, b) => {
        if (!Array.isArray(bar)) return;
        bar.slice(0, SLOTS).forEach((slot, s) => {
          if (isItem(slot)) bars[b]![s] = { name: slot.name, quality: slot.quality };
        });
      });
    }
    const active = Number.isInteger(parsed.active) && parsed.active! >= 0 && parsed.active! < BARS ? parsed.active! : 0;
    return { active, bars };
  } catch {
    return fallback;
  }
}

function writeStored(stored: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable or full — the bar still works for this session */
  }
}

/** Bars are numbered 1–9 then 0 for the tenth, like the game's keys. */
function barLabel(bar: number): string {
  return bar === BARS - 1 ? "0" : String(bar + 1);
}

/** Which shortcut prototype each tool shows the art of. The sprites are
 *  the game's own, copied out of the install by the data pipeline's
 *  extractShortcutIcons() into data/sprites/shortcuts/, listed in
 *  data/shortcut-icons.json by prototype name. Several candidates per tool
 *  since the names have shifted between game versions; failing all of them,
 *  the first shortcut whose name contains `match` is used. */
const SHORTCUTS: Record<QuickbarTool, { names: string[]; match: string }> = {
  undo: { names: ["undo"], match: "undo" },
  redo: { names: ["redo"], match: "redo" },
  deconstruct: { names: ["give-deconstruction-planner", "new-deconstruction-planner"], match: "deconstruction" },
  blueprint: { names: ["give-blueprint", "new-blueprint"], match: "blueprint" },
  upgrade: { names: ["give-upgrade-planner", "new-upgrade-planner"], match: "upgrade" },
  book: { names: ["give-blueprint-book", "new-blueprint-book"], match: "blueprint-book" },
  alt: { names: ["toggle-alt-mode", "alt-mode"], match: "alt-mode" },
  copper: { names: ["give-copper-wire", "copper-wire"], match: "copper-wire" },
  green: { names: ["give-green-wire", "green-wire"], match: "green-wire" },
  red: { names: ["give-red-wire", "red-wire"], match: "red-wire" },
};

const SHORTCUT_MANIFEST_URL = "./data/shortcut-icons.json";
const SHORTCUT_DIR = "./data/sprites/shortcuts/";

type ShortcutManifest = Record<string, { file: string; size: number; style: string }>;

let manifestPromise: Promise<ShortcutManifest> | null = null;
function loadShortcutManifest(): Promise<ShortcutManifest> {
  manifestPromise ??= fetch(SHORTCUT_MANIFEST_URL)
    .then((res) => (res.ok ? (res.json() as Promise<ShortcutManifest>) : {}))
    .catch(() => ({}));
  return manifestPromise;
}

function resolveShortcut(manifest: ShortcutManifest, tool: QuickbarTool): ShortcutManifest[string] | undefined {
  const spec = SHORTCUTS[tool];
  for (const name of spec.names) if (manifest[name]) return manifest[name];
  // "blueprint" must not grab the book's art through the substring match.
  const name = Object.keys(manifest).find((n) => n.includes(spec.match) && (tool !== "blueprint" || !n.includes("book")));
  return name ? manifest[name] : undefined;
}

interface ToolSpec {
  tool: QuickbarTool;
  label: string;
  /** Button colour until the manifest's own `style` arrives (and if a
   *  shortcut has none) — what the game puts behind each glyph. */
  tone: "grey" | "red" | "green" | "blue";
  /** Shown on the button only when the sprite isn't in the dataset yet. */
  short: string;
}

/** Column-major, top then bottom, as the game lays the grid out. */
const TOOLS: ToolSpec[] = [
  { tool: "undo", label: "Undo (Ctrl+Z)", tone: "grey" , short: "Undo" },
  { tool: "redo", label: "Redo (Ctrl+Y)", tone: "grey" , short: "Redo" },
  { tool: "deconstruct", label: "Deconstruction planner (Alt+D)", tone: "red" , short: "Decon" },
  { tool: "blueprint", label: "Create blueprint (Ctrl+C)", tone: "blue" , short: "BP" },
  { tool: "upgrade", label: "Upgrade planner — coming next", tone: "green" , short: "Upgr" },
  { tool: "book", label: "Create blueprint book from the current blueprint", tone: "blue" , short: "Book" },
  { tool: "alt", label: "Alt mode (Alt) · right-click: choose what it shows", tone: "grey" , short: "Alt" },
  { tool: "copper", label: "Copper wire (Alt+C)", tone: "grey" , short: "Cu" },
  { tool: "green", label: "Green wire (Alt+G)", tone: "grey" , short: "Grn" },
  { tool: "red", label: "Red wire (Alt+R)", tone: "grey" , short: "Red" },
];

export function buildQuickbar(host: HTMLElement, callbacks: QuickbarCallbacks): QuickbarHandle {
  const stored = readStored();
  let held: QuickbarItem | null = null;

  host.replaceChildren();
  host.classList.add("quickbar");

  /* ----- hotbar ----- */
  const hotbarFrame = document.createElement("div");
  hotbarFrame.className = "qb-frame qb-hotbar";

  const panel = document.createElement("div");
  panel.className = "qb-frame qb-panel";
  panel.hidden = true;
  const panelHeader = document.createElement("div");
  panelHeader.className = "qb-panel-header";
  const panelClose = document.createElement("button");
  panelClose.type = "button";
  panelClose.className = "gui-close";
  panelClose.setAttribute("aria-label", "Close");
  panelClose.textContent = "✕";
  panelHeader.appendChild(panelClose);
  // As in the game, the all-bars panel is two wells side by side — the bar
  // numbers in one, every bar's slots in the other — not ten framed rows.
  const panelRows = document.createElement("div");
  panelRows.className = "qb-panel-rows";
  const panelNumbers = document.createElement("div");
  panelNumbers.className = "qb-well qb-num-col";
  const panelSlots = document.createElement("div");
  panelSlots.className = "qb-well qb-slot-col";
  panelRows.append(panelNumbers, panelSlots);
  panel.append(panelHeader, panelRows);

  const mainRow = document.createElement("div");
  mainRow.className = "qb-bar-row is-main";
  // The panel hangs off the hotbar's own frame, not the quickbar: the tool
  // grid beside it is taller and would lift it clear of the bar.
  hotbarFrame.append(panel, mainRow);

  /* ----- tools ----- */
  const toolsFrame = document.createElement("div");
  toolsFrame.className = "qb-frame qb-tools";
  const toolGrid = document.createElement("div");
  toolGrid.className = "qb-well qb-tool-grid";
  toolsFrame.appendChild(toolGrid);

  // The alt-mode button's menu: a checkbox per layer, opening above the
  // tool grid like the all-bars panel does above the hotbar.
  let altLayers: AltLayers = { ...DEFAULT_ALT_LAYERS };
  const altMenu = document.createElement("div");
  altMenu.className = "qb-frame qb-alt-menu";
  altMenu.hidden = true;
  const altTitle = document.createElement("div");
  altTitle.className = "qb-alt-title";
  altTitle.textContent = "Alt mode shows";
  altMenu.appendChild(altTitle);
  const altChecks = new Map<keyof AltLayers, HTMLInputElement>();
  for (const { key, label } of ALT_LAYERS) {
    const row = document.createElement("label");
    row.className = "qb-alt-row";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = altLayers[key];
    check.addEventListener("change", () => {
      altLayers = { ...altLayers, [key]: check.checked };
      callbacks.onAltLayers(altLayers);
    });
    row.append(check, label);
    altMenu.appendChild(row);
    altChecks.set(key, check);
  }
  toolsFrame.appendChild(altMenu);
  // Any press outside the menu (the alt button's own right-click aside,
  // which toggles it) closes it.
  const onOutside = (e: PointerEvent) => {
    if (altMenu.hidden || altMenu.contains(e.target as Node)) return;
    if (e.button === 2 && toolButtons.get("alt")!.contains(e.target as Node)) return;
    altMenu.hidden = true;
  };
  document.addEventListener("pointerdown", onOutside, true);

  const toolButtons = new Map<QuickbarTool, HTMLButtonElement>();
  for (const spec of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `qb-tool is-${spec.tone}`;
    button.title = spec.label;
    button.setAttribute("aria-label", spec.label);
    void loadShortcutManifest().then((manifest) => {
      const shortcut = resolveShortcut(manifest, spec.tool);
      if (!shortcut) {
        // Dataset generated before shortcut sprites were extracted: a plain
        // label, not invented art — re-run extract-sprites to get the real
        // glyph.
        button.classList.add("is-missing-sprite");
        button.textContent = spec.short;
        return;
      }
      const img = document.createElement("img");
      img.src = SHORTCUT_DIR + shortcut.file;
      img.alt = "";
      img.draggable = false;
      button.replaceChildren(img);
      if (shortcut.style === "red" || shortcut.style === "green" || shortcut.style === "blue") {
        button.classList.remove(`is-${spec.tone}`);
        button.classList.add(`is-${shortcut.style}`);
      }
    });
    if (spec.tool === "upgrade") button.disabled = true;
    button.addEventListener("click", () => callbacks.onTool(spec.tool));
    if (spec.tool === "alt") {
      button.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        altMenu.hidden = !altMenu.hidden;
      });
    }
    toolButtons.set(spec.tool, button);
    toolGrid.appendChild(button);
  }

  host.append(hotbarFrame, toolsFrame);

  function persist(): void {
    writeStored(stored);
  }

  function makeSlot(bar: number, slot: number): HTMLButtonElement {
    const item = stored.bars[bar]![slot] ?? null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "qb-slot";
    if (slot === 5) button.classList.add("is-group-start");
    if (item) {
      button.classList.add("is-filled");
      button.appendChild(icon(item.name, item.name.replace(/-/g, " "), 28));
      if (item.quality !== "normal") {
        const q = document.createElement("span");
        q.className = `qb-quality quality-${item.quality}`;
        q.title = item.quality;
        button.appendChild(q);
      }
      button.title = `${item.name.replace(/-/g, " ")}\nClick: take into cursor (again to put away) · Right-click: clear`;
      if (held && held.name === item.name && held.quality === item.quality) button.classList.add("is-held");
    } else {
      button.title = "Click to set this slot";
    }
    button.addEventListener("click", () => {
      if (item) {
        callbacks.onPickItem(item);
        closePanel();
      } else {
        callbacks.onAssignSlot(bar, slot);
      }
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!item) return;
      stored.bars[bar]![slot] = null;
      persist();
      render();
    });
    return button;
  }

  function makeSlotRow(bar: number): HTMLElement {
    const slots = document.createElement("div");
    slots.className = "qb-slots";
    for (let s = 0; s < SLOTS; s++) slots.appendChild(makeSlot(bar, s));
    return slots;
  }

  function well(child: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = "qb-well";
    el.appendChild(child);
    return el;
  }

  function render(): void {
    // The always-visible bar: its number opens the all-bars panel.
    const mainNumber = document.createElement("button");
    mainNumber.type = "button";
    mainNumber.className = "qb-bar-num";
    mainNumber.textContent = barLabel(stored.active);
    mainNumber.title = "Show all quickbars";
    mainNumber.classList.toggle("is-open", !panel.hidden);
    mainNumber.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      render();
    });
    mainRow.replaceChildren(well(mainNumber), well(makeSlotRow(stored.active)));

    if (panel.hidden) return;
    panelNumbers.replaceChildren();
    panelSlots.replaceChildren();
    // Top to bottom: 0, 9, 8 … 1 — the tenth bar first, as in the game.
    for (let bar = BARS - 1; bar >= 0; bar--) {
      const number = document.createElement("button");
      number.type = "button";
      number.className = "qb-bar-num";
      number.textContent = barLabel(bar);
      number.title = `Use quickbar ${barLabel(bar)}`;
      if (bar === stored.active) number.classList.add("is-active");
      number.addEventListener("click", () => {
        stored.active = bar;
        persist();
        closePanel();
      });
      const slots = makeSlotRow(bar);
      // Hovering a bar's number lights its whole row, which now lives in
      // the other well.
      number.addEventListener("mouseenter", () => slots.classList.add("is-hot"));
      number.addEventListener("mouseleave", () => slots.classList.remove("is-hot"));
      panelNumbers.appendChild(number);
      panelSlots.appendChild(slots);
    }
  }

  function closePanel(): boolean {
    if (panel.hidden) return false;
    panel.hidden = true;
    render();
    return true;
  }
  panelClose.addEventListener("click", () => closePanel());

  render();

  return {
    setSlot(bar, slot, item) {
      if (bar < 0 || bar >= BARS || slot < 0 || slot >= SLOTS) return;
      stored.bars[bar]![slot] = item;
      persist();
      render();
    },
    sync(state) {
      toolButtons.get("undo")!.disabled = !state.canUndo;
      toolButtons.get("redo")!.disabled = !state.canRedo;
      toolButtons.get("deconstruct")!.classList.toggle("is-active", state.boxMode === "deleteBox");
      toolButtons.get("blueprint")!.classList.toggle("is-active", state.boxMode === "copyBox");
      toolButtons.get("alt")!.classList.toggle("is-active", state.altMode);
      altLayers = { ...state.altLayers };
      for (const [key, check] of altChecks) check.checked = altLayers[key];
      toolButtons.get("copper")!.classList.toggle("is-active", state.wire === "copper");
      toolButtons.get("green")!.classList.toggle("is-active", state.wire === "green");
      toolButtons.get("red")!.classList.toggle("is-active", state.wire === "red");
      const changed = held?.name !== state.held?.name || held?.quality !== state.held?.quality;
      held = state.held;
      if (changed) render();
    },
    pickSlot(slot) {
      const item = stored.bars[stored.active]![slot];
      if (!item) return false;
      callbacks.onPickItem(item);
      return true;
    },
    closePanel() {
      if (altMenu.hidden) return closePanel();
      altMenu.hidden = true;
      return true;
    },
    destroy() {
      document.removeEventListener("pointerdown", onOutside, true);
      host.replaceChildren();
    },
  };
}
