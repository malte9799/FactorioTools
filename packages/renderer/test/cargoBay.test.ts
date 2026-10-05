/** Cargo landing pad, space platform hub and cargo bay.
 *
 *  The three join into one structure whose outline and seams are plated
 *  with connection pieces (neighbours/cargoBay.ts), over a body, hatches
 *  and floor the prototype stacks by render layer (data-pipeline's
 *  cargoBayGraphics).
 *
 *  Run with: npx tsx test/cargoBay.test.ts
 */
import assert from "node:assert/strict";
import { Layer, type PlacedEntity } from "@factoriotools/engine";
import { hasDataset, requireDataset } from "./dataset.js";
import { buildVisualLookup, makeConnectorPredicates } from "../src/entityLookup.js";
import { NeighbourGrid } from "../src/neighbours/grid.js";
import { FluidNetwork } from "../src/neighbours/fluid.js";
import { HeatNetwork } from "../src/neighbours/heat.js";
import { buildCargoBayGrid, cargoBayPieces, CargoBayGrid, type CargoBayShape } from "../src/neighbours/cargoBay.js";
import { collectEntity } from "../src/draw/collect.js";
import { compareDrawCommands, type DrawCommand } from "../src/draw/commands.js";

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

let nextNumber = 1;
function entity(name: string, x: number, y: number): PlacedEntity {
  return { entityNumber: nextNumber++, name, x, y, direction: 0, quality: "normal", modules: [], filterItems: [] } as unknown as PlacedEntity;
}

const SHAPES: Record<string, CargoBayShape> = {
  bay: { footprint: [4, 4] },
  pad: { footprint: [8, 8], surface: "planet" },
  hub: { footprint: [8, 8], surface: "space" },
};
const shapeOf = (name: string) => SHAPES[name];

/** The pieces `self` draws among `all`, as sorted `shape@x,y` strings. */
function pieces(self: PlacedEntity, all: PlacedEntity[]): string[] {
  const grid = buildCargoBayGrid(all, shapeOf);
  return cargoBayPieces(self, SHAPES[self.name]!.footprint, grid)
    .map((p) => `${p.shape}@${p.x},${p.y}`)
    .sort();
}

test("a lone bay is four outer corners", () => {
  const bay = entity("bay", 0, 0);
  assert.deepEqual(pieces(bay, [bay]), [
    "bottom_left_outer_corner@-1,1",
    "bottom_right_outer_corner@1,1",
    "top_left_outer_corner@-1,-1",
    "top_right_outer_corner@1,-1",
  ]);
});

test("a lone hub walls the two cells between each pair of corners", () => {
  const hub = entity("hub", 0, 0);
  assert.deepEqual(pieces(hub, [hub]), [
    "bottom_left_outer_corner@-3,3",
    "bottom_right_outer_corner@3,3",
    "bottom_wall@-1,3",
    "bottom_wall@1,3",
    "left_wall@-3,-1",
    "left_wall@-3,1",
    "right_wall@3,-1",
    "right_wall@3,1",
    "top_left_outer_corner@-3,-3",
    "top_right_outer_corner@3,-3",
    "top_wall@-1,-3",
    "top_wall@1,-3",
  ]);
});

test("an entity the grid has not heard of still plates its own outline", () => {
  const ghost = { ...entity("bay", 0, 0), entityNumber: -1 };
  const drawn = cargoBayPieces(ghost, [4, 4], new CargoBayGrid());
  assert.equal(drawn.length, 4);
  assert.ok(drawn.every((p) => p.shape.endsWith("_outer_corner")));
});

test("two bays side by side share one wide bridge, drawn by the right-hand one", () => {
  const left = entity("bay", 0, 0);
  const right = entity("bay", 4, 0);
  assert.deepEqual(pieces(left, [left, right]), [
    "bottom_left_outer_corner@-1,1",
    "bottom_wall@1,1",
    "top_left_outer_corner@-1,-1",
    "top_wall@1,-1",
  ]);
  assert.deepEqual(pieces(right, [left, right]), [
    "bottom_right_outer_corner@1,1",
    "bottom_wall@-1,1",
    "bridge_horizontal_wide@-2,0",
    "top_right_outer_corner@1,-1",
    "top_wall@-1,-1",
  ]);
});

test("two stacked bays share one wide bridge, drawn by the lower one", () => {
  const upper = entity("bay", 0, 0);
  const lower = entity("bay", 0, 4);
  assert.ok(!pieces(upper, [upper, lower]).some((p) => p.startsWith("bridge")));
  assert.deepEqual(
    pieces(lower, [upper, lower]).filter((p) => p.startsWith("bridge")),
    ["bridge_vertical_wide@0,-2"],
  );
});

test("four bays round a point draw a single crossing there", () => {
  const all = [entity("bay", 0, 0), entity("bay", 4, 0), entity("bay", 0, 4), entity("bay", 4, 4)];
  const crossings = all.flatMap((bay) => pieces(bay, all).filter((p) => p.startsWith("bridge_crossing")).map((p) => `${bay.x},${bay.y}:${p}`));
  assert.deepEqual(crossings, ["4,4:bridge_crossing@-2,-2"]);
  // Each of the four seams keeps its own wide bridge.
  const wide = all.flatMap((bay) => pieces(bay, all).filter((p) => p.includes("_wide")));
  assert.equal(wide.length, 4);
});

test("two bays meeting on a hub's edge make a crossing, not a bridge, where all three meet", () => {
  const hub = entity("hub", 0, 0);
  const all = [hub, entity("bay", -2, -6), entity("bay", 2, -6)];
  assert.deepEqual(
    pieces(hub, all).filter((p) => p.startsWith("bridge")),
    ["bridge_crossing@0,-4", "bridge_vertical_wide@-2,-4", "bridge_vertical_wide@2,-4"],
  );
  // The bays draw the seam between themselves and nothing on the hub's edge.
  assert.deepEqual(pieces(all[1]!, all).filter((p) => p.startsWith("bridge")), []);
  assert.deepEqual(pieces(all[2]!, all).filter((p) => p.startsWith("bridge")), ["bridge_horizontal_wide@-2,0"]);
});

test("bays overlapping by a single cell get a narrow bridge and inner corners", () => {
  const upper = entity("bay", 0, 0);
  const lower = entity("bay", 2, 4);
  assert.deepEqual(pieces(upper, [upper, lower]), [
    "bottom_left_inner_corner@1,1",
    "bottom_left_outer_corner@-1,1",
    "right_wall@1,1",
    "top_left_outer_corner@-1,-1",
    "top_right_outer_corner@1,-1",
  ]);
  assert.deepEqual(pieces(lower, [upper, lower]), [
    "bottom_left_outer_corner@-1,1",
    "bottom_right_outer_corner@1,1",
    "bridge_vertical_narrow@-1,-2",
    "left_wall@-1,-1",
    "top_right_inner_corner@-1,-1",
    "top_right_outer_corner@1,-1",
  ]);
});

test("a piece keeps its look wherever its entity sits in the list", () => {
  const a = entity("bay", 0, 0);
  const b = entity("bay", 4, 0);
  const seeds = (self: PlacedEntity, all: PlacedEntity[]) =>
    cargoBayPieces(self, [4, 4], buildCargoBayGrid(all, shapeOf)).map((p) => p.seed);
  assert.deepEqual(seeds(a, [a, b]), seeds(a, [b, a]));
});

test("a blueprint is in space with a platform hub, or with platform floor and no landing pad", () => {
  const bay = entity("bay", 0, 0);
  assert.equal(buildCargoBayGrid([bay], shapeOf).spacePlatform, false);
  assert.equal(buildCargoBayGrid([bay], shapeOf, true).spacePlatform, true);
  assert.equal(buildCargoBayGrid([bay, entity("hub", 6, 2)], shapeOf).spacePlatform, true);
  assert.equal(buildCargoBayGrid([bay, entity("pad", 6, 2)], shapeOf, true).spacePlatform, false);
});

if (!hasDataset()) {
  console.log("cargoBay.test.ts: skipping the dataset-backed tests (no local dataset — see dataset.ts)");
} else {
  const { gameData, catalog } = requireDataset("cargoBay.test.ts");
  const lookup = buildVisualLookup(gameData, catalog);
  const connectors = makeConnectorPredicates(lookup);

  /** `self`'s commands among `all`, in paint order, as sheet file names. */
  const collect = (self: PlacedEntity, all: PlacedEntity[], floorInSpace = false): DrawCommand[] => {
    const ctx = {
      grid: new NeighbourGrid(),
      fluidNetwork: new FluidNetwork(),
      heatNetwork: new HeatNetwork(),
      ...connectors,
      cargoBays: buildCargoBayGrid(all, connectors.cargoBayShapeOf, floorInSpace),
      animationFrame: 0,
    };
    const out: DrawCommand[] = [];
    collectEntity(out, self, lookup.get(self.name)!, ctx, 1);
    return out.sort(compareDrawCommands);
  };
  const sheets = (commands: DrawCommand[]) => commands.map((c) => c.sheet.split("/").pop()!);

  test("a landing pad draws its whole stack: floor, body, shut hatch and robot door", () => {
    const pad = entity("cargo-landing-pad", 0, 0);
    const drawn = sheets(collect(pad, [pad]));
    for (const sheet of ["planet-hub-0-A.png", "planet-hub-1-A.png", "planet-hub-2.png", "planet-hub-3.png", "planet-hub-shadow.png",
      "planet-hub-turbine.png", "planet-hub-drone-hatch.png", "planet-upper-hatch-back.png", "planet-upper-hatch-front.png", "planet-upper-hatch-occluder.png"]) {
      assert.ok(drawn.includes(sheet), `expected ${sheet} to be drawn`);
    }
    // Floor under body under hatch, and the hatch's front lip over its rim.
    const at = (sheet: string) => drawn.indexOf(sheet);
    assert.ok(at("planet-hub-0-A.png") < at("planet-hub-3.png"));
    assert.ok(at("planet-hub-3.png") < at("planet-hub-drone-hatch.png"));
    assert.ok(at("planet-hub-3.png") < at("planet-upper-hatch-back.png"));
    assert.ok(at("planet-upper-hatch-occluder.png") < at("planet-upper-hatch-front.png"));
  });

  test("a platform hub draws both of its hatches", () => {
    const hub = entity("space-platform-hub", 0, 0);
    const drawn = sheets(collect(hub, [hub]));
    for (const sheet of ["platform-hub-3.png", "platform-upper-hatch-back.png", "platform-upper-hatch-front.png",
      "platform-lower-hatch-front-r.png", "platform-lower-hatch-front.png", "platform-lower-hatch-occluder.png"]) {
      assert.ok(drawn.includes(sheet), `expected ${sheet} to be drawn`);
    }
  });

  test("every connection piece a hub asks for has floor art", () => {
    const pad = entity("cargo-landing-pad", 0, 0);
    const floor = collect(pad, [pad]).filter((c) => c.sheet.endsWith("planet-connections-0.png"));
    assert.equal(floor.length, 12);
  });

  test("a cargo bay wears planet art beside a landing pad and platform art beside a platform hub", () => {
    const bay = entity("cargo-bay", 6, -2);
    const onPlanet = sheets(collect(bay, [bay, entity("cargo-landing-pad", 0, 0)]));
    assert.ok(onPlanet.includes("planet-cargo-bay-3.png") && onPlanet.includes("planet-connections-0.png"));
    assert.ok(!onPlanet.some((s) => s.startsWith("platform-")));

    const inSpace = sheets(collect(bay, [bay, entity("space-platform-hub", 0, 0)]));
    assert.ok(inSpace.includes("platform-cargo-bay-3.png") && inSpace.includes("platform-connections-0.png"));
    assert.ok(!inSpace.some((s) => s.startsWith("planet-")));
    // The hatch and floor patch are the same sprite in both looks — once each.
    assert.equal(inSpace.filter((s) => s === "shared-bay-hatch.png").length, 1);
    assert.equal(inSpace.filter((s) => s === "shared-cargo-bay-0.png").length, 1);
  });

  test("a hubless cargo bay takes its look from the floor", () => {
    const bay = entity("cargo-bay", 0, 0);
    assert.ok(sheets(collect(bay, [bay])).includes("planet-cargo-bay-3.png"));
    assert.ok(sheets(collect(bay, [bay], true)).includes("platform-cargo-bay-3.png"));
  });

  test("a cargo bay's hatch closes over its body and rim", () => {
    const bay = entity("cargo-bay", 0, 0);
    const drawn = sheets(collect(bay, [bay]));
    const at = (sheet: string) => drawn.indexOf(sheet);
    assert.ok(at("planet-cargo-bay-3.png") < at("planet-cargo-bay-occluder.png"));
    assert.ok(at("planet-cargo-bay-occluder.png") < at("shared-bay-hatch.png"));
  });

  test("floor plating of every hub and bay paints before any of their bodies", () => {
    const all = [entity("cargo-landing-pad", 0, 0), entity("cargo-bay", 6, -2), entity("cargo-bay", -2, 6)];
    const commands = all.flatMap((e) => collect(e, all)).sort(compareDrawCommands);
    const lastFloor = commands.map((c) => c.layer).lastIndexOf(Layer.LowerObjectAboveShadow);
    const firstBody = commands.findIndex((c) => c.layer === Layer.Object);
    assert.ok(lastFloor >= 0 && firstBody >= 0 && lastFloor < firstBody);
  });
}

console.log(`\n${passed} passed`);
