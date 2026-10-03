/** The circuit/power wire network: which wires exist, where each end
 *  physically attaches to its entity's sprite, and which way a pole turns to
 *  face the wires hanging off it.
 *
 *  A LOADED blueprint's wires are exactly the ones it declares. Factorio
 *  records pole connections explicitly, so two poles standing in reach of
 *  each other are NOT wired unless the blueprint says so — inventing copper
 *  on load would draw wires the game does not.
 *
 *  A NEWLY PLACED pole is the one exception, and it mirrors the game rather
 *  than the file: dropping a pole next to a powered one joins the network on
 *  the spot. See autoConnectPole.
 */
import type { PlacedEntity, WireAttachPoints, WireColor, WireLink } from "@factoriotools/engine";
import type { ResolvedVisual } from "../entityLookup.js";
import { toCardinal } from "./grid.js";

/** One wire, resolved to the two world-space points it should be drawn
 *  between. */
export interface ResolvedWire {
  color: WireColor;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** False when the two entities are further apart than the shorter of their
   *  wire reaches — the game draws such a wire faded, because it would break
   *  if the blueprint were built as-is. */
  reaches: boolean;
}

/** Everything the renderer needs to know about one blueprint's wires. */
export interface WireNetwork {
  wires: WireLink[];
  /** entityNumber -> the entities it is wired to, either colour. Poles use
   *  this to work out which way to face. */
  neighbours: Map<number, number[]>;
  /** entityNumber -> the facing (0..15) its wires imply. Poles only; every
   *  other entity keeps its own blueprint direction. */
  poleDirection: Map<number, number>;
}

const EMPTY_NETWORK: WireNetwork = {
  wires: [],
  neighbours: new Map(),
  poleDirection: new Map(),
};

/** Angle of (dx, dy) in degrees, measured counter-clockwise from east, in
 *  [0, 360). Y is screen-space (down-positive), so callers invert it to get
 *  the maths convention this expects. */
function angleOf(dx: number, dy: number): number {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Which of the pole's 4 sprite facings best points at one neighbour.
 *
 *  Ported from the reference editor's `getPowerPoleRotation`. The circle is
 *  cut into 8 sectors and offset by 1.5 sectors so a facing covers the
 *  90 degrees CENTRED on its own direction rather than starting at it —
 *  without that offset every pole leans one eighth-turn off true.
 */
function angleToSector(angle: number): 0 | 1 | 2 | 3 {
  const clockwise = 360 - angle;
  const sectorAngle = 360 / 8;
  let shifted = clockwise - sectorAngle * 1.5;
  if (shifted < 0) shifted += 360;
  return (Math.floor(shifted / sectorAngle) % 4) as 0 | 1 | 2 | 3;
}

/** The facing a pole takes given where its wired neighbours sit.
 *
 *  A pole has only 4 sprites but can be wired in any number of directions, so
 *  the game averages: each neighbour votes for a sector, and the mean sector
 *  becomes the facing. Returned in this project's 16-way direction scheme
 *  (sector * 4), matching what every sprite lookup expects. An unwired pole
 *  keeps facing north.
 */
export function poleDirectionFor(
  centre: { x: number; y: number },
  neighbours: { x: number; y: number }[],
): number {
  if (neighbours.length === 0) return 0;
  let sum = 0;
  for (const p of neighbours) {
    // Invert Y: the sector maths is in standard maths orientation, while
    // world Y grows downward.
    sum += angleToSector(angleOf(p.x - centre.x, -(p.y - centre.y)));
  }
  return Math.floor(sum / neighbours.length) * 4;
}

/** Builds the wire network for one blueprint: the adjacency every pole needs
 *  to orient itself, and the per-pole facing that follows from it. */
export function buildWireNetwork(
  wires: WireLink[],
  entities: PlacedEntity[],
  isPole: (name: string) => boolean,
): WireNetwork {
  if (wires.length === 0) return EMPTY_NETWORK;

  const byNumber = new Map(entities.map((e) => [e.entityNumber, e]));
  const neighbours = new Map<number, number[]>();
  const push = (from: number, to: number): void => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };
  for (const wire of wires) {
    push(wire.from, wire.to);
    push(wire.to, wire.from);
  }

  const poleDirection = new Map<number, number>();
  for (const [entityNumber, connected] of neighbours) {
    const self = byNumber.get(entityNumber);
    if (!self || !isPole(self.name)) continue;
    const points: { x: number; y: number }[] = [];
    for (const other of connected) {
      const e = byNumber.get(other);
      // A pole leans toward everything it is wired to, not only other poles:
      // a red wire to a combinator turns it just as a copper wire to a pole
      // does, which is what the game itself shows.
      if (e) points.push({ x: e.x, y: e.y });
    }
    poleDirection.set(entityNumber, poleDirectionFor(self, points));
  }

  return { wires, neighbours, poleDirection };
}

/** Where one colour of wire attaches to an entity, in world tiles.
 *
 *  The prototype gives attachment points per 4-way facing, in the entity's
 *  own local frame with the offset already baked in for that facing — so the
 *  point is looked up by facing and then simply added to the entity's centre,
 *  never rotated here. Rotating it again would double-apply the facing.
 */
function attachPoint(
  points: WireAttachPoints | undefined,
  entity: PlacedEntity,
  direction: number,
  color: WireColor,
  useSecondCopper: boolean,
): { x: number; y: number } | undefined {
  if (!points) return undefined;
  if (useSecondCopper && points.secondCopper) {
    return { x: entity.x + points.secondCopper[0], y: entity.y + points.secondCopper[1] };
  }
  const facing = toCardinal(direction) / 4;
  const point = points.byDirection[facing] ?? points.byDirection[0];
  const offset = point?.[color];
  if (!offset) return undefined;
  return { x: entity.x + offset[0], y: entity.y + offset[1] };
}

/** Where one colour's wire attaches to a single entity, in world tiles.
 *
 *  The same terminal maths resolveWires uses for a finished wire's ends,
 *  exposed for the in-progress wire that trails from an armed entity to the
 *  cursor: both must leave from exactly the same point on the sprite, or the
 *  wire would visibly jump the moment the second end is clicked.
 *
 *  Side 1 is a plain entity's only terminal (and a combinator's input); side
 *  2 is a combinator's output or a power switch's right copper post. */
export function terminalFor(
  entity: PlacedEntity,
  visual: ResolvedVisual | undefined,
  direction: number,
  color: WireColor,
  side: 1 | 2 = 1,
): { x: number; y: number } | undefined {
  if (!visual) return undefined;
  const points = side === 2 && visual.outputWireConnections ? visual.outputWireConnections : visual.wireConnections;
  return attachPoint(points, entity, direction, color, side === 2 && !visual.outputWireConnections);
}

/** Resolves every wire to the two world points it connects, dropping any
 *  whose endpoints cannot be located (an entity missing from the blueprint,
 *  or one whose prototype declares no terminal of that colour). */
export function resolveWires(
  network: WireNetwork,
  entities: PlacedEntity[],
  visualFor: (name: string) => ResolvedVisual | undefined,
  directionOf: (entity: PlacedEntity) => number,
): ResolvedWire[] {
  const byNumber = new Map(entities.map((e) => [e.entityNumber, e]));
  const out: ResolvedWire[] = [];

  for (const wire of network.wires) {
    const a = byNumber.get(wire.from);
    const b = byNumber.get(wire.to);
    if (!a || !b) continue;
    const va = visualFor(a.name);
    const vb = visualFor(b.name);
    if (!va || !vb) continue;

    // Side 2 means a combinator's output terminal, or a power switch's right
    // copper post — both sit elsewhere on the sprite than side 1.
    const pointsA = wire.fromSide === 2 && va.outputWireConnections ? va.outputWireConnections : va.wireConnections;
    const pointsB = wire.toSide === 2 && vb.outputWireConnections ? vb.outputWireConnections : vb.wireConnections;

    const p1 = attachPoint(pointsA, a, directionOf(a), wire.color, wire.fromSide === 2 && !va.outputWireConnections);
    const p2 = attachPoint(pointsB, b, directionOf(b), wire.color, wire.toSide === 2 && !vb.outputWireConnections);
    if (!p1 || !p2) continue;

    // Reach is measured centre to centre against the SHORTER of the two
    // reaches, matching the game: a big pole's 32 tiles does not let a small
    // pole reach further than its own 7.5.
    const limit = Math.min(va.maxWireDistance ?? Infinity, vb.maxWireDistance ?? Infinity);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const reaches = !Number.isFinite(limit) || dx * dx + dy * dy <= limit * limit;

    out.push({ color: wire.color, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, reaches });
  }

  return out;
}

/* ---------- Editing the network ---------- */

/** How many copper wires one pole may carry. Factorio's own limit, and the
 *  reason a pole in a dense field does not end up wired to everything around
 *  it. Circuit (red/green) wires are not subject to it. */
const MAX_POLE_COPPER_WIRES = 5;

/** True when `a` and `b` are already joined by a wire of this colour, in
 *  either direction. Wires are undirected, so the stored order of the two
 *  ends says nothing about which is "first". */
export function wireExists(wires: WireLink[], color: WireColor, a: number, b: number, aSide?: 1 | 2, bSide?: 1 | 2): boolean {
  return wires.some((w) => w.color === color && sameEnds(w, a, b, aSide, bSide));
}

/** Whether a wire joins these two ends, in either order. A side left out
 *  matches either side. */
function sameEnds(w: WireLink, a: number, b: number, aSide?: 1 | 2, bSide?: 1 | 2): boolean {
  const end = (n: number, side: 1 | 2, want: number, wantSide?: 1 | 2) => n === want && (wantSide === undefined || side === wantSide);
  return (end(w.from, w.fromSide, a, aSide) && end(w.to, w.toSide, b, bSide)) || (end(w.from, w.fromSide, b, bSide) && end(w.to, w.toSide, a, aSide));
}

/** Whether this entity has a terminal of the given colour at all — a pole has
 *  copper plus red/green, a combinator only red/green, a belt none. Used to
 *  reject an invalid target before it becomes a pending pick, so the gesture
 *  never leaves the user half-way through a wire that could not exist. */
export function canWire(visual: ResolvedVisual | undefined, color: WireColor): boolean {
  if (!visual) return false;
  const has = (points: WireAttachPoints | undefined): boolean =>
    points?.byDirection.some((p) => p?.[color] !== undefined) ?? false;
  return has(visual.wireConnections) || has(visual.outputWireConnections);
}

/** Adds the wire if it is absent, removes it if it is present, and reports
 *  which happened. One gesture toggles, so clicking the same pair twice is a
 *  no-op overall rather than stacking duplicate wires. */
export function toggleWire(
  wires: WireLink[],
  color: WireColor,
  a: number,
  b: number,
  aSide: 1 | 2 = 1,
  bSide: 1 | 2 = 1,
): { wires: WireLink[]; connected: boolean } {
  // A combinator may be wired from its input to its own output (a memory
  // cell, a clock); any other wire needs two different ends.
  if (a === b && aSide === bSide) return { wires, connected: false };
  if (wireExists(wires, color, a, b, aSide, bSide)) {
    return {
      wires: wires.filter((w) => !(w.color === color && sameEnds(w, a, b, aSide, bSide))),
      connected: false,
    };
  }
  // Side 1 is a pole's or plain entity's terminal and a combinator's input;
  // side 2 a combinator's output.
  return { wires: [...wires, { color, from: a, fromSide: aSide, to: b, toSide: bSide }], connected: true };
}

/** Which terminal of an entity a click at (x, y) means: the output side of
 *  a combinator when the click is nearer its output, else side 1. */
export function terminalSideAt(
  entity: PlacedEntity,
  visual: ResolvedVisual | undefined,
  direction: number,
  color: WireColor,
  at: { x: number; y: number },
): 1 | 2 {
  if (!visual?.outputWireConnections) return 1;
  const input = terminalFor(entity, visual, direction, color, 1);
  const output = terminalFor(entity, visual, direction, color, 2);
  if (!input || !output) return output ? 2 : 1;
  const d = (p: { x: number; y: number }) => (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
  return d(output) < d(input) ? 2 : 1;
}

/** Copper wires a freshly placed pole should take on, mirroring the game's
 *  own "drop a pole beside a powered one and it joins the network".
 *
 *  Ported from the reference editor's connectPowerPole rather than invented,
 *  because the obvious rule — wire every pole in reach — is wrong in a way
 *  that only shows up on a dense field: it produces a cobweb. The real rule
 *  has two limiters that matter:
 *
 *  - A pole already carrying MAX_POLE_COPPER_WIRES copper wires is not a
 *    candidate, and the new pole itself takes at most that many.
 *  - Each pole picked also blacklists everything IT is already wired to, so
 *    the new pole joins a connected clump once instead of once per member.
 *
 *  Candidates are taken nearest-first by Manhattan distance, which is what
 *  makes the choice deterministic and keeps the wires short.
 */
export function autoConnectPole(
  placed: PlacedEntity,
  entities: PlacedEntity[],
  wires: WireLink[],
  visualFor: (name: string) => ResolvedVisual | undefined,
  isPole: (name: string) => boolean,
): WireLink[] {
  if (!isPole(placed.name)) return wires;
  const selfReach = visualFor(placed.name)?.maxWireDistance;
  if (selfReach === undefined) return wires;

  // Copper-wire counts and adjacency, computed once rather than per candidate.
  const copperCount = new Map<number, number>();
  const copperNeighbours = new Map<number, number[]>();
  for (const w of wires) {
    if (w.color !== "copper") continue;
    for (const [self, other] of [[w.from, w.to], [w.to, w.from]] as const) {
      copperCount.set(self, (copperCount.get(self) ?? 0) + 1);
      const list = copperNeighbours.get(self);
      if (list) list.push(other);
      else copperNeighbours.set(self, [other]);
    }
  }

  const candidates = entities
    .filter((e) => {
      if (e.entityNumber === placed.entityNumber || !isPole(e.name)) return false;
      if ((copperCount.get(e.entityNumber) ?? 0) >= MAX_POLE_COPPER_WIRES) return false;
      if (wireExists(wires, "copper", placed.entityNumber, e.entityNumber)) return false;
      const reach = visualFor(e.name)?.maxWireDistance;
      if (reach === undefined) return false;
      // Reach is the SHORTER of the two, same rule resolveWires uses to
      // decide whether an existing wire is drawn faded.
      const limit = Math.min(reach, selfReach);
      const dx = e.x - placed.x;
      const dy = e.y - placed.y;
      return dx * dx + dy * dy <= limit * limit;
    })
    .sort(
      (a, b) =>
        Math.abs(a.x - placed.x) + Math.abs(a.y - placed.y) -
        (Math.abs(b.x - placed.x) + Math.abs(b.y - placed.y)),
    );

  const added: WireLink[] = [];
  const blacklist = new Set<number>();
  let budget = MAX_POLE_COPPER_WIRES - (copperCount.get(placed.entityNumber) ?? 0);

  for (const pole of candidates) {
    if (budget <= 0) break;
    if (blacklist.has(pole.entityNumber)) continue;
    budget -= 1;

    blacklist.add(pole.entityNumber);
    // Everything this pole already reaches is now considered joined, so the
    // new pole does not also wire itself to each of them individually.
    for (const other of copperNeighbours.get(pole.entityNumber) ?? []) blacklist.add(other);

    added.push({
      color: "copper",
      from: placed.entityNumber,
      fromSide: 1,
      to: pole.entityNumber,
      toSide: 1,
    });
  }

  return added.length > 0 ? [...wires, ...added] : wires;
}

/** Drops every wire touching these entities — what erasing a pole must do,
 *  or its wires would hang in the air pointing at something that is gone. */
export function dropWiresFor(wires: WireLink[], removed: Set<number>): WireLink[] {
  return wires.filter((w) => !removed.has(w.from) && !removed.has(w.to));
}
