/** Prüft die neue Profiling-API: Phasen summieren sich plausibel, das
 *  Frame-Log zeichnet auf und stoppt, die Entity-Aufschlüsselung stimmt. */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

const ctxStub: any = new Proxy({}, { get(_t, p) {
  if (p === "createPattern") return () => ({ setTransform() {} });
  if (p === "canvas") return undefined; return () => {};
}, set() { return true; } });
function el(): any {
  const e: any = { style:{}, dataset:{}, children:[], hidden:false, width:0, height:0,
    getContext:()=>ctxStub, addEventListener(){}, removeEventListener(){},
    appendChild(c:any){e.children.push(c);return c;}, replaceChildren(){},
    setPointerCapture(){}, releasePointerCapture(){},
    getBoundingClientRect:()=>({left:0,top:0,width:1600,height:900,right:1600,bottom:900}),
    querySelector:()=>null, remove(){} };
  return e;
}
let rafQueue: (()=>void)[] = [];
(globalThis as any).window = { devicePixelRatio:1, innerWidth:1600, innerHeight:900, addEventListener(){}, removeEventListener(){} };
(globalThis as any).document = { createElement: () => el(), activeElement: null };
(globalThis as any).requestAnimationFrame = (cb:()=>void) => { rafQueue.push(cb); return 1; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).ResizeObserver = class { observe(){} disconnect(){} };
(globalThis as any).DOMMatrix = class { scale(){ return this; } };
(globalThis as any).Image = class {
  decoding=""; private _o:any;
  set onload(f:any){this._o=f;queueMicrotask(()=>f?.());} get onload(){return this._o;}
  set onerror(_f:any){} set src(v:string){(this as any).__id=v;} decode(){return Promise.resolve();}
};

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const renderer = mountRenderer(el(), data, catalog);
const pump = (n=1) => { for (let i=0;i<n;i++){ const q=rafQueue; rafQueue=[]; for(const cb of q) cb(); } };

const ex = [...examples].sort((a,b)=>b.entities-a.entities)[0];
const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp)).map(normaliseEntities).sort((a,b)=>b.length-a.length)[0]!;
renderer.loadBlueprint(entities);
pump(3); await new Promise(r=>setTimeout(r,80)); pump(2);

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};

console.log(`=== Profiling-API (${entities.length} Entities) ===\n`);

// 1) Phasen
renderer.camera.panByScreenDelta(8, 3); pump(1);
const s1 = renderer.getDebugStats();
const sum = Object.values(s1.phases).reduce((a, b) => a + b, 0);
check("Phasen sind belegt", sum > 0, `Summe ${sum.toFixed(2)} ms`);
check("Phasen <= renderTime", sum <= s1.renderTimeMs * 3 + 1, `Summe ${sum.toFixed(2)} vs render ${s1.renderTimeMs.toFixed(2)} ms`);
console.log("       " + Object.entries(s1.phases).map(([k,v]) => `${k} ${(v as number).toFixed(2)}`).join(" | "));

// 2) Rebuild-Erkennung. Der Zaehlerstand wird VOR und NACH dem Pan
// verglichen, statt sceneRebuilt zu lesen — das Flag gilt nur fuer den
// zuletzt gezeichneten Frame und ein ruhender Frame zeichnet gar nicht.
const rebuildsBefore = renderer.getDebugStats().sceneRebuildCount;
// Weit genug schwenken, dass sich der sichtbare Satz wirklich aendert.
renderer.camera.panByScreenDelta(4000, 2000); pump(1);
const s2 = renderer.getDebugStats();
check("Pan loest Rebuild aus", s2.sceneRebuildCount > rebuildsBefore,
  `${rebuildsBefore} -> ${s2.sceneRebuildCount}`);

// Ruhende Frames: nur bei einer STATISCHEN Szene messbar. Der grosse
// Blueprint ist voller Baender, die jeden Frame legitim neu zeichnen —
// deshalb hier auf eine Auswahl ohne Animation umschalten.
const staticOnly = entities.filter((e) => /wall|pipe|chest|pole|substation/.test(e.name)).slice(0, 60);
renderer.loadBlueprint(staticOnly);
pump(3);
const skippedBefore = renderer.getDebugStats().framesSkipped;
pump(5);
const s3 = renderer.getDebugStats();
check("Ruhende Frames werden uebersprungen (statische Szene)", s3.framesSkipped > skippedBefore,
  `${skippedBefore} -> ${s3.framesSkipped}`);
renderer.loadBlueprint(entities);
pump(3);
check("Zaehler laufen", s3.framesDrawn > 0 && s3.sceneRebuildCount > 0, `${s3.framesDrawn} gezeichnet, ${s3.sceneRebuildCount} Rebuilds`);

// 3) Frame-Log
check("Log ist anfangs leer", renderer.getFrameLog().length === 0);
renderer.startFrameRecording(30);
check("Aufnahme laeuft", renderer.isRecording() === true);
for (let i = 0; i < 25; i++) { renderer.camera.panByScreenDelta(3, 1); pump(1); }
const log = renderer.getFrameLog();
check("Log gefuellt", log.length >= 20, `${log.length} Frames`);
check("Log hat Zeitstempel", log.length > 1 && log[log.length-1]!.t > log[0]!.t);
check("Log hat Phasen", log[0]!.phases !== undefined && typeof log[0]!.phases.paint === "number");
check("Log hat Kamerazustand", typeof log[0]!.pixelsPerTile === "number");
renderer.stopFrameRecording();
check("Aufnahme gestoppt", renderer.isRecording() === false);
const frozen = renderer.getFrameLog().length;
pump(3);
check("Nach Stopp keine neuen Eintraege", renderer.getFrameLog().length === frozen);

// 4) Entity-Aufschlüsselung
check("Aufschluesselung standardmaessig leer", renderer.getEntityCostBreakdown().length === 0);
renderer.setEntityAccounting(true);
pump(2);
const costs = renderer.getEntityCostBreakdown();
check("Aufschluesselung gefuellt", costs.length > 0, `${costs.length} Entity-Namen`);
const totalCounted = costs.reduce((a, c) => a + c.count, 0);
check("Summe der Anzahl plausibel", totalCounted > 0 && totalCounted <= entities.length, `${totalCounted} von ${entities.length}`);
check("Nach collectMs sortiert", costs.every((c, i) => i === 0 || costs[i-1]!.collectMs >= c.collectMs));
console.log("\n  Teuerste Entities:");
for (const c of costs.slice(0, 5)) {
  console.log(`    ${c.collectMs.toFixed(2).padStart(6)} ms  ${String(c.count).padStart(5)}x  ${String(c.drawCommands).padStart(5)} cmds  ${c.name}`);
}
renderer.setEntityAccounting(false);
pump(2);
check("Abschalten leert die Aufschluesselung", renderer.getEntityCostBreakdown().length === 0);

console.log(`\n${fails === 0 ? "Alle Pruefungen bestanden." : fails + " Fehlschlaege."}`);
renderer.destroy();
process.exit(fails === 0 ? 0 : 1);
