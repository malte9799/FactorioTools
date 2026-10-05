/**
 * The scene cache's animation profiles (draw/animProfile.ts).
 *
 * A scene is collected once at frame 0; each frame only patches the sx of the
 * commands a profile says animate. A profile is probed — the entity collected
 * up to MAX_ANIM_PERIOD + 1 times — once per entity type, and an entity whose
 * neighbours change how many commands it draws (a belt with or without end
 * caps, a machine with its pipe covers) needs its own. Those used to be
 * re-probed on every scene rebuild, every pan and every hover, which made a
 * blueprint full of belt shapes take seconds per frame. They are now pieced
 * together from the sprites earlier probes measured.
 *
 * What has to hold: the profile handed out for every entity is the one
 * probing that very entity would give, and rebuilding a scene probes nothing.
 */
import assert from "node:assert/strict";
import type { PlacedEntity } from "@factoriotools/engine";
import { requireDataset } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } from "../src/entityLookup.js";
import { buildGrid } from "../src/neighbours/grid.js";
import { buildFluidNetwork } from "../src/neighbours/fluid.js";
import { buildHeatNetwork } from "../src/neighbours/heat.js";
import { buildCargoBayGrid } from "../src/neighbours/cargoBay.js";
import { collectEntity, type CollectContext } from "../src/draw/collect.js";
import type { DrawCommand } from "../src/draw/commands.js";
import { AnimProfileCache, type AnimProfile } from "../src/draw/animProfile.js";

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

const { gameData, catalog } = requireDataset("animProfile");
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

const N = 0, E = 4, S = 8, W = 12;

function entity(entityNumber: number, name: string, x: number, y: number, direction = N, recipe?: string): PlacedEntity {
  return { entityNumber, name, x, y, direction, quality: "normal", modules: [], filterItems: [], recipe };
}

/** Belt shapes built facing north, as [dx, dy, facing]: each makes the
 *  same belt type draw a different number of commands. */
const SHAPES: [number, number, number][][] = [
  [[0, 0, N]], // alone: both end caps
  [[0, 1, N], [0, 0, N], [0, -1, N]], // a run: start cap, none, end cap
  [[0, 0, N], [-1, 0, E]], // a curve fed from the left
  [[0, 0, N], [1, 0, W]], // a curve fed from the right
  [[-1, 0, E], [0, 0, E], [1, 0, E], [0, -1, S]], // side-loading a run
];

function turn(dx: number, dy: number, direction: number): [number, number] {
  let x = dx, y = dy;
  for (let i = 0; i < direction / 4; i++) [x, y] = [-y, x];
  return [x, y];
}

function scene(): PlacedEntity[] {
  const out: PlacedEntity[] = [];
  let n = 1;
  let ox = 0;
  for (const name of ["transport-belt", "turbo-transport-belt"]) {
    for (const direction of [N, E, S, W]) {
      for (const shape of SHAPES) {
        for (const [dx, dy, facing] of shape) {
          const [x, y] = turn(dx, dy, direction);
          out.push(entity(n++, name, ox + x + 0.5, y + 0.5, (facing + direction) % 16));
        }
        ox += 5;
      }
    }
  }
  // A chemical plant alone, and one with pipes on its two inputs: the
  // connected ports swap the covers it draws.
  out.push(entity(n++, "chemical-plant", ox + 1.5, 1.5, N, "sulfuric-acid"));
  out.push(entity(n++, "chemical-plant", ox + 7.5, 1.5, N, "sulfuric-acid"));
  out.push(entity(n++, "pipe", ox + 6.5, -0.5));
  out.push(entity(n++, "pipe", ox + 8.5, -0.5));
  return out;
}

function contextFor(all: PlacedEntity[]): CollectContext {
  return {
    grid: buildGrid(all),
    fluidNetwork: buildFluidNetwork(all, (e: PlacedEntity) => {
      const p = lookup.get(e.name)?.pipeConnections;
      return p && activeFluidConnections(p, e.recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(all, (n: string) => lookup.get(n)?.heatConnections),
    ...connectors,
    cargoBays: buildCargoBayGrid(all, connectors.cargoBayShapeOf),
    animationFrame: 0,
  } as unknown as CollectContext;
}

/** What buildSceneCache does for each entity: its type's profile, or — when
 *  this entity drew a different number of commands — its shape's. */
function build(cache: AnimProfileCache, all: PlacedEntity[], ctx: CollectContext): { entity: PlacedEntity; profile: AnimProfile; emitted: number; byShape: boolean }[] {
  const commands: DrawCommand[] = [];
  const out: { entity: PlacedEntity; profile: AnimProfile; emitted: number; byShape: boolean }[] = [];
  for (const e of all) {
    const visual = lookup.get(e.name);
    if (!visual?.graphics) continue;
    const before = commands.length;
    collectEntity(commands, e, visual, ctx, 1);
    const emitted = commands.length - before;
    const profile = cache.forEntity(e, visual, ctx);
    const byShape = !(profile.animated.length === 0 || profile.commandCount === emitted);
    out.push({ entity: e, profile: byShape ? cache.forShape(e, visual, ctx, commands, before) : profile, emitted, byShape });
  }
  return out;
}

const all = scene();
const ctx = contextFor(all);

test("every entity gets the profile probing that very entity gives", () => {
  const cache = new AnimProfileCache();
  const built = build(cache, all, ctx);
  let animatedChecked = 0;
  for (const { entity: e, profile, emitted } of built) {
    // A fresh cache probes this entity itself, in the same scene.
    const own = new AnimProfileCache().forEntity(e, lookup.get(e.name)!, ctx);
    if (own.commandCount !== emitted) continue;
    assert.deepEqual(profile, own, `${e.name} at ${e.x},${e.y} facing ${e.direction}`);
    if (own.animated.length) animatedChecked++;
  }
  const belts = all.filter((e) => e.name.endsWith("transport-belt")).length;
  assert.equal(animatedChecked, belts, "every belt should animate and be checked");
});

test("shapes made of sprites already seen are pieced together, not probed", () => {
  const cache = new AnimProfileCache();
  const built = build(cache, all, ctx);
  const byShape = built.filter((b) => b.byShape).length;
  const types = new Set(built.map((b) => `${b.entity.name}|${b.entity.direction}|${Math.abs(Math.round(b.entity.x) + Math.round(b.entity.y)) % 2}`)).size;
  assert.ok(byShape > 0, "expected some belts to differ from their type's shape");
  assert.ok(cache.probes < types + byShape, `${cache.probes} probes for ${types} types and ${byShape} odd shapes: nothing was pieced together`);
});

test("rebuilding the same scene probes nothing", () => {
  const cache = new AnimProfileCache();
  build(cache, all, ctx);
  const probes = cache.probes;
  const again = build(cache, all, ctx);
  assert.equal(cache.probes, probes, "a second build re-probed");
  assert.ok(again.some((b) => b.byShape), "the rebuild still has odd shapes to cover");
});

console.log(`\n${passed} passing`);
