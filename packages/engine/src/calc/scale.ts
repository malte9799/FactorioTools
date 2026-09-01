import type { CalculationResult } from "./rates.js";
import type { BottleneckSubgroup } from "./throughput.js";

export interface ScaleTarget {
  /** Item name to size the whole build against — must be a produced item
   *  (a "product" or "intermediate" flow), not a pure ingredient. */
  itemName: string;
  /** Desired production rate, items/second (unscaled by timescale/multiplier
   *  — those are separate presentation knobs, see ViewOptions). */
  ratePerSecond: number;
}

export interface ScaleResult {
  /** target / theoretical-max-for-that-item. 1 when no target is set, or
   *  the target item produces nothing (nothing to scale from). */
  factor: number;
  /** The theoretical max rate the factor was computed against. */
  theoreticalMaxPerSecond: number;
  /** True when theoreticalMaxPerSecond is 0 (or the item wasn't found) —
   *  the UI should show a warning instead of a silently-wrong factor of 1. */
  unreachable: boolean;
}

/** Computes a linear scale factor so the target item's rate lands exactly on
 *  `target.ratePerSecond`, anchored to the THEORETICAL max (confirmed
 *  decision: sizing answers "how many adequately-fed machines for this
 *  target," not "how many of today's possibly-underfed machines" — see
 *  scaleWarning below for surfacing that gap separately rather than baking
 *  it into this number). Presentation-layer only: nothing here re-runs
 *  calculate() — beacon diminishing returns depend on beacon count in range,
 *  which a linear rescale doesn't change, so scaling every displayed number
 *  by one factor is exact, not an approximation. */
export function computeScaleFactor(result: CalculationResult, target: ScaleTarget | null): ScaleResult {
  if (!target) return { factor: 1, theoreticalMaxPerSecond: 0, unreachable: false };
  const flow = result.flows.find((f) => f.name === target.itemName);
  const theoreticalMaxPerSecond = flow?.produced ?? 0;
  if (theoreticalMaxPerSecond <= 0) {
    return { factor: 1, theoreticalMaxPerSecond, unreachable: true };
  }
  return {
    factor: target.ratePerSecond / theoreticalMaxPerSecond,
    theoreticalMaxPerSecond,
    unreachable: false,
  };
}

export interface ScaleWarning {
  /** The machine group whose current (bottlenecked) build can't sustain its
   *  share of the target once scaled up to the required count. */
  groupKey: string;
  recipeLabel: string;
  /** Machines needed at the target, rounded up. */
  machinesNeeded: number;
  /** What those `machinesNeeded` machines would actually deliver, given
   *  their CURRENT inserter/belt adjacency — not the theoretical amount the
   *  scale factor assumes. */
  actualDeliveredPerSecond: number;
  /** What they were sized to deliver. */
  targetSharePerSecond: number;
}

/** Surfaces the gap between "how many machines the theoretical-anchored
 *  scale factor says you need" and "what those machines would actually
 *  produce given how they're fed right now" — keeps the bottleneck engine's
 *  diagnostic value visible without conflating it into computeScaleFactor's
 *  own number, since these are two different questions, not one. Only
 *  machine groups whose bottleneck is NOT "machine" (i.e. genuinely
 *  inserter/belt-limited) can ever produce a warning here. */
export function findScaleWarnings(
  result: CalculationResult,
  scale: ScaleResult,
  bottlenecks: Map<string, BottleneckSubgroup[]>,
): ScaleWarning[] {
  if (scale.factor === 1 || scale.unreachable) return [];
  const warnings: ScaleWarning[] = [];

  for (const group of result.groups) {
    const subgroups = bottlenecks.get(group.key);
    if (!subgroups) continue;
    for (const sub of subgroups) {
      if (sub.bottleneck.limitedBy === "machine") continue;
      const currentCount = sub.entityNumbers.length;
      const machinesNeededExact = currentCount * scale.factor;
      const machinesNeeded = Math.ceil(machinesNeededExact);
      const targetSharePerSecond = group.craftsPerSecond * machinesNeededExact;
      // Each of the scaled-up machines is assumed fed identically to how
      // this subgroup's entities are fed today — the diagnostic question is
      // "if you build more machines wired up exactly like these, what do
      // you actually get," which is a fair reading of "current build."
      const actualDeliveredPerSecond = sub.bottleneck.actualCraftsPerSecond * machinesNeeded;
      if (actualDeliveredPerSecond < targetSharePerSecond - 1e-9) {
        warnings.push({
          groupKey: group.key,
          recipeLabel: group.recipeLabel,
          machinesNeeded,
          actualDeliveredPerSecond,
          targetSharePerSecond,
        });
      }
    }
  }
  return warnings;
}
