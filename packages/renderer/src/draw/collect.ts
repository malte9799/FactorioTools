import { Layer, stockOrientation, type FluidPointRef, type GraphicsLayer, type InserterGraphics, type PlacedEntity, type SignalColor, type Sprite } from "@factoriotools/engine";
import type { ResolvedVisual } from "../entityLookup.js";
import { openEnds, RAIL_DECK_HEIGHT, railEnds } from "../railGeometry.js";
import { dir4Name, dir8Name, toCardinal, opposite, splitterLaneCells, step, Dir, type Cardinal, type NeighbourGrid } from "../neighbours/grid.js";
import { classifyPipe } from "../neighbours/pipe.js";
import { classifyWall } from "../neighbours/wall.js";
import { combinatorSymbol } from "../sprites/combinatorSymbol.js";
import { classifyBeltCell, undergroundSideLoad, type BeltCap } from "../neighbours/beltGraph.js";
import { cargoBayPieces, type CargoBayGrid, type CargoBayPiece } from "../neighbours/cargoBay.js";
import type { FluidNetwork, FluidPointState } from "../neighbours/fluid.js";
import type { HeatNetwork } from "../neighbours/heat.js";
import { PIXELS_PER_TILE, type DrawCommand } from "./commands.js";

/** Rotates a fixed local [x, y] offset by an entity's own placement
 *  direction, 90° per cardinal step — same convention as heat.ts's own
 *  (private) rotatePoint, duplicated here rather than exported+imported for
 *  one call site, since this only ever rotates a plain tuple (no
 *  connection-specific `direction` field to carry along). */
function rotate90([x, y]: [number, number], entityDirection: number): [number, number] {
  const steps = Math.round(toCardinal(entityDirection) / 4) % 4;
  let rx = x, ry = y;
  for (let i = 0; i < steps; i++) [rx, ry] = [-ry, rx];
  return [rx, ry];
}

export interface CollectContext {
  grid: NeighbourGrid;
  fluidNetwork: FluidNetwork;
  heatNetwork: HeatNetwork;
  isPipeLike: (name: string) => boolean;
  isHeatPipeLike: (name: string) => boolean;
  isWallLike: (name: string) => boolean;
  isBeltLike: (name: string) => boolean;
  /** The cells cargo hubs and bays occupy, for the plating they lay round
   *  themselves and across to each other. */
  cargoBays: CargoBayGrid;
  animationFrame: number;
  /** What a placed rail signal shows (railSignals.ts). Left out, or
   *  returning undefined, for a signal still in hand, which shows green. */
  signalState?: (entity: PlacedEntity) => SignalColor | undefined;
  /** Every rail end in the scene (railGeometry's railJoints), so track
   *  knows which of its ends stop in an end cap. Left out, every end does. */
  railJoints?: ReadonlySet<string>;
}

/** Everything a layer's frame axes need, resolved once per entity. */
interface EntityFrame {
  /** 0..3, cardinal facing. */
  direction: number;
  /** entity.direction unmodified (0..15) — for a layer keyed by more than
   *  4-way facing, e.g. artillery-turret's direction256 axis. */
  rawDirection: number;
  /** Rolling stock's heading, a fraction of a turn clockwise from north. */
  orientation: number;
  /** The colour a rail signal shows. */
  signalState: SignalColor;
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
  /** A cargo hub/bay draws several connection pieces at once — one per
   *  outline cell and seam — instead of picking a single shape like pipes
   *  and walls do. */
  cargoPieces: CargoBayPiece[];
  /** Which of a cargo bay's two looks to draw. */
  onSpacePlatform: boolean;
  animation: number;
  undergroundIn: boolean;
  /** Which side (if any) a belt-like entity feeds this underground from —
   *  see undergroundSideLoad: a back feed hides the back_patch, a front
   *  feed swaps in the direction_*_side_loading body and hides the
   *  front_patch. */
  sideLoad: { back: boolean; front: boolean };
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
  /** What each of this entity's own fluid-box connection points is plugged
   *  into (see FluidNetwork.stateOf), with the unrotated local point a
   *  `fluid-point` layer's own `point` is matched against. */
  /** True when this entity has live fluid ports — what a `plumbed` layer
   *  is matched against. */
  plumbed: boolean;
  /** `offsetX`/`offsetY`/`direction` place the point itself, rotated with
   *  the entity — what a `pipe-pictures` stub is drawn from. */
  fluidPoints: { local: { x: number; y: number; direction: number }; state: FluidPointState; offsetX: number; offsetY: number; direction: Cardinal }[];
  /** Every heat-network connection point this entity has that the real
   *  heat network graph found NO neighbour for — same "unconnected only"
   *  rule as unconnectedPipeCovers (confirmed against the reference
   *  renderer's own draw_boiler: `needsEnding = !isConnected`, cover drawn
   *  only when true — heat-covers is NOT the reactor's
   *  heat-connection-patches pattern of "always draw one of two variants").
   *
   *  Unlike unconnectedPipeCovers, the offset here is NOT derived from the
   *  connection point's own position — the reference renderer's own
   *  draw_boiler hardcodes a fixed [0, 1.5] shift (rotated by the entity's
   *  own placement direction, not the connection's facing) for every
   *  heat-exchanger patch regardless of which connection triggered it.
   *  heat-exchanger is confirmed the only entity with this layer, so
   *  reproducing that fixed offset exactly (rather than generalizing to a
   *  per-point formula this reference behaviour doesn't actually follow)
   *  is the faithful choice. spriteDirection is separately entityDirection
   *  rotated 8 (south) — also taken verbatim from the reference rather
   *  than assumed to equal the connection's own facing, which only
   *  coincides for this entity's specific south-facing connection. */
  unconnectedHeatCovers: { offsetX: number; offsetY: number; spriteDirection: Cardinal }[];
  /** Every `heat_buffer.connections` point this entity declares, in
   *  declaration order (matching the `heat-connection-patches` layer's own
   *  `connected`/`disconnected` array index) — a reactor always draws one
   *  patch per point, unlike pipe-covers' unconnected-only set, since the
   *  connected and disconnected art are two distinct sprites rather than an
   *  added cap over otherwise-bare art. */
  heatConnectionPatches: { index: number; offsetX: number; offsetY: number; connected: boolean }[];
  /** The module name in each of a beacon's physical module slots (index
   *  order matches the module-slot layer's own `slots` array), undefined
   *  past the last filled one. Derived from entity.modules' collapsed
   *  ModuleStack[] by expanding count back out to one entry per slot. */
  slotModules: string[];
}

/** Builds `entity`'s EntityFrame: its facing, the connection shape its
 *  neighbours give it, and what each of its fluid and heat ports is
 *  plugged into — read once here, ahead of collectEntity's layer loop. */
function resolveFrame(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext): EntityFrame {
  const x = Math.round(entity.x);
  const y = Math.round(entity.y);
  const frame: EntityFrame = {
    direction: Math.round(toCardinal(entity.direction) / 4) % 4,
    rawDirection: entity.direction,
    orientation: stockOrientation(entity),
    signalState: ctx.signalState?.(entity) ?? "green",
    connectionIndex: 0,
    connectionName: "",
    caps: [],
    laneCaps: [[], []],
    cargoPieces: [],
    onSpacePlatform: ctx.cargoBays.spacePlatform,
    animation: ctx.animationFrame,
    undergroundIn: entity.undergroundType !== "output",
    sideLoad: { back: false, front: false },
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
      .filter((p) => !p.noCover && (entity.entityNumber === -1 || !ctx.fluidNetwork.isConnected(p)))
      .map((p) => {
        const { dx, dy } = step(p.direction);
        // p.offsetX/Y is the point's own unrounded local offset from this
        // entity's centre — using p.x/p.y (the rounded world tile) minus
        // this entity's own independently-rounded x/y would drift whenever
        // the two roundings don't land the same way (e.g. a south-facing
        // pump's socket at entity.y + 0.5).
        return { offsetX: p.offsetX + dx, offsetY: p.offsetY + dy, direction: p.direction };
      }),
    // An unused drill has had its points pruned from the network (see
    // FluidNetwork.pruneUnused), so having any means it is plumbed in.
    plumbed: ctx.fluidNetwork.pointsFor(entity.entityNumber).length > 0,
    // A ghost shows every port open, for the same reason it shows every
    // cover above.
    fluidPoints: ctx.fluidNetwork
      .pointsFor(entity.entityNumber)
      .map((p) => ({
        local: p.local,
        state: entity.entityNumber === -1 ? ("open" as const) : ctx.fluidNetwork.stateOf(p),
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        direction: p.direction,
      })),
    // Fixed [0, 1.5] offset rotated by the ENTITY's own placement direction
    // (not the connection point's facing), and sprite picked by
    // entityDirection+8 — both taken verbatim from the reference renderer's
    // draw_boiler, which hardcodes this rather than deriving it from
    // conn.position (see unconnectedHeatCovers' own doc comment for why
    // that's the faithful choice for heat-exchanger specifically).
    unconnectedHeatCovers: ctx.heatNetwork
      .pointsFor(entity.entityNumber)
      .filter((p) => entity.entityNumber === -1 || !ctx.heatNetwork.isConnected(p))
      .map(() => {
        // Rotating [0, 1.5] by direction only depends on entity.direction,
        // never on which point triggered it — every unconnected point on
        // this entity produces the exact same offset/sprite pair.
        const [offsetX, offsetY] = rotate90([0, 1.5], entity.direction);
        return { offsetX, offsetY, spriteDirection: toCardinal(entity.direction + 8) };
      })
      // heat-exchanger has exactly one connection, so this never actually
      // produces duplicates today, but dedupe by offset defensively rather
      // than assume that stays true for every future heat-covers entity.
      .filter((v, i, arr) => arr.findIndex((o) => o.offsetX === v.offsetX && o.offsetY === v.offsetY) === i),
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
    slotModules: entity.modules.flatMap((stack) => Array<string>(stack.count).fill(stack.name)),
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
    case "combinator":
      // Not a neighbour rule: the display shows the entity's own operation.
      frame.connectionName = `${combinatorSymbol(entity)}-${dir4Name(entity.direction)}`;
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
        // Both halves store the direction items travel (as a 2.0 blueprint
        // does — see packages/sim/src/network.ts), so the lane runs along
        // entity.direction as-is; only the structure column (below) flips
        // for an exit.
        const laneFacing = toCardinal(entity.direction);
        const shape = classifyBeltCell(x, y, entity.direction, ctx.grid, ctx.isBeltLike, true);
        frame.connectionIndex = shape.row;
        frame.caps = shape.caps.filter((cap) => cap.kind === (frame.undergroundIn ? "start" : "end"));
        frame.sideLoad = undergroundSideLoad(x, y, entity.direction, ctx.grid, ctx.isBeltLike);
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
    case "cargo-bay":
      frame.cargoPieces = cargoBayPieces(entity, visual.tileFootprint, ctx.cargoBays);
      break;
  }

  // An underground's exit half stores its travel direction, but its
  // structure sheet's column is indexed by the way its hood faces — back
  // toward the entrance — so it comes from the opposite facing (the
  // reference editor flips exits the same way).
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
    case "animation": return Math.floor((frame.animation * (axis.speedup ?? 1)) / (axis.slowdown ?? 1));
    case "connection": return frame.connectionIndex;
    case "underground-end": {
      const sideLoadIndex = frame.undergroundIn ? axis.inSideLoadIndex : axis.outSideLoadIndex;
      if (frame.sideLoad.front && sideLoadIndex !== undefined) return sideLoadIndex;
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
    // A colour the sheet has no frame for (a rail signal with no track to
    // guard) shows red.
    case "signal-state": return axis.frames[frame.signalState] ?? axis.frames.red ?? 0;
    case "orientation": {
      const turn = ((frame.orientation % 1) + 1) % 1;
      const index = Math.round(turn * (axis.halfTurn ? 2 : 1) * axis.count) % axis.count;
      return axis.axis === "column" ? index % axis.lineLength : Math.floor(index / axis.lineLength);
    }
    case "direction16Grid": {
      const count = axis.count ?? 16;
      const index = ((frame.rawDirection % count) + count) % count;
      return axis.axis === "column" ? index % axis.lineLength : Math.floor(index / axis.lineLength);
    }
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
    entityNumber: entity.entityNumber,
  });
}

/** An inserter's platform (the static base plate under the swinging arm)
 *  Y-sorts against neighbours like any other entity's body — confirmed
 *  against the real game, where the platform sits at the same ordinary
 *  "object" render layer everything else does, and only the arm/hand
 *  pictures always draw above neighbours regardless of depth (they're
 *  designed to swing out over neighbouring tiles). Emitting the platform
 *  here, through the same push()/sort pipeline collectEntity's other
 *  entities use, is what lets a taller neighbour correctly overlap an
 *  inserter's base the way it would any other building — drawInserter's own
 *  procedural pass (see render.ts) now only paints the arm on top of
 *  whatever this pass already painted, never the platform. */
export function collectInserterPlatform(
  out: DrawCommand[],
  entity: PlacedEntity,
  graphics: InserterGraphics,
  alpha: number,
): void {
  // The sheet holds one frame per facing, and the frame for a facing is the
  // one at the OPPOSITE direction's index (as the reference editor's
  // spriteDataBuilder picks it: ((dir + 8) % 16) / 4). The pipeline's sprite
  // carries no `columns`, which push() reads as a single-frame sheet and
  // wraps every facing back to frame 0 — so it is given here.
  const column = (opposite(toCardinal(entity.direction)) / 4) % graphics.platformDirections;
  push(out, { ...graphics.platform, columns: graphics.platformDirections }, column, 0, entity, Layer.Object, 0, alpha);
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

  const first = out.length;
  const isStub = (l: GraphicsLayer | undefined) => l !== undefined && "per" in l && l.per === "pipe-pictures";
  const pointsOf = (refs: FluidPointRef[]) =>
    frame.fluidPoints.filter((p) => refs.some((r) => r.x === p.local.x && r.y === p.local.y && r.direction === p.local.direction));

  graphics.layers.forEach((layer, order) => {
    // A drill's dry-only and wet-only art: draw whichever matches.
    if (layer.plumbed !== undefined && layer.plumbed !== frame.plumbed) return;
    // Art a fluid box switches on: one of its points has to be live, or —
    // for a thruster's elbows — carrying an actual connection.
    if (layer.enabledBy) {
      const live = pointsOf(layer.enabledBy.points);
      const on = layer.enabledBy.connected ? live.some((p) => p.state === "connected" || p.state === "sibling") : live.length > 0;
      if (!on) return;
    }
    // A cargo bay's planet-only and platform-only art: draw whichever matches.
    if (layer.onSpacePlatform !== undefined && layer.onSpacePlatform !== frame.onSpacePlatform) return;
    // A cargo hub/bay draws several connection pieces at once, each at its
    // own spot on the outline. A piece sorts by that spot rather than by
    // its sprite's shift, so the pieces of one tier overlap front to back
    // the same way whichever sheet they are cut from.
    if ("per" in layer && layer.per === "cargo-connection") {
      for (const piece of frame.cargoPieces) {
        const sprite = layer.sprites[`${piece.shape}.${piece.seed % (layer.variants[piece.shape] ?? 1)}`];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, piece.x, piece.y, false, undefined, 0, -(sprite.shift?.[1] ?? 0));
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

    // A pipe stub draws at every live point of its fluid box, anchored on
    // the tile the socket opens onto like a cover is. Factorio stacks a
    // machine's own sprites by draw order alone, where this renderer sorts
    // by where each one lands — which would put a side-facing stub beneath
    // the body it plugs into. So a stub borrows the sort key of the body
    // pieces already collected for this entity: level with the last of them
    // to go over the body (later in the layer list, it wins the tie), just
    // ahead of the first to go under.
    if ("per" in layer && layer.per === "pipe-pictures") {
      const body = out.slice(first).filter((c) => c.layer === layer.layer && !isStub(graphics.layers[c.order])).map((c) => c.y);
      for (const point of pointsOf(layer.points)) {
        const sprite = layer.sprites[dir4Name(point.direction)];
        if (!sprite) continue;
        const { dx, dy } = step(point.direction);
        const offsetX = point.offsetX + dx;
        const offsetY = point.offsetY + dy;
        const own = entity.y + offsetY + (sprite.shift?.[1] ?? 0);
        const wanted = body.length === 0 ? own : layer.under ? Math.min(own, Math.min(...body) - CAP_PRIORITY_EPSILON) : Math.max(own, Math.max(...body));
        push(out, sprite, 0, 0, entity, layer.layer, order, alpha, offsetX, offsetY, false, undefined, 0, wanted - own);
      }
      return;
    }

    // A fusion port's own art: one sprite per connection point, its column
    // picked by what that point is plugged into — and nothing at all for a
    // state the layer names no column for.
    if ("per" in layer && layer.per === "fluid-point") {
      const { x, y, direction } = layer.point;
      const state = frame.fluidPoints.find((p) => p.local.x === x && p.local.y === y && p.local.direction === direction)?.state;
      // No such point right now (its fluid box is switched off): no port, no art.
      if (!state) return;
      // A mixed pair carries no fluid, so unless the layer has art for it
      // the port is simply open.
      const { open, connected, sibling = connected, siblingMixed = open } = layer.columns;
      const column = { open, connected, sibling, siblingMixed }[state];
      const sprite = layer.sprites[dir4Name(entity.direction)];
      if (sprite && column !== undefined) push(out, sprite, column, 0, entity, layer.layer, order, alpha);
      return;
    }

    // heat-covers' own cap draws once per UNconnected heat-network point —
    // same rule as pipe-covers (see unconnectedHeatCovers' own doc comment:
    // confirmed against the reference renderer's draw_boiler, whose
    // `needsEnding = !isConnected` gate this mirrors exactly — the cap
    // patches over a bare stub, the same as a fluid pipe-cover, and is
    // NOT the reactor's "always draw one of two variants" pattern).
    if ("per" in layer && layer.per === "heat-covers") {
      for (const point of frame.unconnectedHeatCovers) {
        const sprite = layer.sprites[dir4Name(point.spriteDirection)];
        if (sprite) push(out, sprite, 0, 0, entity, layer.layer, order, alpha, point.offsetX, point.offsetY);
      }
      return;
    }

    // A rail's end cap, at each end no other track carries on from: the
    // frame is the direction that end points out along.
    if ("per" in layer && layer.per === "rail-ending") {
      const piece = { name: entity.name, x: entity.x, y: entity.y, direction: entity.direction };
      const open = openEnds(piece, ctx.railJoints);
      railEnds(entity.name, entity.direction).forEach((end, i) => {
        if (open[i]) push(out, layer.sprites, end.dir, 0, entity, layer.layer, order, alpha, end.dx, end.dy);
      });
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

    // A beacon's module-slot art: each physical slot draws its socket —
    // column 0 bare, column N holding a tier-N module — and, once filled,
    // the box/lights masks over it at column N-1, multiplied by that
    // module's beacon_tint. Every piece carries its own baked-in shift, so
    // no extra offset is needed here.
    if ("per" in layer && layer.per === "module-slot") {
      layer.slots.forEach((slot, i) => {
        const name = frame.slotModules[i];
        const art = name === undefined ? undefined : visual.moduleArt?.[name] ?? { tier: 1 };
        const tier = art ? Math.min(Math.max(art.tier, 1), Math.max((slot.empty.columns ?? 1) - 1, 1)) : 0;
        push(out, slot.empty, tier, 0, entity, layer.layer, order, alpha, 0, 0, false, undefined, 0, layer.ySortBias ?? 0);
        if (!art) return;
        for (const piece of slot.filled) {
          const before = out.length;
          push(out, piece.sprite, tier - 1, 0, entity, layer.layer, order, alpha, 0, 0, false, undefined, 0, layer.ySortBias ?? 0);
          const color = piece.tint && art[piece.tint];
          if (color && out.length > before) out[out.length - 1]!.multiply = color;
        }
      });
      return;
    }

    const sprite = spriteFor(layer, entity, frame);
    // An underground's structure patches are separate layers, told apart
    // only by their sheet's file name — each one is dropped where a side
    // feed runs across it (see undergroundSideLoad).
    if (sprite && entity.undergroundType !== undefined) {
      if (frame.sideLoad.back && sprite.sheet.endsWith("-back-patch.png")) return;
      if (frame.sideLoad.front && sprite.sheet.endsWith("-front-patch.png")) return;
    }
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
    // A belt side-loading an underground (see undergroundSideLoad) overlaps
    // its lane and must paint over it, rails included — but plain belts sit
    // on the lower belt layer, below the lane. Drop the lane to the belt
    // layer: a south feed's row already sorts after it, a north feed's row
    // needs the lane sorted just ahead of it.
    const underSideFeed = isUndergroundLane && (frame.sideLoad.back || frame.sideLoad.front);
    const laneLayer = underSideFeed ? Layer.LowerObject : layer.layer;
    const laneBias = (layer.ySortBias ?? 0) + (isUndergroundLane && frame.sideLoad.back ? -1 - CAP_PRIORITY_EPSILON : 0);
    push(out, sprite, column, row, entity, laneLayer, order, alpha, 0, 0, false, isUndergroundLane ? frame.laneKeepSide : undefined, laneRecenter, laneBias);

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
        // The inset only moves where the cap lands — yBias hands it back to
        // the sort key, so the cap still ties (and, with capPriority, wins)
        // against whatever sits on the whole tile it covers.
        const insetX = -cap.dx * cap.inset;
        const insetY = -cap.dy * cap.inset;
        push(out, sprite, column, cap.row, entity, layer.layer, order, alpha, cap.dx + insetX, cap.dy + insetY, capPriority, undefined, laneRecenter, -insetY);
      }
    }
  });

  // A signal on elevated track is drawn with its ground art up on the deck,
  // over the track it stands beside; its shadow stays on the ground.
  if (entity.railLayer === "elevated") {
    for (let i = first; i < out.length; i++) {
      const c = out[i]!;
      if (c.layer === Layer.Shadow) continue;
      c.dy -= RAIL_DECK_HEIGHT;
      c.layer = Layer.ElevatedRailMetal;
    }
  }
}
