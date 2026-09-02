/** Regenerates packages/engine/src/data/debug-lab.ts's DEBUG_BLUEPRINT
 *  string. Decodes the blueprint currently baked into that file, appends
 *  (or replaces, if already present) named connection-shape test suites in
 *  free space below the existing layout, then re-encodes and writes the
 *  file back out.
 *
 *  Run with: npm run build-debug-lab --workspace=@factoriotools/data-pipeline
 *
 *  Per the file's own doc comment, DEBUG_BLUEPRINT is meant to grow: when a
 *  render bug is found and fixed, add a new suite function here (or extend
 *  an existing one) rather than hand-editing the base64 string directly. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decodeBlueprintString,
  encodeBlueprintString,
  normaliseEntities,
  denormaliseEntities,
} from "@factoriotools/engine";
import type { Blueprint, PlacedEntity } from "@factoriotools/engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_LAB_PATH = join(__dirname, "../../engine/src/data/debug-lab.ts");

const N = 0, E = 4, S = 8, W = 12;

/** One entity at (x,y) with the given name/direction — entity_number is
 *  assigned later, once, across the whole merged layout. */
interface Spec {
  name: string;
  x: number;
  y: number;
  direction?: number;
}

function wall(x: number, y: number): Spec {
  return { name: "stone-wall", x, y };
}
function belt(x: number, y: number, direction: number): Spec {
  return { name: "transport-belt", x, y, direction };
}
function pipe(x: number, y: number): Spec {
  return { name: "pipe", x, y };
}
function pipeToGround(x: number, y: number, direction: number): Spec {
  return { name: "pipe-to-ground", x, y, direction };
}

/** A labeled block of specs, placed with its own top-left origin — each
 *  suite below returns a list of these so the caller can lay them out in a
 *  simple flowing grid without every suite needing to know its neighbors'
 *  extents. */
interface Block {
  label: string;
  width: number;
  height: number;
  specs: (originX: number, originY: number) => Spec[];
}

/** Straight run, all 4 corners, all 4 T-junctions, and the cross — the
 *  same 9-shape suite used to verify wallGraph.ts's MASK_TO_WALL_SPRITE
 *  live in-app (see the "Wall sprites never rotate" project memory). Each
 *  group is a plus-shaped cluster of up to 5 walls (a center plus whichever
 *  neighbors the shape needs), spaced 4 tiles apart so shadows don't
 *  overlap between groups. */
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

/** Same 9-shape neighbor suite as wallConnectionSuite, but for plain pipes
 *  — pipes have a real dedicated sprite for all 16 neighbor bitmasks (see
 *  pipeGraph.ts's MASK_TO_VARIANT), so this exists mainly to catch
 *  regressions rather than to hunt for missing-sprite fallbacks. */
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

/** Underground pipe (pipe-to-ground) connection suite: for each of the 4
 *  facings, (a) a single underground with a plain pipe butted against its
 *  open side, to verify the open side faces the right way and visibly
 *  connects (the open side is the SAME as the entity's own facing — see
 *  pipeToGroundOpenSide's own doc comment in pipeGraph.ts, ported from the
 *  reference renderer and confirmed live in-app), and (b) a pair of
 *  undergrounds each facing outward (away from each other, toward their
 *  own plain-pipe neighbor) across a gap, matching how the real game
 *  actually uses them to duck underneath other entities. */
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
        // (a) single underground + a plain pipe on its open side (the SAME
        // side as `dir`, per pipeToGroundOpenSide).
        const [odx, ody] = offsets[dir]!;
        const singleY = originY + 1;
        specs.push(pipeToGround(cx, singleY, dir));
        specs.push(pipe(cx + odx, singleY + ody));

        // (b) two undergrounds forming one continuous underground run
        // across a 1-tile gap (the shortest possible run) — entity 1's
        // open side (== its own `dir`) must face entity 2, and entity 2's
        // open side must face back toward entity 1, so each one's facing
        // points INTO the gap between them, not away from it.
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

/** Belt start/end cap suite: for N and E facings (enough to catch a
 *  direction-mapping mistake without needing all 4), (a) an isolated
 *  single belt tile (both a start AND an end cap, per the "walls dont
 *  connect"-style bug report this suite exists to catch — see
 *  [[feedback_verify_sprite_reads_in_app]]'s belt-rows-12-19 entry) and
 *  (b) a 3-tile run, where only the first tile should show a start cap
 *  and only the last should show an end cap, with the middle tile plain. */
function beltCapSuite(): Block {
  const dirs = [N, E];
  const colWidth = 3;
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
      });
      return specs;
    },
  };
}

/** Lays out a list of blocks left-to-right in a single row, `gap` tiles
 *  apart, starting at (startX, startY). Returns every spec from every
 *  block with an absolute position. */
function layoutRow(blocks: Block[], startX: number, startY: number, gap: number): Spec[] {
  const specs: Spec[] = [];
  let x = startX;
  for (const block of blocks) {
    specs.push(...block.specs(x, startY));
    x += block.width + gap;
  }
  return specs;
}

function main(): void {
  const source = readFileSync(DEBUG_LAB_PATH, "utf8");
  const match = source.match(/"(0eNq[^"]+)"/);
  if (!match) throw new Error(`Couldn't find a blueprint string in ${DEBUG_LAB_PATH}`);
  const envelope = decodeBlueprintString(match[1]!);
  if (!envelope.blueprint) throw new Error("DEBUG_BLUEPRINT's envelope has no top-level blueprint");
  const existing = normaliseEntities(envelope.blueprint);

  // Drop any previously-generated connection-suite entities (recognised by
  // y >= FLOOR_Y) before re-adding them, so re-running this script updates
  // the suites in place instead of duplicating them on every run.
  const FLOOR_Y = 2000;
  const kept = existing.filter((e) => e.y < FLOOR_Y);

  const newSpecs = layoutRow(
    [wallConnectionSuite(), pipeConnectionSuite(), undergroundPipeSuite(), beltCapSuite()],
    -744.5, // matches the existing layout's own left edge
    FLOOR_Y,
    6,
  );

  let nextNumber = 1;
  const merged: PlacedEntity[] = [...kept, ...newSpecs].map((e) => ({
    entityNumber: nextNumber++,
    name: e.name,
    x: e.x,
    y: e.y,
    direction: e.direction ?? 0,
    quality: "normal",
    modules: [],
    filterItems: [],
  }));

  const blueprint: Blueprint = {
    item: envelope.blueprint.item,
    label: envelope.blueprint.label,
    version: envelope.blueprint.version,
    entities: denormaliseEntities(merged),
  };
  const newString = encodeBlueprintString({ blueprint });

  const output = source.replace(match[0], `"${newString}"`);
  writeFileSync(DEBUG_LAB_PATH, output);
  console.log(`Wrote ${DEBUG_LAB_PATH} — ${merged.length} entities (${kept.length} kept, ${newSpecs.length} generated).`);
}

main();
