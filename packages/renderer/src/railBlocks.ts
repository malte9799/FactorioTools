/** Rail blocks: signals divide track into blocks, which a held signal shows
 *  as a coloured line down the middle of the track, one colour per block.
 *  Pure data, no DOM.
 *
 *  Pieces that share a joint are in the same block unless a signal stands at
 *  that joint. Track that crosses other track joins its block too, as in the
 *  game: a train on the crossing occupies both. Track that only runs close
 *  by — a curve leaving a switch shares tiles with the straight beside it —
 *  doesn't. */

type Point = [number, number];

/** Where segments ab and cd meet, if they do (endpoints included). */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return undefined;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return undefined;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** True when two pieces' centrelines cross somewhere other than at a rail
 *  end: a crossing, not two pieces meeting or splitting at a joint. */
function centrelinesCross(a: Point[], b: Point[], ends: Point[]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const p = segmentsMeet(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!);
      if (!p) continue;
      // Meeting at (or right by) a rail end is a joint, not a crossing.
      if (ends.some(([ex, ey]) => Math.hypot(p[0] - ex, p[1] - ey) < 0.75)) continue;
      return true;
    }
  }
  return false;
}

import { isElevatedRail, railCentreline, railEndsAt, railTiles, type RailEnd, type RailPiece } from "./railGeometry.js";

export interface RailBlockPiece {
  piece: RailPiece;
  block: number;
  /** Per end, in railEndsAt order: true where a signal cuts the joint, so
   *  the block line stops short of it at the marker. */
  cut: [boolean, boolean];
}

/** Where a block ends at a signalled joint, as the game marks it. With
 *  signals one way only, both blocks get a triangle pointing the way those
 *  signals let trains through: "exit" on the block trains leave (tip at the
 *  joint), "entry" on the block they enter (base at the joint). With signals
 *  both ways, both blocks get a diamond. */
export interface RailBlockMarker {
  x: number;
  y: number;
  /** Outward 16-way direction of the piece end the marker sits on. */
  dir: number;
  block: number;
  kind: "exit" | "entry" | "diamond";
}

export interface RailBlocks {
  pieces: RailBlockPiece[];
  markers: RailBlockMarker[];
  /** Colour index per block; neighbouring blocks never share one. */
  colors: number[];
}

/** Line colours for blocks, as the game cycles them. */
export const RAIL_BLOCK_COLORS = ["#3ee8ff", "#ff3df2", "#ffe23d", "#3d5bff", "#4cff4c", "#ff9a3d", "#ff4c4c", "#a54cff"];

/** `signalled(x, y, dir)` is true when a signal at the joint (x, y) faces
 *  `dir` (its 16-way direction); see railPlacement's takenSignalGroups. */
export function computeRailBlocks(rails: RailPiece[], signalled: (x: number, y: number, dir: number) => boolean): RailBlocks {
  const ground = rails.filter((r) => !isElevatedRail(r.name) && r.name !== "rail-ramp");
  const parent = ground.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // A joint is cut when a signal there faces either way along it.
  const jointCut = (end: RailEnd) => signalled(end.x, end.y, end.dir) || signalled(end.x, end.y, (end.dir + 8) % 16);

  const ends = ground.map((r) => railEndsAt(r));
  const byJoint = new Map<string, { index: number; end: RailEnd }[]>();
  ends.forEach((list, index) => {
    for (const end of list) {
      const key = `${end.x},${end.y},${end.dir % 8}`;
      (byJoint.get(key) ?? byJoint.set(key, []).get(key)!).push({ index, end });
    }
  });
  for (const group of byJoint.values()) {
    if (jointCut(group[0]!.end)) continue;
    for (let i = 1; i < group.length; i++) union(group[0]!.index, group[i]!.index);
  }
  // Crossing track: pieces sharing a tile whose centrelines actually cross.
  const lines = ground.map((r) => railCentreline(r.name, r.direction, 8).map(([x, y]): Point => [r.x + x, r.y + y]));
  const byTile = new Map<string, number[]>();
  const tested = new Set<string>();
  ground.forEach((r, index) => {
    for (const [tx, ty] of railTiles(r)) {
      const key = `${tx},${ty}`;
      const here = byTile.get(key) ?? byTile.set(key, []).get(key)!;
      for (const other of here) {
        const pair = `${other},${index}`;
        if (tested.has(pair)) continue;
        tested.add(pair);
        const pairEnds = [...ends[index]!, ...ends[other]!].map((e): Point => [e.x, e.y]);
        if (centrelinesCross(lines[index]!, lines[other]!, pairEnds)) union(index, other);
      }
      here.push(index);
    }
  });

  const blockOf = new Map<number, number>();
  const pieces = ground.map((piece, i): RailBlockPiece => {
    const root = find(i);
    if (!blockOf.has(root)) blockOf.set(root, blockOf.size);
    const [a, b] = ends[i]!;
    return { piece, block: blockOf.get(root)!, cut: [!!a && jointCut(a), !!b && jointCut(b)] };
  });

  const markers: RailBlockMarker[] = [];
  const neighbours: Set<number>[] = Array.from({ length: blockOf.size }, () => new Set());
  for (const group of byJoint.values()) {
    if (!jointCut(group[0]!.end)) continue;
    for (const { index, end } of group) {
      const block = pieces[index]!.block;
      // A signal faces against the traffic it governs: one facing back along
      // this end lets trains leave through it, one facing out lets them in.
      const exit = signalled(end.x, end.y, (end.dir + 8) % 16);
      const entry = signalled(end.x, end.y, end.dir);
      markers.push({ x: end.x, y: end.y, dir: end.dir, block, kind: exit && entry ? "diamond" : exit ? "exit" : "entry" });
      for (const other of group) if (other.index !== index) neighbours[block]!.add(pieces[other.index]!.block);
    }
  }

  // Greedy colouring: each block takes the first colour no neighbour has.
  const colors: number[] = [];
  for (let b = 0; b < blockOf.size; b++) {
    const used = new Set([...neighbours[b]!].filter((n) => n < b).map((n) => colors[n]));
    let c = 0;
    while (used.has(c)) c++;
    colors.push(c % RAIL_BLOCK_COLORS.length);
  }
  return { pieces, markers, colors };
}
