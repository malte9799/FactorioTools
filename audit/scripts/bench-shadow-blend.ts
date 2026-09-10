/** Zählt, was die teuren Frames der Nutzer-Aufnahme wirklich zeichnen.
 *
 *  Die Aufnahme zeigt: bei 1200-1600 Draw-Commands springt paint von
 *  ~2,4 ms auf ~327 ms Median — Faktor 136 für 30 % mehr Commands. Das ist
 *  keine Skalierung, das ist eine Klippe. Dieses Skript prüft die naheliegende
 *  Ursache: paintPlain schaltet für Schatten auf globalCompositeOperation
 *  "multiply", und Multiply ist in Canvas 2D ein Software-Blend, dessen
 *  Kosten mit der *überdeckten Fläche* wachsen, nicht mit der Command-Zahl.
 *
 *  Gemessen wird headless, also ohne echten Blend: die Zahl der
 *  Multiply-Commands und die von ihnen bedeckte Zielfläche in Pixeln. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, Layer } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

interface Shot { shadowCmds: number; plainCmds: number; shadowArea: number; plainArea: number; switches: number; }
let shot: Shot | null = null;
let composite = "source-over";

const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "createPattern") return () => ({ setTransform() {} });
    if (prop === "canvas") return undefined;
    if (prop === "globalCompositeOperation") return composite;
    if (prop === "drawImage") return (...a: any[]) => {
      if (!shot || a.length < 9) return;
      const dw = a[7], dh = a[8];
      const area = Math.abs(dw * dh);
      if (composite === "multiply") { shot.shadowCmds++; shot.shadowArea += area; }
      else { shot.plainCmds++; shot.plainArea += area; }
    };
    return () => {};
  },
  set(_t, prop, value) {
    if (prop === "globalCompositeOperation") {
      if (shot && value !== composite) shot.switches++;
      composite = value as string;
    }
    return true;
  },
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
  set onerror(_f: any) {} set src(_v: string) {}
  decode() { return Promise.resolve(); }
  get width() { return 1024; } get height() { return 1024; }
};
(globalThis as any).createImageBitmap = () => Promise.resolve({ width: 1024, height: 1024, close() {} });
(globalThis as any).fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}), json: () => Promise.resolve({}) });

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const renderer = mountRenderer(makeElement(), data, catalog);
const pump = (n = 1) => { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } };

const ex = [...examples].sort((a, b) => b.entities - a.entities)[0]!;
const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp))
  .map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
renderer.loadBlueprint(entities);
renderer.setAnimationFrozen(true);
pump(3);
await new Promise((r) => setTimeout(r, 300));
pump(3);

console.log(`Blueprint: ${entities.length} Entities\n`);
console.log("ppt   | cmds gesamt | Schatten | Anteil | Zielfläche(Mpx) | Overdraw | Umschaltungen");

const cam = renderer.camera;
for (const ppt of [6, 8, 12, 16, 24, 32]) {
  // Über die Kamera selbst zoomen, damit deren onChange den Frame dirty
  // markiert — genau der Pfad, den ein echter Wheel-Zoom nimmt.
  cam.zoomAt(ppt / cam.state.pixelsPerTile, 800, 450, 1600, 900);
  pump(2);
  shot = { shadowCmds: 0, plainCmds: 0, shadowArea: 0, plainArea: 0, switches: 0 };
  renderer.stepAnimationFrame(0);
  const total = shot.shadowCmds + shot.plainCmds;
  const pct = total ? (100 * shot.shadowCmds / total).toFixed(1) : "0.0";
  const allArea = shot.shadowArea + shot.plainArea;
  const viewport = 1600 * 900 * 4; // devicePixelRatio 2 -> Backing-Store
  console.log(`${String(ppt).padStart(4)}  | ${String(total).padStart(11)} | ${String(shot.shadowCmds).padStart(8)} | ${pct.padStart(5)}% | ${(allArea/1e6).toFixed(2).padStart(12)} | ${(allArea/viewport).toFixed(2).padStart(9)}x | ${shot.switches}`);
}
