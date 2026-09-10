/** Do animated commands change only their SOURCE RECT (sx/sy), keeping
 *  identical destination geometry, layer and order? If so, a per-frame
 *  recollect is unnecessary even for belts: the cached command list can be
 *  patched in place with a new source offset. */
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
const visualLookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(visualLookup);
const visualFor = (n: string) => visualLookup.get(n);

function collectAll(entities: PlacedEntity[], frame: number): DrawCommand[] {
  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const p = visualFor(e.name)?.pipeConnections;
    return p && activeFluidConnections(p, e.recipe, data);
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

const ex = [...examples].sort((a, b) => b.entities - a.entities)[0];
const entities = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;

// Sample many frames to see the full cycle behaviour.
const frames = [0, 1, 2, 3, 7, 15, 31, 63];
const series = frames.map((f) => collectAll(entities, f));
const base = series[0]!;

let sameLength = true, geomStable = true, onlySrcChanges = true;
const changedFields = new Set<string>();
for (const s of series) {
  if (s.length !== base.length) { sameLength = false; break; }
  for (let i = 0; i < base.length; i++) {
    const a = base[i]!, b = s[i]!;
    for (const k of ["sheet","sx","sy","sw","sh","dx","dy","dw","dh","layer","y","order","alpha"] as const) {
      if ((a as any)[k] !== (b as any)[k]) {
        changedFields.add(k);
        if (!["sx","sy"].includes(k)) onlySrcChanges = false;
        if (["dx","dy","dw","dh","layer","order","y"].includes(k)) geomStable = false;
      }
    }
  }
}
console.log("blueprint:", ex.label.replace(/\[[^\]]*\]/g, "").trim(), "| entities", entities.length, "| commands", base.length);
console.log("frames sampled:", frames.join(","));
console.log("command COUNT identical across frames:", sameLength);
console.log("command ORDER/geometry identical across frames:", geomStable);
console.log("fields that ever differ:", [...changedFields].join(", ") || "(none)");
console.log("=> ONLY source-rect (sx/sy) changes:", onlySrcChanges);

// How many distinct sheets are referenced (atlas switching cost)
const sheets = new Set(base.map(c => c.sheet));
console.log("distinct sheets in one frame:", sheets.size);
