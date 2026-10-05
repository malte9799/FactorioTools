/** What the editor does synchronously on every edit, outside the renderer:
 *  undo snapshot, rate calculation, bottleneck pass, autosave encode.
 *
 *    npx tsx audit/2026-10/scripts/bench-edit-app.ts */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, encodeBlueprintString, collectBlueprints, normaliseEntities, normaliseWires, toBlueprint, calculate, attachBottlenecks } from "../../../packages/engine/src/index.js";
import { buildBeltNetwork, beltSpecResolver } from "../../../packages/sim/src/index.js";
const data = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const time = (fn: () => void, n: number) => { for (let i = 0; i < 2; i++) fn(); const t = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t) / n; };
for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
  const bps = collectBlueprints(decodeBlueprintString(ex.bp));
  const bp = bps.map((b) => ({ b, n: (b.entities ?? []).length })).sort((a, b) => b.n - a.n)[0]!.b;
  const entities = normaliseEntities(bp); const wires = normaliseWires(bp);
  const snap = time(() => entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) })), 20);
  let result: any;
  const calc = time(() => { result = calculate(data, entities, undefined as any); }, 10);
  const bott = time(() => attachBottlenecks({ data, entities, footprintOf: (n: string) => data.machines[n]?.size ?? data.beacons[n]?.size ?? [1, 1] }, result.groups), 10);
  let str = "";
  const enc = time(() => { str = encodeBlueprintString({ blueprint: toBlueprint(entities, { item: "blueprint", label: "x", version: 1 } as any, wires) } as any); }, 5);
  const dec = time(() => decodeBlueprintString(str), 5);
  const net = time(() => buildBeltNetwork(entities, beltSpecResolver(data)), 5);
  console.log(`${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 30).padEnd(30)} n=${entities.length} snapshot=${snap.toFixed(2)} calculate=${calc.toFixed(2)} bottlenecks=${bott.toFixed(2)} encode(autosave)=${enc.toFixed(2)} decode=${dec.toFixed(2)} beltNetwork=${net.toFixed(2)} ms  bpString=${(str.length/1024).toFixed(0)}KB`);
}
