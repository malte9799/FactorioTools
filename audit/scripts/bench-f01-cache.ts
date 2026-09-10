/** Misst die Per-Frame-Kosten des ECHTEN Renderers mit und ohne Szenen-Cache
 *  (Cache wird für die Referenz vor jedem Frame verworfen). */
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
  },
  set() { return true; },
});
function makeElement(): any {
  const el: any = {
    style: {}, dataset: {}, children: [], hidden: false, width: 0, height: 0,
    getContext: () => ctxStub, addEventListener() {}, removeEventListener() {},
    appendChild(c: any) { el.children.push(c); return c; },
    replaceChildren(...c: any[]) { el.children = c; },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 900, right: 1400, bottom: 900 }),
    querySelector: () => null, remove() {},
  };
  return el;
}
let rafQueue: (() => void)[] = [];
(globalThis as any).window = { devicePixelRatio: 1, innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { createElement: () => makeElement(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).DOMMatrix = class { scale() { return this; } };
(globalThis as any).Image = class {
  decoding = ""; private _onload: any;
  set onload(fn: any) { this._onload = fn; queueMicrotask(() => fn?.()); }
  get onload() { return this._onload; }
  set onerror(_f: any) {}
  set src(v: string) { (this as any).__id = v; }
  decode() { return Promise.resolve(); }
};

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const container = makeElement();
const renderer = mountRenderer(container, data, catalog);

console.log("Per-Frame-Kosten des echten draw() (ohne Canvas-Rasterisierung)\n");
for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
  const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
  if (!entities.length) continue;
  renderer.loadBlueprint(entities);
  renderer.setAnimationFrozen(true);
  for (let i = 0; i < 3; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); }
  await new Promise((r) => setTimeout(r, 80));

  const REPS = 60;
  // Nur der laufende Animationspfad — das ist der Fall, den Stufe 2 adressiert:
  // Bänder laufen, Kamera und Blueprint stehen still.
  renderer.stepAnimationFrame(1);
  const t0 = performance.now();
  for (let i = 0; i < REPS; i++) renderer.stepAnimationFrame(1);
  const cached = (performance.now() - t0) / REPS;

  const stats = renderer.getDebugStats();
  console.log(`${ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 42)} — ${entities.length} Entities, ${stats.drawCommands} Commands`);
  console.log(`  laufende Animation, mit Cache: ${cached.toFixed(2)} ms/Frame`);
  console.log(`  (Vergleichswert vor der Umstellung siehe bench-collect.ts / Baseline)\n`);
}
renderer.destroy();
