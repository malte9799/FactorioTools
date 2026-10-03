/** The circuit half of the entity GUI: a combinator's settings, a display
 *  panel's messages, a lamp's colours, and the enable/disable and read
 *  options every wired building has. Laid out like the game's own circuit
 *  GUIs, built from the same plain controls as the rest of the entity GUI.
 *
 *  Every change goes through `commit`, which hands over a fresh copy of the
 *  entity's control_behavior to edit: undo snapshots are shallow, so the
 *  old object must never be changed in place. */
import type {
  BpArithmeticConditions,
  BpCircuitCondition,
  BpControlBehavior,
  BpDeciderCondition,
  BpDeciderOutput,
  BpNetworks,
  BpSignalId,
  GameData,
  PlacedEntity,
  RenderCatalog,
} from "@factoriotools/engine";
import { combinatorKind } from "@factoriotools/sim";
import { buildGridMenu, type GridMenuEntry, type GridMenuHandle } from "./grid-menu.js";
import { icon } from "./legacy-view/icons.js";

/** Which wildcards a signal slot may hold — the game allows each one only
 *  in some places. */
export type Wildcards = ("each" | "anything" | "everything")[];

export interface CircuitCallbacks {
  /** True when a red or green wire reaches the entity. */
  wired: boolean;
  /** Edits a copy of the entity's control_behavior (created if missing)
   *  and, when given, its display-panel settings. */
  commit(mutate: (cb: BpControlBehavior, entity: PlacedEntity) => void): void;
  /** Opens the signal picker; `onPick(undefined)` is never called — a
   *  right-click on the slot clears it instead. */
  pickSignal(allow: Wildcards, onPick: (signal: BpSignalId) => void): void;
}

const COMPARATORS = ["<", ">", "=", "≥", "≤", "≠"];
const NORMALISE_CMP: Record<string, string> = { ">=": "≥", "<=": "≤", "!=": "≠", "==": "=" };
const OPERATIONS = ["*", "/", "+", "-", "%", "^", "<<", ">>", "AND", "OR", "XOR"];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** True for anything the circuit GUI has something to say about. */
export function hasCircuitGui(entity: PlacedEntity, wired: boolean): boolean {
  return wired || combinatorKind(entity.name) !== undefined || /display-panel|lamp/.test(entity.name);
}

export function buildCircuitSection(container: HTMLElement, entity: PlacedEntity, data: GameData, catalog: RenderCatalog, cb: CircuitCallbacks): void {
  const label = (s: BpSignalId | undefined) => (s?.name ? (catalog.itemNames[s.name] ?? catalog.signals?.[s.name]?.localised ?? s.name) : "");
  const behavior = entity.controlBehavior ?? {};

  /* ---------- small controls ---------- */

  const signalSlot = (signal: BpSignalId | undefined, allow: Wildcards, onPick: (s: BpSignalId | undefined) => void, title = "Pick a signal"): HTMLButtonElement => {
    const b = el("button", "filter-slot-button circuit-slot");
    b.type = "button";
    b.title = signal?.name ? `${label(signal)} — right-click to clear` : title;
    if (signal?.name) b.appendChild(icon(signal.name, label(signal), 28));
    b.addEventListener("click", () => cb.pickSignal(allow, (s) => onPick(s)));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (signal?.name) onPick(undefined);
    });
    return b;
  };

  const numberField = (value: number, onCommit: (v: number) => void, title = ""): HTMLInputElement => {
    const input = el("input", "circuit-number");
    input.type = "number";
    input.step = "1";
    input.value = String(value);
    input.title = title;
    input.addEventListener("change", () => {
      const v = Math.trunc(Number(input.value));
      onCommit(Number.isFinite(v) ? Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, v)) : 0);
    });
    return input;
  };

  const select = (options: [string, string][], value: string, onChange: (v: string) => void, cls = "circuit-select"): HTMLSelectElement => {
    const s = el("select", cls);
    for (const [v, text] of options) {
      const o = el("option", undefined, text);
      o.value = v;
      o.selected = v === value;
      s.appendChild(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  const checkbox = (text: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement => {
    const row = el("label", "entity-gui-checkbox-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, document.createTextNode(` ${text}`));
    return row;
  };

  /** Red / green toggles for which wires an operand reads. */
  const networks = (nets: BpNetworks | undefined, onChange: (n: BpNetworks | undefined) => void): HTMLElement => {
    const wrap = el("span", "circuit-nets");
    for (const color of ["red", "green"] as const) {
      const on = nets?.[color] !== false;
      const b = el("button", `circuit-net circuit-net-${color}${on ? " is-on" : ""}`, color === "red" ? "R" : "G");
      b.type = "button";
      b.title = `${on ? "Reads" : "Ignores"} the ${color} wire`;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => {
        const next = { red: nets?.red !== false, green: nets?.green !== false, [color]: !on };
        onChange(next.red && next.green ? undefined : next);
      });
      wrap.appendChild(b);
    }
    return wrap;
  };

  /** [signal] [comparator] [signal or number], the game's condition row. */
  const condition = (cond: BpCircuitCondition | undefined, allow: Wildcards, onChange: (c: BpCircuitCondition) => void): HTMLElement => {
    const c: BpCircuitCondition = cond ?? {};
    const row = el("div", "circuit-row");
    row.appendChild(signalSlot(c.first_signal, allow, (s) => onChange({ ...c, first_signal: s })));
    row.appendChild(select(COMPARATORS.map((x) => [x, x]), NORMALISE_CMP[c.comparator ?? "<"] ?? c.comparator ?? "<", (v) => onChange({ ...c, comparator: v }), "circuit-select circuit-cmp"));
    row.appendChild(signalSlot(c.second_signal, [], (s) => onChange({ ...c, second_signal: s }), "A signal, or leave empty to compare with a number"));
    if (!c.second_signal?.name) row.appendChild(numberField(c.constant ?? 0, (v) => onChange({ ...c, constant: v })));
    return row;
  };

  const section = (title: string): HTMLDivElement => {
    const s = el("div", "entity-gui-section circuit-section");
    s.appendChild(el("div", "circuit-heading", title));
    container.appendChild(s);
    return s;
  };

  const addButton = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = el("button", "circuit-add", text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };

  const removeButton = (onClick: () => void): HTMLButtonElement => {
    const b = el("button", "circuit-remove", "×");
    b.type = "button";
    b.title = "Remove";
    b.addEventListener("click", onClick);
    return b;
  };

  /* ---------- per entity ---------- */

  const kind = combinatorKind(entity.name);

  if (kind === "constant") {
    const s = section("Constant combinator");
    s.appendChild(checkbox("Output on", behavior.is_on !== false, (on) => cb.commit((b) => {
      if (on) delete b.is_on;
      else b.is_on = false;
    })));
    const sections = behavior.sections?.sections ?? [];
    const filters = sections[0]?.filters ?? [];
    const grid = el("div", "circuit-constant-grid");
    const editFilters = (fn: (f: NonNullable<typeof filters>) => void) =>
      cb.commit((b) => {
        b.sections ??= {};
        b.sections.sections ??= [];
        if (!b.sections.sections[0]) b.sections.sections[0] = { index: 1, filters: [] };
        const list = (b.sections.sections[0].filters ??= []);
        fn(list);
        list.forEach((f, i) => (f.index = i + 1));
      });
    filters.forEach((f, i) => {
      const cell = el("div", "circuit-constant-cell");
      cell.appendChild(signalSlot(f, [], (sig) => editFilters((list) => {
        if (!sig) list.splice(i, 1);
        else list[i] = { ...list[i], ...sig, type: sig.type, quality: list[i]?.quality ?? "normal" };
      })));
      cell.appendChild(numberField(f.count ?? 0, (v) => editFilters((list) => (list[i]!.count = v))));
      grid.appendChild(cell);
    });
    const empty = el("div", "circuit-constant-cell");
    empty.appendChild(signalSlot(undefined, [], (sig) => sig && editFilters((list) => list.push({ ...sig, quality: "normal", comparator: "=", count: 1 })), "Add a signal"));
    grid.appendChild(empty);
    s.appendChild(grid);
    if (sections.length > 1) s.appendChild(el("div", "circuit-note", `Plus ${sections.length - 1} more section${sections.length === 2 ? "" : "s"} from the blueprint, kept as they are.`));
    return;
  }

  if (kind === "arithmetic") {
    const s = section("Arithmetic combinator");
    const a: BpArithmeticConditions = behavior.arithmetic_conditions ?? {};
    const edit = (fn: (x: BpArithmeticConditions) => void) => cb.commit((b) => fn((b.arithmetic_conditions ??= {})));
    const operand = (which: "first" | "second") => {
      const wrap = el("div", "circuit-operand");
      const sig = a[`${which}_signal`];
      wrap.appendChild(signalSlot(sig, ["each"], (x) => edit((c) => {
        if (x) c[`${which}_signal`] = x;
        else delete c[`${which}_signal`];
      })));
      if (!sig?.name) wrap.appendChild(numberField(a[`${which}_constant`] ?? 0, (v) => edit((c) => (c[`${which}_constant`] = v))));
      else wrap.appendChild(networks(a[`${which}_signal_networks`], (n) => edit((c) => {
        if (n) c[`${which}_signal_networks`] = n;
        else delete c[`${which}_signal_networks`];
      })));
      return wrap;
    };
    const row = el("div", "circuit-row");
    row.append(operand("first"), select(OPERATIONS.map((x) => [x, x]), a.operation ?? "*", (v) => edit((c) => (c.operation = v)), "circuit-select circuit-op"), operand("second"));
    s.appendChild(row);
    const out = el("div", "circuit-row");
    out.append(el("span", "circuit-label", "Output"), signalSlot(a.output_signal, ["each"], (x) => edit((c) => {
      if (x) c.output_signal = x;
      else delete c.output_signal;
    })));
    s.appendChild(out);
    return;
  }

  if (kind === "decider") {
    const conds: BpDeciderCondition[] = behavior.decider_conditions?.conditions ?? [];
    const outs: BpDeciderOutput[] = behavior.decider_conditions?.outputs ?? [];
    const edit = (fn: (c: BpDeciderCondition[], o: BpDeciderOutput[]) => void) =>
      cb.commit((b) => {
        b.decider_conditions ??= {};
        fn((b.decider_conditions.conditions ??= []), (b.decider_conditions.outputs ??= []));
      });
    const s = section("Decider combinator · conditions");
    conds.forEach((c, i) => {
      const line = el("div", "circuit-decider-row");
      if (i > 0) line.appendChild(select([["or", "OR"], ["and", "AND"]], c.compare_type === "and" ? "and" : "or", (v) => edit((list) => (list[i]!.compare_type = v as "and" | "or")), "circuit-select circuit-join"));
      const row = condition(c, ["each", "anything", "everything"], (next) => edit((list) => (list[i] = { ...list[i], ...next })));
      if (c.first_signal?.name) row.insertBefore(networks(c.first_signal_networks, (n) => edit((list) => {
        if (n) list[i]!.first_signal_networks = n;
        else delete list[i]!.first_signal_networks;
      })), row.children[1]!);
      row.appendChild(removeButton(() => edit((list) => list.splice(i, 1))));
      line.appendChild(row);
      s.appendChild(line);
    });
    s.appendChild(addButton("+ Add condition", () => edit((list) => list.push(list.length ? { comparator: "<", constant: 0, compare_type: "and" } : { comparator: "<", constant: 0 }))));
    const so = section("Outputs");
    outs.forEach((o, i) => {
      const row = el("div", "circuit-row");
      row.appendChild(signalSlot(o.signal, ["each", "anything", "everything"], (sig) => edit((_, list) => {
        if (sig) list[i]!.signal = sig;
        else delete list[i]!.signal;
      })));
      const copy = o.copy_count_from_input !== false;
      row.appendChild(select([["input", "Input count"], ["constant", "Constant"]], copy ? "input" : "constant", (v) => edit((_, list) => {
        if (v === "input") delete list[i]!.copy_count_from_input;
        else list[i]!.copy_count_from_input = false;
      })));
      if (!copy) row.appendChild(numberField(o.constant ?? 1, (v) => edit((_, list) => (list[i]!.constant = v))));
      else row.appendChild(networks(o.networks, (n) => edit((_, list) => {
        if (n) list[i]!.networks = n;
        else delete list[i]!.networks;
      })));
      row.appendChild(removeButton(() => edit((_, list) => list.splice(i, 1))));
      so.appendChild(row);
    });
    so.appendChild(addButton("+ Add output", () => edit((_, list) => list.push({}))));
    return;
  }

  if (kind === "selector") {
    const s = section("Selector combinator");
    const op = behavior.operation ?? "select";
    s.appendChild(select(
      [["select", "Select input"], ["count", "Count inputs"], ["random", "Random input"], ["stack-size", "Stack size"], ["rocket-capacity", "Rocket capacity"], ["quality-filter", "Quality filter"], ["quality-transfer", "Quality transfer"]],
      op,
      (v) => cb.commit((b) => (b.operation = v)),
    ));
    const row = el("div", "circuit-row");
    if (op === "select") {
      row.appendChild(select([["max", "Sort descending"], ["min", "Sort ascending"]], behavior.select_max === false ? "min" : "max", (v) => cb.commit((b) => (b.select_max = v === "max"))));
      row.appendChild(el("span", "circuit-label", "Index"));
      row.appendChild(signalSlot(behavior.index_signal, [], (x) => cb.commit((b) => {
        if (x) b.index_signal = x;
        else delete b.index_signal;
      })));
      if (!behavior.index_signal?.name) row.appendChild(numberField(behavior.index_constant ?? 0, (v) => cb.commit((b) => (b.index_constant = v))));
    } else if (op === "count") {
      row.append(el("span", "circuit-label", "Output"), signalSlot(behavior.count_signal, [], (x) => cb.commit((b) => {
        if (x) b.count_signal = x;
        else delete b.count_signal;
      })));
    } else if (op === "random") {
      row.append(el("span", "circuit-label", "Every (ticks)"), numberField(behavior.random_update_interval ?? 0, (v) => cb.commit((b) => (b.random_update_interval = Math.max(0, v)))));
    } else if (op !== "stack-size") {
      row.appendChild(el("span", "circuit-note", "Kept in the blueprint; the simulation outputs nothing for this mode."));
    }
    s.appendChild(row);
    return;
  }

  if (/display-panel/.test(entity.name)) {
    const msgs = behavior.parameters ?? [];
    const s = section("Display panel");
    const own = el("div", "circuit-row");
    own.append(el("span", "circuit-label", "Shows"), signalSlot(entity.panel?.icon, [], (x) => cb.commit((_, e) => (e.panel = { ...e.panel, icon: x }))));
    const text = el("input", "circuit-text");
    text.type = "text";
    text.placeholder = "Text";
    text.value = entity.panel?.text ?? "";
    text.addEventListener("change", () => cb.commit((_, e) => (e.panel = { ...e.panel, text: text.value || undefined })));
    own.appendChild(text);
    s.appendChild(own);
    const edit = (fn: (list: NonNullable<BpControlBehavior["parameters"]>) => void) => cb.commit((b) => fn((b.parameters ??= [])));
    if (msgs.length || cb.wired) s.appendChild(el("div", "circuit-heading", "Circuit messages — the first whose condition holds is shown"));
    msgs.forEach((m, i) => {
      const row = el("div", "circuit-row");
      row.appendChild(signalSlot(m.icon, [], (x) => edit((list) => (list[i] = { ...list[i], icon: x }))));
      const t = el("input", "circuit-text");
      t.type = "text";
      t.placeholder = "Text";
      t.value = m.text ?? "";
      t.addEventListener("change", () => edit((list) => (list[i] = { ...list[i], text: t.value || undefined })));
      row.append(t, removeButton(() => edit((list) => list.splice(i, 1))));
      s.appendChild(row);
      s.appendChild(condition(m.condition, ["anything", "everything"], (c) => edit((list) => (list[i] = { ...list[i], condition: c }))));
    });
    if (msgs.length || cb.wired) s.appendChild(addButton("+ Add message", () => edit((list) => list.push({ condition: { comparator: "<", constant: 0 } }))));
    return;
  }

  if (!cb.wired && !/lamp/.test(entity.name)) return;
  if (!cb.wired) {
    section("Circuit network").appendChild(el("div", "circuit-note", "Connect a red or green wire to control it from the circuit network."));
    return;
  }

  const s = section("Circuit network");
  const enabled = !!(behavior.circuit_enabled ?? behavior.circuit_enable_disable);
  s.appendChild(checkbox("Enable/disable", enabled, (on) => cb.commit((b) => {
    delete b.circuit_enable_disable;
    if (on) {
      b.circuit_enabled = true;
      b.circuit_condition ??= { comparator: ">", constant: 0 };
    } else delete b.circuit_enabled;
  })));
  if (enabled) s.appendChild(condition(behavior.circuit_condition, ["anything", "everything"], (c) => cb.commit((b) => (b.circuit_condition = c))));

  if (/lamp/.test(entity.name)) {
    s.appendChild(checkbox("Use colors", !!behavior.use_colors, (on) => cb.commit((b) => {
      if (on) b.use_colors = true;
      else delete b.use_colors;
    })));
    if (behavior.use_colors) s.appendChild(select([["0", "Color mapping"], ["1", "Components (RGB)"], ["2", "Packed RGB"]], String(behavior.color_mode ?? 0), (v) => cb.commit((b) => (b.color_mode = Number(v)))));
    return;
  }

  if (data.inserters[entity.name]) {
    s.appendChild(checkbox("Set filters", !!behavior.circuit_set_filters, (on) => cb.commit((b) => {
      if (on) b.circuit_set_filters = true;
      else delete b.circuit_set_filters;
    })));
    s.appendChild(checkbox("Read hand contents", !!behavior.circuit_read_hand_contents, (on) => cb.commit((b) => {
      if (on) b.circuit_read_hand_contents = true;
      else delete b.circuit_read_hand_contents;
    })));
    if (behavior.circuit_read_hand_contents) s.appendChild(select([["0", "Pulse"], ["1", "Hold"]], String(behavior.circuit_hand_read_mode ?? 0), (v) => cb.commit((b) => (b.circuit_hand_read_mode = Number(v)))));
    s.appendChild(checkbox("Set stack size", !!behavior.circuit_set_stack_size, (on) => cb.commit((b) => {
      if (on) b.circuit_set_stack_size = true;
      else delete b.circuit_set_stack_size;
    })));
    if (behavior.circuit_set_stack_size) {
      const row = el("div", "circuit-row");
      row.append(el("span", "circuit-label", "Stack size from"), signalSlot(behavior.stack_control_input_signal, [], (x) => cb.commit((b) => {
        if (x) b.stack_control_input_signal = x;
        else delete b.stack_control_input_signal;
      })));
      s.appendChild(row);
    }
    return;
  }

  if (data.belts[entity.name]) {
    s.appendChild(checkbox("Read belt contents", !!behavior.circuit_read_hand_contents, (on) => cb.commit((b) => {
      if (on) b.circuit_read_hand_contents = true;
      else delete b.circuit_read_hand_contents;
    })));
    if (behavior.circuit_read_hand_contents) s.appendChild(select([["0", "Pulse"], ["1", "Hold"], ["2", "Hold (all belts)"]], String(behavior.circuit_contents_read_mode ?? 0), (v) => cb.commit((b) => (b.circuit_contents_read_mode = Number(v)))));
    return;
  }

  if (data.machines[entity.name]) {
    s.appendChild(checkbox("Read contents", !!behavior.read_contents, (on) => cb.commit((b) => {
      if (on) b.read_contents = true;
      else delete b.read_contents;
    })));
    s.appendChild(checkbox("Read working", !!behavior.read_working, (on) => cb.commit((b) => {
      if (on) b.read_working = true;
      else delete b.read_working;
    })));
    if (behavior.read_working) {
      const row = el("div", "circuit-row");
      row.append(el("span", "circuit-label", "Signal"), signalSlot(behavior.working_signal ?? { type: "virtual", name: "signal-W" }, [], (x) => cb.commit((b) => {
        if (x) b.working_signal = x;
        else delete b.working_signal;
      })));
      s.appendChild(row);
    }
  }
}

const WILDCARD_NAMES: Record<string, Wildcards[number]> = { "signal-each": "each", "signal-anything": "anything", "signal-everything": "everything" };

/** The signal picker: every item, fluid and virtual signal, in the build
 *  menu's grid, with only the wildcards this slot allows. */
export function buildSignalMenu(container: HTMLElement, catalog: RenderCatalog, allow: Wildcards, onPick: (signal: BpSignalId) => void, onCancel: () => void): GridMenuHandle {
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
    onConfirm: ({ name }) => {
      const type = catalog.signals?.[name]?.type;
      onPick(type ? { type, name } : { name });
    },
    onCancel,
  });
}
