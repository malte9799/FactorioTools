# 00 — Executive Summary

**Projekt:** FactorioTools — Blueprint-Viewer und Ratenrechner
**Umfang:** 15.673 LOC First-Party, 4 Workspaces, Vanilla TypeScript + Canvas 2D
**Datum:** 2026-09-08 · **Branch:** `main`
**Findings:** 19 (3× Schweregrad 5, 3× 4, 6× 3, 5× 2, 2× 1)

---

## Gesamtbild in drei Sätzen

Die **Architektur und Codequalität sind überdurchschnittlich** — 0 Zyklen,
0 Schichtverletzungen, 0 TODOs, 0 `@ts-ignore`, 0 CVEs, strikte
TypeScript-Konfiguration und Kommentare, die durchgehend das *Warum* erklären.
Die Probleme liegen fast ausschließlich in **zwei Bereichen**: einem Renderpfad,
der 60×/s ein Ergebnis neu berechnet, das sich nachweislich nicht ändert, und
einer Sprite-Auslieferung, bei der 87 % der Bytes nie verwendet werden können.
Dazu kommt **eine echte Sicherheitslücke**, die praktisch nachgewiesen ist.

---

## Die 10 wichtigsten Erkenntnisse

### 1. Persistentes XSS über eingefügte Blueprint-Strings — **die dringlichste Maßnahme**
*Schweregrad 5 · Aufwand S (~2 h) · F-16*

Mit `audit/scripts/xss-probe.ts` **praktisch nachgewiesen**: Ein präparierter
Blueprint-String trägt rohes HTML über `decode` → `calculate` in
`warning.entityName` und `moduleLabel`, die an 8 Stellen ungeescaped per
`innerHTML` gerendert werden. Ein Book-Label landet zusätzlich über
`saveToLibrary` in `localStorage` und feuert **bei jedem weiteren
Seitenaufruf**. Blueprint-Strings sind das normale Austauschformat der
Community — sie werden routinemäßig von Fremden kopiert.
*Nutzen/Aufwand: höchster im Projekt. Zwei Stunden.*

### 2. Der Renderer baut in jedem Frame die komplette Szene neu auf — ohne Grund
*Schweregrad 5 · Aufwand M · F-01*

`tick()` ruft `draw()` **bedingungslos**, es gibt kein Dirty-Flag.
**Gemessen** bei 6.478 Entities: **13,65 ms reines JavaScript pro Frame — 82 %
des 60-fps-Budgets, bevor ein Pixel gezeichnet ist.** Über 8 gesampelte Frames
ändert sich dabei **ausschließlich das Feld `sx`**; Command-Anzahl,
-Reihenfolge und Geometrie sind bitidentisch. Modelliertes Caching:
**12,5–14,2 ms Ersparnis pro Frame (Faktor 1288–2219).**
*Ein Dirty-Flag allein (~1 h) beseitigt bereits den kompletten Leerlaufverbrauch.*

### 3. 87 % der ausgelieferten Sprite-Bytes sind nie adressierbar
*Schweregrad 5 · Aufwand L · F-06*

**Gemessen** über alle 482 referenzierten Sheets: **153 von 176 MB** sind
Frames, die der Renderer über seine Achsen niemals ansprechen kann.
`rail-stone-path.png` liefert **512 Frames aus, um 1 zu zeichnen**. Ursache:
`extract-sprites.ts:66` kopiert Entity-Sheets unverändert — obwohl dieselbe
Datei für Icons bereits croppt. Realer Nutzer-Download pro Blueprint:
**Median 13,2 MB, p90 42,1 MB, max 63,9 MB.**
*Größter absoluter Gewinn, aber auch der aufwendigste Punkt.*

### 4. Unbegrenzter Undo-Stack mit Vollkopien — ein Absturzpfad
*Schweregrad 4 · Aufwand S (~15 min) · F-10*

Jeder Edit legt eine Deep-Copy **aller** Entities ab, ohne Obergrenze.
**Gemessen:** 200 Edits auf dem größten Blueprint halten **224 MB** dauerhaft —
zusätzlich zu bis zu 64 MB dekodierter Sprites.
*Ein Ringpuffer mit 50 Einträgen löst es in einer Viertelstunde.*

### 5. 11.355 LOC ohne jeden Test — und die riskanteste Logik ist darunter
*Schweregrad 4 · Aufwand M · F-12*

`renderer`, `data-pipeline` und `site` haben **null Tests**. Betroffen ist
ausgerechnet die Nachbarschafts-Klassifikation, die entscheidet, wie Bänder,
Rohre und Wände visuell zusammenlaufen — dort sind Regressionen subtil.
Die gute Nachricht: **1.684 LOC davon sind komplett DOM-frei** und mit dem
bereits vorhandenen tsx-Runner sofort testbar, ohne jsdom oder neues Framework.
*Voraussetzung dafür, die Punkte 2 und 3 verantwortbar umzusetzen.*

### 6. Der Platzierungsmodus baut pro Frame drei Nachbarschaftsnetze neu
*Schweregrad 4 · Aufwand M · F-02*

Solange etwas „in der Hand" ist, werden `buildGrid`, `buildFluidNetwork` und
`buildHeatNetwork` in **jedem Frame** über eine Vollkopie aller Entities neu
aufgebaut — für einen einzigen Ghost. **Gemessen +2,19 ms/Frame** genau
während der interaktivsten Nutzung.

### 7. 177 ms verschenkt durch einen unnötig sequenziellen Ladevorgang
*Schweregrad 3 · Aufwand S (~10 min) · F-08*

`game-data.json` wird vollständig abgewartet **und geparst**, bevor
`render-catalog.json` überhaupt angefragt wird — obwohl beide unabhängig sind.
**Gemessen: 355 ms sequenziell vs. 178 ms parallel.**
*Bestes Aufwand/Nutzen-Verhältnis des Audits: zehn Minuten für 177 ms.*

### 8. Erzwungener Reflow bei jeder Hover-Bewegung
*Schweregrad 3 · Aufwand S · F-04*

`onSchematicHover` ersetzt den Tooltip-DOM und liest unmittelbar danach
`getBoundingClientRect()` — klassisches Layout Thrashing, im selben Frame wie
die 13,65 ms aus Punkt 2.

### 9. Was **gut** ist und nicht angefasst werden sollte

Ausdrücklich festgehalten: Die **Schichtung** (0 Zyklen, 0 Verletzungen bei 53
Modulen), der **Sprite-Atlas** (begrenzte Decode-Nebenläufigkeit,
`img.decode()` vor Freigabe, Outline-Fallback, geteilte Instanz über Remounts),
die **Trennung `collect`/`paint`** (die Punkt 2 überhaupt erst lösbar macht),
das **`CanvasPattern`-Bodenraster**, das **vollständige `destroy()`**, die
**Fehlerbehandlung** („degradieren statt abstürzen", mit Test dafür), die
**Build-Geschwindigkeit** (3,4 s Check, 1,3 s Build) und die
**Abhängigkeitslage** (20 Pakete, 0 CVEs, alle Lizenzen permissiv).

### 10. Drei naheliegende Ratschläge, die ich geprüft und **verworfen** habe

Weil Messen besser ist als Vermuten:

- **„Sprites nach Sichtfeld lazy laden"** → gemessen **0 % Ersparnis**. Echte
  Blueprints sind kompakt genug, dass nach dem Initial-Framing praktisch alle
  Entities im Bild sind.
- **„PNGs mit einem Image-Optimizer verkleinern"** → Re-Encoding machte die
  Testdateien **19 % größer** (42,3 → 50,2 MB). Die Quell-PNGs sind bereits gut
  komprimiert.
- **„Die lineare Gruppensuche im Hover-Pfad durch eine Map ersetzen"** →
  gemessen **0,10–0,19 µs**. Völlig irrelevant, wird nicht als Finding geführt.

---

## Zweiter Durchgang (Phase 7): was die Nachprüfung geändert hat

Die drei größten Findings wurden mit **jeweils anderer Methode** gegengeprüft.
Alle drei tragen; zwei Empfehlungen mussten **präzisiert** werden:

- **F-01:** Über 128 statt 8 Frames geprüft. Beim größten Blueprint ist die
  Animationsperiode einheitlich (64), bei **gemischten Bandstufen** aber
  **dreifach (64/32/16)**. Ein Cache-Patch mit einer gemeinsamen Periode hätte
  langsamere Bänder desynchronisiert — ein Fehler, der bei Prüfung nur am
  größten Blueprint **nicht aufgefallen wäre**. Die Empfehlung verlangt jetzt
  eine Periode **pro Command**.
- **F-06:** Statt die Adressierung zu modellieren, wurde `collectEntity` real
  über 16 Richtungen × 11 Nachbarschaften × 15 Frames je Entity aufgerufen.
  Ergebnis **89 % statt 87 %** — der Befund trägt. Aber: `rail-stone-path.png`
  nutzt empirisch **4 von 210** Zellen, modelliert nur 1 von 512. Ein Zuschnitt
  auf Basis der Achsen hätte **drei real benutzte Frames weggeschnitten**. Die
  Umsetzung muss auf der empirischen Erfassung aufsetzen.
- **F-16:** Geprüft, ob der Payload nicht nur ankommt, sondern zu einem
  **aktiven** DOM-Element wird: **4 von 4 Fundstellen** erzeugen
  `<img onerror>`. Gegenprobe: Der empfohlene Escaping-Helfer senkt die Zahl
  aktiver Elemente auf **0** — der Fix wirkt nachweislich.

---

## Empfohlene Reihenfolge (Details in `07-roadmap.md`)

| Stufe | Inhalt | Aufwand | Wirkung |
|---|---|---|---|
| **1** | XSS, paralleles Laden, Undo-Deckel, CI, CSP | **~5 h** | Sicherheit bereinigt, **-177 ms** Start, Absturzpfad weg |
| **2** | Renderer-Tests (`beltGraph` zuerst) | 2–3 Tage | Absicherung für Stufe 3 und 4 |
| **3** | Dirty-Flag, Ghost-Netze, Command-Cache | ~1,5 Tage | **13,65 ms → <0,1 ms** JS pro Frame |
| **4** | Sprite-Frames beim Extrahieren zuschneiden | 3–5 Tage | **-153 MB** (87 %) |
| **5** | Bundle-Aufräumen, Schriften, Monolithen | nach Bedarf | Hygiene |

**Wenn nur ein Tag zur Verfügung steht:** Stufe 1 vollständig. Danach ist die
Sicherheitslücke geschlossen, der Start 177 ms schneller, ein Absturzpfad
beseitigt und jede weitere Änderung durch CI abgesichert.

---

## Offene Fragen & Annahmen

Getroffene Annahmen, da während des Audits keine Rückfragen möglich waren:

1. **Deployment-Ziel unbekannt.** `vite.config.ts:6` (`base: "./"`) deutet auf
   GitHub/Codeberg Pages. Ob dort gzip/brotli aktiv ist, konnte ich **nicht
   verifizieren** — F-09 ist deshalb als Prüfauftrag formuliert, nicht als
   bestätigter Fehler.
2. **Zielhardware unbekannt.** Alle Messungen stammen vom Entwicklungsrechner
   (darwin, Node 22). Auf schwächerer Hardware sind die Absolutwerte höher, die
   Verhältnisse bleiben. Die Canvas-`drawImage`-Kosten sind in den
   Frame-Messungen **nicht** enthalten — die realen Frame-Zeiten im Browser
   liegen also über den genannten Werten.
3. **„Große Blueprints" definiert als die 176 mitgelieferten Beispiele**
   (4–6.478 Entities, Median 160). Sollten Nutzer regelmäßig noch größere
   Blueprints öffnen, verschärfen sich F-01, F-02 und F-10 entsprechend.
4. **Der Renderer wurde nicht im Browser vermessen.** Auf Wunsch wurde auf
   Browser-Automatisierung verzichtet; alle Messungen laufen headless über die
   echten Module in Node. Die JS-Kosten sind damit belastbar, GPU-, Decode- und
   Compositing-Kosten dagegen **nicht gemessen** und im Bericht als solche
   gekennzeichnet.
5. **F-05 (Integer-Map-Schlüssel) ist hergeleitet, nicht gemessen** — der
   Anteil wurde nicht isoliert. Deshalb bewusst zurückgestellt.
6. **Zur Rechtelage der extrahierten Sprites** (Material von Wube Software)
   äußere ich mich nicht — für eine öffentliche Bereitstellung wäre die Frage
   gesondert zu klären.

---

## Reproduzierbarkeit

Alle Messungen stammen aus eigenen Skripten in `audit/scripts/`:

```bash
node  audit/scripts/depgraph.mjs              # Zyklen, Schichtverletzungen
node  audit/scripts/bundle-attribution.mjs <sourcemap>
node  audit/scripts/bench-startup-fetch.mjs   # Lade-Wasserfall
npx tsx audit/scripts/bench-collect.ts        # Per-Frame-JS
npx tsx audit/scripts/bench-anim-delta.ts     # was sich pro Frame ändert
npx tsx audit/scripts/bench-cache-model.ts    # erreichbarer Cache-Gewinn
npx tsx audit/scripts/bench-sprite-payload.ts # Download pro Blueprint
npx tsx audit/scripts/analyze-frame-waste.ts  # ungenutzte Sprite-Frames
npx tsx --expose-gc audit/scripts/bench-undo-memory.ts
npx tsx audit/scripts/xss-probe.ts            # XSS-Nachweis
```

Kein Produktivcode wurde verändert.
