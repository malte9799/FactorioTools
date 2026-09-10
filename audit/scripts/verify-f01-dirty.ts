/** VERIFIKATION F-01 Stufe 1 ohne Browser.
 *  Der Browser-Pane drosselt requestAnimationFrame in einem versteckten Tab
 *  vollständig (nachgewiesen: rAF feuert dort in 1,5 s kein einziges Mal), da-
 *  mit ist er zum Prüfen einer rAF-Schleife ungeeignet. Stattdessen wird
 *  mountRenderer hier mit einem minimalen DOM-Stub betrieben, rAF selbst
 *  kontrolliert getaktet und gezählt, wie oft draw() tatsächlich läuft. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, DEBUG_BLUEPRINT } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));

/* ---------- minimaler DOM-Stub ---------- */
let drawImageCalls = 0;
/** draw() beginnt immer mit ctx.setTransform(dpr,0,0,dpr,0,0) — ein exakter
 *  Zähler für tatsächlich ausgeführte draw()-Durchläufe. */
let drawCalls = 0;
const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "setTransform") return () => { drawCalls++; };
    if (prop === "drawImage") return () => { drawImageCalls++; };
    if (prop === "canvas") return undefined;
    if (prop === "imageSmoothingEnabled" || prop === "globalAlpha") return 1;
    if (prop === "createPattern") return () => ({ setTransform() {} });
    return () => {};
  },
  set() { return true; },
});

function makeElement(): any {
  const el: any = {
    style: {}, dataset: {}, children: [], hidden: false, width: 0, height: 0,
    getContext: () => ctxStub,
    addEventListener() {}, removeEventListener() {},
    appendChild(c: any) { el.children.push(c); return c; },
    replaceChildren(...c: any[]) { el.children = c; },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }),
    querySelector: () => null,
    remove() {},
  };
  return el;
}

let rafQueue: (() => void)[] = [];
(globalThis as any).window = {
  devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
};
(globalThis as any).document = { createElement: () => makeElement(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
(globalThis as any).Image = class { decoding = ""; onload: any; onerror: any; set src(_v: string) { /* nie laden */ } };
(globalThis as any).DOMMatrix = class { scale() { return this; } };
(globalThis as any).performance = globalThis.performance;

/** Führt genau `n` rAF-Ticks aus und meldet, wie viele davon gezeichnet haben. */
function runFrames(n: number): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const before = drawImageCalls;
    const queued = rafQueue;
    rafQueue = [];
    for (const cb of queued) cb();
    if (drawImageCalls > before) drawn++;
  }
  return drawn;
}

const { mountRenderer } = await import("../../packages/renderer/src/render.js");

const container = makeElement();
const renderer = mountRenderer(container, data, catalog);

const entities = collectBlueprints(decodeBlueprintString(DEBUG_BLUEPRINT)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;

/* Ohne geladene Sprites zeichnet paint() nichts — deshalb zählt hier nicht
   drawImage, sondern ob draw() lief. Dafür wird getDebugStats().renderTimeMs
   herangezogen: der Ringpuffer wächst nur bei echten draw()-Durchläufen. */
let lastRenderSamples = 0;
function drawsIn(frames: number): number {
  const before = drawCalls;
  for (let i = 0; i < frames; i++) {
    const q = rafQueue; rafQueue = [];
    for (const cb of q) cb();
  }
  void lastRenderSamples;
  return drawCalls - before;
}

console.log("=== F-01 Stufe 1: zeichnet die Schleife nur noch bei Bedarf? ===\n");

// 1) Statische Szene: nur Entities OHNE Animation
const staticEntities = entities.filter((e) => /wall|pipe|chest|pole/.test(e.name)).slice(0, 40);
renderer.loadBlueprint(staticEntities);
runFrames(3); // initiale Frames abarbeiten
const staticDrawn = drawsIn(30);
console.log(`statische Szene (${staticEntities.length} Entities, keine Animation):`);
console.log(`  von 30 Frames gezeichnet: ${staticDrawn}`);

// 2) Szene MIT Bändern
const beltEntities = entities.filter((e) => /transport-belt/.test(e.name)).slice(0, 40);
renderer.loadBlueprint(beltEntities);
runFrames(3);
const beltDrawn = drawsIn(30);
console.log(`\nSzene mit Bändern (${beltEntities.length} Entities):`);
console.log(`  von 30 Frames gezeichnet: ${beltDrawn}`);

// 3) Kamera-Invalidierung auf der statischen Szene
renderer.loadBlueprint(staticEntities);
runFrames(3);
const idleBefore = drawsIn(10);
renderer.camera.panByScreenDelta(25, 10);
const afterPan = drawsIn(3);
console.log(`\nKamera-Invalidierung (statische Szene):`);
console.log(`  Leerlauf, 10 Frames gezeichnet: ${idleBefore}`);
console.log(`  nach panByScreenDelta, 3 Frames gezeichnet: ${afterPan}`);

// 4) setHighlight / setAltMode
const beforeHl = drawsIn(5);
renderer.setHighlight({ producers: new Set([1]), consumers: new Set() });
const afterHl = drawsIn(3);
renderer.setAltMode(true);
const afterAlt = drawsIn(3);
console.log(`\nweitere Invalidierungen:`);
console.log(`  Leerlauf 5 Frames: ${beforeHl} | nach setHighlight 3 Frames: ${afterHl} | nach setAltMode 3 Frames: ${afterAlt}`);

const ok = staticDrawn === 0 && beltDrawn > 0 && idleBefore === 0 && afterPan > 0 && afterHl > 0 && afterAlt > 0;
console.log(`\nERGEBNIS: ${ok ? "wie erwartet" : "ABWEICHUNG — bitte prüfen"}`);
renderer.destroy();
process.exit(ok ? 0 : 1);
