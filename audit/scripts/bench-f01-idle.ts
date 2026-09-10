/** Was F-01 Stufe 1 real spart: Anteil der Blueprints, die im Leerlauf
 *  gar nicht mehr gezeichnet werden, plus die dadurch eingesparte
 *  Per-Frame-Arbeit. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, hasAnimatedLayer } from "../../packages/renderer/src/entityLookup.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);

let fullyStatic = 0, analysed = 0;
const rows: { label: string; entities: number; animated: number; pct: number }[] = [];

for (const ex of examples) {
  let entities: PlacedEntity[];
  try {
    entities = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0] ?? [];
  } catch { continue; }
  if (!entities.length) continue;
  analysed++;
  const animated = entities.filter((e) => {
    const v = lookup.get(e.name);
    return v ? hasAnimatedLayer(v) : false;
  }).length;
  if (animated === 0) fullyStatic++;
  rows.push({ label: ex.label.replace(/\[[^\]]*\]/g, "").trim(), entities: entities.length, animated, pct: animated / entities.length * 100 });
}

console.log(`Blueprints untersucht: ${analysed}`);
console.log(`davon vollständig statisch (0 animierte Entities): ${fullyStatic} = ${(fullyStatic / analysed * 100).toFixed(0)} %`);
console.log(`  -> diese zeichnen im Leerlauf jetzt GAR NICHT mehr (vorher 60x/s)\n`);

const withAnim = rows.filter((r) => r.animated > 0);
const avgPct = withAnim.reduce((a, b) => a + b.pct, 0) / withAnim.length;
console.log(`Bei den übrigen ${withAnim.length} animieren im Schnitt ${avgPct.toFixed(0)} % der Entities.`);
console.log(`Dort bleibt Stufe 1 wirkungslos, solange Bänder im Bild sind — dafür ist Stufe 2 (Command-Cache) gedacht.\n`);

const sorted = [...rows].sort((a, b) => a.pct - b.pct);
console.log("10 Blueprints mit dem geringsten Animationsanteil:");
for (const r of sorted.slice(0, 10)) {
  console.log(`  ${r.pct.toFixed(1).padStart(5)} %  ${String(r.entities).padStart(5)} Ent  ${r.label.slice(0, 44)}`);
}
