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

/** RailGraphics' own 8 named slots — straight-rail is the first entity kind
 *  in this codebase with genuinely distinct art for the 4 diagonal
 *  directions too (every other directional entity collapses to 4-way via
 *  toCardinal). Values match the 16-way blueprint scheme's own diagonal
 *  slots (2/6/10/14 — see this file's own top doc comment), confirmed
 *  against teoxoy/factorio-blueprint-editor's getDirName8Way. */
export type Dir8Name = "north" | "northeast" | "east" | "southeast" | "south" | "southwest" | "west" | "northwest";
const DIR8_NAMES: Dir8Name[] = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/** Rounds any blueprint direction value onto the nearest of the 8 named
 *  compass slots (0,2,4,...,14 -> north,northeast,east,...,northwest). */
export function toDir8Name(direction: number): Dir8Name {
  const index = Math.round(direction / 2) % 8;
  return DIR8_NAMES[index]!;
}

export type BeltConnection = "straight" | "curve-left" | "curve-right" | "side-left" | "side-right";

export interface BeltFrame {
  /** Row index into the belt_animation_set sheet (0-19). Column is the
   *  animation frame, chosen by the renderer's clock, independent of
   *  connection shape. */
  row: number;
  connection: BeltConnection;
  /** Rows 12-19 are NOT side-load merge decals — that was this codebase's
   *  own earlier misreading of the sheet (see the project's "verify sprite
   *  reads in-app" rule: even a spike that "cross-checked against the
   *  sheet's actual per-row pixel content" got the SEMANTICS wrong here,
   *  not just the row numbers, since the pixel content alone doesn't say
   *  what a row means). Ported from teoxoy/factorio-blueprint-editor's
   *  getBeltSpriteFromData: rows 12-19 are START/END caps — a thin
   *  chevron decal drawn ON TOP of the ordinary straight-belt frame
   *  (`row` above stays STRAIGHT_ROW[facing]) at the tile's own back edge
   *  (start, when nothing feeds into this belt) or front edge (end, when
   *  nothing receives this belt's output) — see START_ROW/END_ROW below
   *  and classifyBelt's own doc comment. Side-loading (an item merging in
   *  from the side while the belt continues straight) has no dedicated
   *  decal at all in the real sprite data — it's purely a gameplay/logic
   *  distinction, invisible in the art. Up to 2 of these can apply to one
   *  tile (an isolated single-tile belt has both a start and an end cap),
   *  hence an array rather than one optional field. */
  overlayRows: number[];
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

/** Start-cap row per facing — drawn when nothing feeds into this belt's
 *  back edge. Ported directly from getBeltSpriteFromData's 'start' case
 *  (bas.starting_{south,west,north,east}_index defaults 13/15/17/19,
 *  1-based; converted to this codebase's 0-based rows here), confirmed
 *  against the real sheet's row content (each shows a chevron sitting at
 *  one frame edge, consistent with an end-of-belt cap) rather than
 *  trusted from the reference alone. */
const START_ROW: Record<Dir4, number> = {
  [Dir4.North]: 12,
  [Dir4.East]: 14,
  [Dir4.South]: 16,
  [Dir4.West]: 18,
};

/** End-cap row per facing — drawn when nothing receives this belt's
 *  output ahead. Ported from getBeltSpriteFromData's 'end' case
 *  (bas.ending_{north,east,south,west}_index defaults 18/20/14/16,
 *  1-based -> 0-based rows here). */
const END_ROW: Record<Dir4, number> = {
  [Dir4.North]: 17,
  [Dir4.East]: 19,
  [Dir4.South]: 13,
  [Dir4.West]: 15,
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
  const aheadNeighbor = neighborAt(facing);
  const leftNeighbor = neighborAt(left);
  const rightNeighbor = neighborAt(right);

  const straightFeed = feedsIn(behindNeighbor, behind);
  const leftFeed = feedsIn(leftNeighbor, left);
  const rightFeed = feedsIn(rightNeighbor, right);

  // Start/end caps are independent of straight-vs-curve shape (ported from
  // getBeltSprites: both are computed unconditionally alongside the base
  // sprite, not as alternatives to it) — a belt gets a start cap whenever
  // NOTHING belt-like sits behind it at all (regardless of that neighbor's
  // own facing; an unrelated belt pointing the wrong way still means this
  // tile isn't truly the start of a line, but the real game still doesn't
  // draw a cap there — only a fully empty/non-belt tile behind does),
  // matching the reference's plain `if (conn.from)`/`if (conn.to)` presence
  // check rather than feedsIn's stricter facing check (which is reserved
  // for deciding curve-vs-straight, a different question).
  const overlayRows: number[] = [];
  if (!behindNeighbor?.isBeltLike) overlayRows.push(START_ROW[facing]);
  if (!aheadNeighbor?.isBeltLike) overlayRows.push(END_ROW[facing]);

  // A perpendicular feed without a straight-behind feed is a curve (the
  // belt bends to receive from the side); a perpendicular feed WITH a
  // straight-behind feed is a side-load (items merge in from the side onto
  // an otherwise straight run) — side-loading has no dedicated sprite of
  // its own (see BeltFrame's own doc comment), so it's visually identical
  // to plain "straight" here; `connection` still records it distinctly for
  // any future caller that cares about the logical shape, not just pixels.
  if (leftFeed && !rightFeed) {
    return straightFeed
      ? { row: STRAIGHT_ROW[facing], connection: "side-left", overlayRows }
      : { row: CURVE_ROW[facing].left, connection: "curve-left", overlayRows };
  }
  if (rightFeed && !leftFeed) {
    return straightFeed
      ? { row: STRAIGHT_ROW[facing], connection: "side-right", overlayRows }
      : { row: CURVE_ROW[facing].right, connection: "curve-right", overlayRows };
  }
  return { row: STRAIGHT_ROW[facing], connection: "straight", overlayRows };
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
