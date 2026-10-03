// Prototype helper: turn the reference gradient table into src/gradients.ts.
//   node proto/make-gradients.mjs <path to gradients.cpp>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(process.argv[2], "utf8");
const hex = [...src.slice(src.indexOf("{"), src.indexOf("};")).matchAll(/0x[0-9a-fA-F]+/g)].map((m) => Number(m[0]));
if (hex.length !== 512) throw new Error(`expected 512 values, found ${hex.length}`);

const rows = [];
for (let i = 0; i < 512; i += 8) {
  rows.push("  " + hex.slice(i, i + 8).map((v) => "0x" + v.toString(16).padStart(8, "0")).join(", ") + ",");
}

const out = [
  "/** The 256 gradient vectors of Factorio's basis noise, as raw float32 bits",
  " *  (x, y interleaved), before the per-seed shuffle.",
  " *",
  " *  They are 4.2 * (cos, sin) of 256 evenly spaced angles, but the game's table",
  " *  is not reproducible from that formula: 24 entries sit one ulp away from any",
  " *  closed form, and JavaScript engines do not agree on the last bit of",
  " *  Math.cos either. Bit-exact maps need the exact table, so it is stored.",
  " *",
  " *  Values as published in ness056/fast-factorio-seed-finder, whose author",
  " *  reverse-engineered the generator and shares it with Wube's permission. */",
  "const BITS = new Uint32Array([",
  ...rows,
  "]);",
  "",
  "export function defaultGradients(): Float32Array {",
  "  return new Float32Array(new Float32Array(BITS.buffer, BITS.byteOffset, BITS.length));",
  "}",
  "",
].join("\n");

writeFileSync(path.join(import.meta.dirname, "../src/gradients.ts"), out);
console.log(`wrote src/gradients.ts (${out.length} bytes)`);
