/** Headless frame harness for the 2026-10 audit: the real renderer with a
 *  stubbed canvas and a fake clock, so the maxFps cap never skips a frame.
 *  Measures JavaScript cost only — drawImage is a no-op that, while
 *  globalThis.__rec is set, hashes its arguments into globalThis.__h. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../../packages/engine/src/index.js";

export const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
export const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
export const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "createPattern") return () => ({ setTransform() {} });
    if (prop === "getImageData") return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)) });
    if (prop === "measureText") return () => ({ width: 10 });
    if (prop === "canvas") return undefined;
    if (prop === "drawImage") return (...a: any[]) => { const g = globalThis as any; if (g.__rec) { let h = g.__h | 0; const str = a.map((v) => typeof v === "number" ? v.toFixed(4) : (v && v.__id) || typeof v).join(","); for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0; g.__h = h; g.__n = (g.__n | 0) + 1; } };
    return () => {};
  }, set() { return true; },
});
function makeElement(): any {
  const el: any = { style: {}, dataset: {}, children: [], hidden: false, width: 1, height: 1,
    getContext: () => ctxStub, addEventListener() {}, removeEventListener() {},
    appendChild(c: any) { el.children.push(c); return c; }, replaceChildren() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    querySelector: () => null, remove() {} };
  return el;
}
const realNow = performance.now.bind(performance);
let fakeNow = 1000;
export const clock = { advance(ms = 16.7) { fakeNow += ms; } };
(performance as any).now = () => fakeNow + (realNow() % 1); // monotonic-ish within a tick
let rafQueue: (() => void)[] = [];
(globalThis as any).window = { devicePixelRatio: 2, innerWidth: 1600, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { createElement: () => makeElement(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return 1; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { constructor(public cb: any) {} observe() { this.cb?.([]); } disconnect() {} };
(globalThis as any).DOMMatrix = class { scale() { return this; } };
(globalThis as any).Image = class {
  decoding = ""; width = 64; height = 64; private _o: any;
  set onload(f: any) { this._o = f; queueMicrotask(() => f?.()); }
  get onload() { return this._o; }
  set onerror(_f: any) {} set src(v: string) { (this as any).__id = v; }
  decode() { return Promise.resolve(); }
};
(globalThis as any).fetch = async () => { throw new Error("no fetch"); };

export const { mountRenderer } = await import("../../../packages/renderer/src/render.js");
export function mount() { return mountRenderer(makeElement(), data, catalog); }
export const pump = (n = 1) => { for (let i = 0; i < n; i++) { clock.advance(); const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } };
export function biggest(n: number): { label: string; entities: PlacedEntity[]; bp: any }[] {
  return [...examples].sort((a, b) => b.entities - a.entities).slice(0, n).map((ex) => {
    const bps = collectBlueprints(decodeBlueprintString(ex.bp));
    const best = bps.map((b: any) => ({ b, e: normaliseEntities(b) })).sort((a: any, b: any) => b.e.length - a.e.length)[0]!;
    return { label: ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 40), entities: best.e, bp: best.b };
  });
}
export function time(fn: () => void, n: number): number {
  for (let i = 0; i < 3; i++) fn();
  const t0 = realNow();
  for (let i = 0; i < n; i++) fn();
  return (realNow() - t0) / n;
}
