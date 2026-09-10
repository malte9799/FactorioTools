/** Measures the startup data waterfall: game-data.json is awaited fully
 *  before render-catalog.json is even requested (engine/src/data/index.ts:41-48),
 *  though neither depends on the other's contents. Compares sequential vs
 *  parallel against a real local HTTP server serving the actual files. */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";

const FILES = {
  "/data/game-data.json": "apps/site/public/data/game-data.json",
  "/data/render-catalog.json": "apps/site/public/data/render-catalog.json",
  "/data/sprite-icon-manifest.json": "apps/site/public/data/sprite-icon-manifest.json",
};
const bodies = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, readFileSync(v)]));
for (const [k, v] of Object.entries(FILES)) console.log(`${k}: ${(statSync(v).size / 1024).toFixed(0)} KB`);

// Simulate a realistic remote link: added latency + bandwidth cap.
const LATENCY_MS = 40;      // typical RTT to a CDN/Pages host
const MBPS = 20;            // ~20 Mbit/s
const server = createServer(async (req, res) => {
  const body = bodies[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  await new Promise(r => setTimeout(r, LATENCY_MS));
  const transferMs = (body.length * 8) / (MBPS * 1e6) * 1000;
  await new Promise(r => setTimeout(r, transferMs));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\nsimulated link: ${LATENCY_MS}ms RTT, ${MBPS} Mbit/s\n`);

async function sequential() {
  const t0 = performance.now();
  const a = await fetch(base + "/data/game-data.json"); await a.json();
  const b = await fetch(base + "/data/render-catalog.json"); await b.json();
  return performance.now() - t0;
}
async function parallel() {
  const t0 = performance.now();
  const [a, b] = await Promise.all([
    fetch(base + "/data/game-data.json").then(r => r.json()),
    fetch(base + "/data/render-catalog.json").then(r => r.json()),
  ]);
  void a; void b;
  return performance.now() - t0;
}

const runs = 5;
let s = 0, p = 0;
for (let i = 0; i < runs; i++) { s += await sequential(); p += await parallel(); }
s /= runs; p /= runs;
console.log(`TODAY  sequential (index.ts:41 then :47): ${s.toFixed(0)} ms`);
console.log(`FIXED  Promise.all parallel:              ${p.toFixed(0)} ms`);
console.log(`saving on first paint of the renderer:    ${(s - p).toFixed(0)} ms (${((1 - p / s) * 100).toFixed(0)}%)`);
server.close();
