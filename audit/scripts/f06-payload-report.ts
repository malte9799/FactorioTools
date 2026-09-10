/** F-06: Was der Zuschnitt am ausgelieferten Sprite-Volumen ändert.
 *  Vergleicht die gesicherten Originale gegen den aktuellen Stand. */
import { readdirSync, statSync, existsSync } from "node:fs";
const LIVE = "apps/site/public/data/sprites/entities/";
const ORIG = "audit/f06-rollout/original-sheets/";

let liveTotal = 0, n = 0;
for (const f of readdirSync(LIVE)) { liveTotal += statSync(LIVE + f).size; n++; }

let croppedBefore = 0, croppedAfter = 0, m = 0;
for (const f of readdirSync(ORIG)) {
  if (!existsSync(LIVE + f)) continue;
  const b = statSync(ORIG + f).size, a = statSync(LIVE + f).size;
  // Das Backup enthält auch Sheets aus einem früheren, verworfenen Plan, die
  // am Ende doch unangetastet blieben — die zählen nicht als zugeschnitten.
  if (a === b) continue;
  croppedBefore += b; croppedAfter += a; m++;
}
const originalTotal = liveTotal - croppedAfter + croppedBefore;
const MB = (b: number) => (b / 1048576).toFixed(1) + " MB";

console.log("=== F-06: ausgeliefertes Sprite-Volumen ===\n");
console.log(`  Sheets gesamt:        ${n}`);
console.log(`  davon zugeschnitten:  ${m}`);
console.log("");
console.log(`  vorher:               ${MB(originalTotal)}`);
console.log(`  nachher:              ${MB(liveTotal)}`);
console.log(`  eingespart:           ${MB(originalTotal - liveTotal)}  (-${(100 - liveTotal / originalTotal * 100).toFixed(1)} %)`);
console.log("");
console.log(`  Nur die zugeschnittenen: ${MB(croppedBefore)} -> ${MB(croppedAfter)}  (-${(100 - croppedAfter / croppedBefore * 100).toFixed(1)} %)`);
