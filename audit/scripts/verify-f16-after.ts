/** NACHWEIS NACH DEM FIX (F-16).
 *  Importiert den ECHTEN html-Helfer aus dem Produktivcode und speist die
 *  Payloads durch die real im Code stehenden Template-Formen. Zusätzlich
 *  wird geprüft, ob safeName im Engine-Layer greift. */
import { html, raw, escapeHtml } from "../../apps/site/src/tools/blueprint-viewer/html.js";
import { decodeBlueprintString, collectBlueprints, normaliseEntities, encodeBlueprintString } from "../../packages/engine/src/index.js";

const PAYLOADS = [
  `<img src=x onerror="alert(1)">`,
  `"><script>alert(1)</script>`,
  `<svg onload=alert(1)>`,
  `'"><img src=x onerror=alert(1)>`,
];

function findActiveElements(markup: string) {
  const hits: { tag: string; handlers: string[] }[] = [];
  const tagRe = /<\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(markup))) {
    const handlers = [...m[2]!.matchAll(/\b(on[a-z]+)\s*=/gi)].map((h) => h[1]!);
    if (handlers.length || /\b(src|href)\s*=/i.test(m[2]!)) hits.push({ tag: m[1]!, handlers });
  }
  return hits;
}

let fails = 0;
console.log("=== 1) Render-Schicht: echte Templates mit dem echten html-Helfer ===");
for (const p of PAYLOADS) {
  // exakt die Formen aus panels.ts:525 / :129 und library-sidebar.ts:57
  const cases: [string, string][] = [
    ["panels.ts:525 warning.entityName", html`<div class="flow-name"><span>${p}</span><span class="sub">${p}</span></div>`],
    ["panels.ts:129 moduleLabel", html`<span class="sub">2× Maschine · ${p}</span>`],
    ["library-sidebar.ts:57 book.label", html`<span class="library-disclosure" aria-hidden="true">▸</span><span>📘 ${p}</span>`],
    ["panels.ts:97 line.label", html`<div class="flow-name"><span>${p}</span></div>`],
  ];
  for (const [where, markup] of cases) {
    const active = findActiveElements(markup);
    if (active.length) { fails++; console.log(`  VERWUNDBAR ${where} <- ${p}`); }
  }
}
console.log(fails === 0 ? `  OK: 0 aktive Elemente über ${PAYLOADS.length} Payloads × 4 Fundstellen` : `  ${fails} FEHLSCHLÄGE`);

console.log("\n=== 2) raw() lässt eigenes Markup durch, escaped aber nicht doppelt ===");
const nested = html`<div>${raw(html`<span class="count">×${`<b>5</b>`}</span>`)}</div>`;
console.log("  ", nested);
console.log("   kein aktives Element:", findActiveElements(nested).length === 0);

console.log("\n=== 3) Engine-Schicht: safeName gegen Entity-/Modulnamen ===");
for (const p of PAYLOADS) {
  const env: any = { blueprint: { item: "blueprint", label: "probe", version: 562949955649538,
    entities: [{ entity_number: 1, name: p, position: { x: 0, y: 0 } }] } };
  const ents = normaliseEntities(collectBlueprints(decodeBlueprintString(encodeBlueprintString(env)))[0]!);
  const n = ents[0]!.name;
  const clean = /^[a-z0-9-]*$/.test(n);
  console.log(`  ${clean ? "OK " : "FAIL"}  ${JSON.stringify(p)} -> ${JSON.stringify(n)}`);
  if (!clean) fails++;
}

console.log("\n=== 4) escapeHtml deckt alle fünf Zeichen ab ===");
console.log("  ", escapeHtml(`&<>"'`));
if (escapeHtml(`&<>"'`) !== "&amp;&lt;&gt;&quot;&#39;") { fails++; console.log("  FAIL"); }

console.log(fails === 0 ? "\nERGEBNIS: alle Prüfungen bestanden." : `\nERGEBNIS: ${fails} Fehlschläge.`);
process.exit(fails === 0 ? 0 : 1);
