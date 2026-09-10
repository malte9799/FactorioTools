/** PHASE 7 VERIFIKATION von F-01.
 *  Meine Empfehlung "Command-Liste cachen, nur sx patchen" trägt nur, wenn
 *  sx sich TATSÄCHLICH linear mit dem Frame bewegt und zyklisch umläuft.
 *  Ein einfacher "stride"-Patch wäre falsch, wenn:
 *   - unterschiedliche Entities unterschiedliche Zykluslängen haben,
 *   - der Zyklus nicht bei animationFrame % columns umläuft,
 *   - ein slowdown-Faktor die Rate ändert (collect.ts:223).
 *  Getestet über eine volle Umlaufperiode statt nur 8 Stichproben. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);
const visualFor = (n: string) => lookup.get(n);

function collectAt(entities: PlacedEntity[], frame: number): DrawCommand[] {
  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const p = visualFor(e.name)?.pipeConnections; return p && activeFluidConnections(p, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(entities, (n) => visualFor(n)?.heatConnections);
  const ctx: any = { grid, fluidNetwork, heatNetwork, ...connectors, platformBoxes: [], animationFrame: frame };
  const cmds: DrawCommand[] = [];
  for (const e of entities) {
    const v = visualFor(e.name);
    if (!v || !v.graphics || v.inserterGraphics) continue;
    collectEntity(cmds, e, v, ctx, 1);
  }
  return cmds;
}

// Der zweitgrößte Blueprint mischt mehrere Band-Tiers (turbo/express/fast/
// underground) — dort ist am ehesten mit UNTERSCHIEDLICHEN Zykluslängen zu
// rechnen, was einen naiven Einheits-Patch brechen würde.
const pick = Number(process.argv[2] ?? 0);
const ex = [...examples].sort((a,b)=>b.entities-a.entities)[pick];
const entities = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0]!;

const FRAMES = 128;                       // volle Periode abdecken
const series: DrawCommand[][] = [];
for (let f = 0; f < FRAMES; f++) series.push(collectAt(entities, f));
const base = series[0]!;

// 1. Struktur wirklich über alle 128 Frames stabil?
let structStable = true;
const changed = new Set<string>();
for (const s of series) {
  if (s.length !== base.length) { structStable = false; break; }
  for (let i = 0; i < base.length; i++) {
    for (const k of ["sheet","sy","sw","sh","dx","dy","dw","dh","layer","y","order","alpha","tint"] as const) {
      if ((base[i] as any)[k] !== (s[i] as any)[k]) { structStable = false; changed.add(k); }
    }
  }
}
console.log(`Blueprint: ${entities.length} Entities, ${base.length} Commands, ${FRAMES} Frames geprüft`);
console.log(`1) Struktur (alles außer sx) über 128 Frames stabil: ${structStable}`);
if (!structStable) console.log(`   ABWEICHENDE FELDER: ${[...changed].join(", ")}`);

// 2. Bewegt sich sx pro Command periodisch und mit konstantem Schritt?
const animIdx: number[] = [];
for (let i = 0; i < base.length; i++) if (series.some(s => s[i]!.sx !== base[i]!.sx)) animIdx.push(i);

let linearOk = 0, nonLinear: number[] = [];
const periods = new Map<number, number>();
for (const i of animIdx) {
  const vals = series.map(s => s[i]!.sx);
  const uniq = [...new Set(vals)].sort((a,b)=>a-b);
  const stride = uniq.length > 1 ? uniq[1]! - uniq[0]! : 0;
  const evenlySpaced = uniq.every((v, k) => k === 0 || v - uniq[k-1]! === stride);
  // Periode = nach wie vielen Frames wiederholt sich der Wert?
  let period = vals.findIndex((v, k) => k > 0 && v === vals[0] && vals[(k+1) % FRAMES] === vals[1]);
  if (period <= 0) period = uniq.length;
  periods.set(period, (periods.get(period) ?? 0) + 1);
  if (evenlySpaced) linearOk++; else nonLinear.push(i);
}
console.log(`2) animierte Commands: ${animIdx.length}`);
console.log(`   davon mit gleichmäßigem sx-Schritt: ${linearOk} (${(linearOk/animIdx.length*100).toFixed(1)}%)`);
if (nonLinear.length) console.log(`   NICHT gleichmäßig: ${nonLinear.length} -> einfacher stride-Patch UNZUREICHEND`);
console.log(`3) beobachtete Zykluslängen (Frames -> Anzahl Commands):`);
for (const [p, n] of [...periods.entries()].sort((a,b)=>b[1]-a[1])) console.log(`   Periode ${p}: ${n} Commands`);
console.log(`   => ${periods.size === 1 ? "einheitlich" : "UNTERSCHIEDLICHE Perioden - Patch muss pro Command eigene Periode kennen"}`);
