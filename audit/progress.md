# Audit Progress Log

Projekt: FactorioTools (`/Users/malte/Develpoment/FactorioTools`)
Branch: `main` (mit uncommitteten Änderungen, siehe Phase 0)
Start: 2026-09-08

---

## Phase 0 — Orientierung ✅ (abgeschlossen)

**Ermittelter Stack**
- Vanilla TypeScript, **kein UI-Framework** (kein React/Vue/Svelte). DOM per
  `innerHTML`/`createElement`, Rendering per **Canvas 2D**.
- Build: Vite 6.4.3, TypeScript 5.7, npm workspaces (Monorepo).
- 4 Workspaces: `apps/site`, `packages/engine`, `packages/renderer`,
  `packages/data-pipeline`.
- Laufzeit-Deps insgesamt nur: `pako` (engine), `pngjs` (data-pipeline, nur Node).
  Der ausgelieferte Client hat **eine einzige** Runtime-Dependency (pako).

**Größe (gemessen)**
- 15.673 LOC First-Party (ts/css/html), 60 Quelldateien.
- Größte Dateien: `blueprint-viewer/index.ts` 1922, `style.css` 1457,
  `renderer/src/render.ts` 1064, `data-pipeline/render-catalog.ts` 899.

**Baselines (gemessen)**
- `npm run check` (tsc --noEmit, 4 Pakete): **3,4 s**, 0 Fehler.
- `npm test`: **1,07 s**, 29 Tests, alle grün — aber ausschließlich `engine`.
- `npx vite build`: **1,27 s**, 50 Module → 1 JS-Chunk 180,76 kB (61,43 kB gzip),
  CSS 23,96 kB (5,35 kB gzip).

**Assets (gemessen)**
- `apps/site/public/data/sprites`: **248 MB**, 590 PNGs, Ø 377 kB,
  größte Einzeldatei `rail-stone-path.png` 11,4 MB.
- `public/data/*.json`: example-blueprints 1,39 MB, render-catalog 325 kB,
  game-data 299 kB, sprite-source-manifest 40 kB, sprite-icon-manifest 23 kB.

**Doku**
- **Keine README, kein CLAUDE.md, keine ADRs, keine Doku-Dateien** im Repo.
  Einzige Doku sind Inline-Kommentare (die allerdings überdurchschnittlich gut
  sind, siehe 04-code-quality).

**Notiert für spätere Phasen**
- 4 `tsconfig.tsbuildinfo` sind untracked und nicht in `.gitignore` → Phase 4.
- `blueprint_book.txt` (1,3 MB) liegt getrackt im Repo-Root → Phase 4/5.
- Kein Linter (ESLint/Biome/oxlint), kein Formatter, keine CI-Konfiguration.
- Kein Test-Runner-Framework; Tests sind handgeschriebene tsx-Skripte.

## Phase 1 — Architektur ✅ (abgeschlossen)

Eigenes Analyse-Skript `audit/scripts/depgraph.mjs` (Tarjan-SCC + Layer-Check)
über 53 Module / 143 Kanten:
- **0 Zyklen**, **0 Layer-Verletzungen**. Schichtung engine → renderer/data-pipeline
  → site wird strikt eingehalten. Das ist sauber und sollte nicht angefasst werden.
- Höchster Fan-out: `renderer/src/render.ts` (15), `blueprint-viewer/index.ts` (12).
- `engine/src/index.ts` hat Fan-in 33 (Barrel-Export, exportiert u. a. auch
  Debug-Daten wie `data/rotation-test.js` in den Produktions-Bundle → Phase 3).

## Phase 2 — Rendering ✅ (Hauptteil, abgeschlossen)

**Gemessen** mit eigenen Skripten gegen echte Blueprint-Daten (176 Beispiele,
größte: 6.478 Entities):
- `audit/scripts/bench-collect.ts` — Per-Frame-JS-Kosten
- `audit/scripts/bench-animated-share.ts` — animierter Szenenanteil
- `audit/scripts/bench-anim-delta.ts` — was sich pro Frame wirklich ändert
- `audit/scripts/bench-cache-model.ts` — erreichbarer Gewinn durch Caching

Kernbefund (**gemessen**, nicht geschätzt):
- `tick()` ruft `draw()` **bedingungslos** jeden Frame (render.ts:511-526),
  ohne Dirty-Flag. Auch bei völlig statischer Ansicht.
- Per-Frame-JS beim 6.478-Entity-Blueprint: **13,65 ms** von 16,7 ms Budget
  (82 %), davon `collectEntity` **11,83 ms**.
- Über 8 gesampelte Frames ändert sich **ausschließlich das Feld `sx`**.
  Command-Anzahl, -Reihenfolge, Geometrie, Layer, Sheet: identisch.
- Modelliertes Caching (einmal sammeln+sortieren, pro Frame nur `sx` patchen):
  **12,5–14,2 ms Ersparnis/Frame, ~1300–2200x** auf dem Collect-Pfad.

## Phase 2 (Fortsetzung) — weitere Render-Befunde

- `positionTooltip` (blueprint-viewer/index.ts:466-475): schreibt DOM
  (replaceChildren/appendChild/hidden=false) und liest direkt danach
  `getBoundingClientRect()` → **erzwungener Reflow bei jeder Hover-Bewegung**.
- **Widerlegte Vermutung:** `groupForEntity` (index.ts:463, linear find+includes)
  gemessen mit `bench-hover-lookup.ts`: nur 0,10–0,19 µs pro Hover (5–37 Gruppen).
  **Kein Finding** — wird bewusst NICHT im Report als Problem geführt.
- `spriteAtlas.ts` ist überdurchschnittlich gut gebaut (Decode-Concurrency-Limit,
  async decode, Outline-Fallback, geteilte Instanz über Remounts). Nicht anfassen.
- `destroy()` (render.ts:977-992) räumt vollständig auf — alle Listener, rAF,
  ResizeObserver. Kein Leak auf diesem Pfad.

## Phase 5 vorgezogen (Teilbefund) — XSS

Mit `audit/scripts/xss-probe.ts` **praktisch nachgewiesen** (nicht vermutet):
Ein präpariertes Blueprint-String bringt rohes HTML über decode → calculate in
`warning.entityName` und `moduleLabel`, die in `panels.ts:526` bzw.
`panels.ts:133/451/487` **ungeescaped per innerHTML** gerendert werden.
Blueprint-Strings werden routinemäßig aus fremden Quellen (Reddit, Foren)
einkopiert → realer Stored-XSS-Vektor.

### XSS — vollständige Kette verifiziert
`xss-probe.ts` belegt zusätzlich: ein **Blueprint-Book-Label** trägt rohes HTML
durch `collectBlueprints` in `saveToLibrary` → localStorage → beim nächsten
Laden über `library-sidebar.ts:279` (`makeCategory` → innerHTML). Damit ist es
**persistentes** XSS (überlebt Reload), nicht nur reflektiertes.
Insgesamt 8 blueprint-speisbare innerHTML-Senken (Skript: `scan-innerhtml`-
Analyse, exakte Variante inline in Phase 5 dokumentiert).

## Phase 3 — Performance außerhalb Rendering (läuft)
**Gemessen (Phase 3):**
- Bundle: 1 einziger Chunk, 180,8 kB (61,4 kB gzip), **0 dynamische Imports**.
  Sourcemap-Attribution (`bundle-attribution.mjs`):
  pako **28,5 %** (48 kB), blueprint-viewer/index.ts 12,3 %, panels.ts 6,8 %,
  render.ts 6,4 %. Dev-only (layer-debug + debug-lab + rotation-test):
  14.657 B = **8,7 %**. *(Korrektur meiner ersten Zählung: `entityPreview` ist
  Produktivcode — via edit-properties.ts:2 — und zählt nicht als Dev-Code.)*
- Startup-Wasserfall (`bench-startup-fetch.mjs`, 40 ms RTT / 20 Mbit/s):
  game-data.json wird **vollständig awaited**, erst danach render-catalog.json
  (data/index.ts:41 → :47). Sequenziell 355 ms vs. parallel 178 ms →
  **177 ms (50 %) Ersparnis**, obwohl keine Abhängigkeit besteht.
- JSON-Assets komprimieren 90–93 % (gzip) — Hosting-Kompression ist Pflicht.
- Sprite-Payload pro Blueprint (`bench-sprite-payload.ts`, 176 echte Blueprints):
  **Median 13,2 MB, p90 42,1 MB, max 63,9 MB**.
- **Widerlegte Hypothese:** Viewport-basiertes Lazy-Loading bringt **0 %** —
  bei echten Blueprints sind nach dem Initial-Framing praktisch alle Entities
  im Bild. Wird NICHT empfohlen.
- **Widerlegte Hypothese:** PNG-Reoptimierung bringt nichts — `sips`-Reencoding
  macht die Dateien *größer* (42 MB → 50 MB im Sample). Quell-PNGs sind bereits
  gut komprimiert. Generischer Rat "nutze einen Image-Optimizer" wäre falsch.
- **Der eigentliche Befund** (`analyze-frame-waste.ts`): **153 MB von 176 MB
  (87 %)** der ausgelieferten Sprite-Bytes sind Frames, die der Renderer
  **nie adressieren kann** (Achsen `col=none,row=none`). `rail-stone-path.png`
  liefert 512 Frames aus, um **1** zu zeichnen. Ursache: `extract-sprites.ts:66`
  kopiert Entity-Sheets per `copyFileSync` unverändert — obwohl dieselbe Datei
  für Icons/Item-Groups bereits `PNG.bitblt`-Cropping macht (:167, :211).

## Phase 4 — Codequalität & Tests (läuft)
**Gemessen/geprüft (Phase 4):**
- **Positiv:** 0 TODO/FIXME/HACK, 0 `@ts-ignore`/`@ts-expect-error`,
  0 `as unknown as`. `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`
  aktiv, `tsc --noEmit` läuft fehlerfrei durch.
- **Positiv:** alle 64 `any` liegen **ausschließlich** in `data-pipeline`
  (Parsen des untypisierten Factorio-Lua-Dumps) — vertretbar. Der
  ausgelieferte Client-Code ist `any`-frei bis auf `window.__debug`.
- **Tests:** engine 721 Test-LOC / 2117 Src-LOC (ordentlich, 29 Tests grün).
  renderer (3560), data-pipeline (3335), site (4460) = **11.355 LOC ohne
  jeden Test**. 1.684 LOC davon (neighbours/, spatialIndex, camera,
  entityLookup, collect, commands) sind **komplett DOM-frei** und mit dem
  bestehenden tsx-Runner sofort testbar — kein jsdom nötig.
- **Komplexität:** zwei Ausreißer — `mountBlueprintViewer`
  (index.ts:258, **1.666 Zeilen, 283 Branches, 182 Deklarationen,
  51 verschachtelte Funktionen**) und `mountRenderer` (render.ts:125,
  889 Zeilen, 170 Branches).
- **Speicher (gemessen, `bench-undo-memory.ts`):** `undoStack` (index.ts:586)
  ist **unbegrenzt**; jeder Edit legt via `snapshotEntities` (:590) eine
  Deep-Copy aller Entities ab. 200 Edits auf dem größten Blueprint =
  **224 MB** dauerhaft gehalten (1.145 KB pro Edit). Snapshot-Zeit selbst
  (0,29 ms) ist unkritisch.
- 2 vergessene `console.log` in layer-debug/index.ts:503,505 (Dev-Tool).

## Phase 5 — Sicherheit & Abhängigkeiten (läuft)
**Gemessen/geprüft (Phase 5):**
- `npm audit`: **0 Schwachstellen** (info/low/moderate/high/critical alle 0).
- Nur **20 Pakete** im gesamten node_modules-Baum. Client-Runtime: **nur pako**.
- Lizenzen: pako (MIT AND Zlib), pngjs/vite/tsx (MIT), typescript (Apache-2.0).
  Alle permissiv, keine Copyleft-Konflikte.
- Veraltet (Major-Sprünge, nicht dringend): pako 2.2.0→3.0.1,
  vite 6.4.3→8.2.2, typescript 5.9.3→7.0.2, @types/node 22→26.
- **Keine Secrets**, keine .env/.pem/.key getrackt.
- **Kein CSP-Header/Meta-Tag** — verschärft das bestätigte XSS.
- `blueprint_book.txt` (1,3 MB im Root) ist **kein Altlast-Fund**: wird von
  scripts/build-example-blueprints.mjs und pick-random-blueprint.mjs als
  Build-Input gelesen. Kein Finding.

## Phase 6 — Synthese (läuft)
## Phase 6 — Synthese ✅
Alle acht Deliverables geschrieben (00–07). `06-findings.csv` validiert:
19 Zeilen, alle Spalten befüllt, keine unvollständigen Datensätze.
Schweregrade 5/4/3/2/1 = 3/3/6/5/2; Aufwand S/M/L = 14/3/2.

## Phase 7 — Zweiter Durchgang ✅ (abgeschlossen)

Die drei größten Findings wurden mit **jeweils anderer Methode** gegengeprüft
als im ersten Durchgang. Ergebnis: alle drei tragen, zwei wurden **präzisiert**.

### F-01 (Render-Caching) — bestätigt, Empfehlung PRÄZISIERT
`verify-f01.ts`, 128 statt 8 Frames, zwei Blueprints:
- Struktur über volle Umlaufperiode stabil ✓, 100 % gleichmäßiger sx-Schritt ✓
- **REVIDIERT:** Beim größten Blueprint ist die Zykluslänge einheitlich 64.
  Bei gemischten Bandstufen (Heavy Promethium Cruiser) treten aber **drei
  Perioden auf: 64 / 32 / 16**. Ein Patch mit *einer* gemeinsamen Periode
  hätte langsamere Bandstufen desynchronisiert — ein subtiler visueller
  Fehler, der bei Prüfung nur am größten Blueprint **nicht aufgefallen wäre**.
  → `02-rendering.md` ergänzt: `animColumns` ist pro Command **zwingend**,
  Ursache ist der `slowdown`-Faktor (collect.ts:223).

### F-06 (87 % Sprite-Verschwendung) — bestätigt, Umsetzungsweg KORRIGIERT
`verify-f06.ts` prüft **empirisch** statt modelliert: `collectEntity` wird real
über 16 Richtungen × 11 Nachbarschaften × 15 Animationsframes je Entity
aufgerufen und die tatsächlich vorkommenden Zellen protokolliert.
- Ergebnis **89 %** (156 MB) vs. 87 % aus der statischen Analyse → trägt.
- **REVIDIERT:** Für `rail-stone-path.png` findet die empirische Methode
  **4 von 210** genutzten Zellen, die statische nur 1 von 512. Ein Cropping auf
  Basis der Achsen-Modellierung hätte **drei real benutzte Frames
  weggeschnitten**. → `02-rendering.md` ergänzt: Die Umsetzung muss auf der
  empirischen Zellerfassung aufsetzen, nicht auf `column.by`/`row.by`.

### F-16 (XSS) — bestätigt, keine Revision nötig
`verify-f16.mjs` bildet die exakten Templates nach und prüft mit einem
Tag-Scanner, ob ein **aktives** Element entsteht (nicht nur, ob der String
ankommt): **4 von 4 Fundstellen erzeugen `<img onerror>`.**
Gegenprobe: Der empfohlene `escapeHtml`/`html`-Helfer reduziert die aktiven
Elemente auf **0** — der vorgeschlagene Fix wirkt nachweislich.

### Im Verlauf des Audits verworfene eigene Hypothesen
Bewusst dokumentiert, um keine Scheinbefunde im Report zu haben:
1. `groupForEntity` (linear find+includes) — gemessen 0,10–0,19 µs → **kein Finding**.
2. Viewport-basiertes Sprite-Lazy-Loading — gemessen **0 %** Ersparnis → verworfen.
3. PNG-Reoptimierung — Re-Encoding macht Dateien **19 % größer** → verworfen.
4. `entityPreview.ts` als Dev-Code gezählt — ist **Produktivcode**
   (edit-properties.ts:2) → Bundle-Zahl von 9,3 % auf 8,7 % korrigiert.
5. "Zieh-Vorgang ruft applyEdit pro Frame" — falsch, es gibt eine korrekte
   Entprellung pro Zelle (render.ts:569/551) → Formulierung in 03 präzisiert.

**Audit abgeschlossen.** Kein Produktivcode verändert; alle Schreibvorgänge
ausschließlich nach `./audit/`.
