/** F-06 ROLLOUT, Schritt B: Schneidet die Sheets zu und schreibt den Katalog um.
 *
 *  Kerngedanke: Der RENDERER wird nicht angefasst. `collect.ts` rechnet
 *      sx = (sprite.x ?? 0) + column * frameWidth
 *  Wenn ein Sheet auf die genutzten Spalten/Zeilen eingedampft wird,
 *  verschieben sich die Zellen — also wird im Katalog der Sprite-Ursprung
 *  `x`/`y` so umgeschrieben, dass dieselbe Formel wieder auf dieselbe Zelle
 *  zeigt. Damit bleibt jeder gezeichnete Pixel identisch und es gibt keinen
 *  neuen Codepfad, der falsch sein könnte.
 *
 *  Grenzfall `columns`: `push()` rechnet `rawColumn % (sprite.columns ?? 1)`.
 *  Bleibt `columns` unverändert, während das Sheet schmaler wird, zeigt der
 *  Modulo weiterhin auf die richtige logische Spalte — die Umrechnung auf die
 *  neue physische Spalte passiert über das umgeschriebene `x`. Deshalb wird
 *  `columns` NUR dort angefasst, wo eine Spalte tatsächlich entfällt und der
 *  Modulo sonst danebengreifen würde; siehe remapColumn().
 *
 *  ZWEI Dateien tragen Sprite-Deskriptoren, nicht nur eine:
 *    - render-catalog.json  (~460 Sprites, die kuratierten Layer)
 *    - game-data.json       (~314 Sprites unter machines/beacons/belts/inserters)
 *  `buildVisualLookup` führt beide zusammen. Ein früherer Lauf schrieb nur den
 *  Katalog um — die Prüfung schlug daraufhin mit 780 Pixel-Abweichungen an
 *  (chemical-plant, oil-refinery u. a. beziehen ihre Sheets aus game-data).
 *  Deshalb werden hier beide Dateien identisch behandelt.
 *
 *  --dry-run schreibt nichts, meldet nur.
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const DRY = process.argv.includes("--dry-run");
const SRC_DIR = "apps/site/public/data/sprites/entities/";
const BACKUP_DIR = "audit/f06-rollout/original-sheets/";
const USAGE = "audit/f06-rollout/usage.json";
const TARGETS = [
  { live: "apps/site/public/data/render-catalog.json", backup: "audit/f06-rollout/render-catalog.original.json" },
  { live: "apps/site/public/data/game-data.json",      backup: "audit/f06-rollout/game-data.original.json" },
];

type Row = {
  sheet: string; file: string; width: number; height: number;
  frameWidth: number; frameHeight: number; cols: number; rows: number;
  totalCells: number; usedCols: number[]; usedRows: number[];
  usedCells: number; croppable: boolean; reason?: string;
};
const usage = JSON.parse(readFileSync(USAGE, "utf8")) as { sheets: Row[] };
const plan = new Map<string, Row>();
for (const r of usage.sheets) if (r.croppable) plan.set(r.file, r);

console.log(`=== F-06 Rollout, Schritt B${DRY ? " (DRY RUN)" : ""} ===`);
console.log(`  Sheets im Plan: ${plan.size}\n`);

/* ---------- 1. PNGs zuschneiden ---------- */
if (!DRY) mkdirSync(BACKUP_DIR, { recursive: true });
let beforeTotal = 0, afterTotal = 0, cropped = 0;

for (const [file, r] of plan) {
  const src = SRC_DIR + file;
  if (!existsSync(src)) { console.warn(`  fehlt: ${file}`); continue; }
  const before = statSync(src).size;

  if (DRY) {
    beforeTotal += before;
    afterTotal += before * (r.usedCols.length * r.usedRows.length) / r.totalCells;
    cropped++;
    continue;
  }

  // Original einmalig sichern, damit ein erneuter Lauf nicht auf einem
  // bereits zugeschnittenen Sheet aufsetzt (das wäre stillschweigender
  // Datenverlust).
  const backup = BACKUP_DIR + file;
  if (!existsSync(backup)) copyFileSync(src, backup);

  const png = PNG.sync.read(readFileSync(backup));
  const { frameWidth: fw, frameHeight: fh, usedCols, usedRows } = r;
  const out = new PNG({ width: fw * usedCols.length, height: fh * usedRows.length });
  out.data.fill(0);
  usedRows.forEach((srcRow, destRow) =>
    usedCols.forEach((srcCol, destCol) =>
      PNG.bitblt(png, out, srcCol * fw, srcRow * fh, fw, fh, destCol * fw, destRow * fh)));
  writeFileSync(src, PNG.sync.write(out));

  const after = statSync(src).size;
  beforeTotal += before; afterTotal += after; cropped++;
}

const MB = (b: number) => (b / 1048576).toFixed(1) + " MB";
console.log(`  Zugeschnitten: ${cropped} Sheets`);
console.log(`  ${MB(beforeTotal)} -> ${MB(afterTotal)}  (-${(100 - afterTotal / beforeTotal * 100).toFixed(1)} %)\n`);

/* ---------- 2. Sprite-Deskriptoren umschreiben ---------- */
let rewritten = 0, untouched = 0, warned = 0;

/** Alter Zellindex -> neuer; -1, wenn die Zelle weggeschnitten wurde. */
const remap = (list: number[], oldIndex: number) => list.indexOf(oldIndex);

function rewriteSprite(sp: any): void {
  const sheets: string[] = sp.sheets ?? (sp.sheet ? [sp.sheet] : []);
  if (!sheets.length || !sp.frameWidth) return;

  // Alle Sheets eines Sprites müssen denselben Plan haben, sonst wäre die
  // Umrechnung pro Datei verschieden — dann lieber nichts tun.
  const rows = sheets.map((s) => plan.get(s.split("/").pop()!));
  if (rows.some((r) => !r)) { untouched++; return; }
  const r = rows[0]!;
  if (rows.some((x) => x!.usedCols.join() !== r.usedCols.join() || x!.usedRows.join() !== r.usedRows.join())) {
    untouched++; return;
  }

  const fw = sp.frameWidth, fh = sp.frameHeight;
  const oldCol = Math.round((sp.x ?? 0) / fw), oldRow = Math.round((sp.y ?? 0) / fh);
  const newCol = remap(r.usedCols, oldCol), newRow = remap(r.usedRows, oldRow);
  if (newCol < 0 || newRow < 0) {
    console.warn(`  WARNUNG: Ursprungszelle (${oldCol},${oldRow}) von ${sheets[0]!.split("/").pop()} nicht im Zuschnitt`);
    warned++; untouched++; return;
  }

  sp.x = newCol * fw;
  sp.y = newRow * fh;

  // `columns` begrenzt den Modulo in push(); nach dem Zuschnitt darf er nicht
  // über das neue Sheet hinauszeigen. Nur verkleinern, nie vergrößern.
  if (typeof sp.columns === "number") sp.columns = Math.min(sp.columns, r.usedCols.length);
  if (typeof sp.rowsPerSheet === "number") sp.rowsPerSheet = Math.min(sp.rowsPerSheet, r.usedRows.length);

  rewritten++;
}

function walk(node: any): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) walk(n); return; }
  if (typeof node.sheet === "string" || Array.isArray(node.sheets)) rewriteSprite(node);
  for (const v of Object.values(node)) walk(v);
}

for (const { live, backup } of TARGETS) {
  const liveRaw = readFileSync(live, "utf8");
  // Immer vom ORIGINAL ausgehen, nie vom bereits umgeschriebenen Stand —
  // sonst würde ein zweiter Lauf die Ursprünge ein zweites Mal verschieben.
  if (!DRY && !existsSync(backup)) writeFileSync(backup, liveRaw);
  const source = existsSync(backup) ? readFileSync(backup, "utf8") : liveRaw;
  const doc = JSON.parse(source);

  const before = rewritten;
  walk(doc);
  console.log(`  ${path.basename(live)}: ${rewritten - before} Sprites umgeschrieben`);

  if (!DRY) writeFileSync(live, JSON.stringify(doc));
}

console.log(`\n  Gesamt: ${rewritten} umgeschrieben, ${untouched} unverändert, ${warned} Warnungen`);
console.log(DRY ? "  (dry run — nichts geschrieben)" : "  geschrieben; Originale unter audit/f06-rollout/");
