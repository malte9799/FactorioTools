/** Renders a seed and compares it with the game's own map preview. Needs a
 *  Factorio install.
 *
 *    npm run compare-preview --workspace=@factoriotools/mapgen -- <seed> [size]
 *
 *  Writes ours/game/diff PNGs to the system temp directory and prints how
 *  many pixels agree. The game draws trees, cliffs and its resource dither
 *  over the terrain, so only water is expected to agree completely. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MapSurface, type MapGenData } from "../src/index.js";
import { FACTORIO, ORACLE_DIR, oracleConfig } from "./oracle.js";
import { decodePng, encodePng, type Image } from "./png.js";
import { loadDataset } from "../test/dataset.js";

const seed = Number(process.argv[2] ?? 123);
const size = Number(process.argv[3] ?? 1024);
const data: MapGenData = loadDataset();

const surface = new MapSurface(data, { seed });
const started = performance.now();
const grid = surface.sample(-size / 2, -size / 2, size, size, 1);
const ms = performance.now() - started;
console.log(`seed ${seed}: ${size}x${size} tiles in ${ms.toFixed(0)} ms (${((size * size) / ms / 1000).toFixed(2)} M tiles/s)`);

function paint(overlays: boolean): Image {
  const img: Image = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let k = 0; k < size * size; k++) {
    let color = surface.tiles[grid.tile[k]!]!.color;
    if (overlays && grid.resource[k]) color = surface.resources[grid.resource[k]! - 1]!.color;
    else if (overlays && grid.enemy[k]) color = [232, 34, 34];
    img.data.set([color[0], color[1], color[2], 255], k * 4);
  }
  return img;
}

const gamePng = path.join(ORACLE_DIR, `preview-${seed}.png`);
execFileSync(
  FACTORIO,
  ["-c", oracleConfig(), "--mod-directory", path.join(ORACLE_DIR, "mods-empty"), "--generate-map-preview", gamePng, "--map-gen-seed", String(seed), "--map-preview-size", String(size)],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const game = decodePng(readFileSync(gamePng));
const ours = paint(false);

const waterColors = new Set(surface.tiles.filter((t) => t.water).map((t) => t.color.join(",")));
let same = 0;
let waterAgree = 0;
let waterTotal = 0;
const diff: Image = { width: size, height: size, data: new Uint8Array(size * size * 4) };
for (let k = 0; k < size * size; k++) {
  const o = k * 4;
  const identical = ours.data[o] === game.data[o] && ours.data[o + 1] === game.data[o + 1] && ours.data[o + 2] === game.data[o + 2];
  if (identical) same++;
  const oursWater = surface.tiles[grid.tile[k]!]!.water;
  const gameWater = waterColors.has(`${game.data[o]},${game.data[o + 1]},${game.data[o + 2]}`);
  if (oursWater || gameWater) {
    waterTotal++;
    if (oursWater === gameWater) waterAgree++;
  }
  diff.data.set(identical ? [ours.data[o]! >> 1, ours.data[o + 1]! >> 1, ours.data[o + 2]! >> 1, 255] : [255, 0, 0, 255], o);
}
console.log(`identical pixels: ${((100 * same) / (size * size)).toFixed(2)}%`);
console.log(`water agreement:  ${((100 * waterAgree) / Math.max(1, waterTotal)).toFixed(3)}% of ${waterTotal} water pixels`);

writeFileSync(path.join(ORACLE_DIR, `ours-${seed}.png`), encodePng(paint(true)));
writeFileSync(path.join(ORACLE_DIR, `diff-${seed}.png`), encodePng(diff));
console.log(`wrote ours-${seed}.png, diff-${seed}.png and preview-${seed}.png to ${ORACLE_DIR}`);
