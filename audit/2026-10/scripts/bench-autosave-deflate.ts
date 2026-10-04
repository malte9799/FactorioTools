/** The autosave encode on the largest example, split by stage, and what
 *  each deflate level costs.
 *
 *    npx tsx audit/2026-10/scripts/bench-autosave-deflate.ts */
import { readFileSync } from "node:fs";
import pako from "pako";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, normaliseWires, toBlueprint } from "../../../packages/engine/src/index.js";
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const ex = [...examples].sort((a, b) => b.entities - a.entities)[0];
const bp = collectBlueprints(decodeBlueprintString(ex.bp)).sort((a: any, b: any) => (b.entities?.length ?? 0) - (a.entities?.length ?? 0))[0]!;
const entities = normaliseEntities(bp); const wires = normaliseWires(bp);
const time = (fn: () => void, n = 10) => { fn(); fn(); const t = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t) / n; };
let json = "";
console.log("toBlueprint", time(() => toBlueprint(entities, { item: "blueprint", label: "x", version: 1 } as any, wires)).toFixed(2));
const env = { blueprint: toBlueprint(entities, { item: "blueprint", label: "x", version: 1 } as any, wires) };
console.log("stringify", time(() => { json = JSON.stringify(env); }).toFixed(2), "json KB", (json.length / 1024).toFixed(0));
for (const level of [1, 6, 9] as const) { let out: Uint8Array = new Uint8Array(); const t = time(() => { out = pako.deflate(json, { level }); }); console.log(`deflate level ${level}`, t.toFixed(2), "ms", (out.length / 1024).toFixed(0), "KB"); }
const z = await import("node:zlib");
console.log("node zlib level9 (native, reference)", time(() => z.deflateSync(json, { level: 9 })).toFixed(2));
