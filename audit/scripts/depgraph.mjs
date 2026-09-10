// Builds the first-party module graph and detects cycles (Tarjan SCC).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const files = execSync(
  `find apps/site/src packages/*/src -name '*.ts' -not -path '*/node_modules/*'`,
  { encoding: "utf8" }
).trim().split("\n");

const ALIAS = {
  "@factoriotools/engine": "packages/engine/src/index.ts",
  "@factoriotools/renderer": "packages/renderer/src/index.ts",
};

const graph = new Map();
for (const f of files) graph.set(f, []);

for (const f of files) {
  const src = readFileSync(path.join(root, f), "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const s of specs) {
    let target = null;
    if (ALIAS[s]) target = ALIAS[s];
    else if (s.startsWith(".")) {
      const resolved = path.normalize(path.join(path.dirname(f), s)).replace(/\.js$/, ".ts");
      target = resolved;
    }
    if (target && graph.has(target)) graph.get(f).push(target);
  }
}

// Tarjan
let idx = 0; const index = new Map(), low = new Map(), onstack = new Set(), stack = [];
const sccs = [];
function strong(v) {
  index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onstack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onstack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = []; let w;
    do { w = stack.pop(); onstack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp);
  }
}
for (const v of graph.keys()) if (!index.has(v)) strong(v);

// layer violations
function layer(f) {
  if (f.startsWith("packages/engine")) return 0;
  if (f.startsWith("packages/renderer")) return 1;
  if (f.startsWith("packages/data-pipeline")) return 1;
  if (f.startsWith("apps/site")) return 2;
  return 9;
}
const violations = [];
for (const [f, deps] of graph) for (const d of deps)
  if (layer(d) > layer(f)) violations.push(`${f} -> ${d}`);

// fan-in / fan-out
const fanIn = new Map();
for (const [, deps] of graph) for (const d of deps) fanIn.set(d, (fanIn.get(d) ?? 0) + 1);

console.log("modules:", graph.size);
console.log("edges:", [...graph.values()].reduce((a, b) => a + b.length, 0));
console.log("\n=== CYCLES (SCC > 1) ===");
console.log(sccs.length ? sccs.map(c => c.join(" <-> ")).join("\n") : "none");
console.log("\n=== LAYER VIOLATIONS (lower layer importing higher) ===");
console.log(violations.length ? violations.join("\n") : "none");
console.log("\n=== TOP FAN-IN ===");
[...fanIn.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([f,n])=>console.log(String(n).padStart(3), f));
console.log("\n=== TOP FAN-OUT ===");
[...graph.entries()].map(([f,d])=>[f,d.length]).sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([f,n])=>console.log(String(n).padStart(3), f));
