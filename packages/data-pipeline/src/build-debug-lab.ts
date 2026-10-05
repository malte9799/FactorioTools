/** Regenerates DEBUG_BLUEPRINT in packages/engine/src/data/debug-lab.ts and
 *  BUG_REPRO_BLUEPRINT in packages/engine/src/data/bug-repro.ts.
 *
 *  The debug lab is one big blueprint in seven chapters, three to a row,
 *  read left to right and top to bottom:
 *
 *    1. Buildings  — every renderable entity, once per facing the game
 *                    allows (N E S W left to right; 8 or 16 for the few
 *                    that turn finer), one labelled section per menu row.
 *    2. Belts      — every neighbour combination a belt tile can see, the
 *                    splitter / underground / loader matrices, per-tier
 *                    samplers and the cases that were once real bugs.
 *    3. Fluids, heat & walls — every pipe / heat pipe / wall shape, pumps,
 *                    valves and every fluid or heat building with its ports
 *                    connected, in all four facings.
 *    4. Power & circuits — copper wiring for each pole type in every
 *                    direction (poles turn to face their wires), mixed
 *                    pole chains, the power switch, combinators wired input
 *                    to output, and circuit wires to every wireable kind.
 *    5. Rails      — every track piece in every facing, a signalled loop
 *                    with train stops, and elevated track crossing over.
 *    6. Floors & space platform — every floor tile, and a hub with bays.
 *    7. Alt-mode   — recipes, modules, beacon tints, quality badges,
 *                    splitter and inserter settings.
 *
 *  Each chapter and section carries a display panel set to "always show in
 *  alt-mode" as its heading, so turning on alt-mode labels the whole lab.
 *
 *  The generator lays everything out with the renderer's own footprint and
 *  collision rules and refuses to write a lab in which two entities
 *  overlap, a wire lands on an entity that has no terminal for it, or a
 *  pole carries more copper wires than the game allows.
 *
 *  Run with: npm run build-debug-lab --workspace=@factoriotools/data-pipeline
 *
 *  Regenerate this whenever a render bug is found, so the fix keeps a
 *  standing check. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { denormaliseEntities, denormaliseWires, encodeBlueprintString, Layer } from "@factoriotools/engine";
import type {
  Blueprint,
  BpControlBehavior,
  BpTile,
  GameData,
  PipeConnectionPoint,
  PlacedEntity,
  QualityName,
  RenderCatalog,
  Sprite,
  WireColor,
  WireLink,
} from "@factoriotools/engine";
import {
  activeFluidConnections,
  buildVisualLookup,
  effectiveFootprint,
  isPoleLike,
  isTwoDirectionOnly,
  rotationStep,
  type ResolvedVisual,
} from "@factoriotools/renderer/src/entityLookup.js";
import { entitiesCollide } from "@factoriotools/renderer/src/collision.js";
import {
  isElevatedRail,
  isRail,
  railEnds,
  railName,
  railTiles,
  signalSlotsForEnd,
  trainStopSlots,
  type RailEnd,
  type RailPiece,
  type RailSlot,
} from "@factoriotools/renderer/src/railGeometry.js";
import { startPiece } from "@factoriotools/renderer/src/railPlacement.js";
import { supportsFor } from "@factoriotools/renderer/src/railPlanner.js";
import { canWire } from "@factoriotools/renderer/src/neighbours/wires.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_LAB_PATH = join(__dirname, "../../engine/src/data/debug-lab.ts");
const BUG_REPRO_PATH = join(__dirname, "../../engine/src/data/bug-repro.ts");
const DATA_DIR = join(__dirname, "../../../apps/site/public/data");

const data = JSON.parse(readFileSync(join(DATA_DIR, "game-data.json"), "utf8")) as GameData;
const catalog = JSON.parse(readFileSync(join(DATA_DIR, "render-catalog.json"), "utf8")) as RenderCatalog;
const lookup = buildVisualLookup(data, catalog);

const N = 0, E = 4, S = 8, W = 12;
const DIRECTIONS = [N, E, S, W];
const QUALITIES: QualityName[] = ["normal", "uncommon", "rare", "epic", "legendary"];

/* ====================================================================== */
/* Sheets: entities, wires and floor tiles in one local frame              */
/* ====================================================================== */

/** One entity as the lab places it: a PlacedEntity minus the bookkeeping
 *  the final pass fills in. */
type Ent = Omit<Partial<PlacedEntity>, "entityNumber" | "name" | "x" | "y"> & { name: string; x: number; y: number };

interface SheetWire {
  color: WireColor;
  a: number;
  aSide: 1 | 2;
  b: number;
  bSide: 1 | 2;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A free-standing piece of the lab in its own coordinates. Sheets are
 *  pasted into one another at even offsets only, which keeps every rail on
 *  the 2-tile rail grid and every floor tile on whole tiles. */
class Sheet {
  readonly ents: Ent[] = [];
  readonly wires: SheetWire[] = [];
  readonly tiles: BpTile[] = [];

  add(e: Ent): number {
    if (!lookup.has(e.name)) throw new Error(`debug lab: "${e.name}" is not a renderable entity`);
    this.ents.push(e);
    return this.ents.length - 1;
  }

  wire(color: WireColor, a: number, b: number, aSide: 1 | 2 = 1, bSide: 1 | 2 = 1): void {
    this.wires.push({ color, a, aSide, b, bSide });
  }

  /** Red, green and (between poles) copper along a list of entities. */
  chain(colors: WireColor[], refs: number[]): void {
    for (let i = 1; i < refs.length; i++) for (const c of colors) this.wire(c, refs[i - 1]!, refs[i]!);
  }

  tile(name: string, x: number, y: number): void {
    this.tiles.push({ name, position: { x, y } });
  }

  /** Copies `other` in, shifted by (dx, dy); returns the index its first
   *  entity lands on. */
  paste(other: Sheet, dx: number, dy: number): number {
    const base = this.ents.length;
    for (const e of other.ents) this.ents.push({ ...e, x: e.x + dx, y: e.y + dy });
    for (const w of other.wires) this.wires.push({ ...w, a: w.a + base, b: w.b + base });
    for (const t of other.tiles) this.tiles.push({ name: t.name, position: { x: t.position.x + dx, y: t.position.y + dy } });
    return base;
  }

  bounds(): Box | undefined {
    let box: Box | undefined;
    const grow = (b: Box) => {
      box = box
        ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
        : { ...b };
    };
    for (const e of this.ents) grow(drawBox(e));
    for (const t of this.tiles) grow({ left: t.position.x, top: t.position.y, right: t.position.x + 1, bottom: t.position.y + 1 });
    return box;
  }
}

function visual(name: string): ResolvedVisual {
  const v = lookup.get(name);
  if (!v) throw new Error(`debug lab: no visual for "${name}"`);
  return v;
}

function footprintOf(e: { name: string; direction?: number }): [number, number] {
  return effectiveFootprint(visual(e.name), e.direction ?? 0);
}

/** The area an entity takes up for layout: its rail tiles for track, its
 *  footprint for everything else. Elevated track is drawn well above its
 *  own tiles, so it reserves that headroom too. */
function drawBox(e: Ent): Box {
  if (isRail(e.name)) {
    const tiles = railTiles({ name: e.name, x: e.x, y: e.y, direction: e.direction ?? 0 });
    const box = {
      left: Math.min(...tiles.map(([x]) => x)),
      top: Math.min(...tiles.map(([, y]) => y)),
      right: Math.max(...tiles.map(([x]) => x + 1)),
      bottom: Math.max(...tiles.map(([, y]) => y + 1)),
    };
    if (isElevatedRail(e.name) || e.name === "rail-ramp") box.top -= 3;
    return box;
  }
  const [w, h] = footprintOf(e);
  return { left: e.x - w / 2, top: e.y - h / 2, right: e.x + w / 2, bottom: e.y + h / 2 };
}

/** Factorio centres an odd-sized footprint on a half tile and an even-sized
 *  one on a whole tile, so its edges always land on the grid. */
function snap(coord: number, size: number): number {
  return Math.round(size) % 2 === 1 ? Math.floor(coord) + 0.5 : Math.round(coord);
}

const floorEven = (v: number) => Math.floor(v / 2) * 2;
const ceilEven = (v: number) => Math.ceil(v / 2) * 2;

/** Rotates a North-frame offset clockwise by `dir` (a multiple of 4). */
function rotOffset(dx: number, dy: number, dir: number): [number, number] {
  let x = dx, y = dy;
  for (let i = 0; i < Math.round(dir / 4) % 4; i++) [x, y] = [-y, x];
  return [x, y];
}

const STEP: Record<number, [number, number]> = { [N]: [0, -1], [E]: [1, 0], [S]: [0, 1], [W]: [-1, 0] };

/** A part of a group designed facing North: x/y are offsets, direction is
 *  the part's own facing relative to the group's. */
type Part = Ent;
const part = (name: string, x: number, y: number, direction = N, extra: Partial<Ent> = {}): Part => ({ name, x, y, direction, ...extra });

/** Places a North-designed group turned to `dir` around (ox, oy), shifted as
 *  a whole so its first part lands on its own grid — the rest follow, since
 *  a design that is valid facing North stays valid turned. Returns the
 *  sheet indices of the parts, in order. */
function placeGroup(sheet: Sheet, parts: Part[], dir: number, ox: number, oy: number): number[] {
  const placed = parts.map((p) => {
    const [x, y] = rotOffset(p.x, p.y, dir);
    return { ...p, x: ox + x, y: oy + y, direction: ((p.direction ?? 0) + dir) % 16 };
  });
  const first = placed[0]!;
  const [w, h] = footprintOf(first);
  const sx = snap(first.x, w) - first.x;
  const sy = snap(first.y, h) - first.y;
  return placed.map((p) => sheet.add({ ...p, x: p.x + sx, y: p.y + sy }));
}

/** Adds a section/row heading: a display panel shown in alt-mode. */
function label(sheet: Sheet, x: number, y: number, text: string): number {
  return sheet.add({ name: "display-panel", x, y, panel: { text, alwaysShow: true } });
}

/* ====================================================================== */
/* Layout: blocks flowed into sections, sections into chapters             */
/* ====================================================================== */

interface Block {
  /** Heading shown above the block in alt-mode. */
  title?: string;
  sheet: Sheet;
}

/** Flows blocks left to right, wrapping at `maxWidth`, each one under its
 *  own heading. Rows top-align; the next row clears the tallest block. */
function flow(blocks: Block[], maxWidth: number, gapX = 4, gapY = 3): Sheet {
  const out = new Sheet();
  let x = 0, y = 0, rowHeight = 0;
  for (const block of blocks) {
    const b = block.sheet.bounds();
    if (!b) continue;
    const left = floorEven(b.left);
    const top = floorEven(b.top);
    const width = ceilEven(b.right - left);
    const height = ceilEven(b.bottom - top) + (block.title ? 2 : 0);
    if (x > 0 && x + width > maxWidth) {
      x = 0;
      y += rowHeight + ceilEven(gapY);
      rowHeight = 0;
    }
    if (block.title) label(out, x + 0.5, y + 0.5, block.title);
    out.paste(block.sheet, x - left, y + (block.title ? 2 : 0) - top);
    x += width + ceilEven(gapX);
    rowHeight = Math.max(rowHeight, height);
  }
  return out;
}

/** Stacks blocks top to bottom, each under its heading. */
function stack(blocks: Block[], gapY = 2): Sheet {
  return flow(blocks, 0, 0, gapY);
}

interface Chapter {
  title: string;
  sections: Block[];
  /** How wide its sections flow before wrapping; CHAPTER_WIDTH by default. */
  width?: number;
}

/* ====================================================================== */
/* 1. Buildings                                                            */
/* ====================================================================== */

/** Internal duplicates of an entity that is already shown: the game gives
 *  them no build-menu slot, and they share another entity's art. */
const ALIASES = new Set(["red-chest", "blue-chest", "hidden-electric-energy-interface"]);

const SUBGROUP_TITLES: Record<string, string> = {
  storage: "Storage",
  belt: "Belts",
  inserter: "Inserters",
  "energy-pipe-distribution": "Poles & pipes",
  "train-transport": "Train transport",
  "logistic-network": "Logistic network",
  "circuit-network": "Circuit network",
  energy: "Energy",
  "extraction-machine": "Mining",
  "smelting-machine": "Smelting",
  "production-machine": "Production",
  agriculture: "Agriculture",
  "environmental-protection": "Environmental protection",
  "space-interactors": "Rockets",
  "space-platform": "Space platform",
  "space-related": "Space platform hub",
  "defensive-structure": "Defensive structures",
  turret: "Turrets",
  module: "Beacon",
  other: "Editor-only",
};

/** True when a set of connection points looks the same turned a quarter —
 *  a pipe or heat pipe gains nothing from being shown four times. A port's
 *  flow counts too: the electromagnetic plant's four ports form a pinwheel,
 *  but turning it still swaps which sides take fluid in and which let out. */
function quarterSymmetric(points: { x: number; y: number; direction: number; flowDirection?: string }[]): boolean {
  const key = (x: number, y: number, d: number, flow?: string) => `${x},${y},${d},${flow ?? ""}`;
  const set = new Set(points.map((p) => key(p.x, p.y, p.direction, p.flowDirection)));
  return points.every((p) => {
    const [x, y] = rotOffset(p.x, p.y, E);
    return set.has(key(x, y, (p.direction + 4) % 16, p.flowDirection));
  });
}

/** Whether any of the entity's art or connections changes with its facing. */
function turns(name: string): boolean {
  const v = visual(name);
  if (v.inserterGraphics || v.rotatesFootprint || name in data.belts) return true;
  for (const layer of v.graphics?.layers ?? []) {
    if ("per" in layer && (layer.per === "dir4" || layer.per === "dir8")) return true;
    // Any facing-driven frame axis: "direction", or the artillery turret's
    // cannon picking one of 256 poses from its placement facing.
    if (/^direction/.test(layer.column?.by ?? "") || /^direction/.test(layer.row?.by ?? "")) return true;
  }
  if (v.pipeConnections?.length && !quarterSymmetric(v.pipeConnections)) return true;
  if (v.heatConnections?.length && !quarterSymmetric(v.heatConnections)) return true;
  return false;
}

/** Every facing the game lets this entity take, in the 16-way scheme. */
function facings(name: string): number[] {
  // A pole has no facing of its own: it turns to face its wires, which the
  // power chapter shows in every direction instead.
  if (isPoleLike(name)) return [N];
  if (isTwoDirectionOnly(name)) return [N, E];
  // A thruster can't be turned at all: its ports are pinned in place.
  if (visual(name).pipeConnections?.some((p) => p.fixed)) return [N];
  const step = rotationStep(name);
  if (step < 4) return Array.from({ length: 16 / step }, (_, i) => i * step);
  return turns(name) ? DIRECTIONS : [N];
}

const isUndergroundLike = (name: string) => name.endsWith("underground-belt") || name.includes("loader");

/** For the machines whose fluid boxes stay hidden without a fluid recipe,
 *  the recipe that opens the most of them — so turning the machine visibly
 *  moves its pipe connections. */
function fluidRecipeFor(name: string): string | undefined {
  const machine = data.machines[name];
  const points = visual(name).pipeConnections;
  if (!machine || !points?.some((p) => p.boxesOffWhenNoFluidRecipe)) return undefined;
  let best: string | undefined;
  let bestCount = 0;
  for (const recipe of Object.values(data.recipes).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!machine.categories.includes(recipe.category)) continue;
    const count = activeFluidConnections(points, recipe.name, data).length;
    if (count > bestCount) {
      best = recipe.name;
      bestCount = count;
    }
  }
  return best;
}

interface CatalogueEntry {
  name: string;
  group: string;
  subgroup: string;
  key: string;
}

function catalogueEntries(): CatalogueEntry[] {
  const groupOrder = new Map(catalog.menuGroups.map((g) => [g.name, g.order]));
  const out: CatalogueEntry[] = [];
  for (const name of lookup.keys()) {
    if (ALIASES.has(name)) continue;
    // Track pieces have a chapter of their own.
    if (isRail(name) || name === "rail-support") continue;
    const pos = catalog.menuPositions[name];
    const group = pos?.group ?? "other";
    const subgroup = pos?.subgroup ?? "other";
    out.push({
      name,
      group,
      subgroup,
      key: `${groupOrder.get(group) ?? "z"}|${pos?.subgroupOrder ?? "z"}|${subgroup}|${pos?.order ?? name}`,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const isSprite = (s: unknown): s is Sprite => typeof s === "object" && s !== null && typeof (s as Sprite).frameWidth === "number";

/** How far a building's art reaches from its centre, in tiles, over every
 *  facing — shadows aside, which may run into the next cell. */
function artReach(name: string): number {
  let reach = 0;
  for (const layer of visual(name).graphics?.layers ?? []) {
    if (layer.layer === Layer.Shadow || !("sprites" in layer) || ("per" in layer && layer.per === "connection")) continue;
    const sprites: unknown[] = "per" in layer ? Object.values(layer.sprites) : [layer.sprites];
    for (const s of sprites) {
      if (!isSprite(s)) continue;
      const scale = s.scale ?? 1;
      const [sx, sy] = s.shift ?? [0, 0];
      reach = Math.max(reach, (s.frameWidth * scale) / 64 + Math.abs(sx), (s.frameHeight * scale) / 64 + Math.abs(sy));
    }
  }
  return reach;
}

/** One building's row: each facing in its own square cell, N E S W left to
 *  right, undergrounds and loaders once as entrance and once as exit. A
 *  cell is as wide as the footprint, or nearly as wide as the art where
 *  that reaches much further (a train stop's platform). */
function facingStrip(name: string, extra: Partial<Ent> = {}): Sheet {
  const sheet = new Sheet();
  const dirs = facings(name);
  const types: ("input" | "output" | undefined)[] = isUndergroundLike(name) ? ["input", "output"] : [undefined];
  const [w, h] = visual(name).tileFootprint;
  const cell = Math.max(Math.ceil(Math.max(w, h)), Math.ceil(2 * artReach(name)) - 2);
  const pitch = cell + 1;
  // Blank cells between the entrances and the exits, enough that the east
  // entrance can't reach the east exit and pair with it: each is meant to
  // stand alone.
  const reach = data.undergroundBelts?.[name]?.maxDistance ?? 0;
  const gap = Math.max(1, Math.floor(reach / pitch) - dirs.length + 1);
  let i = 0;
  for (const undergroundType of types) {
    for (const direction of dirs) {
      const [sx, sy] = footprintOf({ name, direction });
      const cx = i * pitch + cell / 2;
      sheet.add({ name, x: snap(cx, sx), y: snap(cell / 2, sy), direction, undergroundType, ...extra });
      i++;
    }
    i += gap;
  }
  return sheet;
}

/** Buildings that never turn, side by side on one line, wrapping. */
function staticLine(names: string[], maxWidth: number): Sheet {
  const sheet = new Sheet();
  let x = 0, y = 0, lineHeight = 0;
  for (const name of names) {
    const [w, h] = visual(name).tileFootprint;
    if (x > 0 && x + w > maxWidth) {
      x = 0;
      y += lineHeight + 2;
      lineHeight = 0;
    }
    sheet.add({ name, x: snap(x + w / 2, w), y: snap(y + h / 2, h), recipe: fluidRecipeFor(name) });
    x += Math.ceil(w) + 1;
    lineHeight = Math.max(lineHeight, Math.ceil(h));
  }
  return sheet;
}

function buildingSections(): Block[] {
  const bySubgroup = new Map<string, CatalogueEntry[]>();
  for (const entry of catalogueEntries()) {
    const key = `${entry.group}/${entry.subgroup}`;
    bySubgroup.set(key, [...(bySubgroup.get(key) ?? []), entry]);
  }
  const sections: Block[] = [];
  for (const entries of bySubgroup.values()) {
    const names = entries.map((e) => e.name);
    const statics = names.filter((n) => facings(n).length === 1 && !isUndergroundLike(n));
    const turning = names.filter((n) => !statics.includes(n));
    const rows: Block[] = [];
    if (statics.length) rows.push({ sheet: staticLine(statics, 40) });
    for (const name of turning) rows.push({ sheet: facingStrip(name, { recipe: fluidRecipeFor(name) }) });
    const subgroup = entries[0]!.subgroup;
    sections.push({
      title: `[item=${iconFor(names)}] ${SUBGROUP_TITLES[subgroup] ?? subgroup}`,
      sheet: stack(rows, 2),
    });
  }
  return sections;
}

/** An item icon for a heading: the first of `names` that is an item. */
function iconFor(names: string[]): string {
  return names.find((n) => n in data.items) ?? "item-unknown";
}

/* ====================================================================== */
/* 2. Belts                                                                */
/* ====================================================================== */

const TIERS = [
  { belt: "transport-belt", underground: "underground-belt", splitter: "splitter", loader: "loader" },
  { belt: "fast-transport-belt", underground: "fast-underground-belt", splitter: "fast-splitter", loader: "fast-loader" },
  { belt: "express-transport-belt", underground: "express-underground-belt", splitter: "express-splitter", loader: "express-loader" },
  { belt: "turbo-transport-belt", underground: "turbo-underground-belt", splitter: "turbo-splitter", loader: "turbo-loader" },
];

const belt = (x: number, y: number, d: number, name = "transport-belt") => part(name, x, y, d);
const ugIn = (x: number, y: number, d: number, name = "underground-belt") => part(name, x, y, d, { undergroundType: "input" });
const ugOut = (x: number, y: number, d: number, name = "underground-belt") => part(name, x, y, d, { undergroundType: "output" });

/** A North-designed group shown in all four facings, side by side, each in
 *  a `cell`-wide square around (0, 0) of the design. */
function fourWays(design: Part[], cell: number, ox = 0, oy = 0, sheet = new Sheet()): Sheet {
  DIRECTIONS.forEach((dir, i) => placeGroup(sheet, design, dir, ox + i * (cell + 1) + cell / 2, oy + cell / 2));
  return sheet;
}

/** A table of North-designed cases: rows × columns, each cell the case in
 *  all four facings, with row and column headings. */
function matrix(rows: string[], cols: string[], cell: number, design: (row: number, col: number) => Part[]): Sheet {
  const sheet = new Sheet();
  const cellWidth = 4 * (cell + 1);
  const colPitch = cellWidth + 3;
  const rowPitch = cell + 2;
  const labelX = -8;
  cols.forEach((title, c) => label(sheet, c * colPitch + cellWidth / 2 - 0.5, -2.5, title));
  rows.forEach((title, r) => {
    label(sheet, labelX + 0.5, r * rowPitch + cell / 2, title);
    cols.forEach((_, c) => fourWays(design(r, c), cell, c * colPitch, r * rowPitch, sheet));
  });
  return sheet;
}

/** Every neighbourhood a belt tile can see: what feeds it (nothing, from
 *  behind, either side, or a mix — a lone side feed bends it into a
 *  curve), crossed with what it runs into (open space, more belt, a belt
 *  it bends, a run it side-loads, a belt facing back at it). */
function beltNeighbourMatrix(): Sheet {
  const inputs: { title: string; behind: boolean; left: boolean; right: boolean }[] = [
    { title: "fed: nothing", behind: false, left: false, right: false },
    { title: "fed: behind", behind: true, left: false, right: false },
    { title: "fed: left", behind: false, left: true, right: false },
    { title: "fed: right", behind: false, left: false, right: true },
    { title: "fed: behind+left", behind: true, left: true, right: false },
    { title: "fed: behind+right", behind: true, left: false, right: true },
    { title: "fed: left+right", behind: false, left: true, right: true },
    { title: "fed: all three", behind: true, left: true, right: true },
  ];
  const outputs: { title: string; parts: Part[] }[] = [
    { title: "ahead: open", parts: [] },
    { title: "ahead: straight", parts: [belt(0, -1, N)] },
    { title: "ahead: turns it", parts: [belt(0, -1, E)] },
    { title: "ahead: side-loads a run", parts: [belt(-1, -1, E), belt(0, -1, E)] },
    { title: "ahead: nose to nose", parts: [belt(0, -1, S)] },
  ];
  return matrix(
    inputs.map((i) => i.title),
    outputs.map((o) => o.title),
    3,
    (r, c) => {
      const input = inputs[r]!;
      const parts = [belt(0, 0, N)];
      if (input.behind) parts.push(belt(0, 1, N));
      if (input.left) parts.push(belt(-1, 0, E));
      if (input.right) parts.push(belt(1, 0, W));
      return [...parts, ...outputs[c]!.parts];
    },
  );
}

/** Splitter lanes: which of the two inputs and two outputs carry belt. */
function splitterMatrix(): Sheet {
  const sides = [
    { title: "none", lanes: [] as number[] },
    { title: "left", lanes: [-0.5] },
    { title: "right", lanes: [0.5] },
    { title: "both", lanes: [-0.5, 0.5] },
  ];
  return matrix(
    sides.map((s) => `in: ${s.title}`),
    sides.map((s) => `out: ${s.title}`),
    3,
    (r, c) => [
      part("splitter", 0, 0, N),
      ...sides[r]!.lanes.map((x) => belt(x, 1, N)),
      ...sides[c]!.lanes.map((x) => belt(x, -1, N)),
    ],
  );
}

/** Underground entrance and exit states, built facing North. */
function undergroundCases(): { title: string; parts: Part[]; cell: number }[] {
  return [
    { title: "entrance, open", cell: 3, parts: [ugIn(0, 0, N)] },
    { title: "entrance, fed", cell: 3, parts: [ugIn(0, 0, N), belt(0, 1, N)] },
    { title: "entrance, side-loaded left", cell: 3, parts: [ugIn(0, 0, N), belt(-1, 0, E)] },
    { title: "entrance, side-loaded right", cell: 3, parts: [ugIn(0, 0, N), belt(1, 0, W)] },
    { title: "entrance, side-loaded both", cell: 3, parts: [ugIn(0, 0, N), belt(-1, 0, E), belt(1, 0, W)] },
    { title: "exit, open", cell: 3, parts: [ugOut(0, 0, N)] },
    { title: "exit, continues", cell: 3, parts: [ugOut(0, 0, N), belt(0, -1, N)] },
    { title: "exit, side-loaded left", cell: 3, parts: [ugOut(0, 0, N), belt(-1, 0, E)] },
    { title: "exit, side-loaded right", cell: 3, parts: [ugOut(0, 0, N), belt(1, 0, W)] },
    { title: "exit into a curve", cell: 3, parts: [ugOut(0, 0, N), belt(0, -1, E)] },
    { title: "pair, no gap", cell: 4, parts: [ugIn(0, 1, N), ugOut(0, 0, N), belt(0, 2, N), belt(0, -1, N)] },
    { title: "pair, longest gap", cell: 8, parts: [ugIn(0, 5, N), ugOut(0, 0, N), belt(0, 6, N), belt(0, -1, N)] },
    { title: "exit straight into entrance", cell: 7, parts: [ugIn(0, 4, N), ugOut(0, 2, N), ugIn(0, 1, N), ugOut(0, -1, N), belt(0, 5, N), belt(0, -2, N)] },
    { title: "weave: yellow over red", cell: 7, parts: [ugIn(0, 4, N), ugIn(0, 3, N, "fast-underground-belt"), ugOut(0, 1, N, "fast-underground-belt"), ugOut(0, 0, N), belt(0, 5, N), belt(0, -1, N)] },
  ];
}

/** Loader in each direction: an input loader carries belt into the box in
 *  front of it, an output loader carries out of the box behind it. */
function loaderSection(): Sheet {
  const rows: Block[] = [];
  for (const name of ["loader-1x1", ...TIERS.map((t) => t.loader)]) {
    const long = visual(name).tileFootprint[1] > 1;
    const end = long ? 1.5 : 1;
    const sheet = new Sheet();
    fourWays([part(name, 0, 0, N, { undergroundType: "input" }), part("wooden-chest", 0, -end), belt(0, end, N)], 5, 0, 0, sheet);
    fourWays([part(name, 0, 0, N, { undergroundType: "output" }), part("wooden-chest", 0, end), belt(0, -end, N)], 5, 4 * 6 + 2, 0, sheet);
    rows.push({ title: `[item=${name}] ${name}: input ×4, output ×4`, sheet });
  }
  return stack(rows, 1);
}

/** Per tier: a clockwise and an anticlockwise loop (all eight curve
 *  sprites), an underground pair at the tier's full reach, a splitter
 *  between belts, and loaders filling and emptying a chest. */
function tierSampler(): Sheet {
  const rows: Block[] = [];
  for (const tier of TIERS) {
    const sheet = new Sheet();
    const b = (x: number, y: number, d: number) => belt(x, y, d, tier.belt);
    const cw = [b(-1, -1, E), b(0, -1, E), b(1, -1, S), b(1, 0, S), b(1, 1, W), b(0, 1, W), b(-1, 1, N), b(-1, 0, N)];
    const ccw = [b(-1, -1, S), b(-1, 0, S), b(-1, 1, E), b(0, 1, E), b(1, 1, N), b(1, 0, N), b(1, -1, W), b(0, -1, W)];
    placeGroup(sheet, cw, N, 1.5, 1.5);
    placeGroup(sheet, ccw, N, 6.5, 1.5);
    const reach = data.undergroundBelts?.[tier.underground]?.maxDistance ?? 5;
    const line: Part[] = [b(0, 0, E), ugIn(1, 0, E, tier.underground), ugOut(1 + reach, 0, E, tier.underground), b(2 + reach, 0, E)];
    placeGroup(sheet, line, N, 10.5, 1.5);
    const split = 16 + reach;
    placeGroup(sheet, [part(tier.splitter, 0, 0, E), b(-1, -0.5, E), b(-1, 0.5, E), b(1, -0.5, E), b(1, 0.5, E)], N, split + 1.5, 1);
    const loaders = split + 6;
    placeGroup(sheet, [b(0, 0, E), part(tier.loader, 1.5, 0, E, { undergroundType: "input" }), part("wooden-chest", 3, 0), part(tier.loader, 4.5, 0, E, { undergroundType: "output" }), b(6, 0, E)], N, loaders + 0.5, 1.5);
    rows.push({ title: `[item=${tier.belt}] ${tier.belt}`, sheet });
  }
  // Tier changes mid-run, straight and on a curve.
  const mixed = new Sheet();
  const run: Part[] = [];
  TIERS.forEach((t, i) => {
    for (let k = 0; k < 3; k++) run.push(belt(i * 3 + k, 0, E, t.belt));
  });
  placeGroup(mixed, run, N, 0.5, 0.5);
  TIERS.forEach((t, i) => {
    const next = TIERS[(i + 1) % TIERS.length]!;
    placeGroup(mixed, [belt(0, 0, N, t.belt), belt(0, -1, E, next.belt), belt(1, -1, E, next.belt)], N, 14.5 + i * 4, 1.5);
  });
  rows.push({ title: "Tier changes: straight and on a curve", sheet: mixed });
  return stack(rows, 1);
}

/* The named belt cases below were each once a real renderer bug. They keep
 * their original coordinates (whole tiles around a cell anchor) because
 * BUG_REPRO_BLUEPRINT is built from them unchanged. */

interface Spec {
  name: string;
  x: number;
  y: number;
  direction?: number;
}

/** Rotates a relative (dx,dy) offset — expressed for a North-facing
 *  reference case — to match `dir`. */
function rotate(dx: number, dy: number, dir: number): { dx: number; dy: number } {
  const [x, y] = rotOffset(dx, dy, dir);
  return { dx: x, dy: y };
}

interface BeltState {
  label: string;
  height: number;
  build: (specs: Spec[], cx: number, cy: number, dir: number) => void;
}

/** Places a transport belt at `(cx,cy)` shifted by (dx,dy) rotated for
 *  `dir`, facing `baseFacing` rotated the same way. */
function at(specs: Spec[], cx: number, cy: number, dx: number, dy: number, baseFacing: number, dir: number): void {
  const p = rotate(dx, dy, dir);
  specs.push({ name: "transport-belt", x: cx + p.dx, y: cy + p.dy, direction: (baseFacing + dir) % 16 });
}

/** Belt cases that were once genuine renderer bugs, built for North and
 *  rotated into place per column. */
function beltStates(): BeltState[] {
  return [
    {
      label: "isolated",
      height: 3,
      build: (specs, cx, cy, dir) => at(specs, cx, cy, 0, 1, N, dir),
    },
    {
      label: "straight run",
      height: 5,
      build: (specs, cx, cy, dir) => {
        for (let j = -1; j <= 1; j++) at(specs, cx, cy, 0, 1 + j, N, dir);
      },
    },
    {
      label: "back to back",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // Two belts facing AWAY from each other, adjacent, neither feeding
        // nor fed by the other: each start cap must stay suppressed at the
        // shared seam, since the neighbour is physically there
        // (occupiesConnection in beltGraph.ts).
        at(specs, cx, cy, 0, 0, N, dir);
        at(specs, cx, cy, 0, 1, S, dir);
      },
    },
    {
      label: "nose to nose",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // The mirror case: two belts facing TOWARD each other, adjacent,
        // neither feeding the other. Each end cap used to render at the
        // shared seam.
        at(specs, cx, cy, 0, 0, S, dir);
        at(specs, cx, cy, 0, 1, N, dir);
      },
    },
    {
      label: "curve, fed left",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, cx, cy, 0, 1, N, dir); // the curve itself
        at(specs, cx, cy, -1, 1, E, dir); // west neighbour, facing east into it
      },
    },
    {
      label: "curve, fed right",
      height: 3,
      build: (specs, cx, cy, dir) => {
        at(specs, cx, cy, 0, 1, N, dir);
        at(specs, cx, cy, 1, 1, W, dir); // east neighbour, facing west into it
      },
    },
    {
      label: "curve, continues",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // A right-hand curve feeding a straight belt ahead of it — the
        // curve's own end draws no cap once something continues past it.
        at(specs, cx, cy, 0, 1, N, dir);
        at(specs, cx, cy, 1, 1, W, dir);
        at(specs, cx, cy, 0, 0, N, dir);
      },
    },
    {
      label: "T-merge",
      height: 5,
      build: (specs, cx, cy, dir) => {
        for (let j = -1; j <= 1; j++) at(specs, cx, cy, 0, 1 + j, N, dir);
        at(specs, cx, cy, -1, 1, E, dir); // side feed into the middle tile
      },
    },
    {
      label: "side-load only",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // A 3-belt row with a belt dropping onto its centre from the side
        // that row doesn't actually feed from.
        for (let j = -1; j <= 1; j++) at(specs, cx, cy, j, 1, E, dir);
        at(specs, cx, cy, 0, 0, S, dir);
      },
    },
    {
      label: "T-cross, cap over row",
      height: 4,
      build: (specs, cx, cy, dir) => {
        // Same shape as "side-load only" plus one more tile of the feeder
        // belt above it, so the feeder's own end cap — which lands a full
        // tile past its own last belt, right on top of the row tile it
        // drops onto — has to win its paint-order fight against that row
        // tile.
        for (let j = -1; j <= 1; j++) at(specs, cx, cy, j, 1, E, dir);
        at(specs, cx, cy, 0, 0, S, dir);
        at(specs, cx, cy, 0, -1, S, dir);
      },
    },
    {
      label: "curve, fed left (curve placed last)",
      height: 3,
      build: (specs, cx, cy, dir) => {
        // Same shape as "curve, fed left" but with the feeder pushed BEFORE
        // the curve tile: the feeder's end cap and the curve's body can
        // land at the exact same sort-y, and without an explicit
        // tie-breaker the cap's visibility depended on placement order.
        at(specs, cx, cy, -1, 1, E, dir); // feeder pushed first
        at(specs, cx, cy, 0, 1, N, dir); // curve pushed last
      },
    },
    {
      label: "curve, fed straight from behind",
      height: 4,
      build: (specs, cx, cy, dir) => {
        // A curve fed only from the side with a straight belt feeding the
        // FEEDER — the feeder itself draws no spurious end cap where it
        // runs straight into the curve's mouth.
        at(specs, cx, cy, 0, 1, N, dir); // the curve
        at(specs, cx, cy, 1, 1, W, dir); // feeds the curve from the east
        at(specs, cx, cy, 2, 1, W, dir); // feeds the feeder, straight run
      },
    },
  ];
}

/** The once-buggy belt cases, each in all four facings, in labelled cells.
 *  The specs sit on whole-tile corners; a belt centres on a half tile, so
 *  everything moves half a tile. */
function beltRegressionBlocks(): Block[] {
  return beltStates().map((state) => {
    const specs: Spec[] = [];
    DIRECTIONS.forEach((dir, col) => state.build(specs, col * 6 + 2, 2, dir));
    const sheet = new Sheet();
    for (const s of specs) sheet.add({ name: s.name, x: s.x + 0.5, y: s.y + 0.5, direction: s.direction ?? 0 });
    return { title: state.label, sheet };
  });
}

/** Lays a list of belt states out into rows, one column per facing — the
 *  BUG_REPRO_BLUEPRINT layout. */
function layoutBeltFamilyStates(states: BeltState[], originX: number, originY: number): Spec[] {
  const colWidth = 4;
  const rowHeight = Math.max(...states.map((s) => s.height)) + 1;
  const specs: Spec[] = [];
  states.forEach((state, row) => {
    const cy = originY + row * rowHeight + 2;
    DIRECTIONS.forEach((dir, col) => state.build(specs, originX + col * colWidth + 1, cy, dir));
  });
  return specs;
}

/** A small, quick-to-eyeball subset of beltStates — just the cases that were
 *  once genuine renderer bugs. Picked by label so this can't silently drift
 *  out of sync with beltStates' own geometry. */
function bugReproStates(): BeltState[] {
  const labels = [
    "back to back",
    "nose to nose",
    "curve, fed left",
    "curve, fed right",
    "curve, fed left (curve placed last)",
    "curve, fed straight from behind",
    "T-cross, cap over row",
  ];
  const byLabel = new Map(beltStates().map((s) => [s.label, s]));
  return labels.map((name) => {
    const state = byLabel.get(name);
    if (!state) throw new Error(`bugReproStates: no beltStates entry labelled "${name}" (renamed or removed?)`);
    return state;
  });
}

function beltChapter(): Chapter {
  return {
    title: "[item=transport-belt] [font=heading-1]Belts[/font]",
    sections: [
      { title: "[item=transport-belt] Belt neighbour matrix — each cell N E S W", sheet: beltNeighbourMatrix() },
      { title: "[item=splitter] Splitter lanes — each cell N E S W", sheet: splitterMatrix() },
      { title: "[item=underground-belt] Underground belts", sheet: flow(undergroundCases().map((c) => ({ title: c.title, sheet: fourWays(c.parts, c.cell) })), 80, 4, 2) },
      { title: "[item=loader] Loaders with chests", sheet: loaderSection() },
      { title: "[item=turbo-transport-belt] Every tier: loops, reach, splitter, loaders", sheet: tierSampler() },
      { title: "[item=transport-belt] Belt cases that were once bugs", sheet: flow(beltRegressionBlocks(), 80, 4, 2) },
    ],
  };
}

/* ====================================================================== */
/* 3. Fluids, heat & walls                                                 */
/* ====================================================================== */

/** The sixteen ways a 4-way connector can have neighbours: none, the four
 *  dead ends, two straights, four corners, four T-junctions and the cross. */
const NEIGHBOUR_SETS: number[][] = [
  [],
  [N], [E], [S], [W],
  [N, S], [E, W],
  [N, E], [E, S], [S, W], [W, N],
  [N, E, W], [N, E, S], [E, S, W], [N, S, W],
  [N, E, S, W],
];

function connectorShapes(name: string): Sheet {
  const sheet = new Sheet();
  NEIGHBOUR_SETS.forEach((dirs, i) => {
    const cx = (i % 8) * 4 + 1.5;
    const cy = Math.floor(i / 8) * 4 + 1.5;
    sheet.add({ name, x: cx, y: cy });
    for (const d of dirs) {
      const [dx, dy] = STEP[d]!;
      sheet.add({ name, x: cx + dx, y: cy + dy });
    }
  });
  return sheet;
}

/** A connection point turned to the entity's facing, the way the renderer's
 *  fluid and heat networks turn it. */
function worldPoint(
  p: { x: number; y: number; direction: number; positionsByDirection?: [number, number][]; fixed?: boolean },
  dir: number,
): { x: number; y: number; direction: number } {
  if (p.fixed) dir = N;
  const steps = Math.round(dir / 4) % 4;
  const direction = (p.direction + steps * 4) % 16;
  if (p.positionsByDirection) {
    const [x, y] = p.positionsByDirection[steps]!;
    return { x, y, direction };
  }
  const [x, y] = rotOffset(p.x, p.y, dir);
  return { x, y, direction };
}

/** Puts a pipe (or heat pipe) on every port of an entity already on the
 *  sheet, so its connected-port art shows. Plasma ports take only fusion
 *  plumbing and are left open. */
function plumb(sheet: Sheet, index: number, kind: "pipe" | "heat-pipe"): void {
  const e = sheet.ents[index]!;
  const v = visual(e.name);
  let points: (PipeConnectionPoint | { x: number; y: number; direction: number })[] =
    kind === "pipe" ? (v.pipeConnections ?? []) : (v.heatConnections ?? []);
  if (kind === "pipe") {
    points = activeFluidConnections(points as PipeConnectionPoint[], e.recipe, data).filter((p) => !p.connectionCategory?.length || p.connectionCategory.includes("default"));
  }
  const seen = new Set<string>();
  for (const p of points) {
    const w = worldPoint(p as PipeConnectionPoint, e.direction ?? 0);
    // The fluid and heat networks key a port by its rounded centre-plus-
    // offset; a pipe matches it from the next key over, and a pipe at
    // (k - 0.5) rounds to k.
    const [dx, dy] = STEP[w.direction]!;
    const x = Math.round(e.x + w.x) + dx - 0.5;
    const y = Math.round(e.y + w.y) + dy - 0.5;
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sheet.add({ name: kind, x, y });
  }
}

/** One building, four facings, every port connected. */
function plumbedStrip(name: string, kind: "pipe" | "heat-pipe", alsoPipes = false): Sheet {
  const sheet = new Sheet();
  const [w, h] = visual(name).tileFootprint;
  const cell = Math.ceil(Math.max(w, h)) + 2;
  const recipe = fluidRecipeFor(name);
  facings(name).forEach((direction, i) => {
    const [sx, sy] = footprintOf({ name, direction });
    const index = sheet.add({ name, x: snap(i * (cell + 2) + cell / 2, sx), y: snap(cell / 2, sy), direction, recipe });
    plumb(sheet, index, kind);
    if (alsoPipes) plumb(sheet, index, "pipe");
  });
  return sheet;
}

function pipeToGroundSection(): Sheet {
  const ptg = (x: number, y: number, d: number) => part("pipe-to-ground", x, y, d);
  const cases: { title: string; cell: number; parts: Part[] }[] = [
    { title: "with a pipe", cell: 3, parts: [ptg(0, 0, N), part("pipe", 0, -1)] },
    { title: "pair, no gap", cell: 4, parts: [ptg(0, 0, N), ptg(0, 1, S), part("pipe", 0, -1), part("pipe", 0, 2)] },
    { title: "pair, longest gap", cell: 13, parts: [ptg(0, 0, N), ptg(0, 10, S), part("pipe", 0, -1), part("pipe", 0, 11)] },
  ];
  return flow(cases.map((c) => ({ title: c.title, sheet: fourWays(c.parts, c.cell) })), 120, 4, 2);
}

/** Pumps and the three valves, piped on both sides. The offshore pump is
 *  left to the buildings chapter: its port sits at its centre, and the
 *  renderer centres its 1.2×2 footprint on the entity, so the tile its pipe
 *  belongs on reads as taken (the game's own box is off-centre). */
function pumpSection(): Sheet {
  const rows: Block[] = [];
  for (const name of ["pump", "one-way-valve", "overflow-valve", "top-up-valve"]) {
    rows.push({ title: `[item=${name}] ${name}`, sheet: plumbedStrip(name, "pipe") });
  }
  return stack(rows, 1);
}

/** Every other building with fluid ports, connected in every facing. */
function fluidBuildingsSection(): Sheet {
  const skip = new Set(["pipe", "pipe-to-ground", "pump", "one-way-valve", "overflow-valve", "top-up-valve", "offshore-pump", "heat-exchanger", "boiler"]);
  const names = catalogueEntries()
    .map((e) => e.name)
    .filter((n) => visual(n).pipeConnections?.length && !skip.has(n));
  return flow(names.map((name) => ({ title: `[item=${iconFor([name])}] ${name}`, sheet: plumbedStrip(name, "pipe") })), 130, 4, 2);
}

function heatSection(): Sheet {
  const blocks: Block[] = [];
  blocks.push({ title: "[item=heat-pipe] heat pipe shapes", sheet: connectorShapes("heat-pipe") });
  const reactor = new Sheet();
  plumb(reactor, reactor.add({ name: "nuclear-reactor", x: 3.5, y: 3.5 }), "heat-pipe");
  blocks.push({ title: "[item=nuclear-reactor] every port", sheet: reactor });
  const block = new Sheet();
  for (const [x, y] of [[0, 0], [5, 0], [0, 5], [5, 5]] as const) block.add({ name: "nuclear-reactor", x: x + 2.5, y: y + 2.5 });
  blocks.push({ title: "[item=nuclear-reactor] 2×2 reactors", sheet: block });
  const tower = new Sheet();
  plumb(tower, tower.add({ name: "heating-tower", x: 2.5, y: 2.5 }), "heat-pipe");
  plumb(tower, tower.add({ name: "heat-interface", x: 8.5, y: 2.5 }), "heat-pipe");
  blocks.push({ title: "[item=heating-tower] tower, heat interface", sheet: tower });
  blocks.push({ title: "[item=heat-exchanger] heat exchanger", sheet: plumbedStrip("heat-exchanger", "heat-pipe", true) });
  blocks.push({ title: "[item=boiler] boiler", sheet: plumbedStrip("boiler", "pipe") });
  return flow(blocks, 120, 4, 2);
}

function wallSection(): Sheet {
  const blocks: Block[] = [{ title: "[item=stone-wall] wall shapes", sheet: connectorShapes("stone-wall") }];
  const gates = new Sheet();
  // A north-facing gate is the game's vertical gate, set in a wall that runs
  // north-south; an east-facing one sits in a wall running east-west.
  for (let x = 0; x < 9; x++) gates.add({ name: x === 3 || x === 4 ? "gate" : "stone-wall", x: x + 0.5, y: 0.5, direction: E });
  for (let y = 0; y < 9; y++) gates.add({ name: y === 3 || y === 4 ? "gate" : "stone-wall", x: 12.5, y: y + 2.5, direction: N });
  // Gates straight off a wall corner and a T.
  for (const [x, y, n] of [[0, 3, "stone-wall"], [0, 4, "stone-wall"], [1, 4, "gate"], [2, 4, "gate"], [3, 3, "stone-wall"], [3, 4, "stone-wall"], [3, 5, "stone-wall"]] as const) {
    gates.add({ name: n, x: x + 0.5, y: y + 0.5, direction: n === "gate" ? E : N });
  }
  blocks.push({ title: "[item=gate] gates in walls", sheet: gates });
  return flow(blocks, 80, 4, 2);
}

function fluidChapter(): Chapter {
  return {
    title: "[item=pipe] [font=heading-1]Fluids, heat & walls[/font]",
    sections: [
      { title: "[item=pipe] Pipe shapes", sheet: connectorShapes("pipe") },
      { title: "[item=pipe-to-ground] Pipe to ground — N E S W", sheet: pipeToGroundSection() },
      { title: "[item=pump] Pumps & valves, piped", sheet: pumpSection() },
      { title: "[item=chemical-plant] Fluid buildings, every port piped", sheet: fluidBuildingsSection() },
      { title: "[item=nuclear-reactor] Heat", sheet: heatSection() },
      { title: "[item=stone-wall] Walls & gates", sheet: wallSection() },
    ],
  };
}

/* ====================================================================== */
/* 4. Power & circuits                                                     */
/* ====================================================================== */

/** Spacing per pole, straight and diagonal — close enough to read the
 *  facings at a glance, all well inside each pole's reach. */
const POLES: { name: string; d: number; diag: number }[] = [
  { name: "small-electric-pole", d: 5, diag: 4 },
  { name: "medium-electric-pole", d: 6, diag: 5 },
  { name: "substation", d: 8, diag: 6 },
  { name: "big-electric-pole", d: 10, diag: 8 },
];

/** Each pole wired every way a run of poles goes — along a row (with red
 *  and green too), down a column, both diagonals, and as a hub with four
 *  straight or four diagonal spokes. Every end pole turns to face its one
 *  wire; the middles average theirs. */
function poleFacingSection(): Sheet {
  const rows: Block[] = [];
  for (const { name, d, diag } of POLES) {
    const shapes: { title: string; points: [number, number][]; links: [number, number][]; circuit?: boolean }[] = [
      { title: "row", points: [[0, 0], [d, 0], [2 * d, 0]], links: [[0, 1], [1, 2]], circuit: true },
      { title: "column", points: [[0, 0], [0, d], [0, 2 * d]], links: [[0, 1], [1, 2]] },
      { title: "diagonal ↘", points: [[0, 0], [diag, diag], [2 * diag, 2 * diag]], links: [[0, 1], [1, 2]] },
      { title: "diagonal ↗", points: [[0, 2 * diag], [diag, diag], [2 * diag, 0]], links: [[0, 1], [1, 2]] },
      { title: "hub", points: [[0, 0], [0, -d], [d, 0], [0, d], [-d, 0]], links: [[0, 1], [0, 2], [0, 3], [0, 4]] },
      { title: "diagonal hub", points: [[0, 0], [diag, -diag], [diag, diag], [-diag, diag], [-diag, -diag]], links: [[0, 1], [0, 2], [0, 3], [0, 4]] },
    ];
    const blocks: Block[] = shapes.map((shape) => {
      const sheet = new Sheet();
      const refs = placeGroup(sheet, shape.points.map(([x, y]) => part(name, x, y)), N, 0.5, 0.5);
      for (const [a, b] of shape.links) {
        sheet.wire("copper", refs[a]!, refs[b]!);
        if (shape.circuit) {
          sheet.wire("red", refs[a]!, refs[b]!);
          sheet.wire("green", refs[a]!, refs[b]!);
        }
      }
      return { title: shape.title, sheet };
    });
    rows.push({ title: `[item=${name}] ${name}`, sheet: flow(blocks, 400, 4, 2) });
  }
  return stack(rows, 2);
}

/** Every tier wired to every other, red and green alongside; a wire longer
 *  than either pole reaches (drawn faded, like the game's ghost of one);
 *  and the power switch between two poles. */
function poleMixSection(): Sheet {
  const blocks: Block[] = [];
  const chain = new Sheet();
  // small-medium, medium-big, big-small, small-substation, substation-medium,
  // (medium-big again,) big-substation: all six pairs, each within the
  // shorter pole's reach.
  const refs = [
    chain.add({ name: "small-electric-pole", x: 0.5, y: 0.5 }),
    chain.add({ name: "medium-electric-pole", x: 6.5, y: 0.5 }),
    chain.add({ name: "big-electric-pole", x: 14, y: 1 }),
    chain.add({ name: "small-electric-pole", x: 20.5, y: 0.5 }),
    chain.add({ name: "substation", x: 26, y: 1 }),
    chain.add({ name: "medium-electric-pole", x: 32.5, y: 0.5 }),
    chain.add({ name: "big-electric-pole", x: 40, y: 1 }),
    chain.add({ name: "substation", x: 54, y: 1 }),
  ];
  chain.chain(["copper", "red", "green"], refs);
  blocks.push({ title: "every tier to every tier", sheet: chain });

  const far = new Sheet();
  far.wire("copper", far.add({ name: "small-electric-pole", x: 0.5, y: 0.5 }), far.add({ name: "small-electric-pole", x: 14.5, y: 0.5 }));
  blocks.push({ title: "out of reach (faded)", sheet: far });

  const sw = new Sheet();
  const left = sw.add({ name: "medium-electric-pole", x: 0.5, y: 0.5 });
  const swRef = sw.add({ name: "power-switch", x: 5, y: 1 });
  const right = sw.add({ name: "medium-electric-pole", x: 9.5, y: 0.5 });
  sw.wire("copper", left, swRef, 1, 1);
  sw.wire("copper", right, swRef, 1, 2);
  sw.wire("red", left, swRef);
  sw.wire("green", right, swRef);
  blocks.push({ title: "[item=power-switch] power switch: copper left and right", sheet: sw });
  return flow(blocks, 200, 6, 2);
}

const signal = (name: string) => ({ type: "virtual", name });

/** The arithmetic, decider and selector combinators, each facing all four
 *  ways: a constant combinator into its input, a lamp off its output, both
 *  colours on both sides. The constant combinator turns too. */
function combinatorSection(): Sheet {
  const constant: BpControlBehavior = {
    sections: { sections: [{ index: 1, filters: [{ index: 1, type: "virtual", name: "signal-A", quality: "normal", comparator: "=", count: 10 }] }] },
  };
  const lamp: BpControlBehavior = { circuit_enabled: true, circuit_condition: { first_signal: signal("signal-anything"), comparator: ">", constant: 0 } };
  const kinds: { name: string; behavior: BpControlBehavior }[] = [
    { name: "arithmetic-combinator", behavior: { arithmetic_conditions: { first_signal: signal("signal-A"), second_constant: 2, operation: "*", output_signal: signal("signal-B") } } },
    {
      name: "decider-combinator",
      behavior: { decider_conditions: { conditions: [{ first_signal: signal("signal-A"), constant: 0, comparator: ">" }], outputs: [{ signal: signal("signal-B") }] } },
    },
    { name: "selector-combinator", behavior: { operation: "select", select_max: true, index_constant: 0 } },
  ];
  const rows: Block[] = [];
  for (const kind of kinds) {
    const sheet = new Sheet();
    DIRECTIONS.forEach((dir, i) => {
      const [comb, cc, out] = placeGroup(
        sheet,
        [
          part(kind.name, 0, 0, N, { controlBehavior: kind.behavior }),
          part("constant-combinator", 0, 2.5, N, { controlBehavior: constant }),
          part("small-lamp", 0, -2.5, N, { controlBehavior: lamp }),
        ],
        dir,
        i * 8 + 3.5,
        3.5,
      );
      for (const color of ["red", "green"] as const) {
        sheet.wire(color, cc!, comb!, 1, 1);
        sheet.wire(color, comb!, out!, 2, 1);
      }
    });
    rows.push({ title: `[item=${kind.name}] ${kind.name}: input from a constant combinator, output to a lamp`, sheet });
  }
  const ccRow = new Sheet();
  DIRECTIONS.forEach((dir, i) => {
    const [cc, l] = placeGroup(ccRow, [part("constant-combinator", 0, 0, N, { controlBehavior: constant }), part("small-lamp", 0, -2, N, { controlBehavior: lamp })], dir, i * 6 + 2.5, 2.5);
    ccRow.wire("red", cc!, l!);
    ccRow.wire("green", cc!, l!);
  });
  rows.push({ title: "[item=constant-combinator] constant combinator to a lamp", sheet: ccRow });
  return stack(rows, 1);
}

/** Every building that takes a circuit wire, in build-menu order: red and
 *  green from a pole, then on from building to building while the next one
 *  is in a circuit wire's reach; a new pole starts the next run. Poles,
 *  combinators and the power switch have sections of their own. */
function circuitBuildingsSection(): Sheet {
  const ownSection = /electric-pole|substation|combinator|power-switch/;
  const names = catalogueEntries()
    .map((e) => e.name)
    .filter((n) => !ownSection.test(n) && canWire(visual(n), "red"));
  // Factorio's default circuit wire reach, centre to centre, with a margin.
  const REACH = 8.5;
  const blocks: Block[] = [];
  let group = new Sheet();
  let refs: number[] = [];
  let x = 0;
  const flush = () => {
    if (refs.length) {
      group.chain(["red", "green"], refs);
      blocks.push({ sheet: group });
    }
    group = new Sheet();
    refs = [];
    x = 0;
  };
  for (const name of names) {
    const [w, h] = visual(name).tileFootprint;
    const at = () => ({ x: snap(x + w / 2, w), y: snap(h / 2, h) });
    const prev = refs.length ? group.ents[refs[refs.length - 1]!]! : undefined;
    if (prev && (x > 30 || Math.hypot(at().x - prev.x, at().y - prev.y) > REACH)) flush();
    if (!refs.length) {
      refs.push(group.add({ name: "medium-electric-pole", x: 0.5, y: 0.5 }));
      x = 2;
    }
    const undergroundType = isUndergroundLike(name) ? "input" : undefined;
    refs.push(group.add({ name, ...at(), undergroundType }));
    x += Math.ceil(w) + 2;
  }
  flush();
  return flow(blocks, 120, 4, 3);
}

function powerChapter(): Chapter {
  return {
    title: "[item=medium-electric-pole] [font=heading-1]Power & circuit wires[/font]",
    sections: [
      { title: "[item=small-electric-pole] Pole facings: poles turn to face their wires", sheet: poleFacingSection() },
      { title: "[item=big-electric-pole] Mixed tiers & the power switch", sheet: poleMixSection() },
      { title: "[item=decider-combinator] Combinators — N E S W", sheet: combinatorSection() },
      { title: "[item=red-wire] Circuit wires to every wireable building", sheet: circuitBuildingsSection() },
    ],
  };
}

/* ====================================================================== */
/* 5. Rails                                                                */
/* ====================================================================== */

type TrackMove = "straight" | "left" | "right" | "ramp";

/** Lays track piece by piece, the way a player would: each move adds the one
 *  piece that continues the track from its current end — straight on, a
 *  22.5° curve left or right, or a ramp to the other layer. */
class Track {
  readonly pieces: RailPiece[] = [];
  /** The way the track runs through each piece, in step with `pieces`. */
  readonly headings: number[] = [];
  /** Every joint the track has laid, heading the way it was laid. */
  readonly joints: RailEnd[] = [];
  /** Where the track after the first piece starts. */
  readonly start: RailEnd;
  end: RailEnd;

  constructor(x: number, y: number, dir: number, elevated = false) {
    const s = startPiece(x, y, dir, elevated);
    this.pieces.push(s.piece);
    this.headings.push(s.end.dir);
    this.start = s.end;
    this.end = s.end;
    this.joints.push(s.end);
  }

  go(move: TrackMove, times = 1): this {
    for (let i = 0; i < times; i++) {
      this.end = this.step(move);
      this.headings.push(this.end.dir);
      this.joints.push(this.end);
    }
    return this;
  }

  private step(move: TrackMove): RailEnd {
    const at = this.end;
    const heading = move === "left" ? (at.dir + 15) % 16 : move === "right" ? (at.dir + 1) % 16 : at.dir;
    const names =
      move === "ramp" ? ["rail-ramp"]
      : move === "straight" ? [railName("straight", at.elevated), railName("half-diagonal", at.elevated)]
      : [railName("curved-a", at.elevated), railName("curved-b", at.elevated)];
    for (const name of names) {
      for (let direction = 0; direction < 16; direction += 2) {
        const ends = railEnds(name, direction);
        for (let i = 0; i < ends.length; i++) {
          const near = ends[i]!;
          const far = ends[1 - i]!;
          if (near.dir !== (at.dir + 8) % 16 || near.elevated !== at.elevated || far.dir !== heading) continue;
          const piece = { name, x: at.x - near.dx, y: at.y - near.dy, direction };
          this.pieces.push(piece);
          return { x: piece.x + far.dx, y: piece.y + far.dy, dir: far.dir, elevated: far.elevated };
        }
      }
    }
    throw new Error(`debug lab: no ${move} track continues from ${JSON.stringify(at)}`);
  }
}

/** A clockwise loop: four straight sides and four 90° right turns. */
function railLoop(x: number, y: number, side: number): Track {
  const t = new Track(x, y, N);
  // The start piece is the first straight of the first side.
  for (let k = 0; k < 4; k++) t.go("straight", k === 0 ? side - 1 : side).go("right", 4);
  const first = t.pieces[0]!;
  const back = railEnds(first.name, first.direction).map((e) => ({ x: first.x + e.dx, y: first.y + e.dy }));
  if (!back.some((p) => p.x === t.end.x && p.y === t.end.y)) throw new Error("debug lab: rail loop does not close");
  return t;
}

/** A valid joint for each outward end direction, collected off a loop: any
 *  piece fits onto the rail grid by putting one of its ends on the joint
 *  for that end's direction. */
function railJoints(): Map<number, { x: number; y: number }> {
  const joints = new Map<number, { x: number; y: number }>();
  for (const p of railLoop(1, 1, 2).pieces) {
    for (const e of railEnds(p.name, p.direction)) joints.set(e.dir, { x: p.x + e.dx, y: p.y + e.dy });
  }
  return joints;
}

/** Every track piece in every facing it has: straights and half-diagonals
 *  four, curves eight, on the ground and elevated; ramps and supports. */
function trackPieceSection(): Sheet {
  const joints = railJoints();
  const rows: Block[] = [];
  const pieceRow = (name: string, directions: number[]) => {
    const sheet = new Sheet();
    let x = 0;
    for (const direction of directions) {
      const e0 = railEnds(name, direction)[0]!;
      const j = joints.get(e0.dir)!;
      const piece = { name, x: j.x - e0.dx, y: j.y - e0.dy, direction };
      const tiles = railTiles(piece);
      const left = floorEven(Math.min(...tiles.map(([tx]) => tx)));
      const top = floorEven(Math.min(...tiles.map(([, ty]) => ty)));
      sheet.add({ name, x: piece.x - left + x, y: piece.y - top, direction });
      x += ceilEven(Math.max(...tiles.map(([tx]) => tx + 1)) - left) + 2;
    }
    return sheet;
  };
  const four = [0, 2, 4, 6];
  const eight = [0, 2, 4, 6, 8, 10, 12, 14];
  for (const elevated of [false, true]) {
    for (const [shape, dirs] of [["straight", four], ["half-diagonal", four], ["curved-a", eight], ["curved-b", eight]] as const) {
      const name = railName(shape, elevated);
      rows.push({ title: name, sheet: pieceRow(name, dirs) });
    }
  }
  rows.push({ title: "rail-ramp", sheet: pieceRow("rail-ramp", [0, 4, 8, 12]) });
  const supports = new Sheet();
  facings("rail-support").forEach((direction, i) => {
    const j = joints.get(direction)!;
    supports.add({ name: "rail-support", x: j.x - floorEven(j.x) + i * 6 + 2, y: j.y - floorEven(j.y) + 2, direction });
  });
  rows.push({ title: "rail-support", sheet: supports });
  return flow(rows, 120, 6, 2);
}

/** A clockwise loop with a train stop mid-way along each side and, at every
 *  joint round the curves and every other joint on the straights, a rail
 *  signal for clockwise trains and a chain signal for anticlockwise ones —
 *  between them, both kinds face all sixteen ways. */
function signalLoopSection(): Sheet {
  const sheet = new Sheet();
  const loop = railLoop(1, 1, 6);
  for (const p of loop.pieces) sheet.add({ ...p });

  const stops: RailSlot[] = [];
  for (const dir of DIRECTIONS) {
    const side = loop.pieces.filter((p, i) => loop.headings[i] === dir && p.name === "straight-rail");
    const slot = trainStopSlots([side[Math.floor(side.length / 2)]!]).find((s) => s.direction === dir);
    if (slot) stops.push(slot);
  }
  for (const s of stops) sheet.add({ name: "train-stop", x: s.x, y: s.y, direction: s.direction });

  const seen = new Set<string>();
  let straight = 0;
  for (const joint of loop.joints) {
    const key = `${joint.x},${joint.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (joint.dir % 4 === 0 && straight++ % 2 === 1) continue;
    for (const slot of signalSlotsForEnd(joint)) {
      if (stops.some((s) => Math.abs(s.x - slot.x) < 2.5 && Math.abs(s.y - slot.y) < 2.5)) continue;
      const name = slot.direction === joint.dir ? "rail-signal" : "rail-chain-signal";
      sheet.add({ name, x: slot.x, y: slot.y, direction: slot.direction });
    }
  }
  return sheet;
}

/** Ground track climbing a ramp, turning on the elevated layer over a
 *  ground line, and coming back down — with the supports the planner puts
 *  under it. */
function elevatedSection(): Sheet {
  const sheet = new Sheet();
  const ground = new Track(31, -9, S).go("straight", 14);
  const up = new Track(1, 41, N).go("straight").go("ramp").go("straight", 2).go("right", 4).go("straight", 8).go("right", 4).go("straight", 2).go("ramp").go("straight");
  const groundTiles = new Set(ground.pieces.flatMap((p) => railTiles(p).map(([x, y]) => `${x},${y}`)));
  const blocked = (x: number, y: number) => {
    for (let ty = Math.floor(y - 1.5); ty < y + 1.5; ty++) for (let tx = Math.floor(x - 1.5); tx < x + 1.5; tx++) if (groundTiles.has(`${tx},${ty}`)) return true;
    return false;
  };
  const { supports } = supportsFor(up.start, up.pieces.slice(1), () => false, blocked);
  for (const p of [...ground.pieces, ...up.pieces, ...supports]) sheet.add({ ...p });
  return sheet;
}

function railChapter(): Chapter {
  return {
    title: "[item=rail] [font=heading-1]Rails[/font]",
    sections: [
      { title: "[item=rail] Track pieces, every facing", sheet: trackPieceSection() },
      { title: "[item=rail-signal] Signals all round a loop, train stops", sheet: signalLoopSection() },
      { title: "[item=rail-ramp] Elevated track over ground track", sheet: elevatedSection() },
    ],
  };
}

/* ====================================================================== */
/* 6. Floors & space platform                                              */
/* ====================================================================== */

function floorSection(): Sheet {
  const sheet = new Sheet();
  Object.keys(catalog.tiles ?? {}).forEach((name, i) => {
    const ox = (i % 4) * 12;
    const oy = Math.floor(i / 4) * 9;
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) sheet.tile(name, ox + x, oy + y + 2);
    label(sheet, ox + 0.5, oy + 0.5, name);
  });
  return sheet;
}

/** A hub with cargo bays flush against it and against each other, thrusters
 *  and asteroid collectors at the edges, on platform foundation. */
function platformSection(): Sheet {
  const sheet = new Sheet();
  for (let y = -4; y < 26; y++) for (let x = -2; x < 30; x++) sheet.tile("space-platform-foundation", x, y);
  sheet.add({ name: "space-platform-hub", x: 4, y: 4 });
  for (const [x, y] of [[10, 2], [14, 2], [10, 6], [2, 10], [6, 10], [10, 10]] as const) sheet.add({ name: "cargo-bay", x, y });
  // Five tiles tall, so centred on a half tile.
  sheet.add({ name: "thruster", x: 4, y: 20.5 });
  sheet.add({ name: "thruster", x: 10, y: 20.5 });
  for (const [x, dir] of [[1.5, N], [5.5, N], [22.5, N]] as const) sheet.add({ name: "asteroid-collector", x, y: -2.5, direction: dir });
  sheet.add({ name: "asteroid-collector", x: 27.5, y: 5.5, direction: E });
  sheet.add({ name: "crusher", x: 21, y: 2.5 });
  return sheet;
}

function floorChapter(): Chapter {
  return {
    title: "[item=concrete] [font=heading-1]Floors & space platform[/font]",
    width: 50,
    sections: [
      { title: "[item=concrete] Every floor tile", sheet: floorSection() },
      { title: "[item=space-platform-foundation] Space platform", sheet: platformSection() },
    ],
  };
}

/* ====================================================================== */
/* 7. Alt-mode                                                             */
/* ====================================================================== */

/** The first recipe a machine can make, by its first category that has one. */
function recipeFor(name: string): string | undefined {
  const machine = data.machines[name];
  if (!machine) return undefined;
  const recipes = Object.values(data.recipes).sort((a, b) => a.name.localeCompare(b.name));
  for (const category of machine.categories) {
    const r = recipes.find((x) => x.category === category);
    if (r) return r.name;
  }
  return undefined;
}

/** A furnace (or the recycler, a furnace too) picks its recipe from what
 *  goes in, so a blueprint never names one. */
const isFurnace = (categories: string[]) => categories.some((c) => c === "smelting" || c.startsWith("recycling"));

function moduleSection(): Sheet {
  const rows: Block[] = [];
  const modules = Object.values(data.modules);
  const am = new Sheet();
  modules.forEach((m, i) => {
    am.add({ name: "assembling-machine-3", x: i * 4 + 1.5, y: 1.5, recipe: "electronic-circuit", modules: [{ name: m.name, quality: "normal", count: 4 }] });
  });
  rows.push({ title: "[item=assembling-machine-3] every module, four to a machine", sheet: am });
  // A beacon passes on speed, consumption and pollution only: productivity
  // and quality modules can't go in one.
  const beacons = new Sheet();
  modules
    .filter((m) => !((m.effects.productivity ?? 0) > 0 || (m.effects.quality ?? 0) > 0))
    .forEach((m, i) => beacons.add({ name: "beacon", x: i * 4 + 1.5, y: 1.5, modules: [{ name: m.name, quality: "normal", count: 2 }] }));
  rows.push({ title: "[item=beacon] every module a beacon takes (tinted)", sheet: beacons });
  const machines = new Sheet();
  let x = 0;
  for (const m of Object.values(data.machines)) {
    const recipe = m.kind === "crafting" && !isFurnace(m.categories) ? (fluidRecipeFor(m.name) ?? recipeFor(m.name)) : undefined;
    const takesSpeed = m.moduleSlots > 0 && (!m.allowedEffects || m.allowedEffects.includes("speed"));
    if (!recipe && !takesSpeed) continue;
    const [w, h] = m.tileFootprint ?? m.size;
    machines.add({
      name: m.name,
      x: snap(x + w / 2, w),
      y: snap(h / 2, h),
      recipe,
      modules: takesSpeed ? [{ name: "speed-module-3", quality: "normal", count: m.moduleSlots }] : [],
    });
    x += Math.ceil(w) + 1;
  }
  rows.push({ title: "[item=assembling-machine-2] every machine with modules, and a recipe where blueprints carry one", sheet: machines });
  return stack(rows, 1);
}

function qualitySection(): Sheet {
  const rows: Block[] = [];
  for (const name of ["assembling-machine-3", "beacon", "steel-chest", "inserter", "transport-belt", "medium-electric-pole"]) {
    const sheet = new Sheet();
    const [w, h] = visual(name).tileFootprint;
    QUALITIES.forEach((quality, i) => sheet.add({ name, x: snap(i * (Math.ceil(w) + 1) + w / 2, w), y: snap(h / 2, h), quality }));
    rows.push({ sheet });
  }
  return flow(rows, 60, 3, 2);
}

function settingsSection(): Sheet {
  const rows: Block[] = [];
  const variants: { title: string; extra: Partial<Ent> }[] = [
    { title: "input priority left", extra: { splitterInputPriority: "left" } },
    { title: "input priority right", extra: { splitterInputPriority: "right" } },
    { title: "output priority left", extra: { splitterOutputPriority: "left" } },
    { title: "output priority right", extra: { splitterOutputPriority: "right" } },
    { title: "filter, out left", extra: { splitterOutputPriority: "left", splitterFilter: "iron-plate" } },
  ];
  for (const v of variants) rows.push({ title: `[item=splitter] ${v.title}`, sheet: fourWays([part("splitter", 0, 0, N, v.extra)], 2) });
  rows.push({
    title: "[item=fast-inserter] filters: whitelist, blacklist",
    sheet: (() => {
      const sheet = new Sheet();
      fourWays([part("fast-inserter", 0, 0, N, { useFilters: true, filterItems: ["iron-plate", "copper-plate"], filterMode: "whitelist" })], 1, 0, 0, sheet);
      fourWays([part("fast-inserter", 0, 0, N, { useFilters: true, filterItems: ["iron-plate"], filterMode: "blacklist" })], 1, 10, 0, sheet);
      return sheet;
    })(),
  });
  return flow(rows, 60, 4, 2);
}

function altModeChapter(): Chapter {
  return {
    title: "[item=speed-module-3] [font=heading-1]Alt-mode: recipes, modules, quality, settings[/font]",
    width: 110,
    sections: [
      { title: "[item=speed-module-3] Modules", sheet: moduleSection() },
      { title: "[item=quality-module-3] Quality: normal → legendary", sheet: qualitySection() },
      { title: "[item=splitter] Splitter & inserter settings — N E S W", sheet: settingsSection() },
    ],
  };
}

/* ====================================================================== */
/* Assembly, checks and output                                             */
/* ====================================================================== */

/** Sections flow inside a chapter this wide; chapters flow across the lab
 *  three to a row, read left to right, top to bottom. */
const CHAPTER_WIDTH = 170;
const LAB_WIDTH = 3 * CHAPTER_WIDTH + 2 * 24;

function assemble(chapters: Chapter[]): Sheet {
  const blocks = chapters.map((c) => ({ title: c.title, sheet: flow(c.sections, c.width ?? CHAPTER_WIDTH, 8, 6) }));
  return flow(blocks, LAB_WIDTH, 24, 16);
}

/** Refuses a lab the game (or the renderer) would not accept as built. */
function check(lab: Sheet): void {
  const problems: string[] = [];
  const asPlaced = lab.ents.map((e, i) => ({ ...e, entityNumber: i + 1, direction: e.direction ?? 0 }) as PlacedEntity);

  // Nothing overlaps: a coarse grid of 4-tile cells, then the renderer's own
  // collision rule for each nearby pair.
  const cells = new Map<string, number[]>();
  asPlaced.forEach((e, i) => {
    const b = drawBox(lab.ents[i]!);
    for (let cy = Math.floor(b.top / 4); cy <= Math.floor((b.bottom - 0.01) / 4); cy++) {
      for (let cx = Math.floor(b.left / 4); cx <= Math.floor((b.right - 0.01) / 4); cx++) {
        const key = `${cx},${cy}`;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
    }
  });
  const reported = new Set<string>();
  for (const list of cells.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = asPlaced[list[i]!]!;
        const b = asPlaced[list[j]!]!;
        const key = `${list[i]},${list[j]}`;
        if (reported.has(key)) continue;
        if (entitiesCollide(a, b, footprintOf)) {
          reported.add(key);
          problems.push(`overlap: ${a.name} @${a.x},${a.y} d${a.direction} and ${b.name} @${b.x},${b.y} d${b.direction}`);
        }
      }
    }
  }

  // Every wire lands on a terminal of its colour, and no pole carries more
  // copper than the game's five.
  const copper = new Map<number, number>();
  for (const w of lab.wires) {
    for (const [ref, side] of [[w.a, w.aSide], [w.b, w.bSide]] as const) {
      const e = lab.ents[ref]!;
      const v = visual(e.name);
      if (!canWire(v, w.color)) problems.push(`wire: ${e.name} takes no ${w.color} wire`);
      if (side === 2 && !v.outputWireConnections && !(w.color === "copper" && v.wireConnections?.secondCopper)) {
        problems.push(`wire: ${e.name} has no second ${w.color} terminal`);
      }
      if (w.color === "copper" && isPoleLike(e.name)) copper.set(ref, (copper.get(ref) ?? 0) + 1);
    }
  }
  for (const [ref, n] of copper) if (n > 5) problems.push(`wire: ${lab.ents[ref]!.name} carries ${n} copper wires`);

  if (problems.length) throw new Error(`debug lab: ${problems.length} problems\n  ${problems.slice(0, 30).join("\n  ")}`);
}

function toBlueprint(sheet: Sheet, label: string, description?: string): Blueprint {
  const placed: PlacedEntity[] = sheet.ents.map((e, i) => ({
    ...e,
    entityNumber: i + 1,
    direction: e.direction ?? 0,
    quality: e.quality ?? "normal",
    modules: e.modules ?? [],
    filterItems: e.filterItems ?? [],
  }));
  const links: WireLink[] = sheet.wires.map((w) => ({ color: w.color, from: w.a + 1, fromSide: w.aSide, to: w.b + 1, toSide: w.bSide }));
  const blueprint: Blueprint = {
    item: "blueprint",
    label,
    description,
    icons: [{ index: 1, signal: { name: "lab" } }],
    version: 562949956632576,
    entities: denormaliseEntities(placed),
  };
  if (links.length) blueprint.wires = denormaliseWires(links, placed);
  if (sheet.tiles.length) blueprint.tiles = sheet.tiles;
  return blueprint;
}

function writeBlueprint(path: string, blueprint: Blueprint): void {
  const source = readFileSync(path, "utf8");
  // A deflated blueprint string: "0" then base64 of a zlib stream ("eN…").
  const match = source.match(/"(0eN[A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error(`Couldn't find a blueprint string in ${path}`);
  writeFileSync(path, source.replace(match[0], `"${encodeBlueprintString({ blueprint })}"`));
}

function main(): void {
  const chapters: Chapter[] = [
    { title: "[item=assembling-machine-2] [font=heading-1]Buildings — every entity, every facing (N E S W, left to right)[/font]", sections: buildingSections() },
    beltChapter(),
    fluidChapter(),
    powerChapter(),
    railChapter(),
    floorChapter(),
    altModeChapter(),
  ];
  const lab = assemble(chapters);
  check(lab);

  const contents = chapters
    .map((c, i) => `${i + 1}. ${c.title.replace(/\[[^\]]*\]/g, "").trim()}`)
    .join("\n");
  const description =
    "Renderer debug lab — turn on alt-mode to see every section's heading.\n\n" + contents +
    "\n\nRegenerate with: npm run build-debug-lab --workspace=@factoriotools/data-pipeline";
  writeBlueprint(DEBUG_LAB_PATH, toBlueprint(lab, "Renderer debug lab", description));

  const b = lab.bounds()!;
  const kinds = new Set(lab.ents.map((e) => e.name)).size;
  console.log(
    `Wrote ${DEBUG_LAB_PATH} — ${lab.ents.length} entities of ${kinds} kinds, ${lab.wires.length} wires, ` +
      `${lab.tiles.length} tiles, ${Math.ceil(b.right - b.left)}×${Math.ceil(b.bottom - b.top)} tiles.`,
  );

  // A small standalone blueprint with just the regression-worthy cases, so
  // they can be eyeballed directly.
  const states = bugReproStates();
  const repro = new Sheet();
  for (const s of layoutBeltFamilyStates(states, 0, 0)) repro.add({ name: s.name, x: s.x, y: s.y, direction: s.direction ?? 0 });
  const reproBlueprint = toBlueprint(repro, "Renderer bug repro");
  delete reproBlueprint.icons;
  writeBlueprint(BUG_REPRO_PATH, reproBlueprint);
  console.log(`Wrote ${BUG_REPRO_PATH} — ${repro.ents.length} entities in ${states.length} rows.`);
}

main();
