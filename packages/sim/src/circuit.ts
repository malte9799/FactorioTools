/** The circuit network, tick by tick: red and green wire networks built
 *  from a blueprint's wires, constant, arithmetic, decider and selector
 *  combinators, and the conditions buildings, lamps and display panels test
 *  against them.
 *
 *  Timing follows the game. Every tick each network carries the sum of what
 *  its members output that tick; a combinator's output is computed from what
 *  its input networks carried the tick before, so every combinator adds one
 *  tick of delay. A building (a belt reading its contents, an inserter its
 *  hand) hands its output in through setOutput(), and it shows up on the
 *  network at the next step().
 *
 *  Values are 32-bit signed integers and wrap like the game's. */
import type {
  BpArithmeticConditions,
  BpCircuitCondition,
  BpControlBehavior,
  BpDeciderCondition,
  BpDeciderOutput,
  BpNetworks,
  BpSignalId,
  PlacedEntity,
  WireLink,
} from "@factoriotools/engine";

/** Signal values by key (see signalKey). Zero values are never stored. */
export type Signals = Map<string, number>;

export type WireChannel = "red" | "green";

/** `type:name`, plus `@quality` for anything above normal. A blueprint
 *  leaves `type` off for items. */
export function signalKey(s: BpSignalId): string {
  const q = s.quality && s.quality !== "normal" ? `@${s.quality}` : "";
  return `${s.type ?? "item"}:${s.name}${q}`;
}

export function parseSignalKey(key: string): { type: string; name: string; quality?: string } {
  const colon = key.indexOf(":");
  const rest = key.slice(colon + 1);
  const at = rest.indexOf("@");
  return { type: key.slice(0, colon), name: at < 0 ? rest : rest.slice(0, at), quality: at < 0 ? undefined : rest.slice(at + 1) };
}

/** The three wildcards. They stand for other signals and never carry a
 *  value of their own on a network. */
export const EACH = "signal-each";
export const ANYTHING = "signal-anything";
export const EVERYTHING = "signal-everything";
const WILDCARDS = new Set([EACH, ANYTHING, EVERYTHING]);

const wildcard = (s: BpSignalId | undefined): string | undefined => (s?.name && WILDCARDS.has(s.name) ? s.name : undefined);

const add = (into: Signals, key: string, v: number) => {
  const sum = ((into.get(key) ?? 0) + v) | 0;
  if (sum === 0) into.delete(key);
  else into.set(key, sum);
};

/* ---------- arithmetic ---------- */

function pow(a: number, b: number): number {
  if (b < 0) return 0;
  let r = 1;
  let base = a | 0;
  let e = b;
  while (e > 0) {
    if (e & 1) r = Math.imul(r, base);
    base = Math.imul(base, base);
    e = Math.floor(e / 2);
  }
  return r;
}

/** One arithmetic operation, in 32-bit integers like the game. Division and
 *  modulo by zero give 0. */
export function arithmetic(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return (a + b) | 0;
    case "-": return (a - b) | 0;
    case "/": return b === 0 ? 0 : (a / b) | 0;
    case "%": return b === 0 ? 0 : (a % b) | 0;
    case "^": return pow(a, b);
    case "<<": return a << b;
    case ">>": return a >> b;
    case "AND": return a & b;
    case "OR": return a | b;
    case "XOR": return a ^ b;
    case "*":
    default: return Math.imul(a, b);
  }
}

/** One comparison. Both the 2.0 symbols (≥ ≤ ≠) and ASCII spellings are
 *  read; "<" is the game's default. */
export function compare(comparator: string | undefined, a: number, b: number): boolean {
  switch (comparator) {
    case ">": return a > b;
    case "=": case "==": return a === b;
    case "≥": case ">=": return a >= b;
    case "≤": case "<=": return a <= b;
    case "≠": case "!=": return a !== b;
    case "<":
    default: return a < b;
  }
}

/** A plain condition (enable/disable, lamp, display message) against one
 *  set of signals: both wires added together, as the game reads them.
 *
 *  - Everything: true when every signal present passes — so also when
 *    there are none at all.
 *  - Anything: true when at least one signal present passes.
 *  - Each isn't allowed in a plain condition; it reads as Anything.
 *  - No first signal set: never true. */
export function testCondition(cond: BpCircuitCondition | undefined, input: Signals): boolean {
  if (!cond?.first_signal?.name) return false;
  const right = cond.second_signal?.name ? (input.get(signalKey(cond.second_signal)) ?? 0) : (cond.constant ?? 0);
  const wild = wildcard(cond.first_signal);
  if (wild === EVERYTHING) {
    for (const v of input.values()) if (!compare(cond.comparator, v, right)) return false;
    return true;
  }
  if (wild) {
    for (const v of input.values()) if (compare(cond.comparator, v, right)) return true;
    return false;
  }
  return compare(cond.comparator, input.get(signalKey(cond.first_signal)) ?? 0, right);
}

/* ---------- networks ---------- */

export interface CircuitNetwork {
  id: number;
  color: WireChannel;
  /** What it carries this tick. */
  values: Signals;
  /** Connectors on it: entity number and side (1 = input or only, 2 = a
   *  combinator's output). */
  members: { entity: number; side: 1 | 2 }[];
}

export type CombinatorKind = "constant" | "arithmetic" | "decider" | "selector";

export function combinatorKind(name: string): CombinatorKind | undefined {
  if (name.includes("constant-combinator")) return "constant";
  if (name.includes("arithmetic-combinator")) return "arithmetic";
  if (name.includes("decider-combinator")) return "decider";
  if (name.includes("selector-combinator")) return "selector";
  return undefined;
}

export interface CircuitOptions {
  /** Stack sizes for the selector combinator's "stack size" mode. */
  stackSizeOf?: (item: string) => number | undefined;
  /** Seed for the selector combinator's random mode. */
  seed?: number;
}

interface Combinator {
  entity: PlacedEntity;
  kind: CombinatorKind;
  /** Output this tick. */
  out: Signals;
  /** Selector random mode: the pick and when it was made. */
  pick?: { key: string; tick: number };
}

/** What a lamp shows. */
export interface LampState {
  on: boolean;
  /** CSS colour when lit by a circuit colour or its own setting. */
  color?: string;
}

/** What a display panel shows: the first message whose condition holds. */
export interface DisplayState {
  icon?: BpSignalId;
  text?: string;
}

const LAMP_COLORS: [string, string][] = [
  ["signal-red", "#ff3030"],
  ["signal-green", "#30ff30"],
  ["signal-blue", "#3070ff"],
  ["signal-yellow", "#ffee30"],
  ["signal-pink", "#ff60ff"],
  ["signal-cyan", "#30ffff"],
  ["signal-white", "#ffffff"],
  ["signal-grey", "#9a9a9a"],
  ["signal-black", "#202020"],
];

const hex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");

export class CircuitSim {
  tick = 0;
  readonly networks: CircuitNetwork[] = [];
  readonly combinators: Combinator[] = [];
  private readonly byConnector = new Map<string, CircuitNetwork>();
  private readonly entities = new Map<number, PlacedEntity>();
  private readonly comboOf = new Map<number, Combinator>();
  /** What buildings put on their networks, by entity number. */
  private readonly outputs = new Map<number, Signals>();
  private rng: number;

  constructor(entities: PlacedEntity[], wires: WireLink[], private readonly options: CircuitOptions = {}) {
    this.rng = (options.seed ?? 0x9e3779b9) | 0 || 1;
    for (const e of entities) this.entities.set(e.entityNumber, e);
    // Union-find over connectors: entity, side, colour.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let p = parent.get(k) ?? k;
      if (p !== k) {
        p = find(p);
        parent.set(k, p);
      }
      return p;
    };
    const key = (n: number, side: 1 | 2, color: string) => `${n}:${side}:${color}`;
    const seen = new Set<string>();
    for (const w of wires) {
      if (w.color === "copper") continue;
      if (!this.entities.has(w.from) || !this.entities.has(w.to)) continue;
      const a = key(w.from, this.sideOf(w.from, w.fromSide), w.color);
      const b = key(w.to, this.sideOf(w.to, w.toSide), w.color);
      seen.add(a);
      seen.add(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const roots = new Map<string, CircuitNetwork>();
    for (const k of seen) {
      const root = find(k);
      let net = roots.get(root);
      const [n, side, color] = k.split(":");
      if (!net) {
        net = { id: this.networks.length, color: color as WireChannel, values: new Map(), members: [] };
        roots.set(root, net);
        this.networks.push(net);
      }
      net.members.push({ entity: Number(n), side: Number(side) as 1 | 2 });
      this.byConnector.set(k, net);
    }
    for (const e of entities) {
      const kind = combinatorKind(e.name);
      if (!kind) continue;
      const c: Combinator = { entity: e, kind, out: new Map() };
      this.combinators.push(c);
      this.comboOf.set(e.entityNumber, c);
    }
  }

  /** Only combinators that compute have a separate output side. */
  private sideOf(n: number, side: 1 | 2): 1 | 2 {
    const kind = combinatorKind(this.entities.get(n)?.name ?? "");
    return side === 2 && kind !== undefined && kind !== "constant" ? 2 : 1;
  }

  network(n: number, color: WireChannel, side: 1 | 2 = 1): CircuitNetwork | undefined {
    return this.byConnector.get(`${n}:${side}:${color}`);
  }

  /** True when any red or green wire reaches this entity. */
  isWired(n: number): boolean {
    return !!(this.network(n, "red") ?? this.network(n, "green") ?? this.network(n, "red", 2) ?? this.network(n, "green", 2));
  }

  /** Red and green inputs of an entity, as separate sets. */
  inputs(n: number, side: 1 | 2 = 1): { red: Signals; green: Signals } {
    return { red: this.network(n, "red", side)?.values ?? new Map(), green: this.network(n, "green", side)?.values ?? new Map() };
  }

  /** Both wires added together: what a building's condition sees. */
  merged(n: number, side: 1 | 2 = 1, nets: BpNetworks | undefined = undefined): Signals {
    const { red, green } = this.inputs(n, side);
    const out: Signals = new Map();
    if (nets?.red !== false) for (const [k, v] of red) add(out, k, v);
    if (nets?.green !== false) for (const [k, v] of green) add(out, k, v);
    return out;
  }

  /** What a building puts on its networks from now on (until changed). */
  setOutput(n: number, signals: Signals | undefined) {
    if (signals && signals.size) this.outputs.set(n, signals);
    else this.outputs.delete(n);
  }

  /** A combinator's current output, after the last step. */
  combinatorOutput(n: number): Signals | undefined {
    return this.comboOf.get(n)?.out;
  }

  step() {
    // Every combinator reads what the networks carried last tick, all at
    // once, so the order they're listed in never matters.
    const next = this.combinators.map((c) => this.compute(c));
    this.combinators.forEach((c, i) => (c.out = next[i]!));
    for (const net of this.networks) {
      const values: Signals = new Map();
      for (const m of net.members) {
        const c = this.comboOf.get(m.entity);
        // A constant combinator puts its signals on its only side; the
        // others on their output side.
        const src = c ? (c.kind === "constant" || m.side === 2 ? c.out : undefined) : this.outputs.get(m.entity);
        if (src) for (const [k, v] of src) add(values, k, v);
      }
      net.values = values;
    }
    this.tick++;
  }

  /** The generic enable/disable condition: undefined when the entity has
   *  none, or isn't wired (the game ignores the condition then). */
  enabled(n: number): boolean | undefined {
    const cb = this.entities.get(n)?.controlBehavior;
    if (!cb || !(cb.circuit_enabled ?? cb.circuit_enable_disable) || !this.isWired(n)) return undefined;
    return testCondition(cb.circuit_condition, this.merged(n));
  }

  /** Tests any condition against an entity's inputs. */
  test(n: number, cond: BpCircuitCondition | undefined): boolean {
    return testCondition(cond, this.merged(n));
  }

  /** Whether one decider row holds on its own, as the game lights it in
   *  the GUI: with Each or Anything, when any input signal passes; with
   *  Everything, when all do. */
  rowHolds(n: number, cond: BpDeciderCondition): boolean {
    if (!cond.first_signal?.name) return false;
    const left = this.merged(n, 1, cond.first_signal_networks);
    const right = cond.second_signal?.name && !wildcard(cond.second_signal) ? (this.merged(n, 1, cond.second_signal_networks).get(signalKey(cond.second_signal)) ?? 0) : (cond.constant ?? 0);
    const wild = wildcard(cond.first_signal);
    if (wild === EVERYTHING) {
      for (const v of left.values()) if (!compare(cond.comparator, v, right)) return false;
      return true;
    }
    if (wild) {
      for (const [k, v] of left) {
        const r = wildcard(cond.second_signal) === EACH ? (this.merged(n, 1, cond.second_signal_networks).get(k) ?? 0) : right;
        if (compare(cond.comparator, v, r)) return true;
      }
      return false;
    }
    return compare(cond.comparator, left.get(signalKey(cond.first_signal)) ?? 0, right);
  }

  lamp(n: number): LampState {
    const e = this.entities.get(n);
    const cb = e?.controlBehavior;
    const own = e?.color ? `#${hex((e.color.r ?? 1) * 255)}${hex((e.color.g ?? 1) * 255)}${hex((e.color.b ?? 1) * 255)}` : undefined;
    if (!cb || !this.isWired(n)) return { on: true, color: own };
    // In 2.0 a lamp has an Enable/disable box like any building; one from
    // a blueprint that sets a condition without it still uses it.
    const gated = cb.circuit_enabled ?? cb.circuit_enable_disable ?? !!cb.circuit_condition;
    const input = this.merged(n);
    const on = gated ? testCondition(cb.circuit_condition, input) : true;
    if (!cb.use_colors) return { on, color: own };
    const mode = cb.color_mode ?? 0;
    if (mode === 1) {
      const v = (name: string) => input.get(`virtual:${name}`) ?? 0;
      return { on, color: `#${hex(v("signal-red"))}${hex(v("signal-green"))}${hex(v("signal-blue"))}` };
    }
    if (mode === 2) {
      const packed = input.get("virtual:signal-white") ?? 0;
      return { on, color: `#${hex(packed >> 16)}${hex(packed >> 8)}${hex(packed)}` };
    }
    const found = LAMP_COLORS.find(([name]) => (input.get(`virtual:${name}`) ?? 0) > 0);
    return { on, color: found?.[1] ?? own };
  }

  display(n: number): DisplayState | undefined {
    const e = this.entities.get(n);
    if (!e) return undefined;
    const messages = e.controlBehavior?.parameters ?? [];
    if (this.isWired(n) && messages.length) {
      const input = this.merged(n);
      const shown = messages.find((m) => testCondition(m.condition, input));
      return shown ? { icon: shown.icon, text: shown.text } : undefined;
    }
    if (e.panel?.icon || e.panel?.text) return { icon: e.panel.icon, text: e.panel.text };
    const first = messages[0];
    return first ? { icon: first.icon, text: first.text } : undefined;
  }

  /* ---------- combinators ---------- */

  private compute(c: Combinator): Signals {
    const cb = c.entity.controlBehavior ?? {};
    switch (c.kind) {
      case "constant": return this.constant(cb);
      case "arithmetic": return cb.arithmetic_conditions ? this.arithmeticOut(c, cb.arithmetic_conditions) : new Map();
      case "decider": return this.deciderOut(c, cb.decider_conditions?.conditions ?? [], cb.decider_conditions?.outputs ?? []);
      case "selector": return this.selectorOut(c, cb);
    }
  }

  private constant(cb: BpControlBehavior): Signals {
    const out: Signals = new Map();
    if (cb.is_on === false) return out;
    for (const section of cb.sections?.sections ?? []) {
      if (section.active === false) continue;
      const mult = typeof section.multiplier === "number" ? section.multiplier : 1;
      for (const f of section.filters ?? []) {
        if (!f.name || WILDCARDS.has(f.name)) continue;
        add(out, signalKey(f), Math.imul(f.count ?? 0, mult | 0));
      }
    }
    return out;
  }

  private arithmeticOut(c: Combinator, a: BpArithmeticConditions): Signals {
    const out: Signals = new Map();
    const n = c.entity.entityNumber;
    const op = a.operation ?? "*";
    const left = this.merged(n, 1, a.first_signal_networks);
    const right = this.merged(n, 1, a.second_signal_networks);
    const outWild = wildcard(a.output_signal);
    const second = (k?: string) => {
      if (a.second_signal?.name) return wildcard(a.second_signal) === EACH && k ? (right.get(k) ?? 0) : right.get(signalKey(a.second_signal)) ?? 0;
      return a.second_constant ?? 0;
    };
    if (wildcard(a.first_signal) === EACH) {
      // Each: the operation runs once per input signal; with Each as the
      // output too every result keeps its own signal, otherwise they're
      // added together onto the one output signal.
      for (const [k, v] of left) {
        const r = arithmetic(op, v, second(k));
        if (outWild === EACH) add(out, k, r);
        else if (a.output_signal?.name && !outWild) add(out, signalKey(a.output_signal), r);
      }
      return out;
    }
    let first: number;
    if (a.first_signal?.name && !wildcard(a.first_signal)) first = left.get(signalKey(a.first_signal)) ?? 0;
    else if (a.first_constant !== undefined) first = a.first_constant;
    else return out;
    if (!a.output_signal?.name || outWild) return out;
    add(out, signalKey(a.output_signal), arithmetic(op, first, second()));
    return out;
  }

  /** A 2.0 decider. Rows joined by AND bind tighter than rows joined by OR.
   *
   *  - Everything on the left: every input signal passes (true with none).
   *  - Anything: at least one passes; Anything as an output then gives the
   *    signal that did.
   *  - Each: the whole set of rows is tested once per input signal, with
   *    Each standing for that signal. Each as an output gives every signal
   *    that passed; a named output gives its count (or the constant) once
   *    per signal that passed, added up. */
  private deciderOut(c: Combinator, conds: BpDeciderCondition[], outputs: BpDeciderOutput[]): Signals {
    const n = c.entity.entityNumber;
    const out: Signals = new Map();
    const nets = new Map<BpNetworks | undefined, Signals>();
    const read = (net: BpNetworks | undefined) => {
      let s = nets.get(net);
      if (!s) nets.set(net, (s = this.merged(n, 1, net)));
      return s;
    };
    const groups: BpDeciderCondition[][] = [];
    conds.forEach((cond, i) => {
      if (i === 0 || cond.compare_type !== "and") groups.push([cond]);
      else groups[groups.length - 1]!.push(cond);
    });
    let matched: string | undefined;
    const row = (cond: BpDeciderCondition, each?: string): boolean => {
      if (!cond.first_signal?.name) return false;
      const left = read(cond.first_signal_networks);
      const right = cond.second_signal?.name
        ? wildcard(cond.second_signal) === EACH && each ? (read(cond.second_signal_networks).get(each) ?? 0) : (read(cond.second_signal_networks).get(signalKey(cond.second_signal)) ?? 0)
        : (cond.constant ?? 0);
      const wild = wildcard(cond.first_signal);
      if (wild === EACH) return each !== undefined && compare(cond.comparator, left.get(each) ?? 0, right);
      if (wild === EVERYTHING) {
        for (const v of left.values()) if (!compare(cond.comparator, v, right)) return false;
        return true;
      }
      if (wild === ANYTHING) {
        for (const [k, v] of left) {
          if (compare(cond.comparator, v, right)) {
            matched ??= k;
            return true;
          }
        }
        return false;
      }
      return compare(cond.comparator, left.get(signalKey(cond.first_signal)) ?? 0, right);
    };
    // No rows at all is never true.
    const holds = (each?: string) => groups.some((g) => g.every((cond) => row(cond, each)));

    const usesEach = conds.some((cond) => wildcard(cond.first_signal) === EACH);
    const value = (o: BpDeciderOutput, key: string) => (o.copy_count_from_input === false ? (o.constant ?? 1) : (read(o.networks).get(key) ?? 0));
    const emitAll = (o: BpDeciderOutput) => {
      for (const k of read(o.networks).keys()) add(out, k, value(o, k));
    };

    if (usesEach) {
      const candidates = new Set<string>();
      for (const cond of conds) if (wildcard(cond.first_signal) === EACH) for (const k of read(cond.first_signal_networks).keys()) candidates.add(k);
      const passed = [...candidates].filter((k) => holds(k));
      if (!passed.length) return out;
      for (const o of outputs) {
        const w = wildcard(o.signal);
        if (!o.signal?.name) continue;
        if (w === EACH) for (const k of passed) add(out, k, value(o, k));
        else if (w === EVERYTHING) emitAll(o);
        else if (w === ANYTHING) add(out, passed[0]!, value(o, passed[0]!));
        else {
          const key = signalKey(o.signal);
          // Copying the count adds up the inputs of every signal that
          // passed; a constant counts them.
          for (const k of passed) add(out, key, o.copy_count_from_input === false ? (o.constant ?? 1) : (read(o.networks).get(k) ?? 0));
        }
      }
      return out;
    }

    if (!holds()) return out;
    for (const o of outputs) {
      if (!o.signal?.name) continue;
      const w = wildcard(o.signal);
      if (w === EVERYTHING || w === EACH) emitAll(o);
      else if (w === ANYTHING) {
        const k = matched ?? read(o.networks).keys().next().value;
        if (k !== undefined) add(out, k, value(o, k));
      } else add(out, signalKey(o.signal), value(o, signalKey(o.signal)));
    }
    return out;
  }

  private random(): number {
    // xorshift32: deterministic, so a rebuilt model replays the same picks.
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x | 0;
    return (x >>> 0) / 4294967296;
  }

  /** The selector combinator's modes the lab can run: select by index,
   *  count, random and stack size. Quality modes and rocket capacity
   *  output nothing. */
  private selectorOut(c: Combinator, cb: BpControlBehavior): Signals {
    const n = c.entity.entityNumber;
    const input = this.merged(n);
    const out: Signals = new Map();
    switch (cb.operation ?? "select") {
      case "select": {
        const max = cb.select_max ?? true;
        const sorted = [...input].sort((a, b) => (max ? b[1] - a[1] : a[1] - b[1]) || (a[0] < b[0] ? -1 : 1));
        const index = cb.index_signal?.name ? (input.get(signalKey(cb.index_signal)) ?? 0) : (cb.index_constant ?? 0);
        const hit = sorted[index];
        if (hit) out.set(hit[0], hit[1]);
        return out;
      }
      case "count": {
        if (cb.count_signal?.name && !wildcard(cb.count_signal)) add(out, signalKey(cb.count_signal), input.size);
        return out;
      }
      case "random": {
        const every = Math.max(1, cb.random_update_interval ?? 1);
        if (!c.pick || this.tick - c.pick.tick >= every || !input.has(c.pick.key)) {
          const keys = [...input.keys()];
          c.pick = keys.length ? { key: keys[Math.floor(this.random() * keys.length)]!, tick: this.tick } : undefined;
        }
        if (c.pick) out.set(c.pick.key, input.get(c.pick.key)!);
        return out;
      }
      case "stack-size": {
        for (const k of input.keys()) {
          const s = parseSignalKey(k);
          const size = s.type === "item" ? this.options.stackSizeOf?.(s.name) : undefined;
          if (size) add(out, k, size);
        }
        return out;
      }
      default:
        return out;
    }
  }
}
