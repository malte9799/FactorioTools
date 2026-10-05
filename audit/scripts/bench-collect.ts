/**
 * Benchmark of the real per-frame CPU pipeline in packages/renderer:
 *   buildGrid -> buildFluidNetwork/buildHeatNetwork -> spatialIndex.queryRect
 *   -> collectEntity -> paint's filter/sort
 * Canvas painting itself is excluded (no DOM here); this isolates the
 * JS-side cost that runs on the main thread every single rAF tick.
 */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, effectiveFootprint, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { buildCargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { SpatialIndex } from "../../packages/renderer/src/spatialIndex.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import { compareDrawCommands, type DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: { label: string; entities: number; bp: string }[] = JSON.parse(
  readFileSync("apps/site/public/data/example-blueprints.json", "utf8"),
);

const visualLookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(visualLookup);
const visualFor = (name: string) => visualLookup.get(name);

function timeIt(label: string, iters: number, fn: () => void): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (performance.now() - t0) / iters;
  console.log(`  ${label.padEnd(38)} ${dt.toFixed(3)} ms`);
  return dt;
}

const targets = process.argv.slice(2).length
  ? examples.filter((e) => process.argv.slice(2).includes(String(e.entities)))
  : [...examples].sort((a, b) => b.entities - a.entities).filter((_, i) => [0, 2, 8].includes(i)).concat(
      examples.filter((e) => e.entities >= 150 && e.entities <= 175).slice(0, 1),
    );

const results: any[] = [];

for (const ex of targets) {
  let entities: PlacedEntity[];
  try {
    const envelope = decodeBlueprintString(ex.bp);
    const bps = collectBlueprints(envelope);
    // A book contributes every one of its blueprints; the editor renders one
    // at a time, so take the largest as the realistic worst case.
    entities = bps.map(normaliseEntities).sort((a, b) => b.length - a.length)[0] ?? [];
  } catch (err) {
    console.log(`SKIP ${ex.label}: ${(err as Error).message}`);
    continue;
  }
  if (entities.length === 0) { console.log(`SKIP ${ex.label}: no entities`); continue; }
  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 46)} — ${entities.length} entities ===`);

  const tGrid = timeIt("buildGrid (per edit)", 20, () => { buildGrid(entities); });
  const tFluid = timeIt("buildFluidNetwork (per edit)", 20, () => {
    buildFluidNetwork(entities, (e) => {
      const points = visualFor(e.name)?.pipeConnections;
      return points && activeFluidConnections(points, e.recipe, data);
    });
  });
  const tHeat = timeIt("buildHeatNetwork (per edit)", 20, () => {
    buildHeatNetwork(entities, (name) => visualFor(name)?.heatConnections);
  });

  const boxes = entities.map((e) => {
    const v = visualFor(e.name);
    const [fw, fh] = v ? effectiveFootprint(v, e.direction) : [1, 1];
    return { entityNumber: e.entityNumber, left: e.x - fw / 2, top: e.y - fh / 2, right: e.x + fw / 2, bottom: e.y + fh / 2 };
  });
  const tIndex = timeIt("new SpatialIndex (per edit)", 20, () => { new SpatialIndex(boxes); });
  const spatialIndex = new SpatialIndex(boxes);
  const entityById = new Map(entities.map((e) => [e.entityNumber, e]));

  const bb = spatialIndex.boundingBox!;
  // "Whole blueprint in view" — the default framing after load, i.e. the
  // worst realistic per-frame case.
  const tQuery = timeIt("queryRect, whole bp visible (PER FRAME)", 50, () => {
    spatialIndex.queryRect(bb.minX - 4, bb.minY - 4, bb.maxX + 4, bb.maxY + 4);
  });

  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const points = visualFor(e.name)?.pipeConnections;
    return points && activeFluidConnections(points, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(entities, (name) => visualFor(name)?.heatConnections);
  const collectCtx: any = { grid, fluidNetwork, heatNetwork, ...connectors, cargoBays: buildCargoBayGrid(entities, connectors.cargoBayShapeOf), animationFrame: 0 };

  const visibleIds = spatialIndex.queryRect(bb.minX - 4, bb.minY - 4, bb.maxX + 4, bb.maxY + 4);
  const visible: PlacedEntity[] = [];
  for (const id of visibleIds) { const e = entityById.get(id); if (e) visible.push(e); }

  let cmdCount = 0;
  const tCollect = timeIt("collectEntity all visible (PER FRAME)", 20, () => {
    const commands: DrawCommand[] = [];
    for (const entity of visible) {
      const visual = visualFor(entity.name);
      if (!visual || !visual.graphics || visual.inserterGraphics) continue;
      collectEntity(commands, entity, visual, collectCtx, 1);
    }
    cmdCount = commands.length;
  });

  const baseCommands: DrawCommand[] = [];
  for (const entity of visible) {
    const visual = visualFor(entity.name);
    if (!visual || !visual.graphics || visual.inserterGraphics) continue;
    collectEntity(baseCommands, entity, visual, collectCtx, 1);
  }
  const tFilter = timeIt("paint's 2x filter() (PER FRAME)", 50, () => {
    baseCommands.filter((c) => !c.tint || c.layer === 5);
    baseCommands.filter((c) => c.tint && c.layer !== 5);
  });
  const tSort = timeIt("sort(compareDrawCommands) (PER FRAME)", 50, () => {
    baseCommands.slice().sort(compareDrawCommands);
  });

  const perFrame = tQuery + tCollect + tFilter + tSort;
  console.log(`  -> draw commands: ${cmdCount}  (${(cmdCount / visible.length).toFixed(1)} per entity)`);
  console.log(`  -> PER-FRAME JS (excl. canvas drawImage): ${perFrame.toFixed(2)} ms  => budget 16.7ms: ${(perFrame / 16.7 * 100).toFixed(0)}%`);
  results.push({ label: ex.label.replace(/\[[^\]]*\]/g, "").trim(), entities: entities.length, visible: visible.length, commands: cmdCount,
    tGrid, tFluid, tHeat, tIndex, tQuery, tCollect, tFilter, tSort, perFrame });
}

console.log("\n=== JSON ===");
console.log(JSON.stringify(results, null, 2));
