import assert from "node:assert/strict";
import { Layer, type PlacedEntity } from "@factoriotools/engine";
import { buildVisualLookup } from "../src/entityLookup.js";
import { collectEntity } from "../src/draw/collect.js";
import { computeFitBox } from "../src/entityPreview.js";
import { NeighbourGrid } from "../src/neighbours/grid.js";
import { FluidNetwork } from "../src/neighbours/fluid.js";
import { HeatNetwork } from "../src/neighbours/heat.js";
import { CargoBayGrid } from "../src/neighbours/cargoBay.js";
import type { DrawCommand } from "../src/draw/commands.js";
import { hasDataset, requireDataset } from "./dataset.js";

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

/* ---------- shadow must not skew the centering ----------
 *
 * A synthetic case, independent of any real dataset: one 2x2 "building"
 * command centered on (0,0), plus a shadow shifted 3 tiles to one side
 * only (asymmetric, matching how a real shadow's own shift works — see
 * the agricultural tower's own [1.45, 0.30]). The box must still center
 * on the building, not on "building + shadow" as one shape, while still
 * growing wide enough that the shadow itself is never clipped. */
test("computeFitBox centers on the building, not the asymmetric shadow, while still covering it", () => {
  const building: DrawCommand = {
    sheet: "x", sx: 0, sy: 0, sw: 1, sh: 1,
    dx: -1, dy: -1, dw: 2, dh: 2,
    layer: Layer.Object, y: 0, order: 0, alpha: 1,
  };
  const shadow: DrawCommand = {
    sheet: "x", sx: 0, sy: 0, sw: 1, sh: 1,
    dx: 1, dy: -0.5, dw: 3, dh: 1, // reaches from x=1 to x=4 — purely to one side
    layer: Layer.Shadow, y: 0, order: 0, alpha: 1,
  };

  const box = computeFitBox([2, 2], [shadow, building]);

  // Centered on the 2x2 building (cx=0), not pulled toward the shadow.
  assert.ok(Math.abs(box.cx) < 0.01, `expected cx near 0 (the building's own center), got ${box.cx}`);
  // But still wide enough to contain the shadow's far edge (x=4), i.e. a
  // half-width of at least 4 on the side the shadow reaches toward.
  assert.ok(box.w / 2 >= 4 - 1e-9, `expected the box to still reach the shadow's far edge at x=4 (half-width >= 4), got half-width ${box.w / 2}`);
});

if (!hasDataset()) {
  console.log("entityPreview.test.ts: skipping the dataset-backed test (no local dataset — see dataset.ts)");
} else {
  const { gameData, catalog } = requireDataset("entityPreview.test.ts");
  const lookup = buildVisualLookup(gameData, catalog);

  /* ---------- entityPreview's fit-box must cover the real art, not just
   *  a footprint*margin guess ----------
   *
   * Regression coverage for exactly the bug reported live: the agricultural
   * tower's properties-panel preview showed no arm at all, even though the
   * main canvas and #/layer-debug — which share collectEntity()/paint() with
   * this preview — rendered it correctly. The cause was entityPreview.ts
   * fitting the viewport to tileFootprint * a fixed 1.6 margin, a guess that
   * covers ordinary sprite overhang but not this entity's crane arm. Exercises
   * computeFitBox() directly (the same function mountEntityPreview's draw()
   * calls) rather than re-deriving the bounding-box math in the test, so this
   * fails the moment that function's real behaviour regresses, not just a
   * parallel copy of its logic. */
  test("computeFitBox spans the agricultural-tower's crane arm, not just its footprint", () => {
    const visual = lookup.get("agricultural-tower");
    assert.ok(visual, "agricultural-tower must be in the visual lookup — if this fails, the crane fix in render-catalog.ts likely regressed and the entity has no graphics at all");

    const entity: PlacedEntity = {
      entityNumber: -1,
      name: "agricultural-tower",
      x: 0,
      y: 0,
      direction: 0,
      quality: "normal",
      modules: [],
      filterItems: [],
    };

    const commands: DrawCommand[] = [];
    const never = () => false;
    collectEntity(
      commands,
      entity,
      visual!,
      { grid: new NeighbourGrid(), fluidNetwork: new FluidNetwork(), heatNetwork: new HeatNetwork(), isPipeLike: never, isHeatPipeLike: never, isWallLike: never, isBeltLike: never, cargoBays: new CargoBayGrid(), animationFrame: 0 },
      1,
    );
    assert.ok(commands.length >= 10, `expected the base+shadow+8 crane parts (>=10 commands), got ${commands.length} — a lower count means the crane parts aren't being collected`);

    const box = computeFitBox(visual!.tileFootprint, commands);

    // The old fixed-margin fit only ever budgeted 1.6 * 3 = 4.8 tiles of
    // total height. The real crane parts (shift.y around -4.3 to -4.4, per
    // render-catalog.ts's PART_PLACEMENT) push the true extent well past
    // that on their own, before even adding each part's own sprite height.
    assert.ok(box.h > 5, `expected the crane arm to push the fit box's height past 5 tiles (old margin only covered 4.8 total), got ${box.h.toFixed(2)}`);
    // And the box must be centered near the arm, not still centered on the
    // small footprint — a wide-but-off-center box would still visually clip
    // half the arm out of a square viewport.
    assert.ok(box.cy < -1, `expected the fit box's center to sit well above the pedestal (arm reaches up), got cy=${box.cy.toFixed(2)}`);
  });
}

console.log(`\n${passed} passed`);
