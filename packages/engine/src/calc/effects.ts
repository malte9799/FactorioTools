import type {
  Effects,
  GameData,
  MachineProto,
  ModuleStack,
  PlacedEntity,
  QualityName,
} from "../types.js";

export const NO_EFFECTS: Effects = {
  speed: 0,
  productivity: 0,
  consumption: 0,
  pollution: 0,
  quality: 0,
};

function addInto(target: Effects, source: Partial<Effects>, scale = 1): void {
  for (const key of Object.keys(target) as (keyof Effects)[]) {
    target[key] += (source[key] ?? 0) * scale;
  }
}

/** Quality raises the magnitude of a module's *beneficial* effects only; its
 *  drawbacks (extra power draw, speed penalty) stay at the base value. */
function qualityScaled(
  value: number,
  key: keyof Effects,
  multiplier: number,
): number {
  if (multiplier === 1 || value === 0) return value;
  const beneficial =
    key === "consumption" || key === "pollution" ? value < 0 : value > 0;
  return beneficial ? value * multiplier : value;
}

export function effectsFromModules(
  data: GameData,
  modules: ModuleStack[],
): Effects {
  const total = { ...NO_EFFECTS };
  for (const stack of modules) {
    const proto = data.modules[stack.name];
    if (!proto) continue;
    const q = data.qualityModuleEffect[stack.quality] ?? 1;
    for (const key of Object.keys(total) as (keyof Effects)[]) {
      const raw = proto.effects[key] ?? 0;
      total[key] += qualityScaled(raw, key, q) * stack.count;
    }
  }
  return total;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boxOf(x: number, y: number, size: [number, number]): Box {
  return {
    left: x - size[0] / 2,
    top: y - size[1] / 2,
    right: x + size[0] / 2,
    bottom: y + size[1] / 2,
  };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export interface BeaconInfluence {
  /** Beacons whose supply area covers the machine. */
  entities: PlacedEntity[];
  effects: Effects;
}

/** Beacons within range, precomputed once per blueprint. */
export function findBeacons(data: GameData, entities: PlacedEntity[]): PlacedEntity[] {
  return entities.filter((e) => e.name in data.beacons);
}

/** Factorio 2.0 transmits `distribution_effectiveness * profile[n]` of the
 *  combined module effects of all n beacons reaching the machine. Past the
 *  end of the profile array, the LAST entry is reused — this is the
 *  engine-documented behaviour (lua-api BeaconPrototype.profile), not a
 *  recomputed 1/sqrt(n) — the vanilla profile array happens to approximate
 *  that shape internally, but treating it as a formula would silently
 *  diverge from any beacon (modded or future vanilla) with a different
 *  profile. Set profile to [1] and distributionEffectiveness to 0.5 for 1.1
 *  behaviour. */
function beaconProfile(profile: number[] | undefined, count: number): number {
  if (count <= 0) return 0;
  if (!profile || profile.length === 0) return 1;
  const index = Math.min(count, profile.length) - 1;
  return profile[index]!;
}

export function beaconEffectsFor(
  data: GameData,
  machine: MachineProto,
  entity: PlacedEntity,
  beacons: PlacedEntity[],
): BeaconInfluence {
  const machineBox = boxOf(entity.x, entity.y, machine.size);
  const reaching = beacons.filter((beacon) => {
    const proto = data.beacons[beacon.name];
    if (!proto) return false;
    const d = proto.supplyAreaDistance;
    const area = boxOf(beacon.x, beacon.y, [
      proto.size[0] + d * 2,
      proto.size[1] + d * 2,
    ]);
    return overlaps(machineBox, area);
  });

  const combined = { ...NO_EFFECTS };
  if (reaching.length === 0) return { entities: reaching, effects: combined };

  // Every reaching beacon contributes its modules; the transmission ratio is a
  // function of how many beacons there are in total.
  const ratio = beaconProfile(
    data.beacons[reaching[0]!.name]?.profile,
    reaching.length,
  );
  for (const beacon of reaching) {
    const proto = data.beacons[beacon.name]!;
    // The beacon's OWN quality raises distributionEffectiveness additively
    // (+0.2/level in vanilla), unlike every other quality-scaled stat's
    // ×(1+0.3×level) multiplier — confirmed against the dump: base 1.5 +
    // 0.2/level gives 1.5/1.7/1.9/2.1/2.5, not 1.5×2.5=3.75. Module quality
    // (the modules INSIDE the beacon) still uses the normal multiplier, via
    // effectsFromModules → qualityScaled.
    const level = data.qualityLevel[beacon.quality] ?? 0;
    const effectiveness =
      proto.distributionEffectiveness + proto.distributionEffectivenessBonusPerQualityLevel * level;
    const perBeacon = effectsFromModules(data, beacon.modules);
    addInto(combined, perBeacon, effectiveness * ratio);
  }
  return { entities: reaching, effects: combined };
}

export interface ResolvedMachine {
  machine: MachineProto;
  quality: QualityName;
  /** Base speed after quality, before effects. */
  baseSpeed: number;
  ownEffects: Effects;
  beaconEffects: Effects;
  totalEffects: Effects;
  beaconCount: number;
  /** entity_number of every beacon whose supply area reaches this machine. */
  beaconEntityNumbers: number[];
}

export function resolveMachine(
  data: GameData,
  machine: MachineProto,
  entity: PlacedEntity,
  beacons: PlacedEntity[],
): ResolvedMachine {
  const ownEffects = effectsFromModules(data, entity.modules);
  const beacon = beaconEffectsFor(data, machine, entity, beacons);

  const totalEffects = { ...NO_EFFECTS };
  addInto(totalEffects, ownEffects);
  addInto(totalEffects, beacon.effects);

  // The engine floors speed and power at 20% of base.
  totalEffects.speed = Math.max(totalEffects.speed, -0.8);
  totalEffects.consumption = Math.max(totalEffects.consumption, -0.8);
  if (machine.allowedEffects) {
    for (const key of Object.keys(totalEffects) as (keyof Effects)[]) {
      if (!machine.allowedEffects.includes(key)) totalEffects[key] = 0;
    }
  }

  return {
    machine,
    quality: entity.quality,
    baseSpeed: machine.speed * (data.qualityMachineSpeed[entity.quality] ?? 1),
    ownEffects,
    beaconEffects: beacon.effects,
    totalEffects,
    beaconCount: beacon.entities.length,
    beaconEntityNumbers: beacon.entities.map((e) => e.entityNumber),
  };
}
