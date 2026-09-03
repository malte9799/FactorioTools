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
function loader(x: number, y: number, direction: number, type: "input" | "output"): Spec {
  return { name: "loader", x, y, direction, undergroundType: type };
}
function splitter(x: number, y: number, direction: number): Spec {
  return { name: "splitter", x, y, direction };
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

/** Rotates a relative (dx,dy) offset — expressed for a North-facing
 *  reference case — to match `dir`, and the facing that goes with it (also
 *  expressed for North, then rotated the same way). Lets every belt-state
 *  block below be written once, for North, and reused for all four facings
 *  instead of a hand-derived per-direction table. */
function rotate(dx: number, dy: number, dir: number): { dx: number; dy: number } {
  const turns = dir / 4; // 0..3 quarter-turns
  let x = dx, y = dy;
  for (let i = 0; i < turns; i++) [x, y] = [-y, x];
  return { dx: x, dy: y };
}
function rotateDir(baseDir: number, dir: number): number {
  return (baseDir + dir) % 16;
}

/** Every belt-family neighbour-classification state, one column per
 *  facing, grouped in rows: transport-belt shapes, splitter lane feeds,
 *  underground mouths (plain/side-loaded/a real paired run), and loader
 *  input/output. Each state is built for North and rotated into place, so
 *  all four facings exercise the exact same relative geometry. */
function beltStateSuite(): Block {
  const dirs = [N, E, S, W];

  /** Places `name` at `(cx,cy)` shifted by (dx,dy) rotated for `dir`, facing
   *  `baseFacing` rotated the same way. */
  const at = (
    specs: Spec[],
    name: "belt" | "underground-in" | "underground-out" | "splitter",
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    baseFacing: number,
    dir: number,
  ): void => {
    const p = rotate(dx, dy, dir);
    const facing = rotateDir(baseFacing, dir);
    const x = cx + p.dx, y = cy + p.dy;
    if (name === "belt") specs.push(belt(x, y, facing));
    else if (name === "underground-in") specs.push(underground(x, y, facing, "input"));
    else if (name === "underground-out") specs.push(underground(x, y, facing, "output"));
    else specs.push(splitter(x, y, facing));
  };

  // ---- transport-belt states (built for North, i.e. baseFacing N) ----
  const beltStates: { label: string; height: number; build: (specs: Spec[], cx: number, cy: number, dir: number) => void }[] = [
    {
      label: "isolated",
      height: 3,
      build: (specs, cx, cy, dir) => at(specs, "belt", cx, cy, 0, 1, N, dir),
    },
    {
      label: "straight run",
      height: 5,
      build: (specs, cx, cy, dir) => {
        for (let j = -1; j <= 1; j++) at(specs, "belt", cx, cy, 0, 1 + j, N, dir);
      },
    },
    {
      label: "curve, fed left",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, "belt", cx, cy, 0, 1, N, dir); // the curve itself
        at(specs, "belt", cx, cy, -1, 1, E, dir); // west neighbour, facing east into it
      },
    },
    {
      label: "curve, fed right",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, "belt", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, 1, 1, W, dir); // east neighbour, facing west into it
      },
    },
    {
      label: "curve, continues",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // A right-hand curve feeding a straight belt ahead of it — checks
        // the curve's own end draws no cap once something continues past
        // it, the same as a straight run's own interior tiles don't.
        at(specs, "belt", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, 1, 1, W, dir);
        at(specs, "belt", cx, cy, 0, -1, N, dir);
      },
    },
    {
      label: "T-merge",
      height: 5,
      build: (specs, cx, cy, dir) => {
        for (let j = -1; j <= 1; j++) at(specs, "belt", cx, cy, 0, 1 + j, N, dir);
        at(specs, "belt", cx, cy, -1, 1, E, dir); // side feed into the middle tile
      },
    },
    {
      label: "side-load only",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // A 3-belt row (facing = baseFacing rotated + right-angle, drawn as
        // West for North's own reference case) with a belt dropping onto
        // its centre from the side that row doesn't actually feed from.
        for (let j = -1; j <= 1; j++) at(specs, "belt", cx, cy, j, 1, E, dir);
        at(specs, "belt", cx, cy, 0, 0, S, dir);
      },
    },
  ];

  // ---- splitter lane-feed states ----
  const splitterStates: { label: string; height: number; build: (specs: Spec[], cx: number, cy: number, dir: number) => void }[] = [
    {
      label: "splitter, open",
      height: 3,
      build: (specs, cx, cy, dir) => at(specs, "splitter", cx, cy, 0, 1, N, dir),
    },
    {
      label: "splitter, both fed",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // Splitter faces North (exits north), so its input side — and the
        // lane feeds' own position — is behind it, one tile further south.
        at(specs, "splitter", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, -0.5, 2, N, dir);
        at(specs, "belt", cx, cy, 0.5, 2, N, dir);
      },
    },
    {
      label: "splitter, one lane fed",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, "splitter", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, -0.5, 2, N, dir);
      },
    },
  ];

  // ---- underground mouth states ----
  const undergroundStates: { label: string; height: number; build: (specs: Spec[], cx: number, cy: number, dir: number) => void }[] = [
    {
      label: "entrance, plain",
      height: 3,
      build: (specs, cx, cy, dir) => at(specs, "underground-in", cx, cy, 0, 1, N, dir),
    },
    {
      label: "exit, plain",
      height: 3,
      build: (specs, cx, cy, dir) => at(specs, "underground-out", cx, cy, 0, 1, N, dir),
    },
    {
      label: "entrance, side-loaded",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, "underground-in", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, -1, 1, E, dir);
      },
    },
    {
      label: "exit, side-loaded",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, "underground-out", cx, cy, 0, 1, N, dir);
        at(specs, "belt", cx, cy, -1, 1, E, dir);
      },
    },
    {
      label: "paired run",
      height: 5,
      build: (specs, cx, cy, dir) => {
        at(specs, "underground-in", cx, cy, 0, 2, N, dir);
        at(specs, "underground-out", cx, cy, 0, 0, N, dir);
      },
    },
  ];

  // ---- loader states ----
  const loaderStates: { label: string; height: number; build: (specs: Spec[], cx: number, cy: number, dir: number) => void }[] = [
    {
      label: "loader, input",
      height: 3,
      build: (specs, cx, cy, dir) => {
        const p = rotate(0, 1, dir);
        specs.push(loader(cx + p.dx, cy + p.dy, rotateDir(N, dir), "input"));
      },
    },
    {
      label: "loader, output",
      height: 3,
      build: (specs, cx, cy, dir) => {
        const p = rotate(0, 1, dir);
        specs.push(loader(cx + p.dx, cy + p.dy, rotateDir(N, dir), "output"));
      },
    },
  ];

  const allStates = [...beltStates, ...splitterStates, ...undergroundStates, ...loaderStates];
  const colWidth = 4;
  const rowHeight = Math.max(...allStates.map((s) => s.height)) + 1;

  return {
    label: "belt-family neighbour states",
    width: dirs.length * colWidth,
    height: allStates.length * rowHeight,
    specs: (originX, originY) => {
      const specs: Spec[] = [];
      allStates.forEach((state, row) => {
        const cy = originY + row * rowHeight + 2;
        dirs.forEach((dir, col) => {
          const cx = originX + col * colWidth + 1;
          state.build(specs, cx, cy, dir);
        });
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

/** Lays out blocks left to right, wrapping onto a new row once `maxWidth`
 *  would be exceeded — for a suite with more blocks than comfortably fit
 *  in one line. Each row's height is its tallest block. */
function layoutGrid(blocks: Block[], startX: number, startY: number, gap: number, maxWidth: number): Spec[] {
  const specs: Spec[] = [];
  let x = startX;
  let y = startY;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x !== startX && x + block.width > startX + maxWidth) {
      x = startX;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    specs.push(...block.specs(x, y));
    x += block.width + gap;
    rowHeight = Math.max(rowHeight, block.height);
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
  const smallSuites = layoutRow(
    [wallConnectionSuite(), pipeConnectionSuite(), undergroundPipeSuite()],
    0,
    suitesY,
    6,
  );
  const beltSuiteY = Math.max(...smallSuites.map((s) => s.y)) + 8;
  const suites = [...smallSuites, ...layoutGrid([beltStateSuite()], 0, beltSuiteY, 6, 400)];

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
