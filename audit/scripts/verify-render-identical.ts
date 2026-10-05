/** CHARAKTERISIERUNG DES RENDERPFADS.
 *  Ersetzt einen Canvas-Snapshot-Vergleich, der ohne Browser nicht möglich
 *  ist: statt Pixel wird die exakte Folge der drawImage-Aufrufe erfasst, die
 *  paint()/paintPlain() absetzen würden — Reihenfolge, Quell-/Zielrechtecke,
 *  Alpha und Composite-Modus. Zwei Renderpfade, die dieselbe Aufruffolge
 *  erzeugen, malen dasselbe Bild.
 *
 *  Läuft gegen den Debug-Lab-Blueprint (eine Instanz jeder Entity) und die
 *  größten echten Blueprints. Gibt einen Hash aus, der vor und nach einer
 *  Änderung übereinstimmen muss. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import { DEBUG_BLUEPRINT } from "../../packages/engine/src/data/debug-lab.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { buildCargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import { paint, paintPlain } from "../../packages/renderer/src/draw/paint.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);

/** Minimaler 2D-Kontext, der jeden Zeichenbefehl protokolliert statt zu malen. */
function recordingCtx() {
  const ops: string[] = [];
  let alpha = 1, composite = "source-over";
  const ctx: any = {
    set globalAlpha(v: number) { alpha = v; ops.push(`alpha=${v.toFixed(4)}`); },
    get globalAlpha() { return alpha; },
    set globalCompositeOperation(v: string) { composite = v; ops.push(`comp=${v}`); },
    get globalCompositeOperation() { return composite; },
    imageSmoothingEnabled: false,
    fillStyle: "", strokeStyle: "", lineWidth: 0,
    drawImage: (img: any, ...a: number[]) =>
      ops.push(`draw ${img.__id} ${a.map((n) => n.toFixed(4)).join(",")}`),
    fillRect: (...a: number[]) => ops.push(`fillRect ${a.map((n) => n.toFixed(4)).join(",")}`),
    strokeRect: (...a: number[]) => ops.push(`strokeRect ${a.map((n) => n.toFixed(4)).join(",")}`),
    save: () => ops.push("save"), restore: () => ops.push("restore"),
    translate: (...a: number[]) => ops.push(`translate ${a.join(",")}`),
    scale: (...a: number[]) => ops.push(`scale ${a.join(",")}`),
    setTransform: (...a: number[]) => ops.push(`setTransform ${a.join(",")}`),
    createPattern: () => ({}),
  };
  return { ctx, ops };
}

/** Atlas-Stub: jedes Sheet gilt als geladen, damit alle Zeichenpfade laufen. */
const atlas: any = { get: (sheet: string) => ({ __id: sheet }) };

function commandsFor(entities: PlacedEntity[], frame: number): DrawCommand[] {
  const grid = buildGrid(entities);
  const fluidNetwork = buildFluidNetwork(entities, (e) => {
    const p = lookup.get(e.name)?.pipeConnections;
    return p && activeFluidConnections(p, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(entities, (n) => lookup.get(n)?.heatConnections);
  const cargoBays = buildCargoBayGrid(entities, connectors.cargoBayShapeOf);
  const ctx: any = { grid, fluidNetwork, heatNetwork, ...connectors, cargoBays, animationFrame: frame };
  const cmds: DrawCommand[] = [];
  for (const e of entities) {
    const v = lookup.get(e.name);
    if (!v || !v.graphics || v.inserterGraphics) continue;
    collectEntity(cmds, e, v, ctx, 1);
  }
  return cmds;
}

const cases: [string, PlacedEntity[]][] = [];
{
  const debug = collectBlueprints(decodeBlueprintString(DEBUG_BLUEPRINT)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0];
  if (debug?.length) cases.push(["debug-lab (eine Instanz jeder Entity)", debug]);
}
for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
  const e = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0];
  if (e?.length) cases.push([ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 40), e]);
}

const overall = createHash("sha256");
for (const [label, entities] of cases) {
  const perFrame: string[] = [];
  for (const frame of [0, 1, 7, 33]) {
    const cmds = commandsFor(entities, frame);
    // BEIDE Pfade müssen dieselbe Aufruffolge liefern: der alte paint() und
    // der neue direkte paintPlain() für ungetönte Szenen-Commands.
    const a = recordingCtx(); paint(a.ctx, atlas, cmds.map((c) => ({ ...c })), 32);
    const b = recordingCtx(); paintPlain(b.ctx, atlas, cmds.map((c) => ({ ...c })));
    if (a.ops.join("\n") !== b.ops.join("\n")) {
      console.log(`  ABWEICHUNG in ${label}, Frame ${frame}: paint() != paintPlain()`);
      process.exitCode = 1;
    }
    perFrame.push(createHash("sha256").update(b.ops.join("\n")).digest("hex").slice(0, 16));
  }
  const h = perFrame.join(" ");
  overall.update(h);
  console.log(`  ${label.padEnd(42)} ${h}`);
}
console.log(`\nGESAMT-HASH: ${overall.digest("hex").slice(0, 32)}`);
