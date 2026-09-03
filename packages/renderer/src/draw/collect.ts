import { Layer, type GraphicsLayer, type PlacedEntity, type Sprite } from "@factoriotools/engine";
import type { ResolvedVisual } from "../entityLookup.js";
import { dir4Name, dir8Name, toCardinal, opposite, splitterLaneCells, type NeighbourGrid } from "../neighbours/grid.js";
import { classifyPipe } from "../neighbours/pipe.js";
import { classifyWall } from "../neighbours/wall.js";
import { classifyBelt, type BeltCap } from "../neighbours/belt.js";
import { classifyPlatform, type PlatformBox } from "../neighbours/platform.js";
import { PIXELS_PER_TILE, type DrawCommand } from "./commands.js";

export interface CollectContext {
  grid: NeighbourGrid;
  isPipeLike: (name: string) => boolean;
  isWallLike: (name: string) => boolean;
  isBeltLike: (name: string) => boolean;
  /** Every platform-connectable entity's footprint box, for cargo hubs/bays
   *  to find flush neighbours across their whole edge, not just one tile. */
  platformBoxes: PlatformBox[];
  animationFrame: number;
}

/** Everything a layer's frame axes need, resolved once per entity. */
interface EntityFrame {
  /** 0..3, cardinal facing. */
  direction: number;
  /** Belt connection row, or a pipe/wall variant name. */
  connectionIndex: number;
  connectionName: string;
  /** Start/end pieces closing off a belt run, each on an adjacent tile. */
  caps: BeltCap[];
  /** A splitter straddles two tiles, so its two belt-lane layers each need
   *  their own cap classification from their own lane's tile — [-side, +side],
   *  matching splitterGraphics's lane(-1)/lane(1) layer order. Empty for
   *  every other belt-connector entity, which has just the one `caps`. */
  laneCaps: [BeltCap[], BeltCap[]];
  /** A cargo hub/bay draws several connection pieces at once — one per edge
   *  and corner — instead of picking a single shape like pipes and walls do. */
  platformShapes: string[];
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
    caps: [],
    laneCaps: [[], []],
    platformShapes: [],
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
      if (entity.name.includes("splitter")) {
        // A splitter has no single tile of its own — each lane classifies
        // from its own cell, or a belt feeding the far lane would look like
        // it feeds nothing.
        const [minus, plus] = splitterLaneCells(entity);
        frame.laneCaps = [
          classifyBelt(minus.x, minus.y, entity.direction, ctx.grid, ctx.isBeltLike).caps,
          classifyBelt(plus.x, plus.y, entity.direction, ctx.grid, ctx.isBeltLike).caps,
        ];
      } else {
        const shape = classifyBelt(x, y, entity.direction, ctx.grid, ctx.isBeltLike);
        frame.connectionIndex = shape.row;
        frame.caps = shape.caps;
      }
      break;
    }
    case "platform": {
      const box = ctx.platformBoxes.find((b) => b.entityNumber === entity.entityNumber);
      if (box) frame.platformShapes = classifyPlatform(box, ctx.platformBoxes);
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
  offsetX = 0,
  offsetY = 0,
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
    dx: entity.x + offsetX + shiftX - dw / 2,
    dy: entity.y + offsetY + shiftY - dh / 2,
    dw,
    dh,
    layer,
    // Sorted by the entity's own row, not the offset one, so a cap stays
    // with the belt it belongs to.
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
  const isSplitter = entity.name.includes("splitter");
  let laneIndex = 0;

  graphics.layers.forEach((layer, order) => {
    // A cargo hub/bay draws several connection pieces at once — one per
    // edge/corner, each with its own baked-in shift — instead of the single
    // connection-name pick every other connector uses.
    if (graphics.connector === "platform" && "per" in layer && layer.per === "connection") {
      for (const shape of frame.platformShapes) {
        const sprite = layer.sprites[shape];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha);
      }
      return;
    }

    const sprite = spriteFor(layer, entity, frame);
    if (!sprite) return;
    const column = axisIndex(layer.column, frame);
    const row = axisIndex(layer.row, frame);
    push(out, sprite, column, row, entity, layer.layer, order, alpha);

    // Belt caps share the body's own tile and grid, drawn after it so they
    // layer on top. A splitter's two belt-lane layers each carry their own
    // lane's caps, in the same order splitterGraphics declared them
    // (lane(-1), lane(1)).
    if (layer.row?.by === "connection") {
      const caps = isSplitter ? frame.laneCaps[laneIndex++] ?? [] : frame.caps;
      for (const cap of caps) {
        push(out, sprite, column, cap.row, entity, layer.layer, order, alpha);
      }
    }
  });
}
