/** Crude but useful complexity proxy: per-function length and branch count
 *  (if/for/while/case/&&/||/?:) across first-party TS. */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("find apps/site/src packages/*/src -name '*.ts'", { encoding: "utf8" }).trim().split("\n");
const rows = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  let cur = null, depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const m = L.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|^\s*([A-Za-z0-9_]+)\s*\([^)]*\)\s*[:{]|^\s*(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/);
    if (m && depth === 0) {
      if (cur) rows.push(cur);
      cur = { file: f, name: m[1] || m[2] || m[3], line: i + 1, len: 0, branches: 0 };
    }
    if (cur) {
      cur.len++;
      cur.branches += (L.match(/\b(if|for|while|case)\b|&&|\|\||\?\s*[^:]/g) || []).length;
    }
    depth += (L.match(/\{/g) || []).length - (L.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  if (cur) rows.push(cur);
}
rows.sort((a, b) => b.branches - a.branches);
console.log("=== 20 most branch-heavy functions ===");
for (const r of rows.slice(0, 20))
  console.log(`  branches=${String(r.branches).padStart(3)} len=${String(r.len).padStart(4)}  ${r.file}:${r.line}  ${r.name}`);
console.log("\n=== 12 longest functions ===");
for (const r of [...rows].sort((a,b)=>b.len-a.len).slice(0,12))
  console.log(`  len=${String(r.len).padStart(4)} branches=${String(r.branches).padStart(3)}  ${r.file}:${r.line}  ${r.name}`);
