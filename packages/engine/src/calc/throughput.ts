import type { GameData, InserterProto, PlacedEntity, RecipeProto } from "../types.js";
import { boxOf, overlaps, type Box } from "./effects.js";
import type { MachineGroup } from "./rates.js";

export interface BottleneckInfo {
  /** Crafts/sec this machine can actually sustain given its adjacent
   *  inserters/belts, vs. `craftsPerSecond`'s theoretical max. */
  actualCraftsPerSecond: number;
  limitedBy: "machine" | "ingredient" | "product";
  /** Which ingredient/product is the binding constraint, when limitedBy
   *  isn't "machine". */
  limitingItem?: string;
  /** Items/sec of adjacent input capacity found, per ingredient name. */
  inputCapacity: Record<string, number>;
  /** Items/sec of adjacent output capacity found, per product name. */
  outputCapacity: Record<string, number>;
}

/** Factorio direction values increase clockwise from north (0). Rotates a
 *  north-relative offset (e.g. an inserter's pickup_position at direction 0)
 *  by the entity's actual direction. Always assumes the 16-way scheme (step
 *  4 of 16) — confirmed by spike against real 2.0 blueprint exports that
 *  every direction value observed is only consistent with 16-way, never
 *  8-way (mirrors the identical fix/reasoning in
 *  packages/renderer/src/beltGraph.ts's toCardinal(): guessing the scheme
 *  from whether direction <= 7 is ambiguous — direction 4 means "8-way
 *  South" under one scheme and "16-way East" under the other — and was
 *  silently misplacing the pickup/drop tiles this bottleneck check looks
 *  at for any inserter with direction 4 or 8). */
function rotateNorthOffset(dx: number, dy: number, direction: number): { dx: number; dy: number } {
  const quarterTurns = Math.round(direction / 4) % 4;
  let x = dx;
  let y = dy;
  for (let i = 0; i < quarterTurns; i++) {
    const nx = -y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return { dx: x, dy: y };
}

/** An inserter's pickup tile is one tile behind it, its drop tile one tile
 *  ahead — confirmed against the real prototype's insert_position ([0,1.2],
 *  i.e. roughly a tile south at direction 0) / pickup_position ([0,-1], a
 *  tile north at direction 0). Real coordinates are close enough to exactly
 *  ±1 tile that rounding to the tile grid is correct for adjacency purposes
 *  — this engine only needs "which tile," not the sub-tile offset. */
function inserterTiles(entity: PlacedEntity): { pickup: { x: number; y: number }; drop: { x: number; y: number } } {
  const behind = rotateNorthOffset(0, -1, entity.direction);
  const ahead = rotateNorthOffset(0, 1, entity.direction);
  return {
    pickup: { x: entity.x + behind.dx, y: entity.y + behind.dy },
    drop: { x: entity.x + ahead.dx, y: entity.y + ahead.dy },
  };
}

function pointInBox(x: number, y: number, box: Box): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

export interface ThroughputContext {
  data: GameData;
  entities: PlacedEntity[];
  /** Authoritative footprint per entity name, falling back to 1x1 for
   *  anything not in GameData (belts, poles, chests, ...) — mirrors
   *  MachineProto.tileFootprint/size, but this pass also needs footprints
   *  for non-machine entities it doesn't otherwise touch. */
  footprintOf: (entityName: string) => [number, number];
}

interface AdjacentInserter {
  entity: PlacedEntity;
  proto: InserterProto;
  /** true if this inserter's drop tile lands on the machine (feeding it);
   *  false if its pickup tile does (removing from it). */
  feedsIn: boolean;
}

/** Finds every inserter whose pickup or drop tile falls inside the machine's
 *  footprint box. A single inserter could in principle satisfy both (a 1x1
 *  machine sandwiched oddly) but real placements never do — Factorio's own
 *  placement rules prevent an inserter from having the same machine on both
 *  sides — so no special-casing for that is needed. */
function findAdjacentInserters(ctx: ThroughputContext, machineBox: Box): AdjacentInserter[] {
  const found: AdjacentInserter[] = [];
  for (const entity of ctx.entities) {
    const proto = ctx.data.inserters[entity.name];
    if (!proto) continue;
    const { pickup, drop } = inserterTiles(entity);
    if (pointInBox(drop.x, drop.y, machineBox)) {
      found.push({ entity, proto, feedsIn: true });
    } else if (pointInBox(pickup.x, pickup.y, machineBox)) {
      found.push({ entity, proto, feedsIn: false });
    }
  }
  return found;
}

/** Belts that touch the machine's footprint directly (no inserter between
 *  them) — the direct-output-to-belt mechanic mining drills and some other
 *  machines use. Only counts as an output path; nothing in vanilla feeds a
 *  crafting machine's *input* straight from a belt without an inserter. */
function findAdjacentOutputBelts(ctx: ThroughputContext, entity: PlacedEntity, machineBox: Box): number {
  let capacity = 0;
  for (const other of ctx.entities) {
    const beltProto = ctx.data.belts[other.name];
    if (!beltProto) continue;
    const [w, h] = ctx.footprintOf(other.name);
    const beltBox = boxOf(other.x, other.y, [w, h]);
    // Adjacent (touching), not overlapping the machine's own tiles.
    const touchBox = boxOf(other.x, other.y, [w + 0.02, h + 0.02]);
    if (overlaps(touchBox, machineBox) && !overlaps(beltBox, machineBox)) {
      capacity += beltProto.throughput;
    }
  }
  return capacity;
}

function quality1(data: GameData, quality: PlacedEntity["quality"]): number {
  return data.qualityMachineSpeed[quality] ?? 1;
}

/** Computes the actual (inserter/belt-limited) rate for one machine group's
 *  representative entity, given the recipe it's running. Per the project
 *  plan: per-machine local adjacency, not a full belt-network simulation —
 *  this looks at what's physically placed next to THIS machine, nothing
 *  further upstream/downstream. */
export function computeBottleneck(
  ctx: ThroughputContext,
  entity: PlacedEntity,
  recipe: RecipeProto,
  theoreticalCraftsPerSecond: number,
  productivity: number,
): BottleneckInfo {
  const machine = ctx.data.machines[entity.name];
  const footprint = machine?.tileFootprint ?? machine?.size ?? ctx.footprintOf(entity.name);
  const machineBox = boxOf(entity.x, entity.y, footprint);

  const inserters = findAdjacentInserters(ctx, machineBox);

  // Multiple ingredients/products can each be fed by different inserters on
  // different sides; a machine has no notion of "which ingredient goes to
  // which inserter" in the blueprint itself, so — matching how Factorio
  // itself resolves this at runtime — every input-feeding inserter is
  // assumed capable of carrying any of the recipe's ingredients, and the
  // bottleneck is evaluated per ingredient against the SAME shared pool of
  // input inserter capacity. This slightly overstates capacity for a
  // multi-ingredient recipe fed by inserters that in reality only carry one
  // specific item each, but with no per-inserter filter data in a blueprint
  // to say otherwise, shared-pool is the least-wrong assumption available.
  let totalInputCapacity = 0;
  let totalOutputCapacity = 0;
  for (const ins of inserters) {
    const rate = ins.proto.throughput * quality1(ctx.data, ins.entity.quality);
    if (ins.feedsIn) totalInputCapacity += rate;
    else totalOutputCapacity += rate;
  }

  const inputCapacity: Record<string, number> = {};
  const outputCapacity: Record<string, number> = {};
  let limitingCraftsFromInputs = Infinity;
  let limitingInput: string | undefined;
  for (const ingredient of recipe.ingredients) {
    inputCapacity[ingredient.name] = totalInputCapacity;
    if (ingredient.amount <= 0) continue;
    const maxCrafts = totalInputCapacity / ingredient.amount;
    if (maxCrafts < limitingCraftsFromInputs) {
      limitingCraftsFromInputs = maxCrafts;
      limitingInput = ingredient.name;
    }
  }
  if (recipe.ingredients.length === 0) limitingCraftsFromInputs = Infinity;

  let limitingCraftsFromOutputs = Infinity;
  let limitingOutput: string | undefined;
  for (const product of recipe.results) {
    const beltCapacity = findAdjacentOutputBelts(ctx, entity, machineBox);
    const capacity = totalOutputCapacity + beltCapacity;
    outputCapacity[product.name] = capacity;
    const boosted = Math.max(0, product.amount - (product.ignoredByProductivity ?? 0)) * (1 + productivity) + (product.ignoredByProductivity ?? 0);
    if (boosted <= 0) continue;
    const maxCrafts = capacity / boosted;
    if (maxCrafts < limitingCraftsFromOutputs) {
      limitingCraftsFromOutputs = maxCrafts;
      limitingOutput = product.name;
    }
  }
  if (recipe.results.length === 0) limitingCraftsFromOutputs = Infinity;

  // No inserters/belts found at all on a side means "unknown, not zero" —
  // a blueprint fragment pasted without its surrounding logistics shouldn't
  // report a hard 0 rate, which would swamp every other number with a false
  // bottleneck. Only apply a cap when at least one adjacent inserter/belt on
  // that side was actually found.
  const hasInputAdjacency = inserters.some((i) => i.feedsIn);
  const hasOutputAdjacency = inserters.some((i) => !i.feedsIn) || findAdjacentOutputBelts(ctx, entity, machineBox) > 0;

  const candidates: { rate: number; limitedBy: BottleneckInfo["limitedBy"]; item?: string }[] = [
    { rate: theoreticalCraftsPerSecond, limitedBy: "machine" },
  ];
  if (hasInputAdjacency) candidates.push({ rate: limitingCraftsFromInputs, limitedBy: "ingredient", item: limitingInput });
  if (hasOutputAdjacency) candidates.push({ rate: limitingCraftsFromOutputs, limitedBy: "product", item: limitingOutput });

  const binding = candidates.reduce((min, c) => (c.rate < min.rate ? c : min));

  return {
    actualCraftsPerSecond: binding.rate,
    limitedBy: binding.limitedBy,
    limitingItem: binding.item,
    inputCapacity,
    outputCapacity,
  };
}

/** A `groupKey`-collapsed row can contain entities with different actual
 *  adjacency (one furnace fed by a regular inserter, another by a stack
 *  inserter, otherwise identical config) — exactly the case the bottleneck
 *  feature exists to surface. Bottleneck is computed per-entity first, then
 *  a group's display is only split into sub-rows when the entities within
 *  it genuinely differ; most real repeatable builds feed every instance
 *  identically, so this rarely fires in practice. */
export interface BottleneckSubgroup {
  /** Signature distinguishing this subgroup — e.g. "stack-inserter:1" —
   *  entities with the same signature share one BottleneckInfo. Purely a
   *  display grouping key, opaque to callers. */
  signature: string;
  entityNumbers: number[];
  bottleneck: BottleneckInfo;
}

function capacitySignature(inserters: AdjacentInserter[]): string {
  const counts = new Map<string, number>();
  for (const ins of inserters) {
    const key = `${ins.feedsIn ? "in" : "out"}:${ins.entity.name}:${ins.entity.quality}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([k, n]) => `${k}x${n}`).join("|");
}

/** Adds per-entity bottleneck info to every machine group, mutating nothing
 *  in `rates.ts` — a pure additive pass a caller runs alongside
 *  `calculate()`. Kept as a separate exported function (not folded into
 *  `calculate()` itself) so callers that don't need it pay no cost, matching
 *  how `rates.ts` already keeps `scaleRate` presentation-only and separate. */
export function attachBottlenecks(ctx: ThroughputContext, groups: MachineGroup[]): Map<string, BottleneckSubgroup[]> {
  const byGroupKey = new Map<string, BottleneckSubgroup[]>();
  const entityByNumber = new Map(ctx.entities.map((e) => [e.entityNumber, e] as const));

  for (const group of groups) {
    const recipe = ctx.data.recipes[group.recipeName];
    if (!recipe) continue;
    const machine = ctx.data.machines[group.machineName];
    const productivity = Math.min(group.effects.productivity, recipe.maximumProductivity ?? Infinity);

    const bySignature = new Map<string, BottleneckSubgroup>();
    for (const entityNumber of group.entityNumbers) {
      const entity = entityByNumber.get(entityNumber);
      if (!entity || !machine) continue;
      const footprint = machine.tileFootprint ?? machine.size;
      const machineBox = boxOf(entity.x, entity.y, footprint);
      const inserters = findAdjacentInserters(ctx, machineBox);
      const signature = capacitySignature(inserters);

      let subgroup = bySignature.get(signature);
      if (!subgroup) {
        const bottleneck = computeBottleneck(ctx, entity, recipe, group.craftsPerSecond, productivity);
        subgroup = { signature, entityNumbers: [], bottleneck };
        bySignature.set(signature, subgroup);
      }
      subgroup.entityNumbers.push(entityNumber);
    }
    byGroupKey.set(group.key, [...bySignature.values()]);
  }
  return byGroupKey;
}
