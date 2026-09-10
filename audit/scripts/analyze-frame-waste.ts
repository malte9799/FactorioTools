/** For every referenced sheet, computes which frame cells the renderer can
 *  EVER address (given each layer's column/row axes) versus how many cells the
 *  sheet physically contains. Cells that can never be addressed are pure
 *  downloaded waste. */
import { readFileSync, statSync, existsSync } from "node:fs";
import type { GameData, RenderCatalog } from "../../packages/engine/src/index.js";
import { buildVisualLookup } from "../../packages/renderer/src/entityLookup.js";
import { execSync } from "node:child_process";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);

function pngSize(file: string): [number, number] | null {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file, { flag: "r" });
  // IHDR width/height at bytes 16..24
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// How many distinct values can each axis take?
function axisCardinality(axis: any): number {
  if (!axis || axis.by === "none") return 1;
  switch (axis.by) {
    case "direction": return 4;
    case "direction8": return 8;
    case "direction16": case "direction256": return 16;
    case "animation": return Infinity; // uses whatever the sheet has
    case "connection": return 16;
    default: return Infinity;
  }
}

type Row = { sheet: string; bytes: number; cells: number; used: number; wastedBytes: number; axes: string };
const seen = new Map<string, Row>();

for (const [, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    const sprites: any[] = !("per" in layer) ? [layer.sprites]
      : layer.per === "heat-connection-patches" ? [...layer.connected, ...layer.disconnected]
      : layer.per === "module-slot" ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled])
      : Object.values(layer.sprites);
    for (const s of sprites) {
      if (!s?.sheet || !s.frameWidth) continue;
      const file = "apps/site/public/data/sprites/entities/" + s.sheet.split("/").pop();
      const dim = pngSize(file);
      if (!dim) continue;
      const [w, h] = dim;
      const cols = Math.max(1, Math.floor(w / s.frameWidth));
      const rows_ = Math.max(1, Math.floor(h / s.frameHeight));
      const cells = cols * rows_;
      const usedCols = Math.min(cols, axisCardinality(layer.column));
      const usedRows = Math.min(rows_, axisCardinality(layer.row));
      const used = Math.min(cells, usedCols * usedRows);
      const bytes = statSync(file).size;
      const key = s.sheet;
      const prev = seen.get(key);
      // A sheet shared by several entities: keep the most generous usage.
      if (!prev || used > prev.used) {
        seen.set(key, { sheet: key, bytes, cells, used,
          wastedBytes: Math.round(bytes * (1 - used / cells)),
          axes: `col=${layer.column?.by ?? "none"},row=${layer.row?.by ?? "none"}` });
      }
    }
  }
}

const rows = [...seen.values()].sort((a, b) => b.wastedBytes - a.wastedBytes);
const totalBytes = rows.reduce((a, b) => a + b.bytes, 0);
const totalWaste = rows.reduce((a, b) => a + b.wastedBytes, 0);
console.log(`sheets analysed: ${rows.length}, total ${(totalBytes/1048576).toFixed(0)} MB`);
console.log(`never-addressable frame bytes: ${(totalWaste/1048576).toFixed(0)} MB (${(totalWaste/totalBytes*100).toFixed(0)}%)\n`);
console.log("=== 20 sheets with the most unused frames ===");
for (const r of rows.slice(0, 20))
  console.log(`  ${(r.bytes/1048576).toFixed(1).padStart(5)} MB  uses ${String(r.used).padStart(3)}/${String(r.cells).padEnd(4)} cells  waste ${(r.wastedBytes/1048576).toFixed(1).padStart(5)} MB  ${r.axes.padEnd(28)} ${r.sheet.split("/").pop()}`);
