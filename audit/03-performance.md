# 03 — Performance außerhalb des Renderings

## Build

**Gemessen** (Entwicklungsrechner, warmer Cache):

| Schritt | Dauer |
|---|---:|
| `npm run check` (tsc --noEmit, 4 Pakete) | **3,4 s**, 0 Fehler |
| `npm test` (29 Tests) | **1,07 s**, alle grün |
| `npx vite build` (50 Module) | **1,27 s** |

**Das ist ausgezeichnet und braucht keine Maßnahme.** Ein Full-Check plus Build
plus Tests liegt bei unter sechs Sekunden. Bei Projekten dieser Größe ist das
selten. Der Grund ist die minimale Abhängigkeitsbasis (20 Pakete gesamt) und
der Verzicht auf ein Framework — beides bewusst gut entschieden.

## Bundle

```
dist/index.html                 0,99 kB │ gzip:  0,52 kB
dist/assets/index-*.css        23,96 kB │ gzip:  5,35 kB
dist/assets/index-*.js        180,76 kB │ gzip: 61,43 kB
```

61 kB gzip JavaScript ist für den Funktionsumfang **klein**. Aber: **ein
einziger Chunk, null dynamische Imports** (verifiziert:
`grep -rn "import(" apps/site/src packages/*/src` → 0 Treffer).

### Zusammensetzung (gemessen, `audit/scripts/bundle-attribution.mjs`)

Attribution über die Sourcemap, 168.657 zugeordnete Bytes:

| Modul | Bytes | Anteil |
|---|---:|---:|
| **`node_modules/pako`** | **48.039** | **28,5 %** |
| `site/.../blueprint-viewer/index.ts` | 20.711 | 12,3 % |
| `site/.../legacy-view/panels.ts` | 11.457 | 6,8 % |
| `renderer/src/render.ts` | 10.857 | 6,4 % |
| `site/tools/layer-debug/index.ts` | 7.621 | 4,5 % |
| `engine/src/data/vanilla.ts` | 7.456 | 4,4 % |
| `engine/src/data/debug-lab.ts` | 6.383 | 3,8 % |

### F-07 — Debug-Werkzeuge und Fixtures im Produktions-Bundle (Schweregrad 2)

**Fundstellen:** `packages/engine/src/index.ts:9-11`, `apps/site/src/app.ts:4`, `:28`

`engine/src/index.ts` re-exportiert unbedingt:

```ts
export * from "./data/rotation-test.js";
export * from "./data/debug-lab.js";
export * from "./data/bug-repro.js";
```

und `app.ts:4` importiert das Layer-Debug-Werkzeug statisch, obwohl dessen
Route (`#/layer-debug`) laut Kommentar bewusst **nicht** in `ROUTES` steht und
im Menü nicht erreichbar ist.

**Gemessen:** layer-debug 7.621 B + debug-lab 6.383 B + rotation-test 653 B
= **14.657 B roh, 8,7 % des zugeordneten Bundles**.

> Korrektur meiner ersten Zählung: `entityPreview.ts` (997 B) sieht nach
> Debug-Code aus, ist aber **Produktivcode** — `edit-properties.ts:2` nutzt
> `mountEntityPreview` im Eigenschaften-Panel. Es zählt nicht mit.

**Lösungsvorschlag:** Das Debug-Werkzeug dynamisch laden, dann verschiebt Vite
es automatisch in einen eigenen Chunk, der nur bei Aufruf der Route geladen wird:

```ts
// app.ts
case "#/layer-debug": {
  // Dev-Hilfsmittel: dynamisch geladen, damit es nicht im Haupt-Chunk landet.
  const { mountLayerDebug } = await import("./tools/layer-debug/index.js");
  unmountCurrent = mountLayerDebug(toolRoot);
  break;
}
```

(`route()` muss dafür `async` werden.) Die Debug-Fixtures aus dem
Barrel-Export in `engine/src/index.ts` entfernen und dort, wo sie gebraucht
werden, direkt aus `engine/src/data/debug-lab.js` importieren.

**Aufwand:** S. **Nutzen:** ~9 % kleineres Haupt-Bundle. Ehrlich eingeordnet:
Bei 61 kB gzip ist das in absoluten Zahlen wenig — es steht deshalb weit hinter
den Asset-Themen. Es lohnt sich vor allem als Aufräumarbeit.

### pako — 28,5 % des Bundles

pako wird **ausschließlich** in `engine/src/blueprint.ts:37` und `:51`
gebraucht (`inflate`/`deflate` für Blueprint-Strings). Es ist damit nicht auf
dem Pfad des ersten Renderings, sondern wird erst gebraucht, wenn tatsächlich
ein Blueprint dekodiert wird.

**Optionen, ehrlich gegeneinander abgewogen:**

1. **Dynamischer Import** in `decodeBlueprintString`/`encodeBlueprintString`.
   Nachteil: Die Funktionen müssen `async` werden — ein Eingriff in die
   öffentliche Engine-API mit Auswirkung auf alle Aufrufer und Tests.
2. **`DecompressionStream("deflate")`** der Plattform statt pako. In allen
   aktuellen Browsern verfügbar, würde 48 kB **ersatzlos** streichen. Ebenfalls
   asynchron, also gleicher API-Eingriff, aber ohne zusätzlichen Chunk.

**Empfehlung:** Beides ist Aufwand M und spart ~30 % Bundle. Angesichts von nur
61 kB gzip gesamt ist der Nutzen aber gering — **erst angehen, wenn die
Asset-Themen (F-06) erledigt sind.** Dort liegen die echten Megabytes.

## F-08 — Sequenzieller Wasserfall beim Laden der Startdaten (Schweregrad 3)

**Fundstelle:** `packages/engine/src/data/index.ts:41` und `:47`

```ts
const res = await fetch(gameDataUrl);              // :41  292 KB — voll abgewartet
if (res.ok) {
  const data = (await res.json()) as GameData;     // :43
  const catalogUrl = gameDataUrl.replace(...);
  const catalogRes = await fetch(catalogUrl);      // :47  318 KB — startet erst jetzt
```

Die zweite Anfrage beginnt erst, wenn die erste vollständig übertragen **und
geparst** ist — obwohl beide Dateien völlig unabhängig sind.

**Gemessen** (`audit/scripts/bench-startup-fetch.mjs`, echter HTTP-Server mit
simulierten 40 ms RTT / 20 Mbit/s über den tatsächlichen Dateien):

```
TODAY  sequenziell (index.ts:41, dann :47):  355 ms
FIXED  Promise.all parallel:                 178 ms
Ersparnis:                                   177 ms (50 %)
```

Bis der Katalog da ist, zeichnet der Renderer laut eigenem Kommentar (`:50`)
nur Umriss-Kästen — diese 177 ms sind also direkt sichtbare Wartezeit.

**Lösungsvorschlag:**

```ts
export async function loadData(gameDataUrl = "/data/game-data.json"): Promise<GameData> {
  const catalogUrl = gameDataUrl.replace(/game-data\.json$/, "render-catalog.json");
  // Beide Dateien sind voneinander unabhängig — parallel laden, damit der
  // Katalog nicht auf das vollständige Parsen von game-data.json wartet.
  const [dataRes, catalogRes] = await Promise.allSettled([fetch(gameDataUrl), fetch(catalogUrl)]);

  if (dataRes.status === "fulfilled" && dataRes.value.ok) {
    active = (await dataRes.value.json()) as GameData;
    if (catalogRes.status === "fulfilled" && catalogRes.value.ok) {
      try { activeCatalog = (await catalogRes.value.json()) as RenderCatalog; } catch { /* Umriss-Fallback */ }
    }
  }
  return active;
}
```

Das bestehende Fehlerverhalten (Fallback auf `vanilla`, Katalog optional) bleibt
mit `allSettled` erhalten.

**Aufwand:** S (eine Funktion). **Nutzen:** 177 ms schnelleres erstes echtes
Rendering — der beste Aufwand/Nutzen-Schnitt im ganzen Audit.

## F-09 — Kompression der JSON-Assets muss hostseitig sichergestellt sein (Schweregrad 3)

**Gemessen:**

| Datei | roh | gzip | Ersparnis |
|---|---:|---:|---:|
| `render-catalog.json` | 317 kB | 23 kB | **93 %** |
| `game-data.json` | 291 kB | 30 kB | **90 %** |
| `sprite-source-manifest.json` | 38 kB | 3 kB | 92 % |
| `example-blueprints.json` | 1.356 kB | 864 kB | 37 % |

Die beiden Startdateien schrumpfen um über 90 %. Ohne aktive Kompression
überträgt der Startpfad **608 kB statt 53 kB**. Die `vite.config.ts` deutet auf
GitHub/Codeberg Pages als Ziel (`base: "./"`, Zeile 6) — GitHub Pages liefert
gzip für JSON standardmäßig aus, andere statische Hoster nicht zwangsläufig.

**Empfehlung:** Verifizieren (`curl -sI -H 'Accept-Encoding: gzip, br' <url>` →
`content-encoding`). Falls nicht aktiv: vorkomprimierte `.json.br`/`.json.gz`
mit ausliefern. Aufwand S, Nutzen hoch. *Hinweis: Das habe ich **nicht**
verifiziert, da kein Deployment-Ziel im Repo hinterlegt ist — es ist eine
Prüfaufgabe, kein bestätigter Fehler.*

`example-blueprints.json` (1,39 MB) wird korrekt **lazy** geladen und nur beim
Klick auf "Beispiel laden" (`index.ts:246-256`), mit sauberem Retry bei Fehler.
**Gut gelöst.**

## Netzwerk gesamt

Der Startpfad ist:

```
index.html
  ├─ Google-Fonts-CSS (blockierend, fremde Domain)   → dann Font-Dateien
  ├─ index.js (61 kB gzip)
  ├─ index.css (5 kB gzip)
  └─ loadData()  ──▶ game-data.json  ──sequenziell──▶ render-catalog.json   ← F-08
       └─ dann: bis zu 64 MB Sprites (Median 13 MB)                          ← F-06
```

Kein Backend, keine API, keine Datenbank. Die im Auftrag genannten Punkte
"N+1-Abfragen" und "Datenbank-Caching" existieren hier **nicht** — es gibt
nichts zu prüfen.

## F-10 — Unbegrenzter Undo-Stack mit vollständigen Deep-Copies (Schweregrad 4)

**Fundstelle:** `apps/site/src/tools/blueprint-viewer/index.ts:586-587`, `:589-591`, `:598`

```ts
let undoStack: PlacedEntity[][] = [];   // :586 — nie begrenzt
let redoStack: PlacedEntity[][] = [];   // :587

function snapshotEntities(): PlacedEntity[] {                                    // :589
  return entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));
}

function applyEdit(mutate: () => void): void {
  undoStack.push(snapshotEntities());   // :598 — jeder Edit, ohne Obergrenze
```

Jeder einzelne Edit legt eine **vollständige Kopie aller Entities** ab. Der
Stack wird nur beim Laden eines anderen Blueprints geleert (`:534`, `:553`),
nie durch eine Größengrenze.

Verschärfend: Ein **Zieh-Vorgang** erzeugt einen Edit **pro überstrichener
Kachel**. `placeAtGhost`/`eraseAtScreenPoint` (render.ts:569, :551) entprellen
korrekt über `placedThisGesture`/`erasedThisGesture`, feuern also nicht pro
Frame, sondern pro neuer Zelle — eine Linie über 200 Kacheln erzeugt dennoch
200 Vollkopien. *(Präzisierung gegenüber meiner ersten Lesart: es ist nicht
"pro Frame", die Entprellung ist vorhanden und korrekt.)*

**Gemessen** (`audit/scripts/bench-undo-memory.ts`, Node mit `--expose-gc`):

| Blueprint | Entities | pro Snapshot | 200-Edit-Sitzung | Snapshot-Zeit |
|---|---:|---:|---:|---:|
| Legendary Bioflux | 6.478 | 1.145 KB | **224 MB** | 0,29 ms |
| Heavy Promethium Cruiser | 4.067 | 715 KB | **140 MB** | 0,20 ms |
| Legendary Blue Science | 2.736 | 488 KB | 95 MB | 0,16 ms |

224 MB **zusätzlich** zu den bereits dekodierten Sprites (bis zu 64 MB
Rohbytes, als Bitmaps im Speicher deutlich mehr). Das ist ein realistischer Weg
in einen Tab-Absturz bei längerer Bearbeitung großer Blueprints.

Die Snapshot-**Zeit** (0,29 ms) ist dagegen unkritisch und braucht keine Maßnahme.

**Lösungsvorschlag:** Ringpuffer mit fester Obergrenze — die einfachste Lösung,
die das Problem vollständig beseitigt:

```ts
/** Obergrenze des Undo-Verlaufs. Jeder Eintrag ist eine Vollkopie aller
 *  Entities (~1,1 MB bei 6.500 Entities), deshalb gedeckelt: 50 Schritte
 *  decken jede realistische Rücknahme ab und begrenzen den Verbrauch auf
 *  ~57 MB statt unbegrenzt. */
const UNDO_LIMIT = 50;

function pushUndo(): void {
  undoStack.push(snapshotEntities());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
```

und `undoStack.push(snapshotEntities())` an `:598`, `:610`, `:622` durch
`pushUndo()` ersetzen.

**Ergänzend (optional, größerer Umbau):** Statt Vollkopien nur das Delta
speichern (welche Entity wurde hinzugefügt/entfernt/geändert). Das senkt den
Verbrauch auf praktisch null, ist aber ein echter Umbau der Edit-Schicht — der
Deckel oben erledigt 95 % des Problems in 15 Minuten.

**Aufwand:** S. **Nutzen:** hoch, beseitigt einen Absturzpfad.

## Speicher: Sprite-Atlas ohne Eviction

**Fundstelle:** `packages/renderer/src/spriteAtlas.ts:23`, `:139-144`

`private images = new Map<string, HTMLImageElement>()` wächst monoton; es gibt
keine Eviction, und die Instanz ist bewusst modulglobal, um Remounts zu
überleben.

**Bewertung:** Das ist eine **bewusste, dokumentierte** Abwägung (`:132-138`) —
ohne sie würde jeder Remount ~200 MB neu dekodieren. Für einen Tab, in dem der
Nutzer mehrere große Blueprints nacheinander öffnet, akkumuliert der Speicher
allerdings über alle jemals gesehenen Sheets.

**Empfehlung:** **Vorerst nichts tun.** Wenn F-06 (87 % ungenutzte Frames)
umgesetzt ist, sinkt der Gesamtbedarf um etwa eine Größenordnung und das Thema
erledigt sich. Erst danach — und nur bei belegten Problemen — über eine
LRU-Eviction nachdenken. Ich führe das bewusst **nicht** als Finding.
