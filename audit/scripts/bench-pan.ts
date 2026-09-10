/** Misst, was ein PAN kostet — der Fall, den der Nutzer als ruckelig meldet.
 *  Beim Schwenken ändert sich der sichtbare Entity-Satz laufend, der
 *  Szenen-Cache verfehlt also und wird neu gebaut. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "createPattern") return () => ({ setTransform() {} });
    if (prop === "canvas") return undefined;
    return () => {};
  }, set() { return true; },
});
function makeElement(): any {
  const el: any = { style: {}, dataset: {}, children: [], hidden: false, width: 0, height: 0,
    getContext: () => ctxStub, addEventListener() {}, removeEventListener() {},
    appendChild(c: any) { el.children.push(c); return c; }, replaceChildren() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => null, remove() {} };
  return el;
}
let rafQueue: (() => void)[] = [];
(globalThis as any).window = { devicePixelRatio: 2, innerWidth: 1600, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { createElement: () => makeElement(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return 1; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).DOMMatrix = class { scale() { return this; } };
(globalThis as any).Image = class {
  decoding = ""; private _o: any;
  set onload(f: any) { this._o = f; queueMicrotask(() => f?.()); }
  get onload() { return this._o; }
  set onerror(_f: any) {} set src(v: string) { (this as any).__id = v; }
  decode() { return Promise.resolve(); }
};

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const renderer = mountRenderer(makeElement(), data, catalog);
const pump = (n = 1) => { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } };

for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 2)) {
  const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
  if (!entities.length) continue;
  renderer.loadBlueprint(entities);
  renderer.setAnimationFrozen(true);
  pump(3);
  await new Promise((r) => setTimeout(r, 80));
  pump(2);

  // 1) STILLSTAND: Cache trifft
  let t0 = performance.now();
  for (let i = 0; i < 30; i++) pump(1);
  const still = (performance.now() - t0) / 30;

  // 2) PAN: jeder Frame verschiebt die Kamera um 6 px, wie beim Ziehen
  t0 = performance.now();
  for (let i = 0; i < 30; i++) { renderer.camera.panByScreenDelta(6, 2); pump(1); }
  const panning = (performance.now() - t0) / 30;

  // 3) ZOOM
  t0 = performance.now();
  for (let i = 0; i < 20; i++) { renderer.camera.zoomAt(1.02, 800, 450, 1600, 900); pump(1); }
  const zooming = (performance.now() - t0) / 20;

  console.log(`\n=== ${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 42)} — ${entities.length} Entities ===`);
  console.log(`  Stillstand: ${still.toFixed(2)} ms/Frame`);
  console.log(`  PAN:        ${panning.toFixed(2)} ms/Frame   <-- ${panning > 16.7 ? "ÜBER BUDGET" : "ok"}`);
  console.log(`  ZOOM:       ${zooming.toFixed(2)} ms/Frame   <-- ${zooming > 16.7 ? "ÜBER BUDGET" : "ok"}`);
}
renderer.destroy();
