/**
 * Regression tests for the animation half of the scene cache.
 *
 * render.ts no longer re-collects the scene every frame; it collects once and
 * patches each animated command's `sx` from a probed profile. Two properties
 * have to hold for that patch to produce the same pixels the old per-frame
 * collect did, and both were broken by the caching work:
 *
 *   1. A turbo belt's odd-parity tile starts half a sheet into its own row,
 *      so it wraps PARTWAY through its cycle. A model that only accepts a
 *      straight base + frame*stride ramp rejects it, and the tile then never
 *      animates at all — the checkerboard offset reads as "every other belt
 *      is frozen".
 *
 *   2. Every sx a command is patched to must land on a cell the sheet
 *      actually holds. Addressing past the last column samples empty pixels,
 *      which is what a splitter's flicker was: an occasional blank frame.
 *
 * Both are asserted against the real collect path and the real sprite data.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { PlacedEntity } from "@factoriotools/engine";
import { requireDataset, DATA_DIR } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../src/entityLookup.js";
import { buildGrid } from "../src/neighbours/grid.js";
import { buildFluidNetwork } from "../src/neighbours/fluid.js";
import { buildHeatNetwork } from "../src/neighbours/heat.js";
import { collectEntity } from "../src/draw/collect.js";
import type { DrawCommand } from "../src/draw/commands.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

// Also needs the extracted sprite sheets, not just the JSON — it reads PNG
// headers to check that no frame addresses past the end of its sheet.
const { gameData, catalog } = requireDataset("beltAnimation", true);
const PUBLIC = DATA_DIR;
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

function entity(name: string, x: number, y: number, direction = 0): PlacedEntity {
  return {
    entityNumber: Math.round(Math.abs(x) * 977 + Math.abs(y) * 131 + direction) + 1,
    name, x, y, direction, quality: "normal", modules: [], filterItems: [],
  } as unknown as PlacedEntity;
}

/** Collects `self` at one animation frame, with `others` as its neighbours. */
function collect(self: PlacedEntity, others: PlacedEntity[], frame: number): DrawCommand[] {
  const all = [self, ...others];
  const ctx = {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, (e as { recipe?: string }).recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    platformBoxes: all.map((e) => ({ entityNumber: e.entityNumber, left: e.x - 1.5, top: e.y - 1.5, right: e.x + 1.5, bottom: e.y + 1.5 })),
    animationFrame: frame,
  };
  const out: DrawCommand[] = [];
  const visual = lookup.get(self.name);
  if (!visual?.graphics) return out;
  collectEntity(out, self, visual, ctx as never, 1);
  return out;
}

/** Width in pixels of every sheet the tests touch, read from the PNG header. */
const SHEET_DIR = path.join(PUBLIC, "sprites/entities");
const sheetWidth = new Map<string, number>();
function widthOf(sheet: string): number | undefined {
  const base = path.basename(sheet);
  if (sheetWidth.has(base)) return sheetWidth.get(base);
  const file = path.join(SHEET_DIR, base);
  if (!existsSync(file)) { sheetWidth.set(base, 0); return 0; }
  const header = readFileSync(file).subarray(0, 32);
  const w = header.readUInt32BE(16);
  sheetWidth.set(base, w);
  return w;
}

/* ---------- 1. A turbo belt's two parities actually differ, and both move ---------- */
// The checkerboard offset is the whole point of the turbo belt's look: with
// every tile in lockstep the run strobes instead of showing items advancing.

test("turbo belt: alternate tiles run half a cycle apart", () => {
  // Two adjacent tiles of one straight run — opposite parities by definition.
  const run = [entity("turbo-transport-belt", 0.5, 0.5), entity("turbo-transport-belt", 1.5, 0.5),
               entity("turbo-transport-belt", 2.5, 0.5), entity("turbo-transport-belt", 3.5, 0.5)];
  const even = collect(run[1]!, run, 0);
  const odd = collect(run[2]!, run, 0);
  const evenBody = even.find((c) => c.sheet.includes("turbo-transport-belt"));
  const oddBody = odd.find((c) => c.sheet.includes("turbo-transport-belt"));
  assert.ok(evenBody && oddBody, "both tiles draw a belt body");
  assert.notEqual(evenBody!.sx, oddBody!.sx, "adjacent turbo tiles must not share an animation phase");
});

test("turbo belt: the odd-parity tile advances across the whole cycle", () => {
  const run = [entity("turbo-transport-belt", 0.5, 0.5), entity("turbo-transport-belt", 1.5, 0.5),
               entity("turbo-transport-belt", 2.5, 0.5), entity("turbo-transport-belt", 3.5, 0.5)];
  const seen = new Set<number>();
  for (let frame = 0; frame < 64; frame++) {
    const body = collect(run[2]!, run, frame).find((c) => c.sheet.includes("turbo-transport-belt"));
    assert.ok(body, "belt body present");
    seen.add(body!.sx);
  }
  // A frozen tile would show exactly one. The sheet is 64 columns wide and
  // a turbo belt steps four of them a tick, so its cycle shows 16.
  assert.equal(seen.size, 16, "odd-parity turbo tile must visit every frame of its cycle");
});

/* ---------- Each tier animates at its own belt speed ---------- */
// The game advances a belt's sheet `speed * 32` frames a tick — one for a
// yellow belt, two red, three blue, four turbo. Every tier stepping one
// column a tick made the faster belts look slower than they move.

test("each belt tier advances speed * 32 columns a tick", () => {
  const expected: Record<string, number> = {
    "transport-belt": 1, "fast-transport-belt": 2, "express-transport-belt": 3, "turbo-transport-belt": 4,
    "underground-belt": 1, "fast-underground-belt": 2, "express-underground-belt": 3, "turbo-underground-belt": 4,
    "splitter": 1, "fast-splitter": 2, "express-splitter": 3, "turbo-splitter": 4,
  };
  for (const [name, step] of Object.entries(expected)) {
    const visual = lookup.get(name);
    if (!visual?.graphics) continue;
    const lane = visual.graphics.layers.find((l) => l.column?.by === "animation");
    assert.ok(lane, `${name} has an animated lane`);
    const sprites = lane!.sprites as { frameWidth?: number; north?: { frameWidth: number } };
    const width = sprites.frameWidth ?? sprites.north!.frameWidth;
    const self = entity(name, 0.5, 0.5);
    const lanesAt = (frame: number) => collect(self, [], frame).filter((c) => /transport-belt\.png$/.test(c.sheet));
    const a = lanesAt(0);
    const b = lanesAt(1);
    assert.ok(a.length > 0 && a.length === b.length, `${name} draws its lane`);
    for (let k = 0; k < a.length; k++) {
      assert.equal(b[k]!.sx - a[k]!.sx, step * width, `${name} lane ${k} must step ${step} column(s) a tick`);
    }
  }
});

test("turbo belt: both parities visit the SAME set of cells, only in a different order", () => {
  const run = [entity("turbo-transport-belt", 0.5, 0.5), entity("turbo-transport-belt", 1.5, 0.5),
               entity("turbo-transport-belt", 2.5, 0.5), entity("turbo-transport-belt", 3.5, 0.5)];
  const cellsOf = (e: PlacedEntity) => {
    const s = new Set<number>();
    for (let frame = 0; frame < 64; frame++) {
      const body = collect(e, run, frame).find((c) => c.sheet.includes("turbo-transport-belt"));
      if (body) s.add(body.sx);
    }
    return [...s].sort((a, b) => a - b);
  };
  assert.deepEqual(cellsOf(run[1]!), cellsOf(run[2]!),
    "a phase offset must reorder frames, never move the tile onto different art");
});

/* ---------- 2. No animated command may ever address past its sheet ---------- */
// This is the splitter flicker's actual signature. A blank frame means some
// sx landed on a column the sheet does not have.

const BELT_KINDS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"];
const SPLITTERS = ["splitter", "fast-splitter", "express-splitter", "turbo-splitter"];

test("splitters never address a cell past the end of their sheet", () => {
  for (const name of SPLITTERS) {
    if (!lookup.get(name)?.graphics) continue;
    for (let direction = 0; direction < 16; direction += 4) {
      // Both the isolated case (draws end caps) and the mid-run case (does
      // not) — the two shapes whose command counts differ.
      const alone = [entity(name, 1, 0.5, direction)];
      const fed = [entity(name, 1, 0.5, direction),
                   entity("transport-belt", 0.5, -0.5, direction), entity("transport-belt", 1.5, -0.5, direction),
                   entity("transport-belt", 0.5, 1.5, direction), entity("transport-belt", 1.5, 1.5, direction)];
      for (const scene of [alone, fed]) {
        for (let frame = 0; frame < 64; frame++) {
          for (const c of collect(scene[0]!, scene, frame)) {
            const w = widthOf(c.sheet);
            if (!w) continue;
            assert.ok(c.sx >= 0 && c.sx + c.sw <= w,
              `${name} dir${direction} frame${frame}: sx ${c.sx}+${c.sw} exceeds ${path.basename(c.sheet)} width ${w}`);
          }
        }
      }
    }
  }
});

test("belts never address a cell past the end of their sheet", () => {
  for (const name of BELT_KINDS) {
    if (!lookup.get(name)?.graphics) continue;
    for (let direction = 0; direction < 16; direction += 4) {
      const run = [entity(name, 0.5, 0.5, direction), entity(name, 1.5, 0.5, direction),
                   entity(name, 2.5, 0.5, direction), entity(name, 3.5, 0.5, direction)];
      for (const self of run) {
        for (let frame = 0; frame < 64; frame++) {
          for (const c of collect(self, run, frame)) {
            const w = widthOf(c.sheet);
            if (!w) continue;
            assert.ok(c.sx >= 0 && c.sx + c.sw <= w,
              `${name} dir${direction} frame${frame}: sx ${c.sx}+${c.sw} exceeds ${path.basename(c.sheet)} width ${w}`);
          }
        }
      }
    }
  }
});

/* ---------- 3. Neighbours change a splitter's command COUNT ---------- */
// The invariant the scene cache's profile lookup depends on. If this ever
// stops being true the per-entity fallback in buildSceneCache is dead code;
// while it IS true, matching profiles by entity type alone is unsound.

test("a splitter's command count depends on its neighbours", () => {
  const alone = [entity("splitter", 1, 0.5, 0)];
  const fed = [entity("splitter", 1, 0.5, 0),
               entity("transport-belt", 0.5, 1.5, 0), entity("transport-belt", 1.5, 1.5, 0)];
  const a = collect(alone[0]!, alone, 0).length;
  const b = collect(fed[0]!, fed, 0).length;
  assert.notEqual(a, b,
    "expected caps to appear/disappear with neighbours — the scene cache's shape check relies on it");
});

console.log(`\n${passed} passed`);
