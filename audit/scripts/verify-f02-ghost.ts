/** VERIFIKATION F-02: Der Ghost-Preview-Cache darf das ANGEZEIGTE Ergebnis
 *  nicht verändern. Prüft, dass die gecachten Netze für jede Ghost-Position/
 *  -Richtung dieselben Klassifikationen liefern wie ein frischer Neuaufbau,
 *  und zählt, wie viele Neuaufbauten der Cache einspart. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import { DEBUG_BLUEPRINT } from "../../packages/engine/src/data/debug-lab.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { CargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);

const entities = collectBlueprints(decodeBlueprintString(DEBUG_BLUEPRINT)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;

function networksFor(withGhost: PlacedEntity[]) {
  return {
    grid: buildGrid(withGhost),
    fluid: buildFluidNetwork(withGhost, (e) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, e.recipe, data);
    }),
    heat: buildHeatNetwork(withGhost, (n) => lookup.get(n)?.heatConnections),
  };
}

function ghostCommands(ghost: PlacedEntity, nets: ReturnType<typeof networksFor>): string {
  const visual = lookup.get(ghost.name);
  if (!visual?.graphics) return "";
  const ctx: any = { grid: nets.grid, fluidNetwork: nets.fluid, heatNetwork: nets.heat, ...connectors, cargoBays: new CargoBayGrid(), animationFrame: 0 };
  const cmds: DrawCommand[] = [];
  collectEntity(cmds, ghost, visual, ctx, 1);
  return cmds.map((c) => `${c.sheet}|${c.sx},${c.sy}|${c.dx.toFixed(3)},${c.dy.toFixed(3)}|${c.layer}|${c.order}`).join(";");
}

const GHOST_NAMES = ["transport-belt", "pipe", "nuclear-reactor", "assembling-machine-2", "underground-belt", "heat-pipe"]
  .filter((n) => lookup.has(n));

/** Bildet die neue Cache-Logik nach: Key aus Position/Richtung/Name/Version. */
let rebuilds = 0;
let cacheKey: string | null = null;
let cached: ReturnType<typeof networksFor> | null = null;
function cachedNetworks(ghost: PlacedEntity): ReturnType<typeof networksFor> {
  const key = `0|${ghost.name}|${ghost.x},${ghost.y}|${ghost.direction}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cached = networksFor([...entities, ghost]);
    rebuilds++;
  }
  return cached!;
}

let checks = 0, mismatches = 0, framesSimulated = 0;
for (const name of GHOST_NAMES) {
  for (const [gx, gy] of [[0.5, 0.5], [4.5, 2.5], [10.5, 10.5], [-3.5, 6.5]] as [number, number][]) {
    for (const dir of [0, 4, 8, 12]) {
      const ghost: PlacedEntity = {
        entityNumber: -1, name, x: gx, y: gy, direction: dir,
        quality: "normal", modules: [], filterItems: [],
        undergroundType: name.includes("underground") ? "input" : undefined,
      };
      // 10 Frames mit RUHENDER Maus — genau der Fall, den der Cache trifft.
      for (let frame = 0; frame < 10; frame++) {
        framesSimulated++;
        const fresh = ghostCommands(ghost, networksFor([...entities, ghost]));
        const viaCache = ghostCommands(ghost, cachedNetworks(ghost));
        checks++;
        if (fresh !== viaCache) {
          mismatches++;
          console.log(`  ABWEICHUNG: ${name} @${gx},${gy} dir=${dir} frame=${frame}`);
        }
      }
    }
  }
}

console.log(`Ghost-Konstellationen: ${GHOST_NAMES.length} Entities x 4 Positionen x 4 Richtungen`);
console.log(`simulierte Frames:     ${framesSimulated}`);
console.log(`Vergleiche:            ${checks}`);
console.log(`Abweichungen:          ${mismatches}`);
console.log(`Netz-Neuaufbauten:     ${rebuilds} statt ${framesSimulated}  (-${(100 - rebuilds / framesSimulated * 100).toFixed(0)} %)`);
process.exit(mismatches === 0 ? 0 : 1);
