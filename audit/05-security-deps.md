# 05 — Sicherheit & Abhängigkeiten

## Zusammenfassung

Die Abhängigkeitslage ist **vorbildlich**. Es gibt genau **ein** ernstes
Sicherheitsproblem — dieses aber praktisch nachgewiesen und persistent.

## F-16 — Persistentes XSS über präparierte Blueprint-Strings (Schweregrad 5)

**Fundstellen:**
- `apps/site/src/tools/blueprint-viewer/legacy-view/panels.ts:524-530` (`warning.entityName`, `warning.detail`)
- `apps/site/src/tools/blueprint-viewer/legacy-view/panels.ts:129-136` (`recipeLabel`, `machineLabel`, `moduleLabel`)
- `apps/site/src/tools/blueprint-viewer/legacy-view/panels.ts:447`, `:483` (dieselben Felder)
- `apps/site/src/tools/blueprint-viewer/legacy-view/panels.ts:96` (`line.label`), `:179` (`flow.label`), `:390` (`w.recipeLabel`)
- `apps/site/src/tools/blueprint-viewer/library-sidebar.ts:53` + `:279` (`book.label`)

### Nachgewiesen, nicht vermutet

`audit/scripts/xss-probe.ts` baut mit der **echten** Engine-API einen
Blueprint-String und verfolgt die Zeichenkette durch die reale Verarbeitungskette.
Ausgabe:

```
crafted blueprint string length: 333
round-trips through decode: true

--- result.warnings (gerendert in panels.ts:526 via innerHTML) ---
  entityName: "<img src=x onerror=\"alert(1)\">"
  contains raw HTML tag: true

--- group.moduleLabel (gerendert in panels.ts:133/451/487 via innerHTML) ---
  moduleLabel: "2× <img src=x onerror=\"alert(1)\">"
  contains raw HTML tag: true

=== BOOK PATH (library-sidebar.ts:279 -> makeCategory -> innerHTML) ===
  leaf label: "<img src=x onerror=\"alert(1)\">"
  leaf label carries raw HTML: true
  => in localStorage gespeichert -> PERSISTENT über Reloads
```

### Die Kette im Einzelnen

```
Angreifer erstellt Blueprint-String
   │  (Entity-Name / Modul-Name / Book-Label = HTML-Payload)
   ▼
Nutzer fügt ihn ein (Reddit, Forum, Discord — der normale Verbreitungsweg)
   ▼
decodeBlueprintString ──▶ normaliseEntities ──▶ calculate
   │                                              │
   │  Unbekannter Entity-Name landet in           │  Unbekannter Modulname
   │  result.warnings (rates.ts:153-159)          │  landet in moduleLabel
   │                                              │  (rates.ts:81-86, ungefiltert)
   ▼                                              ▼
panels.ts:526  row.innerHTML = `...${warning.entityName}...`     ← Ausführung
panels.ts:133  card.innerHTML = `...${group.moduleLabel}...`     ← Ausführung
```

Und für die persistente Variante:

```
Book-Label (Angreifer-kontrolliert)
   ▼  saveToLibrary (blueprint-library.ts:56-73)
localStorage["factoriotools.blueprint-viewer.library"]
   ▼  bei JEDEM späteren Seitenaufruf
library-sidebar.ts:279 → makeCategory(…, `📘 ${book.label}`)
   ▼
library-sidebar.ts:53  header.innerHTML = `…<span>${title}</span>`   ← Ausführung
```

### Warum das real ist und nicht theoretisch

Blueprint-Strings sind **das** Austauschformat dieser Community. Ihr Zweck ist,
von Fremden kopiert und eingefügt zu werden. Ein "füg das mal ein, das ist ein
super Reaktor-Design"-Posting ist der Normalfall, nicht ein Angriffsszenario.
Die Payload muss keine Warnung auslösen — sie ist im String unsichtbar
(base64+zlib).

Was ein Angreifer erreichen kann: Auslesen und Exfiltration der gesamten
gespeicherten Blueprint-Bibliothek des Opfers, stilles Verändern gespeicherter
Blueprints, beliebiges Umgestalten der Seite. Es gibt **keine** Cookies,
Sessions oder Zugangsdaten zu stehlen (kein Backend) — das begrenzt den Schaden,
hebt ihn aber nicht auf. Verschärfend: **kein CSP-Header** (siehe F-18), also
keine zweite Verteidigungslinie.

`example-blueprints.json` stammt aus der eigenen Sammlung des Entwicklers und
ist damit vertrauenswürdig — die eingefügten Strings der Nutzer sind es nicht.

### Lösungsvorschlag

Die saubere und dauerhafte Lösung ist, für **von Blueprints stammende Werte**
kein `innerHTML` mehr zu verwenden. Das Muster existiert im Projekt bereits:
Struktur per `innerHTML`, Inhalt per `textContent`/`prepend` — genau das machen
`panels.ts:106` und `:137` heute schon mit `icon(...)`.

```ts
// panels.ts:524 — vorher
row.innerHTML = `
  <div class="flow-name">
    <span>${warning.entityName}</span>
    <span class="sub">${warning.detail}</span>
  </div>
  <div class="flow-rate"><span class="value">×${warning.count}</span></div>`;

// nachher: Gerüst ohne Fremddaten, Werte per textContent
row.innerHTML = `
  <div class="flow-name"><span class="n"></span><span class="sub"></span></div>
  <div class="flow-rate"><span class="value"></span></div>`;
row.querySelector<HTMLElement>(".n")!.textContent = warning.entityName;
row.querySelector<HTMLElement>(".sub")!.textContent = warning.detail;
row.querySelector<HTMLElement>(".value")!.textContent = `×${warning.count}`;
```

Für die zahlreichen Stellen lohnt ein kleiner Helfer:

```ts
/** Tagged Template, das jeden interpolierten Wert HTML-escaped. Für Markup mit
 *  Werten aus eingefügten Blueprints (Entity-, Modul-, Rezept-, Book-Namen),
 *  die grundsätzlich als nicht vertrauenswürdig zu behandeln sind. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = String(values[i - 1] ?? "").replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    return out + v + s;
  }, "");
}

// Anwendung: nur das Präfix `html` ergänzen, Template bleibt unverändert
row.innerHTML = html`
  <div class="flow-name">
    <span>${warning.entityName}</span>
    <span class="sub">${warning.detail}</span>
  </div>`;
```

Damit ist die Änderung an allen 8 Fundstellen ein Einzeiler pro Stelle.

**Zusätzlich empfohlen (Tiefenverteidigung):** Namen bereits an der
Systemgrenze validieren. Factorio-Prototypnamen bestehen ausschließlich aus
`[a-z0-9-]`; alles andere ist per Definition ungültig:

```ts
// engine/src/blueprint.ts, in normaliseEntities
const VALID_PROTOTYPE_NAME = /^[a-z0-9-]+$/;
// Ein Name, der nicht dem Factorio-Prototypenschema entspricht, kann kein
// echtes Spielobjekt sein — er stammt aus einem manipulierten String.
if (!VALID_PROTOTYPE_NAME.test(name)) { /* verwerfen oder als "(ungültig)" führen */ }
```

**Aufwand:** S für den `html`-Helfer plus 8 Aufrufstellen (~1–2 h).
**Nutzen:** beseitigt die einzige echte Schwachstelle des Projekts.
**Das ist die dringlichste Einzelmaßnahme des gesamten Audits.**

## F-17 — `saveToLibrary` speichert unvalidierte Fremddaten dauerhaft (Schweregrad 3)

**Fundstelle:** `apps/site/src/tools/blueprint-viewer/blueprint-library.ts:56-73`, `:23-32`

Zwei zusammenhängende Punkte:

1. Der Label eines gespeicherten Blueprints wird ungeprüft aus dem
   Fremd-String übernommen (`:69`, `:73`) — der Persistenz-Teil von F-16.
2. `readAll()` (`:23-32`) prüft nur `Array.isArray(parsed)`. Die einzelnen
   Einträge werden **nicht** validiert. Ein via XSS (F-16) oder direkt über
   die DevTools manipulierter `localStorage`-Eintrag kann also beliebig
   geformte Objekte in die Anwendung einspeisen.

**Lösungsvorschlag:** Beim Lesen pro Eintrag die Form prüfen und Länge
begrenzen:

```ts
function isSaved(x: unknown): x is SavedBlueprint {
  const e = x as Partial<SavedBlueprint>;
  return !!e && typeof e.id === "string" && typeof e.label === "string"
      && typeof e.bpString === "string" && typeof e.savedAt === "number"
      && e.label.length <= 200 && e.bpString.length <= 5_000_000;
}
function readAll(): SavedBlueprint[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
  } catch { return []; }
}
```

**Aufwand:** S. **Nutzen:** mittel (Tiefenverteidigung; F-16 ist die Hauptsache).

## F-18 — Keine Content-Security-Policy (Schweregrad 2)

**Fundstelle:** `apps/site/index.html` (Fehlen eines Meta-Tags)

Ohne CSP fehlt die zweite Verteidigungslinie gegen F-16. Da die Anwendung
statisch ist und außer Google Fonts keine fremden Ressourcen lädt, ist eine
strenge Policy problemlos möglich:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self';
               style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
               font-src https://fonts.gstatic.com;
               img-src 'self' data:;
               connect-src 'self';
               base-uri 'none';
               object-src 'none';
               frame-ancestors 'none'">
```

Das blockiert das `<img src=x onerror=...>`-Muster aus F-16 **nicht**
(Inline-Event-Handler in per `innerHTML` eingefügtem Markup werden von
`script-src` nicht erfasst) — wohl aber das Nachladen externer Skripte und die
Exfiltration an fremde Endpunkte (`connect-src 'self'`). Es ist eine sinnvolle
Ergänzung, **kein Ersatz** für F-16.

Hinweis: `style-src` braucht `'unsafe-inline'`, weil die Anwendung an mehreren
Stellen `element.style.*` setzt (Tooltip-Position, Fensterverwaltung).

Wenn der Hoster eigene Header erlaubt, gehören dort zusätzlich
`X-Content-Type-Options: nosniff` und `Referrer-Policy: no-referrer` hin.

**Aufwand:** S. **Nutzen:** mittel.

## Abhängigkeiten — durchweg gut

### Bekannte Schwachstellen

```
npm audit → {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
```

**Null.** Bei nur 20 Paketen im gesamten Baum ist das nachvollziehbar — und
diese minimale Angriffsfläche ist eine der besten Eigenschaften des Projekts.
Zum Vergleich: Ein typisches Frontend-Projekt hat 800–1.500 transitive Pakete.

### Lizenzen

| Paket | Version | Lizenz | Rolle |
|---|---|---|---|
| `pako` | 2.2.0 | MIT AND Zlib | Client-Runtime |
| `pngjs` | 7.0.0 | MIT | nur Build (Node) |
| `vite` | 6.4.3 | MIT | nur Build |
| `typescript` | 5.9.3 | Apache-2.0 | nur Build |
| `tsx` | 4.23.13 | MIT | nur Build/Test |

Alle permissiv, **keine Copyleft-Konflikte**, keine Lizenz mit
Weitergabepflichten für den ausgelieferten Code.

> Nicht geprüft, aber erwähnenswert: Die extrahierten Sprites sind
> urheberrechtlich geschütztes Material von Wube Software. Für eine
> **öffentliche** Bereitstellung der gerenderten Sprites wäre die Rechtelage
> gesondert zu klären. Das ist eine juristische, keine technische
> Frage, und ich bewerte sie nicht.

### Veraltete Pakete

| Paket | aktuell | neueste | Bewertung |
|---|---|---|---|
| `vite` | 6.4.3 | 8.2.2 | 2 Major zurück |
| `typescript` | 5.9.3 | 7.0.2 | 1 Major zurück |
| `pako` | 2.2.0 | 3.0.1 | 1 Major zurück |
| `@types/node` | 22.20.1 | 26.5.0 | 4 Major zurück |

**Keine dieser Versionen hat eine bekannte Schwachstelle.** Ein Update ist
Wartung, nicht Dringlichkeit. Empfehlung: `@types/node` auf die zur
Node-Laufzeit passende Major-Version ziehen (billig, kein Laufzeitrisiko), Vite
und TypeScript bewusst und getrennt aktualisieren, wenn Zeit ist. `pako`
sollte **nicht** aktualisiert werden, ohne zuvor F-08/den Ersatz durch
`DecompressionStream` (siehe `03-performance.md`) zu bewerten — womöglich
entfällt die Abhängigkeit ganz.

## Secrets

```
git grep -E '(api[_-]?key|secret|password|token|BEGIN .*PRIVATE KEY|AKIA…|ghp_…|sk-…)'
   → keine Treffer
git ls-files | grep -E '\.env|credential|secret|\.pem|\.key$'
   → keine Treffer
```

**Keine Secrets im Repository.** Es gibt auch keine, die es geben könnte — die
Anwendung hat kein Backend, keine API-Schlüssel, keine Authentifizierung.

## Unsichere Muster — was ich geprüft und *nicht* gefunden habe

- **`eval` / `new Function` / `setTimeout("string")`:** keine Treffer.
- **`dangerouslySetInnerHTML`-Äquivalente außer den unter F-16 genannten:**
  keine.
- **Prototype Pollution:** `JSON.parse` wird auf `localStorage`-Inhalte und
  Blueprint-JSON angewandt. Die geparsten Objekte werden über explizite
  Feldzugriffe gelesen, nicht per `Object.assign` in bestehende Objekte
  gemischt. **Kein ausnutzbarer Pfad gefunden.**
- **Offene Weiterleitungen / `window.open` / `location`-Zuweisungen aus
  Fremddaten:** Die einzigen `location`-Zuweisungen sind Hash-Routen aus der
  festen `ROUTES`-Konstante (`app.ts:33`, `nav.ts:11`). **Unbedenklich.**
- **`postMessage` / iframe / WebSocket / externe Endpunkte:** existieren nicht.
- **Zip-Bomb über `pako.inflate`:** `blueprint.ts:37` dekomprimiert ohne
  Größengrenze. Ein extrem hoch komprimierter String könnte den Tab
  ausbremsen. Das ist ein Selbst-DoS beim eigenen Einfügen — geringe
  Auswirkung, aber eine Obergrenze wäre billig. Ich führe es bewusst **nicht**
  als eigenes Finding: Der Nutzer schädigt damit nur die eigene Sitzung, und
  ein Reload behebt es.
