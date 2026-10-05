/** Per example blueprint: sprite bytes downloaded and RGBA bytes held once
 *  decoded — the same sheet set rebuildIndices preloads.
 *
 *    npx tsx audit/2026-10/scripts/bench-payload.ts */
import { readFileSync, statSync, existsSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../../packages/engine/src/index.js";
import { buildVisualLookup } from "../../../packages/renderer/src/entityLookup.js";
const data = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const info = new Map<string, { disk: number; dec: number }>();
const sheetInfo = (s: string) => { let i = info.get(s); if (!i) { const f = "apps/site/public/data/sprites/entities/" + s.split("/").pop(); if (!existsSync(f)) { i = { disk: 0, dec: 0 }; } else { const b = readFileSync(f); i = { disk: b.length, dec: b.readUInt32BE(16) * b.readUInt32BE(20) * 4 }; } info.set(s, i); } return i; };
const rows: { disk: number; dec: number; n: number }[] = [];
for (const ex of examples) {
  const sheets = new Set<string>();
  for (const bp of collectBlueprints(decodeBlueprintString(ex.bp))) for (const e of normaliseEntities(bp)) {
    const v: any = lookup.get(e.name);
    for (const layer of v?.graphics?.layers ?? []) {
      const sprites = !("per" in layer) ? [layer.sprites] : layer.per === "heat-connection-patches" ? [...layer.connected, ...layer.disconnected] : layer.per === "module-slot" ? layer.slots.flatMap((s: any) => [s.empty, ...s.filled.map((p: any) => p.sprite)]) : Object.values(layer.sprites);
      for (const sp of sprites as any[]) { if (sp.sheet) sheets.add(sp.sheet); for (const s of sp.sheets ?? []) sheets.add(s); }
    }
    const ins = v?.inserterGraphics; if (ins) { sheets.add(ins.platform.sheet); sheets.add(ins.handBase.sheet); sheets.add(ins.handOpen.sheet); }
  }
  let disk = 0, dec = 0; for (const s of sheets) { const i = sheetInfo(s); disk += i.disk; dec += i.dec; }
  rows.push({ disk, dec, n: ex.entities });
}
const q = (arr: number[], p: number) => [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)]!;
const MB = (b: number) => (b / 1e6).toFixed(1) + " MB";
for (const k of ["disk", "dec"] as const) console.log(k === "disk" ? "download (sprite PNGs)" : "decoded RGBA in memory", "median", MB(q(rows.map((r) => r[k]), 0.5)), "p90", MB(q(rows.map((r) => r[k]), 0.9)), "max", MB(Math.max(...rows.map((r) => r[k]))));
