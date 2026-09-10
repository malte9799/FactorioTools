# Umsetzungs-Log

Branch: `audit/umsetzung`, ausgehend von `0822f76`.
Regel: vor jedem Commit muss `npm run check`, `npm test` und `npx vite build`
grün sein. Bei rotem Stand wird zurückgesetzt und das Finding zurückgestellt.

## Ausgangsmessung (Baseline auf `0822f76`)

`npx tsx audit/scripts/bench-collect.ts`:

| Blueprint | Entities | DrawCommands | Per-Frame-JS |
|---|---:|---:|---:|
| Legendary Bioflux | 6.478 | 8.915 | **13,33 ms** (80 % des Budgets) |
| Legendary Blue Science | 2.736 | 3.860 | 7,25 ms |
| Green Circuit Upcycler | 2.283 | 4.251 | 5,42 ms |
| Biter Egg Rocket | 173 | 225 | 0,29 ms |

(Audit-Prognose war 13,65 ms für Bioflux — Abweichung 2 %, Messrauschen.)

Weitere Baselines:
- `npm run check`: grün, ~3,4 s
- `npm test`: 29 Tests grün, ~1,1 s
- `npx vite build`: 180,76 kB JS (61,43 kB gzip), ~1,3 s

---
## F-16 + F-17 — XSS und localStorage-Validierung ✅ umgesetzt

**Commit:** `7e7c9f5` · 2026-09-09

**Geändert**
- **Neu:** `apps/site/src/tools/blueprint-viewer/html.ts` — `html`-Tagged-Template
  mit Escaping, `escapeHtml`, `raw()` für selbst erzeugtes Markup.
- `legacy-view/panels.ts`: alle 8 Senken auf `html`/`raw` umgestellt
  (measureLine, recipeLineRow, Rezeptkarte, flowRow, flowPanel-Überschrift,
  Scale-Warning-Banner, beide Maschinenzeilen, Warnings-Panel).
- `library-sidebar.ts:57`: Kategorie-Header (Book-Label) escaped.
- `packages/engine/src/blueprint.ts`: `safeName()` in `normaliseEntities`,
  `readModules` (beide On-Disk-Formen) und `readFilterItems`.
- `blueprint-library.ts`: `isSavedBlueprint`-Type-Guard mit Längengrenzen (F-17).

**Abweichung von der Audit-Empfehlung (bewusst, konservativ)**
Das Audit schlug vor, ungültige Prototypnamen zu „verwerfen oder als
(ungültig) führen". Ich **verwerfe nicht** — die Entity bleibt erhalten und
taucht weiter in den „Not counted"-Warnungen auf, nur der Name wird auf
`[a-z0-9-]` reduziert. Grund: Verwerfen hätte das Berechnungsverhalten
geändert und dem dokumentierten Prinzip „degradieren statt abstürzen"
widersprochen (es gibt einen Test dafür). Labels werden bewusst **nicht**
gestrippt, sondern nur beim Rendern escaped — Nutzer benennen Blueprints
legitim „A & B".

**Messung vorher/nachher** (`audit/scripts/verify-f16-after.ts`, neu)

| Prüfung | vorher | nachher |
|---|---|---|
| aktive `<img onerror>`-Elemente (4 Payloads × 4 Senken) | 4/4 Senken verwundbar | **0 aktive Elemente** |
| `safeName` gegen 4 Payloads | — | **4/4 auf `[a-z0-9-]` reduziert** |
| `raw()` doppel-escapet nicht | — | bestätigt |
| `escapeHtml` deckt `&<>"'` | — | bestätigt |

`xss-probe.ts` (Original-Skript) nachher: `entityName` und `moduleLabel`
enthalten **kein** rohes HTML mehr. Das Book-Label trägt weiterhin die
Zeichen — korrekt, da dort die Render-Schicht (Layer 1) greift.

**Grün:** check 0 Fehler · 29 Tests · Build ok.
Bundle 180,76 → 181,78 kB (61,43 → 61,85 kB gzip; +0,42 kB gzip fürs Escaping).

---
## F-08 — Startdaten parallel laden ✅ umgesetzt
**Commit:** `7f86cf9`

`loadData` (`engine/src/data/index.ts`) startet beide Fetches jetzt über
`Promise.allSettled`. Katalog wird weiterhin nur angewandt, wenn game-data
geladen hat; beide Fallbacks (vanilla-Datensatz, Outline-Modus) bleiben.

| | vorher | nachher | Audit-Prognose |
|---|---:|---:|---|
| loadData @40ms RTT/20Mbit | 355 ms | **184 ms** | 178 ms |
| Ersparnis | — | **171 ms (48 %)** | 177 ms (50 %) |

Gemessen mit neuem `audit/scripts/bench-f08-real.ts` — treibt die **echte**
`loadData`, nicht eine Nachbildung. Die 6 ms Differenz zur Prognose ist die
zusätzliche Parse-Arbeit der echten Funktion. Korrektheit im selben Lauf
geprüft: 25 machines, 94 catalog-entities.

---

## F-10 — Undo/Redo-Historie gedeckelt ✅ umgesetzt
**Commit:** `2e5a3cd`

`HISTORY_LIMIT = 50` + `pushHistory()` an allen drei Push-Stellen. **Auch
`redoStack`** gedeckelt (wächst über `undo()` genauso) — das ging über die
Audit-Empfehlung hinaus, die nur `undoStack` nannte.

| Blueprint | Edits | vorher | nachher |
|---|---:|---:|---:|
| Bioflux (6.478) | 200 | 222 MB | **56 MB** (-75 %) |
| Bioflux (6.478) | 500 | 555 MB | **54 MB** (-90 %) |
| Promethium (4.067) | 500 | 344 MB | **34 MB** (-90 %) |

**Methodischer Hinweis:** Die erste Messung zeigte nur -2 %, weil sie
Allokation statt Retention maß. Verworfene Snapshots sind unerreichbar, aber
noch nicht eingesammelt. `bench-f10-after.ts` erzwingt jetzt GC vor der
Messung. Entscheidend ist die **Flachheit** über 200 vs. 500 Edits: Der
Verbrauch skaliert nicht mehr mit der Sitzungslänge.

---

## F-03 — paint()-Filter im Hauptpfad übersprungen ✅ umgesetzt
**Commit:** `0a6391e`

`paintPlain` exportiert, `render.ts:426` ruft es direkt. `paint()` bleibt
unverändert für Ghost und Entity-Preview.

**Renderpfad-Verifikation:** Neues `audit/scripts/verify-render-identical.ts`
zeichnet die exakte `drawImage`/`alpha`/`composite`-Aufruffolge auf und
vergleicht `paint()` gegen `paintPlain()` über den **Debug-Lab-Blueprint
(eine Instanz jeder Entity)** plus die drei größten echten Blueprints, in den
Animationsframes 0/1/7/33. **Alle Folgen byte-identisch.**
Ein Pixel-Snapshot ist headless nicht möglich — das ist der Ersatz dafür,
und das steht so auch im Commit.

Ersparnis: **0,15 ms/Frame** (Bioflux). Klein, wie das Audit selbst einordnete.

---

## F-04 + F-15 — Tooltip-Reflow und Debug-Logs ✅ umgesetzt
**Commit:** `655a93f`

Karte wird nur noch bei **Inhaltswechsel** neu gebaut und gemessen (Key über
das, was die Karte zeigt — nicht über die Entity, damit eine Reihe gleicher
Assembler gar nichts kostet). Positionierung über `transform` statt
`left`/`top`; `.machine-tooltip` in CSS auf `top:0/left:0` verankert.

**Im Browser verifiziert** (visuelle Änderung, headless nicht prüfbar):
Bei 300×158-Tooltip und Cursor (500,300) landet das Element exakt auf
(516,316); an rechtem und unterem Rand klappt es korrekt um und bleibt im
Viewport. Keine Konsolenfehler.

F-15: beide `console.log("DEBUG …")` entfernt. Die zwei `console.warn`
(spriteAtlas, iconAtlas) bleiben — echte Fehlerdiagnose.

---

## F-13 + F-18 — CI und CSP ✅ umgesetzt
**Commit:** `33bfdd0`

`.github/workflows/ci.yml`: check + test + build auf push/PR.
CSP-Meta-Tag in `index.html`.

**Abweichung:** `frame-ancestors` wieder **entfernt** — Browser ignorieren die
Direktive im `<meta>`-Element und loggen einen Konsolenfehler (im Browser
beobachtet, nicht vermutet). Gehört in einen echten HTTP-Header; im Kommentar
vermerkt, zusammen mit X-Content-Type-Options und Referrer-Policy.

**Im Browser verifiziert:** frischer Tab, **0 CSP-Verstöße**, Google-Fonts-
Stylesheet lädt weiterhin, IBM Plex Sans/Mono als `loaded` gemeldet,
Sprites zeichnen.

---
## F-09 — Hosting-Kompression ⏸️ zurückgestellt (nicht umsetzbar auf diesem Branch)
2026-09-09

Das Repository enthält **kein Deployment-Ziel**: kein git-Remote, keine
Pages-/Netlify-/Vercel-Konfiguration, kein CNAME. Es gibt damit nichts,
wogegen sich `content-encoding` prüfen ließe, und eine Deployment-Konfiguration
zu erfinden wäre Scope-Creep.

Das Audit hatte F-09 bereits als **Prüfauftrag** formuliert, nicht als
bestätigten Fehler. Bleibt als manueller Schritt im Abschlussbericht.

---

## Stufe 1 abgeschlossen — Zwischenstand Messungen

| Kennzahl | Baseline | jetzt |
|---|---:|---:|
| Per-Frame-JS Bioflux | 13,33 ms | 11,77 ms (nur F-03; F-01 folgt) |
| loadData @40ms/20Mbit | 355 ms | 184 ms |
| Undo-Speicher, 200 Edits | 222 MB | 56 MB |
| XSS-Senken mit aktivem Element | 4/4 | **0/4** |
| Bundle gzip | 61,43 kB | 61,96 kB |
| Tests | 29 grün | 29 grün |

---
## F-12 — Renderer-Tests ✅ umgesetzt (Stufe 2)
**Commit:** `8ee6f9f` · 2026-09-09

43 neue Tests in `packages/renderer/test/`: pipe (13), beltGraph (14),
spatial-camera (16). Alle DOM-frei, laufen mit dem vorhandenen tsx-Runner.
Test-Suite gesamt: **29 → 72**, weiterhin ~1 s.

Wiring: `packages/renderer` hat jetzt ein `test`-Skript; Wurzel-Skript auf
`--workspaces --if-present` umgestellt (lief vorher nur gegen engine).

**Zwei Tests haben meine Erwartung widerlegt — genau ihr Zweck:**
1. `classifyWall` ignoriert einen Nord-Nachbarn **vollständig**. Ich hatte
   Symmetrie erwartet; der Code dokumentiert die Asymmetrie als bewusste
   Portierung der Spiel-Logik. Test pinnt jetzt das Ist-Verhalten.
2. Cap-Unterdrückung bei Bändern hängt an **physischer Adjazenz**, nicht an
   Blickrichtung. Zwei Rücken-an-Rücken-Bänder behalten je nur ihren
   End-Cap. Der Kommentar in beltGraph.ts nennt das als früheren Bug —
   jetzt mit Regressionsschutz.

Kein Produktivcode geändert, nur Tests + package.json-Skripte.

---
## F-01 Stufe 1 — Dirty-Flag ✅ umgesetzt (Stufe 3)
**Commit:** `52d6a6a` · 2026-09-09

`needsRedraw` + `animatedVisibleCount`; Camera meldet eigene Änderungen
(`setOnChange`), zwölf weitere Invalidierungspunkte. Neu:
`hasAnimatedLayer()` in entityLookup (WeakMap-gecacht).

**Wichtig — Browser war zur Prüfung UNGEEIGNET:** Der Browser-Pane drosselt
`requestAnimationFrame` in einem versteckten Tab vollständig; gemessen:
**0 rAF-Aufrufe in 1500 ms**, `document.hidden === true`. Jeder Canvas-
Vergleich dort hätte "nichts bewegt sich" gezeigt — unabhängig von meiner
Änderung. Erst `stepAnimation()` (umgeht rAF) zeigte, dass die Animation
funktioniert. Deshalb: eigenes Skript mit DOM-Stub und handgetakteter rAF.

`audit/scripts/verify-f01-dirty.ts`:

| Szenario | vorher | nachher |
|---|---:|---:|
| statische Szene, 30 Frames | 30 draws | **0 draws** |
| Band-Szene, 30 Frames | 30 draws | **30 draws** (Animation intakt) |
| Leerlauf → panByScreenDelta | — | 0, dann **genau 1** |
| setHighlight / setAltMode | — | **je genau 1** |

**Renderpfad unverändert:** `verify-render-identical.ts` liefert denselben
Gesamt-Hash `1b18d8ea0b0be4ba0b0e258ea5925847` wie vor der Änderung.

**Ehrliche Einordnung der Wirkung** (`bench-f01-idle.ts`, alle 176 Blueprints):
**39 (22 %) sind vollständig statisch** → im Leerlauf jetzt 0 statt 60 draws/s.
Die übrigen 137 haben im Schnitt 43 % animierte Entities und zeichnen weiter,
solange Bänder im Bild sind. Stufe 1 löst also **nicht** den Hauptfall —
dafür ist Stufe 2 gedacht. Das Audit hatte das so vorhergesagt.

Tests 72 → 81 (redraw.test.ts, 9 Tests).

---
## F-02 — Ghost-Preview-Netze gecacht ✅ umgesetzt
**Commit:** `4ac4b77` · 2026-09-09

Cache-Key: `entitiesVersion|name|snappedX,snappedY|direction`. `entitiesVersion`
wird von `rebuildIndices` hochgezählt.

**Abweichung von der Audit-Empfehlung (bewusst, konservativ):** Das Audit
skizzierte ein `OverlayGrid`. Ich habe die dort ebenfalls genannte
**Änderungserkennung** umgesetzt — das Overlay ändert, *wie* Konnektivität
aufgelöst wird, der Cache nicht: er liefert entweder dasselbe Objekt oder
baut exakt wie vorher neu.

`audit/scripts/verify-f02-ghost.ts`: 6 Ghost-Typen × 4 Positionen ×
4 Richtungen × 10 ruhende Frames = **960 Vergleiche, 0 Abweichungen**,
Netz-Neuaufbauten **960 → 96 (-90 %)**.
Eingesparte Kosten pro ruhendem Frame (Bioflux, gemessen):
buildGrid 1,19 + Fluid 0,48 + Heat 0,14 = **1,81 ms**.
Audit-Prognose war 2,19 ms — dieselbe Größenordnung.

Renderpfad unverändert (Hash `1b18d8ea…`).

---
## F-01 Stufe 2 — Command-Cache ✅ umgesetzt
**Commit:** `86478b9` · 2026-09-09

Gesammelte+sortierte Command-Liste wird gehalten; pro Frame nur `sx` der
animierten Einträge gepatcht. Key: `entitiesVersion|highlightVersion|visibleIds`.

**Die Phase-7-Präzisierung war nötig:** Jeder animierte Command bekommt seine
**eigene** Periode. `base`/`stride`/`period` werden vom Klassifikator
abgetastet (MAX_ANIM_PERIOD = 256), nicht aus Katalog-Metadaten hergeleitet —
`collect.ts` bleibt einzige Quelle der Wahrheit. Commands, die nicht exakt
`base + (frame % period) * stride` folgen, bleiben statisch (degradiert zum
Standbild, nie zu falscher Grafik).

`alphaFor` aus `draw()` herausgezogen (Cache backt Alpha ein);
`setHighlight` zählt `highlightVersion` hoch.

**Verifikation** (`audit/scripts/verify-f01-cache.ts`): echter Renderer,
Cache-Pfad gegen denselben Renderer mit pro Frame verworfenem Cache.
4 Blueprints × 17 Frames (inkl. 63/64/65 und 127/128 am Modulo-Umlauf):
**68 Frames, 0 Abweichungen.**

**Messung** (`bench-f01-cache.ts`, echter Renderer, Bänder laufen):

| Blueprint | Baseline | nachher | Faktor |
|---|---:|---:|---:|
| Bioflux (6.478 Ent) | 13,33 ms | **1,80 ms** | 7,4× |
| Promethium (4.067) | — | **1,35 ms** | — |
| Blue Science (2.736) | 7,25 ms | **0,94 ms** | 7,7× |

Budget-Anteil Bioflux: **80 % → 11 %**.

**Abweichung von der Audit-Prognose (ehrlich):** Das Audit modellierte
1288–2219× für den Collect-Schritt allein. Gemessen sind es 7,4× auf den
**gesamten** Frame — weil die verbleibenden 1,8 ms aus Spatial-Query,
Paint-Schleife und Grid stammen, die der Cache nicht anfasst. Die
Audit-Zahl war für den isolierten Collect korrekt, als Gesamtaussage aber
zu optimistisch.

---
## F-07 + F-19 ✅ umgesetzt (Stufe 5)
**Commit:** `98fa069` · 2026-09-09

**F-07:** `layer-debug` per `import()` → eigener Chunk.
Haupt-Bundle **180,76 → 177,09 kB** (61,43 → 60,63 kB gzip),
layer-debug 8,26 kB (3,40 gzip) nur bei Aufruf.
`routeToken` verhindert, dass ein spät eintreffender Import ein Werkzeug
über das inzwischen aktive mountet.

**Abweichung:** Die Debug-**Fixtures** bleiben im Engine-Barrel. Das Audit
schlug vor, sie zu entfernen — sie werden aber von der ausgelieferten
Library-Sidebar genutzt („Rotation test", „Debug lab"), ein Entfernen aus dem
Barrel hätte sie also **nicht** aus dem Bundle entfernt.

**F-19:** 8 Latin-Schnitte (137 kB) selbst gehostet unter `/fonts`,
Google-Fonts-Link entfernt, zwei Schnitte per `preload`.
Dadurch konnte die **CSP auf reines `'self'`** verschärft werden.
Browser-verifiziert: **0 Requests an google/gstatic**, alle Font-Dateien
lokal mit HTTP 200, UI rendert in den richtigen Schriften.

## F-14 ✅ umgesetzt
**Commit:** `32b0f30`

`BlueprintRenderer.getVisualLookup()` eingeführt; App nutzt es statt einer
eigenen Kopie. Die manuelle Synchronisation beim Datensatzwechsel entfällt
ersatzlos. `noUnusedLocals` fand den toten Import.

## Anmerkung zur Browser-Verifikation
Der Browser-Pane läuft als **versteckter Tab** (`document.hidden === true`).
Dort gilt:
- `requestAnimationFrame` feuert **überhaupt nicht** (gemessen: 0 in 1500 ms)
- `img.decode()` ist gedrosselt → die Decode-Queue des Sprite-Atlas läuft
  nicht leer, es wurden nur **6 von ~180** Sheets geladen → Canvas bleibt leer

Beides ist eine Eigenschaft der Umgebung, **keine Regression**: die
headless-Verifikationen (`verify-render-identical`, `verify-f01-cache`,
`verify-f01-dirty`) laufen unverändert grün, und der Gesamt-Hash ist seit
Beginn identisch. Für DOM-Dinge (Tooltip-Position, Fonts, CSP) war der
Browser dagegen aussagekräftig und wurde genutzt.

---
## F-06 — Vorbereitung ⏸️ (Branch `audit/f06-vorbereitung`, KEIN Rollout)
2026-09-09

### Schritt 1: Gegenprüfung der kritischen Layer-Arten
`audit/scripts/f06-verify-layers.ts` — **wichtigstes Ergebnis des Audits-Followups:**

| Entity | Sheet | Achsen-Modell sagt | real beobachtet |
|---|---|---:|---:|
| nuclear-reactor | reactor-connect-patches.png | **1 Zelle** | **12 Zellen** |
| heating-tower | heating-tower-pipes.png | 1 | **4** |
| heating-tower | heating-tower-pipes-disconnected.png | 1 | **4** |

→ **32 Abweichungen.** Ein Zuschnitt nach `column.by`/`row.by` hätte beim
Reaktor **11 real benutzte Frames weggeschnitten.** Die Phase-7-Warnung des
Audits war berechtigt und ist hiermit konkret belegt.

`per:"module-slot"` (nur `beacon`) ist dagegen **unkritisch**: jedes Sprite
liegt in einer eigenen Datei mit genau 1 Zelle.

**Konsequenz für die Umsetzung: Der Zuschnitt MUSS auf der empirischen
Zellerfassung (collectEntity real ausführen) aufsetzen, nie auf den Achsen.**

### Schritt 2: Prototyp für genau eine Familie (`recycler`)
`audit/scripts/f06-crop-prototype.ts` — 8 Sheets (4 Richtungen + Schatten):

| | vorher | nachher |
|---|---:|---:|
| recycler gesamt | **15,1 MB** | **481 KB** (-96,9 %) |
| recycler-W.png | 3,97 MB | 97 KB (-97,6 %) |
| recycler-E.png | 3,51 MB | 96 KB (-97,3 %) |

Jedes Sheet ist 8×8 Zellen groß, genutzt wird **genau 1**.

### Schritt 3: Vorher/Nachher-Vergleich
`audit/scripts/f06-render-comparison.ts`: Alle 8 Sheets **pixelgenau
identisch** (400.820 Pixel verglichen, 0 abweichend).
Seite-an-Seite-Bild: `audit/f06/comparison-recycler-N.png`
(links Original-Zelle, rechts zugeschnitten — visuell nicht unterscheidbar).

**Hier gestoppt, wie beauftragt.** Kein Ausrollen auf weitere Entities, kein
Eingriff in `public/data/sprites` oder den Katalog. Die Artefakte liegen in
`audit/f06/` (700 KB).

---
## Nachtrag — gemeldete Ruckler beim Bewegen

### Ursache 1: Regression durch meinen Szenen-Cache ✅ behoben
**Commit:** `82487c5`

`bench-pan.ts` (neu) misst Pan/Zoom statt nur Stillstand — genau der Fall,
den die bisherigen Benchmarks **nicht** abdeckten:

| | vorher | nachher |
|---|---:|---:|
| PAN, Bioflux | **921,88 ms/Frame** | **6,02 ms** |
| ZOOM, Bioflux | **2413,53 ms/Frame** | **11,96 ms** |
| ZOOM, Promethium | 3481,38 ms | 15,39 ms |

Zwei Fehler, beide meine:
1. `buildSceneCache` prüfte das Animationsverhalten mit **257 Collect-Läufen
   über die ganze Szene** — bei jedem Cache-Miss, also in jedem Frame beim
   Bewegen. Jetzt pro Entity-Typ einmal, memoisiert (`animProfiles`).
2. Der Cache-Key verkettete **alle sichtbaren IDs zu einem String** — pro
   Frame eine mehrere Kilobyte große Allokation nur zum Vergleichen.

### Ursache 2: Der eigentliche Ruckler (VORBESTEHEND) ✅ behoben
**Commit:** `a979ffd`

Die neue Aufnahme-Funktion, auf der **echten Maschine des Nutzers** über 30 s:

```
paint = 99,9 % der Kosten in den 15 teuersten Frames; collect ≈ 1 ms gesamt
Einzelframes: 1451 / 1773 / 1959 ms — komplett paint
108 ms paint für DREI Draw-Commands
42 % der gesamten Sitzung im drawImage-Stall
```

108 ms für 3 Commands ist keine Zeichenarbeit, sondern **Decode beim ersten
drawImage**. `img.decode()` garantiert nur *Dekodierbarkeit*; der Browser
dekodiert beim ersten Sampling erneut — synchron, mitten im Frame, bei
Sheets bis 11 MB.

`spriteAtlas` nutzt jetzt `fetch` + `createImageBitmap`: einmal dekodiert,
off-thread, fertige Pixel. `<img>` bleibt als Fallback.

**Wichtig — noch offen:** Ich konnte die Wirkung **nicht auf der Maschine des
Nutzers nachmessen** (der Browser-Pane drosselt Decoding). Die Aufnahme, die
das Problem gefunden hat, sollte nach dieser Änderung wiederholt werden.

---
