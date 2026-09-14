import { Layer, type GraphicsLayer, type PlacedEntity, type Sprite } from "@factoriotools/engine";
import type { ResolvedVisual } from "../entityLookup.js";
import { dir4Name, dir8Name, toCardinal, opposite, splitterLaneCells, step, Dir, type Cardinal, type NeighbourGrid } from "../neighbours/grid.js";
import { classifyPipe } from "../neighbours/pipe.js";
import { classifyWall } from "../neighbours/wall.js";
import { classifyBeltCell, undergroundSideLoaded, type BeltCap } from "../neighbours/beltGraph.js";
import { classifyPlatform, type PlatformBox } from "../neighbours/platform.js";
import type { FluidNetwork } from "../neighbours/fluid.js";
import type { HeatNetwork } from "../neighbours/heat.js";
import { PIXELS_PER_TILE, type DrawCommand } from "./commands.js";

export interface CollectContext {
  grid: NeighbourGrid;
  fluidNetwork: FluidNetwork;
  heatNetwork: HeatNetwork;
  isPipeLike: (name: string) => boolean;
  isHeatPipeLike: (name: string) => boolean;
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
  /** entity.direction unmodified (0..15) — for a layer keyed by more than
   *  4-way facing, e.g. artillery-turret's direction256 axis. */
  rawDirection: number;
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
  /** True when a belt-like entity feeds this underground's mouth from the
   *  side rather than straight on — swaps in the direction_*_side_loading
   *  sprite, which the plain mouth art doesn't otherwise account for. */
  sideLoaded: boolean;
  /** Which cardinal half of an underground/loader's belt-lane frame to keep
   *  (the sprite is a full 2-tile belt frame, built to overlap into a
   *  neighbour the way a plain belt's own frame does — an underground has
   *  no such neighbour on its open end, so without cropping, half the frame
   *  visibly pokes out past the structure sprite that's meant to cover it).
   *  Undefined for every non-underground entity, which needs no crop. */
  laneKeepSide?: Cardinal;
  /** Every fluid-box connection point this entity has that the real fluid
   *  network graph found no neighbour for — each drawn with its own
   *  pipe-covers sprite, offset from entity centre by the point's own
   *  rotated local position (world tile minus entity's own rounded centre,
   *  matching push()'s existing offsetX/offsetY convention). */
  unconnectedPipeCovers: { offsetX: number; offsetY: number; direction: Cardinal }[];
  /** Every heat-network connection point this entity has that the real
   *  heat network graph found A neighbour for — the inverse filter from
   *  unconnectedPipeCovers, since a heat consumer's own idle sprite (unlike
   *  a fluid entity's) has no closing art at that point on its own; the
   *  cap here is what fills the gap once a heat pipe is actually plugged
   *  in, not what covers a stub with nothing attached. Same offset
   *  convention as unconnectedPipeCovers (one tile further out, in the
   *  connection's own facing). */
  connectedHeatCovers: { offsetX: number; offsetY: number; direction: Cardinal }[];
  /** Every `heat_buffer.connections` point this entity declares, in
   *  declaration order (matching the `heat-connection-patches` layer's own
   *  `connected`/`disconnected` array index) — a reactor always draws one
   *  patch per point, unlike pipe-covers' unconnected-only set, since the
   *  connected and disconnected art are two distinct sprites rather than an
   *  added cap over otherwise-bare art. */
  heatConnectionPatches: { index: number; offsetX: number; offsetY: number; connected: boolean }[];
  /** Whether each of a beacon's physical module slots (index order matches
   *  the module-slot layer's own `slots` array) actually has a module in
   *  it — true entries draw the filled box/lights pieces, false draw the
   *  empty socket. Derived from entity.modules' collapsed ModuleStack[] by
   *  expanding count back out to one bool per physical slot. */
  filledSlots: boolean[];
}

function resolveFrame(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext): EntityFrame {
  const x = Math.round(entity.x);
  const y = Math.round(entity.y);
  const frame: EntityFrame = {
    direction: Math.round(toCardinal(entity.direction) / 4) % 4,
    rawDirection: entity.direction,
    connectionIndex: 0,
    connectionName: "",
    caps: [],
    laneCaps: [[], []],
    platformShapes: [],
    animation: ctx.animationFrame,
    undergroundIn: entity.undergroundType !== "output",
    sideLoaded: false,
    // A cover sprite draws one full tile further out than the connection
    // point itself, in the direction the connection faces — confirmed
    // against the reference renderer's own pipe-cover logic
    // (spriteDataBuilder.ts's generateFluidBoxConnections: offset2 =
    // rotatePointBasedOnDir([0,-1], dir), added to the connection's own
    // position). Without it the cover would sit centred on the socket
    // itself instead of capping the stub that pokes out past it.
    //
    // A ghost (entityNumber -1, the placeholder id placeEntity/render.ts's
    // own ghost object always uses) always shows every one of its own
    // covers, connected or not — it isn't actually built yet, so there's no
    // real pipe run to visually join into, and suppressing a cover next to
    // an existing pipe would wrongly suggest the ghost is already plumbed
    // in before the player has placed it.
    unconnectedPipeCovers: ctx.fluidNetwork
      .pointsFor(entity.entityNumber)
      .filter((p) => entity.entityNumber === -1 || !ctx.fluidNetwork.isConnected(p))
      .map((p) => {
        const { dx, dy } = step(p.direction);
        // p.offsetX/Y is the point's own unrounded local offset from this
        // entity's centre — using p.x/p.y (the rounded world tile) minus
        // this entity's own independently-rounded x/y would drift whenever
        // the two roundings don't land the same way (e.g. a south-facing
        // pump's socket at entity.y + 0.5).
        return { offsetX: p.offsetX + dx, offsetY: p.offsetY + dy, direction: p.direction };
      }),
    // heat-covers' own cap sits the same one-tile-further-out as a fluid
    // pipe-cover does (see unconnectedPipeCovers' own doc comment) — it is
    // structurally the same kind of stub cap, just drawn on the opposite
    // (connected) side of the filter. A ghost never shows one: unlike a
    // pipe/heat-pipe stub (whose own art already looks unfinished without a
    // neighbour), a heat-exchanger's plain idle sprite looks complete on
    // its own, so a not-yet-built ghost has nothing to visually close off.
    connectedHeatCovers: ctx.heatNetwork
      .pointsFor(entity.entityNumber)
      .filter((p) => entity.entityNumber !== -1 && ctx.heatNetwork.isConnected(p))
      .map((p) => {
        const { dx, dy } = step(p.direction);
        // p.offsetX/Y is the point's own unrounded local offset from this
        // entity's centre — using p.x/p.y (the rounded world tile) minus
        // this entity's own independently-rounded x/y would drift whenever
        // the two roundings don't land the same way (e.g. heat-exchanger's
        // own 3x2 footprint, which sits on a half-integer y; see
        // HeatNetwork.add's own doc comment for the connectivity bug this
        // same drift caused).
        return { offsetX: p.offsetX + dx, offsetY: p.offsetY + dy, direction: p.direction };
      }),
    // A reactor's own connection-patch art sits directly at the connection
    // point's own world position, not a further tile out the way a pipe
    // cover does — matching the reference renderer's own draw_reactor
    // (addToShift(conn.position, patchSheet), no extra step). A ghost
    // (entityNumber -1) always shows its disconnected art everywhere: it
    // isn't actually built yet, so there's no real heat network to have
    // joined into.
    heatConnectionPatches: ctx.heatNetwork.pointsFor(entity.entityNumber).map((p, index) => ({
      index,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      connected: entity.entityNumber !== -1 && ctx.heatNetwork.isConnected(p),
    })),
    // entity.modules is collapsed (one ModuleStack per distinct
    // name+quality, each with its own count) — expanding count back out
    // gives one entry per physical slot, in the same left-to-right order
    // Factorio itself fills them, matching index.ts's own expandModuleSlots.
    filledSlots: entity.modules.flatMap((stack) => Array<boolean>(stack.count).fill(true)),
  };

  switch (visual.graphics?.connector) {
    case "pipe":
      frame.connectionName = classifyPipe(x, y, ctx.grid, ctx.isPipeLike, ctx.fluidNetwork);
      break;
    case "heat-pipe":
      frame.connectionName = classifyPipe(x, y, ctx.grid, ctx.isHeatPipeLike, ctx.heatNetwork);
      break;
    case "wall":
      frame.connectionName = classifyWall(x, y, ctx.grid, ctx.isWallLike);
      break;
    case "belt": {
      if (entity.name.includes("splitter")) {
        // A splitter has no single tile of its own — each lane classifies
        // from its own cell, or a belt feeding the far lane would look like
        // it feeds nothing. A splitter's lanes never curve, so both lanes'
        // rows are identical (classifyBeltCell's `row` only depends on
        // `direction` and forceStraight, not the cell it's called from) —
        // reading it off either one is enough. connectionIndex left at its
        // 0 default (same bug as the underground/loader lane before it) is
        // the sheet's East row, so every splitter rendered its lanes facing
        // east regardless of its own actual facing.
        const [minus, plus] = splitterLaneCells(entity);
        const minusShape = classifyBeltCell(minus.x, minus.y, entity.direction, ctx.grid, ctx.isBeltLike, true);
        frame.connectionIndex = minusShape.row;
        frame.laneCaps = [
          minusShape.caps,
          classifyBeltCell(plus.x, plus.y, entity.direction, ctx.grid, ctx.isBeltLike, true).caps,
        ];
      } else if (entity.undergroundType !== undefined) {
        // An underground belt (or loader) never curves, and only ever
        // shows the one cap for its own open end — the entrance's start
        // cap, or the exit's end cap — never both. Its belt LANE layer
        // (the moving, item-carrying strip under/over the structure sprite)
        // still needs shape.row the same way a plain belt does — without
        // it connectionIndex stayed at its 0 default, which happens to be
        // the sheet's East row, so every underground/loader rendered its
        // lane facing east regardless of the entity's real facing.
        //
        // An exit half stores its direction pointing back at the entrance
        // (see the opposite() correction below, applied to frame.direction
        // for the structure column) — the lane's own row needs that exact
        // same correction, or an exit's chevrons would visually point
        // backward into the entrance instead of onward, away from it.
        const laneDirection = entity.undergroundType === "output" ? opposite(toCardinal(entity.direction)) : entity.direction;
        const laneFacing = toCardinal(laneDirection);
        const shape = classifyBeltCell(x, y, laneDirection, ctx.grid, ctx.isBeltLike, true);
        frame.connectionIndex = shape.row;
        frame.caps = shape.caps.filter((cap) => cap.kind === (frame.undergroundIn ? "start" : "end"));
        frame.sideLoaded = undergroundSideLoaded(x, y, entity.direction, ctx.grid, ctx.isBeltLike);
        // An entrance's belt still visibly runs on the surface BEHIND it
        // (opposite its facing) before diving into the tunnel ahead; an
        // exit's picks back up AHEAD of it (its own facing), having just
        // come out of the tunnel behind. Either way, only the half toward
        // the open surface run should show — the other half is where the
        // structure sprite's own mouth art takes over.
        frame.laneKeepSide = frame.undergroundIn ? opposite(laneFacing) : laneFacing;
      } else {
        const shape = classifyBeltCell(x, y, entity.direction, ctx.grid, ctx.isBeltLike);
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
    case "animation": return Math.floor(frame.animation / (axis.slowdown ?? 1));
    case "connection": return frame.connectionIndex;
    case "underground-end": {
      const sideLoadIndex = frame.undergroundIn ? axis.inSideLoadIndex : axis.outSideLoadIndex;
      if (frame.sideLoaded && sideLoadIndex !== undefined) return sideLoadIndex;
      return frame.undergroundIn ? axis.inIndex : axis.outIndex;
    }
    case "direction256": {
      // entity.direction is 0..15 (16 placement facings); the sheet packs
      // 256 frames (fine in-combat traverse, irrelevant for a blueprint's
      // static pose) at lineLength per row — scale the placement facing
      // onto that range and pick its nearest frame, then split into this
      // row/column pair.
      const frameIndex = Math.round((frame.rawDirection / 16) * 256) % 256;
      return axis.axis === "column" ? frameIndex % axis.lineLength : Math.floor(frameIndex / axis.lineLength);
    }
    // Rail-signal/rail-chain-signal's own row axis — entity.direction (0..15)
    // IS the row directly, no 256-scaling needed (their sheet is a genuine
    // 16-row grid, one row per placement facing).
    case "direction16": return frame.rawDirection;
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

/** Nudges a cap's sort-y just enough to win a tie against whatever body
 *  sprite already occupies the tile it lands on — e.g. a belt's end cap
 *  landing on a curve tile one row over, both at the exact same world y.
 *  Without this, ties fall back to array order (paint.ts's sort is stable),
 *  which meant a cap's visibility depended on which of the two entities was
 *  PLACED first rather than which visually belongs on top — a cap should
 *  always win, regardless of placement order. Comfortably above float noise,
 *  comfortably below the smallest real gap between two distinct rows (1
 *  world tile). */
const CAP_PRIORITY_EPSILON = 1e-4;

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
  capPriority = false,
  keepSide?: Cardinal,
  laneRecenter = 0,
  yBias = 0,
): void {
  const column = rawColumn % Math.max(sprite.columns ?? 1, 1);
  const scale = sprite.scale ?? 1;
  let dw = (sprite.frameWidth * scale) / PIXELS_PER_TILE;
  let dh = (sprite.frameHeight * scale) / PIXELS_PER_TILE;
  const [shiftX, shiftY] = sprite.shift ?? [0, 0];

  let sx = (sprite.x ?? 0) + column * sprite.frameWidth;
  // A grid split across several same-sized files (Sprite.sheets) picks its
  // file from the row, then continues indexing within that file with the
  // row made relative to it — sy itself never spans past one file's own
  // height.
  let sheet = sprite.sheet;
  let sheetRow = row;
  if (sprite.sheets && sprite.rowsPerSheet) {
    const fileIndex = Math.floor(row / sprite.rowsPerSheet);
    sheet = sprite.sheets[fileIndex] ?? sprite.sheets[sprite.sheets.length - 1]!;
    sheetRow = row % sprite.rowsPerSheet;
  }
  let sy = (sprite.y ?? 0) + sheetRow * sprite.frameHeight;
  let sw = sprite.frameWidth;
  let sh = sprite.frameHeight;
  let dx = entity.x + offsetX + shiftX - dw / 2;
  let dy = entity.y + offsetY + shiftY - dh / 2;

  // An underground/loader's belt-lane frame is a full 2-tile belt frame
  // (built to overlap into a neighbouring tile the way a plain belt's own
  // frame does), but there's no neighbour on its open end to cover that
  // overlap — cropping both the source and destination rects to the half
  // toward keepSide keeps only the surface-run half and drops the half
  // that would otherwise poke out past the structure sprite covering it.
  // Only the along-facing axis is cropped: the perpendicular axis is left
  // full-height/width, same as a plain belt's own frame — it overlaps
  // slightly past the entity's 1-tile-wide side, same as a plain belt does
  // into its neighbours, and that's fine uncropped (confirmed against a
  // live render): cropping it turned out to cut off real art (the frame's
  // roller/undercarriage strip isn't centred in the frame), not excess.
  if (keepSide !== undefined) {
    const horizontal = keepSide === Dir.East || keepSide === Dir.West;
    if (horizontal) {
      sw /= 2;
      dw /= 2;
      if (keepSide === Dir.East) {
        // East: keep the right half of both rects.
        sx += sw;
        dx += dw;
      }
    } else {
      sh /= 2;
      dh /= 2;
      if (keepSide === Dir.South) {
        // South: keep the bottom half of both rects.
        sy += sh;
        dy += dh;
      }
    }
  }

  // A loader's own box spans 2 tiles (unlike an underground-belt's 1), so
  // its belt-connecting tile sits half a tile further out, toward the open
  // end, than an underground's own already-correct placement — applies to
  // both the lane (direction from keepSide) and its cap (direction from
  // which way this particular push was offset, since caps don't crop and so
  // never set keepSide). Destination-only: never resamples the source.
  if (laneRecenter !== 0) {
    const towardSide = keepSide ?? (offsetX > 0 ? Dir.East : offsetX < 0 ? Dir.West : offsetY > 0 ? Dir.South : Dir.North);
    if (towardSide === Dir.East) dx += laneRecenter;
    else if (towardSide === Dir.West) dx -= laneRecenter;
    else if (towardSide === Dir.South) dy += laneRecenter;
    else dy -= laneRecenter;
  }

  out.push({
    sheet,
    sx,
    sy,
    sw,
    sh,
    dx,
    dy,
    dw,
    dh,
    layer,
    // Sorted by where the piece actually lands, not its owner's tile — a cap
    // offset onto a neighbour's tile must compete for paint order against
    // whatever else occupies that tile (e.g. a belt row it visually overlaps
    // at a T-junction), not against things near its owner instead. A
    // splitter's two lanes are the same story: shiftY (not offsetY) is what
    // actually separates them on an east/west-facing splitter, so it has to
    // be in the sort key too, or the lower lane's shadow can lose to the
    // upper lane's just because it comes first in the layer array. A plain
    // belt's cap additionally gets a tiny epsilon bump (capPriority) so it
    // wins an exact tie against a NEIGHBOURING entity's own body sprite
    // (see CAP_PRIORITY_EPSILON) — but an underground/loader's own cap must
    // NOT get that boost: its offset can land back on ITS OWN entity's
    // oversized structure sprite (several tiles across, drawn with a baked-
    // in shadow), which is deliberately ordered after the lane/cap so the
    // structure's shadow paints over the cap, not under it. The epsilon
    // would otherwise flip that specific ordering by winning the y-tie
    // before `order` is even compared.
    y: entity.y + offsetY + shiftY + (capPriority ? CAP_PRIORITY_EPSILON : 0) + yBias,
    order,
    alpha,
    rotationDeg: sprite.rotationDeg,
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

    // A pipe-cover patch draws once per unconnected fluid-box connection
    // point, each at that point's own offset from entity centre — unlike
    // every other `per` variant, which picks a single sprite for the whole
    // entity, a storage tank can need up to 4 of these at once (one per
    // corner the fluid network graph found no neighbour for).
    if ("per" in layer && layer.per === "pipe-covers") {
      for (const point of frame.unconnectedPipeCovers) {
        const sprite = layer.sprites[dir4Name(point.direction)];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, point.offsetX, point.offsetY);
      }
      return;
    }

    // heat-covers' own cap draws once per CONNECTED heat-network point —
    // the inverse filter of pipe-covers (see connectedHeatCovers' own doc
    // comment for why: a heat consumer's plain idle art has no closing
    // shape of its own at that point, unlike a fluid entity's).
    if ("per" in layer && layer.per === "heat-covers") {
      for (const point of frame.connectedHeatCovers) {
        const sprite = layer.sprites[dir4Name(point.direction)];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, point.offsetX, point.offsetY);
      }
      return;
    }

    // A reactor's heat-connection-patch draws once per heat_buffer
    // connection point — always exactly one sprite per point (either its
    // connected or disconnected variant), unlike pipe-covers which only adds
    // a cap where nothing else is drawn.
    if ("per" in layer && layer.per === "heat-connection-patches") {
      for (const point of frame.heatConnectionPatches) {
        const sprite = (point.connected ? layer.connected : layer.disconnected)[point.index];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, point.offsetX, point.offsetY);
      }
      return;
    }

    // A beacon's module-slot art: each physical slot draws its own empty
    // socket, or (once a module actually occupies it) the box/lights-mask/
    // lights-glow pieces layered over it — every piece already carries its
    // own baked-in shift, so no extra offset is needed here.
    if ("per" in layer && layer.per === "module-slot") {
      layer.slots.forEach((slot, i) => {
        if (frame.filledSlots[i]) {
          for (const sprite of slot.filled) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, 0, 0, false, undefined, 0, layer.ySortBias ?? 0);
        } else {
          push(out, slot.empty, 0, 0, entity, layer.layer, order, alpha, 0, 0, false, undefined, 0, layer.ySortBias ?? 0);
        }
      });
      return;
    }

    const sprite = spriteFor(layer, entity, frame);
    if (!sprite) return;
    let column = axisIndex(layer.column, frame);
    const row = axisIndex(layer.row, frame);
    // Turbo belt only: alternate tiles run their animation a half-cycle out
    // of phase (matches the real game's own look at that speed — every
    // frame in lockstep reads as a single strobing flicker instead of items
    // visibly advancing). Every other belt tier keeps one shared phase.
    if (entity.name === "turbo-transport-belt" && layer.column?.by === "animation") {
      const parity = (Math.round(entity.x) + Math.round(entity.y)) % 2;
      if (parity !== 0) column += Math.floor((sprite.columns ?? 1) / 2);
    }
    // Only an underground/loader's own lane layer needs half-cropping (see
    // laneKeepSide's own doc comment) — a plain belt's identically-shaped
    // "connection" row layer is its actual full body and must stay whole.
    const isUndergroundLane = entity.undergroundType !== undefined && layer.row?.by === "connection";
    // A loader's own box spans 2 tiles (unlike an underground-belt's 1), so
    // its belt-connecting tile is a further tile out from centre than the
    // half-crop's own midpoint lands by default — recentring only for a
    // loader keeps an underground-belt's already-correct placement alone.
    const laneRecenter = isUndergroundLane && entity.name.includes("loader") ? 0.5 : 0;
    push(out, sprite, column, row, entity, layer.layer, order, alpha, 0, 0, false, isUndergroundLane ? frame.laneKeepSide : undefined, laneRecenter, layer.ySortBias ?? 0);

    // Belt caps share the body's grid but sit a tile off toward the
    // neighbour they cover. A splitter's two belt-lane layers each carry
    // their own lane's caps, in the same order splitterGraphics declared
    // them (lane(-1), lane(1)). An underground/loader's structure sheet only
    // has entrance/exit(/side-load) rows, no cap art of its own — the cap
    // belongs to its separate belt-lane layer instead, which (like a plain
    // belt) picks its row via "connection".
    if (layer.row?.by === "connection") {
      const caps = isSplitter ? frame.laneCaps[laneIndex++] ?? [] : frame.caps;
      // Only a plain belt's cap gets the priority epsilon (see push's own
      // comment) — an underground/loader's cap must stay ordered purely by
      // `order`, so its own structure sprite's baked-in shadow (pushed
      // after the lane) still paints over it.
      const capPriority = entity.undergroundType === undefined;
      for (const cap of caps) {
        push(out, sprite, column, cap.row, entity, layer.layer, order, alpha, cap.dx, cap.dy, capPriority, undefined, laneRecenter);
      }
    }
  });
}
