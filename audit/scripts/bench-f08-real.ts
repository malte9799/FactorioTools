/** Misst die ECHTE loadData()-Implementierung (nicht eine Nachbildung) gegen
 *  einen lokalen HTTP-Server mit simulierter Latenz/Bandbreite. Vergleicht
 *  den sequenziellen Alt-Stand mit dem neuen parallelen. */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { loadData } from "../../packages/engine/src/data/index.js";

const FILES: Record<string, string> = {
  "/data/game-data.json": "apps/site/public/data/game-data.json",
  "/data/render-catalog.json": "apps/site/public/data/render-catalog.json",
};
const bodies = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, readFileSync(v)]));
for (const [k, v] of Object.entries(FILES)) console.log(`${k}: ${(statSync(v).size / 1024).toFixed(0)} KB`);

const LATENCY_MS = 40, MBPS = 20;
const server = createServer(async (req, res) => {
  const body = bodies[req.url!];
  if (!body) { res.writeHead(404); res.end(); return; }
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  await new Promise((r) => setTimeout(r, (body.length * 8) / (MBPS * 1e6) * 1000));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
console.log(`\nsimuliert: ${LATENCY_MS} ms RTT, ${MBPS} Mbit/s\n`);

/** Der Stand VOR der Änderung, wortgleich nachgebildet. */
async function loadDataSequential(gameDataUrl: string) {
  try {
    const res = await fetch(gameDataUrl);
    if (res.ok) {
      const data = await res.json();
      const catalogUrl = gameDataUrl.replace(/game-data\.json$/, "render-catalog.json");
      try {
        const catalogRes = await fetch(catalogUrl);
        if (catalogRes.ok) await catalogRes.json();
      } catch { /* ignore */ }
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

const RUNS = 7;
const time = async (fn: () => Promise<unknown>) => {
  await fn();
  let total = 0;
  for (let i = 0; i < RUNS; i++) { const t = performance.now(); await fn(); total += performance.now() - t; }
  return total / RUNS;
};

const before = await time(() => loadDataSequential(base + "/data/game-data.json"));
const after = await time(() => loadData(base + "/data/game-data.json"));

console.log(`VORHER  (sequenziell, Alt-Stand):        ${before.toFixed(0)} ms`);
console.log(`NACHHER (loadData, echt, parallel):      ${after.toFixed(0)} ms`);
console.log(`Ersparnis:                                ${(before - after).toFixed(0)} ms (${((1 - after / before) * 100).toFixed(0)} %)`);

// Korrektheit: liefert die neue Fassung dieselben Daten und den Katalog?
const { getData, getRenderCatalog } = await import("../../packages/engine/src/data/index.js");
await loadData(base + "/data/game-data.json");
const d = getData(), c = getRenderCatalog();
console.log(`\nKorrektheit: machines=${Object.keys(d.machines).length}, catalog-entities=${Object.keys(c.entities).length}, catalog.version=${c.version}`);
server.close();
