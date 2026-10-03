import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  Evaluator, MapSurface, NO_SIDE, Program, chunkStreamSeed, cliffCode, cliffName, cliffPieces, compileSettings, onCliffLine, parseExpression,
  placementGroups, presetOptions, rollChunk, startingLakePosition, surfaceSeed, trimCliffs, unsupportedFunctions, type MapGenData, type MapGenOptions, type PlacementEntity,
} from "../src/index.js";
import { Rng } from "../src/rng.js";
import { loadDataset } from "./dataset.js";
import { pow } from "../src/fastmath.js";

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

const ROOT = path.join(import.meta.dirname, "..");
const loadData = (): MapGenData => loadDataset();

/* ---------- parser ---------- */

test("parser: ^ binds tighter than unary minus and is right-associative", () => {
  assert.deepEqual(parseExpression("-x ^ 2"), { t: "un", op: "-", a: { t: "bin", op: "^", a: { t: "id", name: "x" }, b: { t: "num", v: 2 } } });
  const chain = parseExpression("2 ^ 3 ^ x");
  assert.equal(chain.t, "bin");
  assert.deepEqual(chain.t === "bin" && chain.b, { t: "bin", op: "^", a: { t: "num", v: 3 }, b: { t: "id", name: "x" } });
  assert.deepEqual(parseExpression("2 ^ -x"), { t: "bin", op: "^", a: { t: "num", v: 2 }, b: { t: "un", op: "-", a: { t: "id", name: "x" } } });
});

test("parser: arithmetic is left-associative with the usual precedence", () => {
  const ast = parseExpression("a - b - c * d");
  assert.deepEqual(ast, {
    t: "bin", op: "-",
    a: { t: "bin", op: "-", a: { t: "id", name: "a" }, b: { t: "id", name: "b" } },
    b: { t: "bin", op: "*", a: { t: "id", name: "c" }, b: { t: "id", name: "d" } },
  });
});

test("parser: named and positional calls, strings, colon identifiers", () => {
  assert.deepEqual(parseExpression("clamp{value = x, min = -1, max = 1}"), {
    t: "call", name: "clamp", pos: null,
    named: { value: { t: "id", name: "x" }, min: { t: "un", op: "-", a: { t: "num", v: 1 } }, max: { t: "num", v: 1 } },
  });
  assert.deepEqual(parseExpression("var('control:iron-ore:size') > 0"), {
    t: "bin", op: ">", a: { t: "call", name: "var", pos: [{ t: "str", v: "control:iron-ore:size" }], named: null }, b: { t: "num", v: 0 },
  });
  assert.deepEqual(parseExpression("control:water:size"), { t: "id", name: "control:water:size" });
  assert.deepEqual(parseExpression("0x10 + .5 + 4.2e-5"), parseExpression("16 + 0.5 + 0.000042"));
});

/* ---------- primitives ---------- */

test("rng: reproduces the game developer's published vectors", () => {
  // From TOGoS/FactorioNoiseJS, written by the author of the game's noise.
  const vectors: [number, number[]][] = [
    [100, [45438212, 1409544450, 3980732798, 112738311, 3238374133, 2853535413]],
    [400, [54073607, 2416095235, 2388209852, 82837509, 2298934852, 2986767855]],
    [500, [67067654, 4093776131, 1070546075, 98058244, 1795643805, 3189237892]],
  ];
  for (const [seed, expected] of vectors) {
    const rng = new Rng(seed);
    assert.deepEqual(expected.map(() => rng.next()), expected);
  }
  // Seeds below 341 are raised to it, and the lowest bit is ignored.
  const draw = (seed: number): number => new Rng(seed).next();
  assert.equal(draw(200), draw(100));
  assert.equal(draw(401), draw(400));
});

test("pow: exact for integer exponents, the game's approximation otherwise", () => {
  assert.equal(pow(3, 4), 81);
  assert.equal(pow(2, -2), 0.25);
  assert.equal(pow(0, 0), 1);
  // Not Math.pow: the approximation does not even return 1 for 1.
  assert.equal(pow(1, Math.fround(1 / 3)), 1.0000152587890625);
});

test("starting lake sits 75 tiles from spawn", () => {
  for (const seed of [1, 123, 2718281828]) {
    const [x, y] = startingLakePosition(seed, [0, 0]);
    const d = Math.hypot(x, y);
    assert.ok(d > 73 && d <= 75, `seed ${seed}: lake at distance ${d}`);
  }
});

/* ---------- against the game ---------- */

interface Fixture {
  seed: number;
  planet?: string;
  preset?: string;
  options?: Partial<MapGenOptions>;
  define: Record<string, string>;
  positions: [number, number][];
  values: Record<string, string>;
}

const fixtureDir = path.join(ROOT, "test/fixtures");
for (const file of readdirSync(fixtureDir).filter((f) => /^(nauvis|primitives|vulcanus|gleba)-.*\.json$/.test(f)).sort()) {
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, file), "utf8")) as Fixture;
  test(`matches the game bit for bit: ${file} (${Object.keys(fixture.values).length} expressions)`, () => {
    const data = loadData();
    for (const [name, expression] of Object.entries(fixture.define)) data.expressions[name] = { expression };
    // A preset was applied to the game through the planet prototype, which
    // has no starting area or map size; drop those to compare like for like.
    const preset = fixture.preset ? { ...presetOptions(data.presets![fixture.preset]), startingArea: 1, height: 0 } : {};
    const program = new Program(data, compileSettings(data, { seed: fixture.seed, planet: fixture.planet, ...preset, ...fixture.options }));
    const evaluator = new Evaluator(program);
    const xs = Float32Array.from(fixture.positions, (p) => p[0]);
    const ys = Float32Array.from(fixture.positions, (p) => p[1]);
    const wrong: string[] = [];
    for (const [name, encoded] of Object.entries(fixture.values)) {
      const bytes = Buffer.from(encoded, "base64");
      const expected = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const ours = evaluator.run([program.named(name)], xs, ys)[0]!;
      let bad = 0;
      let first = "";
      for (let i = 0; i < expected.length; i++) {
        if (Object.is(expected[i], ours[i]) || expected[i] === ours[i]) continue;
        if (!bad) first = `at ${fixture.positions[i]}: game ${expected[i]}, ours ${ours[i]}`;
        bad++;
      }
      if (bad) wrong.push(`${name}: ${bad}/${expected.length} differ, ${first}`);
    }
    assert.deepEqual(wrong, []);
  });
}

/* ---------- planets ---------- */

test("planets: each has its own seed, and the unfinished ones say what they lack", () => {
  assert.equal(surfaceSeed(123, "nauvis"), 123);
  // Map seed plus the CRC32 of the planet's name.
  assert.equal(surfaceSeed(123, "vulcanus"), 1249812914);
  assert.equal(surfaceSeed(0xffffffff, "vulcanus"), 1249812790);
  const data = loadData();
  assert.deepEqual(unsupportedFunctions(data, "nauvis"), []);
  assert.deepEqual(unsupportedFunctions(data, "vulcanus"), []);
  assert.deepEqual(unsupportedFunctions(data, "gleba"), []);
  assert.deepEqual(unsupportedFunctions(data, "aquilo"), ["voronoi_cell_id", "voronoi_facet_noise"]);
  assert.ok(unsupportedFunctions(data, "fulgora").includes("voronoi_spot_noise"));
  const vulcanus = new MapSurface(data, { seed: 123, planet: "vulcanus" });
  assert.deepEqual(vulcanus.resources.map((r) => r.name).sort(), ["calcite", "coal", "sulfuric-acid-geyser", "tungsten-ore"]);
  assert.ok(vulcanus.tiles.some((t) => t.name === "lava" && t.water));
});

test("pow: a square root is exact, unlike any other fractional power", () => {
  assert.equal(pow(2, 0.5), Math.fround(Math.SQRT2));
  assert.notEqual(pow(2, 1.5), Math.fround(2 ** 1.5));
});

/* ---------- settings ---------- */

test("settings: a preset's named sizes and cliff control become numbers", () => {
  const data = loadData();
  assert.deepEqual(Object.keys(data.presets!).sort(), ["death-world", "death-world-marathon", "default", "island", "lakes", "marathon", "rail-world", "ribbon-world", "rich-resources"]);
  assert.deepEqual(data.mapTypes, ["elevation", "elevation_lakes", "elevation_island"]);

  const rich = presetOptions(data.presets!["rich-resources"]);
  assert.equal(rich.controls!["iron-ore"]!.richness, 2);
  const death = presetOptions(data.presets!["death-world"]);
  assert.deepEqual(death.controls!["enemy-base"], { frequency: 2, size: 2, richness: undefined });
  assert.equal(death.startingArea, Math.SQRT1_2);

  // The ribbon world sets no cliff settings of its own: its cliffs are
  // thinned through Nauvis's cliff control.
  const ribbon = presetOptions(data.presets!["ribbon-world"]);
  assert.equal(ribbon.height, 128);
  const constants = compileSettings(data, { seed: 1, ...ribbon }).constants;
  assert.equal(constants.cliff_elevation_interval, 160);
  assert.equal(constants.cliff_richness, 0.75);
  assert.equal(constants.starting_area_radius, 450);
  assert.equal(constants["control:water:frequency"], 4);
  assert.equal(compileSettings(data, { seed: 1 }).constants.cliff_elevation_interval, 40);
});

test("settings: a bounded map ends in void, and a disabled resource is gone", () => {
  const data = loadData();
  const ribbon = new MapSurface(data, { seed: 123, ...presetOptions(data.presets!["ribbon-world"]) });
  const strip = ribbon.sample(0, -96, 4, 192, 1);
  const names = Array.from(strip.tile, (t) => ribbon.tiles[t]!.name);
  assert.equal(names[0], "out-of-map");
  assert.equal(names[(96 - 65) * 4], "out-of-map");
  assert.notEqual(names[(96 - 64) * 4], "out-of-map");
  assert.notEqual(names[(96 + 63) * 4], "out-of-map");
  assert.equal(names[(96 + 64) * 4], "out-of-map");

  const none = new MapSurface(data, { seed: 123, controls: { "iron-ore": { size: 0 } } });
  const iron = none.resources.findIndex((r) => r.name === "iron-ore");
  assert.equal(none.sample(-128, -64, 128, 128, 1).resource.includes(iron + 1), false);
  assert.equal(new MapSurface(data, { seed: 123 }).sample(-128, -64, 128, 128, 1).resource.includes(iron + 1), true);
});

/* ---------- surface ---------- */

test("surface: sampling is deterministic and independent of how it is cut up", () => {
  const data = loadData();
  const whole = new MapSurface(data, { seed: 123 }).sample(-64, -64, 128, 128, 1);
  const again = new MapSurface(data, { seed: 123 }).sample(-64, -64, 128, 128, 1);
  assert.deepEqual(whole.tile, again.tile);
  const quarter = new MapSurface(data, { seed: 123 }).sample(0, 0, 64, 64, 1);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const w = (y + 64) * 128 + x + 64;
      assert.equal(quarter.tile[y * 64 + x], whole.tile[w]);
      assert.equal(quarter.resource[y * 64 + x], whole.resource[w]);
      assert.equal(quarter.enemy[y * 64 + x], whole.enemy[w]);
    }
  }
  const other = new MapSurface(data, { seed: 5000 }).sample(-64, -64, 128, 128, 1);
  assert.notDeepEqual(whole.tile, other.tile);
});

test("surface: a coarser step samples the same tiles", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const fine = surface.sample(-256, -256, 64, 64, 1);
  const coarse = surface.sample(-256, -256, 16, 16, 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(coarse.tile[y * 16 + x], fine.tile[y * 4 * 64 + x * 4]);
});

test("surface: the starting area has the four starting patches, and no enemies", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const names = surface.resources.map((r) => r.name);
  assert.deepEqual([...names].sort(), ["coal", "copper-ore", "crude-oil", "iron-ore", "stone", "uranium-ore"]);
  const starting = surface.resourcePatches(-150, -150, 150, 150).filter((p) => p.starting);
  assert.deepEqual(starting.map((p) => names[p.resource]).sort(), ["coal", "copper-ore", "iron-ore", "stone"]);
  for (const patch of starting) {
    assert.ok(Math.hypot(patch.x, patch.y) <= 120, "starting patch within the placement radius");
    const amount = surface.patchAmount(patch);
    assert.ok(amount.tiles > 100 && amount.amount > 50_000, `${names[patch.resource]} holds ${amount.amount} on ${amount.tiles} tiles`);
  }
  const grid = surface.sample(-128, -128, 256, 256, 1);
  assert.equal(grid.enemy.reduce((a, b) => a + b, 0), 0, "no spawners near spawn");
  assert.ok(grid.resource.some((r) => r > 0));
  const near = surface.enemyBases(-150, -150, 150, 150).filter((b) => Math.hypot(b.x, b.y) < 130);
  assert.deepEqual(near, []);
});

test("surface: far from spawn there are regular patches and enemy bases", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const patches = surface.resourcePatches(-1500, -1500, 1500, 1500);
  for (let r = 0; r < surface.resources.length; r++) assert.ok(patches.some((p) => p.resource === r && !p.starting), `${surface.resources[r]!.name} patches exist`);
  const bases = surface.enemyBases(-1500, -1500, 1500, 1500);
  assert.ok(bases.length > 20, `${bases.length} bases`);
  for (const b of bases) assert.ok(Math.hypot(b.x, b.y) > surface.startingAreaRadius * 0.9);
  const oil = surface.resources.findIndex((r) => r.name === "crude-oil");
  assert.equal(surface.resources[oil]!.chance, Math.fround(1 / 0.020833333333333) ** -1);
  assert.equal(surface.resources[oil]!.normalYield, 300000);
});

test("surface: ore patches are exactly where the game's probability is positive", () => {
  // The surface shows where things can spawn (no per-tile penalty), which
  // must not disturb the random draws that size the patches themselves.
  const data = loadData();
  const surface = new MapSurface(data, { seed: 123 });
  const program = new Program(data, compileSettings(data, { seed: 123 }));
  const exact = new Evaluator(program);
  const size = 192;
  const x0 = -448;
  const y0 = -104;
  const grid = surface.sample(x0, y0, size, size, 1);
  const xs = new Float32Array(size * size);
  const ys = new Float32Array(size * size);
  for (let k = 0; k < xs.length; k++) {
    xs[k] = x0 + (k % size);
    ys[k] = y0 + Math.floor(k / size);
  }
  const ores = surface.resources.map((r, i) => ({ ...r, i })).filter((r) => r.chance === 1);
  let oreTiles = 0;
  for (const ore of ores) {
    const p = exact.run([program.named(`entity:${ore.name}:probability`)], xs, ys)[0]!;
    for (let k = 0; k < p.length; k++) {
      if (surface.tiles[grid.tile[k]!]!.water) continue;
      const shown = grid.resource[k] === ore.i + 1;
      // Where two patches overlap only the first is shown.
      if (grid.resource[k] && !shown) continue;
      assert.equal(shown, p[k]! > 0, `${ore.name} at ${xs[k]},${ys[k]}`);
      if (shown) oreTiles++;
    }
  }
  assert.ok(oreTiles > 500, `${oreTiles} ore tiles in the window`);
});

/* ---------- cliffs ---------- */

test("cliffs: a piece runs with the high ground on its left", () => {
  // One cell; vertices in the order nw, ne, sw, se. Level 0 below 10, 1 above.
  const piece = (nw: number, ne: number, sw: number, se: number, cliffy = [10, 10, 10, 10]): string | null =>
    cliffName(cliffPieces(Float32Array.of(nw, ne, sw, se), Float32Array.from(cliffy), 1, 1, 10, 40)[0]!);
  assert.equal(piece(0, 0, 20, 20), "east-to-west");
  assert.equal(piece(20, 20, 0, 0), "west-to-east");
  assert.equal(piece(0, 20, 0, 20), "north-to-south");
  assert.equal(piece(0, 0, 0, 20), "east-to-south");
  assert.equal(piece(0, 20, 20, 20), "north-to-west");
  assert.equal(piece(0, 0, 0, 0), null);
  // Levels meeting diagonally leave the cell empty.
  assert.equal(piece(20, 0, 0, 20), null);
  // A side counts only if either of its vertices is cliffy.
  assert.equal(piece(0, 0, 0, 20, [0, 0, 10, 0]), "none-to-south");
  assert.equal(piece(0, 0, 0, 20, [0, 10, 0, 0]), "east-to-none");
  assert.equal(piece(0, 0, 0, 20, [10, 0, 0, 0]), null);
});

test("cliffs: a line ends where its neighbour is displaced", () => {
  const west = 3;
  const east = 1;
  const row = Uint8Array.of(cliffCode(west, east), cliffCode(west, east), cliffCode(west, east));
  trimCliffs(row, 3, 1, (k) => k === 1);
  assert.deepEqual([...row].map(cliffName), ["west-to-none", null, "none-to-east"]);
  assert.equal(cliffCode(NO_SIDE, east), row[2]);
});

test("cliffs: the drawn line is thinner than its cell and reaches both sides", () => {
  const westToEast = cliffCode(3, 1);
  const rows = [0, 1, 2, 3].map((sy) => [0, 1, 2, 3].map((sx) => (onCliffLine(westToEast, 4, sx, sy) ? "#" : ".")).join(""));
  assert.deepEqual(rows, ["....", "####", "####", "...."]);
  assert.equal(onCliffLine(westToEast, 1, 0, 0), true);
});

test("cliffs: match the cliffs the game places", () => {
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, "cliffs-123.json"), "utf8")) as { seed: number; half: number; cliffs: [number, number, string][] };
  const surface = new MapSurface(loadData(), { seed: fixture.seed });
  const cells = fixture.half / 4;
  const pieces = surface.cliffs(-cells, -cells, cells * 2, cells * 2);
  const game = new Map(fixture.cliffs.map(([x, y, name]) => [`${x},${y}`, name]));
  let same = 0;
  let different = 0;
  for (let j = 0; j < cells * 2; j++) {
    for (let i = 0; i < cells * 2; i++) {
      const ours = cliffName(pieces[j * cells * 2 + i]!);
      const theirs = game.get(`${i - cells},${j - cells}`) ?? null;
      if (ours === theirs) same += ours ? 1 : 0;
      else different++;
    }
  }
  assert.ok(same > 300, `${same} cliffs matched`);
  // Not zero: an oil well displaces a cliff too, and where wells stand is a
  // random roll. Everything else is exact.
  assert.ok(different <= same * 0.02, `${different} cells differ from the game, ${same} match`);
});

test("surface: cliffs and trees appear in the sampled grid when asked for", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  // Away from spawn: the starting area keeps cliffs out.
  const plain = surface.sample(-512, -512, 256, 256, 1);
  assert.equal(plain.cliff.some(Boolean), false);
  assert.equal(plain.trees.some(Boolean), false);
  const full = surface.sample(-512, -512, 256, 256, 1, { cliffs: true, trees: true });
  assert.deepEqual(full.tile, plain.tile);
  const cliffSamples = full.cliff.reduce((a, b) => a + b, 0);
  assert.ok(cliffSamples > 100 && cliffSamples < 256 * 256 * 0.05, `${cliffSamples} cliff samples`);
  assert.ok(full.trees.some(Boolean));
  // Zoomed out, the same contours still show.
  const coarse = surface.sample(-2048, -2048, 256, 256, 16, { cliffs: true });
  assert.ok(coarse.cliff.some(Boolean));
});

test("surface: a hovered patch is measured tile by tile", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const uranium = surface.resources.findIndex((r) => r.name === "uranium-ore");
  const spot = surface.resourcePatches(-600, -600, 600, 600).find((p) => p.resource === uranium)!;
  const patch = surface.measurePatch(spot.x, spot.y)!;
  assert.equal(patch.resource, uranium);
  assert.equal(patch.complete, true);
  // The game reports 638 uranium tiles holding 3,546,148 in this area.
  assert.equal(patch.tiles, 638);
  assert.ok(Math.abs(patch.amount - 3_546_148) < 3_546_148 * 0.001, `amount ${patch.amount}`);
  assert.equal(patch.mask.reduce((a, b) => a + b, 0), patch.tiles);
  assert.equal(patch.mask.length, patch.width * patch.height);
  // Anywhere on the patch gives the same patch; off it, nothing.
  const edge = patch.mask.findIndex(Boolean);
  const again = surface.measurePatch(patch.x0 + (edge % patch.width), patch.y0 + Math.floor(edge / patch.width))!;
  assert.equal(again.tiles, patch.tiles);
  assert.equal(surface.measurePatch(patch.x0 - 5, patch.y0 - 5), null);
});

/* ---------- placement ---------- */

test("placement: groups take their turns in code-unit order of `order`", () => {
  const orders = ["c", "b[enemy]-a", "", "b", "a[tree]-b", "c", "b"];
  assert.deepEqual(placementGroups(orders.map((order) => ({ order }))), [[2], [4], [3, 6], [1], [0, 5]]);
  assert.equal(chunkStreamSeed(0, 0), 0x3fbe2c);
  assert.equal(chunkStreamSeed(1, 0), 0x3fbe2c + 0x1eef);
  assert.equal(chunkStreamSeed(-4, -4), 4114148);
});

test("placement: one draw per eligible tile, two more for an off-grid attempt", () => {
  const entity = (name: string, offGrid: boolean, aquatic = false): PlacementEntity => ({
    name, type: "test", probability: 0, richness: 0, offGrid, box: [[-0.1, -0.1], [0.1, 0.1]], aquatic,
  });
  const entities = [entity("fish", false, true), entity("tree", true), entity("ore", false)];
  const groups = [[0], [1], [2]];
  const fill = (v: number): Float32Array => new Float32Array(1024).fill(v);
  const water = new Uint8Array(1024);
  for (let k = 0; k < 100; k++) water[k] = 1;
  const richness = [fill(1), fill(1), fill(7)];
  const attempts = rollChunk(3, -2, entities, groups, [fill(0), fill(2), fill(0.5)], richness, water);
  // Fish: 100 draws on water, never placed. Trees: every one of the 924 land
  // tiles succeeds and takes three draws. So the ore's rolls start at draw
  // 100 + 924 * 3, and run from the last land tile backwards.
  const rng = new Rng(chunkStreamSeed(3, -2));
  for (let d = 0; d < 100 + 924 * 3; d++) rng.next();
  const expected: number[] = [];
  for (let k = 1023; k >= 100; k--) if (rng.next() * 2 ** -32 < 0.5) expected.push(k);
  const ore = attempts.filter((a) => a.entity === 2);
  assert.deepEqual(ore.map((a) => (a.tileY + 64) * 32 + (a.tileX - 96)), expected);
  assert.ok(ore.length > 400 && ore.length < 520);
  assert.equal(ore[0]!.richness, 7);
  assert.equal(attempts.filter((a) => a.entity === 1).length, 924);
  assert.equal(attempts.filter((a) => a.entity === 0).length, 0);
  // Off-grid attempts carry their two position draws; snapped ones sit mid-tile.
  assert.ok(attempts.find((a) => a.entity === 1)!.offsetA !== 0.5);
  assert.equal(ore[0]!.offsetA, 0.5);
});

test("placement: the resource entities of a chunk are the ones the game places", () => {
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, "resources-123.json"), "utf8")) as {
    seed: number; chunks: [number, number][]; resources: [string, number, number, number][];
  };
  const surface = new MapSurface(loadData(), { seed: fixture.seed });
  const game = new Set(fixture.resources.map(([name, x, y, amount]) => `${name}@${x},${y}=${amount}`));
  const ours = new Set<string>();
  for (const [cx, cy] of fixture.chunks) {
    for (const r of surface.chunkResources(cx, cy)) ours.add(`${surface.resources[r.resource]!.name}@${r.x},${r.y}=${r.amount}`);
  }
  const missing = [...game].filter((k) => !ours.has(k));
  const extra = [...ours].filter((k) => !game.has(k));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  // Every well, on its tile, with its yield.
  const wells = [...ours].filter((k) => k.startsWith("crude-oil"));
  assert.equal(wells.length, 8);
  assert.ok(wells.includes("crude-oil@431,-405=263180"));
  for (const name of ["iron-ore", "copper-ore", "coal", "stone", "uranium-ore"]) assert.ok([...ours].some((k) => k.startsWith(name)), `${name} present`);
});

test("surface: an oil field is drawn and measured as its wells", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const oil = surface.resources.findIndex((r) => r.name === "crude-oil");
  const field = surface.sample(384, -416, 64, 64, 1, { wells: true });
  // Eight wells, each a 3x3 square, none of them touching.
  assert.equal(field.resource.filter((r) => r === oil + 1).length, 8 * 9);
  const area = surface.sample(384, -416, 64, 64, 1);
  assert.ok(area.resource.filter((r) => r === oil + 1).length > 500, "without wells the whole field is marked");
  // From far out a field is a single mark at its centre.
  const far = surface.sample(0, -1024, 128, 128, 8, { wells: true });
  const centre = surface.resourcePatches(384, -416, 448, -352).find((p) => p.resource === oil)!;
  assert.equal(far.resource[Math.floor((centre.y + 1024) / 8) * 128 + Math.floor(centre.x / 8)], oil + 1);
  assert.ok(far.resource.filter((r) => r === oil + 1).length <= 4);

  const patch = surface.measurePatch(431, -405)!;
  assert.equal(patch.resource, oil);
  assert.equal(patch.wells.length, 8);
  assert.equal(patch.entities, 8);
  assert.equal(patch.amount, patch.wells.reduce((sum, w) => sum + w.amount, 0));
  assert.equal(patch.amount, 263180 + 463336 + 678162 + 462652 + 657556 + 482909 + 292967 + 361993);
  // The corner of a well's square, a tile off the well itself, finds it too.
  assert.equal(surface.measurePatch(432, -406)?.wells.length, 8);
});

test("surface: probe agrees with the sampled grid", () => {
  const surface = new MapSurface(loadData(), { seed: 123 });
  const grid = surface.sample(-40, -40, 80, 80, 1);
  for (const [x, y] of [[0, 0], [-40, -40], [39, 39], [12, -31]] as const) {
    const probe = surface.probe(x, y);
    const k = (y + 40) * 80 + x + 40;
    assert.equal(probe.tile, surface.tiles[grid.tile[k]!]!.name);
    assert.equal(probe.resource, grid.resource[k] ? surface.resources[grid.resource[k]! - 1]!.name : null);
  }
});

console.log(`\n${passed} passed`);
