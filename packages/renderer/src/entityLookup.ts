import type { EntityGraphics, GameData, InserterGraphics, RenderCatalog } from "@factoriotools/engine";
import { toCardinal, Dir4 } from "./beltGraph.js";

/** Unifies GameData's machines/beacons/belts (which have rates) and the
 *  RenderCatalog's visual-only entities (which don't) into one
 *  name -> {footprint, graphics} lookup — the renderer doesn't care which
 *  side of that split an entity name came from, only how to draw it. */
export interface ResolvedVisual {
  tileFootprint: [number, number];
  graphics?: EntityGraphics;
  /** Inserters are procedurally drawn (platform + hand), a different shape
   *  from EntityGraphics' direction-indexed-sheet model — set instead of
   *  `graphics` when present. */
  inserterGraphics?: InserterGraphics;
  rotatesFootprint?: boolean;
  localised: string;
  /** True for belts/underground-belts/splitters — entities beltGraph.ts's
   *  neighbor classification should consider when deciding connection
   *  shape. */
  isBeltLike: boolean;
  /** True for pipes/heat-pipes — entities pipeGraph.ts's neighbor
   *  classification should consider when deciding connection shape.
   *  pipe-to-ground is deliberately NOT included: its graphics are a
   *  single representative static sprite (see render-catalog.ts's own
   *  comment on why), not a connectors map, so it has nothing for
   *  pipeGraph.ts to pick a variant from — it still counts as a
   *  connection-completing neighbor via isPipeToGround below. */
  isPipeLike: boolean;
  /** True for pipe-to-ground specifically — pipeGraph.ts needs this to
   *  know a neighboring pipe-to-ground only opens on ONE side (its own
   *  facing), unlike a plain pipe/heat-pipe which is open on all 4. */
  isPipeToGround: boolean;
  /** True for inserters — dispatches to the platform+hand composite draw
   *  instead of drawSprite4Way, regardless of whether inserterGraphics
   *  resolved (missing graphics still routes here so it gets the inserter-
   *  shaped outline fallback, not the generic one). */
  isInserter: boolean;
  /** True for GameData machines — alt-mode draws the entity's own `recipe`
   *  as a centered icon badge for these, matching the real game's alt view. */
  isMachine: boolean;
  /** True for GameData beacons — alt-mode draws module icons for these (and
   *  for machines) but skips the recipe badge, since beacons have no recipe. */
  isBeacon: boolean;
  /** How many module slots this machine/beacon prototype has — alt-mode
   *  uses this only to decide whether a module row is worth drawing at all
   *  (0-slot machines skip it even if `entity.modules` were somehow
   *  non-empty); the actual icons drawn come from the placed entity's own
   *  `modules`, not this count. */
  moduleSlots: number;
  /** True for inserters and combinators (arithmetic/decider/constant) —
   *  alt-mode draws a small yellow direction arrow for these, matching the
   *  real game's own alt view (per the user's own screenshot comparison:
   *  the yellow arrows there are direction indicators on inserters AND
   *  logic gates, not item-flow lines as first assumed). Other directional
   *  entities (belts, machines) already show their facing clearly enough
   *  through their own sprite, so this stays opt-in rather than blanket. */
  showDirectionArrow: boolean;
}

export function buildVisualLookup(data: GameData, catalog: RenderCatalog): Map<string, ResolvedVisual> {
  const lookup = new Map<string, ResolvedVisual>();

  for (const m of Object.values(data.machines)) {
    lookup.set(m.name, {
      tileFootprint: m.tileFootprint ?? m.size,
      graphics: m.graphics,
      localised: m.localised,
      isBeltLike: false,
      isPipeLike: false,
      isPipeToGround: false,
      isInserter: false,
      isMachine: true,
      isBeacon: false,
      moduleSlots: m.moduleSlots,
      showDirectionArrow: false,
    });
  }
  for (const b of Object.values(data.beacons)) {
    lookup.set(b.name, {
      tileFootprint: b.size,
      graphics: b.graphics,
      localised: b.localised,
      isBeltLike: false,
      isPipeLike: false,
      isPipeToGround: false,
      isInserter: false,
      isMachine: false,
      isBeacon: true,
      moduleSlots: b.moduleSlots,
      showDirectionArrow: false,
    });
  }
  for (const belt of Object.values(data.belts)) {
    lookup.set(belt.name, {
      tileFootprint: [1, 1],
      graphics: belt.graphics
        ? {
            kind: "belt",
            sheet: belt.graphics.sheet,
            frameWidth: belt.graphics.frameWidth,
            frameHeight: belt.graphics.frameHeight,
            directionCount: 1,
            lineLength: belt.graphics.frameCount,
            scale: belt.graphics.scale,
          }
        : undefined,
      localised: belt.localised,
      isBeltLike: true,
      isPipeLike: false,
      isPipeToGround: false,
      isInserter: false,
      isMachine: false,
      isBeacon: false,
      moduleSlots: 0,
      showDirectionArrow: false,
    });
  }
  for (const inserter of Object.values(data.inserters)) {
    lookup.set(inserter.name, {
      // Confirmed by spike: inserters occupy a 1x1 footprint but their
      // platform/hand art overhangs it the same way other entities'
      // drawSprite4Way overhang factor already accounts for.
      tileFootprint: [1, 1],
      inserterGraphics: inserter.graphics,
      localised: inserter.localised,
      isBeltLike: false,
      isPipeLike: false,
      isPipeToGround: false,
      isInserter: true,
      isMachine: false,
      isBeacon: false,
      moduleSlots: 0,
      showDirectionArrow: true,
    });
  }
  for (const e of Object.values(catalog.entities)) {
    if (lookup.has(e.name)) continue; // GameData takes precedence if both define it
    lookup.set(e.name, {
      tileFootprint: e.tileFootprint,
      graphics: e.graphics,
      rotatesFootprint: e.rotatesFootprint,
      localised: e.localised,
      isBeltLike: e.graphics?.kind === "belt" || e.graphics?.kind === "underground" || e.graphics?.kind === "splitter",
      isPipeLike: e.graphics?.kind === "pipe",
      isPipeToGround: e.name === "pipe-to-ground",
      isInserter: false,
      isMachine: false,
      isBeacon: false,
      moduleSlots: 0,
      showDirectionArrow: e.name.includes("combinator"),
    });
  }
  return lookup;
}

/** `tileFootprint` is stored in the entity's own north-facing local space
 *  (confirmed by spike against splitter's real collision_box: [1.8, 1],
 *  1.8 tiles across its belt lanes, 1 tile deep along the direction of
 *  travel) — for a `rotatesFootprint` entity facing east/west, width and
 *  depth swap on screen, exactly like a 90-degree rotation would to any
 *  rectangle. Only splitters set `rotatesFootprint` today, but this is
 *  generic over any future non-square entity that does too. Callers that
 *  need the entity's on-screen box (spatial index, highlight rect, ghost
 *  snapping) must go through this rather than reading `tileFootprint`
 *  directly, or they silently keep the north-facing box at every facing. */
export function effectiveFootprint(visual: ResolvedVisual, direction: number): [number, number] {
  const [w, h] = visual.tileFootprint;
  if (!visual.rotatesFootprint) return [w, h];
  const facing = toCardinal(direction);
  return facing === Dir4.East || facing === Dir4.West ? [h, w] : [w, h];
}
