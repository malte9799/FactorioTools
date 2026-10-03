/** Compiles noise-expression source into a flat, deduplicated operation graph.
 *
 *  Name lookup follows the game: innermost local expressions, functions and
 *  parameters first, then `property_expression_names`, then named prototypes,
 *  then built-ins. Functions are inlined at each call; identical operations
 *  are merged, so `elevation` shared by twenty tile expressions is one node. */
import { parseExpression, type Ast, type BinOp } from "./parser.js";
import { BINARY_KERNELS, FOLD_KERNELS, TERNARY_KERNELS, UNARY_KERNELS, type BinaryOp, type TernaryOp, type UnaryOp } from "./kernels.js";

export type ExprSource = string | number | boolean;

export interface LocalDefs {
  local_expressions?: Record<string, ExprSource>;
  local_functions?: Record<string, FnDef>;
}
export interface ExprDef extends LocalDefs {
  expression: ExprSource;
}
export interface FnDef extends LocalDefs {
  parameters: string[];
  expression: ExprSource;
}

export interface AutoplaceDef extends LocalDefs {
  probability_expression?: ExprSource;
  richness_expression?: ExprSource;
}

export interface NoiseSource {
  expressions: Record<string, ExprDef>;
  functions: Record<string, FnDef>;
  /** Autoplace specifications, reachable as `entity:iron-ore:probability`. */
  autoplace?: Record<string, Record<string, AutoplaceDef>>;
}

export interface CompileSettings {
  seed: number;
  /** Named numeric constants: `control:iron-ore:size`, `starting_area_radius`, ... */
  constants: Record<string, number>;
  propertyExpressionNames: Record<string, string>;
  startingPositions: [number, number][];
  startingLakePositions: [number, number][];
}

export type Op =
  | "const" | "x" | "y"
  | UnaryOp | BinaryOp | TernaryOp
  | "basis" | "multioctave" | "vpm" | "quick" | "random_penalty" | "spot"
  | "nearest" | "expression_in_range" | "multisample" | "terrace" | "voronoi";

export interface Node {
  op: Op;
  args: number[];
  /** Constant parameters; the value itself for `const`. */
  p?: any;
}

type Val =
  | { k: "n"; id: number }
  | { k: "s"; v: string }
  | { k: "pts"; v: [number, number][] };

interface Scope {
  vars: Map<string, Val>;
  defs: LocalDefs;
  /** Compiled local expressions, so each is built once per scope instance. */
  cache: Map<string, Val>;
  parent: Scope | null;
}

const f = Math.fround;

const BUILTIN_CONSTANTS: Record<string, number> = { true: 1, false: 0, e: Math.E, pi: Math.PI, inf: Infinity };

/** Parameter order (and defaults) of every built-in, for positional calls. */
const SIGNATURES: Record<string, { params: string[]; defaults?: Record<string, number> }> = {
  abs: { params: ["value"] },
  atan2: { params: ["y", "x"] },
  ceil: { params: ["value"] },
  clamp: { params: ["value", "min", "max"] },
  cos: { params: ["value"] },
  floor: { params: ["value"] },
  if: { params: ["condition", "true_branch", "false_branch"] },
  log2: { params: ["value"] },
  pow: { params: ["value", "exponent"] },
  pow_precise: { params: ["value", "exponent"] },
  ridge: { params: ["value", "min", "max"] },
  sin: { params: ["value"] },
  sqrt: { params: ["value"] },
  terrace: { params: ["value", "strength", "offset", "width"] },
  basis_noise: {
    params: ["x", "y", "seed0", "seed1", "input_scale", "output_scale", "offset_x", "offset_y"],
    defaults: { input_scale: 1, output_scale: 1, offset_x: 0, offset_y: 0 },
  },
  multioctave_noise: {
    params: ["x", "y", "persistence", "seed0", "seed1", "octaves", "input_scale", "output_scale", "offset_x", "offset_y"],
    defaults: { input_scale: 1, output_scale: 1, offset_x: 0, offset_y: 0 },
  },
  variable_persistence_multioctave_noise: {
    params: ["x", "y", "persistence", "seed0", "seed1", "octaves", "input_scale", "output_scale", "offset_x", "offset_y"],
    defaults: { input_scale: 1, output_scale: 1, offset_x: 0, offset_y: 0 },
  },
  quick_multioctave_noise: {
    params: [
      "x", "y", "seed0", "seed1", "octaves", "input_scale", "output_scale", "offset_x", "offset_y",
      "octave_input_scale_multiplier", "octave_output_scale_multiplier", "octave_seed0_shift",
    ],
    defaults: {
      input_scale: 1, output_scale: 1, offset_x: 0, offset_y: 0,
      octave_input_scale_multiplier: 0.5, octave_output_scale_multiplier: 2, octave_seed0_shift: 1,
    },
  },
  random_penalty: { params: ["x", "y", "source", "seed", "amplitude"], defaults: { seed: 1, amplitude: 1 } },
  distance_from_nearest_point: { params: ["x", "y", "points", "maximum_distance"], defaults: { maximum_distance: Infinity } },
  distance_from_nearest_point_x: { params: ["x", "y", "points"] },
  distance_from_nearest_point_y: { params: ["x", "y", "points"] },
  multisample: { params: ["expression", "offset_x", "offset_y"] },
  noise_layer_id: { params: ["value"] },
  var: { params: ["value"] },
  spot_noise: {
    params: [
      "x", "y", "density_expression", "spot_quantity_expression", "spot_radius_expression", "spot_favorability_expression",
      "seed0", "seed1", "basement_value", "maximum_spot_basement_radius", "region_size", "skip_offset", "skip_span",
      "hard_region_target_quantity", "candidate_point_count", "candidate_spot_count", "suggested_minimum_candidate_point_spacing",
    ],
    defaults: { region_size: 512, skip_offset: 0, skip_span: 1, hard_region_target_quantity: 1 },
  },
  voronoi_spot_noise: { params: ["x", "y", "seed0", "seed1", "grid_size", "distance_type", "jitter"], defaults: { jitter: 0.5 } },
  voronoi_facet_noise: { params: ["x", "y", "seed0", "seed1", "grid_size", "distance_type", "jitter"], defaults: { jitter: 0.5 } },
  voronoi_pyramid_noise: { params: ["x", "y", "seed0", "seed1", "grid_size", "distance_type", "jitter"], defaults: { jitter: 0.5 } },
  voronoi_cell_id: { params: ["x", "y", "seed0", "seed1", "grid_size", "distance_type", "jitter"], defaults: { jitter: 0.5 } },
};

const UNARY_FUNCTIONS: Record<string, UnaryOp> = { abs: "abs", ceil: "ceil", cos: "cos", floor: "floor", log2: "log2", sin: "sin", sqrt: "sqrt" };
const BINARY_OPERATORS: Record<BinOp, BinaryOp> = {
  "^": "pow", "*": "mul", "/": "div", "%": "mod", "%%": "rem", "+": "add", "-": "sub",
  "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "==": "eq", "~=": "ne", "&": "band", "~": "bxor", "|": "bor",
};
const COMMUTATIVE = new Set<Op>(["add", "mul", "min", "max", "eq", "ne", "band", "bxor", "bor"]);
const DISTANCE_TYPES: Record<string, number> = { chebyshev: 0, manhattan: 1, euclidean: 2, minkowski3: 3 };

/** CRC32 (IEEE), used to turn a string noise-layer name into a number. */
export function crc32(s: string): number {
  let crc = ~0;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export class Program {
  readonly nodes: Node[] = [];
  private readonly index = new Map<string, number>();
  private readonly globals = new Map<string, Val>();
  private readonly asts = new Map<string, Ast>();
  /** Named expressions currently being compiled, to report recursion. */
  private readonly active = new Set<string>();

  constructor(
    readonly source: NoiseSource,
    readonly settings: CompileSettings,
  ) {}

  /** Compile a named noise expression and return its node. */
  named(name: string): number {
    return this.number(this.global(name), name);
  }

  /** Compile an anonymous expression (an autoplace probability, say). */
  expression(def: ExprDef): number {
    const scope: Scope = { vars: new Map(), defs: def, cache: new Map(), parent: null };
    return this.number(this.compileSource(def.expression, scope), "expression");
  }

  /** A constant node. It keeps the full double of a literal; arithmetic sees
   *  it rounded to single precision (see `constantOf`). */
  constant(value: number): number {
    return this.intern({ op: "const", args: [], p: value });
  }

  /** The value of a constant node as the game's float arithmetic sees it. */
  constantOf(id: number): number | undefined {
    const n = this.nodes[id]!;
    return n.op === "const" ? f(n.p as number) : undefined;
  }

  private intern(node: Node): number {
    const key = `${node.op}|${node.args.join(",")}|${node.p === undefined ? "" : JSON.stringify(node.p, (_k, v) => (v === Infinity ? "inf" : v === -Infinity ? "-inf" : v))}`;
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;
    const id = this.nodes.length;
    this.nodes.push(node);
    this.index.set(key, id);
    return id;
  }

  private number(v: Val, what: string): number {
    if (v.k !== "n") throw new Error(`${what} is not a number`);
    return v.id;
  }

  private parse(src: string): Ast {
    let ast = this.asts.get(src);
    if (!ast) {
      ast = parseExpression(src);
      this.asts.set(src, ast);
    }
    return ast;
  }

  private compileSource(src: ExprSource, scope: Scope): Val {
    if (typeof src === "number") return { k: "n", id: this.constant(src) };
    if (typeof src === "boolean") return { k: "n", id: this.constant(src ? 1 : 0) };
    return this.compile(this.parse(src), scope);
  }

  /** A named expression or map-gen constant, outside any local scope. */
  private global(name: string): Val {
    const hit = this.globals.get(name);
    if (hit) return hit;
    const v = this.resolveGlobal(name);
    this.globals.set(name, v);
    return v;
  }

  private resolveGlobal(name: string): Val {
    const override = this.settings.propertyExpressionNames[name];
    const target = override ?? name;
    const def = this.source.expressions[target];
    if (def) {
      if (this.active.has(target)) throw new Error(`recursive noise expression '${target}'`);
      this.active.add(target);
      const scope: Scope = { vars: new Map(), defs: def, cache: new Map(), parent: null };
      const v = this.compileSource(def.expression, scope);
      this.active.delete(target);
      return v;
    }
    const autoplace = /^(tile|entity|decorative):(.+):(probability|richness)$/.exec(target);
    if (autoplace) {
      const spec = this.source.autoplace?.[autoplace[1]!]?.[autoplace[2]!];
      if (!spec) throw new Error(`no autoplace for '${target}'`);
      const src = autoplace[3] === "probability" ? spec.probability_expression : spec.richness_expression;
      const scope: Scope = { vars: new Map(), defs: spec, cache: new Map(), parent: null };
      return this.compileSource(src ?? (autoplace[3] === "probability" ? 0 : 1), scope);
    }
    if (override !== undefined && !Number.isNaN(Number(override))) return { k: "n", id: this.constant(Number(override)) };
    if (name === "x" || name === "y") return { k: "n", id: this.intern({ op: name, args: [] }) };
    if (name === "map_seed") return { k: "n", id: this.constant(this.settings.seed >>> 0) };
    if (name === "map_seed_small") return { k: "n", id: this.constant(this.settings.seed & 0xffff) };
    if (name === "map_seed_normalized") return { k: "n", id: this.constant((this.settings.seed >>> 0) / 4294967295) };
    if (name === "starting_positions") return { k: "pts", v: this.settings.startingPositions };
    if (name === "starting_lake_positions") return { k: "pts", v: this.settings.startingLakePositions };
    const setting = this.settings.constants[name];
    if (setting !== undefined) return { k: "n", id: this.constant(setting) };
    const builtin = BUILTIN_CONSTANTS[name];
    if (builtin !== undefined) return { k: "n", id: this.constant(builtin) };
    throw new Error(`unknown noise variable '${name}'`);
  }

  private lookup(name: string, scope: Scope | null): Val {
    for (let s = scope; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
      const cached = s.cache.get(name);
      if (cached) return cached;
      const local = s.defs.local_expressions?.[name];
      if (local !== undefined) {
        const compiled = this.compileSource(local, s);
        s.cache.set(name, compiled);
        return compiled;
      }
    }
    return this.global(name);
  }

  private findFunction(name: string, scope: Scope | null): { def: FnDef; home: Scope | null } | undefined {
    for (let s = scope; s; s = s.parent) {
      const def = s.defs.local_functions?.[name];
      if (def) return { def, home: s };
    }
    const def = this.source.functions[name];
    return def ? { def, home: null } : undefined;
  }

  private compile(ast: Ast, scope: Scope): Val {
    switch (ast.t) {
      case "num":
        return { k: "n", id: this.constant(ast.v) };
      case "str":
        return { k: "s", v: ast.v };
      case "id":
        return this.lookup(ast.name, scope);
      case "un": {
        const a = this.number(this.compile(ast.a, scope), "operand");
        if (ast.op === "+") return { k: "n", id: a };
        return { k: "n", id: this.unary(ast.op === "-" ? "neg" : "bnot", a) };
      }
      case "bin": {
        const a = this.number(this.compile(ast.a, scope), "operand");
        const b = this.number(this.compile(ast.b, scope), "operand");
        return { k: "n", id: this.binary(BINARY_OPERATORS[ast.op], a, b) };
      }
      case "call":
        return this.call(ast, scope);
    }
  }

  private unary(op: UnaryOp, a: number): number {
    const c = this.constantOf(a);
    if (c !== undefined) return this.constant(UNARY_KERNELS[op](c));
    return this.intern({ op, args: [a] });
  }

  private binary(op: BinaryOp, a: number, b: number): number {
    const ca = this.constantOf(a);
    const cb = this.constantOf(b);
    if (ca !== undefined && cb !== undefined) return this.constant((FOLD_KERNELS[op] ?? BINARY_KERNELS[op])(ca, cb));
    const args = COMMUTATIVE.has(op) && a > b ? [b, a] : [a, b];
    return this.intern({ op, args });
  }

  private ternary(op: TernaryOp, a: number, b: number, c: number): number {
    const ca = this.constantOf(a);
    const cb = this.constantOf(b);
    const cc = this.constantOf(c);
    if (ca !== undefined && cb !== undefined && cc !== undefined) return this.constant(TERNARY_KERNELS[op](ca, cb, cc));
    // A constant condition picks its branch now, so the other one (a whole
    // starting-patch set for a resource that has none) is never evaluated.
    if (op === "if" && ca !== undefined) return ca > 0 ? b : c;
    return this.intern({ op, args: [a, b, c] });
  }

  private call(ast: Extract<Ast, { t: "call" }>, scope: Scope): Val {
    const { name } = ast;

    const user = this.findFunction(name, scope);
    if (user) {
      const { def, home } = user;
      const vars = new Map<string, Val>();
      if (ast.pos) {
        if (ast.pos.length !== def.parameters.length) throw new Error(`'${name}' expects ${def.parameters.length} arguments`);
        ast.pos.forEach((arg, i) => vars.set(def.parameters[i]!, this.compile(arg, scope)));
      } else {
        for (const param of def.parameters) {
          const arg = ast.named![param];
          if (!arg) throw new Error(`'${name}' is missing argument '${param}'`);
          vars.set(param, this.compile(arg, scope));
        }
      }
      return this.compileSource(def.expression, { vars, defs: def, cache: new Map(), parent: home });
    }

    if (name === "min" || name === "max") {
      const ids = (ast.pos ?? Object.values(ast.named ?? {})).map((a) => this.number(this.compile(a, scope), name));
      if (ids.length < 1) throw new Error(`'${name}' needs arguments`);
      let acc = ids[0]!;
      for (let i = 1; i < ids.length; i++) acc = this.binary(name, acc, ids[i]!);
      return { k: "n", id: acc };
    }

    if (name === "expression_in_range") return this.expressionInRange(ast, scope);

    const sig = SIGNATURES[name];
    if (!sig) throw new Error(`unknown noise function '${name}'`);
    const args = new Map<string, Val>();
    if (ast.pos) {
      ast.pos.forEach((arg, i) => {
        const param = sig.params[i];
        if (!param) throw new Error(`too many arguments to '${name}'`);
        args.set(param, this.compile(arg, scope));
      });
    } else {
      for (const [param, arg] of Object.entries(ast.named!)) {
        if (!sig.params.includes(param)) throw new Error(`'${name}' has no parameter '${param}'`);
        args.set(param, this.compile(arg, scope));
      }
    }

    const has = (p: string): boolean => args.has(p);
    const node = (p: string): number => {
      const v = args.get(p);
      if (v) return this.number(v, `${name}.${p}`);
      const d = sig.defaults?.[p];
      if (d === undefined) throw new Error(`'${name}' is missing argument '${p}'`);
      return this.constant(d);
    };
    const num = (p: string): number => {
      const c = this.constantOf(node(p));
      if (c === undefined) throw new Error(`'${name}.${p}' must be constant`);
      return c;
    };
    /** An integer parameter. Unlike arithmetic, these read the constant at
     *  full precision: a map seed above 2^24 is not rounded to a float. */
    const int = (p: string): number => {
      const id = node(p);
      if (this.constantOf(id) === undefined) throw new Error(`'${name}.${p}' must be constant`);
      return Math.trunc(this.nodes[id]!.p as number);
    };
    /** A noise layer: a number, or a string hashed to one. */
    const layer = (p: string): number => {
      const v = args.get(p);
      if (v?.k === "s") return crc32(v.v);
      return int(p);
    };
    /** `seed1` above 255 spills into `seed0`: its low byte picks the layer,
     *  the rest moves the seed. */
    const seeds = (): { seed0: number; seed1: number } => {
      const raw1 = layer("seed1") >>> 0;
      const seed0 = (int("seed0") + 7 * (raw1 >>> 8)) >>> 0;
      return { seed0, seed1: raw1 & 255 };
    };

    const unaryOp = UNARY_FUNCTIONS[name];
    if (unaryOp) return { k: "n", id: this.unary(unaryOp, node("value")) };

    switch (name) {
      case "var": {
        const v = args.get("value");
        if (v?.k !== "s") throw new Error("var() expects a string");
        return this.lookup(v.v, scope);
      }
      case "noise_layer_id": {
        const v = args.get("value");
        if (v?.k !== "s") throw new Error("noise_layer_id() expects a string");
        return { k: "n", id: this.constant(crc32(v.v)) };
      }
      case "atan2":
        return { k: "n", id: this.binary("atan2", node("y"), node("x")) };
      case "pow":
        return { k: "n", id: this.binary("pow", node("value"), node("exponent")) };
      case "pow_precise":
        return { k: "n", id: this.binary("pow_precise", node("value"), node("exponent")) };
      case "clamp":
        return { k: "n", id: this.ternary("clamp", node("value"), node("min"), node("max")) };
      case "ridge":
        return { k: "n", id: this.ternary("ridge", node("value"), node("min"), node("max")) };
      case "if":
        return { k: "n", id: this.ternary("if", node("condition"), node("true_branch"), node("false_branch")) };
      case "terrace":
        return {
          k: "n",
          id: this.intern({ op: "terrace", args: [node("value"), node("strength")], p: { offset: num("offset"), width: num("width") } }),
        };
      case "basis_noise":
        return {
          k: "n",
          id: this.intern({
            op: "basis",
            args: [node("x"), node("y")],
            p: { ...seeds(), inputScale: num("input_scale"), outputScale: num("output_scale"), offsetX: num("offset_x"), offsetY: num("offset_y") },
          }),
        };
      case "multioctave_noise":
        return {
          k: "n",
          id: this.intern({
            op: "multioctave",
            args: [node("x"), node("y")],
            p: {
              ...seeds(), octaves: int("octaves"), persistence: num("persistence"),
              inputScale: num("input_scale"), outputScale: num("output_scale"), offsetX: num("offset_x"), offsetY: num("offset_y"),
            },
          }),
        };
      case "variable_persistence_multioctave_noise":
        return {
          k: "n",
          id: this.intern({
            op: "vpm",
            args: [node("x"), node("y"), node("persistence")],
            p: {
              ...seeds(), octaves: int("octaves"),
              inputScale: num("input_scale"), outputScale: num("output_scale"), offsetX: num("offset_x"), offsetY: num("offset_y"),
            },
          }),
        };
      case "quick_multioctave_noise":
        return {
          k: "n",
          id: this.intern({
            op: "quick",
            args: [node("x"), node("y")],
            p: {
              ...seeds(), octaves: int("octaves"), seedShift: int("octave_seed0_shift"),
              inputScale: num("input_scale"), outputScale: num("output_scale"), offsetX: num("offset_x"), offsetY: num("offset_y"),
              inputScaleMultiplier: num("octave_input_scale_multiplier"), outputScaleMultiplier: num("octave_output_scale_multiplier"),
            },
          }),
        };
      case "random_penalty":
        return {
          k: "n",
          id: this.intern({ op: "random_penalty", args: [node("x"), node("y"), node("source")], p: { seed: int("seed"), amplitude: num("amplitude") } }),
        };
      case "distance_from_nearest_point":
      case "distance_from_nearest_point_x":
      case "distance_from_nearest_point_y": {
        const pts = args.get("points");
        if (pts?.k !== "pts") throw new Error(`${name} expects a position list`);
        const mode = name.endsWith("_x") ? 1 : name.endsWith("_y") ? 2 : 0;
        const max = mode === 0 ? num("maximum_distance") : Infinity;
        return { k: "n", id: this.intern({ op: "nearest", args: [node("x"), node("y")], p: { mode, points: pts.v, max } }) };
      }
      case "multisample":
        return {
          k: "n",
          id: this.intern({ op: "multisample", args: [], p: { expr: node("expression"), offsetX: int("offset_x"), offsetY: int("offset_y") } }),
        };
      case "spot_noise": {
        const span = int("skip_span");
        const regionSize = int("region_size");
        const spotCount = has("candidate_spot_count")
          ? int("candidate_spot_count")
          : Math.trunc((has("candidate_point_count") ? num("candidate_point_count") : 256) / span);
        // Unless told otherwise, points keep half the average distance
        // between candidates apart.
        const spacing = has("suggested_minimum_candidate_point_spacing")
          ? num("suggested_minimum_candidate_point_spacing")
          : regionSize / Math.sqrt(spotCount * span) / 2;
        return {
          k: "n",
          id: this.intern({
            op: "spot",
            args: [node("x"), node("y")],
            p: {
              density: node("density_expression"),
              quantity: node("spot_quantity_expression"),
              radius: node("spot_radius_expression"),
              favorability: node("spot_favorability_expression"),
              seed0: int("seed0") >>> 0,
              seed1: layer("seed1") >>> 0,
              basement: num("basement_value"),
              maxRadius: num("maximum_spot_basement_radius"),
              regionSize,
              skipOffset: int("skip_offset"),
              skipSpan: span,
              hardTarget: num("hard_region_target_quantity") > 0,
              spotCount,
              spacing,
            },
          }),
        };
      }
      case "voronoi_spot_noise":
      case "voronoi_facet_noise":
      case "voronoi_pyramid_noise":
      case "voronoi_cell_id": {
        const dt = args.get("distance_type");
        const distanceType = dt?.k === "s" ? DISTANCE_TYPES[dt.v] : num("distance_type");
        if (distanceType === undefined) throw new Error(`unknown distance_type in ${name}`);
        return {
          k: "n",
          id: this.intern({
            op: "voronoi",
            args: [node("x"), node("y")],
            p: {
              kind: name.slice("voronoi_".length),
              // The layer is added to the seed, not mixed in as elsewhere.
              seed: (int("seed0") + layer("seed1")) >>> 0,
              gridSize: Math.max(0, Math.min(65535, int("grid_size"))),
              distanceType,
              jitter: Math.fround(num("jitter")),
            },
          }),
        };
      }
    }
    throw new Error(`noise function '${name}' is not implemented`);
  }

  /** `expression_in_range(multiplier, maximum, e1..en, from1..fromn, to1..ton)`. */
  private expressionInRange(ast: Extract<Ast, { t: "call" }>, scope: Scope): Val {
    if (!ast.pos || ast.pos.length < 5 || (ast.pos.length - 2) % 3 !== 0) throw new Error("expression_in_range takes 2 + 3n positional arguments");
    const ids = ast.pos.map((a) => this.number(this.compile(a, scope), "expression_in_range"));
    const n = (ids.length - 2) / 3;
    const constant = (id: number): number => {
      const c = this.constantOf(id);
      if (c === undefined) throw new Error("expression_in_range bounds must be constant");
      return c;
    };
    // The bounds are the one place a literal keeps its double precision: the
    // middle and half-width of each range are computed in doubles and only
    // then rounded.
    const exact = (id: number): number => {
      constant(id);
      return this.nodes[id]!.p as number;
    };
    const mid: number[] = [];
    const half: number[] = [];
    for (let k = 0; k < n; k++) {
      const from = exact(ids[2 + n + k]!);
      const to = exact(ids[2 + 2 * n + k]!);
      mid.push(f((from + to) / 2));
      half.push(f((to - from) / 2));
    }
    return {
      k: "n",
      id: this.intern({ op: "expression_in_range", args: ids.slice(2, 2 + n), p: { multiplier: constant(ids[0]!), maximum: constant(ids[1]!), mid, half } }),
    };
  }
}
