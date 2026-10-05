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

const DEFAULT_CATEGORY = ["default"];

/** Two points only join when their `connection_category` lists overlap —
 *  absent means Factorio's own default category — and they don't each
 *  insist on a different fluid: a fluid box's `filter` names the one fluid
 *  it takes, so a thruster's fuel port never joins the oxidizer port of the
 *  thruster beside it. */
function sharesCategory(a: WorldPipeConnection, b: WorldPipeConnection): boolean {
  if (a.filter !== undefined && b.filter !== undefined && a.filter !== b.filter) return false;
  const other = b.categories ?? DEFAULT_CATEGORY;
  return (a.categories ?? DEFAULT_CATEGORY).some((c) => other.includes(c));
}

/** Rotates a connection point declared in an entity's own unrotated
 *  (north-facing) local frame into world space, by the entity's own
 *  placement direction. Only 4-way rotation is meaningful here — every
 *  fluid-box connection point in the dump is declared at a cardinal
 *  direction, and every fluid-box-bearing entity rotates in 90-degree
 *  steps — so `entity.direction` is first collapsed to its nearest
 *  cardinal the same way collect.ts's own `frame.direction` is. */
function rotatePoint(point: PipeConnectionPoint, entityDirection: number): { x: number; y: number; direction: Cardinal } {
  // An entity that can't be turned keeps its ports where its art has them.
  const cardinal = point.fixed ? 0 : toCardinal(entityDirection);
  const steps = Math.round(cardinal / 4) % 4;
  const direction = ((point.direction + steps * 4) % 16) as Cardinal;
  // Pumpjack's own output socket: no single base point rotates correctly
  // (its nozzle is off-center) — Factorio ships the exact position for
  // each of the 4 facings directly, so look that up instead of rotating.
  if (point.positionsByDirection) {
    const [x, y] = point.positionsByDirection[steps]!;
    return { x, y, direction };
  }
  let { x, y } = point;
  for (let i = 0; i < steps; i++) [x, y] = [-y, x];
  return { x, y, direction };
}

export type FluidPointState = "open" | "connected" | "sibling" | "siblingMixed";

export interface WorldPipeConnection {
  entityNumber: number;
  entityName: string;
  /** The point's own `connectionCategory`/`filter`/`noCover`, carried
   *  through unchanged from its PipeConnectionPoint. */
  categories?: string[];
  filter?: string;
  noCover?: boolean;
  onlyWhenConnected?: boolean;
  /** The unrotated local point this was built from — what a `fluid-point`
   *  layer's own `point` is matched against. */
  local: { x: number; y: number; direction: number };
  /** World tile the point sits on (entity centre + rotated local offset,
   *  rounded) — used for tile-for-tile connectivity matching. */
  x: number;
  y: number;
  /** The rotated local offset itself, unrounded — entity.x/y is often a
   *  half-integer (any even-width/height footprint) and offsetX/offsetY is
   *  meant to be added straight back onto it for drawing, so rounding this
   *  independently of that would drift a cover sprite off by up to a tile
   *  whenever the two roundings don't land the same way. */
  offsetX: number;
  offsetY: number;
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

  /** Turns each of `entity`'s connection points into world space and files
   *  it under the tile it lands on. */
  add(entity: PlacedEntity, connections: PipeConnectionPoint[]): void {
    for (const c of connections) {
      const rotated = rotatePoint(c, entity.direction);
      // entity.x/y themselves may already be a half-integer (any
      // even-width/height footprint, e.g. a pump facing east) — rounding
      // them before adding the rotated offset would silently shift the
      // point half a tile off, so round only the final sum for the tile key.
      const point: WorldPipeConnection = {
        entityNumber: entity.entityNumber,
        entityName: entity.name,
        categories: c.connectionCategory,
        filter: c.filter,
        noCover: c.noCover,
        onlyWhenConnected: c.onlyWhenConnected,
        local: { x: c.x, y: c.y, direction: c.direction },
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

  /** Drops every `onlyWhenConnected` point whose entity isn't actually
   *  plumbed in. Such an entity (a mining drill) is in use when one of its
   *  ports meets an ordinary fluid connection — a pipe, a tank — or a port
   *  of another such entity that is itself in use: drills pass fluid
   *  through, so a whole row lights up from one pipe at its end. An unused
   *  drill then has no ports at all, so it draws no covers. Call once,
   *  after every entity is added. */
  pruneUnused(): void {
    const optional = this.points.filter((p) => p.onlyWhenConnected);
    if (optional.length === 0) return;
    const used = new Set<number>();
    const links = new Map<number, Set<number>>();
    for (const point of optional) {
      for (const peer of this.facing(point)) {
        if (!sharesCategory(point, peer)) continue;
        if (!peer.onlyWhenConnected) {
          used.add(point.entityNumber);
          continue;
        }
        const list = links.get(point.entityNumber);
        if (list) list.add(peer.entityNumber);
        else links.set(point.entityNumber, new Set([peer.entityNumber]));
      }
    }
    const queue = [...used];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const next of links.get(id) ?? []) {
        if (used.has(next)) continue;
        used.add(next);
        queue.push(next);
      }
    }
    const keep = (p: WorldPipeConnection) => !p.onlyWhenConnected || used.has(p.entityNumber);
    this.points = this.points.filter(keep);
    for (const [key, list] of this.byTile) this.byTile.set(key, list.filter(keep));
  }

  /** Every other entity's connection point sitting one tile outward from
   *  `point` (in the direction it faces) and pointing back. */
  private facing(point: WorldPipeConnection): WorldPipeConnection[] {
    const facing = point.direction;
    const targetX = point.x + (facing === 4 ? 1 : facing === 12 ? -1 : 0);
    const targetY = point.y + (facing === 8 ? 1 : facing === 0 ? -1 : 0);
    const back = opposite(facing);
    return (this.byTile.get(`${targetX},${targetY}`) ?? []).filter(
      (c) => c.entityNumber !== point.entityNumber && c.direction === back,
    );
  }

  /** True when some other entity's own connection point sits one tile
   *  outward from `point` (in the direction it faces), points back and
   *  shares a connection category — a real, physical fluid connection, not
   *  just adjacency. */
  isConnected(point: WorldPipeConnection): boolean {
    return this.facing(point).some((c) => sharesCategory(point, c));
  }

  /** What `point` is plugged into, for `per: "fluid-point"` art. Meeting a
   *  port of another entity of the same prototype wins over everything
   *  else: `sibling` when the two ports share a category, `siblingMixed`
   *  when they don't — two fusion reactors side by side pair up every
   *  touching port (Factorio's neighbour_connectable matches plasma with
   *  coolant ports too), though no fluid flows through a mixed pair.
   *  Otherwise `connected` for a real fluid connection, else `open`. */
  stateOf(point: WorldPipeConnection): FluidPointState {
    const peers = this.facing(point);
    const siblings = peers.filter((c) => c.entityName === point.entityName);
    if (siblings.length > 0) return siblings.some((c) => sharesCategory(point, c)) ? "sibling" : "siblingMixed";
    return peers.some((c) => sharesCategory(point, c)) ? "connected" : "open";
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
    // Default-category sockets only: a plain pipe can't join a plasma port.
    return candidates?.some((c) => c.direction === direction && (c.categories ?? DEFAULT_CATEGORY).includes("default")) ?? false;
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
  pipeConnectionsOf: (entity: PlacedEntity) => PipeConnectionPoint[] | undefined,
): FluidNetwork {
  const network = new FluidNetwork();
  for (const entity of entities) {
    const connections = pipeConnectionsOf(entity);
    if (connections && connections.length > 0) network.add(entity, connections);
  }
  network.pruneUnused();
  return network;
}
