#!/usr/bin/env node
/**
 * Dev-only test helper: generates one big synthetic blueprint that places
 * every entity this app can render, laid out in a grid — plus a set of belt
 * layouts exercising every connection shape (straight runs, all 4 curve
 * combinations, side-loads, a T-merge) since those aren't just "rotate one
 * entity" but depend on neighbor geometry. Meant for visually sweeping the
 * whole renderer at once after a rendering fix, not a permanent app
 * feature.
 *
 * Only entities with a genuine per-direction sprite (confirmed via
 * graphics.directionCount > 1 — poles, underground belts, radar, rail
 * signals — plus inserters, which are procedurally drawn and always
 * rotate) are placed in all 4 cardinal directions (16-way scheme:
 * 0/4/8/12 = N/E/S/W). Everything else renders the same static frame
 * regardless of its placed direction in this tool (confirmed against real
 * game footage — see hasDistinctRotation()'s own comment), so those are
 * placed once at direction 0 rather than wasting grid space on 4
 * identical-looking copies.
 *
 * Usage: node scripts/build-rotation-test-blueprint.mjs > /tmp/rotation-test.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DATA = path.join(__dirname, "../apps/site/public/data");

const gameData = JSON.parse(readFileSync(path.join(SITE_DATA, "game-data.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(path.join(SITE_DATA, "render-catalog.json"), "utf-8"));

const DIRECTIONS = [0, 4, 8, 12]; // 16-way N/E/S/W

let nextEntityNumber = 1;
const entities = [];

function place(name, x, y, direction) {
  const entity = { entity_number: nextEntityNumber++, name, position: { x, y } };
  if (direction !== undefined && direction !== 0) entity.direction = direction;
  entities.push(entity);
  return entity;
}

// ---------- Section 1: every entity, every direction, in a grid ----------
// Skips belts (handled separately below, since a lone rotated belt tile
// tells you nothing about connection shape) and underground belts
// (need an in/out pair, also handled separately).
const allEntityNames = [
  ...Object.keys(gameData.machines),
  ...Object.keys(gameData.beacons),
  ...Object.keys(gameData.inserters),
  ...Object.keys(catalog.entities),
].filter((name, i, arr) => arr.indexOf(name) === i); // de-dupe (catalog entries can overlap GameData names)

const SKIP_IN_GRID = new Set([
  ...Object.keys(gameData.belts),
  ...Object.keys(catalog.entities).filter((n) => n.includes("underground-belt")),
]);

function footprintOf(name) {
  const m = gameData.machines[name];
  if (m) return m.tileFootprint ?? m.size ?? [1, 1];
  const b = gameData.beacons[name];
  if (b) return b.size ?? [1, 1];
  if (gameData.inserters[name]) return [1, 1];
  const c = catalog.entities[name];
  if (c) return c.tileFootprint ?? [1, 1];
  return [1, 1];
}

// Most buildings render the exact same sprite regardless of their placed
// direction in this tool (confirmed against real game footage: only poles,
// underground belts, radar, and rail signals carry a real directionCount>1
// sheet in the extracted data — chemical-plant/oil-refinery/pump etc. DO
// rotate in the real game, but this pipeline deliberately collapses them to
// a single static "north" frame, see dump-to-gamedata.ts's own doc comment
// on graphicsForCraftingMachine). Placing 4 identical-looking copies of one
// of those wastes grid space and tells you nothing a single copy doesn't —
// so only entities with a genuine per-direction sheet (or inserters, which
// are procedurally drawn and always rotate) get the full 4-direction
// treatment; everything else gets placed once, at direction 0.
function hasDistinctRotation(name) {
  if (gameData.inserters[name]) return true;
  const graphics = gameData.machines[name]?.graphics ?? gameData.beacons[name]?.graphics ?? catalog.entities[name]?.graphics;
  return (graphics?.directionCount ?? 1) > 1;
}

// The 4 rotations of one entity sit right next to each other (1 tile gap,
// not a fixed oversized cell) — per the user's own feedback, same-entity
// rotations don't need belt-strand-style spacing between them. Rows are
// packed by actual footprint size (largest first) so a 1x1 entity's row
// isn't stretched to fit a 7x7 neighbor elsewhere in the grid — each row's
// height is just that row's own tallest entity.
const gridEntries = allEntityNames.filter((n) => !SKIP_IN_GRID.has(n));
gridEntries.sort((a, b) => {
  const [aw, ah] = footprintOf(a);
  const [bw, bh] = footprintOf(b);
  return aw * ah - bw * bh;
});

const GRID_COLUMNS = 10;
const ROTATION_GAP = 1;
const ROW_GAP = 2;
let col = 0;
let rowY = 0;
let rowHeight = 0;
let colX = 0;

for (const name of gridEntries) {
  const [fw, fh] = footprintOf(name);
  const directions = hasDistinctRotation(name) ? DIRECTIONS : [0];
  const rowWidth = (fw + ROTATION_GAP) * directions.length - ROTATION_GAP;
  if (col >= GRID_COLUMNS) {
    col = 0;
    colX = 0;
    rowY += rowHeight + ROW_GAP;
    rowHeight = 0;
  }
  directions.forEach((dir, i) => {
    place(name, colX + i * (fw + ROTATION_GAP), rowY, dir);
  });
  colX += rowWidth + ROW_GAP * 2;
  rowHeight = Math.max(rowHeight, fh);
  col++;
}

let cursorY = rowY + rowHeight + 10;

// ---------- Section 2: underground belt in/out pairs, every direction ----------
const undergroundNames = Object.keys(catalog.entities).filter((n) => n.includes("underground-belt"));
{
  let x = 0;
  for (const name of undergroundNames) {
    DIRECTIONS.forEach((dir) => {
      const outE = place(name, x, cursorY, dir);
      outE.type = "output";
      const inE = place(name, x + 3, cursorY, dir);
      inE.type = "input";
      x += 6;
    });
    x += 4;
  }
  cursorY += 6;
}

// ---------- Section 3: belts — straight runs in all 4 directions ----------
const beltNames = Object.keys(gameData.belts);
{
  let x = 0;
  for (const name of beltNames) {
    DIRECTIONS.forEach((dir) => {
      // A 5-tile straight run so the middle tiles show the "fully fed"
      // straight frame, not just an unfed end tile.
      const [dx, dy] = dir === 0 ? [0, -1] : dir === 4 ? [1, 0] : dir === 8 ? [0, 1] : [-1, 0];
      for (let i = 0; i < 5; i++) {
        place(name, x + dx * i, cursorY + dy * i + 10, dir);
      }
      x += 7;
    });
    x += 3;
  }
  cursorY += 22;
}

// ---------- Section 4: belt curves — every fromDirection x toDirection turn ----------
// A curve is a belt at `to` direction fed from a perpendicular neighbor.
// Enumerates all 4 "turn into this cardinal from the left" and "from the
// right" combinations using one representative belt tier.
{
  const tier = beltNames[beltNames.length - 1] ?? beltNames[0]; // fastest tier, most visually distinct
  let x = 0;
  const offsetFor = (dir) => (dir === 0 ? [0, -1] : dir === 4 ? [1, 0] : dir === 8 ? [0, 1] : [-1, 0]);
  const leftOf = (dir) => (dir + 12) % 16;
  const rightOf = (dir) => (dir + 4) % 16;
  for (const to of DIRECTIONS) {
    for (const side of [leftOf(to), rightOf(to)]) {
      // Feeder belt sits one tile in the `side` direction from the corner
      // tile, facing opposite(side) so it feeds INTO the corner.
      const [fdx, fdy] = offsetFor(side);
      const feederDir = (side + 8) % 16;
      place(tier, x + fdx, cursorY + fdy, feederDir);
      place(tier, x, cursorY, to);
      // One more tile downstream so the curve isn't a dead end (matches a
      // real curve's usual context).
      const [tdx, tdy] = offsetFor(to);
      place(tier, x + tdx, cursorY + tdy, to);
      x += 4;
    }
    x += 2;
  }
  cursorY += 6;
}

// ---------- Section 5: T-merge (side-load) — two perpendicular feeders into one straight run ----------
{
  const tier = beltNames[beltNames.length - 1] ?? beltNames[0];
  let x = 0;
  for (const to of DIRECTIONS) {
    const offsetFor = (dir) => (dir === 0 ? [0, -1] : dir === 4 ? [1, 0] : dir === 8 ? [0, 1] : [-1, 0]);
    const leftOf = (dir) => (dir + 12) % 16;
    const rightOf = (dir) => (dir + 4) % 16;
    const behind = (dir) => (dir + 8) % 16;
    // Straight-behind feeder (makes this a side-load, not a plain curve).
    const [bdx, bdy] = offsetFor(behind(to));
    place(tier, x + bdx, cursorY + bdy, to);
    place(tier, x, cursorY, to);
    // One side feeder.
    const [ldx, ldy] = offsetFor(leftOf(to));
    place(tier, x + ldx, cursorY + ldy, (leftOf(to) + 8) % 16);
    // Downstream continuation.
    const [tdx, tdy] = offsetFor(to);
    place(tier, x + tdx, cursorY + tdy, to);
    x += 5;
  }
  cursorY += 6;
}

const blueprint = {
  item: "blueprint",
  label: "Rotation + connection sweep",
  entities,
  version: 562949956435968,
};

const deflated = deflateSync(JSON.stringify({ blueprint }), { level: 9 });
const encoded = "0" + deflated.toString("base64");
const rotatableCount = gridEntries.filter(hasDistinctRotation).length;
console.error(
  `Generated ${entities.length} entities across ${gridEntries.length} prototypes ` +
    `(${rotatableCount} with a genuine per-direction sprite, shown in all 4 directions; ` +
    `${gridEntries.length - rotatableCount} shown once — no distinct rotation model in this tool) ` +
    `+ belt/underground connection cases.`,
);
console.log(encoded);
