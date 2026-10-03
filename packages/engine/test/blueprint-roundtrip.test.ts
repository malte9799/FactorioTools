import assert from "node:assert/strict";
import {
  decodeBlueprintString,
  denormaliseEntities,
  encodeBlueprintString,
  normaliseEntities,
  normaliseWires,
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

/* ---------- Inserter filter/override-stack-size/spoil-priority round trip ----------
 *
 * Real blueprint string with 5 bulk-inserters, each configured with one
 * different setting from the entity GUI's own filter/override/spoil-priority
 * panel — captured from a live game (Space Age) rather than hand-built, so
 * this exercises the actual on-disk shapes (flat `filters`, `filter_mode`,
 * `use_filters`, `override_stack_size`, `spoil_priority`) rather than a
 * guessed one. */
const FIVE_INSERTERS_BLUEPRINT =
  "0eNq9k8tugzAQRf9l1iYqBBJA6pdUFeIxtKMYm45N1RTx7x1AyaY0YtUNEpbn3DNX8giVHrBnMh7yEai2xkH+MoKjN1Pq+cyUHUIO1aAvARmH7JFhUkCmwS/Iw+lVARpPnnAdXX6uhRm6Sm7modpGKOitkylr5hQhBVF4SBRcIY+Oh0QSGmKs1wvppH6Bo/3gp7/BClrSMra635a6o4mtCSyjUD+GUku+HBrLnZSjoLZdX3LprejAM8xVDA6LO9HzgBvmx93mYfrI3H4iMzVYOF/Wl8LRtzCTjcB4f2D2f1WttKKzzWKmZQdNzsO+EpP9O50f7eR6S7qQJ2B5VW4Z3XvQEovKrEkeu8Xv9lAUSO9umU9OURZnWZLGp7N8pukH0fkZyw==";

test("normaliseEntities reads all four inserter GUI settings from a real blueprint", () => {
  const envelope = decodeBlueprintString(FIVE_INSERTERS_BLUEPRINT);
  const entities = normaliseEntities(envelope.blueprint!);
  assert.equal(entities.length, 5);

  const [plain, whitelisted, overridden, blacklisted, spoilPriority] = entities;
  assert.deepEqual(plain!.filterItems, []);
  assert.equal(plain!.useFilters, undefined);
  assert.equal(plain!.overrideStackSize, undefined);
  assert.equal(plain!.spoilPriority, undefined);

  assert.deepEqual(whitelisted!.filterItems, ["iron-ore"]);
  assert.equal(whitelisted!.useFilters, true);
  assert.equal(whitelisted!.filterMode, "whitelist");

  assert.equal(overridden!.overrideStackSize, 5);

  assert.deepEqual(blacklisted!.filterItems, ["iron-ore"]);
  assert.equal(blacklisted!.useFilters, true);
  assert.equal(blacklisted!.filterMode, "blacklist");

  assert.equal(spoilPriority!.spoilPriority, "fresh-first");
});

test("denormaliseEntities writes the inserter settings back out, and re-reading them matches", () => {
  const envelope = decodeBlueprintString(FIVE_INSERTERS_BLUEPRINT);
  const original = normaliseEntities(envelope.blueprint!);
  const roundTripped = normaliseEntities({ item: "blueprint", entities: denormaliseEntities(original) });
  assert.deepEqual(roundTripped.map((e) => e.filterItems), original.map((e) => e.filterItems));
  assert.deepEqual(roundTripped.map((e) => e.useFilters), original.map((e) => e.useFilters));
  assert.deepEqual(roundTripped.map((e) => e.filterMode), original.map((e) => e.filterMode));
  assert.deepEqual(roundTripped.map((e) => e.overrideStackSize), original.map((e) => e.overrideStackSize));
  assert.deepEqual(roundTripped.map((e) => e.spoilPriority), original.map((e) => e.spoilPriority));
});

test("a gap between filled filter slots survives the round trip (position, not just the names)", () => {
  const entities: PlacedEntity[] = [
    { entityNumber: 1, name: "filter-inserter", x: 0, y: 0, direction: 0, quality: "normal", modules: [], filterItems: ["iron-plate", "", "copper-plate"], useFilters: true, filterMode: "whitelist" },
  ];
  const [bpEntity] = denormaliseEntities(entities);
  assert.deepEqual(bpEntity!.filters, [
    { index: 1, name: "iron-plate" },
    { index: 3, name: "copper-plate" },
  ]);
  const reread = normaliseEntities({ item: "blueprint", entities: [bpEntity!] });
  assert.deepEqual(reread[0]!.filterItems, ["iron-plate", "", "copper-plate"]);
});

test("a chest's request_filters stay read-only: filterItems round-trips to display but useFilters is never set", () => {
  const chestEntity: BpEntity = {
    entity_number: 1,
    name: "requester-chest",
    position: { x: 0, y: 0 },
    request_filters: { sections: [{ index: 1, filters: [{ index: 1, name: "iron-plate" }] }] },
  };
  const [chest] = normaliseEntities({ item: "blueprint", entities: [chestEntity] });
  assert.deepEqual(chest!.filterItems, ["iron-plate"]);
  assert.equal(chest!.useFilters, undefined, "a chest's filters shouldn't be mistaken for an inserter's flat filters");

  const [reWritten] = denormaliseEntities([chest!]);
  assert.equal(reWritten!.filters, undefined, "must not write chest display data back out as inserter-shaped filters");
  assert.equal(reWritten!.request_filters, undefined, "chest requests are still not writable — dropped, not guessed wrong");
});

test("splitter priorities and filter round-trip, reading both the 2.0 object and 1.1 string filter", () => {
  const modern: BpEntity = {
    entity_number: 1,
    name: "splitter",
    position: { x: 0.5, y: 0 },
    input_priority: "left",
    output_priority: "right",
    filter: { name: "iron-plate", quality: "normal", comparator: "=" },
  };
  const legacy: BpEntity = { entity_number: 2, name: "splitter", position: { x: 2.5, y: 0 }, output_priority: "left", filter: "copper-plate" };
  const [a, b] = normaliseEntities({ item: "blueprint", entities: [modern, legacy] });
  assert.equal(a!.splitterInputPriority, "left");
  assert.equal(a!.splitterOutputPriority, "right");
  assert.equal(a!.splitterFilter, "iron-plate");
  assert.equal(b!.splitterInputPriority, undefined);
  assert.equal(b!.splitterFilter, "copper-plate");

  const [written] = denormaliseEntities([a!]);
  assert.equal(written!.input_priority, "left");
  assert.equal(written!.output_priority, "right");
  assert.deepEqual(written!.filter, { name: "iron-plate" });
  assert.deepEqual(normaliseEntities({ item: "blueprint", entities: [written!] })[0], { ...a!, entityNumber: 1 });
});

test("a plain splitter writes no priority or filter keys", () => {
  const [plain] = normaliseEntities({ item: "blueprint", entities: [{ entity_number: 1, name: "splitter", position: { x: 0.5, y: 0 } }] });
  const [written] = denormaliseEntities([plain!]);
  assert.equal("input_priority" in written!, false);
  assert.equal("output_priority" in written!, false);
  assert.equal("filter" in written!, false);
});

test("item hints come from combinators, display panels, infinity and requester chests, never virtual signals", () => {
  const entities: BpEntity[] = [
    {
      entity_number: 1,
      name: "constant-combinator",
      position: { x: 0.5, y: 0.5 },
      control_behavior: { sections: { sections: [{ filters: [{ name: "iron-plate" }, { type: "virtual", name: "signal-N" }] }, { filters: [{ name: "copper-plate" }] }] } },
    },
    { entity_number: 2, name: "display-panel", position: { x: 1.5, y: 0.5 }, icon: { name: "advanced-circuit" }, control_behavior: { parameters: [{ icon: { type: "virtual", name: "signal-anything" } }] } },
    { entity_number: 3, name: "infinity-chest", position: { x: 2.5, y: 0.5 }, infinity_settings: { filters: [{ name: "coal" }] } },
    { entity_number: 4, name: "requester-chest", position: { x: 3.5, y: 0.5 }, request_filters: { sections: [{ index: 1, filters: [{ index: 1, name: "stone" }] }, { index: 2, filters: [{ index: 1, name: "sulfur" }] }] } },
    { entity_number: 5, name: "transport-belt", position: { x: 4.5, y: 0.5 } },
  ];
  const [cc, dp, inf, req, belt] = normaliseEntities({ item: "blueprint", entities });
  assert.deepEqual(cc!.signalItems, ["iron-plate", "copper-plate"]);
  assert.deepEqual(dp!.signalItems, ["advanced-circuit"]);
  assert.deepEqual(inf!.signalItems, ["coal"]);
  assert.deepEqual(req!.signalItems, ["stone", "sulfur"]);
  assert.equal(belt!.signalItems, undefined);
});

test("circuit settings and wires round-trip unchanged (a decider clock)", () => {
  const clock = "0eNqNUv1qgzAQf5f7O5bqtGuFPUkRiXquB5q4JLaT4rvvErt1LTJGQEwu9/u6XKHqRhwMKQf5FajWykJ+vIKldyU7f6Zkj5BDgzU1aKJa9xUp6bSBWQCpBj8hj2ex0uLBnFRuvSeZCwGoHDnChTNsplKNfYWGQcVfQAIGbblXK8/IeOnLbpMJmCCP9ttNxkTc5ozuygpP8kzcwxct1r7HPv4z+bcTAS11Ds3z6U3KResGVVSf0DrW8DHKjjVzQWnTs3vP2g/SBI05vIWD0acbzwWv2Sf1ZDQRf4S84vPw4LIhs/jg0rrnG2rJtYZ+3P/esdOWjHXlfYZuGryiMxk3Bl83icuNCGV9giXjMBp2sfUD1aMbRvf8hv4FtvqGHvIOfMNUhkTL1ui+JMV0kLeysxjiZQ0XTsQrOMYiFomIC3FMhF9pwVVy2DPw/d0LOPO4Q4DZLjmkh0O2T3ev/JnnL6V9ELU=";
  const original = decodeBlueprintString(clock).blueprint!;
  const entities = normaliseEntities(original);
  const out = toBlueprint(entities, original, normaliseWires(original));
  assert.deepEqual(out.entities!.map((e) => e.control_behavior), original.entities!.map((e) => e.control_behavior));
  assert.deepEqual(out.wires, original.wires);
  // Editing the copy never touches the decoded blueprint.
  entities[0]!.controlBehavior!.is_on = false;
  assert.equal(original.entities![0]!.control_behavior!.is_on, undefined);
});

test("display panel text, icon and lamp colour round-trip", () => {
  const entities: BpEntity[] = [
    { entity_number: 1, name: "display-panel", position: { x: 0.5, y: 0.5 }, text: "Hi", icon: { type: "virtual", name: "signal-A" }, always_show: true },
    { entity_number: 2, name: "small-lamp", position: { x: 1.5, y: 0.5 }, color: { r: 1, g: 0, b: 0, a: 1 } },
  ];
  const back = denormaliseEntities(normaliseEntities({ item: "blueprint", entities }));
  assert.equal(back[0]!.text, "Hi");
  assert.deepEqual(back[0]!.icon, { type: "virtual", name: "signal-A" });
  assert.equal(back[0]!.always_show, true);
  assert.deepEqual(back[1]!.color, { r: 1, g: 0, b: 0, a: 1 });
});

console.log(`\n${passed} passing`);
