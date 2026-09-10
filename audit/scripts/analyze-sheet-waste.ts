/** The per-blueprint payload is dominated by a few huge sheets. How much of
 *  each sheet does the renderer actually USE? A sheet holding 64 animation
 *  frames costs its full byte size even if the viewer only ever draws one. */
import { readFileSync, statSync, existsSync } from "node:fs";
import type { GameData, RenderCatalog } from "../../packages/engine/src/index.js";
import { buildVisualLookup } from "../../packages/renderer/src/entityLookup.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);

type Use = { sheet: string; file: string; bytes: number; users: Set<string>; frames: number; anim: boolean };
const sheets = new Map<string, Use>();

for (const [name, visual] of lookup) {
  const consider = (s: any, animAxis: boolean) => {
    if (!s?.sheet) return;
    const file = "apps/site/public/data/sprites/entities/" + s.sheet.split("/").pop();
    let u = sheets.get(s.sheet);
    if (!u) {
      u = { sheet: s.sheet, file, bytes: existsSync(file) ? statSync(file).size : 0, users: new Set(), frames: 0, anim: false };
      sheets.set(s.sheet, u);
    }
    u.users.add(name);
    if (animAxis) u.anim = true;
  };
  for (const layer of (visual as any).graphics?.layers ?? []) {
    const isAnim = JSON.stringify(layer).includes('"animation"');
    const sprites: any[] = !("per" in layer) ? [layer.sprites]
      : layer.per === "heat-connection-patches" ? [...layer.connected, ...layer.disconnected]
      : layer.per === "module-slot" ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled])
      : Object.values(layer.sprites);
    for (const s of sprites) consider(s, isAnim);
  }
  const ins = (visual as any).inserterGraphics;
  if (ins) { consider(ins.platform, false); consider(ins.handBase, false); consider(ins.handOpen, false); }
}

const rows = [...sheets.values()].sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((a, b) => a + b.bytes, 0);
console.log(`sheets referenced by the catalog: ${rows.length}, total ${(total/1048576).toFixed(0)} MB\n`);
console.log("=== 20 heaviest sheets ===");
for (const r of rows.slice(0, 20))
  console.log(`  ${(r.bytes/1048576).toFixed(1).padStart(5)} MB  anim=${r.anim ? "Y" : "n"}  used by ${String(r.users.size).padStart(2)}  ${r.sheet.split("/").pop()}`);

const animBytes = rows.filter(r => r.anim).reduce((a, b) => a + b.bytes, 0);
console.log(`\nanimated sheets: ${rows.filter(r=>r.anim).length} files, ${(animBytes/1048576).toFixed(0)} MB (${(animBytes/total*100).toFixed(0)}% of referenced bytes)`);
const top20 = rows.slice(0,20).reduce((a,b)=>a+b.bytes,0);
console.log(`top 20 sheets alone: ${(top20/1048576).toFixed(0)} MB (${(top20/total*100).toFixed(0)}% of referenced bytes)`);

// Sheets referenced by the catalog but never by a real vanilla entity users could place
console.log(`\nsheets referenced by exactly 1 entity: ${rows.filter(r=>r.users.size===1).length}`);
