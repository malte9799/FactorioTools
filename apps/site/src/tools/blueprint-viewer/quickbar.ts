/** The game's bottom-of-screen quickbar: ten switchable bars of ten slots,
 *  each slot holding a placeable entity to take into the cursor as a ghost,
 *  plus the shortcut tool grid to its right (undo/redo, the planner tools,
 *  alt mode, the three wires).
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

export interface QuickbarCallbacks {
  /** Left or right click on a filled slot (or its number key): put the item
   *  in the cursor. */
  onPickItem(item: QuickbarItem): void;
  /** Left click on an empty slot: the caller opens its picker and later
   *  answers through the handle's setSlot(). */
  onAssignSlot(bar: number, slot: number): void;
  onTool(tool: QuickbarTool): void;
}

/** Live editor state the tool grid and slots reflect. */
export interface QuickbarState {
  canUndo: boolean;
  canRedo: boolean;
  boxMode: "deleteBox" | "copyBox" | null;
  altMode: boolean;
  wire: "copper" | "red" | "green" | null;
  /** The entity ghost in the cursor, so its slot can show as the one in hand. */
  held: QuickbarItem | null;
}

export interface QuickbarHandle {
  setSlot(bar: number, slot: number, item: QuickbarItem | null): void;
  sync(state: QuickbarState): void;
  /** Number-key access: picks slot `slot` of the active bar, if filled. */
  pickSlot(slot: number): boolean;
  /** Closes the all-bars panel; true if it was open (for Escape). */
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

/* Shortcut glyphs, drawn after the game's own shortcut-bar art: a white
   dashed selection square with the tool's mark inside on the planner
   colours, dark arrows on the grey undo/redo buttons. */
const DASHED = `<rect x="4" y="4" width="24" height="24" fill="none" stroke="#fff" stroke-width="2.2" stroke-dasharray="3.2 2.4"/>`;
const ICONS: Record<Exclude<QuickbarTool, "copper" | "green" | "red">, string> = {
  undo: `<svg viewBox="0 0 32 32"><path d="M9 13a9 9 0 0 1 16 5h-3.6A5.6 5.6 0 0 0 11.6 15.4L15 19H6v-9z" fill="currentColor"/></svg>`,
  redo: `<svg viewBox="0 0 32 32"><path d="M23 13a9 9 0 0 0-16 5h3.6a5.6 5.6 0 0 1 9.8-2.6L17 19h9v-9z" fill="currentColor"/></svg>`,
  deconstruct: `<svg viewBox="0 0 32 32">${DASHED}<path d="M11 11l10 10M21 11L11 21" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>`,
  blueprint: `<svg viewBox="0 0 32 32">${DASHED}<path d="M16 10v12M10 16h12" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>`,
  upgrade: `<svg viewBox="0 0 32 32">${DASHED}<path d="M16 9l6 7h-3.6v6h-4.8v-6H10z" fill="#fff"/></svg>`,
  book: `<svg viewBox="0 0 32 32"><path d="M8 5h15a2 2 0 0 1 2 2v20H10a2 2 0 0 1-2-2z" fill="#e8f1f8"/><path d="M10 23h15v4H10a2 2 0 0 1 0-4z" fill="#9fb9cc"/><rect x="11" y="8" width="11" height="11" fill="none" stroke="#3b6d93" stroke-width="1.6" stroke-dasharray="2 1.6"/></svg>`,
  alt: `<svg viewBox="0 0 32 32"><rect x="3" y="9" width="26" height="14" rx="3" fill="#3a3a3a"/><text x="16" y="20.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="10" fill="#d6d6d6" letter-spacing="0.5">ALT</text></svg>`,
};

const WIRE_ITEMS: Record<"copper" | "green" | "red", string> = {
  copper: "copper-cable",
  green: "green-wire",
  red: "red-wire",
};

interface ToolSpec {
  tool: QuickbarTool;
  label: string;
  tone: "grey" | "red" | "green" | "blue";
}

/** Column-major, top then bottom, as the game lays the grid out. */
const TOOLS: ToolSpec[] = [
  { tool: "undo", label: "Undo (Ctrl+Z)", tone: "grey" },
  { tool: "redo", label: "Redo (Ctrl+Y)", tone: "grey" },
  { tool: "deconstruct", label: "Deconstruction planner (Alt+D)", tone: "red" },
  { tool: "blueprint", label: "Create blueprint (Ctrl+C)", tone: "blue" },
  { tool: "upgrade", label: "Upgrade planner — coming next", tone: "green" },
  { tool: "book", label: "Create blueprint book from the current blueprint", tone: "blue" },
  { tool: "alt", label: "Alt mode (Alt)", tone: "grey" },
  { tool: "copper", label: "Copper wire (Alt+C)", tone: "grey" },
  { tool: "green", label: "Green wire (Alt+G)", tone: "grey" },
  { tool: "red", label: "Red wire (Alt+R)", tone: "grey" },
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
  const panelRows = document.createElement("div");
  panelRows.className = "qb-panel-rows";
  panel.append(panelHeader, panelRows);

  const mainRow = document.createElement("div");
  mainRow.className = "qb-bar-row is-main";
  hotbarFrame.append(mainRow);

  /* ----- tools ----- */
  const toolsFrame = document.createElement("div");
  toolsFrame.className = "qb-frame qb-tools";
  const toolButtons = new Map<QuickbarTool, HTMLButtonElement>();
  for (const spec of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `qb-tool is-${spec.tone}`;
    button.title = spec.label;
    button.setAttribute("aria-label", spec.label);
    if (spec.tool === "copper" || spec.tool === "green" || spec.tool === "red") {
      button.appendChild(icon(WIRE_ITEMS[spec.tool], "", 28));
    } else {
      button.innerHTML = ICONS[spec.tool];
    }
    if (spec.tool === "upgrade") button.disabled = true;
    button.addEventListener("click", () => callbacks.onTool(spec.tool));
    toolButtons.set(spec.tool, button);
    toolsFrame.appendChild(button);
  }

  host.append(panel, hotbarFrame, toolsFrame);

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
      button.appendChild(icon(item.name, item.name.replace(/-/g, " "), 32));
      if (item.quality !== "normal") {
        const q = document.createElement("span");
        q.className = `qb-quality quality-${item.quality}`;
        q.title = item.quality;
        button.appendChild(q);
      }
      button.title = `${item.name.replace(/-/g, " ")}\nClick: take into cursor · ⌘/Ctrl+right-click: clear`;
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
      if (e.metaKey || e.ctrlKey) {
        stored.bars[bar]![slot] = null;
        persist();
        render();
        return;
      }
      callbacks.onPickItem(item);
      closePanel();
    });
    return button;
  }

  function fillRow(row: HTMLElement, bar: number, numberButton: HTMLButtonElement): void {
    row.replaceChildren(numberButton);
    const slots = document.createElement("div");
    slots.className = "qb-slots";
    for (let s = 0; s < SLOTS; s++) slots.appendChild(makeSlot(bar, s));
    row.appendChild(slots);
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
    fillRow(mainRow, stored.active, mainNumber);

    if (panel.hidden) return;
    panelRows.replaceChildren();
    // Top to bottom: 0, 9, 8 … 1 — the tenth bar first, as in the game.
    for (let bar = BARS - 1; bar >= 0; bar--) {
      const row = document.createElement("div");
      row.className = "qb-bar-row";
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
      fillRow(row, bar, number);
      panelRows.appendChild(row);
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
    closePanel,
    destroy() {
      host.replaceChildren();
    },
  };
}
