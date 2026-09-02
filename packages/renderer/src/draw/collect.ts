import { Layer, type GraphicsLayer, type PlacedEntity, type Sprite } from "@factoriotools/engine";
import type { ResolvedVisual } from "../entityLookup.js";
import { dir4Name, dir8Name, toCardinal, opposite, type NeighbourGrid } from "../neighbours/grid.js";
import { classifyPipe } from "../neighbours/pipe.js";
import { classifyWall } from "../neighbours/wall.js";
import { classifyBelt } from "../neighbours/belt.js";
import { PIXELS_PER_TILE, type DrawCommand } from "./commands.js";

export interface CollectContext {
  grid: NeighbourGrid;
  isPipeLike: (name: string) => boolean;
  isWallLike: (name: string) => boolean;
  isBeltLike: (name: string) => boolean;
  animationFrame: number;
}

/** Everything a layer's frame axes need, resolved once per entity. */
interface EntityFrame {
  /** 0..3, cardinal facing. */
  direction: number;
  /** Belt connection row, or a pipe/wall variant name. */
  connectionIndex: number;
  connectionName: string;
  /** Extra rows drawn over the body (belt start/end caps). */
  extraRows: number[];
  animation: number;
  undergroundIn: boolean;
}

function resolveFrame(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext): EntityFrame {
  const x = Math.round(entity.x);
  const y = Math.round(entity.y);
  const frame: EntityFrame = {
    direction: Math.round(toCardinal(entity.direction) / 4) % 4,
    connectionIndex: 0,
    connectionName: "",
    extraRows: [],
    animation: ctx.animationFrame,
    undergroundIn: entity.undergroundType !== "output",
  };

  switch (visual.graphics?.connector) {
    case "pipe":
      frame.connectionName = classifyPipe(x, y, ctx.grid, ctx.isPipeLike);
      break;
    case "wall":
      frame.connectionName = classifyWall(x, y, ctx.grid, ctx.isWallLike);
      break;
    case "belt": {
      const shape = classifyBelt(x, y, entity.direction, ctx.grid, ctx.isBeltLike);
      frame.connectionIndex = shape.row;
      frame.extraRows = shape.caps;
      break;
    }
  }

  // An underground's exit half stores its direction pointing back at the
  // entrance, so its sprite column comes from the opposite facing.
  if (entity.undergroundType === "output") {
    frame.direction = Math.round(opposite(toCardinal(entity.direction)) / 4) % 4;
  }
  return frame;
}

function axisIndex(axis: GraphicsLayer["column"], frame: EntityFrame): number {
  if (!axis) return 0;
  switch (axis.by) {
    case "none": return 0;
    case "direction": return frame.direction;
    case "animation": return frame.animation;
    case "connection": return frame.connectionIndex;
    case "underground-end": return frame.undergroundIn ? axis.inIndex : axis.outIndex;
  }
}

function spriteFor(layer: GraphicsLayer, entity: PlacedEntity, frame: EntityFrame): Sprite | undefined {
  if (!("per" in layer)) return layer.sprites;
  switch (layer.per) {
    case "dir4": return layer.sprites[dir4Name(entity.direction)];
    case "dir8": return layer.sprites[dir8Name(entity.direction)];
    case "connection": return layer.sprites[frame.connectionName];
  }
}

function push(
  out: DrawCommand[],
  sprite: Sprite,
  rawColumn: number,
  row: number,
  entity: PlacedEntity,
  layer: Layer,
  order: number,
  alpha: number,
): void {
  const column = rawColumn % Math.max(sprite.columns ?? 1, 1);
  const scale = sprite.scale ?? 1;
  const dw = (sprite.frameWidth * scale) / PIXELS_PER_TILE;
  const dh = (sprite.frameHeight * scale) / PIXELS_PER_TILE;
  const [shiftX, shiftY] = sprite.shift ?? [0, 0];
  out.push({
    sheet: sprite.sheet,
    sx: (sprite.x ?? 0) + column * sprite.frameWidth,
    sy: (sprite.y ?? 0) + row * sprite.frameHeight,
    sw: sprite.frameWidth,
    sh: sprite.frameHeight,
    dx: entity.x + shiftX - dw / 2,
    dy: entity.y + shiftY - dh / 2,
    dw,
    dh,
    layer,
    y: entity.y,
    order,
    alpha,
  });
}

/** Turns one entity into its draw commands. Nothing here touches the canvas —
 *  ordering is decided globally once every entity has contributed. */
export function collectEntity(
  out: DrawCommand[],
  entity: PlacedEntity,
  visual: ResolvedVisual,
  ctx: CollectContext,
  alpha: number,
): void {
  const graphics = visual.graphics;
  if (!graphics || graphics.layers.length === 0) return;

  const frame = resolveFrame(entity, visual, ctx);

  graphics.layers.forEach((layer, order) => {
    const sprite = spriteFor(layer, entity, frame);
    if (!sprite) return;
    const column = axisIndex(layer.column, frame);
    const row = axisIndex(layer.row, frame);
    push(out, sprite, column, row, entity, layer.layer, order, alpha);

    // Belt caps ride on the body layer's own grid, one row each.
    if (layer.row?.by === "connection" && frame.extraRows.length > 0) {
      for (const capRow of frame.extraRows) {
        push(out, sprite, column, capRow, entity, layer.layer, order, alpha);
      }
    }
  });
}
