# 02 — Rendering (Schwerpunkt)

## Vorbemerkung zur Methodik

Dieses Projekt hat **kein UI-Framework**. Die im Auftrag genannten Punkte
"unnötige Re-Renders durch instabile Props", "fehlende Memoisierung",
"Context-Provider die zu viel neu rendern", "Listen-Virtualisierung" und
"Hydration" haben hier **kein Gegenstück** — es gibt keine Komponenten, keine
Props, keinen Context, kein SSR. Ich schreibe das explizit hin, statt diese
Abschnitte mit erfundenen Äquivalenten zu füllen.

Was es stattdessen gibt: eine `requestAnimationFrame`-Schleife über einen
Canvas 2D. Die Analyse folgt dieser Realität.

Alle Zahlen unten sind **gemessen**, nicht geschätzt. Die Skripte liegen in
`audit/scripts/` und sind reproduzierbar:

```bash
npx tsx audit/scripts/bench-collect.ts
npx tsx audit/scripts/bench-animated-share.ts
npx tsx audit/scripts/bench-anim-delta.ts
npx tsx audit/scripts/bench-cache-model.ts
npx tsx audit/scripts/bench-sprite-payload.ts
npx tsx audit/scripts/analyze-frame-waste.ts
```

Datengrundlage: die 176 echten Blueprints aus
`apps/site/public/data/example-blueprints.json` (4–6.478 Entities, Median 160).
Gemessen auf dem Entwicklungsrechner (darwin, Node 22). Die Canvas-`drawImage`-
Kosten selbst sind **nicht** enthalten — gemessen wurde ausschließlich die
JS-Arbeit, die auf dem Main-Thread vor dem ersten Pixel anfällt. Auf schwächerer
Hardware sind die Absolutwerte höher, die Verhältnisse bleiben.

---

## Der Render-Pfad end-to-end

```
requestAnimationFrame(tick)                      render.ts:806, :525
  └─ tick()                                      render.ts:511
       ├─ frameTimes.push(...)                   Debug-Statistik
       ├─ animationFrame++                       :519
       ├─ applyKeyboardPan(16)                   :520   ← WASD
       └─ draw()                                 :522   ← IMMER, bedingungslos
            ├─ fillRect(ganzer Canvas)           :266
            ├─ drawGrid → CanvasPattern          :275
            ├─ spatialIndex.queryRect(Viewport)  :282   ← alloziert Set + String-Keys
            ├─ [Ghost-Zweig, nur in 'place']     :317-395
            │     └─ buildGrid/buildFluidNetwork/buildHeatNetwork
            │        über ALLE Entities + Ghost  :342-355  ← 3 volle Neuaufbauten
            ├─ for (visible) collectEntity(...)  :406-417  ← Hotspot
            ├─ paint(ctx, atlas, commands)       :419
            │     ├─ 2× commands.filter(...)     paint.ts:30-31 ← 2 neue Arrays
            │     ├─ commands.sort(comparator)   paint.ts:37
            │     └─ for (c) ctx.drawImage(...)  paint.ts:53
            ├─ for (procedural) drawInserter     :421-425
            ├─ [Highlight-Pass]                  :428-442
            ├─ [Alt-Mode-Pass]                   :448-453
            └─ [Ghost-Zeichnung]                 :455-475
```

### Was löst ein Redraw aus?

**Alles und nichts** — `draw()` läuft in jedem Frame, unabhängig davon, ob sich
irgendetwas geändert hat. Es gibt **kein Dirty-Flag**, kein `needsRedraw`, keine
Invalidierung. Verifiziert: `grep -n "needsRedraw\|dirty" packages/renderer/src/render.ts`
liefert keinen Treffer; `tick()` (render.ts:511-526) ruft `draw()` unbedingt und
plant sich sofort neu.

Das heißt: Ein Nutzer, der einen Blueprint geöffnet hat und **die Hände von
Maus und Tastatur nimmt**, verbrennt weiterhin 60 volle Szenen-Neuaufbauten pro
Sekunde.

---

## F-01 — Vollständiger Szenen-Neuaufbau in jedem Frame (Schweregrad 5)

**Fundstelle:** `packages/renderer/src/render.ts:511-526` (`tick`), `:259-478` (`draw`)

### Gemessen

`audit/scripts/bench-collect.ts`, Per-Frame-JS ohne Canvas-Zeichnen:

| Blueprint | Entities | DrawCommands | queryRect | **collectEntity** | filter | sort | **Summe** | Anteil an 16,7 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Legendary Bioflux | 6.478 | 8.915 | 0,35 | **11,83** | 0,14 | 1,33 | **13,65 ms** | **82 %** |
| Legendary Blue Science | 2.736 | 3.860 | 0,11 | 6,08 | 0,07 | 0,63 | 6,89 ms | 41 % |
| Green Circuit Upcycler | 2.283 | 4.251 | 0,11 | 4,61 | 0,07 | 0,64 | 5,44 ms | 33 % |
| Biter Egg Rocket | 173 | 225 | 0,01 | 0,25 | 0,00 | 0,02 | 0,28 ms | 2 % |

Beim größten Blueprint sind **82 % des 60-fps-Budgets aufgebraucht, bevor ein
einziges Pixel gezeichnet wurde**. `collectEntity` allein trägt 87 % dieser Last.

### Warum das ein Problem ist

Der Neuaufbau ist nicht nur teuer, er ist **überflüssig**. Beweis
(`bench-anim-delta.ts`, größter Blueprint, 8 gesampelte Frames 0/1/2/3/7/15/31/63):

```
command COUNT identical across frames:           true
command ORDER/geometry identical across frames:  true
fields that ever differ:                         sx
=> ONLY source-rect (sx/sy) changes:             true
```

Über alle 8.915 Commands und alle gesampelten Frames ändert sich **ausschließlich
das Feld `sx`** — der horizontale Offset in die Spritesheet-Zeile, also der
Animationsframe der Fließbänder. `sheet`, `sy`, `sw`, `sh`, `dx`, `dy`, `dw`,
`dh`, `layer`, `y`, `order`, `alpha` sind über alle Frames **bitidentisch**.

Die 11,83 ms `collectEntity` und die 1,33 ms `sort` berechnen also 60×
pro Sekunde ein Ergebnis, das sich strukturell **nie** ändert, solange der
Nutzer nichts editiert und die Kamera stillsteht.

### Modellierte Wirkung

`bench-cache-model.ts` — einmal sammeln + sortieren, danach pro Frame nur die
animierten `sx`-Felder patchen:

| Blueprint | heute | mit Cache | Faktor | Ersparnis/Frame |
|---|---:|---:|---:|---:|
| Legendary Bioflux (6.478) | 12,56 ms | 0,010 ms | **1288×** | 12,55 ms |
| Heavy Promethium Cruiser (4.067) | 14,18 ms | 0,008 ms | **1883×** | 14,17 ms |
| Legendary Blue Science (2.736) | 6,26 ms | 0,003 ms | **2219×** | 6,26 ms |

### Lösungsvorschlag

Zwei Stufen, die getrennt umsetzbar sind. Stufe 1 allein bringt schon fast
alles und ist deutlich risikoärmer.

**Stufe 1 — Dirty-Flag (klein, ~1 h).** Nur neu zeichnen, wenn sich etwas
geändert hat. Da Fließbänder animiert sind, ist "nichts geändert" nur wahr,
wenn die sichtbare Szene keine animierten Entities enthält — was bei vielen
Blueprints (z. B. reinen Schmelz-/Rechen-Blöcken ohne Turbo-Bänder) zutrifft.

```ts
// render.ts — neben den übrigen Zustandsvariablen (~:167-180)
let needsRedraw = true;
/** Anzahl der sichtbaren Entities, deren Sprite sich pro Frame ändert.
 *  Wird in draw() beim Sammeln mitgezählt; 0 heißt: die Szene ist statisch
 *  und der nächste Frame darf komplett übersprungen werden. */
let animatedVisibleCount = 0;

function invalidate(): void { needsRedraw = true; }

function tick(): void {
  if (destroyed) return;
  const now = performance.now();
  if (lastTickAt !== 0) { /* ... unverändert ... */ }
  lastTickAt = now;

  const panned = applyKeyboardPan(16);      // gibt jetzt true zurück, wenn bewegt
  if (panned) needsRedraw = true;
  if (!animationFrozen && animatedVisibleCount > 0) {
    animationFrame = (animationFrame + 1) % 1_000_000;
    needsRedraw = true;
  }

  if (needsRedraw) {
    const drawStart = performance.now();
    draw();
    renderTimes.push(performance.now() - drawStart);
    if (renderTimes.length > FRAME_HISTORY) renderTimes.shift();
    needsRedraw = false;
  }
  rafHandle = requestAnimationFrame(tick);
}
```

`invalidate()` muss dann an jeder zustandsändernden Stelle gerufen werden:
`camera.zoomAt`/`panByScreenDelta` (onWheel, onPointerMove, Pinch),
`rebuildIndices`, `setHighlight`, `setAltMode`, `setInteractionMode`,
`rotateGhost`, Ghost-Positionswechsel, `resize`, und im
`atlas.whenIdle().then(...)`-Callback. Sauberer wäre, die Kamera selbst einen
`onChange`-Callback feuern zu lassen, statt 12 Aufrufstellen zu pflegen.

**Stufe 2 — Command-Cache (mittel, ~1 Tag).** Das Sammel- und Sortierergebnis
zwischenspeichern und pro Frame nur die animierten Einträge patchen. Der
vorhandene saubere Schnitt zwischen `collect` (erzeugt Commands) und `paint`
(zeichnet nur) macht das möglich, ohne die Klassifikationslogik anzufassen.

```ts
// Cache-Schlüssel: alles, was die Command-Liste strukturell bestimmt.
// animationFrame gehört bewusst NICHT dazu — der wird gepatcht, nicht neu gesammelt.
interface CommandCache {
  commands: DrawCommand[];        // bereits sortiert
  animated: number[];             // Indizes der Commands mit Animationsachse
  animBase: number[];             // deren sx bei animationFrame === 0
  animStride: number[];           // sx-Zuwachs pro Frame
  animColumns: number[];          // Spaltenzahl des jeweiligen Sheets (für Modulo)
  key: string;                    // entitiesVersion|viewportBucket|altMode|highlightVersion
}

function drawCached(): void {
  const key = cacheKey();
  if (!cache || cache.key !== key) cache = rebuildCommandCache(key);   // teuer, selten
  for (let i = 0; i < cache.animated.length; i++) {                    // billig, pro Frame
    const c = cache.commands[cache.animated[i]!]!;
    const frame = animationFrame % cache.animColumns[i]!;
    c.sx = cache.animBase[i]! + frame * cache.animStride[i]!;
  }
  paintPlain(ctx, atlas, cache.commands);   // bereits sortiert -> sort() entfällt
}
```

**Verifiziert in Phase 7 (`audit/scripts/verify-f01.ts`, 128 Frames statt 8):**

```
Legendary Bioflux    (6.478 Ent): Struktur stabil ✓ | 4.548 animierte Commands,
                                  100 % gleichmäßiger sx-Schritt, Periode 64 einheitlich
Heavy Promethium     (4.067 Ent): Struktur stabil ✓ | 3.119 animierte Commands,
                                  100 % gleichmäßiger Schritt, aber Perioden 64 / 32 / 16
```

Der zweite Fall ist der wichtige: Ein Blueprint mit **gemischten Bandstufen**
(turbo / express / fast / underground) hat **drei verschiedene Zykluslängen**.
Ein Patch mit *einer* gemeinsamen Periode würde die langsameren Bandstufen
desynchronisieren — ein subtiler visueller Fehler, der bei einer Prüfung nur am
größten Blueprint (dort ist die Periode einheitlich 64) **nicht auffallen
würde**.

Deshalb ist das Feld `animColumns` im Cache-Entwurf oben **nicht optional**:
Jeder animierte Command braucht seine **eigene** Periode, `animationFrame`
muss pro Command modulo dieser Periode gerechnet werden. Der `slowdown`-Faktor
aus `collect.ts:223` ist genau der Grund für die unterschiedlichen Perioden.

Wichtig: `paint()` darf die Liste dann **nicht mehr sortieren** (`paint.ts:37`
sortiert in-place) und **nicht mehr filtern** (`paint.ts:30-31` alloziert zwei
neue Arrays pro Frame). Der Ghost ist ohnehin schon ein separater `paint`-Aufruf
(render.ts:468) — die Tint-Trennung kann also aus dem Hauptpfad ganz heraus und
nur für den Ghost-Pfad erhalten bleiben.

**Aufwand/Nutzen:** Stufe 1 ist S (~1 h) und beseitigt die Leerlaufsituation
vollständig. Stufe 2 ist M (~1 Tag) und senkt zusätzlich die Kosten während
Pan/Zoom. Zusammen der mit Abstand größte Performance-Hebel im Projekt.

---

## F-02 — Ghost-Modus baut drei volle Nachbarschaftsnetze pro Frame neu (Schweregrad 4)

**Fundstelle:** `packages/renderer/src/render.ts:342`, `:348`, `:355`

Solange eine Entity "in der Hand" ist (Platzierungsmodus), passiert **in jedem
Frame**:

```ts
if (connectors.isBeltLike(mode.entityName)) previewGrid = buildGrid([...entities, ghost]);
previewFluidNetwork = buildFluidNetwork([...entities, ghost], ...);
previewHeatNetwork  = buildHeatNetwork([...entities, ghost], ...);
```

Jede dieser Zeilen kopiert zuerst das **komplette** Entity-Array
(`[...entities, ghost]`) und baut danach das Netz **von Grund auf** neu — für
einen einzigen hinzugefügten Ghost.

### Gemessen (`bench-collect.ts`, Spalten "per edit")

| Blueprint | buildGrid | buildFluidNetwork | buildHeatNetwork | Summe pro Frame |
|---|---:|---:|---:|---:|
| Legendary Bioflux (6.478) | 1,57 | 0,47 | 0,15 | **2,19 ms** |
| Legendary Blue Science (2.736) | 0,41 | 0,29 | 0,10 | 0,80 ms |

Beim größten Blueprint kommen also **2,19 ms pro Frame zusätzlich** zu den
13,65 ms aus F-01 — und zwar genau dann, wenn der Nutzer aktiv baut und
flüssiges Feedback am wichtigsten ist. Zusammen ~15,8 ms, das Budget ist
überschritten.

**Warum es unnötig ist:** Der Ghost belegt eine Handvoll Kacheln. Alle anderen
Zellen sind identisch mit dem bereits vorhandenen `grid`/`fluidNetwork`/
`heatNetwork`.

**Lösungsvorschlag:** Ein Overlay statt eines Neuaufbaus. `NeighbourGrid`
(`neighbours/grid.ts:62`) ist schon eine schmale Klasse mit nur `at`/`towards`/
`set` — ein Delta-Wrapper ist wenige Zeilen:

```ts
// neighbours/grid.ts
/** Legt einzelne Zellen über ein bestehendes Grid, ohne es zu kopieren.
 *  Für den Platzierungs-Ghost: nur dessen eigene Zellen weichen ab. */
export class OverlayGrid extends NeighbourGrid {
  constructor(private base: NeighbourGrid) { super(); }
  override at(x: number, y: number): Neighbour | undefined {
    return super.at(x, y) ?? this.base.at(x, y);
  }
}

// render.ts:342 wird damit zu:
if (connectors.isBeltLike(mode.entityName)) {
  const o = new OverlayGrid(grid);
  for (const cell of cellsOf(ghost)) o.set(cell.x, cell.y, { name: ghost.name, direction: ghost.direction, undergroundType: ghost.undergroundType });
  previewGrid = o;
}
```

Kosten sinken damit von O(Entities) auf O(Ghost-Zellen), also praktisch auf
null. Für `fluidNetwork`/`heatNetwork` ist derselbe Ansatz möglich, aber
aufwendiger, weil dort Konnektivität über Nachbarn aufgelöst wird — dort genügt
als erster Schritt, den Neuaufbau nur dann auszuführen, wenn sich
`ghostWorldPos` seit dem letzten Frame **tatsächlich geändert** hat (der Ghost
steht bei ruhender Maus still, das trifft die überwiegende Mehrheit der Frames):

```ts
if (ghostSnapX !== lastGhostSnapX || ghostSnapY !== lastGhostSnapY || ghostDirection !== lastGhostDir) {
  previewFluidNetwork = buildFluidNetwork([...entities, ghost], ...);
  previewHeatNetwork  = buildHeatNetwork([...entities, ghost], ...);
  lastGhostSnapX = ghostSnapX; /* ... */
}
```

**Aufwand:** S für die Änderungserkennung, M für das Overlay. **Nutzen:** hoch,
weil es exakt den interaktivsten Pfad trifft.

---

## F-03 — `paint()` alloziert und sortiert in jedem Frame neu (Schweregrad 3)

**Fundstelle:** `packages/renderer/src/draw/paint.ts:30-31`, `:37`

```ts
const untinted = commands.filter((c) => !c.tint || c.layer === Layer.Shadow);
const tinted   = commands.filter((c) => c.tint && c.layer !== Layer.Shadow);
```

Zwei vollständige Array-Allokationen pro Frame. Beim größten Blueprint sind das
2× 8.915 Elemente — und im Normalfall (kein Ghost) ist `tinted` **immer leer**,
`untinted` **immer** eine exakte Kopie der Eingabe.

Dazu `paint.ts:37`: `commands.sort(compareDrawCommands)` — 1,33 ms gemessen bei
8.915 Commands, ebenfalls in jedem Frame, obwohl die Reihenfolge (siehe F-01)
über alle Frames identisch bleibt.

**Lösungsvorschlag (unabhängig von F-01 umsetzbar, ~15 min):** Die Filterung
ganz vermeiden. Der einzige Erzeuger getönter Commands ist der Ghost, und der
wird in `render.ts:465-468` bereits als **eigene** Command-Liste gesammelt und
mit einem separaten `paint()`-Aufruf gezeichnet. Der Hauptpfad kann also direkt
`paintPlain` aufrufen:

```ts
// paint.ts — paintPlain ist heute modul-privat (paint.ts:41) und muss
// dafür exportiert werden:
export function paintPlain(...) { /* unverändert */ }

// render.ts:419
paintPlain(ctx, atlas, commands);          // statt paint(...)
// render.ts:468 (Ghost) bleibt bei paint(...) — dort wird die
// Tint-Trennung tatsächlich gebraucht.
```

Damit entfallen zwei Array-Allokationen pro Frame ersatzlos. Der Sort
verschwindet mit F-01 Stufe 2.

**Gemessen:** filter 0,14 ms + sort 1,33 ms = **1,47 ms/Frame** beim größten
Blueprint. Klein gegenüber F-01, aber der Filter-Anteil ist mit einer
Einzeiler-Änderung zu haben.

---

## F-04 — Erzwungener Reflow bei jeder Hover-Bewegung (Layout Thrashing) (Schweregrad 3)

**Fundstelle:** `apps/site/src/tools/blueprint-viewer/index.ts:466-475` und `:490-497`

Klassisches Read-after-Write:

```ts
// :490-496  — SCHREIBEN am Layout
tooltip.replaceChildren();
const card = buildRecipeCard(group, getData(), options);   // baut kompletten Teilbaum
tooltip.appendChild(window_);
tooltip.hidden = false;
positionTooltip(event);
  // :468 — LESEN, erzwingt synchrones Reflow des gerade geänderten Baums
  const rect = tooltip.getBoundingClientRect();
  // :473-474 — SCHREIBEN
  tooltip.style.left = `${...}px`;
  tooltip.style.top  = `${...}px`;
```

Der Browser muss bei `getBoundingClientRect()` das Layout synchron neu
berechnen, weil unmittelbar davor der DOM-Teilbaum ersetzt wurde. Das passiert
bei **jeder** Mausbewegung über eine Entity mit Rezept — parallel zu den
13,65 ms aus F-01 im selben Frame.

**Lösungsvorschlag:** Die Tooltip-Größe ändert sich nur, wenn sich der *Inhalt*
ändert, nicht wenn die Maus sich bewegt. Also Karte nur bei Gruppenwechsel neu
bauen und die gemessene Größe cachen:

```ts
let tooltipGroupKey: string | null = null;
let tooltipSize = { w: 0, h: 0 };

function onSchematicHover(entityNumber: number | undefined, event: PointerEvent) {
  /* ... */
  const key = `${group.machineName}|${group.recipeLabel}|${group.count}|${group.quality}`;
  if (key !== tooltipGroupKey) {
    tooltipGroupKey = key;
    tooltip.replaceChildren(/* ... neue Karte ... */);
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();   // nur bei Inhaltswechsel
    tooltipSize = { w: r.width, h: r.height };
  }
  positionTooltip(event, tooltipSize);           // reine Rechnung, kein Layout-Read
}
```

Zusätzlich empfehlenswert: Positionierung über
`transform: translate(x, y)` statt `left`/`top`. `transform` wird vom Compositor
verarbeitet und löst weder Layout noch Paint aus, `left`/`top` schon.

**Aufwand:** S. **Nutzen:** spürbar flüssigeres Hovern, besonders auf großen
Blueprints.

---

## F-05 — String-Keys als Map-Schlüssel im Nachbarschafts-Hot-Path (Schweregrad 2)

**Fundstelle:** `packages/renderer/src/neighbours/grid.ts:63-76`, `packages/renderer/src/spatialIndex.ts:30`, `:44`, `:68`

```ts
private cells = new Map<string, Neighbour>();
at(x, y)  { return this.cells.get(`${x},${y}`); }
set(x, y, n) { this.cells.set(`${x},${y}`, n); }
```

Jeder Zugriff erzeugt einen temporären String. `classifyBeltCell`,
`classifyPipe`, `classifyWall` und `classifyPlatform` rufen `at`/`towards`
mehrfach pro Entity und Frame — bei 6.478 Entities summiert sich das zu
Zehntausenden kurzlebigen Strings pro Frame, die der GC wieder einsammeln muss.

**Lösungsvorschlag:** Ganzzahliger Schlüssel statt String. Blueprint-Koordinaten
liegen weit innerhalb von ±2^20:

```ts
// grid.ts
const KEY_BIAS = 1 << 20;
/** Kollisionsfreier Integer-Schlüssel für |x|,|y| < 2^20 — vermeidet die
 *  String-Allokation pro Zellzugriff im Klassifikations-Hot-Path. */
const cellKey = (x: number, y: number): number => (x + KEY_BIAS) * (1 << 21) + (y + KEY_BIAS);

private cells = new Map<number, Neighbour>();
at(x: number, y: number) { return this.cells.get(cellKey(x, y)); }
```

**Ehrliche Einordnung:** Das ist ein **Mikro-Optimierung**. Die 11,83 ms
`collectEntity` enthalten diesen Anteil, aber ich habe ihn **nicht isoliert
gemessen** und kann ihn deshalb nicht beziffern — es ist eine *hergeleitete*,
keine gemessene Verbesserung. Wenn F-01 umgesetzt ist, läuft dieser Code nur
noch bei Änderungen statt 60×/s, und der Punkt erledigt sich weitgehend von
selbst. **Deshalb: erst nach F-01 überhaupt in Betracht ziehen**, und nur, wenn
ein Profil ihn dann noch zeigt.

---

## Frame-Budget, Batching, Timer

**Gut gelöst:**
- Es gibt **genau eine** rAF-Schleife (`render.ts:806`). Keine konkurrierenden
  Loops, keine `setInterval`-Animation, kein `setTimeout`-Polling im Renderpfad
  (verifiziert: `grep -n "setInterval\|setTimeout" packages/renderer/src/render.ts`
  liefert keine Treffer im Zeichenpfad).
- Die WASD-Kamerabewegung läuft **innerhalb** der rAF-Schleife
  (`applyKeyboardPan`, `:520`), nicht über einen eigenen Timer. Richtig gemacht.
- Diagonale Bewegung wird normalisiert (`:493`) — Detailtreue zum Spiel.
- `destroy()` (`:977-992`) räumt vollständig auf: rAF abgebrochen, alle
  Listener entfernt, `ResizeObserver` disconnected, Atlas-Callback gelöst.
  **Kein Leak auf diesem Pfad.**

**Problematisch:** Der einzige echte Frame-Budget-Verstoß ist F-01/F-02.

---

## GPU / Compositing / Overdraw

Ein einzelnes `<canvas>`-Element, also **keine Layer-Explosion** und kein
Compositing-Problem im DOM-Sinn. Zwei Beobachtungen:

**Gut gelöst:** `drawGrid` (`render.ts:1004-1030`) benutzt ein einmalig
erzeugtes, gecachtes `CanvasPattern` statt eines `fillRect` pro Kachel. Der
Kommentar dokumentiert, dass bei minimalem Zoom sonst *zehntausende*
`fillRect`-Aufrufe pro Frame anfielen. Das ist genau die richtige Lösung.

**Overdraw:** Bei 8.915 Commands auf 6.478 Entities (1,4 Sprites pro Entity)
werden Schatten- und Hauptebenen übereinandergelegt. Der globale Sort
(`compareDrawCommands`: Layer → y → order) ist notwendig, damit kein Schatten
auf einem Nachbarn landet — das ist korrekt und darf nicht wegoptimiert werden.
Der `globalCompositeOperation`-Wechsel für Schatten (`paint.ts:44-47`) ist
bereits zustandsminimierend implementiert (nur bei echtem Wechsel), ebenso
`globalAlpha` (`:49-52`). **Sauber gelöst, nicht anfassen.**

---

## Assets, Ladereihenfolge, erstes Rendering

### F-06 — 87 % der ausgelieferten Sprite-Bytes sind nie adressierbar (Schweregrad 5)

**Fundstelle:** `packages/data-pipeline/src/extract-sprites.ts:66`

Gemessen mit `analyze-frame-waste.ts` über alle 482 vom Katalog referenzierten
Sheets: Für jedes Sheet wurde aus den PNG-Maßen (IHDR) und `frameWidth`/
`frameHeight` die Zellenzahl bestimmt und mit der Zahl der Zellen verglichen,
die die Achsen (`column.by`/`row.by`) überhaupt ansprechen können.

```
sheets analysed: 482, total 176 MB
never-addressable frame bytes: 153 MB (87 %)
```

Die 20 schlimmsten Fälle:

| Sheet | Größe | genutzte Zellen | verschwendet |
|---|---:|---|---:|
| `rail-stone-path.png` | 11,4 MB | **1 von 512** | 11,4 MB |
| `foundry-main-1.png` | 8,8 MB | 1 von 64 | 8,7 MB |
| `thruster-1.png` | 6,2 MB | 1 von 32 | 6,0 MB |
| `rail-stone-path-inside.png` | 5,8 MB | 1 von 512 | 5,8 MB |
| `biolab-anim.png` | 5,9 MB | 1 von 32 | 5,7 MB |
| `radar.png` | 4,4 MB | 4 von 64 | 4,2 MB |
| `recycler-W/E/N/S.png` | je ~3,7 MB | je 1 von 64 | 14,6 MB |
| `centrifuge-A/B/C.png` | je ~2,8 MB | je 1 von 64 | 8,3 MB |

**Ursache:** `extract-sprites.ts:66` kopiert Entity-Sheets unverändert:

```ts
copyFileSync(src, dest);
```

Interessant: **Dieselbe Datei kann bereits croppen.** Für Icons (`:167`) und
Item-Groups (`:211`) wird `PNG.bitblt` verwendet. Nur der Entity-Pfad nutzt es
nicht.

**Auswirkung (gemessen, `bench-sprite-payload.ts`):** Was ein Nutzer beim
Öffnen eines Blueprints tatsächlich lädt — **Median 13,2 MB, p90 42,1 MB,
Maximum 63,9 MB**. Auf einer mobilen Verbindung ist das der Unterschied
zwischen benutzbar und unbenutzbar.

**Lösungsvorschlag:** Im Extraktionsschritt nur die tatsächlich adressierbaren
Zellen herausschneiden und ein kompaktes Sheet schreiben. Der Katalog kennt
`frameWidth`, `frameHeight`, `columns` und die Achsen bereits, die
Zielkoordinaten sind also berechenbar:

```ts
// extract-sprites.ts — statt copyFileSync(src, dest) für Entity-Sheets
/** Schneidet nur die Frame-Zellen heraus, die der Renderer über seine
 *  column/row-Achsen ansprechen kann. Ein Sheet mit column.by === "none"
 *  und row.by === "none" schrumpft damit auf eine einzige Zelle. */
function cropUsedFrames(src: string, dest: string, spec: SheetUsage): void {
  const png = PNG.sync.read(readFileSync(src));
  const { frameWidth, frameHeight, usedCols, usedRows } = spec;
  const out = new PNG({ width: frameWidth * usedCols.length, height: frameHeight * usedRows.length });
  out.data.fill(0);
  usedRows.forEach((srcRow, r) =>
    usedCols.forEach((srcCol, c) =>
      PNG.bitblt(png, out, srcCol * frameWidth, srcRow * frameHeight,
                 frameWidth, frameHeight, c * frameWidth, r * frameHeight)));
  writeFileSync(dest, PNG.sync.write(out));
}
```

Da sich dabei die Spaltenindizes verschieben, muss `render-catalog.ts` die
`columns`-Angabe und ggf. einen Spalten-Offset entsprechend neu schreiben —
das ist der eigentliche Aufwand, nicht das Croppen selbst.

**Aufwand:** L (Pipeline + Katalog + visuelle Verifikation aller ~120 Entities).
**Nutzen:** sehr hoch — Größenordnung **10× weniger Sprite-Bytes**, plus
entsprechend weniger Decode-Zeit und Speicher im Browser.

### Phase-7-Gegenprobe mit anderer Methode

Die Zahl oben stammt aus einer **statischen Modellierung** der
`column.by`/`row.by`-Achsen. Weil davon eine teure Empfehlung abhängt, habe ich
sie mit einem **unabhängigen, empirischen** Verfahren gegengeprüft
(`audit/scripts/verify-f06.ts`): Statt die Adressierung zu modellieren, wird
`collectEntity` für **jede** Entity über 16 Richtungen × 11
Nachbarschaftskonstellationen × 15 Animationsframes real aufgerufen und
protokolliert, welche `(sheet, sx, sy)`-Zellen **tatsächlich** vorkommen.

```
EMPIRISCH (collectEntity real aufgerufen, nicht modelliert):
  Sheets erfasst: 467
  Gesamtbytes:    176 MB
  davon genutzt:   19 MB
  VERSCHWENDET:   156 MB = 89 %
```

**Zwei Methoden, dasselbe Ergebnis (87 % vs. 89 %).** Der Befund trägt.

Aufschlussreich ist die Abweichung im Detail: Für `rail-stone-path.png` findet
die empirische Messung **4 von 210** genutzten Zellen, die statische Analyse
kam auf 1 von 512. Die empirische Methode findet also **mehr** genutzte Zellen —
sie ist die konservativere. Genau deshalb sollte die Implementierung von F-06
**auf dieser empirischen Erfassung aufbauen**, nicht auf der Achsen-Modellierung:
Ein Cropping, das sich auf `column.by`/`row.by` verlässt, hätte bei
`rail-stone-path` drei tatsächlich benutzte Frames weggeschnitten.

**Konkrete Konsequenz für die Umsetzung:** `verify-f06.ts` produziert bereits
die Menge der real benutzten Zellen pro Sheet. Diese Menge ist die richtige
Eingabe für den Zuschnitt — nicht eine aus den Achsen abgeleitete Annahme.

**Weiterhin zwingend:** eine visuelle Gegenprüfung über das vorhandene
Layer-Debug-Werkzeug bzw. den Debug-Lab-Blueprint (enthält je eine Instanz
jeder Entity), bevor der Zuschnitt ausgerollt wird.

### Verworfene Hypothesen (bewusst *keine* Empfehlung)

Zwei naheliegende Ratschläge habe ich geprüft und **verworfen**, weil die
Messung dagegen spricht:

1. **"Sprites per Viewport lazy laden."** `bench-sprite-payload.ts` vergleicht
   Preload-aller-Entities gegen ein 320×180-Kachel-Sichtfenster bei minimalem
   Zoom: **2919 MB vs. 2919 MB — 100 %, also null Ersparnis.** Echte Blueprints
   sind kompakt genug, dass nach dem initialen Framing praktisch alle Entities
   im Bild sind. Die Empfehlung wäre wirkungslos.

2. **"PNGs mit einem Image-Optimizer verkleinern."** Ein Re-Encoding-Test über
   10 repräsentative Sheets ergab **42,3 MB → 50,2 MB, also 19 % *größer***.
   Die von Factorio gelieferten PNGs sind bereits gut komprimiert. Auch die
   Schattensheets sind schon optimal (`8-bit colormap` bzw. `gray+alpha`,
   zusammen nur 6,5 MB). Hier ist nichts zu holen — das Problem sind
   ausschließlich die ungenutzten Frames (F-06).

### Schriften und erstes Rendering

`apps/site/index.html:11-16` lädt drei Google-Fonts-Familien über ein
**render-blockierendes** `<link rel="stylesheet">`:

```html
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet" />
```

`preconnect` ist korrekt gesetzt (`:9-10`) und `display=swap` verhindert
unsichtbaren Text — beides richtig gemacht. Es bleiben aber acht Schriftschnitte
von einem Drittanbieter auf dem kritischen Pfad, mit DNS + TLS + zwei
Round-Trips (CSS, dann Font-Dateien), bevor der erste Text final gerendert ist.
`display=swap` bedeutet zudem, dass ein **Font-Swap-Layout-Shift** auftritt,
sobald die Schriften ankommen.

**Vorschlag:** Die benötigten `woff2`-Dateien selbst hosten und per
`@font-face` + `<link rel="preload">` einbinden. Spart eine fremde Verbindung
und einen Round-Trip. Aufwand S, Nutzen moderat.

### Ladereihenfolge

Siehe `03-performance.md`, F-08: `game-data.json` und `render-catalog.json`
werden **sequenziell** geladen, obwohl unabhängig — gemessen 177 ms unnötige
Verzögerung, bis der Renderer überhaupt Sprites zeichnen kann.

---

## Was am Rendering gut gelöst ist (nicht anfassen)

Explizit festgehalten, weil der Auftrag danach fragt:

1. **`spriteAtlas.ts` insgesamt.** Begrenzte Decode-Nebenläufigkeit
   (`DECODE_CONCURRENCY = 6`, `:44`) gegen Main-Thread-Stalls beim Aufdecken
   vieler neuer Entities; `img.decode()` **vor** Freigabe, damit `drawImage`
   nie synchron dekodieren muss (`:106`); Outline-Fallback statt Blockieren;
   eine geteilte Instanz über Remounts (`:139-144`), sodass ein Sheet pro Tab
   nur einmal dekodiert wird. Das ist durchdachter als in den meisten
   Canvas-Projekten und die Kommentare erklären das *Warum*.
2. **Trennung `collect` / `paint`.** Klassifikation erzeugt reine Datenobjekte,
   Zeichnen berührt keine Logik. Genau dieser Schnitt macht F-01 Stufe 2
   überhaupt erst realisierbar.
3. **Frustum-Culling** über `SpatialIndex.queryRect` mit `CULL_PADDING = 4`
   (`render.ts:281`) — mit gemessenen 0,35 ms bei 6.478 Entities völlig
   unkritisch und korrekt gepolstert für überstehende Sprites.
4. **Globaler Sort statt Sortierung pro Entity** — notwendig für korrekte
   Schattenüberlagerung, bewusst so gebaut und dokumentiert.
5. **`CanvasPattern` für das Bodenraster** statt Zehntausender `fillRect`.
6. **Vollständiges Teardown** in `destroy()`.
7. **`imageSmoothingEnabled = false`** (`:145`) — korrekt für Pixel-Art.
8. **`touchAction`/`userSelect`/`draggable`-Behandlung** (`:136-141`) samt
   Begründung, warum jede einzelne Zeile nötig ist.
