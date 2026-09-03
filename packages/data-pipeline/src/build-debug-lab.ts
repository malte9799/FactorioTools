/** Regenerates DEBUG_BLUEPRINT in packages/engine/src/data/debug-lab.ts: a
 *  catalogue of every renderable entity, grouped by type and sorted by size,
 *  plus the connection-shape suites that cover neighbour-aware art.
 *
 *  Run with: npm run build-debug-lab --workspace=@factoriotools/data-pipeline
 *
 *  Regenerate this whenever a render bug is found, so the fix keeps a
 *  standing check. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeBlueprintString, denormaliseEntities } from "@factoriotools/engine";
import type { Blueprint, EntityGraphics, GameData, PlacedEntity, RenderCatalog } from "@factoriotools/engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_LAB_PATH = join(__dirname, "../../engine/src/data/debug-lab.ts");
const DATA_DIR = join(__dirname, "../../../apps/site/public/data");

const N = 0, E = 4, S = 8, W = 12;
const DIRECTIONS = [N, E, S, W];

interface Spec {
  name: string;
  x: number;
  y: number;
  direction?: number;
  undergroundType?: "input" | "output";
}

function wall(x: number, y: number): Spec {
  return { name: "stone-wall", x, y };
}
function belt(x: number, y: number, direction: number): Spec {
  return { name: "transport-belt", x, y, direction };
}
function underground(x: number, y: number, direction: number, type: "input" | "output"): Spec {
  return { name: "underground-belt", x, y, direction, undergroundType: type };
}
function pipe(x: number, y: number): Spec {
  return { name: "pipe", x, y };
}
function pipeToGround(x: number, y: number, direction: number): Spec {
  return { name: "pipe-to-ground", x, y, direction };
}

/** A block of specs placed from its own top-left origin, so the caller can
 *  flow blocks without each knowing its neighbours' extents. */
interface Block {
  label: string;
  width: number;
  height: number;
  specs: (originX: number, originY: number) => Spec[];
}

/** Every wall connection shape: isolated, both straights, all four corners,
 *  all four T-junctions, and the cross. Each is a plus-shaped cluster of a
 *  centre wall plus whichever neighbours the shape needs. */
function wallConnectionSuite(): Block {
  const groups: { dirs: number[] }[] = [
    { dirs: [] }, // isolated single
    { dirs: [N, S] }, // straight vertical
    { dirs: [E, W] }, // straight horizontal
    { dirs: [N, E] }, // corner
    { dirs: [N, W] }, // corner
    { dirs: [S, E] }, // corner
    { dirs: [S, W] }, // corner
    { dirs: [N, E, W] }, // T missing south
    { dirs: [N, S, E] }, // T missing west
    { dirs: [S, E, W] }, // T missing north
    { dirs: [N, S, W] }, // T missing east
    { dirs: [N, E, S, W] }, // cross
  ];
  const offsets: Record<number, [number, number]> = {
    [N]: [0, -1],
    [E]: [1, 0],
    [S]: [0, 1],
    [W]: [-1, 0],
  };
  const spacing = 4;
  return {
    label: "wall connections",
    width: groups.length * spacing,
    height: 3,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      const cy = originY + 1;
      groups.forEach((g, i) => {
        const cx = originX + i * spacing + 1;
        specs.push(wall(cx, cy));
        for (const dir of g.dirs) {
          const [dx, dy] = offsets[dir]!;
          specs.push(wall(cx + dx, cy + dy));
        }
      });
      return specs;
    },
  };
}

/** The same shapes as the wall suite, for pipes. */
function pipeConnectionSuite(): Block {
  const groups: { dirs: number[] }[] = [
    { dirs: [] },
    { dirs: [N, S] },
    { dirs: [E, W] },
    { dirs: [N, E] },
    { dirs: [N, W] },
    { dirs: [S, E] },
    { dirs: [S, W] },
    { dirs: [N, E, W] },
    { dirs: [N, S, E] },
    { dirs: [S, E, W] },
    { dirs: [N, S, W] },
    { dirs: [N, E, S, W] },
  ];
  const offsets: Record<number, [number, number]> = {
    [N]: [0, -1],
    [E]: [1, 0],
    [S]: [0, 1],
    [W]: [-1, 0],
  };
  const spacing = 4;
  return {
    label: "pipe connections",
    width: groups.length * spacing,
    height: 3,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      const cy = originY + 1;
      groups.forEach((g, i) => {
        const cx = originX + i * spacing + 1;
        specs.push(pipe(cx, cy));
        for (const dir of g.dirs) {
          const [dx, dy] = offsets[dir]!;
          specs.push(pipe(cx + dx, cy + dy));
        }
      });
      return specs;
    },
  };
}

/** Per facing: an underground with a pipe against its open side, and a pair
 *  facing each other across a gap — one continuous underground run. */
function undergroundPipeSuite(): Block {
  const dirs = [N, E, S, W];
  const offsets: Record<number, [number, number]> = {
    [N]: [0, -1],
    [E]: [1, 0],
    [S]: [0, 1],
    [W]: [-1, 0],
  };
  const colWidth = 4;
  return {
    label: "underground pipe connections",
    width: dirs.length * colWidth,
    height: 8,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      dirs.forEach((dir, i) => {
        const cx = originX + i * colWidth + 1;
        // A pipe against the underground's open side, which is its facing.
        const [odx, ody] = offsets[dir]!;
        const singleY = originY + 1;
        specs.push(pipeToGround(cx, singleY, dir));
        specs.push(pipe(cx + odx, singleY + ody));

        // A pair facing into the gap between them: the shortest run.
        const pairY = originY + 4;
        const [ddx, ddy] = offsets[dir]!;
        const farDir = { [N]: S, [E]: W, [S]: N, [W]: E }[dir]!;
        specs.push(pipeToGround(cx, pairY, dir));
        specs.push(pipeToGround(cx + ddx * 2, pairY + ddy * 2, farDir));
      });
      return specs;
    },
  };
}

/** Per facing: a plain underground entrance, an entrance side-loaded by a
 *  belt (swaps to the direction_in_side_loading sprite), a plain exit, and
 *  an exit side-loaded the same way — checking both the plain mouth art and
 *  the side-loading swap on both ends. */
function undergroundBeltSideLoadSuite(): Block {
  const dirs = [N, E, S, W];
  // Each facing's left side, as a {step, facing a belt sitting there needs
  // to point back into the underground's mouth}.
  const leftFeed: Record<number, { dx: number; dy: number; faces: number }> = {
    [N]: { dx: -1, dy: 0, faces: E },
    [E]: { dx: 0, dy: -1, faces: S },
    [S]: { dx: 1, dy: 0, faces: W },
    [W]: { dx: 0, dy: 1, faces: N },
  };
  const colWidth = 3;
  return {
    label: "underground belt side-loading",
    width: dirs.length * colWidth,
    height: 8,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      dirs.forEach((dir, i) => {
        const cx = originX + i * colWidth + 1;
        const { dx, dy, faces } = leftFeed[dir]!;

        // Plain entrance, nothing feeding its side.
        specs.push(underground(cx, originY + 1, dir, "input"));

        // Entrance side-loaded: a belt facing into it from its left.
        const inY = originY + 3;
        specs.push(underground(cx, inY, dir, "input"));
        specs.push(belt(cx + dx, inY + dy, faces));

        // Plain exit.
        specs.push(underground(cx, originY + 5, dir, "output"));

        // Exit side-loaded the same way.
        const outY = originY + 7;
        specs.push(underground(cx, outY, dir, "output"));
        specs.push(belt(cx + dx, outY + dy, faces));
      });
      return specs;
    },
  };
}

/** An isolated belt (both caps), a 3-tile run (a cap at each end only), a
 *  right-hand curve (start cap on its side input), a T-merge (a side feed
 *  into a straight run, which draws as straight with no extra cap), and a
 *  side-load (a belt dropping onto the middle of an unrelated run from a
 *  direction that row doesn't actually draw its input from — the dropping
 *  belt still needs its own end cap, since the row underneath it isn't
 *  really connected) — for two facings. */
function beltCapSuite(): Block {
  const dirs = [N, E];
  const colWidth = 7;
  return {
    label: "belt start/end caps",
    width: dirs.length * colWidth,
    height: 6,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      dirs.forEach((dir, i) => {
        const cx = originX + i * colWidth;
        specs.push(belt(cx, originY + 1, dir));
        for (let j = 0; j < 3; j++) {
          specs.push(dir === N ? belt(cx, originY + 3 + j, dir) : belt(cx + j, originY + 3, dir));
        }
        // A right-hand curve: fed from its right (a belt one tile that way,
        // facing back into the curve tile — not just sitting adjacent to
        // it), bending to exit the way `dir` points.
        const curveX = cx + 2;
        if (dir === N) {
          specs.push(belt(curveX, originY, N));
          specs.push(belt(curveX + 1, originY, W)); // east of the curve, facing west into it
        } else {
          specs.push(belt(curveX, originY + 2, E));
          specs.push(belt(curveX, originY + 3, N)); // south of the curve, facing north into it
        }
        // A real T-merge: a straight feed from behind AND a side feed join
        // one tile, which continues straight with no extra cap at the
        // merge — and the segment above it, fed correctly from behind, gets
        // no cap either.
        const mergeX = cx + 4;
        if (dir === N) {
          specs.push(belt(mergeX, originY + 3, N));
          specs.push(belt(mergeX, originY + 2, N));
          specs.push(belt(mergeX, originY + 1, N));
          specs.push(belt(mergeX - 1, originY + 2, E));
        } else {
          specs.push(belt(mergeX - 3, originY + 5, E));
          specs.push(belt(mergeX - 2, originY + 5, E));
          specs.push(belt(mergeX - 1, originY + 5, E));
          specs.push(belt(mergeX - 2, originY + 4, S));
        }
        // A side-load: a 3-belt west-facing row, with a south-facing belt
        // dropping onto the centre tile from above. The row's own input
        // side is behind it (east), not north, so this isn't a real
        // connection — the dropping belt still needs its own end cap.
        const loadX = cx + 6;
        specs.push(belt(loadX, originY + 2, W));
        specs.push(belt(loadX - 1, originY + 2, W));
        specs.push(belt(loadX - 2, originY + 2, W));
        specs.push(belt(loadX - 1, originY, S));
        specs.push(belt(loadX - 1, originY + 1, S));
      });
      return specs;
    },
  };
}
/** Lays out a list of blocks left to right, `gap` tiles apart. */
function layoutRow(blocks: Block[], startX: number, startY: number, gap: number): Spec[] {
  const specs: Spec[] = [];
  let x = startX;
  for (const block of blocks) {
    specs.push(...block.specs(x, startY));
    x += block.width + gap;
  }
  return specs;
}

interface Entry {
  name: string;
  footprint: [number, number];
  rotates: boolean;
  group: string;
  subgroup: string;
  sortKey: string;
}

/** An entity rotates on screen if any of its layers picks art by facing. */
function rotates(graphics: EntityGraphics | undefined): boolean {
  for (const layer of graphics?.layers ?? []) {
    if ("per" in layer && (layer.per === "dir4" || layer.per === "dir8")) return true;
    if (layer.column?.by === "direction" || layer.row?.by === "direction") return true;
  }
  return false;
}

/** Every renderable entity, with the same GameData-wins precedence the
 *  renderer's own lookup uses. */
function collectEntries(data: GameData, catalog: RenderCatalog): Entry[] {
  const seen = new Map<string, Entry>();
  const menu = catalog.menuPositions;

  const add = (
    name: string,
    footprint: [number, number],
    graphics: EntityGraphics | undefined,
    alwaysRotates = false,
  ): void => {
    if (seen.has(name)) return;
    const pos = menu[name];
    seen.set(name, {
      name,
      footprint,
      rotates: alwaysRotates || rotates(graphics),
      group: pos?.group ?? "other",
      subgroup: pos?.subgroup ?? "other",
      sortKey: pos?.order ?? name,
    });
  };

  for (const m of Object.values(data.machines)) add(m.name, m.tileFootprint ?? m.size, m.graphics);
  for (const b of Object.values(data.beacons)) add(b.name, b.size, b.graphics);
  for (const b of Object.values(data.belts)) add(b.name, [1, 1], b.graphics);
  // Inserters are drawn procedurally, outside EntityGraphics, and always face.
  for (const i of Object.values(data.inserters)) add(i.name, [1, 1], undefined, true);
  for (const e of Object.values(catalog.entities)) add(e.name, e.tileFootprint, e.graphics);

  return [...seen.values()];
}

/** Internal duplicates of an entity that is already shown: the game gives
 *  them no build-menu slot, and they share another entity's art. */
const ALIASES = new Set(["red-chest", "blue-chest", "hidden-electric-energy-interface"]);

const GROUP_ORDER = ["logistics", "production", "intermediate-products", "space", "combat", "effects", "other"];

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

/** One row per subgroup, so related entities sit together: belts on one row,
 *  chests on another. Within a row, smallest footprint first, then the game's
 *  own menu order, so size progressions read left to right. */
function catalogueRows(entries: Entry[]): Entry[][] {
  const bySubgroup = new Map<string, Entry[]>();
  for (const e of entries) {
    if (ALIASES.has(e.name)) continue;
    const key = `${groupRank(e.group)}/${e.group}/${e.subgroup}`;
    const row = bySubgroup.get(key);
    if (row) row.push(e);
    else bySubgroup.set(key, [e]);
  }

  const area = (e: Entry) => e.footprint[0] * e.footprint[1];
  for (const row of bySubgroup.values()) {
    row.sort((a, b) => area(a) - area(b) || a.sortKey.localeCompare(b.sortKey));
  }
  return [...bySubgroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

/** Factorio centres an odd-sized footprint on a half tile and an even-sized
 *  one on a whole tile, so its edges always land on the grid. */
function snap(coord: number, size: number): number {
  return Math.round(size) % 2 === 1 ? Math.floor(coord) + 0.5 : Math.round(coord);
}

/** The catalogue proper: one row per subgroup, each entity shown once if it
 *  doesn't rotate and once per facing if it does. Entities share a row's top
 *  edge, and the next row clears the tallest span in this one. */
function catalogueSpecs(rows: Entry[][], originX: number, originY: number): Spec[] {
  const specs: Spec[] = [];
  const GAP = 1;
  const ROW_GAP = 3;
  let y = originY;

  for (const row of rows) {
    let rowSpan = 0;
    let x = originX;
    for (const entry of row) {
      const [w, h] = entry.footprint;
      for (const direction of entry.rotates ? DIRECTIONS : [N]) {
        // Rotating a non-square entity swaps which axis its size spans.
        const turned = direction === E || direction === W;
        const spanX = turned ? h : w;
        const spanY = turned ? w : h;
        specs.push({
          name: entry.name,
          x: snap(x + spanX / 2, spanX),
          y: snap(y + spanY / 2, spanY),
          direction,
        });
        x += spanX + GAP;
        rowSpan = Math.max(rowSpan, spanY);
      }
      x += GAP;
    }
    y += rowSpan + ROW_GAP;
  }
  return specs;
}
function main(): void {
  const data = JSON.parse(readFileSync(join(DATA_DIR, "game-data.json"), "utf8")) as GameData;
  const catalog = JSON.parse(readFileSync(join(DATA_DIR, "render-catalog.json"), "utf8")) as RenderCatalog;

  const entries = collectEntries(data, catalog);
  const rows = catalogueRows(entries);
  const catalogue = catalogueSpecs(rows, 0, 0);

  // Connection suites sit below the catalogue, clear of its tallest row.
  const suitesY = Math.max(...catalogue.map((s) => s.y)) + 8;
  const suites = layoutRow(
    [wallConnectionSuite(), pipeConnectionSuite(), undergroundPipeSuite(), beltCapSuite(), undergroundBeltSideLoadSuite()],
    0,
    suitesY,
    6,
  );

  let nextNumber = 1;
  const merged: PlacedEntity[] = [...catalogue, ...suites].map((e) => ({
    entityNumber: nextNumber++,
    name: e.name,
    x: e.x,
    y: e.y,
    direction: e.direction ?? 0,
    quality: "normal",
    modules: [],
    filterItems: [],
    undergroundType: e.undergroundType,
  }));

  const blueprint: Blueprint = {
    item: "blueprint",
    label: "Renderer debug lab",
    version: 562949956632576,
    entities: denormaliseEntities(merged),
  };

  const source = readFileSync(DEBUG_LAB_PATH, "utf8");
  const match = source.match(/"(0eNq[^"]+)"/);
  if (!match) throw new Error(`Couldn't find a blueprint string in ${DEBUG_LAB_PATH}`);
  writeFileSync(DEBUG_LAB_PATH, source.replace(match[0], `"${encodeBlueprintString({ blueprint })}"`));

  const shown = new Set(catalogue.map((s) => s.name)).size;
  console.log(
    `Wrote ${DEBUG_LAB_PATH} — ${merged.length} entities: ` +
      `${shown} kinds in ${rows.length} rows, ${suites.length} in connection suites.`,
  );
}

main();
