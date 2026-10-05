/** PHASE 7 VERIFIKATION von F-06.
 *  Meine Behauptung "87 % der Frames sind nie adressierbar" stützt sich auf
 *  eine STATISCHE Auswertung von column.by/row.by. Das wäre falsch, wenn der
 *  Renderer Frames über einen Weg adressiert, den ich nicht modelliert habe.
 *  Gegenprobe: statt zu modellieren, wird collectEntity für JEDE Entity über
 *  alle 16 Richtungen, viele Animationsframes und Nachbarschaftsvarianten
 *  aufgerufen und protokolliert, welche (sheet, sx, sy) tatsächlich VORKOMMEN. */
import { readFileSync, statSync, existsSync } from "node:fs";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { buildCargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);
const visualFor = (n: string) => lookup.get(n);

const ent = (name: string, x: number, y: number, direction: number, extra: any = {}): PlacedEntity => ({
  entityNumber: Math.floor(x * 100 + y * 10 + direction) + 1, name, x, y, direction,
  quality: "normal", modules: [], filterItems: [], ...extra,
});

/** (sheet -> Set der tatsächlich benutzten "sx,sy"-Zellen) */
const used = new Map<string, Set<string>>();
const record = (cmds: DrawCommand[]) => {
  for (const c of cmds) {
    let s = used.get(c.sheet); if (!s) used.set(c.sheet, (s = new Set()));
    s.add(`${c.sx},${c.sy}`);
  }
};

const names = [...lookup.keys()];
// Nachbarschaftsvarianten: allein, sowie umgeben von gleichartigen Nachbarn in
// allen vier Richtungen und Kombinationen — deckt Rohr-/Wand-/Band-/Plattform-
// Klassifikation und damit die connection-Achsen ab.
const NEIGHBOUR_SETS: [number, number][][] = [
  [], [[1,0]], [[-1,0]], [[0,1]], [[0,-1]],
  [[1,0],[-1,0]], [[0,1],[0,-1]], [[1,0],[0,1]], [[-1,0],[0,-1]],
  [[1,0],[-1,0],[0,1]], [[1,0],[-1,0],[0,1],[0,-1]],
];
const ANIM_FRAMES = [0,1,2,3,5,7,11,15,23,31,47,63,64,95,127];

for (const name of names) {
  const v = visualFor(name);
  if (!v?.graphics) continue;
  for (const nb of NEIGHBOUR_SETS) {
    for (let dir = 0; dir < 16; dir++) {
      const self = ent(name, 0, 0, dir, {
        undergroundType: dir % 2 === 0 ? "input" : "output",
        // Module füllen, damit module-slot-Layer alle Zustände zeigen
        modules: (v as any).moduleSlots ? [{ name: "productivity-module", quality: "normal", count: (v as any).moduleSlots }] : [],
      });
      const others = nb.map(([dx,dy],i) => ent(name, dx, dy, (dir + i*4) % 16, { undergroundType: "output" }));
      const all = [self, ...others];
      const grid = buildGrid(all);
      const fluidNetwork = buildFluidNetwork(all, (e) => {
        const p = visualFor(e.name)?.pipeConnections; return p && activeFluidConnections(p, e.recipe, data);
      });
      const heatNetwork = buildHeatNetwork(all, (n) => visualFor(n)?.heatConnections);
      const cargoBays = buildCargoBayGrid(all, connectors.cargoBayShapeOf);
      for (const frame of ANIM_FRAMES) {
        const ctx: any = { grid, fluidNetwork, heatNetwork, ...connectors, cargoBays, animationFrame: frame };
        const cmds: DrawCommand[] = [];
        try { collectEntity(cmds, self, v, ctx, 1); } catch { continue; }
        record(cmds);
      }
    }
  }
}

// Zellgröße pro Sheet aus dem Katalog ableiten, um Bytes zu schätzen
function pngDims(file: string): [number, number] | null {
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const frameSize = new Map<string, [number, number]>();
for (const [, v] of lookup) {
  for (const layer of (v as any).graphics?.layers ?? []) {
    const sprites: any[] = !("per" in layer) ? [layer.sprites]
      : layer.per === "heat-connection-patches" ? [...layer.connected, ...layer.disconnected]
      : layer.per === "module-slot" ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled])
      : Object.values(layer.sprites);
    for (const s of sprites) if (s?.sheet && s.frameWidth) frameSize.set(s.sheet, [s.frameWidth, s.frameHeight]);
  }
}

let totalBytes = 0, usedBytes = 0, sheetsCounted = 0;
const worst: [string, number, number, number][] = [];
for (const [sheet, cells] of used) {
  const fs_ = frameSize.get(sheet); if (!fs_) continue;
  const file = "apps/site/public/data/sprites/entities/" + sheet.split("/").pop();
  const dim = pngDims(file); if (!dim) continue;
  const [w, h] = dim, [fw, fh] = fs_;
  const totalCells = Math.max(1, Math.floor(w/fw)) * Math.max(1, Math.floor(h/fh));
  const bytes = statSync(file).size;
  totalBytes += bytes; usedBytes += bytes * Math.min(1, cells.size / totalCells);
  sheetsCounted++;
  worst.push([sheet.split("/").pop()!, bytes, cells.size, totalCells]);
}
worst.sort((a,b)=> (b[1]*(1-b[2]/b[3])) - (a[1]*(1-a[2]/a[3])));

console.log(`EMPIRISCH (collectEntity real aufgerufen, nicht modelliert):`);
console.log(`  Sheets erfasst: ${sheetsCounted}`);
console.log(`  Gesamtbytes:    ${(totalBytes/1048576).toFixed(0)} MB`);
console.log(`  davon genutzt:  ${(usedBytes/1048576).toFixed(0)} MB`);
console.log(`  VERSCHWENDET:   ${((totalBytes-usedBytes)/1048576).toFixed(0)} MB = ${((1-usedBytes/totalBytes)*100).toFixed(0)} %`);
console.log(`\n  10 größte Verschwender (empirisch belegte Zellnutzung):`);
for (const [n,b,u,t] of worst.slice(0,10))
  console.log(`    ${(b/1048576).toFixed(1).padStart(5)} MB  ${String(u).padStart(3)}/${String(t).padEnd(4)} Zellen genutzt  ${n}`);
