import assert from "node:assert/strict";
import { buildBlueprintTree, collectBlueprints } from "../src/blueprint.js";
import type { BlueprintEnvelope } from "../src/types.js";

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

test("a loose blueprint (no book) has no tree", () => {
  const envelope: BlueprintEnvelope = { blueprint: { item: "blueprint", label: "solo" } };
  assert.equal(buildBlueprintTree(envelope), null);
});

test("a flat book yields one book node whose children are its leaves in order", () => {
  const envelope: BlueprintEnvelope = {
    blueprint_book: {
      item: "blueprint-book",
      label: "My book",
      blueprints: [
        { index: 0, blueprint: { item: "blueprint", label: "First" } },
        { index: 1, blueprint: { item: "blueprint", label: "Second" } },
      ],
    },
  };
  const tree = buildBlueprintTree(envelope);
  assert.ok(tree && tree.kind === "book");
  assert.equal(tree.label, "My book");
  assert.deepEqual(tree.children, [
    { kind: "blueprint", label: "First", flatIndex: 0 },
    { kind: "blueprint", label: "Second", flatIndex: 1 },
  ]);
});

test("nested sub-books keep their own folder structure", () => {
  const envelope: BlueprintEnvelope = {
    blueprint_book: {
      item: "blueprint-book",
      label: "Outer",
      blueprints: [
        { index: 0, blueprint: { item: "blueprint", label: "Root leaf" } },
        {
          index: 1,
          blueprint_book: {
            item: "blueprint-book",
            label: "Inner",
            blueprints: [
              { index: 0, blueprint: { item: "blueprint", label: "Nested leaf" } },
            ],
          },
        },
      ],
    },
  };
  const tree = buildBlueprintTree(envelope);
  assert.ok(tree && tree.kind === "book");
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children[0], { kind: "blueprint", label: "Root leaf", flatIndex: 0 });
  const inner = tree.children[1];
  assert.ok(inner && inner.kind === "book");
  assert.equal(inner.label, "Inner");
  assert.deepEqual(inner.children, [{ kind: "blueprint", label: "Nested leaf", flatIndex: 1 }]);
});

test("every leaf's flatIndex matches its position in collectBlueprints' own flattened order", () => {
  const envelope: BlueprintEnvelope = {
    blueprint_book: {
      item: "blueprint-book",
      label: "Outer",
      blueprints: [
        { index: 0, blueprint: { item: "blueprint", label: "A" } },
        {
          index: 1,
          blueprint_book: {
            item: "blueprint-book",
            label: "Inner",
            blueprints: [
              { index: 0, blueprint: { item: "blueprint", label: "B" } },
              { index: 1, blueprint: { item: "blueprint", label: "C" } },
            ],
          },
        },
        { index: 2, blueprint: { item: "blueprint", label: "D" } },
      ],
    },
  };
  const flat = collectBlueprints(envelope);
  const tree = buildBlueprintTree(envelope);
  assert.ok(tree && tree.kind === "book");

  function collectLeaves(node: NonNullable<typeof tree>): { label: string; flatIndex: number }[] {
    if (node.kind === "blueprint") return [{ label: node.label, flatIndex: node.flatIndex }];
    return node.children.flatMap(collectLeaves);
  }
  const leaves = collectLeaves(tree);
  assert.equal(leaves.length, flat.length);
  for (const leaf of leaves) {
    assert.equal(flat[leaf.flatIndex]!.label, leaf.label);
  }
});

test("unlabelled book/blueprint entries fall back to placeholder labels", () => {
  const envelope: BlueprintEnvelope = {
    blueprint_book: {
      item: "blueprint-book",
      blueprints: [{ index: 0, blueprint: { item: "blueprint" } }],
    },
  };
  const tree = buildBlueprintTree(envelope);
  assert.ok(tree && tree.kind === "book");
  assert.equal(tree.label, "Untitled book");
  assert.equal(tree.children[0]!.label, "Untitled blueprint");
});

console.log(`\n${passed} passing`);
