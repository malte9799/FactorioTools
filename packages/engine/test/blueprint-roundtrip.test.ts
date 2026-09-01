import assert from "node:assert/strict";
import {
  decodeBlueprintString,
  denormaliseEntities,
  encodeBlueprintString,
  normaliseEntities,
  toBlueprint,
} from "../src/blueprint.js";
import type { BpEntity, BlueprintEnvelope, PlacedEntity } from "../src/types.js";

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

function bp(entities: BpEntity[]): BlueprintEnvelope {
  return { blueprint: { item: "blueprint", label: "test", entities, version: 562949956435968 } };
}

test("idempotent normalise -> denormalise -> normalise for a fully-populated entity", () => {
  const entities: BpEntity[] = [
    {
      entity_number: 1,
      name: "assembling-machine-3",
      position: { x: 4.5, y: -2.5 },
      direction: 4,
      quality: "rare",
      recipe: "processing-unit",
      items: [
        {
          id: { name: "productivity-module-3", quality: "epic" },
          items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }] },
        },
      ],
    },
  ];
  const placed = normaliseEntities(bp(entities).blueprint!);
  const roundTripped = normaliseEntities({ item: "blueprint", entities: denormaliseEntities(placed) });

  assert.equal(roundTripped.length, 1);
  const [original] = placed;
  const [after] = roundTripped;
  assert.equal(after!.name, original!.name);
  assert.equal(after!.x, original!.x);
  assert.equal(after!.y, original!.y);
  assert.equal(after!.direction, original!.direction);
  assert.equal(after!.quality, original!.quality);
  assert.equal(after!.recipe, original!.recipe);
  assert.deepEqual(after!.modules, original!.modules);
});

test("defaults (direction 0, quality normal, no recipe, no modules) omit their fields", () => {
  const entities: PlacedEntity[] = [
    { entityNumber: 1, name: "transport-belt", x: 0, y: 0, direction: 0, quality: "normal", modules: [], filterItems: [] },
  ];
  const [bpEntity] = denormaliseEntities(entities);
  assert.equal(bpEntity!.direction, undefined);
  assert.equal(bpEntity!.quality, undefined);
  assert.equal(bpEntity!.recipe, undefined);
  assert.equal(bpEntity!.items, undefined);
});

test("full string round trip through encodeBlueprintString/decodeBlueprintString", () => {
  const entities: PlacedEntity[] = [
    { entityNumber: 1, name: "stone-furnace", x: 0, y: 0, direction: 0, quality: "normal", recipe: "iron-plate", modules: [], filterItems: [] },
    { entityNumber: 2, name: "inserter", x: 0, y: -2, direction: 0, quality: "uncommon", modules: [], filterItems: [] },
  ];
  const envelope = { blueprint: toBlueprint(entities, { item: "blueprint", label: "round trip", version: 1 }) };
  const encoded = encodeBlueprintString(envelope);
  assert.equal(encoded[0], "0");
  const decoded = decodeBlueprintString(encoded);
  const reNormalised = normaliseEntities(decoded.blueprint!);

  assert.equal(reNormalised.length, 2);
  assert.equal(reNormalised[0]!.name, "stone-furnace");
  assert.equal(reNormalised[0]!.recipe, "iron-plate");
  assert.equal(reNormalised[1]!.name, "inserter");
  assert.equal(reNormalised[1]!.quality, "uncommon");
});

test("module count is preserved exactly (4 productivity modules in, 4 out)", () => {
  const entities: PlacedEntity[] = [
    {
      entityNumber: 1,
      name: "assembling-machine-3",
      x: 0,
      y: 0,
      direction: 0,
      quality: "normal",
      recipe: "iron-gear-wheel",
      modules: [{ name: "productivity-module-3", quality: "normal", count: 4 }],
      filterItems: [],
    },
  ];
  const [bpEntity] = denormaliseEntities(entities);
  const reread = normaliseEntities({ item: "blueprint", entities: [bpEntity!] });
  assert.equal(reread[0]!.modules.length, 1);
  assert.equal(reread[0]!.modules[0]!.name, "productivity-module-3");
  assert.equal(reread[0]!.modules[0]!.count, 4);
});

test("mixed module names/qualities collapse and expand correctly", () => {
  const entities: PlacedEntity[] = [
    {
      entityNumber: 1,
      name: "assembling-machine-3",
      x: 0,
      y: 0,
      direction: 0,
      quality: "normal",
      modules: [
        { name: "speed-module-3", quality: "normal", count: 2 },
        { name: "productivity-module-3", quality: "rare", count: 2 },
      ],
      filterItems: [],
    },
  ];
  const [bpEntity] = denormaliseEntities(entities);
  const reread = normaliseEntities({ item: "blueprint", entities: [bpEntity!] });
  const byKey = new Map(reread[0]!.modules.map((m) => [`${m.name}/${m.quality}`, m.count]));
  assert.equal(byKey.get("speed-module-3/normal"), 2);
  assert.equal(byKey.get("productivity-module-3/rare"), 2);
});

test("entity numbers renumber sequentially starting at 1", () => {
  const entities: PlacedEntity[] = [
    { entityNumber: 47, name: "transport-belt", x: 0, y: 0, direction: 0, quality: "normal", modules: [], filterItems: [] },
    { entityNumber: 12, name: "transport-belt", x: 1, y: 0, direction: 0, quality: "normal", modules: [], filterItems: [] },
  ];
  const bpEntities = denormaliseEntities(entities);
  assert.equal(bpEntities[0]!.entity_number, 1);
  assert.equal(bpEntities[1]!.entity_number, 2);
});

console.log(`\n${passed} passing`);
