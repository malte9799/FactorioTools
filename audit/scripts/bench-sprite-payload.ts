/** What does a user actually download when opening a typical blueprint?
 *  render.ts's rebuildIndices preloads every sheet referenced by EVERY entity
 *  in the blueprint (not just visible ones), so this is the real first-load
 *  network cost per blueprint. */
import { readFileSync, statSync, existsSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog } from "../../packages/engine/src/index.js";
import { buildVisualLookup } from "../../packages/renderer/src/entityLookup.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const visualLookup = buildVisualLookup(data, catalog);

function sheetsFor(names: Set<string>): Set<string> {
  const sheets = new Set<string>();
  for (const name of names) {
    const visual = visualLookup.get(name);
    for (const layer of visual?.graphics?.layers ?? []) {
      const sprites: any[] = !("per" in layer) ? [(layer as any).sprites]
        : (layer as any).per === "heat-connection-patches" ? [...(layer as any).connected, ...(layer as any).disconnected]
        : (layer as any).per === "module-slot" ? (layer as any).slots.flatMap((s: any) => [s.empty, ...s.filled])
        : Object.values((layer as any).sprites);
      for (const s of sprites) if (s?.sheet) sheets.add(s.sheet);
    }
    const ins = visual?.inserterGraphics;
    if (ins) { sheets.add(ins.platform.sheet); sheets.add(ins.handBase.sheet); sheets.add(ins.handOpen.sheet); }
  }
  return sheets;
}
const bytesOf = (sheets: Set<string>) => {
  let total = 0, missing = 0;
  for (const s of sheets) {
    const p = "apps/site/public/data/sprites/entities/" + s.split("/").pop();
    if (existsSync(p)) total += statSync(p).size; else missing++;
  }
  return { total, missing };
};

// How much of that payload is needed for the entities actually VISIBLE in the
// initial framed view? render.ts:839 preloads for ALL entities regardless.
import { effectiveFootprint } from "../../packages/renderer/src/entityLookup.js";
const rows: any[] = [];
for (const ex of examples) {
  let entities;
  try { entities = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0] ?? []; }
  catch { continue; }
  if (!entities.length) continue;
  const names = new Set(entities.map(e => e.name));
  const sheets = sheetsFor(names);
  const { total, missing } = bytesOf(sheets);
  // Initial camera frames the whole bounding box, but a 1920x1080 viewport at
  // the camera's own min zoom (6px/tile) shows at most 320x180 tiles. For
  // blueprints larger than that, only a subset is truly on screen.
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const e of entities){ const v=visualLookup.get(e.name); const [w,h]=v?effectiveFootprint(v,e.direction):[1,1];
    minX=Math.min(minX,e.x-w/2); minY=Math.min(minY,e.y-h/2); maxX=Math.max(maxX,e.x+w/2); maxY=Math.max(maxY,e.y+h/2); }
  const VW=320, VH=180;
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  const vis = entities.filter(e => Math.abs(e.x-cx)<=VW/2 && Math.abs(e.y-cy)<=VH/2);
  const visSheets = sheetsFor(new Set(vis.map(e=>e.name)));
  const visBytes = bytesOf(visSheets).total;
  rows.push({ label: ex.label.replace(/\[[^\]]*\]/g,'').trim(), entities: entities.length,
    distinctNames: names.size, sheets: sheets.size, mb: total/1048576, missing,
    visMb: visBytes/1048576, visSheets: visSheets.size, visEntities: vis.length });
}
rows.sort((a,b)=>b.mb-a.mb);
console.log(`analysed ${rows.length} real blueprints\n`);
console.log("=== 12 heaviest first-load payloads ===");
for (const r of rows.slice(0,12))
  console.log(`  ${r.mb.toFixed(1).padStart(6)} MB  ${String(r.sheets).padStart(3)} sheets  ${String(r.entities).padStart(5)} ent  ${r.label.slice(0,42)}`);
const mbs = rows.map(r=>r.mb).sort((a,b)=>a-b);
const pct = (p:number) => mbs[Math.floor(mbs.length*p)]!;
console.log(`\nmedian ${pct(0.5).toFixed(1)} MB | p90 ${pct(0.9).toFixed(1)} MB | max ${mbs[mbs.length-1]!.toFixed(1)} MB`);
console.log(`mean sheets per blueprint: ${(rows.reduce((a,b)=>a+b.sheets,0)/rows.length).toFixed(0)}`);

const totalAll = rows.reduce((a,b)=>a+b.mb,0), totalVis = rows.reduce((a,b)=>a+b.visMb,0);
console.log(`\n=== preload-all vs viewport-only (min-zoom 320x180 tile window) ===`);
console.log(`  sum over 176 blueprints: preload-all ${totalAll.toFixed(0)} MB vs viewport-only ${totalVis.toFixed(0)} MB`);
console.log(`  => viewport-only would fetch ${(totalVis/totalAll*100).toFixed(0)}% of today's bytes`);
const big = rows.filter(r=>r.entities>1500).slice(0,8);
console.log(`\n  largest blueprints, all vs viewport:`);
for (const r of big) console.log(`    ${r.mb.toFixed(1).padStart(6)} MB -> ${r.visMb.toFixed(1).padStart(6)} MB  (${r.visEntities}/${r.entities} ent)  ${r.label.slice(0,34)}`);
