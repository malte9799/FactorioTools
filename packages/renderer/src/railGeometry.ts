/** Factorio 2.0 rail geometry: where each rail piece's two ends sit, which way
 *  they face, and which tiles the piece covers. Pure data, no DOM.
 *
 *  Every rail piece joins two "rail ends". An end is a point plus the 16-way
 *  direction pointing OUT of the piece; two pieces connect when they share an
 *  end point with opposite directions. The engine hard-codes this geometry
 *  (it is not in the prototype data), so the base tables below were derived
 *  from real 2.0 blueprints and checked against the rail sprites — see
 *  test/railGeometry.test.ts, which requires the example blueprints' rails to
 *  connect up end to end.
 *
 *  Directions follow the blueprint's 16-way scheme: 0 north, 4 east, 8 south,
 *  12 west, odd values the 22.5° steps between. World y grows downward, so a
 *  90° clockwise turn maps (x, y) to (-y, x). */

export interface RailEndOffset {
  dx: number;
  dy: number;
  /** Outward direction, 0..15. */
  dir: number;
  /** True for the end that sits on the elevated layer. Only a ramp has ends
   *  on both layers; every other piece's ends share the piece's own layer. */
  elevated: boolean;
}

/** A rail end in world space. */
export interface RailEnd {
  x: number;
  y: number;
  dir: number;
  elevated: boolean;
}

/** One rail entity, as placed — name, position and 16-way direction. */
export interface RailPiece {
  name: string;
  x: number;
  y: number;
  direction: number;
}

export type RailShape = "straight" | "half-diagonal" | "curved-a" | "curved-b" | "ramp";

const SHAPE_OF: Record<string, RailShape> = {
  "straight-rail": "straight",
  "half-diagonal-rail": "half-diagonal",
  "curved-rail-a": "curved-a",
  "curved-rail-b": "curved-b",
  "elevated-straight-rail": "straight",
  "elevated-half-diagonal-rail": "half-diagonal",
  "elevated-curved-rail-a": "curved-a",
  "elevated-curved-rail-b": "curved-b",
  "rail-ramp": "ramp",
};

const GROUND_NAME: Record<Exclude<RailShape, "ramp">, string> = {
  straight: "straight-rail",
  "half-diagonal": "half-diagonal-rail",
  "curved-a": "curved-rail-a",
  "curved-b": "curved-rail-b",
};

export function railShape(name: string): RailShape | undefined {
  return SHAPE_OF[name];
}

export function isRail(name: string): boolean {
  return name in SHAPE_OF;
}

export function isElevatedRail(name: string): boolean {
  return name.startsWith("elevated-") && name in SHAPE_OF;
}

/** The entity name of a rail shape on the given layer. */
export function railName(shape: Exclude<RailShape, "ramp">, elevated: boolean): string {
  return elevated ? `elevated-${GROUND_NAME[shape]}` : GROUND_NAME[shape];
}

type BaseEnd = [dx: number, dy: number, dir: number];

/** Direction-0 ends of each shape (straight/half-diagonal also list their
 *  direction-2 form: both pieces have only 4 real facings, 8..14 repeating
 *  0..6). Curves have 8 facings: odd multiples of 2 are the mirror image
 *  (x → -x) of the even multiple of 4 below them. */
const STRAIGHT: Record<0 | 2, [BaseEnd, BaseEnd]> = {
  0: [[0, -1, 0], [0, 1, 8]],
  2: [[1, -1, 2], [-1, 1, 10]],
};
const HALF_DIAGONAL: Record<0 | 2, [BaseEnd, BaseEnd]> = {
  0: [[-1, -2, 15], [1, 2, 7]],
  2: [[1, -2, 1], [-1, 2, 9]],
};
const CURVED_A: [BaseEnd, BaseEnd] = [[0, 2, 8], [-1, -3, 15]];
const CURVED_B: [BaseEnd, BaseEnd] = [[1, 2, 7], [-2, -2, 14]];

function rotate90(dx: number, dy: number, quarterTurns: number): [number, number] {
  let x = dx;
  let y = dy;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return [x, y];
}

function placeBase(ends: [BaseEnd, BaseEnd], quarterTurns: number, mirror: boolean): [number, number, number][] {
  return ends.map(([dx, dy, dir]) => {
    const mx = mirror ? -dx : dx;
    const md = mirror ? (16 - dir) % 16 : dir;
    const [x, y] = rotate90(mx, dy, quarterTurns);
    return [x, y, (md + 4 * quarterTurns) % 16];
  });
}

const endsCache = new Map<string, RailEndOffset[]>();

/** The two ends of a rail piece, relative to its position. Empty for a name
 *  that isn't a rail. Directions are normalised: odd values (never written by
 *  the game for rails) round down to the even facing. */
export function railEnds(name: string, direction: number): RailEndOffset[] {
  const shape = SHAPE_OF[name];
  if (!shape) return [];
  const d = (((Math.floor(direction / 2) * 2) % 16) + 16) % 16;
  const key = `${name}|${d}`;
  const cached = endsCache.get(key);
  if (cached) return cached;
  const elevated = isElevatedRail(name);
  let ends: RailEndOffset[];
  if (shape === "ramp") {
    // 16 tiles long; the direction points from the ground end up to the
    // elevated end. Only the four cardinal facings exist.
    const q = Math.floor(d / 4);
    ends = placeBase([[0, 8, 8], [0, -8, 0]], q, false).map(([dx, dy, dir], i) => ({ dx, dy, dir, elevated: i === 1 }));
  } else {
    let raw: [number, number, number][];
    if (shape === "straight" || shape === "half-diagonal") {
      const table = shape === "straight" ? STRAIGHT : HALF_DIAGONAL;
      const k = d % 8;
      raw = placeBase(table[(k % 4) as 0 | 2], k >= 4 ? 1 : 0, false);
    } else {
      const k = d / 2;
      raw = placeBase(shape === "curved-a" ? CURVED_A : CURVED_B, Math.floor(k / 2), k % 2 === 1);
    }
    ends = raw.map(([dx, dy, dir]) => ({ dx, dy, dir, elevated }));
  }
  endsCache.set(key, ends);
  return ends;
}

/** A rail piece's ends in world space. */
export function railEndsAt(piece: RailPiece): RailEnd[] {
  return railEnds(piece.name, piece.direction).map((e) => ({ x: piece.x + e.dx, y: piece.y + e.dy, dir: e.dir, elevated: e.elevated }));
}

/** Unit vector of a 16-way direction. */
export function dirVector(dir: number): [number, number] {
  const a = (dir * Math.PI) / 8;
  return [Math.sin(a), -Math.cos(a)];
}

/** Track length of each shape, in tiles — the prototypes' collision box
 *  lengths, which is what the rail planner's manual_length_limit counts. */
export function railLength(name: string, direction: number): number {
  switch (SHAPE_OF[name]) {
    case "straight":
      return Math.floor(direction / 2) % 2 === 0 ? 2 : 2 * Math.SQRT2;
    case "half-diagonal":
      return 4.472;
    case "curved-a":
      return 5.032;
    case "curved-b":
      return 4.882;
    case "ramp":
      return 16;
    default:
      return 0;
  }
}

/** Points along a piece's centreline, relative to its position: a cubic
 *  through both ends, leaving each along its own direction, so curves bend
 *  the way their sprite does and straights stay straight. */
export function railCentreline(name: string, direction: number, samples = 8): [number, number][] {
  const ends = railEnds(name, direction);
  if (ends.length !== 2) return [];
  const [a, b] = ends as [RailEndOffset, RailEndOffset];
  const chord = Math.hypot(b.dx - a.dx, b.dy - a.dy);
  const [ax, ay] = dirVector(a.dir);
  const [bx, by] = dirVector(b.dir);
  // Each end's outward vector points away from the piece; the curve leaves
  // a heading inward (-a.dir) and arrives at b travelling along b.dir.
  const p0: [number, number] = [a.dx, a.dy];
  const p1: [number, number] = [a.dx - (ax * chord) / 3, a.dy - (ay * chord) / 3];
  const p2: [number, number] = [b.dx - (bx * chord) / 3, b.dy - (by * chord) / 3];
  const p3: [number, number] = [b.dx, b.dy];
  const out: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** How far a tile's centre may sit from the centreline and still count as
 *  covered — a straight rail's 2×2 footprint exactly (its tiles are 0.5 off
 *  the line, the next row out 1.5). */
const TRACK_HALF_WIDTH = 0.95;

const tilesCache = new Map<string, [number, number][]>();

/** Tiles (top-left corners) a piece covers, relative to its position. */
export function railTileOffsets(name: string, direction: number): [number, number][] {
  const d = Math.floor(direction / 2) * 2;
  const key = `${name}|${d}`;
  const cached = tilesCache.get(key);
  if (cached) return cached;
  const line = railCentreline(name, d, 16);
  const ends = railEnds(name, d);
  const tiles: [number, number][] = [];
  if (line.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of line) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const halfWidth = SHAPE_OF[name] === "ramp" ? 1.8 : TRACK_HALF_WIDTH;
    for (let ty = Math.floor(minY - 2); ty <= Math.ceil(maxY + 2); ty++) {
      for (let tx = Math.floor(minX - 2); tx <= Math.ceil(maxX + 2); tx++) {
        const cx = tx + 0.5;
        const cy = ty + 0.5;
        // A track stops dead at its ends: tiles beyond either end belong to
        // the next piece, not this one.
        if (ends.some((e) => {
          const [ux, uy] = dirVector(e.dir);
          return (cx - e.dx) * ux + (cy - e.dy) * uy > 0;
        })) continue;
        let best = Infinity;
        for (let i = 1; i < line.length; i++) {
          const [ax, ay] = line[i - 1]!;
          const [bx, by] = line[i]!;
          best = Math.min(best, distToSegment(cx, cy, ax, ay, bx, by));
        }
        if (best < halfWidth) tiles.push([tx, ty]);
      }
    }
  }
  tilesCache.set(key, tiles);
  return tiles;
}

/** World tiles (top-left corners) a placed piece covers. Rail positions are
 *  always whole numbers, so these are too. */
export function railTiles(piece: RailPiece): [number, number][] {
  return railTileOffsets(piece.name, piece.direction).map(([tx, ty]) => [piece.x + tx, piece.y + ty]);
}

/** A footprint centred on the piece's position that covers all its tiles —
 *  what hover, selection and the spatial index use, since they all assume
 *  an entity's box is centred on it. */
export function railFootprint(name: string, direction: number): [number, number] {
  let ex = 1;
  let ey = 1;
  for (const [tx, ty] of railTileOffsets(name, direction)) {
    ex = Math.max(ex, Math.abs(tx), Math.abs(tx + 1));
    ey = Math.max(ey, Math.abs(ty), Math.abs(ty + 1));
  }
  return [ex * 2, ey * 2];
}

/** Snaps a world point to the nearest position a straight rail of the given
 *  facing can occupy: cardinal straights sit on odd tile corners, diagonal
 *  straights on even ones (verified against the example blueprints). */
export function snapStraightRail(x: number, y: number, direction: number): { x: number; y: number } {
  const diagonal = Math.floor(direction / 2) % 2 === 1;
  const snap = (v: number) => (diagonal ? Math.round(v / 2) * 2 : Math.round((v - 1) / 2) * 2 + 1);
  return { x: snap(x), y: snap(y) };
}

/** Stable key for one rail entity — two pieces with the same key are the
 *  same piece and must never both exist. */
export function railKey(piece: RailPiece): string {
  const shape = SHAPE_OF[piece.name];
  // Straight and half-diagonal pieces look identical facing either way.
  const d = shape === "straight" || shape === "half-diagonal" ? Math.floor(piece.direction / 2) * 2 % 8 : Math.floor(piece.direction / 2) * 2;
  return `${piece.name}|${piece.x},${piece.y}|${d}`;
}

/** Key for a rail end, ignoring which way it faces. */
export function railEndKey(x: number, y: number, elevated: boolean): string {
  return `${x},${y},${elevated ? 1 : 0}`;
}

/** Where a signal or train stop can go, and which way it then faces. */
export interface RailSlot {
  x: number;
  y: number;
  direction: number;
}

/** Signal slots at one rail end point: for each travel direction along the
 *  joint, the half-tile centres on that direction's left 1–1.7 tiles out and
 *  within about a tile along the track — two per side. (Fitted to the example
 *  blueprints' signals; a 2.0 signal faces the trains it stops and stands on
 *  their left.) */
export function signalSlotsAt(x: number, y: number, endDir: number): RailSlot[] {
  const out: RailSlot[] = [];
  for (const direction of [endDir % 16, (endDir + 8) % 16]) {
    const [ux, uy] = dirVector(direction);
    // Left of travel, in y-down screen space.
    const lx = uy;
    const ly = -ux;
    for (let oy = -2.5; oy <= 2.5; oy++) {
      for (let ox = -2.5; ox <= 2.5; ox++) {
        const lateral = ox * lx + oy * ly;
        const along = ox * ux + oy * uy;
        if (lateral >= 1 && lateral <= 1.7 && Math.abs(along) <= 1.1) out.push({ x: x + ox, y: y + oy, direction });
      }
    }
  }
  return out;
}

/** Every signal slot along the given rails, deduplicated. */
export function signalSlots(rails: RailPiece[]): RailSlot[] {
  const seen = new Map<string, RailSlot>();
  for (const rail of rails) {
    if (railShape(rail.name) === "ramp") continue;
    for (const end of railEndsAt(rail)) {
      for (const slot of signalSlotsAt(end.x, end.y, end.dir)) seen.set(`${slot.x},${slot.y},${slot.direction}`, slot);
    }
  }
  return [...seen.values()];
}

/** Train stop slots: beside a cardinal straight rail, two tiles to the right
 *  of travel, facing the way trains stopping there travel. */
export function trainStopSlots(rails: RailPiece[]): RailSlot[] {
  const out: RailSlot[] = [];
  for (const rail of rails) {
    if (rail.name !== "straight-rail" && rail.name !== "elevated-straight-rail") continue;
    if (Math.floor(rail.direction / 2) % 2 === 1) continue;
    const axis = Math.floor(rail.direction / 4) % 2 === 0 ? 0 : 4;
    for (const direction of [axis, axis + 8]) {
      const [ux, uy] = dirVector(direction);
      out.push({ x: rail.x - Math.round(uy) * 2, y: rail.y + Math.round(ux) * 2, direction });
    }
  }
  return out;
}

/** The slot nearest a point, within `reach` tiles. */
export function nearestSlot(slots: RailSlot[], x: number, y: number, reach: number, preferDirection?: number): RailSlot | undefined {
  let best: RailSlot | undefined;
  let bestScore = reach;
  for (const s of slots) {
    // A slot facing the held direction wins a near tie, so R flips between
    // the two sides of the track instead of being ignored.
    const score = Math.hypot(s.x - x, s.y - y) - (preferDirection === s.direction ? 0.75 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
