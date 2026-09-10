# 04 — Codequalität & Tests

## Gesamteindruck

Dieser Code ist **überdurchschnittlich gepflegt**. Bevor die Findings kommen,
die Belege dafür, weil sie die Bewertung der Findings verändern:

| Metrik | Wert |
|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** |
| `as unknown as` | **0** |
| `tsc --noEmit` über 4 Pakete | **0 Fehler** |
| `any` im ausgelieferten Client-Code | **0** (bis auf `window.__debug`) |
| Zyklen im Modulgraph | **0** |
| Schichtverletzungen | **0** |
| bekannte CVEs | **0** |

Die TypeScript-Konfiguration (`tsconfig.base.json`) ist strikter als üblich:
`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `isolatedModules`,
`verbatimModuleSyntax`. Besonders `noUncheckedIndexedAccess` wird selten
aktiviert und ist hier durchgehend eingehalten.

**Die Kommentare sind die größte Stärke des Projekts.** Sie erklären
durchgängig das *Warum*, nicht das *Was*, und dokumentieren getroffene
Abwägungen und verworfene Alternativen. Beispiele: `spriteAtlas.ts:32-43`
(warum die Decode-Nebenläufigkeit begrenzt ist, inkl. beobachtetem
Browserverhalten), `render.ts:363-372` (warum die Kollisionsabfrage um ein
Epsilon eingerückt wird), `spatialIndex.ts:1-5` (warum ein Uniform-Grid und
kein Quadtree). Das ist Dokumentation auf einem Niveau, das man selten sieht —
**und der Hauptgrund, warum dieses Audit so präzise sein kann.**

## F-11 — Zwei Monolith-Funktionen halten den gesamten Zustand (Schweregrad 3)

**Fundstellen:** `apps/site/src/tools/blueprint-viewer/index.ts:258`, `packages/renderer/src/render.ts:125`

**Gemessen** (`audit/scripts/complexity.mjs`):

| Funktion | Zeilen | Verzweigungen | Deklarationen | verschachtelte Funktionen |
|---|---:|---:|---:|---:|
| `mountBlueprintViewer` | **1.666** | **283** | 182 | 51 |
| `mountRenderer` | **889** | **170** | — | — |
| `mountLayerDebug` | 453 | 85 | — | — |

Zum Vergleich: die viertkomplexeste Funktion im Projekt (`buildRenderCatalog`)
hat 62 Verzweigungen — Faktor 4,5 weniger.

Beide Funktionen sind Closure-Mounts: Der komplette Anwendungszustand liegt als
lokale `let`-Variablen im Funktionsrumpf (`blueprints`, `entities`, `result`,
`undoStack`, `redoStack`, `selectedEntity`, `menuState`, `heldModule`,
`paletteSelection`, … 24 mutable Variablen allein in `mountBlueprintViewer`).

**Warum das ein Problem ist:** Nicht Stil, sondern Testbarkeit. Kein Zustand und
keine der 51 inneren Funktionen ist von außen erreichbar. Genau deshalb hat
`apps/site` **0 Tests** — es *gibt* keine testbare Oberfläche. Jede Änderung an
Undo, Platzierung oder Menülogik ist nur manuell im Browser überprüfbar.

**Lösungsvorschlag:** Kein Big-Bang-Umbau. Schrittweise die zustandsbehafteten
Kerne als eigenständige, testbare Einheiten herauslösen, beginnend mit den
Teilen, die reine Datenlogik sind:

```ts
// apps/site/src/tools/blueprint-viewer/edit-store.ts  (neu)
/** Entity-Liste + Undo/Redo als eigenständige, DOM-freie Einheit.
 *  mountBlueprintViewer hält davon eine Instanz statt sechs lose Variablen —
 *  und diese Datei ist ohne Browser testbar. */
export function createEditStore(initial: PlacedEntity[] = [], undoLimit = 50) {
  let entities = initial;
  const undoStack: PlacedEntity[][] = [];
  const redoStack: PlacedEntity[][] = [];
  const snapshot = () => entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));

  return {
    get entities() { return entities; },
    apply(mutate: (list: PlacedEntity[]) => PlacedEntity[]) {
      undoStack.push(snapshot());
      if (undoStack.length > undoLimit) undoStack.shift();
      redoStack.length = 0;
      entities = mutate(entities);
    },
    undo() { if (undoStack.length) { redoStack.push(snapshot()); entities = undoStack.pop()!; } },
    redo() { if (redoStack.length) { undoStack.push(snapshot()); entities = redoStack.pop()!; } },
    get canUndo() { return undoStack.length > 0; },
  };
}
```

Das löst gleichzeitig F-10 (Undo-Deckel) und schafft die erste testbare
Einheit im `site`-Paket. Weitere Kandidaten in dieser Reihenfolge:
Paletten-/Menüzustand, Platzierungslogik (`placeEntity`), Auswahlzustand.

**Aufwand:** L insgesamt, aber **in kleinen Schritten machbar** — jeder
herausgelöste Teil ist für sich nützlich. **Nutzen:** mittelfristig hoch,
kurzfristig gering. Deshalb in der Roadmap **nicht** vorne.

## F-12 — 11.355 LOC ohne jeden Test (Schweregrad 4)

**Gemessen:**

| Paket | Src-LOC | Test-LOC | Verhältnis |
|---|---:|---:|---|
| `engine` | 2.117 | 721 | **ordentlich** |
| `renderer` | 3.560 | **0** | — |
| `data-pipeline` | 3.335 | **0** | — |
| `apps/site` | 4.460 | **0** | — |

Die 29 vorhandenen Tests sind **gut**: Sie prüfen echtes Verhalten
(Modul-Effekte, Beacon-Reichweite, Engpass-Zuordnung, Blueprint-Roundtrip),
nicht Trivialitäten, und die Testnamen lesen sich als Spezifikation
("*scaling anchors to theoretical, not bottlenecked, rate (confirmed design
decision)*"). Sie laufen in 1,07 s.

Das Problem ist die **Abdeckungslücke**: Ausgerechnet die komplexeste Logik im
Projekt — die Nachbarschafts-Klassifikation im Renderer, die entscheidet, wie
Bänder, Rohre, Wände und Wärmerohre visuell zusammenlaufen — ist **völlig
ungetestet**. Genau dort sind Regressionen visuell subtil und fallen bei
manueller Prüfung leicht durch.

**Der Aufwand ist niedriger als er wirkt.** 1.684 LOC des Renderers sind
**vollständig DOM-frei** und mit dem bereits vorhandenen tsx-Runner sofort
testbar — kein jsdom, kein neues Framework, keine Konfiguration:

| Modul | LOC | DOM-Referenzen |
|---|---:|---:|
| `draw/collect.ts` | 497 | **0** |
| `neighbours/beltGraph.ts` | 241 | **0** |
| `entityLookup.ts` | 213 | **0** |
| `neighbours/fluid.ts` | 130 | **0** |
| `neighbours/grid.ts` | 106 | **0** |
| `neighbours/heat.ts` | 93 | **0** |
| `spatialIndex.ts` | 91 | **0** |
| `camera.ts` | 89 | **0** |
| `neighbours/pipe.ts`, `platform.ts`, `wall.ts`, `draw/commands.ts` | 224 | **0** |

**Lösungsvorschlag:** Im Stil der vorhandenen Tests anfangen, mit den Modulen
mit der höchsten Fehlerwahrscheinlichkeit pro Zeile:

```ts
// packages/renderer/test/beltGraph.test.ts
import { buildGrid } from "../src/neighbours/grid.js";
import { classifyBeltCell } from "../src/neighbours/beltGraph.js";

const belt = (n: number, x: number, y: number, direction: number) =>
  ({ entityNumber: n, name: "transport-belt", x, y, direction,
     quality: "normal" as const, modules: [], filterItems: [] });

// Eine Kurve entsteht, wenn ein Band von der Seite in ein anderes einläuft —
// die häufigste visuelle Regression bei Änderungen an der Klassifikation.
// Signatur laut beltGraph.ts:167 — (x, y, direction, grid, isBeltLike, forceStraight?)
{
  const entities = [belt(1, 0, 0, 4), belt(2, 1, 0, 8)];   // Ost -> Süd
  const grid = buildGrid(entities);
  const isBeltLike = (n: string) => n.includes("transport-belt");
  const cell = classifyBeltCell(1, 0, 8, grid, isBeltLike);
  assert(cell.connectionName !== "", `Klassifikation lieferte nichts`);
  // konkrete Erwartung anhand des Ist-Verhaltens einmalig festschreiben
}
```

Und `packages/renderer/package.json` um ein `test`-Skript ergänzen sowie das
Wurzel-`test` von `--workspace=@factoriotools/engine` auf `--workspaces` umstellen,
damit Renderer-Tests überhaupt mitlaufen.

**Priorität innerhalb von F-12:** `beltGraph` → `pipe`/`wall` → `fluid`/`heat`
→ `spatialIndex`/`camera` (die letzten beiden sind einfach, aber auch am
unwahrscheinlichsten fehlerhaft).

**Aufwand:** M (jedes Modul einzeln S). **Nutzen:** hoch — das ist die
Absicherung, ohne die alle anderen Empfehlungen dieses Audits riskant sind.

## F-13 — Kein Linter, kein Formatter, keine CI (Schweregrad 2)

Es gibt weder ESLint/Biome/oxlint noch Prettier noch eine
CI-Konfiguration (kein `.github/`, kein `.gitlab-ci.yml`, kein Hook).

Der Code ist trotzdem konsistent formatiert — offensichtlich per Disziplin.
Das funktioniert für einen Einzelentwickler; es bedeutet aber, dass
`npm run check` und `npm test` **nur laufen, wenn jemand daran denkt**.

**Lösungsvorschlag (minimal, ohne Stil-Diskussionen):**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run check      # 3,4 s
      - run: npm test           # 1,1 s
      - run: npm run build      # 1,3 s
```

Gesamtlaufzeit unter einer Minute inklusive Installation. Ein Linter kann
später folgen; die CI mit den **bereits vorhandenen** Skripten ist der Schritt
mit dem besten Verhältnis.

**Aufwand:** S. **Nutzen:** mittel.

## F-14 — Doppelt gehaltenes `visualLookup` (Schweregrad 1)

**Fundstellen:** `apps/site/.../blueprint-viewer/index.ts:420` und `:1802`, `packages/renderer/src/render.ts:149`

Beide bauen unabhängig voneinander dieselbe Map aus denselben Eingaben:

```ts
// index.ts:420
let visualLookup = buildVisualLookup(getData(), getRenderCatalog());
// render.ts:149
const visualLookup = buildVisualLookup(data, catalog);
```

Zwei Kopien derselben abgeleiteten Struktur, die bei einem Datensatzwechsel
beide aktualisiert werden müssen (`index.ts:1802` tut das für die eine Kopie;
die andere wird über einen Renderer-Remount erneuert). Das ist heute korrekt,
aber eine stille Konsistenzfalle.

**Lösungsvorschlag:** Der Renderer gibt sein Lookup über die
`BlueprintRenderer`-Schnittstelle heraus (`getVisualLookup(): ReadonlyMap<string, ResolvedVisual>`),
die App nutzt dieses statt eines eigenen. Aufwand S, Nutzen gering — reine
Hygiene.

## F-15 — Zwei vergessene Debug-Ausgaben (Schweregrad 1)

**Fundstellen:** `apps/site/src/tools/layer-debug/index.ts:503`, `:505`

```ts
console.log("DEBUG onSelect", lastClientX, lastClientY);
console.log("DEBUG picked", picked ? spriteForLayer(picked)?.sheet : null);
```

Im Dev-Werkzeug, das aber (F-07) im Produktions-Bundle landet. Entfernen.
Die beiden anderen `console.warn` (`spriteAtlas.ts:115`, `iconAtlas.ts:45`) sind
**legitime** Fehlerdiagnose und sollten bleiben.

**Aufwand:** S (2 Zeilen).

## Duplikate und tote Pfade

**Aktiv gesucht, wenig gefunden** — das ist ein gutes Zeichen, kein
unvollständiger Audit:

- **Kein toter Code** im Sinne nicht erreichbarer Module. Jede Datei im
  Modulgraph hat mindestens eine eingehende Kante. `noUnusedLocals` fängt
  ungenutzte lokale Symbole bereits beim Typecheck ab.
- **Eine strukturelle Duplizierung:** `paintPlain` (`paint.ts:41-57`) und die
  Schleife in `paintTinted` (`:91-105`) sind bis auf Zielkontext und
  Koordinatentransformation identisch (Schatten-Composite-Umschaltung,
  Alpha-Verwaltung, `drawImage`). ~15 Zeilen doppelt. Zusammenführbar über
  einen gemeinsamen Helfer mit Transform-Parameter — aber der Nutzen ist
  gering und das Risiko, dabei die subtile Tint-Semantik zu brechen, real.
  **Empfehlung: so lassen.** Ich führe es der Vollständigkeit halber auf, nicht
  als Handlungsempfehlung.
- `blueprint_book.txt` (1,3 MB im Repo-Root) sieht nach Altlast aus, **ist es
  aber nicht**: `scripts/build-example-blueprints.mjs:22` und
  `scripts/pick-random-blueprint.mjs:18` lesen es als Build-Eingabe. Kein Finding.

## Fehlerbehandlung

**Durchweg gut und bewusst gestaltet.** Die Philosophie ist konsistent
"degradieren statt abstürzen":

- Unbekannte Entities werden zu `warnings` statt zu Ausnahmen
  (`rates.ts:153-159`) — und es gibt einen Test dafür ("*unrecognised and
  recipe-less entities produce warnings, not crashes*").
- Fehlgeschlagene Sprite-Ladevorgänge zeichnen einen Umriss statt zu blockieren
  (`spriteAtlas.ts:75-88`).
- `localStorage`-Fehler (Quota, deaktiviert) werden abgefangen und ignoriert
  (`blueprint-library.ts:29`, `:37`) — richtig, denn hier ist nichts sinnvoll
  zu melden.
- Fehlender Render-Katalog → Umriss-Modus statt Absturz (`data/index.ts:49-51`).
- Ein fehlgeschlagener Beispiel-Fetch setzt den Cache zurück, damit ein
  späterer Klick es erneut versucht (`index.ts:250-253`).

**Eine Einschränkung:** `apps/site/src/app.ts:6-7` verwendet
`document.getElementById(...)!` ohne Prüfung. Das ist praktisch sicher (die
IDs stehen in derselben `index.html`), aber es ist die einzige Stelle, an der
ein Fehlschlag zu einem harten `TypeError` beim Start führen würde. Marginal.

## Typsicherheit

64 Vorkommen von `any` — **alle 64 ausschließlich in `data-pipeline`**:

| Datei | Anzahl |
|---|---:|
| `render-catalog.ts` | 26 |
| `sprite-shapes.ts` | 21 |
| `dump-to-gamedata.ts` | 17 |

Das ist der Code, der Factorios untypisierten Lua-Dump parst. Dort ist `any` an
der Systemgrenze **vertretbar** und mit typisierten Rückgabewerten
(`GraphicsLayer`, `MachineProto`, `Sprite`) sauber abgeschlossen. Der
ausgelieferte Client-Code ist `any`-frei.

**Optionale Verbesserung:** Die 15 `unknown`-basierten Type-Guards, die es
bräuchte, wären ehrlicher als `any`, aber der Gewinn steht in keinem Verhältnis
zum Aufwand — die Pipeline läuft offline, und ein Fehler dort bricht den Build,
nicht die Produktion. **Keine Empfehlung.**
