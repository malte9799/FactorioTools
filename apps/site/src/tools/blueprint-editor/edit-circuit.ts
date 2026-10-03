/** The circuit GUIs, laid out like the game's own: the "Connected to" bar
 *  with each wire's network, the status line, a combinator's settings with
 *  its live input and output signals, a display panel's messages, a lamp's
 *  colours, and the enable/disable and read options of any wired building.
 *
 *  Every change goes through `commit`, which hands over a fresh copy of the
 *  entity's control_behavior to edit: undo snapshots are shallow, so the
 *  old object must never be changed in place. Live parts (network numbers,
 *  signal grids, status) redraw through the refresh function each builder
 *  returns, without rebuilding the controls under the cursor. */
import type {
  BpCircuitCondition,
  BpControlBehavior,
  BpDeciderCondition,
  BpDeciderOutput,
  BpLogisticFilter,
  BpNetworks,
  BpSignalId,
  GameData,
  PlacedEntity,
  RenderCatalog,
} from "@factoriotools/engine";
import { combinatorKind, parseSignalKey, signalKey, type CircuitSim, type Signals } from "@factoriotools/sim";
import { buildGridMenu, type GridMenuEntry, type GridMenuHandle } from "./grid-menu.js";
import { icon } from "./legacy-view/icons.js";
import { renderRichLabel } from "./rich-text.js";

/** Which wildcards a signal slot may hold — the game allows each one only
 *  in some places. */
export type Wildcards = ("each" | "anything" | "everything")[];

export interface CircuitCallbacks {
  /** True when a red or green wire reaches the entity. */
  wired: boolean;
  /** Edits a copy of the entity's control_behavior (created if missing);
   *  the entity itself for display-panel settings outside it. */
  commit(mutate: (cb: BpControlBehavior, entity: PlacedEntity) => void): void;
  /** Opens the signal picker. Clearing a slot is a right-click on it. */
  pickSignal(allow: Wildcards, onPick: (signal: BpSignalId) => void): void;
  /** The running circuit simulation, for live values. */
  live(): CircuitSim | undefined;
  /** Rebuilds the GUI without changing anything (a slot picked for
   *  editing). */
  redraw(): void;
}

type Refresh = () => void;

const COMPARATORS = ["<", ">", "=", "≥", "≤", "≠"];
const NORMALISE_CMP: Record<string, string> = { ">=": "≥", "<=": "≤", "!=": "≠", "==": "=" };
const OPERATIONS = ["*", "/", "+", "-", "%", "^", "<<", ">>", "AND", "OR", "XOR"];
const ANY_WILDCARD: Wildcards = ["each", "anything", "everything"];

/** Which constant-combinator slot has its count open for editing. Kept
 *  across rebuilds: every edit redraws the whole GUI. */
let selectedSlot: { entity: number; section: number; index: number } | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The open dropdown list, if any, and the button it hangs from. */
let openDropdown: { anchor: HTMLElement; close(): void } | undefined;

/** Opens (or, on its own button, closes) a dropdown list drawn in the page.
 *  Deliberately not a native <select>: after picking from the browser's own
 *  popup the page never saw that press end, and the next click on the map
 *  was lost — it took two clicks to reopen a combinator after changing its
 *  comparator. */
function toggleDropdown(anchor: HTMLElement, options: [string, string][], value: string, onPick: (v: string) => void): void {
  const wasOpenHere = openDropdown?.anchor === anchor;
  openDropdown?.close();
  if (wasOpenHere) return;

  const list = el("div", "circuit-dropdown-list");
  for (const [v, text] of options) {
    const item = el("button", v === value ? "is-selected" : undefined, text);
    item.type = "button";
    item.addEventListener("click", () => {
      close();
      if (v !== value) onPick(v);
    });
    list.appendChild(item);
  }
  const at = anchor.getBoundingClientRect();
  list.style.left = `${at.left}px`;
  list.style.top = `${at.bottom}px`;
  list.style.minWidth = `${at.width}px`;
  document.body.appendChild(list);
  // Opens upward when there is no room below.
  const height = list.getBoundingClientRect().height;
  if (at.bottom + height > window.innerHeight) list.style.top = `${Math.max(0, at.top - height)}px`;

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node;
    // A press on the button itself is left to its own click handler.
    if (!list.contains(target) && !anchor.contains(target)) close();
  };
  // Escape closes just the list, not the window behind it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  function close(): void {
    list.remove();
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    openDropdown = undefined;
  }
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  openDropdown = { anchor, close };
}

/** A signal count as the game prints it on a slot: 7, -12, 1.2k, 34M. */
export function slotCount(v: number): string {
  const a = Math.abs(v);
  const short = (d: number, unit: string) => `${(v / d).toFixed(a / d >= 10 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
  if (a >= 1e9) return short(1e9, "G");
  if (a >= 1e6) return short(1e6, "M");
  if (a >= 1e3) return short(1e3, "k");
  return String(v);
}

/** Entities whose whole GUI is their circuit settings. */
export function isCircuitFirst(name: string): boolean {
  return combinatorKind(name) !== undefined || /display-panel|lamp/.test(name);
}

/** True for anything the circuit GUI has something to say about. */
export function hasCircuitGui(entity: PlacedEntity, wired: boolean): boolean {
  return wired || isCircuitFirst(entity.name);
}

/** Which width class the properties window takes for this entity. */
export function circuitWindowKind(entity: PlacedEntity): string | undefined {
  const kind = combinatorKind(entity.name);
  if (kind === "decider" || kind === "arithmetic" || kind === "selector") return "wide";
  if (/display-panel/.test(entity.name)) return "panel";
  if (kind === "constant") return "medium";
  return undefined;
}

/* ---------- connection bar and status ---------- */

function signalsTitle(values: Signals, label: (name: string) => string): string {
  if (!values.size) return "Nothing on this network";
  return [...values].map(([k, v]) => `${label(parseSignalKey(k).name)}: ${v}`).join("\n");
}

/** "Connected to: 477 476" — the network number of each wire colour, per
 *  side for a combinator. */
export function buildConnectionBar(container: HTMLElement, entity: PlacedEntity, catalog: RenderCatalog, cb: CircuitCallbacks): Refresh {
  const bar = el("div", "circuit-bar");
  container.appendChild(bar);
  const kind = combinatorKind(entity.name);
  const sides: { side: 1 | 2; label?: string }[] = kind && kind !== "constant" ? [{ side: 1, label: "Input:" }, { side: 2, label: "Output:" }] : [{ side: 1 }];
  const label = (name: string) => catalog.itemNames[name] ?? catalog.signals?.[name]?.localised ?? name;
  let last = "";
  const refresh = () => {
    const sim = cb.live();
    // Only the network numbers decide the layout; the signal list for a
    // tooltip is read when the pointer gets there, not every tick.
    const parts = sides.map(({ side }) =>
      (["red", "green"] as const).map((color) => {
        const net = sim?.network(entity.entityNumber, color, side);
        return net ? { color, id: net.id + 1, side } : undefined;
      }),
    );
    const key = JSON.stringify(parts) + cb.wired;
    if (key === last) return;
    last = key;
    bar.replaceChildren();
    sides.forEach(({ label: sideLabel }, i) => {
      const group = el("div", "circuit-bar-side");
      if (sideLabel) group.appendChild(el("b", "circuit-bar-label", sideLabel));
      const nets = parts[i]!.filter((p) => p !== undefined);
      if (!nets.length) group.appendChild(el("span", undefined, "Not connected"));
      else {
        group.appendChild(el("span", undefined, "Connected to:"));
        for (const p of nets) {
          const id = el("span", `circuit-bar-net is-${p!.color}`, String(p!.id));
          const info = el("span", "circuit-info", "i");
          for (const target of [id, info]) {
            target.addEventListener("pointerenter", () => {
              const values = cb.live()?.network(entity.entityNumber, p!.color, p!.side)?.values ?? new Map();
              id.title = info.title = signalsTitle(values, label);
            });
          }
          group.append(id, info);
        }
      }
      bar.appendChild(group);
    });
  };
  refresh();
  return refresh;
}

/** "● Working", or what is keeping it from working. */
export function buildCircuitStatus(container: HTMLElement, entity: PlacedEntity, cb: CircuitCallbacks): Refresh {
  const row = el("div", "entity-gui-status circuit-status");
  container.appendChild(row);
  let last = "";
  const refresh = () => {
    const sim = cb.live();
    const n = entity.entityNumber;
    let ok = true;
    let text = "Working";
    if (combinatorKind(entity.name) === "constant" && entity.controlBehavior?.is_on === false) {
      ok = false;
      text = "Disabled";
    } else if (/lamp/.test(entity.name) && sim && !sim.lamp(n).on) {
      ok = false;
      text = "Disabled by control behavior";
    } else if (sim?.enabled(n) === false) {
      ok = false;
      text = "Disabled by control behavior";
    }
    const key = `${ok}${text}`;
    if (key === last) return;
    last = key;
    row.className = `entity-gui-status circuit-status ${ok ? "status-ok" : "status-warn"}`;
    row.innerHTML = `<span class="status-dot"></span>${text}`;
  };
  refresh();
  return refresh;
}

/* ---------- the body ---------- */

export function buildCircuitSection(container: HTMLElement, entity: PlacedEntity, data: GameData, catalog: RenderCatalog, cb: CircuitCallbacks): Refresh {
  const refreshers: Refresh[] = [];
  const label = (s: BpSignalId | undefined) => (s?.name ? (catalog.itemNames[s.name] ?? catalog.signals?.[s.name]?.localised ?? s.name) : "");
  const behavior = entity.controlBehavior ?? {};
  const n = entity.entityNumber;

  /* ---------- small controls ---------- */

  /** A signal slot: icon, optional count, click to pick, right-click to
   *  clear. */
  const slot = (
    signal: BpSignalId | undefined,
    allow: Wildcards,
    onPick: ((s: BpSignalId | undefined) => void) | undefined,
    opts: { count?: number; tint?: "red" | "green"; selected?: boolean; title?: string; onClick?: () => void } = {},
  ): HTMLButtonElement => {
    const b = el("button", `f-slot circuit-slot${opts.tint ? ` is-${opts.tint}` : ""}${opts.selected ? " is-selected" : ""}`);
    b.type = "button";
    b.title = signal?.name ? `${label(signal)}${onPick ? " — right-click to clear" : ""}` : (opts.title ?? "Pick a signal");
    if (signal?.name) {
      b.appendChild(icon(signal.name, label(signal), 32));
      // For the 'q' pipette: an item in a slot can be taken into the cursor.
      if (!signal.type || signal.type === "item") b.dataset.signal = signal.name;
    }
    if (opts.count !== undefined) b.appendChild(el("span", "f-slot-count", slotCount(opts.count)));
    if (opts.onClick) b.addEventListener("click", opts.onClick);
    else if (onPick) b.addEventListener("click", () => cb.pickSignal(allow, (s) => onPick(s)));
    else b.disabled = true;
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (signal?.name && onPick) onPick(undefined);
    });
    return b;
  };

  const numberInput = (value: number, onCommit: (v: number) => void, cls = "circuit-number"): HTMLInputElement => {
    const input = el("input", cls);
    input.type = "number";
    input.step = "1";
    input.value = String(value);
    const commit = () => {
      const v = Math.trunc(Number(input.value));
      onCommit(Number.isFinite(v) ? Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, v)) : 0);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      e.stopPropagation();
    });
    return input;
  };

  const select = (options: [string, string][], value: string, onChange: (v: string) => void, cls = "circuit-select"): HTMLButtonElement => {
    const b = el("button", `${cls} circuit-dropdown`, options.find(([v]) => v === value)?.[1] ?? value);
    b.type = "button";
    b.addEventListener("click", () => toggleDropdown(b, options, value, onChange));
    return b;
  };

  const checkbox = (text: string, checked: boolean, onChange: (on: boolean) => void, cls = "circuit-check"): HTMLLabelElement => {
    const row = el("label", cls);
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, el("span", undefined, text));
    return row;
  };

  const radio = (group: string, text: string, checked: boolean, onPick: () => void): HTMLLabelElement => {
    const row = el("label", "circuit-radio");
    const r = el("input");
    r.type = "radio";
    r.name = `${group}-${n}`;
    r.checked = checked;
    r.addEventListener("change", () => r.checked && onPick());
    row.append(r, el("span", undefined, text));
    return row;
  };

  /** The game's stacked R / G checkboxes: which wires an operand reads. */
  const wires = (nets: BpNetworks | undefined, onChange: ((n: BpNetworks | undefined) => void) | undefined, inline = false): HTMLElement => {
    const wrap = el("div", `circuit-wires${onChange ? "" : " is-off"}${inline ? " is-inline" : ""}`);
    for (const color of ["red", "green"] as const) {
      const row = el("label", `circuit-wire is-${color}`);
      const box = el("input");
      box.type = "checkbox";
      box.checked = nets?.[color] !== false;
      box.disabled = !onChange;
      box.addEventListener("change", () => {
        const next = { red: nets?.red !== false, green: nets?.green !== false, [color]: box.checked };
        onChange?.(next.red && next.green ? undefined : next);
      });
      row.append(box, el("span", undefined, color === "red" ? "R" : "G"));
      wrap.appendChild(row);
    }
    return wrap;
  };

  /** A box holding either a signal or a number, like the game's: shows the
   *  icon or the number; a click opens a small editor to type a number or
   *  pick a signal instead. */
  const valueBox = (signal: BpSignalId | undefined, constant: number, allow: Wildcards, onSignal: (s: BpSignalId) => void, onConstant: (v: number) => void): HTMLElement => {
    const wrap = el("div", "circuit-value-wrap");
    const box = el("button", `f-slot circuit-value${signal?.name ? "" : " is-number"}`);
    box.type = "button";
    if (signal?.name) {
      box.appendChild(icon(signal.name, label(signal), 32));
      box.title = `${label(signal)} — click to change, right-click for a number`;
    } else {
      box.textContent = slotCount(constant);
      box.title = "Click to set a number or pick a signal";
    }
    box.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (signal?.name) onConstant(0);
    });
    box.addEventListener("click", () => {
      if (wrap.querySelector(".circuit-popover")) return;
      const pop = el("div", "circuit-popover f-panel");
      const input = numberInput(signal?.name ? 0 : constant, (v) => onConstant(v));
      const pick = el("button", "f-button", "Signal…");
      pick.type = "button";
      pick.addEventListener("mousedown", (e) => e.preventDefault());
      pick.addEventListener("click", () => cb.pickSignal(allow, onSignal));
      pop.append(input, pick);
      wrap.appendChild(pop);
      input.focus();
      input.select();
      input.addEventListener("blur", () => setTimeout(() => pop.remove(), 150));
    });
    wrap.appendChild(box);
    return wrap;
  };

  const heading = (parent: HTMLElement, text: string) => parent.appendChild(el("div", "circuit-heading", text));

  const panel = (parent: HTMLElement, cls = "") => parent.appendChild(el("div", `f-panel circuit-panel ${cls}`));

  const fullButton = (parent: HTMLElement, text: string, onClick: () => void) => {
    const b = el("button", "f-button circuit-add", text);
    b.type = "button";
    b.addEventListener("click", onClick);
    parent.appendChild(b);
  };

  const removeButton = (onClick: () => void): HTMLButtonElement => {
    const b = el("button", "circuit-remove", "×");
    b.type = "button";
    b.title = "Remove";
    b.addEventListener("click", onClick);
    return b;
  };

  /** Keeps a row green while `holds` says its condition is met. */
  const lightWhile = (holds: () => boolean, target: () => HTMLElement) => {
    const refresh = () => target().classList.toggle("is-met", holds());
    refreshers.push(refresh);
    queueMicrotask(refresh);
  };

  /** [signal] [comparator] [value], the plain condition row. */
  const conditionRow = (cond: BpCircuitCondition | undefined, allow: Wildcards, onChange: (c: BpCircuitCondition) => void): HTMLElement => {
    const c: BpCircuitCondition = cond ?? {};
    const row = el("div", "circuit-row circuit-condition");
    row.appendChild(slot(c.first_signal, allow, (s) => onChange({ ...c, first_signal: s })));
    row.appendChild(select(COMPARATORS.map((x) => [x, x]), NORMALISE_CMP[c.comparator ?? "<"] ?? c.comparator ?? "<", (v) => onChange({ ...c, comparator: v }), "circuit-select circuit-cmp"));
    row.appendChild(valueBox(c.second_signal, c.constant ?? 0, [], (s) => onChange({ ...c, second_signal: s }), (v) => {
      const next = { ...c, constant: v };
      delete next.second_signal;
      onChange(next);
    }));
    // Green while the condition holds, as in game; a display panel's
    // message lights its whole row.
    lightWhile(() => cb.live()?.test(n, c) ?? false, () => (row.parentElement?.classList.contains("circuit-message") ? row.parentElement : row));
    return row;
  };

  /** A grid of live signals; with `tint`, red and green rows apart.
   *  Updated in place every tick: a slot's icon is only rebuilt when its
   *  signal changes, its count only rewritten when the count does, so a
   *  counter ticking every frame touches one text node. */
  const liveGrid = (parent: HTMLElement, read: () => { signals: Signals; tint?: "red" | "green" }[]) => {
    const grid = el("div", "f-slot-grid circuit-grid");
    parent.appendChild(grid);
    const cells: { el: HTMLButtonElement; key?: string; count?: number; countEl?: HTMLElement; tint?: string }[] = [];
    const refresh = () => {
      const want: { key?: string; count?: number; tint?: string }[] = [];
      for (const r of read()) {
        const list = [...r.signals].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        const size = Math.max(10, Math.ceil(list.length / 10) * 10);
        for (let i = 0; i < size; i++) want.push(list[i] ? { key: list[i]![0], count: list[i]![1], tint: r.tint } : {});
      }
      while (cells.length < want.length) {
        const b = el("button", "f-slot circuit-slot");
        b.type = "button";
        b.disabled = true;
        grid.appendChild(b);
        cells.push({ el: b });
      }
      while (cells.length > want.length) cells.pop()!.el.remove();
      want.forEach((w, i) => {
        const c = cells[i]!;
        if (c.key !== w.key) {
          c.key = w.key;
          c.el.replaceChildren();
          c.countEl = undefined;
          c.count = undefined;
          delete c.el.dataset.signal;
          c.el.title = "";
          if (w.key) {
            const s = parseSignalKey(w.key);
            c.el.appendChild(icon(s.name, label({ name: s.name, type: s.type }), 32));
            c.el.title = label({ name: s.name, type: s.type });
            if (s.type === "item") c.el.dataset.signal = s.name;
          }
        }
        if (c.count !== w.count) {
          c.count = w.count;
          if (w.count === undefined) c.countEl?.remove();
          else {
            if (!c.countEl) c.el.appendChild((c.countEl = el("span", "f-slot-count")));
            c.countEl.textContent = slotCount(w.count);
          }
          if (w.count === undefined) c.countEl = undefined;
        }
        if (c.tint !== w.tint) {
          c.el.classList.remove("is-red", "is-green");
          if (w.tint) c.el.classList.add(`is-${w.tint}`);
          c.tint = w.tint;
        }
      });
    };
    refresh();
    refreshers.push(refresh);
  };

  const inputRows = () => {
    const sim = cb.live();
    return (["red", "green"] as const).map((color) => ({ signals: sim?.network(n, color, 1)?.values ?? new Map(), tint: color }));
  };
  const outputRows = () => [{ signals: cb.live()?.combinatorOutput(n) ?? new Map<string, number>() }];

  const commitFlag = (key: keyof BpControlBehavior) => (on: boolean) =>
    cb.commit((b) => {
      if (on) b[key] = true;
      else delete b[key];
    });

  /* ---------- per entity ---------- */

  const kind = combinatorKind(entity.name);

  if (kind === "constant") {
    heading(container, "Output");
    const sw = el("div", "circuit-switch-row");
    const on = behavior.is_on !== false;
    const toggle = el("button", `circuit-switch${on ? " is-on" : ""}`);
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(on));
    toggle.title = "Output on or off";
    toggle.addEventListener("click", () => cb.commit((b) => {
      if (on) b.is_on = false;
      else delete b.is_on;
    }));
    sw.append(el("span", on ? "" : "is-active", "Off"), toggle, el("span", on ? "is-active" : "", "On"));
    container.appendChild(sw);
    container.appendChild(el("hr", "circuit-rule"));

    const sections = behavior.sections?.sections ?? [];
    const editSection = (si: number, fn: (filters: BpLogisticFilter[], section: NonNullable<NonNullable<BpControlBehavior["sections"]>["sections"]>[number]) => void) =>
      cb.commit((b) => {
        b.sections ??= {};
        const list = (b.sections.sections ??= []);
        while (list.length <= si) list.push({ index: list.length + 1, filters: [] });
        fn((list[si]!.filters ??= []), list[si]!);
      });
    const box = panel(container, "circuit-sections");
    sections.forEach((section, si) => {
      const head = el("div", "circuit-section-head");
      const active = el("input");
      active.type = "checkbox";
      active.checked = section.active !== false;
      active.title = "Section on or off";
      active.addEventListener("change", () => editSection(si, (_, s) => {
        if (active.checked) delete s.active;
        else s.active = false;
      }));
      const name = el("input", "circuit-group");
      name.type = "text";
      name.placeholder = "[No group assigned]";
      name.value = section.group ?? "";
      name.addEventListener("keydown", (e) => e.stopPropagation());
      name.addEventListener("change", () => editSection(si, (_, s) => {
        if (name.value) s.group = name.value;
        else delete s.group;
      }));
      const trash = el("button", "f-button is-danger circuit-trash", "🗑");
      trash.type = "button";
      trash.title = "Delete section";
      trash.addEventListener("click", () => cb.commit((b) => {
        b.sections?.sections?.splice(si, 1);
        b.sections?.sections?.forEach((s, i) => (s.index = i + 1));
      }));
      head.append(active, name, el("span", "circuit-grip"), trash);
      box.appendChild(head);

      // Slots sit at their own index, gaps and all, as in game.
      const filters = section.filters ?? [];
      const at = new Map(filters.map((f, i) => [(f.index ?? i + 1) - 1, f] as const));
      const highest = Math.max(-1, ...at.keys());
      const cells = Math.max(10, Math.ceil((highest + 2) / 10) * 10);
      const grid = el("div", "f-slot-grid circuit-grid");
      for (let i = 0; i < cells; i++) {
        const f = at.get(i);
        const isSel = selectedSlot?.entity === n && selectedSlot.section === si && selectedSlot.index === i;
        const setSignal = (sig: BpSignalId | undefined) =>
          editSection(si, (list) => {
            const k = list.findIndex((x, j) => (x.index ?? j + 1) === i + 1);
            if (!sig) {
              if (k >= 0) list.splice(k, 1);
              if (isSel) selectedSlot = undefined;
              return;
            }
            const next: BpLogisticFilter = { index: i + 1, type: sig.type, name: sig.name, quality: "normal", comparator: "=", count: k >= 0 ? list[k]!.count : 1 };
            if (k >= 0) list[k] = next;
            else list.push(next);
            list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            selectedSlot = { entity: n, section: si, index: i };
          });
        grid.appendChild(slot(f, [], setSignal, {
          count: f ? (f.count ?? 0) : undefined,
          selected: isSel,
          title: "Add a signal",
          onClick: f
            ? () => {
                selectedSlot = isSel ? undefined : { entity: n, section: si, index: i };
                cb.redraw();
              }
            : () => cb.pickSignal([], setSignal),
        }));
      }
      box.appendChild(grid);
      const sel = selectedSlot?.entity === n && selectedSlot.section === si ? at.get(selectedSlot.index) : undefined;
      if (sel) {
        const editRow = el("div", "circuit-row circuit-count-editor");
        const idx = selectedSlot!.index;
        editRow.append(
          icon(sel.name!, label(sel), 28),
          el("span", "circuit-label", label(sel)),
          numberInput(sel.count ?? 0, (v) => editSection(si, (list) => {
            const f = list.find((x, j) => (x.index ?? j + 1) === idx + 1);
            if (f) f.count = v;
          }), "circuit-number circuit-count"),
        );
        const change = el("button", "f-button", "Change signal");
        change.type = "button";
        change.addEventListener("click", () => cb.pickSignal([], (sig) => editSection(si, (list) => {
          const f = list.find((x, j) => (x.index ?? j + 1) === idx + 1);
          if (f) Object.assign(f, { type: sig.type, name: sig.name });
        })));
        editRow.appendChild(change);
        box.appendChild(editRow);
      }
    });
    fullButton(box, "Add section", () => editSection(sections.length, () => {}));
    return () => refreshers.forEach((r) => r());
  }

  if (kind === "decider" || kind === "arithmetic" || kind === "selector") {
    const cols = el("div", "circuit-columns");
    const left = el("div", "circuit-col");
    const right = el("div", "circuit-col");
    cols.append(left, right);
    container.appendChild(cols);

    if (kind === "decider") {
      const conds: BpDeciderCondition[] = behavior.decider_conditions?.conditions ?? [];
      const outs: BpDeciderOutput[] = behavior.decider_conditions?.outputs ?? [];
      const edit = (fn: (c: BpDeciderCondition[], o: BpDeciderOutput[]) => void) =>
        cb.commit((b) => {
          b.decider_conditions ??= {};
          fn((b.decider_conditions.conditions ??= []), (b.decider_conditions.outputs ??= []));
        });
      heading(left, "Conditions");
      const cbox = panel(left);
      conds.forEach((c, i) => {
        const row = el("div", "circuit-row circuit-decider-row");
        const join = el("div", "circuit-join");
        if (i > 0) join.appendChild(select([["or", "OR"], ["and", "AND"]], c.compare_type === "and" ? "and" : "or", (v) => edit((list) => (list[i]!.compare_type = v as "and" | "or")), "circuit-select circuit-join-select"));
        row.appendChild(join);
        const setNets = (key: "first_signal_networks" | "second_signal_networks") => (nets: BpNetworks | undefined) =>
          edit((list) => {
            if (nets) list[i]![key] = nets;
            else delete list[i]![key];
          });
        row.appendChild(wires(c.first_signal_networks, setNets("first_signal_networks")));
        row.appendChild(slot(c.first_signal, ANY_WILDCARD, (s) => edit((list) => {
          if (s) list[i]!.first_signal = s;
          else delete list[i]!.first_signal;
        })));
        row.appendChild(select(COMPARATORS.map((x) => [x, x]), NORMALISE_CMP[c.comparator ?? "<"] ?? c.comparator ?? "<", (v) => edit((list) => (list[i]!.comparator = v)), "circuit-select circuit-cmp"));
        row.appendChild(wires(c.second_signal_networks, c.second_signal?.name ? setNets("second_signal_networks") : undefined));
        row.appendChild(valueBox(c.second_signal, c.constant ?? 0, [], (s) => edit((list) => (list[i]!.second_signal = s)), (v) => edit((list) => {
          delete list[i]!.second_signal;
          list[i]!.constant = v;
        })));
        row.append(el("span", "circuit-grip"), removeButton(() => edit((list) => list.splice(i, 1))));
        lightWhile(() => cb.live()?.rowHolds(n, c) ?? false, () => row);
        cbox.appendChild(row);
      });
      fullButton(cbox, "+ Add condition", () => edit((list) => list.push(list.length ? { comparator: "<", constant: 0, compare_type: "and" } : { comparator: "<", constant: 0 })));

      heading(right, "Outputs");
      const obox = panel(right);
      outs.forEach((o, i) => {
        const row = el("div", "circuit-row circuit-output-row");
        const liveCount = () => (o.signal?.name ? cb.live()?.combinatorOutput(n)?.get(signalKey(o.signal)) : undefined);
        const s = slot(o.signal, ANY_WILDCARD, (sig) => edit((_, list) => {
          if (sig) list[i]!.signal = sig;
          else delete list[i]!.signal;
        }), { count: liveCount() });
        row.appendChild(s);
        refreshers.push(() => {
          const v = liveCount();
          let badge = s.querySelector<HTMLElement>(".f-slot-count");
          if (v === undefined) badge?.remove();
          else {
            if (!badge) s.appendChild((badge = el("span", "f-slot-count")));
            if (badge.textContent !== slotCount(v)) badge.textContent = slotCount(v);
          }
        });
        const copy = o.copy_count_from_input !== false;
        const choice = el("div", "circuit-output-choice is-compact");
        // "◯ 1 ✎": the constant, edited in place behind the pencil.
        const constRow = radio(`out${i}`, "", !copy, () => edit((_, list) => (list[i]!.copy_count_from_input = false)));
        const value = el("span", "circuit-const", String(o.constant ?? 1));
        const pen = el("button", "circuit-pen", "✎");
        pen.type = "button";
        pen.title = "Set the value";
        pen.addEventListener("click", (e) => {
          e.preventDefault();
          const input = numberInput(o.constant ?? 1, (v) => edit((_, list) => {
            list[i]!.constant = v;
            list[i]!.copy_count_from_input = false;
          }), "circuit-number circuit-const-input");
          value.replaceWith(input);
          pen.hidden = true;
          input.focus();
          input.select();
        });
        constRow.append(value, pen);
        // "◯ Input count ☑R ☑G" on one line.
        const copyRow = radio(`out${i}`, "Input count", copy, () => edit((_, list) => delete list[i]!.copy_count_from_input));
        copyRow.appendChild(wires(o.networks, copy ? (nets) => edit((_, list) => {
          if (nets) list[i]!.networks = nets;
          else delete list[i]!.networks;
        }) : undefined, true));
        choice.append(constRow, copyRow);
        row.append(choice, el("span", "circuit-grip"), removeButton(() => edit((_, list) => list.splice(i, 1))));
        obox.appendChild(row);
      });
      fullButton(obox, "+ Add output", () => edit((_, list) => list.push({ copy_count_from_input: false })));
    }

    if (kind === "arithmetic") {
      const a = behavior.arithmetic_conditions ?? {};
      const edit = (fn: (x: NonNullable<BpControlBehavior["arithmetic_conditions"]>) => void) => cb.commit((b) => fn((b.arithmetic_conditions ??= {})));
      heading(left, "Input");
      const box = panel(left);
      const row = el("div", "circuit-row");
      const operand = (which: "first" | "second") => {
        const sig = a[`${which}_signal`];
        row.appendChild(wires(a[`${which}_signal_networks`], sig?.name ? (nets) => edit((c) => {
          if (nets) c[`${which}_signal_networks`] = nets;
          else delete c[`${which}_signal_networks`];
        }) : undefined));
        row.appendChild(valueBox(sig, a[`${which}_constant`] ?? 0, ["each"], (s) => edit((c) => (c[`${which}_signal`] = s)), (v) => edit((c) => {
          delete c[`${which}_signal`];
          c[`${which}_constant`] = v;
        })));
      };
      operand("first");
      row.appendChild(select(OPERATIONS.map((x) => [x, x]), a.operation ?? "*", (v) => edit((c) => (c.operation = v)), "circuit-select circuit-op"));
      operand("second");
      box.appendChild(row);
      heading(right, "Output");
      const obox = panel(right);
      obox.appendChild(slot(a.output_signal, ["each"], (s) => edit((c) => {
        if (s) c.output_signal = s;
        else delete c.output_signal;
      })));
    }

    if (kind === "selector") {
      const op = behavior.operation ?? "select";
      heading(left, "Settings");
      const box = panel(left);
      box.appendChild(select(
        [["select", "Select input"], ["count", "Count inputs"], ["random", "Random input"], ["stack-size", "Stack size"], ["rocket-capacity", "Rocket capacity"], ["quality-filter", "Quality filter"], ["quality-transfer", "Quality transfer"]],
        op,
        (v) => cb.commit((b) => (b.operation = v)),
      ));
      const row = el("div", "circuit-row");
      if (op === "select") {
        const order = el("div", "circuit-output-choice");
        order.append(
          radio("order", "Sort descending", behavior.select_max !== false, () => cb.commit((b) => delete b.select_max)),
          radio("order", "Sort ascending", behavior.select_max === false, () => cb.commit((b) => (b.select_max = false))),
        );
        row.append(order, el("span", "circuit-label", "Index"), valueBox(behavior.index_signal, behavior.index_constant ?? 0, [], (s) => cb.commit((b) => (b.index_signal = s)), (v) => cb.commit((b) => {
          delete b.index_signal;
          b.index_constant = v;
        })));
      } else if (op === "count") {
        row.append(el("span", "circuit-label", "Output"), slot(behavior.count_signal, [], (s) => cb.commit((b) => {
          if (s) b.count_signal = s;
          else delete b.count_signal;
        })));
      } else if (op === "random") {
        row.append(el("span", "circuit-label", "Update every (ticks)"), numberInput(behavior.random_update_interval ?? 0, (v) => cb.commit((b) => (b.random_update_interval = Math.max(0, v)))));
      } else if (op !== "stack-size") {
        row.appendChild(el("span", "circuit-note", "Kept in the blueprint; the simulation outputs nothing for this mode."));
      }
      box.appendChild(row);
    }

    heading(left, "Input signals");
    liveGrid(left, inputRows);
    heading(right, "Output signals");
    liveGrid(right, outputRows);
    return () => refreshers.forEach((r) => r());
  }

  if (/display-panel/.test(entity.name)) {
    container.appendChild(checkbox('Always show in "Alt-mode"', entity.panel?.alwaysShow ?? false, (on) => cb.commit((_, e) => (e.panel = { ...e.panel, alwaysShow: on || undefined }))));
    container.appendChild(checkbox("Show tag in chart", entity.panel?.showInChart ?? false, (on) => cb.commit((_, e) => (e.panel = { ...e.panel, showInChart: on || undefined }))));
    const msgs = behavior.parameters ?? [];
    const box = panel(container, "circuit-messages");
    /** The message as the panel shows it (rich text: colours, fonts,
     *  icons); the pencil, or a click, swaps in the raw text to edit. */
    const textField = (value: string | undefined, onCommit: (v: string | undefined) => void) => {
      const wrap = el("div", "circuit-text-wrap");
      const view = el("div", "circuit-text circuit-text-view");
      view.title = "Click to edit";
      if (value) view.appendChild(renderRichLabel(value, 16));
      else view.appendChild(el("span", "circuit-placeholder", "Text"));
      const t = el("input", "circuit-text");
      t.type = "text";
      t.value = value ?? "";
      t.hidden = true;
      const edit = () => {
        view.hidden = true;
        t.hidden = false;
        t.focus();
      };
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter") t.blur();
        e.stopPropagation();
      });
      t.addEventListener("blur", () => {
        if ((t.value || undefined) !== value) onCommit(t.value || undefined);
        else {
          t.hidden = true;
          view.hidden = false;
        }
      });
      view.addEventListener("click", edit);
      const pen = el("button", "circuit-pen", "✎");
      pen.type = "button";
      pen.title = "Edit text";
      pen.addEventListener("click", edit);
      wrap.append(view, t, pen);
      return wrap;
    };
    if (!msgs.length) {
      // No circuit messages: the panel's own icon and text, always shown.
      const row = el("div", "circuit-row circuit-message");
      row.append(
        slot(entity.panel?.icon, [], (x) => cb.commit((_, e) => (e.panel = { ...e.panel, icon: x }))),
        textField(entity.panel?.text, (v) => cb.commit((_, e) => (e.panel = { ...e.panel, text: v }))),
      );
      box.appendChild(row);
    }
    const edit = (fn: (list: NonNullable<BpControlBehavior["parameters"]>) => void) => cb.commit((b) => fn((b.parameters ??= [])));
    msgs.forEach((m, i) => {
      const row = el("div", "circuit-row circuit-message");
      row.append(
        slot(m.icon, [], (x) => edit((list) => (list[i] = { ...list[i], icon: x }))),
        textField(m.text, (v) => edit((list) => (list[i] = { ...list[i], text: v }))),
        conditionRow(m.condition, ["anything", "everything"], (c) => edit((list) => (list[i] = { ...list[i], condition: c }))),
        el("span", "circuit-grip"),
        removeButton(() => edit((list) => list.splice(i, 1))),
      );
      box.appendChild(row);
    });
    fullButton(box, "+ Add message", () => edit((list) => {
      // The first circuit message takes over what the panel showed.
      if (!list.length && (entity.panel?.icon || entity.panel?.text)) list.push({ icon: entity.panel.icon, text: entity.panel.text, condition: { comparator: "<", constant: 0 } });
      list.push({ condition: { comparator: "<", constant: 0 } });
    }));
    return () => refreshers.forEach((r) => r());
  }

  /* ---------- lamps and every other wired building ---------- */

  const box = /lamp/.test(entity.name) ? container : panel(container, "circuit-building");
  if (box !== container) heading(box, "Circuit connection");
  if (!cb.wired) {
    box.appendChild(el("div", "circuit-note", "Connect a red or green wire to control it from the circuit network."));
    return () => {};
  }

  const enabled = !!(behavior.circuit_enabled ?? behavior.circuit_enable_disable ?? (/lamp/.test(entity.name) && behavior.circuit_condition));
  box.appendChild(checkbox("Enable/disable", enabled, (on) => cb.commit((b) => {
    delete b.circuit_enable_disable;
    if (on) {
      b.circuit_enabled = true;
      b.circuit_condition ??= { comparator: ">", constant: 0 };
    } else b.circuit_enabled = false;
  })));
  if (enabled) box.appendChild(conditionRow(behavior.circuit_condition, ["anything", "everything"], (c) => cb.commit((b) => (b.circuit_condition = c))));

  if (/lamp/.test(entity.name)) {
    box.appendChild(checkbox("Use colors", !!behavior.use_colors, commitFlag("use_colors")));
    if (behavior.use_colors) {
      const modes = el("div", "circuit-output-choice circuit-indent");
      ([["0", "Color mapping"], ["1", "Components (RGB)"], ["2", "Packed RGB value"]] as const).forEach(([v, text]) =>
        modes.appendChild(radio("color", text, String(behavior.color_mode ?? 0) === v, () => cb.commit((b) => (b.color_mode = Number(v))))),
      );
      box.appendChild(modes);
    }
    return () => {};
  }

  const readModes = (group: string, current: number, options: [number, string][], onPick: (v: number) => void) => {
    const modes = el("div", "circuit-output-choice circuit-indent");
    for (const [v, text] of options) modes.appendChild(radio(group, text, current === v, () => onPick(v)));
    box.appendChild(modes);
  };

  if (data.inserters[entity.name]) {
    box.appendChild(checkbox("Set filters", !!behavior.circuit_set_filters, commitFlag("circuit_set_filters")));
    box.appendChild(checkbox("Read hand contents", !!behavior.circuit_read_hand_contents, commitFlag("circuit_read_hand_contents")));
    if (behavior.circuit_read_hand_contents) readModes("hand", behavior.circuit_hand_read_mode ?? 0, [[0, "Pulse"], [1, "Hold"]], (v) => cb.commit((b) => (b.circuit_hand_read_mode = v)));
    box.appendChild(checkbox("Set stack size", !!behavior.circuit_set_stack_size, commitFlag("circuit_set_stack_size")));
    if (behavior.circuit_set_stack_size) {
      const row = el("div", "circuit-row circuit-indent");
      row.append(slot(behavior.stack_control_input_signal, [], (x) => cb.commit((b) => {
        if (x) b.stack_control_input_signal = x;
        else delete b.stack_control_input_signal;
      })));
      box.appendChild(row);
    }
  } else if (data.belts[entity.name]) {
    box.appendChild(checkbox("Read belt contents", !!behavior.circuit_read_hand_contents, commitFlag("circuit_read_hand_contents")));
    if (behavior.circuit_read_hand_contents) readModes("belt", behavior.circuit_contents_read_mode ?? 0, [[0, "Pulse"], [1, "Hold"], [2, "Hold (all belts)"]], (v) => cb.commit((b) => (b.circuit_contents_read_mode = v)));
  } else if (data.machines[entity.name]) {
    box.appendChild(checkbox("Read contents", !!behavior.read_contents, commitFlag("read_contents")));
    box.appendChild(checkbox("Read working", !!behavior.read_working, commitFlag("read_working")));
    if (behavior.read_working) {
      const row = el("div", "circuit-row circuit-indent");
      row.append(slot(behavior.working_signal ?? { type: "virtual", name: "signal-W" }, [], (x) => cb.commit((b) => {
        if (x) b.working_signal = x;
        else delete b.working_signal;
      })));
      box.appendChild(row);
    }
  }
  return () => refreshers.forEach((r) => r());
}

const WILDCARD_NAMES: Record<string, Wildcards[number]> = { "signal-each": "each", "signal-anything": "anything", "signal-everything": "everything" };

/** The signal picker: every item, fluid and virtual signal, in the build
 *  menu's grid, with only the wildcards this slot allows. */
export function buildSignalMenu(
  container: HTMLElement,
  catalog: RenderCatalog,
  allow: Wildcards,
  onPick: (signal: BpSignalId) => void,
  onCancel: () => void,
  tab: { initial?: string; onChange?: (group: string) => void } = {},
): GridMenuHandle {
  const entries: GridMenuEntry[] = [
    ...Object.entries(catalog.itemNames).map(([name, localised]) => ({ name, localised, position: catalog.itemMenuPositions[name] })),
    ...Object.entries(catalog.signals ?? {})
      .filter(([name]) => !WILDCARD_NAMES[name] || allow.includes(WILDCARD_NAMES[name]!))
      .map(([name, s]) => ({ name, localised: s.localised, position: s.position })),
  ];
  return buildGridMenu(container, {
    entries,
    groups: catalog.menuGroups,
    filterLabel: "Filter signals",
    showQuality: false,
    initialTab: tab.initial,
    onTabChange: tab.onChange,
    onConfirm: ({ name }) => {
      const type = catalog.signals?.[name]?.type;
      onPick(type ? { type, name } : { name });
    },
    onCancel,
  });
}
