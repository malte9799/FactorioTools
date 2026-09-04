/** The real fluid network: every entity's declared fluid-box connection
 *  points, rotated into world space and matched up tile-for-tile against
 *  every other entity's own points. This replaces guessing connectivity from
 *  a single shared tile (fine for 1-tile pipes, wrong for a 3x3 storage
 *  tank's corner sockets) with the same point-to-point check the game itself
 *  uses — two points are connected when they land on the same world tile
 *  and face each other. Built once per render from every placed entity, then
 *  queried per point (today: to decide whether a storage tank's pipe-cover
 *  patch should draw) rather than re-derived per entity. */
import type { PipeConnectionPoint, PlacedEntity } from "@factoriotools/engine";
import { opposite, toCardinal, type Cardinal } from "./grid.js";

/** Rotates a connection point declared in an entity's own unrotated
 *  (north-facing) local frame into world space, by the entity's own
 *  placement direction. Only 4-way rotation is meaningful here — every
 *  fluid-box connection point in the dump is declared at a cardinal
 *  direction, and every fluid-box-bearing entity rotates in 90-degree
 *  steps — so `entity.direction` is first collapsed to its nearest
 *  cardinal the same way collect.ts's own `frame.direction` is. */
function rotatePoint(point: PipeConnectionPoint, entityDirection: number): { x: number; y: number; direction: Cardinal } {
  const steps = Math.round(toCardinal(entityDirection) / 4) % 4;
  let { x, y } = point;
  for (let i = 0; i < steps; i++) [x, y] = [-y, x];
  const direction = ((point.direction + steps * 4) % 16) as Cardinal;
  return { x, y, direction };
}

export interface WorldPipeConnection {
  entityNumber: number;
  /** World tile the point sits on (entity centre + rotated local offset). */
  x: number;
  y: number;
  /** Cardinal the connection stub points outward, after rotation. */
  direction: Cardinal;
}

/** Every placed entity's fluid-box connection points, rotated into world
 *  space. A plain pipe/pipe-to-ground/valve tile also gets synthetic points
 *  at its own 4 (or fewer) declared directions so multi-tile entities like a
 *  storage tank match against them the same way they'd match a neighbouring
 *  pipe — see buildFluidNetwork's own doc comment for why this needs the
 *  full catalog rather than just a name check. */
export class FluidNetwork {
  private points: WorldPipeConnection[] = [];
  private byTile = new Map<string, WorldPipeConnection[]>();

  add(entity: PlacedEntity, connections: PipeConnectionPoint[]): void {
    for (const c of connections) {
      const rotated = rotatePoint(c, entity.direction);
      const point: WorldPipeConnection = {
        entityNumber: entity.entityNumber,
        x: Math.round(entity.x) + rotated.x,
        y: Math.round(entity.y) + rotated.y,
        direction: rotated.direction,
      };
      this.points.push(point);
      const key = `${point.x},${point.y}`;
      const list = this.byTile.get(key);
      if (list) list.push(point);
      else this.byTile.set(key, [point]);
    }
  }

  /** True when some other entity's own connection point sits one tile
   *  outward from `point` (in the direction it faces) and points back —
   *  a real, physical fluid connection, not just adjacency. */
  isConnected(point: WorldPipeConnection): boolean {
    const facing = point.direction;
    const targetX = point.x + (facing === 4 ? 1 : facing === 12 ? -1 : 0);
    const targetY = point.y + (facing === 8 ? 1 : facing === 0 ? -1 : 0);
    const candidates = this.byTile.get(`${targetX},${targetY}`);
    if (!candidates) return false;
    const back = opposite(facing);
    return candidates.some((c) => c.entityNumber !== point.entityNumber && c.direction === back);
  }

  pointsFor(entityNumber: number): WorldPipeConnection[] {
    return this.points.filter((p) => p.entityNumber === entityNumber);
  }

  /** True when some entity has a connection point at world tile (x,y)
   *  facing `direction` — used by classifyPipe to let a plain pipe connect
   *  visually into a building's own fluid-box socket, not just another
   *  pipe-like tile (the single-tile NeighbourGrid it otherwise relies on
   *  has no notion of a machine's fluid box at all). */
  hasConnectionFacing(x: number, y: number, direction: Cardinal): boolean {
    const candidates = this.byTile.get(`${x},${y}`);
    return candidates?.some((c) => c.direction === direction) ?? false;
  }
}

/** Builds the fluid network from every placed entity's catalog-declared
 *  connection points. A plain pipe/pipe-to-ground/valve isn't in the raw
 *  catalog's `pipeConnections` yet either (extracted generically for every
 *  fluid-box prototype in the data-pipeline, pipe included, via
 *  `fluid_box.pipe_connections`) — so this needs no special-casing per
 *  entity kind, just each entity's own catalog entry. */
export function buildFluidNetwork(
  entities: PlacedEntity[],
  pipeConnectionsOf: (name: string) => PipeConnectionPoint[] | undefined,
): FluidNetwork {
  const network = new FluidNetwork();
  for (const entity of entities) {
    const connections = pipeConnectionsOf(entity.name);
    if (connections && connections.length > 0) network.add(entity, connections);
  }
  return network;
}
