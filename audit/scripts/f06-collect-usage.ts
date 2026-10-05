/** F-06 ROLLOUT, Schritt A: Ermittelt für JEDES Sheet die real angesprochenen
 *  Zellen, über alle Entities und alle relevanten Zustände.
 *
 *  Zwei Dinge, die der Prototyp (eine Familie) noch nicht leisten musste:
 *
 *  1. Sheets werden GETEILT. `pipe-cover-north.png` gehört 14 Entities,
 *     `transport-belt.png` vier. Ein Zuschnitt pro Entity würde die jeweils
 *     anderen zerstören, deshalb wird die VEREINIGUNG über alle Nutzer
 *     gebildet und das Sheet genau einmal zugeschnitten.
 *  2. Der Zustandsraum muss breit genug abgetastet werden, damit keine Zelle
 *     übersehen wird — eine übersehene Zelle ist ein fehlendes Sprite im
 *     fertigen Produkt. Deshalb hier bewusst großzügig: alle 16 Richtungen,
 *     viele Animationsphasen, Modulbelegungen, Heat-Nachbarschaften und
 *     Fluid-/Belt-Nachbarn aus allen vier Himmelsrichtungen.
 *
 *  Schreibt nur einen Bericht, fasst keine Dateien an. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { GameData, RenderCatalog, PlacedEntity } from "../../packages/engine/src/index.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../../packages/renderer/src/entityLookup.js";
import { buildGrid } from "../../packages/renderer/src/neighbours/grid.js";
import { buildFluidNetwork } from "../../packages/renderer/src/neighbours/fluid.js";
import { buildHeatNetwork } from "../../packages/renderer/src/neighbours/heat.js";
import { buildCargoBayGrid } from "../../packages/renderer/src/neighbours/cargoBay.js";
import { collectEntity } from "../../packages/renderer/src/draw/collect.js";
import type { DrawCommand } from "../../packages/renderer/src/draw/commands.js";

const SRC = "apps/site/public/data/sprites/entities/";
const OUT = "audit/f06-rollout";
mkdirSync(OUT, { recursive: true });

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));
const catalog: RenderCatalog = JSON.parse(readFileSync("apps/site/public/data/render-catalog.json", "utf8"));
const lookup = buildVisualLookup(data, catalog);
const connectors = makeConnectorPredicates(lookup);

const sheetFile = (sheet: string) => SRC + sheet.split("/").pop();
function pngDims(sheet: string): [number, number] | null {
  const f = sheetFile(sheet);
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function ent(name: string, x: number, y: number, direction: number, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entityNumber: Math.round(Math.abs(x) * 977 + Math.abs(y) * 131 + direction) + 1, name, x, y,
           direction, quality: "normal", modules: [], filterItems: [], ...extra } as PlacedEntity;
}

/** Every sprite object reachable from a layer, whatever its `per` shape. */
function spritesOfLayer(layer: any): any[] {
  if (!("per" in layer)) return [layer.sprites];
  if (layer.per === "heat-connection-patches") return [...(layer.connected ?? []), ...(layer.disconnected ?? [])];
  if (layer.per === "module-slot") return (layer.slots ?? []).flatMap((s: any) => [s.empty, ...(s.filled ?? [])]);
  return Object.values(layer.sprites ?? {});
}

/* --- Sheet -> Zellraster ---------------------------------------------------
   Nur die FRAMEGRÖSSE definiert das Raster. Der `x`/`y` des Sprites ist
   dagegen ein Ursprungs-Offset: bei `per:"dir4"`-Layern zeigen vier Sprites
   mit identischer Framegröße auf dasselbe Sheet, jedes mit eigenem x
   (0, 386, 772, 1158) — das ist kein Widerspruch, sondern vier Spalten
   desselben Rasters. Die beobachteten sx/sy sind bereits absolute
   Pixelkoordinaten (x + column*frameWidth), also wird direkt daraus der
   Zellindex gebildet und der Sprite-Ursprung ignoriert.

   Ein echter Widerspruch ist nur eine abweichende Framegröße — dann gibt es
   kein gemeinsames Raster und das Sheet bleibt unangetastet. */
const spriteOf = new Map<string, any>();
const conflicting = new Set<string>();
for (const [, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    for (const sp of spritesOfLayer(layer)) {
      if (!sp?.frameWidth) continue;
      const sheets: string[] = sp.sheets ?? (sp.sheet ? [sp.sheet] : []);
      for (const sh of sheets) {
        const prev = spriteOf.get(sh);
        if (!prev) { spriteOf.set(sh, sp); continue; }
        if (prev.frameWidth !== sp.frameWidth || prev.frameHeight !== sp.frameHeight) conflicting.add(sh);
      }
    }
  }
}

/* --- Beobachtung ---------------------------------------------------------- */
const used = new Map<string, Set<string>>();

/* Erste Quelle: die im Katalog DEKLARIERTEN Sprite-Ursprünge.
 *
 * Der Zustandsraum lässt sich nicht garantiert vollständig abtasten. Bei
 * `per:"connection"` (cargo-landing-pad) etwa liegen 16 vorberechnete
 * Zellpositionen im Katalog, von denen eine Nachbar-Simulation nur einen Teil
 * erreicht — die Warnung aus einem früheren Lauf ("Ursprungszelle (6,3) nicht
 * im Zuschnitt") kam genau daher.
 *
 * Deshalb gilt jede im Katalog stehende Ursprungszelle per se als genutzt,
 * unabhängig davon, ob die Simulation sie erreicht hat. Die Beobachtung
 * kommt additiv dazu und fängt die Zellen, die erst durch column/row-Indizes
 * jenseits des Ursprungs entstehen. Lieber ein paar Zellen zu viel behalten
 * als eine zu wenig: zu viel kostet Bytes, zu wenig kostet ein Sprite. */
for (const [, visual] of lookup) {
  for (const layer of (visual as any).graphics?.layers ?? []) {
    for (const sp of spritesOfLayer(layer)) {
      if (!sp?.frameWidth) continue;
      for (const sh of (sp.sheets ?? (sp.sheet ? [sp.sheet] : [])) as string[]) {
        let s = used.get(sh); if (!s) used.set(sh, (s = new Set()));
        s.add(`${sp.x ?? 0},${sp.y ?? 0}`);
      }
    }
  }
}
const record = (cmds: DrawCommand[]) => {
  for (const c of cmds) {
    let s = used.get(c.sheet); if (!s) used.set(c.sheet, (s = new Set()));
    s.add(`${c.sx},${c.sy}`);
  }
};

function collectFor(self: PlacedEntity, others: PlacedEntity[], frame: number): DrawCommand[] {
  const all = [self, ...others];
  const ctx: any = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, e.recipe, data);
    }),
    heatNetwork: buildHeatNetwork(all, (n) => lookup.get(n)?.heatConnections),
    ...connectors,
    cargoBays: buildCargoBayGrid(all, connectors.cargoBayShapeOf),
    animationFrame: frame,
  };
  const out: DrawCommand[] = [];
  const v = lookup.get(self.name);
  if (!v?.graphics) return out;
  try { collectEntity(out, self, v, ctx, 1); } catch { /* Zustand für diese Entity ungültig — überspringen */ }
  return out;
}

// Animation phases: powers of two plus a dense low range. `animationFrame`
// is taken modulo the sprite's own column count, so sampling 0..63 densely
// plus a few large values covers every period the catalog actually uses.
const FRAMES = [...Array(64).keys(), 71, 89, 100, 127, 128, 191, 255, 256, 359, 511, 512, 1023];

// Neighbours from every side, in the flavours that change connection art.
const NEIGHBOUR_KINDS = ["pipe", "heat-pipe", "transport-belt", "fast-transport-belt",
                         "express-transport-belt", "turbo-transport-belt", "small-electric-pole"];

const allNames = [...lookup.keys()];
console.log(`=== F-06 Rollout, Schritt A: Zellnutzung über ${allNames.length} Entities ===`);

let done = 0;
for (const name of allNames) {
  const visual: any = lookup.get(name);
  if (!visual?.graphics) continue;
  const maxSlots = visual.moduleSlots ?? 0;

  for (let dir = 0; dir < 16; dir++) {
    // Ohne Nachbarn, über den Animationsraum
    for (const f of FRAMES) record(collectFor(ent(name, 0.5, 0.5, dir), [], f));

    // Modulbelegungen (nur wo relevant)
    for (let filled = 1; filled <= maxSlots; filled++) {
      record(collectFor(ent(name, 0.5, 0.5, dir, {
        modules: [{ name: "productivity-module", quality: "normal", count: filled }],
      } as any), [], 0));
    }

    // Nachbarn aus allen vier Richtungen, einzeln und gemeinsam
    for (const kind of NEIGHBOUR_KINDS) {
      const around = [ent(kind, 3.5, 0.5, 0), ent(kind, -2.5, 0.5, 0),
                      ent(kind, 0.5, 3.5, 0), ent(kind, 0.5, -2.5, 0)];
      for (const n of around) record(collectFor(ent(name, 0.5, 0.5, dir), [n], 0));
      record(collectFor(ent(name, 0.5, 0.5, dir), around, 0));
    }

    // Gleiche Entity als Nachbar (Wände, Rohre, Bänder verketten sich)
    record(collectFor(ent(name, 0.5, 0.5, dir),
      [ent(name, 3.5, 0.5, dir), ent(name, -2.5, 0.5, dir),
       ent(name, 0.5, 3.5, dir), ent(name, 0.5, -2.5, dir)], 0));
  }
  if (++done % 20 === 0) console.log(`  ... ${done}/${allNames.length}`);
}

/* --- Bericht -------------------------------------------------------------- */
type Row = {
  sheet: string; file: string; width: number; height: number;
  frameWidth: number; frameHeight: number; spriteX: number; spriteY: number;
  cols: number; rows: number; totalCells: number;
  usedCols: number[]; usedRows: number[]; usedCells: number;
  croppable: boolean; reason?: string;
};
const rows: Row[] = [];
for (const [sheet, cells] of used) {
  const sp = spriteOf.get(sheet);
  const dim = pngDims(sheet);
  const base = sheet.split("/").pop()!;
  if (!sp || !dim) { rows.push({ sheet, file: base, width: 0, height: 0, frameWidth: 0, frameHeight: 0,
    spriteX: 0, spriteY: 0, cols: 0, rows: 0, totalCells: 0, usedCols: [], usedRows: [], usedCells: cells.size,
    croppable: false, reason: !dim ? "Datei fehlt" : "kein Sprite-Deskriptor" }); continue; }

  const fw = sp.frameWidth, fh = sp.frameHeight;
  const spx = sp.x ?? 0, spy = sp.y ?? 0;
  const cols = Math.max(1, Math.floor(dim[0] / fw));
  const rws = Math.max(1, Math.floor(dim[1] / fh));

  const coords = [...cells].map((k) => {
    const [sx, sy] = k.split(",").map(Number);
    return { cx: sx! / fw, cy: sy! / fh };
  });
  // Nicht-ganzzahlige Zellindizes bedeuten, dass ein Pfad das Sheet anders
  // adressiert als über volle Frames (z. B. die halbierten Belt-Lanes von
  // keepSide). Solche Sheets werden NICHT zugeschnitten.
  const fractional = coords.some((c) => !Number.isInteger(c.cx) || !Number.isInteger(c.cy));
  const usedCols = [...new Set(coords.map((c) => c.cx))].sort((a, b) => a - b);
  const usedRows = [...new Set(coords.map((c) => c.cy))].sort((a, b) => a - b);

  /* Welche Zuschnitte sind ÜBERHAUPT sicher?
   *
   * `push()` in collect.ts rechnet
   *     sx = sprite.x + column * frameWidth
   *     sy = sprite.y + row    * frameHeight
   * Der Zuschnitt schreibt nur `sprite.x`/`y` um — `column`/`row` kommen zur
   * Laufzeit aus Animationsphase, Richtung und Nachbarschaft und lassen sich
   * nicht umschreiben. Eine Zelle bei Index i landet nach dem Zuschnitt also
   * weiterhin bei Offset i, gemessen ab dem neuen Ursprung.
   *
   * Das geht genau dann auf, wenn die genutzten Indizes ein LÜCKENLOSES
   * Präfix 0..n-1 bilden: dann ist die Abbildung die Identität und es fällt
   * nur ungenutzter Rand hinten weg.
   *
   * Bei transport-belt.png ist das nicht so — Ursprung (0,0), aber
   * `row:"connection"` erreicht die Zeilen 12..19. Ein Zusammenschieben auf
   * [0,1,2,3,12,...] würde jeden Zeilenindex ab 4 auf das falsche Bild
   * zeigen lassen. Solche Sheets bleiben unangetastet.
   *
   * Das ist bewusst konservativ: Es verschenkt Bytes bei löchriger Nutzung,
   * kann aber kein Sprite verfälschen. */
  const isPrefix = (list: number[]) => list.every((v, i) => v === i);

  let croppable = true, reason: string | undefined;
  if (conflicting.has(sheet)) { croppable = false; reason = "widersprüchliche Frame-Geometrie zwischen Nutzern"; }
  else if (fractional) { croppable = false; reason = "nicht-ganzzahlige Zellindizes (Teilframe-Adressierung)"; }
  else if (!isPrefix(usedCols) || !isPrefix(usedRows)) { croppable = false; reason = "genutzte Zellen bilden kein lückenloses Präfix"; }
  else if (usedCols.length === cols && usedRows.length === rws) { croppable = false; reason = "alle Zellen genutzt"; }

  rows.push({ sheet, file: base, width: dim[0], height: dim[1], frameWidth: fw, frameHeight: fh,
    spriteX: spx, spriteY: spy, cols, rows: rws, totalCells: cols * rws,
    usedCols, usedRows, usedCells: cells.size, croppable, reason });
}

rows.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(`${OUT}/usage.json`, JSON.stringify({ sheets: rows, conflicting: [...conflicting] }, null, 1));

const crop = rows.filter((r) => r.croppable);
console.log(`\n  Sheets beobachtet:      ${rows.length}`);
console.log(`  davon zuschneidbar:     ${crop.length}`);
for (const r of rows.filter((x) => !x.croppable)) console.log(`    übersprungen: ${r.file} — ${r.reason}`);
console.log(`\n  Bericht: ${OUT}/usage.json`);
