import assert from "node:assert/strict";
import { Layer } from "@factoriotools/engine";
import type { PlacedEntity } from "@factoriotools/engine";
import { collectInserterPlatform } from "../src/draw/collect.js";
import { compareDrawCommands } from "../src/draw/commands.js";
import { requireDataset } from "./dataset.js";

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

function entity(name: string, x: number, y: number, direction = 0, entityNumber = 1): PlacedEntity {
  return { entityNumber, name, x, y, direction, quality: "normal", modules: [], filterItems: [] };
}

/* ---------- An inserter's platform must Y-sort against neighbours, not
 *  always paint on top ----------
 *
 * Regression coverage for a reported bug: "the base of inserters renders
 * over other object below that" — a neighbouring building placed further
 * down the screen (larger y) than an inserter should overlap the inserter's
 * platform, exactly as any two normal buildings occlude each other by
 * screen depth. Before this fix, render.ts drew every inserter (platform +
 * arm together) in its own pass strictly AFTER the whole Y-sorted normal-
 * sprite pass, so an inserter's platform always painted on top of literally
 * every other entity regardless of true depth — confirmed against the real
 * game's own render_layer behaviour, where the platform sits at the
 * ordinary "object" layer and only the swinging arm always draws on top.
 *
 * collectInserterPlatform (draw/collect.ts) is the fix: it feeds the
 * platform into the same push()/sort pipeline every other entity's body
 * uses, tagged Layer.Object like everything else, so it now takes part in
 * the normal layer+y+order comparison instead of bypassing it. */

const { gameData } = requireDataset("inserterLayering");

test("an inserter platform's draw command lands on the ordinary Object layer", () => {
  const graphics = gameData.inserters["inserter"]?.graphics;
  assert.ok(graphics, "expected the dataset to have a regular inserter with graphics");
  const commands: any[] = [];
  collectInserterPlatform(commands, entity("inserter", 5, 5), graphics!, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].layer, Layer.Object);
});

test("a neighbour further down the screen paints over the inserter platform, not the other way round", () => {
  const graphics = gameData.inserters["inserter"]?.graphics;
  assert.ok(graphics);
  const inserterCmds: any[] = [];
  collectInserterPlatform(inserterCmds, entity("inserter", 5, 5), graphics!, 1);
  const inserterCmd = inserterCmds[0];

  // A same-layer command placed further down the screen (larger y) — what
  // any ordinary neighbouring building's own command would look like at
  // that position.
  const neighbourCmd = { ...inserterCmd, y: inserterCmd.y + 0.5 };

  assert.equal(inserterCmd.layer, neighbourCmd.layer, "both must compete within the same layer for this comparison to mean anything");
  assert.ok(compareDrawCommands(inserterCmd, neighbourCmd) < 0, "the neighbour (larger y) must sort AFTER the inserter platform, i.e. paint over it");
});

test("the platform's y sort key is the entity's y plus the sprite's own shift, matching every other entity", () => {
  const graphics = gameData.inserters["inserter"]?.graphics;
  assert.ok(graphics);
  const commands: any[] = [];
  const e = entity("inserter", 5, 5);
  collectInserterPlatform(commands, e, graphics!, 1);
  const [, shiftY] = graphics!.platform.shift ?? [0, 0];
  assert.equal(commands[0].y, e.y + shiftY);
});

console.log(`\n${passed} passed`);
