/** F-06 SCHRITT 3: Vorher/Nachher-Bildvergleich.
 *  Rendert die genutzte Zelle aus dem ORIGINAL-Sheet und aus dem
 *  ZUGESCHNITTENEN Sheet in je ein PNG und vergleicht sie pixelweise.
 *  Wenn der Zuschnitt korrekt ist, müssen beide identisch sein. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

const OUT = "audit/f06";
const SRC = "apps/site/public/data/sprites/entities/";
const report = JSON.parse(readFileSync(`${OUT}/crop-report.json`, "utf8"));

let allIdentical = true;
const rows: string[] = [];

for (const sheet of report.sheets) {
  const orig = PNG.sync.read(readFileSync(SRC + sheet.sheet));
  const cropped = PNG.sync.read(readFileSync(`${OUT}/${sheet.sheet.replace(/\.png$/, "")}-cropped.png`));
  const fw = sheet.newFrameWidth, fh = sheet.newFrameHeight;

  // Jede genutzte Zelle aus beiden Quellen ausschneiden und vergleichen
  let differing = 0, comparedPixels = 0;
  sheet.usedRows.forEach((srcRow: number, r: number) =>
    sheet.usedCols.forEach((srcCol: number, c: number) => {
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const oi = ((srcRow * fh + y) * orig.width + (srcCol * fw + x)) * 4;
          const ci = ((r * fh + y) * cropped.width + (c * fw + x)) * 4;
          comparedPixels++;
          for (let k = 0; k < 4; k++) if (orig.data[oi + k] !== cropped.data[ci + k]) { differing++; k = 4; }
        }
      }
    }));

  const identical = differing === 0;
  if (!identical) allIdentical = false;
  rows.push(`${identical ? "IDENTISCH" : "ABWEICHUNG"}  ${sheet.sheet.padEnd(28)} ${comparedPixels} Pixel verglichen, ${differing} abweichend`);
}

console.log("=== Pixelvergleich Original-Zelle vs. zugeschnittene Zelle ===\n");
for (const r of rows) console.log("  " + r);
console.log(`\n${allIdentical ? "Alle zugeschnittenen Sheets sind pixelgenau identisch mit dem Original." : "ABWEICHUNGEN GEFUNDEN — Zuschnitt fehlerhaft."}`);

/* --- Seite-an-Seite-Bild für die visuelle Kontrolle --- */
const first = report.sheets.find((s: any) => !s.sheet.includes("shadow"));
if (first) {
  const orig = PNG.sync.read(readFileSync(SRC + first.sheet));
  const cropped = PNG.sync.read(readFileSync(`${OUT}/${first.sheet.replace(/\.png$/, "")}-cropped.png`));
  const fw = first.newFrameWidth, fh = first.newFrameHeight;
  const gap = 16;
  const canvas = new PNG({ width: fw * 2 + gap, height: fh });
  canvas.data.fill(0);
  const srcRow = first.usedRows[0], srcCol = first.usedCols[0];
  PNG.bitblt(orig, canvas, srcCol * fw, srcRow * fh, fw, fh, 0, 0);
  PNG.bitblt(cropped, canvas, 0, 0, fw, fh, fw + gap, 0);
  writeFileSync(`${OUT}/comparison-${first.sheet}`, PNG.sync.write(canvas));
  console.log(`\nSeite-an-Seite (links Original-Zelle, rechts zugeschnitten):`);
  console.log(`  ${OUT}/comparison-${first.sheet}  (${fw}x${fh} je Hälfte)`);
}

process.exit(allIdentical ? 0 : 1);
