/** PHASE 7 VERIFIKATION von F-16.
 *  Bisher belegt: der Payload ERREICHT die Label-Strings. Offen: wird er beim
 *  Einsetzen per innerHTML tatsächlich zu einem aktiven DOM-Element, oder
 *  neutralisiert ihn irgendetwas (Escaping in icon(), textContent-Pfad,
 *  Sanitizer)? Ohne Browser: den exakten Template-Code aus panels.ts /
 *  library-sidebar.ts nachbilden und mit einem minimalen HTML-Parser prüfen,
 *  ob ein <img>-ELEMENT mit onerror-Attribut entsteht. */

const PAYLOAD = `<img src=x onerror="alert(1)">`;

// Exakt die Templates aus dem Produktivcode (Stand Audit):
const templates = {
  "panels.ts:524 (warning.entityName)": (v) => `
        <div class="flow-name">
          <span>${v}</span>
          <span class="sub">detail</span>
        </div>
        <div class="flow-rate"><span class="value">×2</span></div>`,
  "panels.ts:129 (group.moduleLabel)": (v) => `
    <div class="recipe-card-header">
      <div>
        <span class="recipe-card-title">Rezept</span>
        <span class="sub">2× Maschine · ${v}</span>
      </div>
    </div>`,
  "library-sidebar.ts:53 (book.label)": (v) =>
    `<span class="library-disclosure" aria-hidden="true">▸</span><span>📘 ${v}</span>`,
  "panels.ts:96 (line.label)": (v) => `
    <div class="flow-name">
      <span class="dot dot-item"></span>
      <span>${v}</span>
    </div>`,
};

/** Minimaler Tag-Scanner: findet Element-Tags samt Event-Handler-Attributen. */
function findActiveElements(html) {
  const hits = [];
  const tagRe = /<\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrs] = m;
    const handlers = [...attrs.matchAll(/\b(on[a-z]+)\s*=/gi)].map((h) => h[1]);
    const srcish = /\b(src|href)\s*=/i.test(attrs);
    if (handlers.length || (srcish && !["a", "link"].includes(tag.toLowerCase()))) {
      hits.push({ tag, handlers, attrs: attrs.trim().slice(0, 60) });
    }
  }
  return hits;
}

console.log("Payload:", PAYLOAD, "\n");
let vulnerable = 0;
for (const [where, tpl] of Object.entries(templates)) {
  const html = tpl(PAYLOAD);
  const hits = findActiveElements(html);
  const bad = hits.filter((h) => h.tag.toLowerCase() === "img" && h.handlers.length);
  if (bad.length) vulnerable++;
  console.log(`${bad.length ? "VERWUNDBAR" : "ok        "}  ${where}`);
  for (const h of bad) console.log(`              -> <${h.tag}> mit ${h.handlers.join(", ")}   [${h.attrs}]`);
}
console.log(`\n${vulnerable} von ${Object.keys(templates).length} geprüften Fundstellen erzeugen ein aktives <img onerror>-Element.`);

// Gegenprobe: greift der empfohlene Fix?
const escapeHtml = (v) => String(v).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fixed = `<span>${escapeHtml(PAYLOAD)}</span>`;
console.log("\nGegenprobe mit dem empfohlenen escapeHtml/html-Helfer:");
console.log("  Ergebnis:", fixed);
console.log("  aktive Elemente danach:", findActiveElements(fixed).length, "=> Fix wirkt:",
  findActiveElements(fixed).length === 0);
