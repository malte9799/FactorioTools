/** Rail blocks: signals divide track into blocks, which a held signal shows
 *  as a coloured line down the middle of the track, one colour per block.
 *  Pure data, no DOM.
 *
 *  Pieces that share a joint are in the same block unless a signal stands at
 *  that joint. Track that crosses other track joins its block too, as in the
 *  game: a train on the crossing occupies both. */

import { isElevatedRail, railEndsAt, railTiles, type RailEnd, type RailPiece } from "./railGeometry.js";

export interface RailBlockPiece {
  piece: RailPiece;
  block: number;
}

/** Where a block ends at a signalled joint: a triangle pointing into the
 *  joint when a signal there governs trains leaving the block this way,
 *  otherwise a diamond (the joint's signal faces the other way). */
export interface RailBlockMarker {
  x: number;
  y: number;
  /** Outward 16-way direction of the piece end the marker sits on. */
  dir: number;
  block: number;
  kind: "arrow" | "diamond";
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
  // Crossing track shares tiles without sharing a joint.
  const byTile = new Map<string, number>();
  ground.forEach((r, index) => {
    for (const [tx, ty] of railTiles(r)) {
      const key = `${tx},${ty}`;
      const other = byTile.get(key);
      if (other === undefined) byTile.set(key, index);
      else union(index, other);
    }
  });

  const blockOf = new Map<number, number>();
  const pieces = ground.map((piece, i) => {
    const root = find(i);
    if (!blockOf.has(root)) blockOf.set(root, blockOf.size);
    return { piece, block: blockOf.get(root)! };
  });

  const markers: RailBlockMarker[] = [];
  const neighbours: Set<number>[] = Array.from({ length: blockOf.size }, () => new Set());
  for (const group of byJoint.values()) {
    if (!jointCut(group[0]!.end)) continue;
    for (const { index, end } of group) {
      const block = pieces[index]!.block;
      // A signal facing back along this end stops trains leaving through it.
      const governs = signalled(end.x, end.y, (end.dir + 8) % 16);
      markers.push({ x: end.x, y: end.y, dir: end.dir, block, kind: governs ? "arrow" : "diamond" });
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
