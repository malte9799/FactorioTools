# 01 — Architektur

## Stack (selbst ermittelt, Phase 0)

| Aspekt | Befund |
|---|---|
| Sprache | TypeScript 5.9.3, `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` |
| UI-Framework | **keines** — Vanilla DOM (`innerHTML`/`createElement`), kein React/Vue/Svelte |
| Rendering | **Canvas 2D**, handgeschrieben, keine Rendering-Library |
| Build | Vite 6.4.3, npm workspaces (Monorepo) |
| Client-Runtime-Deps | **genau eine**: `pako` (zlib für Blueprint-Strings) |
| Tests | 4 handgeschriebene tsx-Skripte, kein Test-Framework |
| Linter/Formatter/CI | **nicht vorhanden** |

Wichtig für alles Folgende: Es gibt **kein Komponenten-Framework**. Klassische
Rendering-Ratschläge (`React.memo`, stabile Props, Context-Splitting,
Listen-Virtualisierung) sind hier **schlicht nicht anwendbar**. Der Render-Pfad
ist eine rAF-Schleife über einen Canvas — die Analyse in `02-rendering.md`
richtet sich entsprechend danach.

## Projektgröße (gemessen)

15.673 LOC First-Party in 60 Dateien:

| Workspace | Src-LOC | Rolle |
|---|---:|---|
| `apps/site` | 4.460 (+1.457 CSS) | UI, Routing, Werkzeuge |
| `packages/renderer` | 3.560 | Canvas-Renderer, Nachbarschafts-Klassifikation |
| `packages/data-pipeline` | 3.335 | Node-Only: Factorio-Dump → JSON + Sprites |
| `packages/engine` | 2.117 | Blueprint-Codec, Raten-/Durchsatzrechnung |

## Modulgraph (gemessen, `audit/scripts/depgraph.mjs`)

Tarjan-SCC + Layer-Prüfung über **53 Module / 143 Kanten**:

```
Zyklen (SCC > 1):        keine
Layer-Verletzungen:      keine
```

Die Schichtung wird **strikt** eingehalten:

```
engine  ──▶  renderer  ──▶  site
   └──────▶  data-pipeline (Node-only, baut die Assets)
```

Kein Rückwärts-Import, keine Zyklen. **Das ist sauber gelöst und sollte nicht
angefasst werden.** Bei 15k LOC ohne Framework-Vorgaben ist das nicht
selbstverständlich.

### Kopplung

| Modul | Fan-out | Fan-in |
|---|---:|---:|
| `renderer/src/render.ts` | 15 | 3 |
| `renderer/src/index.ts` | 13 | 3 |
| `site/.../blueprint-viewer/index.ts` | 12 | 1 |
| `engine/src/index.ts` | 11 | **33** |
| `renderer/src/neighbours/grid.ts` | 1 | 12 |

`engine/src/index.ts` ist ein Barrel-Export mit Fan-in 33. Das ist an sich in
Ordnung, hat aber eine konkrete Nebenwirkung: Es re-exportiert auch
`data/rotation-test.js`, `data/debug-lab.js` und `data/bug-repro.js`, wodurch
Debug-Fixtures im Produktions-Bundle landen (siehe `03-performance.md`, F-07).

## Datenfluss

```
Factorio-Installation
   │  (data-pipeline, offline, Node)
   ├─ dump-to-gamedata.ts ──▶ game-data.json      (292 KB)
   ├─ render-catalog.ts   ──▶ render-catalog.json (318 KB)
   └─ extract-sprites.ts  ──▶ sprites/*.png       (245 MB, 590 Dateien)
                                    │
                              (Laufzeit, Browser)
   Blueprint-String ──pako.inflate──▶ Envelope ──normaliseEntities──▶ PlacedEntity[]
                                                        │
                        ┌───────────────────────────────┼──────────────────┐
                        ▼                               ▼                  ▼
                 engine/calc                     renderer                site/DOM
              (rates, throughput,          buildGrid + fluid/heat      Panels, Tooltip,
               effects, scale)             ──▶ SpatialIndex            Palette, Library
                        │                  ──▶ collect ──▶ paint              │
                        └──────────── CalculationResult ──────────────────────┘
```

**Zustandshaltung:** Es gibt keinen Store und kein Observable-Pattern. Der
gesamte Anwendungszustand liegt als lokale Variablen in zwei
Closure-Mount-Funktionen (`mountBlueprintViewer`, `mountRenderer`). Das
funktioniert, ist aber der Grund, warum diese beiden Funktionen 1.666 bzw. 889
Zeilen lang sind und praktisch nicht testbar sind (siehe `04-code-quality.md`,
F-11).

**Persistenz:** ausschließlich `localStorage` — Autosave des aktuellen
Blueprints, Bibliothek gespeicherter Blueprints, zuletzt genutzte Entities im
Debug-Tool. Kein Backend, keine Datenbank, keine Netzwerk-API. Die im Auftrag
genannten Punkte "Backend", "Datenbank", "N+1-Abfragen" existieren in diesem
Projekt schlicht nicht.

## Modulgrenzen — Bewertung

**Gut gelöst (nicht anfassen):**
- Die Trennung `collect` (erzeugt `DrawCommand[]`, berührt kein Canvas) von
  `paint` (zeichnet nur, klassifiziert nichts) ist ein sauberer Schnitt und
  genau das, was das Caching in `02-rendering.md` (F-01) erst möglich macht.
- `neighbours/*` kapselt je eine Domäne (Rohre, Wände, Bänder, Wärme,
  Fluid, Plattform) hinter einer schmalen `classify*`-Funktion. Alle sieben
  Module sind DOM-frei und damit direkt testbar.
- `data-pipeline` ist strikt Node-only und läuft offline. Kein
  Factorio-spezifisches Parsing leckt in den Client.

**Schwachstelle:**
- Die Grenze zwischen `site` und `renderer` ist an einer Stelle unscharf:
  `apps/site/.../index.ts` importiert `buildVisualLookup` direkt aus dem
  Renderer und baut sich ein eigenes `visualLookup` (Zeile 8), obwohl
  `mountRenderer` intern bereits eines hält. Zwei unabhängige Kopien derselben
  abgeleiteten Datenstruktur. Kein Fehler, aber eine vermeidbare Doppelung
  (siehe F-14).
