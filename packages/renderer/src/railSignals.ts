/** What each rail signal shows, worked out from the track and the trains
 *  standing on it, as the game does. Pure data, no DOM.
 *
 *  A train occupies every rail block (railBlocks.ts) its body reaches. A
 *  rail signal is red while the block behind it — the one trains pass it
 *  into — is occupied, and green otherwise. A chain signal is red for an
 *  occupied block too; over a free one it repeats the signals a train could
 *  leave that block by: green when all of them are, red when all are red,
 *  blue when only some are open. A signal that guards no track shows
 *  nothing ("none").
 *
 *  Blocks run across both layers, up ramps and along the deck, and signals
 *  on elevated track work like any other. Only ground track detects
 *  trains.
 *
 *  Trains in a blueprint stand still, so no block is ever reserved and no
 *  signal turns yellow. */

import type { SignalColor } from "@factoriotools/engine";
import type { RailBlocks } from "./railBlocks.js";
import { isElevatedRail, railCentreline, railEndsAt, type RailEnd } from "./railGeometry.js";

/** A signal standing on track: the rail joint it belongs to and the way it
 *  faces (16-way). It faces the trains it stops, so they pass it heading
 *  the opposite way. */
export interface TrackSignal {
  id: number;
  chain: boolean;
  x: number;
  y: number;
  dir: number;
  /** True for a signal on elevated track. */
  elevated: boolean;
}

/** A locomotive or wagon: its centre, heading (a fraction of a turn,
 *  clockwise from north) and collision box. */
export interface StockBox {
  x: number;
  y: number;
  orientation: number;
  width: number;
  length: number;
}

/** Unit vector of a heading, in y-down world space. */
export function headingVector(orientation: number): [number, number] {
  const a = orientation * Math.PI * 2;
  return [Math.sin(a), -Math.cos(a)];
}

/** How finely a rail's centreline is walked when testing it against a
 *  train's box, in tiles. */
const OCCUPANCY_STEP = 0.25;

/** The blocks with a train on them: those owning a rail whose centreline
 *  runs through some stock's collision box. */
export function occupiedBlocks(blocks: RailBlocks, stock: StockBox[]): Set<number> {
  const out = new Set<number>();
  if (stock.length === 0) return out;
  for (const { piece, block } of blocks.pieces) {
    // A blueprint doesn't say which layer stock stands on; it is taken to
    // be on the ground, so a train under a bridge leaves the deck free.
    if (out.has(block) || isElevatedRail(piece.name) || piece.name === "rail-ramp") continue;
    const line = railCentreline(piece.name, piece.direction, 8);
    hit: for (const s of stock) {
      // No rail piece reaches further than this from its own position.
      if (Math.hypot(piece.x - s.x, piece.y - s.y) > s.length / 2 + 12) continue;
      const [hx, hy] = headingVector(s.orientation);
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1]!;
        const [bx, by] = line[i]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / OCCUPANCY_STEP));
        for (let k = 0; k <= steps; k++) {
          const dx = piece.x + ax + ((bx - ax) * k) / steps - s.x;
          const dy = piece.y + ay + ((by - ay) * k) / steps - s.y;
          if (Math.abs(dx * hx + dy * hy) <= s.length / 2 && Math.abs(dy * hx - dx * hy) <= s.width / 2) {
            out.add(block);
            break hit;
          }
        }
      }
    }
  }
  return out;
}

const jointKey = (x: number, y: number, dir: number, elevated: boolean) => `${x},${y},${dir},${elevated ? 1 : 0}`;

export function computeSignalStates(blocks: RailBlocks, signals: TrackSignal[], occupied: ReadonlySet<number>): Map<number, SignalColor> {
  const ends = blocks.pieces.map((p) => railEndsAt(p.piece));
  // Piece ends by the joint they sit on and the way they point out of
  // their piece: a train heading `t` at a joint runs on into the pieces
  // whose end there points back at it, (t + 8) % 16.
  const endsAt = new Map<string, { index: number; other: RailEnd | undefined }[]>();
  ends.forEach((list, index) => {
    list.forEach((end, i) => {
      const key = jointKey(end.x, end.y, end.dir, end.elevated);
      (endsAt.get(key) ?? endsAt.set(key, []).get(key)!).push({ index, other: list[1 - i] });
    });
  });
  const signalAt = new Map(signals.map((s) => [jointKey(s.x, s.y, s.dir, s.elevated), s]));

  const states = new Map<number, SignalColor>();
  const resolving = new Set<number>();

  const stateOf = (signal: TrackSignal): SignalColor => {
    const known = states.get(signal.id);
    if (known) return known;
    // Chain signals round a loop each wait on the next: nothing in the
    // loop is closed, so the one asked about twice counts as open.
    if (resolving.has(signal.id)) return "green";
    resolving.add(signal.id);
    const state = resolve(signal);
    resolving.delete(signal.id);
    states.set(signal.id, state);
    return state;
  };

  const resolve = (signal: TrackSignal): SignalColor => {
    // Trains pass the signal heading away from its face, onto the pieces
    // whose end at the joint points the way the signal does.
    const first = endsAt.get(jointKey(signal.x, signal.y, signal.dir, signal.elevated)) ?? [];
    if (first.length === 0) return "none";
    if (first.some(({ index }) => occupied.has(blocks.pieces[index]!.block))) return "red";
    if (!signal.chain) return "green";

    // Walk the block from here the way a train would, to every signal it
    // could leave by.
    const exits: SignalColor[] = [];
    const seen = new Set<string>();
    const queue = [...first];
    while (queue.length > 0) {
      const { index, other } = queue.pop()!;
      if (!other) continue;
      const visit = `${index},${other.x},${other.y}`;
      if (seen.has(visit)) continue;
      seen.add(visit);
      // At the far end the train heads other.dir; a signal there for its
      // direction faces back at it.
      const exit = signalAt.get(jointKey(other.x, other.y, (other.dir + 8) % 16, other.elevated));
      if (exit) {
        exits.push(stateOf(exit));
        continue;
      }
      // A signal for the other direction only: no way through from here.
      if (signalAt.has(jointKey(other.x, other.y, other.dir, other.elevated))) continue;
      queue.push(...(endsAt.get(jointKey(other.x, other.y, (other.dir + 8) % 16, other.elevated)) ?? []));
    }
    const open = exits.filter((s) => s === "green").length;
    const closed = exits.filter((s) => s === "red" || s === "none" || s === "yellow").length;
    if (exits.length === 0 || open === exits.length) return "green";
    return closed === exits.length ? "red" : "blue";
  };

  for (const signal of signals) stateOf(signal);
  return states;
}
