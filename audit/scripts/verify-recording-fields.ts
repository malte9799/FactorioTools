/** Prüft die neuen Recorder-Felder gegen den echten Renderer, nicht gegen
 *  konstruierte Frames: laufen lassen, aufzeichnen, und nachsehen, ob die
 *  Zahlen zueinander passen (drawn+skipped == drawCommands, Atlas-Zähler
 *  konsistent, rebuildReason genau dann "none" wenn nicht neu gebaut). */
import { readFileSync } from "node:fs";
import { decodeBlueprintString, collectBlueprints, normaliseEntities } from "../../packages/engine/src/index.js";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const examples: any[] = JSON.parse(readFileSync("apps/site/public/data/example-blueprints.json", "utf8"));

// Ein Kontext-Stub, der drawImage tatsächlich mitzählt, damit die PaintTally
// gegen eine unabhängige Zählung geprüft werden kann.
let realDraws = 0;
const ctxStub: any = new Proxy({}, {
  get(_t, prop) {
    if (prop === "createPattern") return () => ({ setTransform() {} });
    if (prop === "canvas") return undefined;
    if (prop === "drawImage") return () => { realDraws++; };
    return () => {};
  },
  set() { return true; },
});
function makeElement(): any {
  const el: any = { style: {}, dataset: {}, children: [], hidden: false, width: 3200, height: 1800,
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
(globalThis as any).createImageBitmap = () => Promise.resolve({ width: 1024, height: 1024, close() {} });
(globalThis as any).fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) });
(globalThis as any).Image = class {
  decoding = ""; private _o: any;
  set onload(f: any) { this._o = f; queueMicrotask(() => f?.()); }
  get onload() { return this._o; }
  set onerror(_f: any) {} set src(_v: string) {}
  decode() { return Promise.resolve(); }
  get width() { return 1024; } get height() { return 1024; }
};

const { mountRenderer } = await import("../../packages/renderer/src/render.js");
const { summariseRecording } = await import("../../packages/renderer/src/recordingSummary.js");
const renderer = mountRenderer(makeElement(), data, catalog);
const pump = (n = 1) => { for (let i = 0; i < n; i++) { const q = rafQueue; rafQueue = []; for (const cb of q) cb(); } };

const ex = [...examples].sort((a, b) => b.entities - a.entities)[0]!;
const entities: PlacedEntity[] = collectBlueprints(decodeBlueprintString(ex.bp))
  .map(normaliseEntities).sort((a, b) => b.length - a.length)[0]!;
renderer.loadBlueprint(entities);
renderer.setAnimationFrozen(true);
pump(3);
await new Promise((r) => setTimeout(r, 400));
pump(3);

renderer.startFrameRecording(30);
// Eine kleine Kamerafahrt, damit Rebuilds mit Grund "visibility" entstehen.
for (let i = 0; i < 12; i++) {
  renderer.camera.panByScreenDelta(40, 25);
  pump(1);
}
renderer.camera.zoomAt(0.5, 800, 450, 1600, 900);
pump(1);
// Und ein paar Frames ohne jede Änderung: die müssen den Cache treffen.
for (let i = 0; i < 5; i++) renderer.stepAnimationFrame(0);
renderer.stopFrameRecording();

const log = renderer.getFrameLog();
let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${msg}`);
  if (!ok) fail++;
};

console.log(`Aufgezeichnet: ${log.length} Frames, ${entities.length} Entities\n`);

check(log.length > 0, "Aufnahme enthält Frames");

// 1. drawn + skipped muss die Command-Zahl ergeben.
const tallyMismatch = log.filter((f) => f.paint.drawn + f.paint.skipped !== f.drawCommands);
check(tallyMismatch.length === 0,
  `paint.drawn + paint.skipped == drawCommands in allen Frames (${tallyMismatch.length} Abweichungen)`);

// 2. rebuildReason und sceneRebuilt müssen übereinstimmen.
const reasonMismatch = log.filter((f) => (f.rebuildReason === "none") === f.sceneRebuilt);
check(reasonMismatch.length === 0,
  `rebuildReason == "none" genau dann, wenn nicht neu gebaut (${reasonMismatch.length} Abweichungen)`);

// 3. outsideMs darf nie negativ sein.
check(log.every((f) => f.outsideMs >= 0), "outsideMs ist nie negativ");

// 4. Atlas-Zähler sind plausibel.
check(log.every((f) => f.atlas.ready >= 0 && f.atlas.decoding >= 0 && f.atlas.queued >= 0),
  "Atlas-Zähler sind nicht-negativ");
check(log.some((f) => f.atlas.ready > 0), "Atlas meldet geladene Sheets");

// 5. Die Kamerafahrt muss "visibility"-Rebuilds erzeugt haben,
//    die unveränderten Frames am Ende dagegen keine.
const reasons = new Set(log.map((f) => f.rebuildReason));
check(reasons.has("visibility"), `Kamerafahrt erzeugt "visibility"-Rebuilds (gesehen: ${[...reasons].join(", ")})`);
const tail = log.slice(-5);
check(tail.every((f) => f.rebuildReason === "none"),
  "die 5 Frames ohne Änderung treffen den Cache");

// 6. Fläche und Sheets nur dort > 0, wo auch gezeichnet wurde.
check(log.every((f) => f.paint.drawn === 0 || f.paint.sheets > 0),
  "sheets > 0 sobald etwas gezeichnet wurde");

// 7. Die Zusammenfassung stimmt mit dem Log überein.
const s = summariseRecording(log, 1600 * 900);
check(s.frames === log.length, "summary.frames == Log-Länge");
check(s.peakDrawCommands === Math.max(...log.map((f) => f.drawCommands)),
  "summary.peakDrawCommands stimmt");
const paintTotal = log.reduce((a, f) => a + f.phases.paint, 0);
const summaryPaint = s.phaseTotals.find((p) => p.phase === "paint")!.ms;
check(Math.abs(paintTotal - summaryPaint) < 1e-6, "summary-Phasensumme stimmt mit dem Log überein");

console.log(`\nBeispielframe:`);
const sample = log[Math.floor(log.length / 2)]!;
console.log(JSON.stringify({
  t: +sample.t.toFixed(1), frameMs: +sample.frameMs.toFixed(2), renderMs: +sample.renderMs.toFixed(2),
  outsideMs: +sample.outsideMs.toFixed(2), drawCommands: sample.drawCommands,
  paint: { ...sample.paint, area: Math.round(sample.paint.area) },
  atlas: sample.atlas, rebuildReason: sample.rebuildReason, skippedSince: sample.skippedSince,
}, null, 2));

console.log(`\n${fail === 0 ? "alle Prüfungen bestanden" : `${fail} Prüfung(en) fehlgeschlagen`}`);
if (fail > 0) process.exitCode = 1;
