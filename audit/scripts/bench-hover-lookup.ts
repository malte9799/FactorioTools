/** Cost of blueprint-viewer/index.ts:463's groupForEntity — a linear
 *  groups.find() over an inner entityNumbers.includes(), run on EVERY hover
 *  pointermove — vs a prebuilt Map lookup. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, calculate } from "../../packages/engine/src/index.js";
import type { GameData } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

for (const ex of [...examples].sort((a,b)=>b.entities-a.entities).slice(0,3)) {
  const entities = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0]!;
  if (!entities.length) continue;
  let result: any;
  try { result = calculate(data, entities, undefined as any); }
  catch (e) { console.log("computeRates signature mismatch:", (e as Error).message); break; }
  const groups = result.groups as { entityNumbers: number[] }[];

  const ids = entities.map(e => e.entityNumber);
  const today = (id: number) => groups.find(g => g.entityNumbers.includes(id)) ?? null;
  const map = new Map<number, unknown>();
  for (const g of groups) for (const n of g.entityNumbers) map.set(n, g);
  const fast = (id: number) => map.get(id) ?? null;

  const bench = (label: string, fn: (id:number)=>unknown) => {
    for (const id of ids) fn(id);
    const t0 = performance.now();
    const REPS = 20;
    for (let r=0;r<REPS;r++) for (const id of ids) fn(id);
    const total = performance.now()-t0;
    const per = total/(REPS*ids.length);
    console.log(`  ${label.padEnd(28)} ${(per*1000).toFixed(2)} µs per hover`);
    return per;
  };
  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g,'').trim().slice(0,44)} — ${entities.length} entities, ${groups.length} groups ===`);
  const a = bench("TODAY find+includes", today);
  const b = bench("Map lookup", fast);
  console.log(`  speedup ${(a/b).toFixed(0)}x`);
}
