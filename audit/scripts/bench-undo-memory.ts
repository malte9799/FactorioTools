/** blueprint-viewer/index.ts:598 pushes a full deep copy of every entity onto
 *  undoStack for EVERY edit, with no cap (:586). Measures the real heap cost
 *  of a normal editing session on a large blueprint. Also measures how long
 *  each edit's snapshot itself takes, since it is on the interactive path
 *  (a place/erase DRAG calls applyEdit per entity — see render.ts's
 *  isPlacingDrag/isErasing). */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { PlacedEntity } from "../../packages/engine/src/index.js";

const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

for (const ex of [...examples].sort((a,b)=>b.entities-a.entities).slice(0,3)) {
  const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0]!;
  if (!entities.length) continue;
  const snapshot = () => entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));

  // time one snapshot
  snapshot();
  const t0 = performance.now();
  const REPS = 50;
  for (let i = 0; i < REPS; i++) snapshot();
  const perSnap = (performance.now() - t0) / REPS;

  // heap cost of a 200-edit session (a drag across 200 tiles = 200 edits)
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const stack: PlacedEntity[][] = [];
  for (let i = 0; i < 200; i++) stack.push(snapshot());
  const after = process.memoryUsage().heapUsed;
  const mb = (after - before) / 1048576;

  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g,'').trim().slice(0,44)} — ${entities.length} entities ===`);
  console.log(`  one snapshot:            ${perSnap.toFixed(2)} ms`);
  console.log(`  200-edit undo stack:     ${mb.toFixed(0)} MB retained`);
  console.log(`  per edit:                ${(mb/200*1024).toFixed(0)} KB`);
  console.log(`  a 200-tile erase drag costs ${(perSnap*200).toFixed(0)} ms of snapshotting alone`);
  void stack.length;
}
