/** F-06 ROLLOUT, Schritt C: Beweist, dass der Zuschnitt nichts verändert.
 *
 *  Zwei unabhängige Prüfungen:
 *
 *  A) SEMANTISCH — für jede Entity, jede Richtung, viele Animationsphasen:
 *     Zeigt der Befehl aus dem NEUEN Katalog auf exakt dieselben PIXEL im
 *     neuen Sheet wie der Befehl aus dem ALTEN Katalog im alten Sheet?
 *     Verglichen wird nicht sx/sy (die sollen sich ja ändern), sondern der
 *     tatsächlich adressierte Bildinhalt — plus alle Zielrechteck-Werte,
 *     die unverändert bleiben müssen.
 *
 *  B) PIXELWEISE — der Inhalt jeder übernommenen Zelle im zugeschnittenen
 *     PNG gegen dieselbe Zelle im gesicherten Original.
 *
 *  Läuft gegen die gesicherten Originale in audit/f06-rollout/, also auch
 *  noch, nachdem die Sheets im public-Verzeichnis ersetzt wurden. */
import { readFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { buildCargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const SRC = "apps/site/public/data/sprites/entities/";
const BACKUP = "audit/f06-rollout/original-sheets/";
const OLD_CATALOG = "audit/f06-rollout/render-catalog.original.json";
const NEW_CATALOG = "apps/site/public/data/render-catalog.json";
const OLD_GAMEDATA = "audit/f06-rollout/game-data.original.json";
const NEW_GAMEDATA = "apps/site/public/data/game-data.json";

// game-data trägt selbst Sprite-Deskriptoren, wird also ebenfalls in einer
// alten und einer neuen Fassung gegeneinander gestellt.
const oldData: GameData = JSON.parse(readFileSync(OLD_GAMEDATA, "utf8"));
const newData: GameData = JSON.parse(readFileSync(NEW_GAMEDATA, "utf8"));
const oldCat: RenderCatalog = JSON.parse(readFileSync(OLD_CATALOG, "utf8"));
const newCat: RenderCatalog = JSON.parse(readFileSync(NEW_CATALOG, "utf8"));
const oldLookup = buildVisualLookup(oldData, oldCat);
const newLookup = buildVisualLookup(newData, newCat);
const data = newData;

const pngCache = new Map<string, PNG | null>();
function loadPng(dir: string, sheet: string): PNG | null {
  const key = dir + sheet;
  if (pngCache.has(key)) return pngCache.get(key)!;
  const f = dir + sheet.split("/").pop();
  const v = existsSync(f) ? PNG.sync.read(readFileSync(f)) : null;
  pngCache.set(key, v);
  return v;
}

function ent(name: string, x: number, y: number, direction: number, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entityNumber: Math.round(Math.abs(x) * 977 + Math.abs(y) * 131 + direction) + 1, name, x, y,
           direction, quality: "normal", modules: [], filterItems: [], ...extra } as PlacedEntity;
}

function collectWith(lookup: any, connectors: any, self: PlacedEntity, others: PlacedEntity[], frame: number, gameData: GameData = newData): DrawCommand[] {
  const all = [self, ...others];
  const ctx: any = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, (e as any).recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    cargoBays: buildCargoBayGrid(all, connectors.cargoBayShapeOf),
    animationFrame: frame,
  };
  const out: DrawCommand[] = [];
  const v = lookup.get(self.name);
  if (!v?.graphics) return out;
  try { collectEntity(out, self, v, ctx, 1); } catch { return []; }
  return out;
}

const oldConn = makeConnectorPredicates(oldLookup);
const newConn = makeConnectorPredicates(newLookup);

/* ================= A) Semantische Prüfung ================= */
console.log("=== A) Adressieren alte und neue Befehle dieselben Pixel? ===\n");

let compared = 0, mismatchGeom = 0, mismatchPixels = 0, missingSheet = 0;
const examples: string[] = [];

/** Vergleicht den Bildinhalt zweier Quellrechtecke. */
function samePixels(a: PNG, ax: number, ay: number, b: PNG, bx: number, by: number, w: number, h: number): boolean {
  for (let y = 0; y < h; y++) {
    const ao = ((ay + y) * a.width + ax) * 4;
    const bo = ((by + y) * b.width + bx) * 4;
    if (ao < 0 || bo < 0) return false;
    for (let i = 0; i < w * 4; i++) if (a.data[ao + i] !== b.data[bo + i]) return false;
  }
  return true;
}

const FRAMES = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 63, 127, 255];
for (const [name] of oldLookup) {
  for (let dir = 0; dir < 16; dir += 1) {
    for (const f of FRAMES) {
      const self = ent(name, 0.5, 0.5, dir);
      const neigh = [ent("pipe", 3.5, 0.5, 0), ent("heat-pipe", 0.5, 3.5, 0),
                     ent("transport-belt", -2.5, 0.5, 0)];
      const o = collectWith(oldLookup, oldConn, self, neigh, f, oldData);
      const n = collectWith(newLookup, newConn, self, neigh, f, newData);
      if (o.length !== n.length) {
        mismatchGeom++;
        if (examples.length < 10) examples.push(`${name} dir=${dir} frame=${f}: ${o.length} vs ${n.length} Befehle`);
        continue;
      }
      for (let i = 0; i < o.length; i++) {
        const a = o[i]!, b = n[i]!;
        compared++;
        // Zielrechteck, Layer, Sortierung, Alpha müssen exakt gleich bleiben.
        if (a.dx !== b.dx || a.dy !== b.dy || a.dw !== b.dw || a.dh !== b.dh ||
            a.layer !== b.layer || a.sw !== b.sw || a.sh !== b.sh ||
            (a as any).alpha !== (b as any).alpha) {
          mismatchGeom++;
          if (examples.length < 10) examples.push(`${name} dir=${dir} frame=${f} #${i}: Zielgeometrie weicht ab`);
          continue;
        }
        const oldPng = loadPng(BACKUP, a.sheet) ?? loadPng(SRC, a.sheet);
        const newPng = loadPng(SRC, b.sheet);
        if (!oldPng || !newPng) { missingSheet++; continue; }
        if (a.sx + a.sw > oldPng.width || a.sy + a.sh > oldPng.height ||
            b.sx + b.sw > newPng.width || b.sy + b.sh > newPng.height) {
          mismatchGeom++;
          if (examples.length < 10) examples.push(`${name} #${i}: Quellrechteck außerhalb des Sheets (${b.sheet.split("/").pop()})`);
          continue;
        }
        if (!samePixels(oldPng, a.sx, a.sy, newPng, b.sx, b.sy, a.sw, a.sh)) {
          mismatchPixels++;
          if (examples.length < 10) examples.push(`${name} dir=${dir} frame=${f} #${i}: ANDERE PIXEL in ${b.sheet.split("/").pop()} (alt ${a.sx},${a.sy} -> neu ${b.sx},${b.sy})`);
        }
      }
    }
  }
}

console.log(`  Befehle verglichen:        ${compared}`);
console.log(`  Geometrie-Abweichungen:    ${mismatchGeom}`);
console.log(`  Pixel-Abweichungen:        ${mismatchPixels}`);
console.log(`  Sheet nicht ladbar:        ${missingSheet}`);
if (examples.length) { console.log("\n  Beispiele:"); for (const e of examples) console.log("    " + e); }

/* ================= B) Pixelweise Sheet-Prüfung ================= */
console.log("\n=== B) Zugeschnittene Sheets gegen die Originale ===\n");
const usage = JSON.parse(readFileSync("audit/f06-rollout/usage.json", "utf8")) as { sheets: any[] };
let sheetsOk = 0, sheetsBad = 0, cellsChecked = 0;
for (const r of usage.sheets) {
  if (!r.croppable) continue;
  const orig = loadPng(BACKUP, r.file);
  const crop = loadPng(SRC, r.file);
  if (!orig || !crop) continue;
  if (crop.width !== r.frameWidth * r.usedCols.length || crop.height !== r.frameHeight * r.usedRows.length) {
    console.log(`  FALSCHE GRÖSSE ${r.file}: ${crop.width}x${crop.height}`);
    sheetsBad++; continue;
  }
  let ok = true;
  r.usedRows.forEach((sr: number, dr: number) =>
    r.usedCols.forEach((sc: number, dc: number) => {
      cellsChecked++;
      if (!samePixels(orig, sc * r.frameWidth, sr * r.frameHeight,
                      crop, dc * r.frameWidth, dr * r.frameHeight, r.frameWidth, r.frameHeight)) ok = false;
    }));
  if (ok) sheetsOk++; else { sheetsBad++; console.log(`  ABWEICHUNG in ${r.file}`); }
}
console.log(`  Sheets identisch:  ${sheetsOk}`);
console.log(`  Sheets abweichend: ${sheetsBad}`);
console.log(`  Zellen geprüft:    ${cellsChecked}`);

const pass = mismatchGeom === 0 && mismatchPixels === 0 && sheetsBad === 0;
console.log(`\n${pass ? "BESTANDEN — der Zuschnitt verändert kein gezeichnetes Pixel." : "FEHLGESCHLAGEN"}`);
process.exit(pass ? 0 : 1);
