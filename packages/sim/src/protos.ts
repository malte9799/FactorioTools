import type { GameData } from "@factoriotools/engine";
import { TILE } from "./units.js";

export type BeltKind = "belt" | "underground" | "splitter";

export interface BeltSpec {
  kind: BeltKind;
  /** Movement per tick in 1/256 tile (yellow 8, red 16, blue 24, turbo 32). */
  speed: number;
  /** Undergrounds only: largest entrance-to-exit distance in tiles. */
  maxDistance?: number;
}

export type BeltSpecResolver = (name: string) => BeltSpec | undefined;

/** Vanilla 2.0 values, used when the loaded dataset predates the pipeline
 *  extracting them. Belt/splitter speeds are the well-known tier speeds;
 *  underground max distances are 5/7/9 for the base tiers and 11 for turbo
 *  (the turbo value is UNVERIFIED — regenerate game-data.json to replace it
 *  with the prototype's own max_distance). */
const VANILLA_BELTS: Record<string, number> = {
  "transport-belt": 0.03125,
  "fast-transport-belt": 0.0625,
  "express-transport-belt": 0.09375,
  "turbo-transport-belt": 0.125,
};
const VANILLA_UNDERGROUNDS: Record<string, [speed: number, maxDistance: number]> = {
  "underground-belt": [0.03125, 5],
  "fast-underground-belt": [0.0625, 7],
  "express-underground-belt": [0.09375, 9],
  "turbo-underground-belt": [0.125, 11],
};
const VANILLA_SPLITTERS: Record<string, number> = {
  splitter: 0.03125,
  "fast-splitter": 0.0625,
  "express-splitter": 0.09375,
  "turbo-splitter": 0.125,
};

const units = (tilesPerTick: number) => Math.round(tilesPerTick * TILE);

/** Looks each name up in the dataset first and the vanilla table second. */
export function beltSpecResolver(data?: Pick<GameData, "belts" | "undergroundBelts" | "splitters">): BeltSpecResolver {
  return (name) => {
    const belt = data?.belts[name];
    if (belt) return { kind: "belt", speed: units(belt.speed ?? belt.throughput / 480) };
    const underground = data?.undergroundBelts?.[name];
    if (underground) return { kind: "underground", speed: units(underground.speed), maxDistance: underground.maxDistance };
    const splitter = data?.splitters?.[name];
    if (splitter) return { kind: "splitter", speed: units(splitter.speed) };
    if (name in VANILLA_BELTS) return { kind: "belt", speed: units(VANILLA_BELTS[name]!) };
    if (name in VANILLA_UNDERGROUNDS) {
      const [speed, maxDistance] = VANILLA_UNDERGROUNDS[name]!;
      return { kind: "underground", speed: units(speed), maxDistance };
    }
    if (name in VANILLA_SPLITTERS) return { kind: "splitter", speed: units(VANILLA_SPLITTERS[name]!) };
    return undefined;
  };
}
