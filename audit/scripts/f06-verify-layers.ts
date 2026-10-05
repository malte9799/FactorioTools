/** F-06 SCHRITT 1: Gegenprüfung der Frame-Analyse gegen die beiden Layer-Arten,
 *  bei denen die Achsen-Modellierung (column.by/row.by) NICHT die ganze
 *  Wahrheit ist:
 *    - per: "module-slot"            (eigene slots[]-Indexlogik)
 *    - per: "heat-connection-patches" (connected[]/disconnected[]-Arrays)
 *  Für jede solche Entity wird collectEntity real über alle relevanten
 *  Zustände gefahren und protokolliert, welche Sheet-Zellen wirklich
 *  angesprochen werden. */
import { readFileSync, existsSync, statSync } from "node:fs";
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

function pngDims(sheet: string): [number, number] | null {
  const f = "apps/site/public/data/sprites/entities/" + sheet.split("/").pop();
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const sheetFile = (sheet: string) => "apps/site/public/data/sprites/entities/" + sheet.split("/").pop();

/* ---------- 1. Welche Entities nutzen die kritischen Layer-Arten? ---------- */
const moduleSlotEntities: string[] = [];
const heatPatchEntities: string[] = [];
for (const [name, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    if (layer.per === "module-slot") moduleSlotEntities.push(name);
    if (layer.per === "heat-connection-patches") heatPatchEntities.push(name);
  }
}
console.log("=== Entities mit kritischen Layer-Arten ===");
console.log(`  per:"module-slot":             ${[...new Set(moduleSlotEntities)].join(", ") || "(keine)"}`);
console.log(`  per:"heat-connection-patches": ${[...new Set(heatPatchEntities)].join(", ") || "(keine)"}`);

/* ---------- 2. Alle real angesprochenen Zellen sammeln ---------- */
const used = new Map<string, Set<string>>();
const record = (cmds: DrawCommand[]) => {
  for (const c of cmds) {
    let s = used.get(c.sheet); if (!s) used.set(c.sheet, (s = new Set()));
    s.add(`${c.sx},${c.sy}`);
  }
};

function ent(name: string, x: number, y: number, direction: number, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entityNumber: Math.round(x * 97 + y * 13 + direction) + 1, name, x, y, direction,
           quality: "normal", modules: [], filterItems: [], ...extra } as PlacedEntity;
}

function collectFor(self: PlacedEntity, others: PlacedEntity[], frame: number): DrawCommand[] {
  const all = [self, ...others];
  const grid = buildGrid(all);
  const fluidNetwork = buildFluidNetwork(all, (e) => {
    const p = lookup.get(e.name)?.pipeConnections;
    return p && activeFluidConnections(p, e.recipe, data);
  });
  const heatNetwork = buildHeatNetwork(all, (n) => lookup.get(n)?.heatConnections);
  const cargoBays = buildCargoBayGrid(all, connectors.cargoBayShapeOf);
  const ctx: any = { grid, fluidNetwork, heatNetwork, ...connectors, cargoBays, animationFrame: frame };
  const out: DrawCommand[] = [];
  const v = lookup.get(self.name);
  if (!v?.graphics) return out;
  collectEntity(out, self, v, ctx, 1);
  return out;
}

/* --- 2a. module-slot: jede mögliche Belegung 0..maxSlots durchspielen --- */
console.log("\n=== module-slot: Zellnutzung über alle Belegungsgrade ===");
for (const name of [...new Set(moduleSlotEntities)]) {
  const visual: any = lookup.get(name);
  const maxSlots = visual?.moduleSlots ?? 0;
  const perSheet = new Map<string, Set<string>>();
  for (let filled = 0; filled <= Math.max(maxSlots, 4); filled++) {
    for (let dir = 0; dir < 16; dir += 4) {
      const self = ent(name, 0.5, 0.5, dir, {
        modules: filled > 0 ? [{ name: "productivity-module", quality: "normal", count: filled }] : [],
      } as any);
      const cmds = collectFor(self, [], 0);
      record(cmds);
      for (const c of cmds) {
        let s = perSheet.get(c.sheet); if (!s) perSheet.set(c.sheet, (s = new Set()));
        s.add(`${c.sx},${c.sy}`);
      }
    }
  }
  console.log(`  ${name} (${maxSlots} Slots):`);
  for (const [sheet, cells] of perSheet) {
    const dim = pngDims(sheet);
    console.log(`    ${sheet.split("/").pop()}: ${cells.size} Zellen genutzt${dim ? `, Sheet ${dim[0]}x${dim[1]}` : ""}`);
  }
}

/* --- 2b. heat-connection-patches: verbunden vs. unverbunden, alle Seiten --- */
console.log("\n=== heat-connection-patches: verbunden/unverbunden, alle Nachbarn ===");
for (const name of [...new Set(heatPatchEntities)]) {
  const perSheet = new Map<string, Set<string>>();
  const neighbourSets: PlacedEntity[][] = [
    [],
    [ent("heat-pipe", 2.5, 0.5, 0)],
    [ent("heat-pipe", -1.5, 0.5, 0)],
    [ent("heat-pipe", 0.5, 2.5, 0)],
    [ent("heat-pipe", 0.5, -1.5, 0)],
    [ent("heat-pipe", 2.5, 0.5, 0), ent("heat-pipe", -1.5, 0.5, 0), ent("heat-pipe", 0.5, 2.5, 0), ent("heat-pipe", 0.5, -1.5, 0)],
    [ent(name, 3.5, 0.5, 0)],
  ];
  for (const others of neighbourSets) {
    for (let dir = 0; dir < 16; dir += 4) {
      const cmds = collectFor(ent(name, 0.5, 0.5, dir), others, 0);
      record(cmds);
      for (const c of cmds) {
        let s = perSheet.get(c.sheet); if (!s) perSheet.set(c.sheet, (s = new Set()));
        s.add(`${c.sx},${c.sy}`);
      }
    }
  }
  console.log(`  ${name}:`);
  for (const [sheet, cells] of perSheet) {
    const dim = pngDims(sheet);
    console.log(`    ${sheet.split("/").pop()}: ${cells.size} Zellen${dim ? `, Sheet ${dim[0]}x${dim[1]}` : ""}`);
  }
}

/* ---------- 3. Vergleich mit der Achsen-Modellierung ---------- */
console.log("\n=== Abgleich: Achsen-Modell vs. real beobachtet ===");
function axisCardinality(axis: any): number {
  if (!axis || axis.by === "none") return 1;
  switch (axis.by) {
    case "direction": return 4;
    case "direction8": return 8;
    case "direction16": case "direction256": return 16;
    case "animation": return Infinity;
    case "connection": return 16;
    default: return Infinity;
  }
}
let disagreements = 0;
for (const [name, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    if (layer.per !== "module-slot" && layer.per !== "heat-connection-patches") continue;
    const sprites: any[] = layer.per === "module-slot"
      ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled])
      : [...layer.connected, ...layer.disconnected];
    for (const sp of sprites) {
      if (!sp?.sheet || !sp.frameWidth) continue;
      const dim = pngDims(sp.sheet); if (!dim) continue;
      const cols = Math.max(1, Math.floor(dim[0] / sp.frameWidth));
      const rows = Math.max(1, Math.floor(dim[1] / sp.frameHeight));
      const modelled = Math.min(cols * rows, axisCardinality(layer.column) * axisCardinality(layer.row));
      const observed = used.get(sp.sheet)?.size ?? 0;
      if (observed > modelled) {
        disagreements++;
        console.log(`  WARNUNG ${name}: ${sp.sheet.split("/").pop()} — Modell ${modelled} Zellen, beobachtet ${observed}`);
      }
    }
  }
}
console.log(disagreements === 0
  ? "  Keine Abweichung: bei diesen Layern liefert das Achsen-Modell nie WENIGER Zellen als real genutzt."
  : `  ${disagreements} Abweichungen — Cropping darf sich hier NICHT auf das Achsen-Modell stützen.`);

/* ---------- 4. Einsparpotenzial genau dieser Sheets ---------- */
let critBytes = 0, critUsedFrac = 0, n = 0;
for (const [sheet, cells] of used) {
  const f = sheetFile(sheet); if (!existsSync(f)) continue;
  const anySprite = (() => {
    for (const [, v] of lookup) for (const l of (v as any).graphics?.layers ?? []) {
      const sps: any[] = l.per === "module-slot" ? l.slots.flatMap((s: any) => [s.empty, ...s.filled])
        : l.per === "heat-connection-patches" ? [...l.connected, ...l.disconnected]
        : !("per" in l) ? [l.sprites] : Object.values(l.sprites);
      for (const sp of sps) if (sp?.sheet === sheet && sp.frameWidth) return sp;
    }
    return null;
  })();
  if (!anySprite) continue;
  const dim = pngDims(sheet); if (!dim) continue;
  const total = Math.max(1, Math.floor(dim[0] / anySprite.frameWidth)) * Math.max(1, Math.floor(dim[1] / anySprite.frameHeight));
  const bytes = statSync(f).size;
  critBytes += bytes; critUsedFrac += bytes * Math.min(1, cells.size / total); n++;
}
console.log(`\n=== Sheets dieser ${n} kritischen Layer ===`);
console.log(`  gesamt ${(critBytes / 1048576).toFixed(1)} MB, davon real genutzt ${(critUsedFrac / 1048576).toFixed(1)} MB`);
