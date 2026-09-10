/** The circuit/power wire network: which wires exist, where each end
 *  physically attaches to its entity's sprite, and which way a pole turns to
 *  face the wires hanging off it.
 *
 *  Only wires the blueprint itself declares are represented. Factorio records
 *  a blueprint's pole connections explicitly, so two poles standing in reach
 *  of each other are NOT wired unless the blueprint says so — auto-connecting
 *  them would draw copper the game does not.
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
