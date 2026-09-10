# 07 — Roadmap

## Ordnungsprinzip

Sortiert nach **Wirkung pro investierter Stunde**, mit zwei Ausnahmen von der
reinen Rechnung:

1. **F-16 (XSS) steht vorne, obwohl es keine Funktion verbessert.** Es ist die
   einzige Schwachstelle, die *anderen* Menschen schaden kann, sie ist praktisch
   nachgewiesen und sie kostet zwei Stunden. Alles andere kann warten.
2. **F-12 (Renderer-Tests) steht vor den großen Umbauten**, obwohl es selbst
   nichts beschleunigt. F-01 und F-06 verändern den Renderpfad tiefgreifend —
   ohne Tests sind das Blindflüge. Die Tests sind die Voraussetzung dafür, die
   großen Maßnahmen überhaupt verantwortbar durchzuführen.

Die Zeitangaben sind Schätzungen für jemanden, der den Code kennt.

---

## Stufe 1 — Quick Wins (jeweils unter 1 h, zusammen ~5 h)

| # | Finding | Aufwand | Wirkung |
|---|---|---|---|
| 1 | **F-16** XSS beheben | ~2 h | Beseitigt die einzige echte Schwachstelle |
| 2 | **F-08** Startdaten parallel laden | ~10 min | **-177 ms** bis zum ersten echten Rendering (gemessen) |
| 3 | **F-10** Undo-Stack deckeln | ~15 min | Beseitigt einen Absturzpfad (**224 MB → ~57 MB**) |
| 4 | **F-03** `paintPlain` direkt aufrufen | ~15 min | 2 Array-Allokationen pro Frame weniger |
| 5 | **F-15** Debug-`console.log` entfernen | ~2 min | Hygiene |
| 6 | **F-13** CI einrichten | ~30 min | Verhindert Regressionen ab sofort |
| 7 | **F-09** Kompression verifizieren | ~15 min | Ggf. **608 kB → 53 kB** im Startpfad |
| 8 | **F-18** CSP-Meta-Tag | ~15 min | Tiefenverteidigung zu F-16 |
| 9 | **F-17** localStorage-Einträge validieren | ~20 min | Tiefenverteidigung zu F-16 |

**Warum diese Reihenfolge:** F-16 zuerst aus dem oben genannten Grund. Danach
F-08 und F-10 — zusammen 25 Minuten für 177 ms Ladezeit und einen beseitigten
Absturzpfad, das beste Verhältnis im ganzen Projekt. F-13 (CI) bewusst *vor*
den größeren Maßnahmen, damit ab da jede Änderung automatisch geprüft wird.

Nach Stufe 1: Die Sicherheitslage ist bereinigt, der Start ist spürbar
schneller, und Regressionen werden automatisch gefangen. **Der wahrnehmbare
Renderdurchsatz ist noch unverändert.**

---

## Stufe 2 — Absicherung vor den großen Eingriffen (~2–3 Tage)

| # | Finding | Aufwand | Wirkung |
|---|---|---|---|
| 10 | **F-12** Renderer-Tests, beginnend mit `beltGraph` | M | Macht F-01/F-06 überhaupt verantwortbar |

Konkret: `packages/renderer/test/` anlegen, `test`-Skript im Paket ergänzen,
Wurzel-`test` auf `--workspaces` umstellen. Dann in dieser Reihenfolge:
`beltGraph` (höchste Komplexität, höchstes Regressionsrisiko) → `pipe`/`wall` →
`fluid`/`heat` → `spatialIndex`/`camera`.

Der Ansatz kann pragmatisch sein: Für die Klassifikatoren genügt es zunächst,
das **Ist-Verhalten** für eine Reihe repräsentativer Konstellationen
festzuschreiben (Charakterisierungstests). Das schützt gegen unbeabsichtigte
Änderungen, auch ohne dass jede Erwartung vorher hergeleitet wurde.

**Warum nicht früher:** Ohne Stufe 1 wäre offen, ob man Tests gegen Code
schreibt, den man ohnehin sofort ändert. Nach Stufe 1 ist der Code stabil genug.

**Warum nicht später:** F-01 Stufe 2 und F-06 fassen beide die visuelle
Korrektheit an. Ohne Tests bemerkt man Regressionen erst, wenn ein Nutzer sich
über falsch gezeichnete Bänder wundert.

---

## Stufe 3 — Der Renderdurchsatz (~1,5 Tage)

| # | Finding | Aufwand | Wirkung (gemessen/modelliert) |
|---|---|---|---|
| 11 | **F-01 Stufe 1** Dirty-Flag | ~1 h | Leerlauf: **13,65 ms/Frame → 0** |
| 12 | **F-02** Ghost-Netze nur bei echter Änderung | ~2 h | **-2,19 ms/Frame** beim Bauen |
| 13 | **F-01 Stufe 2** Command-Cache | ~1 Tag | **-12,5 bis -14,2 ms/Frame** (1288–2219×) |

**Warum diese Reihenfolge innerhalb der Stufe:** F-01 Stufe 1 ist eine Stunde
Arbeit und beseitigt bereits den unsinnigsten Zustand — 60 volle
Szenen-Neuaufbauten pro Sekunde, während der Nutzer nichts tut. F-02 ist die
zweitgrößte Einzelersparnis und unabhängig umsetzbar. F-01 Stufe 2 ist der
größte Hebel, aber auch der invasivste Eingriff — deshalb zuletzt, auf
getestetem Fundament.

**Was danach zu erwarten ist:** Auf dem größten Beispiel-Blueprint (6.478
Entities) sinkt die JS-Last pro Frame von 13,65 ms auf unter 0,1 ms bei
statischer Ansicht und auf wenige Zehntel-Millisekunden bei laufender
Band-Animation. Das Frame-Budget ist dann von der Canvas-Zeichenarbeit
bestimmt, nicht mehr von JavaScript — das ist der Zustand, den man haben will.

**F-05 (Integer-Map-Schlüssel) bewusst NICHT in dieser Stufe.** Nach F-01 läuft
der betroffene Code nur noch bei Änderungen statt 60×/s. Erst danach profilieren
und nur umsetzen, wenn er dann noch auffällt. Ich habe seinen Anteil nicht
isoliert gemessen und empfehle keine Arbeit auf Basis einer Vermutung.

---

## Stufe 4 — Die Datenmenge (~3–5 Tage)

| # | Finding | Aufwand | Wirkung (gemessen) |
|---|---|---|---|
| 14 | **F-06** Sprite-Frames im Extraktionsschritt zuschneiden | L | **153 MB von 176 MB** eingespart (87 %) |

Der mit Abstand größte absolute Gewinn des gesamten Audits — und zugleich der
aufwendigste und riskanteste Punkt, weil er die visuelle Korrektheit aller ~120
Entities berührt.

**Vorgehen:**
1. Erst die Analyse aus `analyze-frame-waste.ts` gegen das vorhandene
   Layer-Debug-Werkzeug gegenprüfen: Adressiert wirklich kein Pfad Frames
   anders, als `column.by`/`row.by` es beschreiben? (`per: "module-slot"` und
   `heat-connection-patches` haben eigene Indexlogik — das Skript behandelt sie
   gesondert, aber das gehört visuell bestätigt.)
2. Croppen zunächst für **eine** Entity-Familie umsetzen und visuell vergleichen.
3. Erst dann auf alle ausrollen, mit einem Vorher/Nachher-Screenshot-Vergleich
   über den Debug-Lab-Blueprint (der eine Instanz jeder Entity enthält).

**Warum zuletzt:** Größter Aufwand, höchstes Regressionsrisiko, und der Nutzen
ist Ladezeit — nicht Interaktivität. Wer zuerst Stufe 3 macht, hat die App
flüssig; Stufe 4 macht sie zusätzlich schnell ladend.

**Wichtig:** Die naheliegenden Alternativen sind geprüft und verworfen —
Lazy-Loading nach Sichtfeld bringt gemessen **0 %**, PNG-Reoptimierung macht die
Dateien **19 % größer**. Es gibt zu F-06 keine billigere Abkürzung.

---

## Stufe 5 — Aufräumen, wenn Zeit ist

| # | Finding | Aufwand | Anmerkung |
|---|---|---|---|
| 15 | **F-07** Debug-Code aus dem Bundle | S | 8,7 % kleiner — bei 61 kB gzip absolut wenig |
| 16 | **F-19** Schriften selbst hosten | S | Ein Round-Trip und eine Fremddomain weniger |
| 17 | **F-14** Doppeltes `visualLookup` | S | Reine Hygiene |
| 18 | **F-11** Monolith-Funktionen aufteilen | L | Nur schrittweise, getrieben durch F-12 |
| 19 | pako ersetzen/dynamisch laden | M | ~30 % Bundle, aber API wird `async` |

Diese Punkte sind alle **legitim, aber keiner ist dringend**. F-11 sollte nicht
als eigenes Projekt angegangen werden, sondern als Nebenprodukt von F-12: Jedes
Mal, wenn für einen Test etwas testbar gemacht werden muss, wandert ein Stück
Zustand aus dem Monolithen heraus.

---

## Was bewusst NICHT auf der Roadmap steht

Damit klar ist, was nicht anzufassen ist:

| Bereich | Warum nicht |
|---|---|
| **Modulstruktur / Schichtung** | 0 Zyklen, 0 Schichtverletzungen bei 53 Modulen. Sauber. |
| **`spriteAtlas.ts`** | Decode-Nebenläufigkeit, `img.decode()`, Outline-Fallback, geteilte Instanz — durchdachter als üblich. |
| **`collect`/`paint`-Trennung** | Genau dieser Schnitt macht F-01 Stufe 2 möglich. |
| **Frustum-Culling, `CanvasPattern`-Raster, globaler Sort** | Gemessen unkritisch bzw. für Korrektheit nötig. |
| **`destroy()`-Aufräumen** | Vollständig, kein Leak. |
| **Fehlerbehandlung** | Konsistentes „degradieren statt abstürzen", mit Test dafür. |
| **`any` in `data-pipeline`** | An der Systemgrenze zum untypisierten Lua-Dump vertretbar. |
| **Build-Geschwindigkeit** | 3,4 s Check + 1,3 s Build. Nichts zu tun. |
| **Abhängigkeiten** | 20 Pakete, 0 CVEs, alle Lizenzen permissiv. |
| **`blueprint_book.txt`** | Sieht nach Altlast aus, ist aber Build-Eingabe. |
| **Doppelter Code in `paintPlain`/`paintTinted`** | ~15 Zeilen; Zusammenführung riskiert die subtile Tint-Semantik für wenig Gewinn. |
| **Sprite-Atlas ohne Eviction** | Bewusste, dokumentierte Abwägung. Nach F-06 erledigt sich das Thema. |
| **Sprite-Reoptimierung, Viewport-Lazy-Loading** | Gemessen wirkungslos bzw. kontraproduktiv. |
