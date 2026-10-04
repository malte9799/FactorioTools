import pako from "pako";
import type {
  Blueprint,
  BlueprintBook,
  BlueprintEnvelope,
  BlueprintTreeNode,
  BpEntity,
  BpFilterMode,
  BpItemFilter,
  BpItemRequest,
  BpSignalFilter,
  BpSpoilPriority,
  BpSplitterSide,
  BpWire,
  ModuleStack,
  PlacedEntity,
  QualityName,
  WireColor,
  WireLink,
} from "./types.js";
import { WireConnectorId } from "./types.js";

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

/** Same walk as collectBlueprints, but keeps the book/sub-book folder
 *  structure instead of flattening it — for the library sidebar's "show the
 *  imported book as nested collapsible folders" view. Each leaf's
 *  `flatIndex` matches its position in collectBlueprints' own output, so a
 *  click on a tree node can still call selectBlueprint(flatIndex) against
 *  the flat list the rest of the app already works with. Returns null for a
 *  single loose blueprint (no book, nothing to show as a folder) or an empty
 *  envelope. */
export function buildBlueprintTree(envelope: BlueprintEnvelope): BlueprintTreeNode | null {
  if (!envelope.blueprint_book) return null;
  let nextIndex = 0;
  const walkBook = (book: BlueprintBook): BlueprintTreeNode => ({
    kind: "book",
    label: book.label || "Untitled book",
    children: (book.blueprints ?? []).map((entry): BlueprintTreeNode | null => {
      if (entry.blueprint) {
        return { kind: "blueprint", label: entry.blueprint.label || "Untitled blueprint", flatIndex: nextIndex++ };
      }
      if (entry.blueprint_book) return walkBook(entry.blueprint_book);
      return null;
    }).filter((node): node is BlueprintTreeNode => node !== null),
  });
  return walkBook(envelope.blueprint_book);
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

/** Read explicit filter/request item names into a POSITION-preserving array
 *  — index 0 is slot 1, an empty string marks an unfilled slot in between
 *  two filled ones (e.g. only slots 1 and 3 set becomes ["iron-plate", "",
 *  "copper-plate"], not the two names compacted together) so the entity
 *  GUI's fixed 5-slot row can round-trip exactly what the player configured.
 *  Two different shapes depending on entity kind (confirmed by spike against
 *  a real 2.0 blueprint) — inserter/loader `filters` is a flat array, a
 *  chest's `request_filters` nests under `sections[0].filters`. Neither
 *  exists on most entities (undefined, not an empty array), so this returns
 *  [] rather than assuming one shape. */
function readFilterItems(entity: BpEntity): string[] {
  const flat: BpItemFilter[] = entity.filters ?? entity.request_filters?.sections?.[0]?.filters ?? [];
  if (flat.length === 0) return [];
  const maxIndex = Math.max(...flat.map((f) => f.index));
  const slots = new Array<string>(maxIndex).fill("");
  for (const f of flat) slots[f.index - 1] = safeName(f.name);
  return slots;
}

/** Splits a `defines.wire_connector_id` into the colour it carries and the
 *  entity side it lands on.
 *
 *  Ids 1/2 are red/green for a plain entity AND a combinator's input; 3/4
 *  are a combinator's output. 5 is a pole's copper and a power switch's
 *  left terminal; 6 is a power switch's right. The colliding ids are not
 *  ambiguous in practice — nothing is both a pole and a power switch — so
 *  the side alone distinguishes them. Returns undefined for an id this
 *  project does not know rather than guessing a colour, so an unreadable
 *  wire is skipped instead of drawn wrong. */
function decodeConnector(id: number): { color: WireColor; side: 1 | 2 } | undefined {
  switch (id) {
    case WireConnectorId.circuitRed: return { color: "red", side: 1 };
    case WireConnectorId.circuitGreen: return { color: "green", side: 1 };
    case WireConnectorId.combinatorOutputRed: return { color: "red", side: 2 };
    case WireConnectorId.combinatorOutputGreen: return { color: "green", side: 2 };
    case WireConnectorId.poleCopper: return { color: "copper", side: 1 };
    case WireConnectorId.powerSwitchRightCopper: return { color: "copper", side: 2 };
    default: return undefined;
  }
}

/** Normalises a 2.0 blueprint's `wires` array into WireLinks.
 *
 *  A wire whose two ends disagree on colour is dropped, not repaired: the
 *  game never emits one, so its presence means the string is malformed or
 *  uses a connector id this build does not know, and inventing a colour
 *  would draw a wire the game would not. Same for a wire naming an entity
 *  the blueprint does not contain. */
export function normaliseWires(blueprint: Blueprint): WireLink[] {
  const present = new Set((blueprint.entities ?? []).map((e) => e.entity_number));
  const links: WireLink[] = [];
  for (const wire of blueprint.wires ?? ([] as BpWire[])) {
    if (!Array.isArray(wire) || wire.length < 4) continue;
    const [from, fromId, to, toId] = wire;
    if (!present.has(from) || !present.has(to)) continue;
    const a = decodeConnector(fromId);
    const b = decodeConnector(toId);
    if (!a || !b || a.color !== b.color) continue;
    links.push({ color: a.color, from, fromSide: a.side, to, toSide: b.side });
  }
  return links;
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
    // Only ever present on the entity.filters shape (inserters/loaders) —
    // a chest's request_filters carries none of these, so they stay
    // undefined there, which is also how denormaliseEntities tells the two
    // kinds apart when deciding whether to write flat `filters` back out.
    useFilters: entity.filters !== undefined ? (entity.use_filters ?? false) : undefined,
    filterMode: entity.filters !== undefined ? (entity.filter_mode ?? "whitelist") : undefined,
    overrideStackSize: entity.override_stack_size,
    spoilPriority: entity.spoil_priority,
    undergroundType: entity.type === "input" || entity.type === "output" ? entity.type : undefined,
    splitterInputPriority: asSplitterSide(entity.input_priority),
    splitterOutputPriority: asSplitterSide(entity.output_priority),
    splitterFilter: readSplitterFilter(entity.filter),
    signalItems: readSignalItems(entity),
    ...readCircuit(entity),
  }));
}

/** The circuit settings an entity carries, copied so edits never reach back
 *  into the decoded blueprint. */
function readCircuit(entity: BpEntity): Pick<PlacedEntity, "controlBehavior" | "panel" | "color"> {
  const out: Pick<PlacedEntity, "controlBehavior" | "panel" | "color"> = {};
  if (entity.control_behavior && typeof entity.control_behavior === "object") out.controlBehavior = structuredClone(entity.control_behavior);
  if (entity.text !== undefined || entity.always_show !== undefined || entity.show_in_chart !== undefined || (entity.icon && /display-panel/.test(entity.name))) {
    out.panel = {
      text: typeof entity.text === "string" ? entity.text : undefined,
      icon: entity.icon ? { ...entity.icon } : undefined,
      alwaysShow: entity.always_show,
      showInChart: entity.show_in_chart,
    };
  }
  if (entity.color && typeof entity.color === "object") out.color = { ...entity.color };
  return out;
}

/** Recomputes the read-only `signalItems` hint after an edit to an
 *  entity's circuit settings. */
export function refreshSignalItems(entity: PlacedEntity): void {
  entity.signalItems = readSignalItems({
    entity_number: entity.entityNumber,
    name: entity.name,
    position: { x: entity.x, y: entity.y },
    control_behavior: entity.controlBehavior,
    icon: entity.panel?.icon,
  });
}

/** Every item (not virtual signal or fluid) a combinator, display panel,
 *  infinity chest or requester names; undefined when there are none. */
function readSignalItems(entity: BpEntity): string[] | undefined {
  const found: (BpSignalFilter | undefined)[] = [
    ...(entity.control_behavior?.sections?.sections ?? []).flatMap((s) => s.filters ?? []),
    ...(entity.control_behavior?.parameters ?? []).map((p) => p.icon),
    entity.icon,
    ...(entity.infinity_settings?.filters ?? []),
    ...(entity.request_filters?.sections ?? []).flatMap((s) => s.filters ?? []),
  ];
  const names = found
    .filter((f): f is BpSignalFilter & { name: string } => !!f && typeof f.name === "string" && (f.type === undefined || f.type === "item"))
    .map((f) => safeName(f.name));
  return names.length ? [...new Set(names)] : undefined;
}

function asSplitterSide(side: unknown): BpSplitterSide | undefined {
  return side === "left" || side === "right" ? side : undefined;
}

function readSplitterFilter(filter: BpEntity["filter"]): string | undefined {
  if (typeof filter === "string") return safeName(filter);
  if (filter && typeof filter.name === "string") return safeName(filter.name);
  return undefined;
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

/** Inverse of readFilterItems' position-preserving array: index 0 -> slot 1,
 *  an empty string is a gap and emits no entry at all (matching a real
 *  blueprint, which never has a filter entry for an unset slot). */
function writeFilterSlots(slots: string[]): BpItemFilter[] {
  const out: BpItemFilter[] = [];
  slots.forEach((name, i) => {
    if (name) out.push({ index: i + 1, name });
  });
  return out;
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
 *  filterItems/useFilters/filterMode round-trip ONLY for an inserter/loader
 *  — signalled by useFilters being defined (normaliseEntities only ever sets
 *  it when the SOURCE blueprint used the flat `filters` shape in the first
 *  place). A chest's filterItems came from the incompatible nested
 *  `request_filters.sections` shape instead (useFilters left undefined
 *  there), which this project has no editor for, so it's still not written
 *  back out — re-exporting a blueprint whose chest had requests set still
 *  silently drops them rather than guessing the wrong shape. A freshly
 *  PLACED inserter (never loaded from a blueprint) also has useFilters
 *  undefined until its own GUI sets it, so a plain new inserter round-trips
 *  with no filters block at all, matching a freshly-placed real one. */
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
    if (e.useFilters !== undefined) {
      bp.filters = writeFilterSlots(e.filterItems);
      if (e.useFilters) bp.use_filters = true;
      if (e.filterMode && e.filterMode !== "whitelist") bp.filter_mode = e.filterMode as BpFilterMode;
    }
    if (e.overrideStackSize !== undefined) bp.override_stack_size = e.overrideStackSize;
    if (e.spoilPriority) bp.spoil_priority = e.spoilPriority as BpSpoilPriority;
    if (e.splitterInputPriority) bp.input_priority = e.splitterInputPriority;
    if (e.splitterOutputPriority) bp.output_priority = e.splitterOutputPriority;
    if (e.splitterFilter) bp.filter = { name: e.splitterFilter };
    if (e.controlBehavior && Object.keys(e.controlBehavior).length) bp.control_behavior = structuredClone(e.controlBehavior);
    if (e.panel) {
      if (e.panel.text) bp.text = e.panel.text;
      if (e.panel.icon?.name) bp.icon = { ...e.panel.icon };
      if (e.panel.alwaysShow !== undefined) bp.always_show = e.panel.alwaysShow;
      if (e.panel.showInChart !== undefined) bp.show_in_chart = e.panel.showInChart;
    }
    if (e.color) bp.color = { ...e.color };
    return bp;
  });
}

/** Inverse of normaliseWires(), against the SAME renumbering
 *  denormaliseEntities applies.
 *
 *  That renumbering is why this takes the entity list too: wires address
 *  entities by number, and denormaliseEntities reassigns those numbers by
 *  position in the array. A wire naming an entity that is no longer in the
 *  list (erased since the blueprint was loaded) is dropped — that is the
 *  same thing the game does when you mine one end of a wire. */
export function denormaliseWires(wires: WireLink[], entities: PlacedEntity[]): BpWire[] {
  const renumbered = new Map(entities.map((e, i) => [e.entityNumber, i + 1]));
  const idFor = (color: WireColor, side: 1 | 2): number => {
    if (color === "copper") {
      return side === 1 ? WireConnectorId.poleCopper : WireConnectorId.powerSwitchRightCopper;
    }
    if (color === "red") {
      return side === 1 ? WireConnectorId.circuitRed : WireConnectorId.combinatorOutputRed;
    }
    return side === 1 ? WireConnectorId.circuitGreen : WireConnectorId.combinatorOutputGreen;
  };
  const out: BpWire[] = [];
  for (const wire of wires) {
    const from = renumbered.get(wire.from);
    const to = renumbered.get(wire.to);
    if (from === undefined || to === undefined) continue;
    out.push([from, idFor(wire.color, wire.fromSide), to, idFor(wire.color, wire.toSide)]);
  }
  return out;
}

/** Convenience wrapper bundling denormaliseEntities into a full Blueprint,
 *  ready for encodeBlueprintString. `template` carries the fields that have
 *  no PlacedEntity equivalent (the blueprint's own item/label/version, and
 *  its floor tiles). */
export function toBlueprint(
  entities: PlacedEntity[],
  template: Pick<Blueprint, "item" | "label" | "version" | "description" | "icons" | "tiles">,
  wires: WireLink[] = [],
): Blueprint {
  const bp: Blueprint = {
    ...template,
    entities: denormaliseEntities(entities),
  };
  // Omitted entirely when there are none, matching how sparse real
  // blueprint JSON is (and how the game itself writes wire-less blueprints).
  const encoded = denormaliseWires(wires, entities);
  if (encoded.length) bp.wires = encoded;
  return bp;
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
