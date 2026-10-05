/**
 * The scene cache in render.ts, end to end.
 *
 * A scene is collected and sorted once; after that each frame only patches
 * the sx of the commands that animate. If a patch is wrong (a belt tier
 * stepping at another tier's period, a wrap at the end of a cycle landing on
 * the wrong cell) the frame still draws, just the wrong picture, and nothing
 * else in the suite would notice.
 *
 * So this mounts the real renderer on a stubbed DOM with a hand-driven
 * requestAnimationFrame and, for a run of animation frames, compares the
 * drawImage calls the cached path makes against the calls the same frame
 * makes straight after the cache is thrown away (updateEntities drops it).
 * The two must match call for call, in order.
 *
 * It also checks that paint() and paintPlain() agree on an untinted scene:
 * render.ts paints the scene with paintPlain directly and only routes the
 * placement ghost through paint(), which is only safe while the two produce
 * the same calls for a list with no tint in it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectBlueprints, decodeBlueprintString, normaliseEntities, type PlacedEntity } from "@factoriotools/engine";
import { DEBUG_BLUEPRINT } from "../../engine/src/data/debug-lab.js";
import { DATA_DIR, requireDataset } from "./dataset.js";

const { gameData, catalog } = requireDataset("scene cache");

/* ---------- DOM stub ---------- */

/** Every drawImage that places a sprite cell (the 9-argument form) on any
 *  of the renderer's canvases. Offscreen canvases built once and reused, like
 *  a tinted module mask, draw with the 3-argument form and stay out of it. */
let drawLog: string[] = [];
let nextId = 0;

function makeContext(log: () => string[] = () => drawLog): unknown {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "drawImage") {
        return (img: { __id?: string }, ...args: number[]) => {
          if (args.length === 8) log().push(`${img.__id}|${args.map((n) => n.toFixed(3)).join(",")}`);
        };
      }
      if (prop === "createPattern") return () => ({ setTransform() {} });
      if (prop === "getImageData") return (_x: number, _y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4) });
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "canvas") return undefined;
      return () => {};
    },
    set() {
      return true;
    },
  });
}

function makeElement(): Record<string, unknown> {
  const el: Record<string, unknown> & { children: unknown[] } = {
    __id: `canvas-${nextId++}`,
    style: {}, dataset: {}, children: [], hidden: false, width: 1, height: 1,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(child: unknown) { el.children.push(child); return child; },
    append() {}, replaceChildren() {}, remove() {},
    setAttribute() {}, removeAttribute() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40000, height: 40000, right: 40000, bottom: 40000 }),
    querySelector: () => null,
  };
  const context = makeContext();
  el.getContext = () => context;
  return el;
}

let rafQueue: (() => void)[] = [];
const g = globalThis as Record<string, unknown>;
g.window = { devicePixelRatio: 1, innerWidth: 40000, innerHeight: 40000, addEventListener() {}, removeEventListener() {} };
g.document = { createElement: () => makeElement(), activeElement: null, addEventListener() {}, removeEventListener() {} };
g.requestAnimationFrame = (cb: () => void) => rafQueue.push(cb);
g.cancelAnimationFrame = () => {};
g.ResizeObserver = class { observe() {} disconnect() {} };
g.DOMMatrix = class { scale() { return this; } };
// The icon atlas fetches its manifest by relative URL, which Node cannot
// resolve; nothing here draws icons, so leave that request pending.
g.fetch = () => new Promise(() => {});
/** Every sheet "loads" on the next microtask, so paint really calls drawImage.
 *  Node has no createImageBitmap, which sends the atlas down its <img> path. */
g.Image = class {
  decoding = "";
  width = 1;
  height = 1;
  __id = "";
  set onload(fn: () => void) { queueMicrotask(() => fn()); }
  set onerror(_fn: unknown) {}
  set src(value: string) { this.__id = value; }
  decode() { return Promise.resolve(); }
};

const { mountRenderer, FULL_QUALITY } = await import("../src/render.js");
const { paint, paintPlain } = await import("../src/draw/paint.js");
const { buildVisualLookup, makeConnectorPredicates, activeFluidConnections } = await import("../src/entityLookup.js");
const { buildGrid } = await import("../src/neighbours/grid.js");
const { buildFluidNetwork } = await import("../src/neighbours/fluid.js");
const { buildHeatNetwork } = await import("../src/neighbours/heat.js");
const { buildCargoBayGrid } = await import("../src/neighbours/cargoBay.js");
const { collectEntity, collectInserterPlatform } = await import("../src/draw/collect.js");
const { getSharedSpriteAtlas } = await import("../src/spriteAtlas.js");
type DrawCommand = import("../src/draw/commands.js").DrawCommand;
type SpriteAtlas = import("../src/spriteAtlas.js").SpriteAtlas;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function largest(blueprint: string): PlacedEntity[] {
  return collectBlueprints(decodeBlueprintString(blueprint)).map(normaliseEntities).sort((a, b) => b.length - a.length)[0] ?? [];
}

/** The debug lab (one of every entity) and the three largest examples. */
const cases: [string, PlacedEntity[]][] = [["debug lab", largest(DEBUG_BLUEPRINT)]];
{
  const file = path.join(DATA_DIR, "example-blueprints.json");
  const examples = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as { label: string; bp: string; entities: number }[]) : [];
  for (const ex of [...examples].sort((a, b) => b.entities - a.entities).slice(0, 3)) {
    cases.push([ex.label.replace(/\[[^\]]*\]/g, "").trim().slice(0, 40), largest(ex.bp)]);
  }
}

/* ---------- cached frames match a fresh collect ---------- */

/** The whole scene collected from scratch at one animation frame, the way
 *  render.ts collected every frame before the cache existed. */
const lookup = buildVisualLookup(gameData, catalog);
const connectors = makeConnectorPredicates(lookup);

function commandsFor(entities: PlacedEntity[], animationFrame: number): DrawCommand[] {
  const ctx = {
    grid: buildGrid(entities),
    fluidNetwork: buildFluidNetwork(entities, (e) => {
      const pipes = lookup.get(e.name)?.pipeConnections;
      return pipes && activeFluidConnections(pipes, e.recipe, gameData);
    }),
    heatNetwork: buildHeatNetwork(entities, (name) => lookup.get(name)?.heatConnections),
    ...connectors,
    cargoBays: buildCargoBayGrid(entities, connectors.cargoBayShapeOf),
    animationFrame,
  };
  const commands: DrawCommand[] = [];
  for (const e of entities) {
    const visual = lookup.get(e.name);
    if (visual?.inserterGraphics) collectInserterPlatform(commands, e, visual.inserterGraphics, 1);
    else if (visual?.graphics) collectEntity(commands, e, visual, ctx as never, 1);
  }
  return commands;
}


function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const queue = rafQueue;
    rafQueue = [];
    for (const cb of queue) cb();
  }
}

/** The sprite calls painting `commands` makes through the renderer's own
 *  atlas, so sheet ids resolve exactly as they do in the renderer's log. */
function spriteCalls(commands: DrawCommand[]): string[] {
  const calls: string[] = [];
  paintPlain(makeContext(() => calls) as CanvasRenderingContext2D, getSharedSpriteAtlas(), commands);
  return calls;
}

// Animation off, so a settled view never bakes its static layers onto
// offscreen canvases (bakedLayersFor) and the scene is painted straight onto
// the canvas every frame. The cache still patches sx for every frame
// stepAnimationFrame lands on.
const renderer = mountRenderer(makeElement() as unknown as HTMLElement, gameData, catalog, { ...FULL_QUALITY, animation: false });

// Past a full period and over the wrap, so the modulo step is checked too.
// Mixed belt tiers cycle at 64, 32 and 16 frames.
const FRAMES = [0, 1, 2, 3, 5, 8, 13, 15, 16, 17, 21, 31, 32, 33, 63, 64, 65, 100, 127, 128, 200];

for (const [label, entities] of cases) {
  await test(`cached frames match a fresh collect: ${label} (${entities.length} entities)`, async () => {
    assert.ok(entities.length > 0);
    renderer.loadBlueprint(entities);
    renderer.setAnimationFrozen(true);
    pump(2);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the sheets "load"
    pump(2);

    for (const frame of FRAMES) {
      renderer.stepAnimationFrame(frame - renderer.getAnimationFrame());
      drawLog = [];
      renderer.stepAnimationFrame(0);
      const drawn = drawLog;
      // Compared as a multiset: the renderer collects in spatial-index order,
      // so commands that tie in the depth sort (shadows on one row) can come
      // out in another order than here, which paints the same picture. A
      // wrongly patched sx is a call that never shows up. The drawn log also
      // holds the floor and the inserter arms, painted around the scene.
      const expected = spriteCalls(commandsFor(entities, frame));
      assert.ok(expected.length > 0, `frame ${frame} collected nothing`);
      const remaining = new Map<string, number>();
      for (const call of drawn) remaining.set(call, (remaining.get(call) ?? 0) + 1);
      const missing = expected.filter((call) => {
        const left = remaining.get(call) ?? 0;
        remaining.set(call, left - 1);
        return left === 0;
      });
      assert.deepEqual(missing.slice(0, 3), [], `frame ${frame}: ${missing.length} of ${expected.length} scene calls never drawn`);
    }
  });
}

renderer.destroy();

/* ---------- paint() and paintPlain() agree on an untinted scene ---------- */

/** A context that records every call and state change instead of drawing. */
function recordingContext(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => ops.push(`${prop} ${args.map((a) => (typeof a === "number" ? a.toFixed(4) : (a as { __id?: string })?.__id ?? String(a))).join(",")}`);
    },
    set(_target, prop, value) {
      ops.push(`${String(prop)}=${typeof value === "number" ? value.toFixed(4) : value}`);
      return true;
    },
  });
  return { ctx: ctx as CanvasRenderingContext2D, ops };
}

/** Every sheet counts as loaded, so every draw path runs. */
const stubAtlas = {
  get: (sheet: string) => ({ __id: sheet }),
  getTinted: (sheet: string, color: string) => ({ __id: `${sheet}|${color}` }),
} as unknown as SpriteAtlas;

for (const [label, entities] of cases) {
  await test(`paint() and paintPlain() agree on an untinted scene: ${label}`, () => {
    for (const frame of [0, 1, 7, 33]) {
      const commands = commandsFor(entities, frame);
      assert.ok(commands.length > 0);
      assert.ok(commands.every((c) => !c.tint));
      const viaPaint = recordingContext();
      paint(viaPaint.ctx, stubAtlas, commands.map((c) => ({ ...c })), 32);
      const viaPlain = recordingContext();
      paintPlain(viaPlain.ctx, stubAtlas, commands.map((c) => ({ ...c })));
      assert.deepEqual(viaPaint.ops, viaPlain.ops, `frame ${frame}`);
    }
  });
}

console.log(`\n${passed} passed`);
