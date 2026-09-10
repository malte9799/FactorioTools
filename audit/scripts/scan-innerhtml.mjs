/** Flags every innerHTML assignment whose template interpolates a non-literal
 *  expression, and classifies whether the interpolated value can plausibly
 *  originate from a pasted blueprint (untrusted) vs. game data / literals. */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("find apps/site/src -name '*.ts'", { encoding: "utf8" }).trim().split("\n");
const rows = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\.innerHTML\s*=/.test(lines[i])) continue;
    // capture the template through to its closing backtick
    let block = lines[i], j = i;
    while (!/`\s*;?\s*$/.test(block.trim()) && j < lines.length - 1 && j - i < 30) { j++; block += "\n" + lines[j]; }
    const interps = [...block.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1].trim());
    rows.push({ file: f, line: i + 1, interps });
  }
}
const UNTRUSTED = /entityName|moduleLabel|recipeLabel|machineLabel|\blabel\b|\.name\b|warning\.|title/;
console.log("innerHTML assignments:", rows.length);
console.log("  with NO interpolation (safe):", rows.filter(r => r.interps.length === 0).length);
const risky = rows.filter(r => r.interps.some(x => UNTRUSTED.test(x)));
console.log("  interpolating possibly blueprint-derived values:", risky.length);
for (const r of risky) {
  console.log(`\n  ${r.file}:${r.line}`);
  for (const x of r.interps.filter(v => UNTRUSTED.test(v))) console.log(`      \${${x}}`);
}
