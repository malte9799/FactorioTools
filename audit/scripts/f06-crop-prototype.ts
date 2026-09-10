/** F-06 SCHRITT 2: Prototypischer Zuschnitt für GENAU EINE Entity-Familie
 *  (recycler, 4 Richtungs-Sheets, zusammen ~14,6 MB, davon je 1 von 64 Zellen
 *  genutzt).
 *
 *  Wichtig — Lehre aus Schritt 1: Der Zuschnitt stützt sich NICHT auf
 *  column.by/row.by, sondern auf die real beobachteten Zellen aus einem
 *  collectEntity-Lauf. Bei nuclear-reactor läge das Achsen-Modell um Faktor 12
 *  daneben.
 *
 *  Schreibt NUR nach audit/f06/, fasst weder public/data/sprites noch den
 *  Katalog an. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { PNG } from "pngjs";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const FAMILY = "recycler";
const OUT = "audit/f06";
mkdirSync(OUT, { recursive: true });

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);
const SRC = "apps/site/public/data/sprites/entities/";

const visual: any = lookup.get(FAMILY);
if (!visual?.graphics) { console.error(`${FAMILY} hat keine Grafik im Katalog`); process.exit(1); }

/* --- 1. Real genutzte Zellen ermitteln (alle 16 Richtungen, mehrere Frames) --- */
const usedCells = new Map<string, Set<string>>();
const spriteOf = new Map<string, any>();
for (const layer of visual.graphics.layers ?? []) {
  const sprites: any[] = !("per" in layer) ? [layer.sprites]
    : layer.per === "heat-connection-patches" ? [...layer.connected, ...layer.disconnected]
    : layer.per === "module-slot" ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled])
    : Object.values(layer.sprites);
  for (const sp of sprites) if (sp?.sheet && sp.frameWidth) spriteOf.set(sp.sheet, sp);
}

for (let dir = 0; dir < 16; dir++) {
  for (const frame of [0, 1, 2, 3, 7, 15, 31, 63]) {
    const self: PlacedEntity = { entityNumber: 1, name: FAMILY, x: 0.5, y: 0.5, direction: dir,
      quality: "normal", modules: [], filterItems: [] };
    const all = [self];
    const ctx: any = {
      grid: buildGrid(all),
      fluidNetwork: buildFluidNetwork(all, (e) => {
        const p = lookup.get(e.name)?.pipeConnections;
        return p && activeFluidConnections(p, e.recipe, data);
      }),
      heatNetwork: buildHeatNetwork(all, (n) => lookup.get(n)?.heatConnections),
      ...connectors, platformBoxes: [], animationFrame: frame,
    };
    const cmds: DrawCommand[] = [];
    collectEntity(cmds, self, visual, ctx, 1);
    for (const c of cmds) {
      let s = usedCells.get(c.sheet); if (!s) usedCells.set(c.sheet, (s = new Set()));
      s.add(`${c.sx},${c.sy}`);
    }
  }
}

/* --- 2. Zuschneiden --- */
console.log(`=== F-06 Prototyp: ${FAMILY} ===\n`);
let beforeTotal = 0, afterTotal = 0;
const report: any[] = [];

for (const [sheet, cells] of usedCells) {
  const sp = spriteOf.get(sheet);
  const file = SRC + sheet.split("/").pop();
  if (!sp || !existsSync(file)) continue;

  const png = PNG.sync.read(readFileSync(file));
  const fw = sp.frameWidth, fh = sp.frameHeight;
  const cols = Math.max(1, Math.floor(png.width / fw));
  const rows = Math.max(1, Math.floor(png.height / fh));

  // Beobachtete (sx,sy) sind Pixelkoordinaten der Zelle -> Zellindex
  const coords = [...cells].map((k) => { const [sx, sy] = k.split(",").map(Number); return { cx: Math.round(sx! / fw), cy: Math.round(sy! / fh) }; });
  const usedCols = [...new Set(coords.map((c) => c.cx))].sort((a, b) => a - b);
  const usedRows = [...new Set(coords.map((c) => c.cy))].sort((a, b) => a - b);

  const out = new PNG({ width: fw * usedCols.length, height: fh * usedRows.length });
  out.data.fill(0);
  usedRows.forEach((srcRow, r) =>
    usedCols.forEach((srcCol, c) =>
      PNG.bitblt(png, out, srcCol * fw, srcRow * fh, fw, fh, c * fw, r * fh)));

  const base = sheet.split("/").pop()!;
  const outFile = `${OUT}/${base.replace(/\.png$/, "")}-cropped.png`;
  writeFileSync(outFile, PNG.sync.write(out));

  const before = statSync(file).size, after = statSync(outFile).size;
  beforeTotal += before; afterTotal += after;
  console.log(`  ${base}`);
  console.log(`    Sheet ${png.width}x${png.height} = ${cols}x${rows} Zellen, genutzt ${cells.size}`);
  console.log(`    Spalten ${JSON.stringify(usedCols)}, Zeilen ${JSON.stringify(usedRows)}`);
  console.log(`    ${(before / 1048576).toFixed(2)} MB -> ${(after / 1024).toFixed(0)} KB  (-${(100 - after / before * 100).toFixed(1)} %)`);
  report.push({ sheet: base, beforeBytes: before, afterBytes: after, usedCols, usedRows,
                totalCells: cols * rows, usedCells: cells.size,
                newColumns: usedCols.length, newFrameWidth: fw, newFrameHeight: fh });
}

console.log(`\n  GESAMT ${FAMILY}: ${(beforeTotal / 1048576).toFixed(1)} MB -> ${(afterTotal / 1024).toFixed(0)} KB  (-${(100 - afterTotal / beforeTotal * 100).toFixed(1)} %)`);
writeFileSync(`${OUT}/crop-report.json`, JSON.stringify({ family: FAMILY, beforeBytes: beforeTotal, afterBytes: afterTotal, sheets: report }, null, 2));
console.log(`\n  Bericht: ${OUT}/crop-report.json`);
console.log(`  Zugeschnittene PNGs: ${OUT}/*-cropped.png (NICHT im Projekt aktiviert)`);
