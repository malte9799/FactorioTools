/** VERIFIKATION F-01 Stufe 2.
 *  Der Command-Cache patcht nur `sx`. Diese Prüfung fährt den ECHTEN
 *  mountRenderer (DOM-Stub, handgetaktete rAF) über viele Animationsframes
 *  und vergleicht die tatsächlich gezeichneten drawImage-Aufrufe mit einem
 *  frischen, ungecachten Collect+Sort für denselben Frame. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, DEBUG_BLUEPRINT } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

/* ---------- DOM-Stub ---------- */
let drawLog: string[] = [];
const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "drawImage") return (img: any, ...a: number[]) => drawLog.push(`${img.__id}|${a.map(n => n.toFixed(3)).join(",")}`);
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
/** Sprites gelten sofort als geladen, damit paint() wirklich drawImage ruft. */
(globalThis as any).Image = class {
  decoding = ""; private _onload: any;
  set onload(fn: any) { this._onload = fn; queueMicrotask(() => fn?.()); }
  get onload() { return this._onload; }
  set onerror(_f: any) {}
  set src(v: string) { (this as any).__id = v; }
  decode() { return Promise.resolve(); }
};

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } = await import("../../packages/renderer/src/entityLookup.js");
const { buildGrid } = await import("../../packages/renderer/src/neighbours/grid.js");
const { buildFluidNetwork } = await import("../../packages/renderer/src/neighbours/fluid.js");
const { buildHeatNetwork } = await import("../../packages/renderer/src/neighbours/heat.js");
const { collectEntity } = await import("../../packages/renderer/src/draw/collect.js");
const { compareDrawCommands } = await import("../../packages/renderer/src/draw/commands.js");

const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);

/** Referenz: derselbe Renderer, aber der Szenen-Cache wird vor jedem Frame
 *  verworfen, sodass jeder Frame frisch klassifiziert und sortiert wird —
 *  exakt das Verhalten vor F-01 Stufe 2. Damit vergleicht die Prüfung
 *  Cache-Pfad gegen Nicht-Cache-Pfad im selben Programm, statt gegen einen
 *  nachgebauten Collect mit anderer Sheet-URL-Auflösung.
 *  Das Verwerfen geht über updateEntities(), das sceneCache auf null setzt. */

function pump(n = 1) { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } }

const cases: [string, PlacedEntity[]][] = [];
{
  const dbg = collectBlueprints(decodeBlueprintString(DEBUG_BLUEPRINT)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0];
  if (dbg?.length) cases.push(["debug-lab", dbg]);
}
for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
  const e = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0];
  if (e?.length) cases.push([ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 38), e]);
}

const container = makeElement();
const renderer = mountRenderer(container, data, catalog);
let totalFrames = 0, mismatches = 0;

for (const [label, entities] of cases) {
  renderer.loadBlueprint(entities);
  renderer.setAnimationFrozen(true);
  pump(2);
  await new Promise((r) => setTimeout(r, 60)); // Sprites "laden" lassen
  pump(2);

  let bad = 0;
  // Über eine volle Periode plus Überlauf, damit der Modulo-Umlauf mitgeprüft wird.
  for (const frame of [0, 1, 2, 3, 5, 8, 13, 21, 32, 33, 63, 64, 65, 100, 127, 128, 200]) {
    while (renderer.getAnimationFrame() !== frame) {
      renderer.stepAnimationFrame(frame - renderer.getAnimationFrame());
    }
    // 1) gecachter Pfad
    drawLog = [];
    renderer.stepAnimationFrame(0);
    const actual = drawLog.slice();

    // 2) derselbe Frame, aber mit frisch verworfenem Cache
    renderer.updateEntities(entities);
    drawLog = [];
    renderer.stepAnimationFrame(0);
    const expected = drawLog.slice();
    totalFrames++;
    // Nur die Sprite-Zeichnungen vergleichen (Reihenfolge inklusive).
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
      bad++; mismatches++;
      if (bad === 1) {
        console.log(`  ABWEICHUNG ${label} @frame ${frame}: ${actual.length} (Cache) vs ${expected.length} (frisch) Aufrufe`);
        for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
          if (actual[i] !== expected[i]) { console.log(`    [${i}] Cache:  ${actual[i]}\n         frisch: ${expected[i]}`); break; }
        }
      }
    }
  }
  console.log(`  ${bad === 0 ? "ok  " : "FAIL"} ${label.padEnd(40)} ${entities.length} Entities`);
}

console.log(`\ngeprüfte Frames: ${totalFrames}, Abweichungen: ${mismatches}`);
renderer.destroy();
process.exit(mismatches === 0 ? 0 : 1);
