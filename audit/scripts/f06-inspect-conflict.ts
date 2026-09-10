/** Zeigt für ein Sheet alle Sprite-Deskriptoren, die es referenzieren —
 *  Diagnosehilfe für die als "widersprüchlich" übersprungenen Sheets. */
import { readFileSync } from "node:fs";
import type { GameData, RenderCatalog } from "../../packages/engine/src/index.js";
import { buildVisualLookup } from "../../packages/renderer/src/entityLookup.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);

function spritesOfLayer(layer: any): any[] {
  if (!("per" in layer)) return [layer.sprites];
  if (layer.per === "heat-connection-patches") return [...(layer.connected ?? []), ...(layer.disconnected ?? [])];
  if (layer.per === "module-slot") return (layer.slots ?? []).flatMap((s: any) => [s.empty, ...(s.filled ?? [])]);
  return Object.values(layer.sprites ?? {});
}

const target = process.argv[2]!;
for (const [n, v] of lookup) {
  for (const l of (v as any).graphics?.layers ?? []) {
    for (const sp of spritesOfLayer(l)) {
      if (!sp?.frameWidth) continue;
      const sh: string[] = sp.sheets ?? [sp.sheet];
      if (!sh.some((s) => s && s.split("/").pop() === target)) continue;
      console.log(n.padEnd(24), JSON.stringify({ fw: sp.frameWidth, fh: sp.frameHeight,
        x: sp.x ?? 0, y: sp.y ?? 0, cols: sp.columns, per: l.per,
        col: l.column?.by, row: l.row?.by, nSheets: sp.sheets?.length }));
    }
  }
}
