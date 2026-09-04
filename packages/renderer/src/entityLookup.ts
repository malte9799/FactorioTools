import type { EntityGraphics, GameData, InserterGraphics, PipeConnectionPoint, RenderCatalog } from "@factoriotools/engine";
import { toCardinal, Dir } from "./neighbours/grid.js";

/** One lookup over both GameData (entities with rates) and the RenderCatalog
 *  (visual-only ones) — the renderer doesn't care which side a name came
 *  from, only how to draw it. */
export interface ResolvedVisual {
  tileFootprint: [number, number];
  graphics?: EntityGraphics;
  /** Inserters are drawn procedurally, outside the EntityGraphics model. */
  inserterGraphics?: InserterGraphics;
  rotatesFootprint?: boolean;
  localised: string;
  isMachine: boolean;
  isBeacon: boolean;
  moduleSlots: number;
  /** Alt mode draws a facing arrow for these. */
  showDirectionArrow: boolean;
  /** Fluid-box connection points, in the entity's own unrotated local frame
   *  — feeds the fluid network graph (neighbours/fluid.ts). Undefined for
   *  every entity with no fluid box. */
  pipeConnections?: PipeConnectionPoint[];
}

const EMPTY = {
  isMachine: false,
  isBeacon: false,
  moduleSlots: 0,
  showDirectionArrow: false,
};

export function buildVisualLookup(data: GameData, catalog: RenderCatalog): Map<string, ResolvedVisual> {
  const lookup = new Map<string, ResolvedVisual>();

  for (const m of Object.values(data.machines)) {
    lookup.set(m.name, {
      ...EMPTY,
      tileFootprint: m.tileFootprint ?? m.size,
      graphics: m.graphics,
      localised: m.localised,
      isMachine: true,
      moduleSlots: m.moduleSlots,
      pipeConnections: m.pipeConnections,
    });
  }
  for (const b of Object.values(data.beacons)) {
    lookup.set(b.name, {
      ...EMPTY,
      tileFootprint: b.size,
      graphics: b.graphics,
      localised: b.localised,
      isBeacon: true,
      moduleSlots: b.moduleSlots,
    });
  }
  for (const belt of Object.values(data.belts)) {
    lookup.set(belt.name, {
      ...EMPTY,
      tileFootprint: [1, 1],
      graphics: belt.graphics,
      localised: belt.localised,
    });
  }
  for (const inserter of Object.values(data.inserters)) {
    lookup.set(inserter.name, {
      ...EMPTY,
      tileFootprint: [1, 1],
      inserterGraphics: inserter.graphics,
      localised: inserter.localised,
      showDirectionArrow: true,
    });
  }
  for (const e of Object.values(catalog.entities)) {
    if (lookup.has(e.name)) continue;
    lookup.set(e.name, {
      ...EMPTY,
      tileFootprint: e.tileFootprint,
      graphics: e.graphics,
      rotatesFootprint: e.rotatesFootprint,
      localised: e.localised,
      showDirectionArrow: e.name.includes("combinator"),
      pipeConnections: e.pipeConnections,
    });
  }
  return lookup;
}

/** tileFootprint is stored north-facing; a rotatesFootprint entity swaps
 *  width and depth when it faces east or west. */
export function effectiveFootprint(visual: ResolvedVisual, direction: number): [number, number] {
  const [w, h] = visual.tileFootprint;
  if (!visual.rotatesFootprint) return [w, h];
  const facing = toCardinal(direction);
  return facing === Dir.East || facing === Dir.West ? [h, w] : [w, h];
}

/** True for every underground-belt/loader tier (all vanilla names end in
 *  "underground-belt" or contain "loader" — loader-1x1, loader, *-loader).
 *  These are the belt-connector entities whose PlacedEntity MUST carry a
 *  real undergroundType ("input" unless a blueprint's own `type` field says
 *  "output") — collect.ts's resolveFrame branches on undergroundType being
 *  defined at all to pick the underground/loader structure art over plain
 *  belt row/cap art, so any caller that builds one of these without setting
 *  it (a freshly-placed entity, or the placement ghost) would otherwise
 *  render as a half-cropped, misrotated belt tread instead of the real
 *  entrance/exit structure. */
export function isUndergroundLike(name: string): boolean {
  return name.endsWith("underground-belt") || name.includes("loader");
}

/** True for every electric-pole tier (small/medium/big-electric-pole,
 *  substation). Poles must never be player-rotated: their facing is
 *  meaningless today and will later be derived automatically from the wires
 *  connected to them, so exposing a manual rotate would just be undone by
 *  that future auto-orientation. */
export function isPoleLike(name: string): boolean {
  return name.endsWith("electric-pole") || name === "substation";
}

/** Family predicates for the neighbour classifiers, derived from which
 *  connector an entity declares. */
export function makeConnectorPredicates(lookup: Map<string, ResolvedVisual>) {
  const has = (kind: string) => (name: string) => lookup.get(name)?.graphics?.connector === kind;
  const isPipeLike = (name: string) => has("pipe")(name) || name === "pipe-to-ground";
  const isWallLike = (name: string) => has("wall")(name) || name === "gate";
  const isBeltLike = has("belt");
  const isPlatformLike = has("platform");
  return { isPipeLike, isWallLike, isBeltLike, isPlatformLike };
}
