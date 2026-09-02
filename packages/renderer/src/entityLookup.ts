import type { EntityGraphics, GameData, InserterGraphics, RenderCatalog } from "@factoriotools/engine";
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

/** Family predicates for the neighbour classifiers, derived from which
 *  connector an entity declares. */
export function makeConnectorPredicates(lookup: Map<string, ResolvedVisual>) {
  const has = (kind: string) => (name: string) => lookup.get(name)?.graphics?.connector === kind;
  const isPipeLike = (name: string) => has("pipe")(name) || name === "pipe-to-ground";
  const isWallLike = (name: string) => has("wall")(name) || name === "gate";
  const isBeltLike = has("belt");
  return { isPipeLike, isWallLike, isBeltLike };
}
