/** Vergleicht den unbegrenzten Undo-Stack (Alt-Stand) mit dem gedeckelten
 *  Ringpuffer (HISTORY_LIMIT = 50, wie in index.ts umgesetzt). */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { PlacedEntity } from "../../packages/engine/src/index.js";

const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const HISTORY_LIMIT = 50;

for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
  const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
  if (!entities.length) continue;
  const snapshot = () => entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));

  /** Misst, was nach dem Edit-Lauf noch ERREICHBAR ist (also den dauerhaften
   *  Verbrauch), nicht was insgesamt alloziert wurde: verworfene Snapshots
   *  sind sonst zwar unerreichbar, aber noch nicht eingesammelt und würden
   *  den Deckel wirkungslos aussehen lassen. */
  const measure = (limit: number | null, edits: number) => {
    global.gc?.(); global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const stack: PlacedEntity[][] = [];
    for (let i = 0; i < edits; i++) {
      stack.push(snapshot());
      if (limit !== null && stack.length > limit) stack.shift();
    }
    global.gc?.(); global.gc?.();
    const mb = (process.memoryUsage().heapUsed - before) / 1048576;
    void stack.length;
    return mb;
  };

  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 44)} — ${entities.length} Entities ===`);
  for (const edits of [200, 500]) {
    const un = measure(null, edits);
    const cap = measure(HISTORY_LIMIT, edits);
    console.log(`  ${String(edits).padStart(3)} Edits: unbegrenzt ${un.toFixed(0).padStart(4)} MB  ->  gedeckelt ${cap.toFixed(0).padStart(3)} MB   (-${(100 - cap / un * 100).toFixed(0)} %)`);
  }
}
