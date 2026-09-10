/**
 * How much of a real blueprint's draw work actually depends on animationFrame?
 * Decides whether a static/animated split cache is worth building: only the
 * animated share genuinely has to be recollected every frame.
 */
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
const examples: { label: string; entities: number; bp: string }[] = JSON.parse(
  readFileSync("apps/site/public/data/example-blueprints.json", "utf8"),
);
const visualLookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(visualLookup);
const visualFor = (n: string) => visualLookup.get(n);

function collectAll(entities: PlacedEntity[], frame: number): DrawCommand[] {
  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const points = visualFor(e.name)?.pipeConnections;
    return points && activeFluidConnections(points, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(entities, (name) => visualFor(name)?.heatConnections);
  const ctx: any = { grid, fluidNetwork, heatNetwork, ...connectors, platformBoxes: [], animationFrame: frame };
  const cmds: DrawCommand[] = [];
  for (const e of entities) {
    const v = visualFor(e.name);
    if (!v || !v.graphics || v.inserterGraphics) continue;
    collectEntity(cmds, e, v, ctx, 1);
  }
  return cmds;
}

const key = (c: DrawCommand) => `${c.sheet}|${c.sx},${c.sy},${c.sw},${c.sh}|${c.dx.toFixed(4)},${c.dy.toFixed(4)}|${c.layer}|${c.order}`;

const out: any[] = [];
for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 5)) {
  const bps = collectBlueprints(decodeBlueprintString(ex.bp));
  const entities = bps.map(normaliseEntities).sort((a, b) => b.length - a.length)[0] ?? [];
  if (!entities.length) continue;

  const a = collectAll(entities, 0);
  const b = collectAll(entities, 1);
  const ka = a.map(key), kb = b.map(key);
  let differing = 0;
  const setB = new Set(kb);
  for (const k of ka) if (!setB.has(k)) differing++;

  // Which entity names are responsible
  const animNames = new Set<string>();
  for (const e of entities) {
    const v = visualFor(e.name);
    if (!v?.graphics) continue;
    const one = collectAll([e], 0).map(key).join(";");
    const two = collectAll([e], 1).map(key).join(";");
    if (one !== two) animNames.add(e.name);
  }
  const animEntities = entities.filter((e) => animNames.has(e.name)).length;

  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 46)} ===`);
  console.log(`  entities ${entities.length}, commands ${a.length}`);
  console.log(`  commands changing between frame 0 and 1: ${differing} (${(differing / a.length * 100).toFixed(1)}%)`);
  console.log(`  entities whose art animates: ${animEntities} (${(animEntities / entities.length * 100).toFixed(1)}%)`);
  console.log(`  animated entity names: ${[...animNames].slice(0, 12).join(", ")}${animNames.size > 12 ? ` (+${animNames.size - 12})` : ""}`);
  out.push({ label: ex.label.replace(/\[[^\]]*\]/g, "").trim(), entities: entities.length, commands: a.length,
    differingCommands: differing, differingPct: +(differing / a.length * 100).toFixed(1),
    animatedEntities: animEntities, animatedPct: +(animEntities / entities.length * 100).toFixed(1),
    animatedNames: [...animNames] });
}
console.log("\n=== JSON ===\n" + JSON.stringify(out, null, 2));
