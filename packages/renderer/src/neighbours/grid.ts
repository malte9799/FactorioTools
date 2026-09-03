import type { PlacedEntity } from "@factoriotools/engine";

/** Blueprint direction values, 16-way scheme. */
export enum Dir {
  North = 0,
  NorthEast = 2,
  East = 4,
  SouthEast = 6,
  South = 8,
  SouthWest = 10,
  West = 12,
  NorthWest = 14,
}

export const CARDINALS = [Dir.North, Dir.East, Dir.South, Dir.West] as const;
export type Cardinal = (typeof CARDINALS)[number];

const DIR4_NAMES = ["north", "east", "south", "west"] as const;
const DIR8_NAMES = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

export function toCardinal(direction: number): Cardinal {
  return CARDINALS[Math.round(direction / 4) % 4]!;
}

export function dir4Name(direction: number): (typeof DIR4_NAMES)[number] {
  return DIR4_NAMES[Math.round(direction / 4) % 4]!;
}

export function dir8Name(direction: number): (typeof DIR8_NAMES)[number] {
  return DIR8_NAMES[Math.round(direction / 2) % 8]!;
}

export function opposite(dir: Cardinal): Cardinal {
  return ((dir + 8) % 16) as Cardinal;
}

export function leftOf(dir: Cardinal): Cardinal {
  return ((dir + 12) % 16) as Cardinal;
}

export function rightOf(dir: Cardinal): Cardinal {
  return ((dir + 4) % 16) as Cardinal;
}

export function step(dir: Cardinal): { dx: number; dy: number } {
  switch (dir) {
    case Dir.North: return { dx: 0, dy: -1 };
    case Dir.East: return { dx: 1, dy: 0 };
    case Dir.South: return { dx: 0, dy: 1 };
    case Dir.West: return { dx: -1, dy: 0 };
  }
}

/** What a classifier needs to know about a neighbouring entity. */
export interface Neighbour {
  name: string;
  direction: number;
  undergroundType?: "input" | "output";
}

/** Tile lookup over the placed entities, shared by every classifier. */
export class NeighbourGrid {
  private cells = new Map<string, Neighbour>();

  at(x: number, y: number): Neighbour | undefined {
    return this.cells.get(`${x},${y}`);
  }

  towards(x: number, y: number, dir: Cardinal): Neighbour | undefined {
    const { dx, dy } = step(dir);
    return this.at(x + dx, y + dy);
  }

  set(x: number, y: number, n: Neighbour): void {
    this.cells.set(`${x},${y}`, n);
  }
}

/** A splitter straddles two tiles side by side, offset perpendicular to its
 *  facing — its own two lane cells, in the same -side/+side order
 *  splitterGraphics's lane(-1)/lane(1) shift the art by. Exported so the
 *  belt classifier can run once per lane instead of once at the entity's
 *  own (in-between, tile-less) centre. */
export function splitterLaneCells(e: PlacedEntity): [{ x: number; y: number }, { x: number; y: number }] {
  const facing = toCardinal(e.direction);
  const [dx, dy] = facing === Dir.North || facing === Dir.South ? [0.5, 0] : [0, 0.5];
  return [
    { x: Math.round(e.x - dx), y: Math.round(e.y - dy) },
    { x: Math.round(e.x + dx), y: Math.round(e.y + dy) },
  ];
}

function cellsOf(e: PlacedEntity): { x: number; y: number }[] {
  if (!e.name.includes("splitter")) return [{ x: Math.round(e.x), y: Math.round(e.y) }];
  return splitterLaneCells(e);
}

export function buildGrid(entities: PlacedEntity[]): NeighbourGrid {
  const grid = new NeighbourGrid();
  for (const e of entities) {
    for (const cell of cellsOf(e)) {
      grid.set(cell.x, cell.y, { name: e.name, direction: e.direction, undergroundType: e.undergroundType });
    }
  }
  return grid;
}
