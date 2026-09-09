import pako from "pako";
import type {
  Blueprint,
  BlueprintBook,
  BlueprintEnvelope,
  BpEntity,
  BpItemFilter,
  BpItemRequest,
  ModuleStack,
  PlacedEntity,
  QualityName,
} from "./types.js";

export class BlueprintError extends Error {}

/** Decode a blueprint string into its raw JSON envelope.
 *  Format: one version byte ("0"), then base64 of zlib-deflated JSON. */
export function decodeBlueprintString(input: string): BlueprintEnvelope {
  const trimmed = input.trim().replace(/\s+/g, "");
  if (!trimmed) throw new BlueprintError("Paste a blueprint string to begin.");
  const version = trimmed[0];
  if (version !== "0") {
    throw new BlueprintError(
      `Unrecognised blueprint version byte "${version}". This tool reads version 0 strings, which is what Factorio 1.1 and 2.0 export.`,
    );
  }

  let raw: Uint8Array;
  try {
    raw = base64ToBytes(trimmed.slice(1));
  } catch {
    throw new BlueprintError("The string isn't valid base64 — it may have been truncated on copy.");
  }

  let json: string;
  try {
    json = pako.inflate(raw, { to: "string" });
  } catch {
    throw new BlueprintError("The string decoded but wouldn't decompress. Copy it again straight from the game.");
  }

  try {
    return JSON.parse(json) as BlueprintEnvelope;
  } catch {
    throw new BlueprintError("The blueprint decompressed to something that isn't JSON.");
  }
}

/** Re-encode, for round-trip tests and for sharing edited blueprints later. */
export function encodeBlueprintString(envelope: BlueprintEnvelope): string {
  const deflated = pako.deflate(JSON.stringify(envelope), { level: 9 });
  return "0" + bytesToBase64(deflated);
}

/** Flatten a book (including nested books) into a list of blueprints. */
export function collectBlueprints(envelope: BlueprintEnvelope): Blueprint[] {
  const out: Blueprint[] = [];
  const walkBook = (book: BlueprintBook) => {
    for (const entry of book.blueprints ?? []) {
      if (entry.blueprint) out.push(entry.blueprint);
      else if (entry.blueprint_book) walkBook(entry.blueprint_book);
    }
  };
  if (envelope.blueprint) out.push(envelope.blueprint);
  else if (envelope.blueprint_book) walkBook(envelope.blueprint_book);
  return out;
}

const QUALITIES: QualityName[] = ["normal", "uncommon", "rare", "epic", "legendary"];

function asQuality(value: string | undefined): QualityName {
  return value && (QUALITIES as string[]).includes(value) ? (value as QualityName) : "normal";
}

/** Read module requests. Handles both the 1.1 map form and the 2.0 array form. */
/** Factorio prototype names are lowercase alphanumerics with dashes — that is
 *  the whole alphabet the game itself uses. Anything else cannot name a real
 *  prototype and only ever arrives from a hand-crafted blueprint string.
 *
 *  Such a name is kept (so the entity still shows up in the "not counted"
 *  warnings rather than silently disappearing, which is this engine's
 *  established degrade-don't-crash behaviour) but stripped down to the
 *  characters a prototype name may contain. That way a name can never carry
 *  markup into the app layer, independent of whether a given render path
 *  remembers to escape it. */
const PROTOTYPE_NAME = /^[a-z0-9-]+$/;

function safeName(name: string): string {
  if (PROTOTYPE_NAME.test(name)) return name;
  const stripped = name.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  return stripped.length > 0 ? stripped : "unknown-entity";
}

export function readModules(entity: BpEntity): ModuleStack[] {
  const items = entity.items;
  if (!items) return [];

  // 1.1: { "speed-module-3": 4 }
  if (!Array.isArray(items)) {
    return Object.entries(items).map(([name, count]) => ({
      name: safeName(name),
      quality: "normal" as const,
      count,
    }));
  }

  // 2.0: [{ id: { name, quality }, items: { in_inventory: [{ inventory, stack, count? }] } }]
  const merged = new Map<string, ModuleStack>();
  for (const request of items) {
    const rawName = request.id?.name;
    if (!rawName) continue;
    const name = safeName(rawName);
    const quality = asQuality(request.id?.quality);
    const stacks = request.items?.in_inventory ?? [];
    const count = stacks.length
      ? stacks.reduce((sum, s) => sum + (s.count ?? 1), 0)
      : 1;
    const key = `${name}/${quality}`;
    const existing = merged.get(key);
    if (existing) existing.count += count;
    else merged.set(key, { name, quality, count });
  }
  return [...merged.values()];
}

/** Read explicit filter/request item names, sorted by their own `index` so
 *  alt-mode's badge row shows them in the same left-to-right order the
 *  game's own filter UI uses. Two different shapes depending on entity kind
 *  (confirmed by spike against a real 2.0 blueprint) — inserter `filters`
 *  is a flat array, a chest's `request_filters` nests under
 *  `sections[0].filters`. Neither exists on most entities (undefined, not
 *  an empty array), so this returns [] rather than assuming one shape. */
function readFilterItems(entity: BpEntity): string[] {
  const flat: BpItemFilter[] = entity.filters ?? entity.request_filters?.sections?.[0]?.filters ?? [];
  return [...flat]
    .sort((a, b) => a.index - b.index)
    .map((f) => safeName(f.name));
}

export function normaliseEntities(blueprint: Blueprint): PlacedEntity[] {
  return (blueprint.entities ?? []).map((entity) => ({
    entityNumber: entity.entity_number,
    name: safeName(entity.name),
    x: entity.position.x,
    y: entity.position.y,
    direction: entity.direction ?? 0,
    quality: asQuality(entity.quality),
    recipe: entity.recipe,
    modules: readModules(entity),
    filterItems: readFilterItems(entity),
    undergroundType: entity.type === "input" || entity.type === "output" ? entity.type : undefined,
  }));
}

/* ---------- PlacedEntity[] -> Blueprint (the inverse of normaliseEntities) ---------- */

/** Exact inverse of readModules()'s 2.0-array branch: one in_inventory entry
 *  per module instance (readModules only sums `count ?? 1` per entry, so one
 *  entry per instance round-trips exactly without needing to match the
 *  game's own real inventory-slot numbering — `inventory: 4` is the module
 *  inventory id the existing test fixtures already use). */
function writeModules(modules: ModuleStack[]): BpItemRequest[] {
  return modules.map((stack) => ({
    id: { name: stack.name, quality: stack.quality === "normal" ? undefined : stack.quality },
    items: {
      in_inventory: Array.from({ length: stack.count }, (_, slot) => ({ inventory: 4, stack: slot })),
    },
  }));
}

/** Inverse of normaliseEntities(): PlacedEntity[] -> BpEntity[]. Entity
 *  numbers are renumbered sequentially (1-based, matching the fixture
 *  convention test/calc.test.ts's bp() helper already uses) — nothing
 *  downstream depends on preserving original numbers, only on each entity
 *  having a unique one, and after edits (placements/removals) the original
 *  numbering has holes anyway. Fields at their default value (direction 0,
 *  quality "normal", no recipe, no modules) are omitted entirely, matching
 *  how sparse real blueprint JSON is.
 *
 *  NOT round-tripped: `filterItems` (alt-mode-only, display-side data — see
 *  PlacedEntity's own doc comment). Writing it back out would need to know
 *  which of the two incompatible on-disk shapes (inserter's flat `filters`
 *  vs. a chest's nested `request_filters.sections`) applies, which isn't
 *  derivable from a bare entity name without a lookup this module doesn't
 *  have; re-exporting a blueprint that had filters set silently drops them
 *  rather than guessing wrong. */
export function denormaliseEntities(entities: PlacedEntity[]): BpEntity[] {
  return entities.map((e, i) => {
    const bp: BpEntity = {
      entity_number: i + 1,
      name: e.name,
      position: { x: e.x, y: e.y },
    };
    if (e.direction !== 0) bp.direction = e.direction;
    if (e.quality !== "normal") bp.quality = e.quality;
    if (e.recipe) bp.recipe = e.recipe;
    if (e.modules.length) bp.items = writeModules(e.modules);
    if (e.undergroundType) bp.type = e.undergroundType;
    return bp;
  });
}

/** Convenience wrapper bundling denormaliseEntities into a full Blueprint,
 *  ready for encodeBlueprintString. `template` carries the fields that have
 *  no PlacedEntity equivalent (the blueprint's own item/label/version). */
export function toBlueprint(
  entities: PlacedEntity[],
  template: Pick<Blueprint, "item" | "label" | "version">,
): Blueprint {
  return {
    ...template,
    entities: denormaliseEntities(entities),
  };
}

/* ---------- base64 helpers that work in both the browser and Node ---------- */

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}
