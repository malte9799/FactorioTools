/** Was kostet das Aufzeichnen selbst? Die PaintTally läuft pro Draw-Command,
 *  also muss geprüft werden, ob sie die gemessenen Zeiten verfälscht. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
const R = "";
const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));
const ctxStub: any = new Proxy({}, { get(_t, p) { if (p === "createPattern") return () => ({ setTransform() {} }); if (p === "canvas") return undefined; return () => {}; }, set() { return true; } });
function makeElement(): any { const el: any = { style: {}, dataset: {}, children: [], hidden: false, width: 3200, height: 1800, getContext: () => ctxStub, addEventListener() {}, removeEventListener() {}, appendChild(c: any) { el.children.push(c); return c; }, replaceChildren() {}, setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }), querySelector: () => null, remove() {} }; return el; }
let rafQueue: (() => void)[] = [];
(globalThis as any).window = { devicePixelRatio: 2, innerWidth: 1600, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { createElement: () => makeElement(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return 1; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).DOMMatrix = class { scale() { return this; } };
(globalThis as any).createImageBitmap = () => Promise.resolve({ width: 1024, height: 1024, close() {} });
(globalThis as any).fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}), json: () => Promise.resolve({}) });
(globalThis as any).Image = class { decoding = ""; private _o: any; set onload(f: any) { this._o = f; queueMicrotask(() => f?.()); } get onload() { return this._o; } set onerror(_f: any) {} set src(_v: string) {} decode() { return Promise.resolve(); } get width() { return 1024; } get height() { return 1024; } };

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const renderer = mountRenderer(makeElement(), data, catalog);
const pump = (n = 1) => { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } };
const ex = [...examples].sort((a, b) => b.entities - a.entities)[0]!;
const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
renderer.loadBlueprint(entities);
renderer.setAnimationFrozen(true);
pump(3); await new Promise((r) => setTimeout(r, 400)); pump(3);

function measure(label: string, recording: boolean): number {
  if (recording) renderer.startFrameRecording(60); else renderer.stopFrameRecording();
  // Aufwärmen
  for (let i = 0; i < 20; i++) renderer.stepAnimationFrame(0);
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) renderer.stepAnimationFrame(0);
  const ms = (performance.now() - t0) / N;
  renderer.stopFrameRecording();
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(3)} ms/Frame`);
  return ms;
}
console.log(`Blueprint: ${entities.length} Entities, ${renderer.getDebugStats().drawCommands} Draw-Commands\n`);
const off = measure("ohne Aufzeichnung", false);
const on  = measure("mit Aufzeichnung", true);
const off2 = measure("ohne (Gegenprobe)", false);
const base = (off + off2) / 2;
console.log(`\nOverhead: ${(on - base).toFixed(3)} ms/Frame = ${(100 * (on - base) / base).toFixed(1)} %`);
