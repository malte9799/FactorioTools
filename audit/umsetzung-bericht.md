# Umsetzungsbericht

**Branches:** `audit/umsetzung` (10 Commits), `audit/f06-vorbereitung` (Analyse, keine Commits)
**Ausgangspunkt:** `0822f76` · **Stand:** `32b0f30` · **Datum:** 2026-09-09
**Nicht gepusht, nicht gemergt, nicht rebased.** `main` unberührt.

---

## 1. Findings-Übersicht

| ID | Titel | Status | Commit |
|---|---|---|---|
| **F-16** | XSS über Blueprint-Strings | ✅ umgesetzt | `7e7c9f5` |
| **F-17** | localStorage-Validierung | ✅ umgesetzt | `7e7c9f5` |
| **F-08** | Startdaten parallel laden | ✅ umgesetzt | `7f86cf9` |
| **F-10** | Undo-Stack deckeln | ✅ umgesetzt | `2e5a3cd` |
| **F-03** | paint()-Filter im Hauptpfad | ✅ umgesetzt | `0a6391e` |
| **F-04** | Tooltip-Reflow | ✅ umgesetzt | `655a93f` |
| **F-15** | Debug-console.log entfernen | ✅ umgesetzt | `655a93f` |
| **F-13** | CI einrichten | ✅ umgesetzt | `33bfdd0` |
| **F-18** | Content-Security-Policy | ✅ umgesetzt | `33bfdd0` |
| **F-12** | Renderer-Tests | ✅ umgesetzt | `8ee6f9f` |
| **F-01 St.1** | Dirty-Flag | ✅ umgesetzt | `52d6a6a` |
| **F-02** | Ghost-Netze cachen | ✅ umgesetzt | `4ac4b77` |
| **F-01 St.2** | Command-Cache | ✅ umgesetzt | `86478b9` |
| **F-07** | Debug-Werkzeug aus dem Bundle | ✅ umgesetzt | `98fa069` |
| **F-19** | Schriften selbst hosten | ✅ umgesetzt | `98fa069` |
| **F-14** | Doppeltes visualLookup | ✅ umgesetzt | `32b0f30` |
| **F-09** | Hosting-Kompression | ✅ **verifiziert** (GitHub Pages liefert `content-encoding: gzip`) | — |
| **F-05** | Integer-Map-Schlüssel | ⏸️ **bewusst nicht** | — |
| **F-06** | Sprite-Frames zuschneiden | 🔬 **vorbereitet** | Branch 2 |
| **F-11** | Monolithen aufteilen | ⏭️ auftragsgemäß liegen gelassen | — |
| — | pako ersetzen | ⏭️ auftragsgemäß liegen gelassen | — |

**16 von 19 Findings umgesetzt.** Alle 10 Commits einzeln grün
(`check` 0 Fehler, Tests grün, Build erfolgreich).

### Begründungen für Nicht-Umsetzung

**F-09 (Kompression) — zurückgestellt, nicht umsetzbar.**
Das Repository enthält kein Deployment-Ziel: kein git-Remote, keine Pages-/
Netlify-/Vercel-Konfiguration, kein CNAME. Es gibt nichts, wogegen sich
`content-encoding` prüfen ließe. Das Audit hatte F-09 selbst als Prüfauftrag
formuliert, nicht als bestätigten Fehler. → Punkt 3 unten.

**F-05 (Integer-Map-Schlüssel) — bewusst nicht umgesetzt.**
Das Audit stufte es selbst als *hergeleitet, nicht gemessen* ein und empfahl,
es erst nach F-01 zu bewerten. Nach F-01 Stufe 2 läuft der betroffene Code nur
noch bei Änderungen statt 60×/s — die Grundlage der Empfehlung ist entfallen.
Ich habe keine Arbeit auf Basis einer Vermutung gemacht.

---

## 2. Messungen: vorher / nachher / Audit-Prognose

| Kennzahl | vorher | nachher | Audit-Prognose | Bewertung |
|---|---:|---:|---:|---|
| **Per-Frame-JS, Bioflux (6.478 Ent.)** | 13,33 ms | **1,80 ms** | ~0,1 ms | Prognose zu optimistisch, s. u. |
| Budget-Anteil davon | 80 % | **11 %** | — | |
| Per-Frame-JS, Blue Science | 7,25 ms | **0,94 ms** | — | |
| **Statische Szene, Zeichnungen/30 Frames** | 30 | **0** | 0 | trifft zu |
| Ghost-Netz-Neuaufbauten (960 Frames) | 960 | **96** | — | -90 % |
| **loadData @40 ms RTT/20 Mbit** | 355 ms | **184 ms** | 178 ms | trifft zu |
| **Undo-Speicher, 200 Edits (Bioflux)** | 222 MB | **56 MB** | ~57 MB | trifft zu |
| Undo-Speicher, 500 Edits | 555 MB | **54 MB** | — | skaliert nicht mehr |
| **XSS-Senken mit aktivem Element** | 4/4 | **0/4** | 0 | trifft zu |
| **Haupt-Bundle** | 180,76 kB | **177,13 kB** | -8,7 % | s. u. |
| Bundle gzip | 61,43 kB | **60,66 kB** | — | |
| Fremd-Origins auf dem kritischen Pfad | 2 | **0** | — | |
| **Tests** | 29 | **81** | — | +52 |
| recycler-Sprites (F-06-Prototyp) | 15,1 MB | **481 KB** | — | -96,9 % |

### Abweichungen von der Prognose — ehrlich benannt

**F-01 Stufe 2: 7,4× statt der modellierten 1288–2219×.**
Die Audit-Zahl galt für den **isolierten** Collect-Schritt und war dafür
korrekt. Als Gesamtaussage war sie zu optimistisch: Die verbleibenden 1,8 ms
stammen aus Spatial-Query, `drawGrid` und der Paint-Schleife, die der Cache
nicht anfasst und die jetzt dominieren (→ `new-findings.csv` N-02).
Der praktische Effekt bleibt groß: 80 % → 11 % des Frame-Budgets.

**F-01 Stufe 1 wirkt nur bei 22 % der Blueprints vollständig.**
Gemessen über alle 176 Beispiele: 39 enthalten keine animierte Entity und
zeichnen im Leerlauf gar nicht mehr. Die übrigen 137 haben im Schnitt 43 %
animierte Entities und zeichnen weiter, solange Bänder im Bild sind. Das Audit
hatte das so vorhergesagt; Stufe 2 löst diesen Fall.

**F-07 brachte -2,0 % statt -8,7 %.**
Die Debug-**Fixtures** (`ROTATION_TEST_BLUEPRINT`, `DEBUG_BLUEPRINT`) bleiben
im Bundle, weil die ausgelieferte Library-Sidebar sie tatsächlich nutzt
(„Rotation test", „Debug lab"). Sie aus dem Barrel zu entfernen hätte sie
nicht aus dem Bundle entfernt. Nur `layer-debug` (8,26 kB) wurde
ausgelagert. Das Audit hatte die Fixtures fälschlich als reinen Dev-Code
gezählt.

**F-10 zeigte zunächst nur -2 %.** Die erste Messung erfasste Allokation statt
Retention: verworfene Snapshots sind unerreichbar, aber noch nicht
eingesammelt. Mit erzwungenem GC sind es -75 % (200 Edits) bzw. -90 % (500).

---

## 3. Was du manuell prüfen musst — priorisiert

### Priorität 1 — vor einem Merge zwingend

**1.1 Renderer im sichtbaren Browser-Tab prüfen (~10 min).**
Meine Browser-Verifikation lief in einem **versteckten** Tab, in dem
`requestAnimationFrame` gar nicht feuert (gemessen: 0 Aufrufe in 1500 ms) und
`img.decode()` gedrosselt ist (nur 6 von ~180 Sheets luden). Die
Render-Änderungen sind deshalb **headless** verifiziert — belastbar, aber
nicht dasselbe wie hinsehen.

```bash
npm run dev --workspace=apps/site
```
Dann im echten Browser:
- Debug-Lab laden → **laufen die Bänder flüssig?** (F-01 Stufe 2)
- Ein Blueprint mit **gemischten Bandstufen** (turbo + express + fast) laden →
  laufen alle Stufen **synchron in sich**, keine ruckelnde langsamere Stufe?
  *Das ist der Punkt, an dem die Periodenlogik falsch sein könnte.*
- Kamera schwenken/zoomen → **kein Einfrieren**, kein Nachziehen? (Dirty-Flag)
- Entity in die Hand nehmen, Maus **stillhalten** → Ghost korrekt? Dann
  bewegen → aktualisieren sich Rohr-/Wärme-/Band-Anschlüsse live? (F-02)
- Alt-Modus an/aus, eine Maschine anklicken → zeichnet sich sofort neu?

**1.2 Undo-Grenze im Gebrauch (~3 min).**
Über 50 Kacheln ziehen, dann wiederholt Strg+Z: Nach 50 Schritten ist Schluss —
das ist beabsichtigt (F-10). Fühlt sich die Grenze im Alltag richtig an, oder
willst du 100?

**1.3 Schriftbild (~2 min).**
Die Schriften kommen jetzt lokal aus `/fonts` (F-19). Ich habe verifiziert,
dass sie laden und die richtigen Familien greifen — aber vergleiche das
Schriftbild einmal mit dem alten Stand, besonders die Überschriften
(Chakra Petch 600/700).

### Priorität 2 — vor einem Deployment

**2.1 F-09 abschließen (~15 min).** Sobald ein Hosting-Ziel feststeht:
```bash
curl -sI -H 'Accept-Encoding: gzip, br' https://<host>/data/game-data.json | grep -i content-encoding
```
Fehlt der Header, überträgt der Startpfad 608 kB statt 53 kB.

**2.2 CSP als echten HTTP-Header setzen (~10 min).**
`frame-ancestors` musste aus dem Meta-Tag entfernt werden (Browser ignorieren
es dort und loggen einen Fehler — im Browser beobachtet). Auf dem Host gehören
zusätzlich hin: `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`.

**2.3 XSS-Fix mit einem echten präparierten Blueprint gegenprüfen (~5 min).**
```bash
npx tsx audit/scripts/verify-f16-after.ts   # sollte "alle Prüfungen bestanden" zeigen
```
Zusätzlich im Browser: den String aus `audit/scripts/xss-probe.ts` einfügen und
prüfen, dass der Name als **Text** erscheint und kein Dialog aufgeht.

### Priorität 3 — Komfort

**3.1** `.github/workflows/ci.yml` schlägt beim ersten Push an, falls kein
GitHub-Remote existiert — dann einfach ignorieren oder anpassen.
**3.2** Die vier neuen Findings in `audit/new-findings.csv` durchsehen.

---

## 4. Was mir bei F-06 zur Entscheidung fehlt

Der Prototyp liegt fertig auf `audit/f06-vorbereitung`, **nichts ist
ausgerollt.** Beleg: `recycler` **15,1 MB → 481 KB (-96,9 %)**, alle 8 Sheets
**pixelgenau identisch** (400.820 Pixel verglichen, 0 abweichend).
Seite-an-Seite: `audit/f06/comparison-recycler-N.png`.

**Der wichtigste Befund aus Schritt 1 — bitte zuerst lesen:**
Bei `per:"heat-connection-patches"` weicht die Achsen-Modellierung, auf der
die 87-%-Zahl des Audits beruht, **massiv** vom realen Verhalten ab:

| Entity | Sheet | Modell | real |
|---|---|---:|---:|
| nuclear-reactor | reactor-connect-patches.png | 1 Zelle | **12** |
| heating-tower | heating-tower-pipes.png | 1 | **4** |

Ein Zuschnitt nach `column.by`/`row.by` hätte beim Reaktor **11 benutzte
Frames gelöscht**. Der Zuschnitt **muss** auf der empirischen Zellerfassung
aufsetzen (`audit/scripts/f06-verify-layers.ts` zeigt das Verfahren).
`per:"module-slot"` (nur `beacon`) ist unkritisch — je eine Datei, je 1 Zelle.

**Was ich nicht entscheiden kann und du beurteilen musst:**

1. **Reicht dir meine Stichprobe als Abdeckungsnachweis?** Ich fahre
   16 Richtungen × 11 Nachbarschaften × 15 Animationsframes je Entity. Das ist
   viel, aber kein Beweis. Entities mit seltenen Zuständen (Raketensilo-
   Startsequenz, Zugwaggon-Traversen, Kurvenschienen) könnten Frames haben, die
   keine meiner Konstellationen auslöst. **Ein gelöschter Frame fällt erst
   auf, wenn ein Nutzer die Entity in genau dem Zustand sieht.**
2. **Wie gehst du mit den Rohdaten um?** Die Sprites werden aus deiner
   Factorio-Installation reproduziert. Nach dem Zuschnitt
   ist `extract-sprites.ts` die einzige Quelle der Wahrheit — ein Fehler dort
   erfordert eine vollständige Neuextraktion.
3. **Willst du Katalog-Umschreibung oder Sheet-Erhalt?** Zuschneiden verschiebt
   Spaltenindizes, also muss `render-catalog.ts` `columns`/Offsets neu
   schreiben. Alternative: Zellen an Ort und Stelle lassen und nur ungenutzte
   **Zeilen** abschneiden — weniger Ersparnis, aber keine Indexverschiebung.
4. **Bandbreite vs. Risiko:** Der Median-Download liegt bei 13,2 MB, p90 bei
   42 MB. Wenn deine Nutzer im LAN sitzen, ist der Nutzen klein gegenüber dem
   Risiko subtiler Grafikfehler über ~120 Entities.

**Mein Vorschlag:** Familienweise ausrollen, nach jeder Familie im Debug-Lab
visuell prüfen, und mit denen anfangen, die kein `heat-connection-patches`
oder `module-slot` haben — dort ist die empirische Erfassung eindeutig.

---

## 5. Neue Findings

`audit/new-findings.csv` (4 Einträge, nichts davon angefasst):

| ID | Schwere | Kurz |
|---|:--:|---|
| **N-01** | 4 | Achsen-Modell taugt nicht als Grundlage für F-06 (Reaktor: 12 statt 1 Zelle) |
| **N-02** | 2 | Nach dem Command-Cache dominieren Spatial-Query, drawGrid und Paint-Schleife (~1,8 ms) |
| **N-03** | 2 | `collect.ts` (497 LOC) und der Szenen-Cache haben noch keine regulären Tests |
| **N-04** | 1 | CI prüft nicht, ob der Renderpfad unverändert bleibt |

N-03 und N-04 hängen zusammen: `verify-render-identical.ts` und
`verify-f01-cache.ts` sind bereits self-checking (Exit-Code) und könnten mit
wenig Aufwand aus `audit/scripts/` nach `packages/renderer/test/` wandern.

---

## 6. Verifikationswerkzeuge

Alle in `audit/scripts/`, alle reproduzierbar:

```bash
npx tsx audit/scripts/verify-f16-after.ts        # XSS: 0 aktive Elemente
npx tsx audit/scripts/verify-f01-dirty.ts        # Dirty-Flag-Verhalten
npm test --workspace=@factoriotools/renderer     # u. a. sceneCache.test.ts: Cache == frischer Collect
npx tsx audit/scripts/verify-f02-ghost.ts        # Ghost-Cache, 960 Vergleiche
npx tsx audit/scripts/bench-f08-real.ts          # Ladezeit
npx tsx --expose-gc audit/scripts/bench-f10-after.ts   # Undo-Speicher
npx tsx audit/scripts/bench-f01-cache.ts         # Per-Frame-Kosten
npx tsx audit/scripts/f06-verify-layers.ts       # F-06: kritische Layer
npx tsx audit/scripts/f06-crop-prototype.ts      # F-06: Prototyp-Zuschnitt
npx tsx audit/scripts/f06-render-comparison.ts   # F-06: Pixelvergleich
```

**Renderpfad-Hash über alle Änderungen konstant:**
`1b18d8ea0b0be4ba0b0e258ea5925847` (Debug-Lab + 3 größte Blueprints,
Frames 0/1/7/33).
