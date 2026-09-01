import type { PlacedEntity } from "@factoriotools/engine";

/** Factorio direction constants (also used in blueprint JSON): 0=N, 2=E,
 *  4=S, 6=W in the 8-way scheme; 2.0 blueprints can also use the 16-way
 *  scheme (0,2,4,...14 -> N,NE,E,SE,S,SW,W,NW), but belts are always
 *  4-directional, so this module normalises to the 4-way values. */
export const enum Dir4 {
  North = 0,
  East = 4,
  South = 8,
  West = 12,
}

/** Collapses any blueprint direction value onto the nearest cardinal, since
 *  belts only ever face N/E/S/W. Always assumes the 16-way scheme (0-15,
 *  N/E/S/W at 0/4/8/12) — confirmed by spike that real 2.0 blueprint
 *  exports are 16-way-only. Guessing 8-way vs. 16-way from whether
 *  direction was <= 7 (a previous version's approach) is fundamentally
 *  ambiguous — direction 4 means "8-way South" under one scheme and
 *  "16-way East" under the other — and was silently misrotating every
 *  entity encoded with direction 4 or 8 (undergrounds, inserters, poles,
 *  belts), not just underground belts. */
export function toCardinal(direction: number): Dir4 {
  const cardinalIndex = Math.round(direction / 4) % 4;
  return [Dir4.North, Dir4.East, Dir4.South, Dir4.West][cardinalIndex]!;
}

export type BeltConnection = "straight" | "curve-left" | "curve-right" | "side-left" | "side-right";

export interface BeltFrame {
  /** Row index into the belt_animation_set sheet (0-19). Column is the
   *  animation frame, chosen by the renderer's clock, independent of
   *  connection shape. */
  row: number;
  connection: BeltConnection;
  /** Side-load rows (12-19) are NOT a standalone belt sprite — confirmed by
   *  spike opening those rows directly: they're a thin merge-chevron decal
   *  meant to be drawn ON TOP of the ordinary straight-belt frame (`row`
   *  above is already set to STRAIGHT_ROW[facing] for a side-load, exactly
   *  like the plain-straight case), not a replacement for it. Drawing only
   *  the side-load row alone (the original bug) left the belt tile
   *  underneath missing entirely, which read as the belt "ending" there.
   *  Undefined for every non-side-load connection. */
  overlayRow?: number;
}

/** Row layout re-confirmed by rendering an isolated 4-direction test
 *  blueprint and visually inspecting the actual on-screen result — the
 *  previous ordering here (N/E/S/W at rows 0/1/2/3, credited to "visually
 *  inspecting the extracted PNG") turned out to be wrong: a straight belt
 *  at direction 0 (north) rendered pointing east, confirmed by decoding
 *  turbo-transport-belt.png's actual row 0-3 content directly (chevron
 *  arrows pointing E, W, N, S respectively — a systematic
 *  counterclockwise-by-one-row offset from the assumed layout, not a
 *  per-tier quirk). CURVE_ROW and SIDE_LOAD_ROW (rows 4-19) have since
 *  been independently spiked the same way — isolated feeder+corner+
 *  continuation blueprints for all 8 curve cases and all 8 side-load
 *  cases, each with a lamp marking the feed side, cross-checked against
 *  the sheet's actual per-row pixel content — and both tables below
 *  matched the rendered output exactly, so they're confirmed correct too,
 *  not just carried over unverified. */
export const STRAIGHT_ROW: Record<Dir4, number> = {
  [Dir4.North]: 2,
  [Dir4.East]: 0,
  [Dir4.South]: 3,
  [Dir4.West]: 1,
};

/** curve[toDirection][fromSide] — a belt facing `toDirection` whose input is
 *  turning in from the left or right relative to that facing. Re-confirmed
 *  by rendering each of rows 4-11 in isolation and reading the actual
 *  on-screen shape directly (not the sheet's raw pixels, which the
 *  earlier version of this table's own doc comment claimed to have done
 *  but got wrong for every single row): row 4 is East-input curving to
 *  North, row 5 is North-input curving to East, row 6 is West-input
 *  curving to North, row 7 is North-input curving to West, row 8 is
 *  South-input curving to East, row 9 is East-input curving to South, row
 *  10 is South-input curving to West, row 11 is West-input curving to
 *  South — confirmed against the real game's own top-left-corner-of-a-loop
 *  case (South-input curving to East, i.e. "from below going right"),
 *  which the previous table rendered as East-input curving to South
 *  instead (backwards). */
const CURVE_ROW: Record<Dir4, { left: number; right: number }> = {
  [Dir4.North]: { left: 6, right: 4 },
  [Dir4.East]: { left: 5, right: 8 },
  [Dir4.South]: { left: 9, right: 11 },
  [Dir4.West]: { left: 10, right: 7 },
};

const SIDE_LOAD_ROW: Record<Dir4, { left: number; right: number }> = {
  [Dir4.North]: { left: 12, right: 16 },
  [Dir4.East]: { left: 13, right: 17 },
  [Dir4.South]: { left: 14, right: 18 },
  [Dir4.West]: { left: 15, right: 19 },
};

export function opposite(dir: Dir4): Dir4 {
  return ((dir + 8) % 16) as Dir4;
}

function leftOf(dir: Dir4): Dir4 {
  return ((dir + 12) % 16) as Dir4;
}

function rightOf(dir: Dir4): Dir4 {
  return ((dir + 4) % 16) as Dir4;
}

function offsetFor(dir: Dir4): { dx: number; dy: number } {
  switch (dir) {
    case Dir4.North: return { dx: 0, dy: -1 };
    case Dir4.East: return { dx: 1, dy: 0 };
    case Dir4.South: return { dx: 0, dy: 1 };
    case Dir4.West: return { dx: -1, dy: 0 };
  }
}

export interface BeltLookupEntity {
  entityNumber: number;
  name: string;
  x: number;
  y: number;
  direction: number;
  /** True for belts/splitters/undergrounds — anything that can feed a belt
   *  tile. The renderer passes its own classification (from GameData/
   *  RenderCatalog) rather than this module re-deriving entity kind. */
  isBeltLike: boolean;
}

/** Classifies one belt's connection shape by inspecting its immediate
 *  neighbors, mirroring the neighbor-inspection approach documented in
 *  factorio-blueprint-editor/factorio-scanner (studied for this pattern, not
 *  reused as code). Needs a position index built once per blueprint. */
export function classifyBelt(
  belt: BeltLookupEntity,
  positionIndex: Map<string, BeltLookupEntity>,
): BeltFrame {
  const facing = toCardinal(belt.direction);
  const behind = opposite(facing);
  const left = leftOf(facing);
  const right = rightOf(facing);

  const neighborAt = (dir: Dir4): BeltLookupEntity | undefined => {
    const { dx, dy } = offsetFor(dir);
    return positionIndex.get(`${belt.x + dx},${belt.y + dy}`);
  };

  // A neighbor "feeds into" this belt if it's belt-like and its own facing
  // points toward this tile (i.e. the neighbor's forward offset lands here).
  const feedsIn = (neighbor: BeltLookupEntity | undefined, fromDir: Dir4): boolean => {
    if (!neighbor?.isBeltLike) return false;
    const neighborFacing = toCardinal(neighbor.direction);
    return neighborFacing === opposite(fromDir);
  };

  const behindNeighbor = neighborAt(behind);
  const leftNeighbor = neighborAt(left);
  const rightNeighbor = neighborAt(right);

  const straightFeed = feedsIn(behindNeighbor, behind);
  const leftFeed = feedsIn(leftNeighbor, left);
  const rightFeed = feedsIn(rightNeighbor, right);

  // A perpendicular feed without a straight-behind feed is a curve (the
  // belt bends to receive from the side); with a straight-behind feed too,
  // it's a side-load (items merge in from the side onto an otherwise
  // straight run) — this distinction is exactly what rows 4-11 vs 12-19
  // represent. A side-load's row 12-19 is only a thin merge decal, NOT a
  // full belt sprite (confirmed by spike, see BeltFrame's own doc comment)
  // — `row` stays the ordinary STRAIGHT_ROW so the belt underneath still
  // renders, and the decal goes out via `overlayRow` for the renderer to
  // draw on top of it.
  if (leftFeed && !rightFeed) {
    return straightFeed
      ? { row: STRAIGHT_ROW[facing], connection: "side-left", overlayRow: SIDE_LOAD_ROW[facing].left }
      : { row: CURVE_ROW[facing].left, connection: "curve-left" };
  }
  if (rightFeed && !leftFeed) {
    return straightFeed
      ? { row: STRAIGHT_ROW[facing], connection: "side-right", overlayRow: SIDE_LOAD_ROW[facing].right }
      : { row: CURVE_ROW[facing].right, connection: "curve-right" };
  }
  return { row: STRAIGHT_ROW[facing], connection: "straight" };
}

/** A splitter's own (entityNumber, x, y) don't index it correctly at all:
 *  unlike a plain belt/underground, a splitter straddles TWO lane tiles
 *  side by side (its real collision_box is 1.8 tiles across, confirmed by
 *  spike — see SplitterGraphics' own doc comment in types.ts), offset ±0.5
 *  tile perpendicular to its own facing (X for north/south, Y for
 *  east/west — the same lane math SplitterRenderer's own LANE_OFFSET uses
 *  to draw the two belt lanes side by side). Indexing it once at its own
 *  rounded center (the previous approach) put it under only ONE of its two
 *  lane cells — a belt feeding the OTHER lane found nothing there and
 *  stayed straight instead of curving in, which is exactly the reported
 *  "only one side of the splitter connects" bug. Both lane entries share
 *  the splitter's own entityNumber/direction — the splitter has one
 *  facing, not one per lane. */
function splitterLaneCells(e: PlacedEntity): { x: number; y: number }[] {
  const facing = toCardinal(e.direction);
  const [dx, dy] = facing === Dir4.North || facing === Dir4.South ? [0.5, 0] : [0, 0.5];
  return [
    { x: Math.round(e.x - dx), y: Math.round(e.y - dy) },
    { x: Math.round(e.x + dx), y: Math.round(e.y + dy) },
  ];
}

/** Builds the `x,y -> entity` lookup classifyBelt needs, once per loaded
 *  blueprint. Belts/undergrounds are exactly 1x1-tile aligned, so integer-
 *  tile keys are exact; splitters need splitterLaneCells' own two-cell
 *  indexing instead (see its doc comment). */
export function buildPositionIndex(entities: PlacedEntity[], isBeltLike: (name: string) => boolean): Map<string, BeltLookupEntity> {
  const index = new Map<string, BeltLookupEntity>();
  for (const e of entities) {
    if (!isBeltLike(e.name)) continue;
    const cells = e.name.includes("splitter") ? splitterLaneCells(e) : [{ x: Math.round(e.x), y: Math.round(e.y) }];
    for (const cell of cells) {
      index.set(`${cell.x},${cell.y}`, {
        entityNumber: e.entityNumber,
        name: e.name,
        x: cell.x,
        y: cell.y,
        direction: e.direction,
        isBeltLike: true,
      });
    }
  }
  return index;
}

/** Precomputes classifyBelt's result for every plain transport belt in the
 *  blueprint, once, so the draw loop can look it up instead of re-running
 *  the 4-neighbor classification every frame for every visible belt — the
 *  neighbor structure only changes when entities are placed/removed/
 *  rotated (whenever buildPositionIndex itself is rebuilt), not every
 *  frame. Keyed by entityNumber rather than position, matching how the
 *  renderer already has the PlacedEntity (and its entityNumber) in hand at
 *  draw time. Only plain belts are worth caching this way — splitters and
 *  undergrounds have their own renderers that don't call classifyBelt. */
export function buildBeltFrameCache(entities: PlacedEntity[], isBeltLike: (name: string) => boolean, positionIndex: Map<string, BeltLookupEntity>): Map<number, BeltFrame> {
  const cache = new Map<number, BeltFrame>();
  for (const e of entities) {
    if (!isBeltLike(e.name) || e.name.includes("splitter") || e.name.includes("underground")) continue;
    const self: BeltLookupEntity = {
      entityNumber: e.entityNumber,
      name: e.name,
      x: Math.round(e.x),
      y: Math.round(e.y),
      direction: e.direction,
      isBeltLike: true,
    };
    cache.set(e.entityNumber, classifyBelt(self, positionIndex));
  }
  return cache;
}
