/** Measures the achievable win of caching the collected+sorted command list
 *  and patching only sx per frame, vs today's full recollect+sort. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections, effectiveFootprint } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { SpatialIndex } from "../../packages/renderer/src/spatialIndex.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import { compareDrawCommands, type DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const visualLookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(visualLookup);
const visualFor = (n: string) => visualLookup.get(n);

for (const ex of [...examples].sort((a,b)=>b.entities-a.entities).slice(0,3)) {
  const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0]!;
  if (!entities.length) continue;

  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const p = visualFor(e.name)?.pipeConnections; return p && activeFluidConnections(p, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(entities, (n) => visualFor(n)?.heatConnections);
  const boxes = entities.map((e) => {
    const v = visualFor(e.name); const [fw,fh] = v ? effectiveFootprint(v, e.direction) : [1,1];
    return { entityNumber: e.entityNumber, left: e.x-fw/2, top: e.y-fh/2, right: e.x+fw/2, bottom: e.y+fh/2 };
  });
  const index = new SpatialIndex(boxes);
  const byId = new Map(entities.map(e=>[e.entityNumber,e]));
  const bb = index.boundingBox!;

  const mkCtx = (f:number):any => ({ grid, fluidNetwork, heatNetwork, ...connectors, platformBoxes: [], animationFrame: f });

  const TODAY = (f:number) => {
    const ids = index.queryRect(bb.minX-4, bb.minY-4, bb.maxX+4, bb.maxY+4);
    const vis: PlacedEntity[] = []; for (const id of ids) { const e = byId.get(id); if (e) vis.push(e); }
    const cmds: DrawCommand[] = []; const ctx = mkCtx(f);
    for (const e of vis) { const v = visualFor(e.name); if (!v||!v.graphics||v.inserterGraphics) continue; collectEntity(cmds,e,v,ctx,1); }
    cmds.filter(c=>!c.tint||c.layer===5); cmds.filter(c=>c.tint&&c.layer!==5);
    cmds.sort(compareDrawCommands);
    return cmds;
  };

  // Cached model: collect+sort once, then per frame only patch sx of the
  // animated subset. Build the patch table once (the real implementation
  // would record it during the single collect pass).
  const cached = TODAY(0);
  const f1 = TODAY(1);
  const animIdx: number[] = [];
  for (let i=0;i<cached.length;i++) if (cached[i]!.sx !== f1[i]!.sx) animIdx.push(i);
  // per-frame sx stride for each animated command
  const stride = animIdx.map(i => f1[i]!.sx - cached[i]!.sx);

  const CACHED = (f:number) => {
    for (let k=0;k<animIdx.length;k++) { const i = animIdx[k]!; cached[i]!.sx = cached[i]!.sx + stride[k]!; }
    return cached;
  };

  const bench = (label:string, fn:(f:number)=>unknown, iters:number) => {
    for (let i=0;i<5;i++) fn(i);
    const t0=performance.now(); for (let i=0;i<iters;i++) fn(i);
    const dt=(performance.now()-t0)/iters; console.log(`  ${label.padEnd(34)} ${dt.toFixed(3)} ms`); return dt;
  };

  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g,'').trim().slice(0,44)} — ${entities.length} entities, ${cached.length} commands ===`);
  console.log(`  animated commands: ${animIdx.length} / ${cached.length} (${(animIdx.length/cached.length*100).toFixed(1)}%)`);
  const a = bench("TODAY: full recollect+sort", TODAY, 30);
  const b = bench("CACHED: patch sx only", CACHED, 200);
  console.log(`  speedup: ${(a/b).toFixed(0)}x   saved per frame: ${(a-b).toFixed(2)} ms`);
  console.log(`  idle frame (nothing animating, static bp): TODAY ${a.toFixed(2)} ms -> CACHED ~0.00 ms`);
}
