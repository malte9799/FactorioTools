/** The real heat network: every entity's declared `heat_buffer.connections`
 *  points, rotated into world space and matched up tile-for-tile against
 *  every other entity's own points — the same point-to-point check
 *  neighbours/fluid.ts's FluidNetwork does for fluid boxes, kept as its own
 *  class because a heat pipe and a fluid pipe are materially different
 *  networks (a heat pipe never carries fluid and vice versa, so their
 *  connection points must never cross-match). Built once per render from
 *  every placed entity, then queried per point to decide whether a
 *  reactor's heat-connection-patch art should draw its connected or
 *  disconnected variant. */
import type { HeatConnectionPoint, PlacedEntity } from "@factoriotools/engine";
import { opposite, toCardinal, type Cardinal } from "./grid.js";

/** Rotates a connection point declared in an entity's own unrotated
 *  (north-facing) local frame into world space, by the entity's own
 *  placement direction — identical to fluid.ts's own rotatePoint. */
function rotatePoint(point: HeatConnectionPoint, entityDirection: number): { x: number; y: number; direction: Cardinal } {
  const steps = Math.round(toCardinal(entityDirection) / 4) % 4;
  let { x, y } = point;
  for (let i = 0; i < steps; i++) [x, y] = [-y, x];
  const direction = ((point.direction + steps * 4) % 16) as Cardinal;
  return { x, y, direction };
}

export interface WorldHeatConnection {
  entityNumber: number;
  /** World tile the point sits on (entity centre + rotated local offset,
   *  rounded) — used for tile-for-tile connectivity matching. */
  x: number;
  y: number;
  /** The rotated local offset itself, unrounded — entity.x/y is often a
   *  half-integer (any even-width/height footprint, e.g. heat-exchanger's
   *  own 3x2 box), and offsetX/offsetY is meant to be added straight back
   *  onto it for drawing, so rounding this independently of that would
   *  drift a patch/cover sprite off by up to a tile whenever the two
   *  roundings don't land the same way. Same convention as
   *  FluidNetwork's WorldPipeConnection. */
  offsetX: number;
  offsetY: number;
  direction: Cardinal;
}

export class HeatNetwork {
  private points: WorldHeatConnection[] = [];
  private byTile = new Map<string, WorldHeatConnection[]>();

  add(entity: PlacedEntity, connections: HeatConnectionPoint[]): void {
    for (const c of connections) {
      const rotated = rotatePoint(c, entity.direction);
      // entity.x/y themselves may already be a half-integer (any
      // even-width/height footprint) — rounding them before adding the
      // rotated offset would silently shift the point half a tile off,
      // so round only the final sum for the tile key. Confirmed by spike
      // against a real blueprint (a heat-exchanger at (4.5, -26) with an
      // adjacent heat-pipe at (4.5, -24.5)): the old
      // `Math.round(entity.y) + rotated.y` put the connection point a
      // half-tile away from where the heat-pipe's own point actually
      // registers, so isConnected() never matched them — the heat-exchanger
      // silently never showed as connected to anything, which is also why
      // its own connection-patch cap (heatCoversOf) never appeared: this
      // bug, not a missing sprite, was the real cause of the reported
      // "patch never shows" behaviour.
      const point: WorldHeatConnection = {
        entityNumber: entity.entityNumber,
        x: Math.round(entity.x + rotated.x),
        y: Math.round(entity.y + rotated.y),
        offsetX: rotated.x,
        offsetY: rotated.y,
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
   *  matching FluidNetwork.isConnected's own semantics. */
  isConnected(point: WorldHeatConnection): boolean {
    const facing = point.direction;
    const targetX = point.x + (facing === 4 ? 1 : facing === 12 ? -1 : 0);
    const targetY = point.y + (facing === 8 ? 1 : facing === 0 ? -1 : 0);
    const candidates = this.byTile.get(`${targetX},${targetY}`);
    if (!candidates) return false;
    const back = opposite(facing);
    return candidates.some((c) => c.entityNumber !== point.entityNumber && c.direction === back);
  }

  pointsFor(entityNumber: number): WorldHeatConnection[] {
    return this.points.filter((p) => p.entityNumber === entityNumber);
  }

  /** True when some entity has a connection point at world tile (x,y)
   *  facing `direction` — lets a plain heat-pipe connect visually into a
   *  reactor's own heat-buffer socket, not just another heat-pipe tile
   *  (mirrors FluidNetwork.hasConnectionFacing, used by classifyPipe the
   *  same way for fluid pipes). */
  hasConnectionFacing(x: number, y: number, direction: Cardinal): boolean {
    const candidates = this.byTile.get(`${x},${y}`);
    return candidates?.some((c) => c.direction === direction) ?? false;
  }
}

/** Builds the heat network from every placed entity's catalog-declared
 *  `heatConnections`. */
export function buildHeatNetwork(
  entities: PlacedEntity[],
  heatConnectionsOf: (name: string) => HeatConnectionPoint[] | undefined,
): HeatNetwork {
  const network = new HeatNetwork();
  for (const entity of entities) {
    const connections = heatConnectionsOf(entity.name);
    if (connections && connections.length > 0) network.add(entity, connections);
  }
  return network;
}
