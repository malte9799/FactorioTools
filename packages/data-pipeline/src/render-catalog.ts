/** Builds the RenderCatalog: how to draw every entity that can appear in a
 *  blueprint but has no rate of its own. One explicit adapter per prototype
 *  family, each checked against a real dump. */
import { Layer } from "@factoriotools/engine";
import type { EntityGraphics, GraphicsLayer, MenuGroup, MenuPosition, RenderCatalog, RenderEntityProto, Sprite, TileProto, TileVariantSheet } from "@factoriotools/engine";
import type { LocaleTables } from "./locale.js";
import { ROLLING_STOCK_TABLES, STOCK_LINE_LENGTH, rollingStockLayout } from "./pack-rolling-stock.js";
import {
  animationListGraphics,
  beltAnimationAxis,
  combinatorDisplayLayer,
  directionColumnGraphics,
  fluidEnablersOf,
  heatConnectionPatchLayers,
  heatConnectionsOf,
  heatCoversOf,
  layerOf,
  perDirection,
  pipeConnectionsOf,
  pipeCoversLayers,
  pipePictureLayers,
  outputWireConnectionsOf,
  stackSources,
  staticGraphics,
  unwrapAll,
  toSprite,
  unwrap,
  wireConnectionsOf,
} from "./sprite-shapes.js";

type Raw = Record<string, Record<string, any>>;

function box(collisionBox: [[number, number], [number, number]] | undefined, fallback: [number, number]): [number, number] {
  if (!collisionBox) return fallback;
  const [[x1, y1], [x2, y2]] = collisionBox;
  return [Math.round((x2 - x1) * 100) / 100, Math.round((y2 - y1) * 100) / 100];
}

function footprintOf(proto: any): [number, number] {
  return box(proto.selection_box, [1, 1]);
}

/** A thruster's selection box runs on down over its exhaust nozzle, well
 *  past the tiles it stands on, and so isn't centred on the entity. Its
 *  collision box is the real footprint (4x5) — and what decides whether it
 *  sits on whole or half tiles, which its pipe sockets have to agree with
 *  to land on a tile at all. A prototype that ships no collision box falls
 *  back to footprintOf's selection box rather than stopping the build. */
function collisionFootprint(proto: any): [number, number] {
  if (!Array.isArray(proto.collision_box)) return footprintOf(proto);
  const [[x1, y1], [x2, y2]] = proto.collision_box as [[number, number], [number, number]];
  return [Math.ceil(x2 - x1), Math.ceil(y2 - y1)];
}

const DIR4 = ["north", "east", "south", "west"] as const;
const DIR8 = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

/** Pipes and heat-pipes ship one sprite per connection shape, named by which
 *  sides connect — classifyPipe (neighbours/pipe.ts) is what actually
 *  decides which of these names a tile needs at draw time, so the keys here
 *  must match ITS naming, not necessarily the source prototype's own field
 *  names. Regular pipe's own fields already agree with classifyPipe's
 *  corner_{up,down}_{left,right} order; heat-pipe's equivalent fields swap
 *  it to corner_{left,right}_{up,down} — confirmed by spike against the raw
 *  dump, not a typo in either prototype, just two different conventions —
 *  so each PIPE_VARIANTS entry also lists heat-pipe's alternate field name
 *  to fall back to when the canonical one isn't present. */
const PIPE_VARIANTS: { key: string; altKey?: string }[] = [
  { key: "straight_vertical" },
  { key: "straight_horizontal" },
  { key: "corner_up_right", altKey: "corner_right_up" },
  { key: "corner_up_left", altKey: "corner_left_up" },
  { key: "corner_down_right", altKey: "corner_right_down" },
  { key: "corner_down_left", altKey: "corner_left_down" },
  { key: "t_up" },
  { key: "t_down" },
  { key: "t_left" },
  { key: "t_right" },
  { key: "cross" },
  { key: "ending_up" },
  { key: "ending_down" },
  { key: "ending_left" },
  { key: "ending_right" },
  // heat-pipe's own no-neighbours sprite is just called "single", not
  // "straight_vertical_single" like regular pipe's — same
  // different-convention story as the corner keys above.
  { key: "straight_vertical_single", altKey: "single" },
];

function pipeGraphics(pictures: any, connector: "pipe" | "heat-pipe" = "pipe"): EntityGraphics | undefined {
  if (!pictures) return undefined;
  const sprites: Record<string, Sprite> = {};
  for (const { key, altKey } of PIPE_VARIANTS) {
    const raw = pictures[key] ?? (altKey ? pictures[altKey] : undefined);
    const sprite = toSprite(Array.isArray(raw) ? raw[0] : raw);
    if (sprite) sprites[key] = sprite;
  }
  if (Object.keys(sprites).length === 0) return undefined;
  return {
    connector,
    layers: [{ layer: Layer.Object, sprites, per: "connection" }],
  };
}

/** The reactor's own body (`picture`) sits above a second static sprite,
 *  `lower_layer_picture` — the internal-piping baseplate visible around its
 *  edges (reactor-pipes.png) — which must paint underneath the body rather
 *  than stack among its layers in declaration order: paint order sorts by
 *  layer tier first, each sprite's own y-shift only second, so sharing
 *  Layer.Object with the body would risk winning the sort and covering it
 *  depending on their relative shifts. Same story as pumpjack's own
 *  Layer.LowerObject baseplate in dump-to-gamedata.ts's pumpjackBaseGraphics. */
function reactorGraphics(proto: any): EntityGraphics | undefined {
  const body = staticGraphics(proto.picture);
  if (!body) return undefined;
  const { main: lower } = unwrap(proto.lower_layer_picture);
  if (!lower) return body;
  return { layers: [{ layer: Layer.LowerObject, sprites: lower }, ...body.layers] };
}

/** Walls pick both their sprite and its shadow by the same connection name. */
const WALL_PIECES: { field: string; name: string }[] = [
  { field: "single", name: "single" },
  { field: "straight_vertical", name: "straightVertical" },
  { field: "straight_horizontal", name: "straightHorizontal" },
  { field: "corner_right_down", name: "cornerRight" },
  { field: "corner_left_down", name: "cornerLeft" },
  { field: "t_up", name: "t" },
  { field: "ending_right", name: "endingRight" },
  { field: "ending_left", name: "endingLeft" },
];

function wallGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const sprites: Record<string, Sprite> = {};
  const shadows: Record<string, Sprite> = {};
  for (const { field, name } of WALL_PIECES) {
    const { main, shadow } = unwrap(pics?.[field]);
    if (!main) return undefined;
    sprites[name] = main;
    if (shadow) shadows[name] = shadow;
  }
  const layers: GraphicsLayer[] = [];
  if (Object.keys(shadows).length > 0) {
    layers.push({ layer: Layer.Shadow, sprites: shadows, per: "connection" });
  }
  layers.push({ layer: Layer.Object, sprites, per: "connection" });
  return { connector: "wall", layers };
}

/** Undergrounds and loaders share one sheet: facings as columns, entrance
 *  and exit (and, for undergrounds only, their side-loading variants — a
 *  different mouth piece for when a belt feeds in from the side rather
 *  than straight on) as rows. A loader's structure has no side-loading
 *  fields or ground-seam patches, so those layers are simply absent.
 *
 *  Both also carry their own belt_animation_set — the same transport-
 *  belt.png sheet a plain belt uses — for the moving, item-carrying lane
 *  under/behind the structure sprite. collect.ts's resolveFrame crops that
 *  lane's frame to just its open-end half (laneKeepSide) — without that
 *  crop this visibly overlapped/clipped through a loader's smaller box
 *  icon, which is why the lane was dropped for loaders entirely at first;
 *  the crop is what makes it safe to bring back, matching an underground-
 *  belt's own half-belt look exactly. */
function undergroundGraphics(proto: any): EntityGraphics | undefined {
  const struct = proto.structure;
  const out = struct?.direction_out?.sheet;
  const inn = struct?.direction_in?.sheet;
  const sprite = toSprite(out ?? inn);
  if (!sprite) return undefined;
  const rowOf = (s: any): number | undefined => (s ? Math.round((s.y ?? 0) / s.height) : undefined);

  const beltLane = toSprite(proto.belt_animation_set?.animation_set);

  const layers: GraphicsLayer[] = [];

  // Pushed BEFORE the structure layers, so the mouth/box art (an
  // underground-belt's several tiles across, a loader's own smaller icon)
  // paints on top of the lane rather than the lane covering it — both are
  // Layer.Object, so array order is what decides.
  if (beltLane) {
    layers.push({ layer: Layer.Object, sprites: beltLane, column: beltAnimationAxis(proto), row: { by: "connection" } });
  }

  const backPatch = toSprite(struct?.back_patch?.sheet);
  if (backPatch) layers.push({ layer: Layer.Object, sprites: { ...backPatch, columns: 4 }, column: { by: "direction" } });

  layers.push({
    layer: Layer.Object,
    // One column per facing; the entrance/exit/side-loading rows are
    // picked by the entity's own end and its live neighbours, so the grid
    // origin resets to the sheet's top.
    sprites: { ...sprite, y: 0, columns: 4 },
    column: { by: "direction" },
    row: {
      by: "underground-end",
      inIndex: rowOf(inn) ?? 1,
      outIndex: rowOf(out) ?? 0,
      inSideLoadIndex: rowOf(struct?.direction_in_side_loading?.sheet),
      outSideLoadIndex: rowOf(struct?.direction_out_side_loading?.sheet),
    },
  });

  const frontPatch = toSprite(struct?.front_patch?.sheet);
  if (frontPatch) layers.push({ layer: Layer.Object, sprites: { ...frontPatch, columns: 4 }, column: { by: "direction" } });

  // Needed so collectEntity's belt-connector branch runs at all — without
  // it, an underground never picks up its own open-end cap or checks for
  // side-loading, both resolved from live neighbours the same way a plain
  // belt's are.
  return { layers, connector: "belt" };
}

/** A splitter draws two belt lanes under a body whose art is one whole file
 *  per facing. East and west need an extra patch to fill a gap their shorter
 *  body sprite leaves. */
function splitterGraphics(proto: any): EntityGraphics | undefined {
  const beltRaw = proto.belt_animation_set?.animation_set;
  const belt = toSprite(beltRaw);
  const structure = proto.structure;
  if (!belt || !structure) return undefined;

  const body = perDirection(structure, DIR4);
  if (!body) return undefined;

  // A splitter straddles two tiles, so it carries a belt lane either side of
  // its centre, offset across its own facing.
  const lane = (side: -1 | 1): Record<(typeof DIR4)[number], Sprite> => {
    const across = (d: (typeof DIR4)[number]): [number, number] =>
      d === "north" || d === "south" ? [0.5 * side, 0] : [0, 0.5 * side];
    return {
      north: { ...belt, shift: across("north") },
      east: { ...belt, shift: across("east") },
      south: { ...belt, shift: across("south") },
      west: { ...belt, shift: across("west") },
    };
  };

  const layers: GraphicsLayer[] = [
    { layer: Layer.LowerObject, sprites: lane(-1), per: "dir4", column: beltAnimationAxis(proto), row: { by: "connection" } },
    { layer: Layer.LowerObject, sprites: lane(1), per: "dir4", column: beltAnimationAxis(proto), row: { by: "connection" } },
    { layer: Layer.Object, sprites: body, per: "dir4" },
  ];

  const patches = proto.structure_patch ?? {};
  const usable = (raw: any) => typeof raw?.filename === "string" && !raw.filename.endsWith("empty.png");
  if (DIR4.some((d) => usable(patches[d]))) {
    const patch = {} as Record<(typeof DIR4)[number], Sprite>;
    for (const d of DIR4) {
      const sprite = usable(patches[d]) ? toSprite(patches[d]) : body[d];
      if (sprite) patch[d] = sprite;
    }
    layers.push({ layer: Layer.Object, sprites: patch, per: "dir4" });
  }
  return { connector: "belt", layers };
}

/** A roboport's `base` is the body with its hatch opening left uncovered;
 *  the closed-hatch cap and the seam patch over it are separate fields,
 *  always drawn together at their animation's first (closed) frame since a
 *  blueprint shows an idle roboport. The hatch is two leaves — up and down —
 *  each sliding into place from its own side at frame 0; each field's own
 *  shift already positions its half, no rotation needed. The doors must sit
 *  visibly on top of the hatch opening they cover — Layer.AboveObject,
 *  confirmed by hand in the layer-order debug tool (#/layer-debug): sharing
 *  plain Layer.Object with `base` let the base win the y-sort and render
 *  the doors underneath it instead. */
function roboportGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const l of unwrapAll(proto.base)) {
    layers.push({ layer: l.shadow ? Layer.Shadow : Layer.Object, sprites: l.sprite });
  }
  const patch = toSprite(proto.base_patch);
  if (patch) layers.push({ layer: Layer.Object, sprites: patch });
  for (const field of ["door_animation_up", "door_animation_down"]) {
    const door = toSprite(proto[field]);
    if (door) layers.push({ layer: Layer.AboveObject, sprites: door });
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** A thruster's body is graphics_set.animation; its four pipe elbows are
 *  working_visualisations entries each switched on by one of its fuel/
 *  oxidizer pipe connections, and only while that connection is plugged in
 *  (the boxes' `draw_only_when_connected`) — a bare thruster shows none.
 *  The fifth entry, a `fadeout` exhaust-flame effect, only shows while
 *  running and is skipped for the same reason animationListGraphics skips
 *  !always_draw entries.
 *
 *  Under it all goes the `integration_patch` (thruster-bckg), on its own
 *  `integration_patch_render_layer` (floor): the pipework that joins each
 *  elbow to the body. Without it the elbows float a gap away from it. */
function thrusterGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const { main, shadow } = unwrap(gs?.animation);
  if (!main) return undefined;
  const layers: GraphicsLayer[] = [];
  const patch = unwrap(gs?.integration_patch?.north ?? gs?.integration_patch).main;
  if (patch) layers.push({ layer: layerOf(gs?.integration_patch_render_layer, Layer.Floor), sprites: patch });
  if (shadow) layers.push({ layer: Layer.Shadow, sprites: shadow });
  layers.push({ layer: Layer.Object, sprites: main });
  const pipes = animationListGraphics(gs?.working_visualisations, fluidEnablersOf(proto));
  if (pipes) layers.push(...pipes.layers);
  return { layers };
}

/** Picks one direction's frame out of a rotated_sprite-shaped sheet
 *  (direction_count + line_length, direction packed into ROWS — see
 *  isDirectionInRows) as a fixed, non-rotating Sprite: bakes the row's y
 *  offset (and, for a sheet split across several same-sized files, the
 *  right file) directly into the sprite rather than leaving it for
 *  column/row frame axes, since this layer is meant to always draw that one
 *  frame regardless of the entity's placement facing.
 *
 *  `cropTopFraction` chops that fraction off the TOP of the frame (0..1,
 *  e.g. 0.75 keeps only the bottom quarter) by shrinking frameHeight and
 *  advancing y into the frame by the same amount — crane-7/arm_outer's own
 *  frame is a long bare telescoping shaft with just a small mounting
 *  bracket at the bottom; the shaft's reach is irrelevant to an idle,
 *  unextended pose and reads as a stray beam without it. Cropping shifts
 *  the remaining art's own center down by half the removed height, so the
 *  caller's `shift` must be pre-compensated (the crop happens here, not in
 *  push()'s own frame math, so nothing else can absorb that offset). */
function fixedDirectionFrame(raw: any, direction: number, cropTopFraction = 0): Sprite | undefined {
  const sprite = toSprite(raw);
  if (!sprite) return undefined;
  const lineLength = raw?.line_length ?? 1;
  const row = Math.floor(direction / lineLength);
  const col = direction % lineLength;
  let sheet = sprite.sheet;
  let sheetRow = row;
  if (sprite.sheets && sprite.rowsPerSheet) {
    const fileIndex = Math.floor(row / sprite.rowsPerSheet);
    sheet = sprite.sheets[fileIndex] ?? sprite.sheets[sprite.sheets.length - 1]!;
    sheetRow = row % sprite.rowsPerSheet;
  }
  const y = sheetRow * sprite.frameHeight;
  const cropPx = Math.round(sprite.frameHeight * cropTopFraction);
  return {
    ...sprite,
    sheet,
    sheets: undefined,
    rowsPerSheet: undefined,
    x: col * sprite.frameWidth,
    y: y + cropPx,
    frameHeight: sprite.frameHeight - cropPx,
  };
}

/** The agricultural tower's arm ("crane") is a separate, heavily-animated
 *  prototype (`proto.crane`, required in from its own file) rather than a
 *  field under graphics_set — graphics_set alone (what the generic
 *  PICTURE_FIELD path reads) only covers the base pedestal, which is why a
 *  naive read of this entity renders a bare stump with an empty mounting
 *  socket at the top and no arm at all.
 *
 *  The crane's 9 parts are positioned by the game as a true 3D kinematic
 *  chain (relative_position/static_length against crane.origin) and its
 *  rotated_sprite sheets are yaw-only — every direction keeps the part
 *  vertical on screen, no frame alone depicts a swept, angled arm. So
 *  rather than solve that chain, PART_PLACEMENT below is a hand-picked
 *  direction + shift + paint-order bias per part, eyeballed in a one-off
 *  visual placement tool (this project's own crane-editor scratch tool,
 *  not part of the shipped app) against the base's own collar opening
 *  until the still pose read correctly — the closest a still, unanimated
 *  blueprint icon needs to get to the arm's real extended silhouette.
 *
 *  Each part's own `shift` (authored for its place in the 3D rig, relative
 *  to crane.origin) does NOT carry over to this flat stack — confirmed by
 *  spike: applied as-is, the hub's raw shift draws it oversized and
 *  floating clear of the collar. ySortBias is likewise necessary, not
 *  cosmetic: paint order within Layer.Object sorts by each sprite's own
 *  shift.y (see collect.ts's push()), and every crane part's frame carries
 *  a large transparent margin (room for the sheet's other 127 directions'
 *  poses) that can otherwise sort a correctly-placed part behind the
 *  base's own collar/tube art.
 *
 *  arm_central is deliberately omitted: its placement was never actually
 *  finished, and unlike the others it isn't needed for a believable idle
 *  pose — the parts on either side of it already read as a continuous arm
 *  without it. */
function agriculturalTowerGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const { main, shadow } = unwrap(gs?.animation);
  if (!main) return undefined;
  const layers: GraphicsLayer[] = [];
  if (shadow) layers.push({ layer: Layer.Shadow, sprites: shadow });
  layers.push({ layer: Layer.Object, sprites: main });

  const PART_PLACEMENT: Record<string, { direction: number; shift: [number, number]; ySortBias: number; cropTopFraction?: number; rotationDeg?: number }> = {
    hub: { direction: 96, shift: [0.5114, -3.3137], ySortBias: 4 },
    arm_inner: { direction: 96, shift: [-0.6467, -3.8829], ySortBias: 3, rotationDeg: 300 },
    arm_inner_joint: { direction: 96, shift: [-1.9705, -4.3942], ySortBias: 6, rotationDeg: 275 },
    arm_central_joint: { direction: 96, shift: [-3.3445, -4.3072], ySortBias: 5, rotationDeg: 253 },
    // arm_outer's own frame is a long bare telescoping shaft with just a
    // small mounting bracket at one end — the shaft's reach is irrelevant
    // to an idle, unextended pose and reads as a stray floating beam
    // without cropping. Cropped to its bottom quarter (the bracket end;
    // "top" here means the top of the SOURCE frame, the far/telescoping
    // end, not screen-up) via fixedDirectionFrame's cropTopFraction, which
    // shrinks frameHeight and advances y into the frame — that shifts the
    // remaining art's own center down by half the removed height, so the
    // shift below is pre-compensated (see the shift math in
    // agriculturalTowerGraphics' call site) to land the bracket where it
    // was placed against the un-cropped frame in the editor.
    arm_outer: { direction: 96, shift: [-4.0324, -7.8409], ySortBias: 5, cropTopFraction: 0.75, rotationDeg: 75 },
    "grappler-hub": { direction: 48, shift: [-4.5742, -3.6692], ySortBias: 0, rotationDeg: 180 },
    telescope: { direction: 0, shift: [-4.5945, -2.3077], ySortBias: -3, rotationDeg: 180 },
    "grappler-claw": { direction: 0, shift: [-4.6013, -0.9101], ySortBias: -5, rotationDeg: 180 },
  };
  const parts = proto.crane?.parts;
  const partByName = new Map<string, any>((parts ?? []).map((p: any) => [p.name, p]));
  for (const [name, placement] of Object.entries(PART_PLACEMENT)) {
    const part = partByName.get(name);
    const raw = part?.rotated_sprite ?? part?.sprite; // telescope/grappler-claw use the non-rotating `sprite` field
    const sprite = fixedDirectionFrame(raw, placement.direction, placement.cropTopFraction ?? 0);
    if (!sprite) continue;
    // Cropping shrinks frameHeight and keeps the BOTTOM of the source
    // frame, which moves that remaining art's own center down on screen by
    // half the cropped-away height — add that back so `placement.shift`
    // (picked against the full, uncropped frame) still lands the kept
    // portion where it was placed.
    const cropPx = raw ? Math.round((raw.height ?? 0) * (placement.cropTopFraction ?? 0)) : 0;
    const shiftY = placement.shift[1] + (cropPx * (sprite.scale ?? 1)) / 2 / 32;
    layers.push({
      layer: Layer.Object,
      sprites: { ...sprite, shift: [placement.shift[0], shiftY], rotationDeg: placement.rotationDeg },
      column: { by: "none" },
      ySortBias: placement.ySortBias,
    });
  }
  return { layers };
}

/** artillery-turret's cannon (base + barrel) rotates through a 256-entry
 *  aiming sheet — 64 rows of line_length frames, meant for fine in-combat
 *  traverse — rather than the plain {north,east,south,west} split every
 *  other rotatable entity here uses. A blueprint only shows one of the 16
 *  placement facings, so this picks that facing's single nearest frame via
 *  Layer.direction256 (see collect.ts's axisIndex) instead of animating
 *  through the sheet. The turret's own base_picture platform is genuinely
 *  static (no direction_count of its own — radially symmetric, doesn't need
 *  to rotate) and stays a plain fixed sprite. */
function artilleryTurretGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const l of unwrapAll(proto.base_picture)) {
    layers.push({ layer: l.shadow ? Layer.Shadow : Layer.Object, sprites: l.sprite });
  }
  // cannon_base_shift's 3rd component is the cannon's own z-height above the
  // turret's base platform (raised on its mount) — not baked into either
  // sprite's own `shift`, unlike every other entity here. Without
  // subtracting it from shift.y (z-up = screen-up = negative y), the
  // cannon base/barrel draw a full tile too low, sitting on the ground
  // instead of raised on the platform.
  const zLift = proto.cannon_base_shift?.[2] ?? 0;
  for (const field of ["cannon_base_pictures", "cannon_barrel_pictures"]) {
    for (const l of unwrapAll(proto[field])) {
      const lineLength = l.sprite.columns ?? 1;
      const [sx, sy] = l.sprite.shift ?? [0, 0];
      layers.push({
        layer: l.shadow ? Layer.Shadow : Layer.AboveObject,
        sprites: { ...l.sprite, shift: [sx, sy - zLift] },
        column: { by: "direction256", axis: "column", lineLength },
        row: { by: "direction256", axis: "row", lineLength },
      });
    }
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** fusion-reactor's own border: 8 connection pieces around its perimeter
 *  (graphics_set.connections_graphics, each with its own baked shift placing
 *  it at one specific spot), one per neighbour_connectable connection.
 *  graphics_set.direction_to_connections_graphics maps {north, east}
 *  (fusion-reactor is `two_direction_only`) to which piece (1-based) each
 *  connection uses at that facing — the connections rotate with the entity,
 *  the pieces don't.
 *
 *  Each piece is a 5-frame sheet, and the frame is the port's state, not
 *  animation. 0 = coolant port (the ordinary round pipe flange), 1 = plasma
 *  port (the angular one) — the same frame whether the port is bare or has
 *  a pipe/generator on it, confirmed against the game: a generator's own
 *  intake housing plugs straight onto frame 1. 2..4 only appear between
 *  two reactors: 2 = coolant meeting coolant, 3 = plasma meeting plasma,
 *  4 = a coolant port meeting a plasma one (plating, no pipe). Whether a
 *  connection is plasma or coolant is its own neighbour_connectable
 *  category against graphics_set.plasma_category; what it's attached to
 *  comes from the fluid-box point sitting half a tile inside it (the
 *  neighbour connection is declared on the entity's edge, its pipe
 *  connection on the centre of the edge tile). */
function fusionReactorConnectionLayers(proto: any): GraphicsLayer[] {
  const gs = proto.graphics_set;
  const pieces: { main?: Sprite; shadow?: Sprite }[] = (gs?.connections_graphics ?? []).map((c: any) => unwrap(c.pictures));
  const dirMap = gs?.direction_to_connections_graphics;
  const connections: any[] = proto.neighbour_connectable?.connections ?? [];
  if (pieces.length === 0 || !dirMap?.north || !dirMap?.east) return [];
  const points = pipeConnectionsOf(proto);

  const layers: GraphicsLayer[] = [];
  for (let slot = 0; slot < pieces.length; slot++) {
    const northPiece = pieces[dirMap.north[slot] - 1];
    const eastPiece = pieces[dirMap.east[slot] - 1];
    const location = connections[slot]?.location;
    const [dx, dy] = ({ 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] } as Record<number, [number, number]>)[location?.direction ?? -1] ?? [0, 0];
    const found = points.find(
      (p) =>
        p.direction === location?.direction &&
        Math.abs(p.x - (location.position[0] - dx / 2)) < 0.01 &&
        Math.abs(p.y - (location.position[1] - dy / 2)) < 0.01,
    );
    if (!found) throw new Error(`${proto.name}: no fluid point behind neighbour connection ${slot}`);
    const point = { x: found.x, y: found.y, direction: found.direction };
    const plasma = connections[slot].category === gs.plasma_category;
    const own = plasma ? 1 : 0;
    const columns = { open: own, connected: own, sibling: plasma ? 3 : 2, siblingMixed: 4 };
    if (northPiece?.shadow && eastPiece?.shadow) {
      layers.push({ layer: Layer.Shadow, sprites: { north: northPiece.shadow, east: eastPiece.shadow }, per: "fluid-point", point, columns });
    }
    if (northPiece?.main && eastPiece?.main) {
      layers.push({ layer: Layer.Object, sprites: { north: northPiece.main, east: eastPiece.main }, per: "fluid-point", point, columns });
    }
  }
  return layers;
}

function fusionReactorGraphics(proto: any): EntityGraphics | undefined {
  const body = directionColumnGraphics(proto.graphics_set);
  const layers = [...(body?.layers ?? []), ...fusionReactorConnectionLayers(proto)];
  return layers.length > 0 ? { layers } : undefined;
}

/** rail-signal/rail-chain-signal's own sheet: 16 rows (one per placement
 *  direction, 0..15 — a genuine 16-way sheet, not the 256-entry aiming grid
 *  artillery-turret's cannon uses) with one frame per signal colour as
 *  columns. row picks the direction row directly (direction16); column
 *  picks the frame of the colour the signal is at, through the prototype's
 *  own signal_color_to_structure_frame_index. */
function railSignalGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  const frames: Record<string, number> = proto.ground_picture_set?.signal_color_to_structure_frame_index ?? { green: 0, yellow: 1, red: 2 };
  for (const l of unwrapAll(proto.ground_picture_set?.structure)) {
    const lineLength = l.sprite.columns ?? 1;
    layers.push({
      layer: l.shadow ? Layer.Shadow : Layer.Object,
      sprites: { ...l.sprite, columns: lineLength },
      column: { by: "signal-state", frames },
      row: { by: "direction16" },
    });
  }
  // On elevated track a signal wears other art, hung off the side of the
  // deck: a sheet with more rows than facings, the extra ones for
  // particular rail shapes. structure_align_to_animation_index gives the
  // row for each facing and shape (12 shapes per facing); the row most of
  // a facing's shapes share is the plain one, used on any track.
  const elevated = proto.elevated_picture_set;
  const align: number[] | undefined = elevated?.structure_align_to_animation_index;
  if (elevated?.structure && align?.length === 16 * 12) {
    const rows = Array.from({ length: 16 }, (_, d) => {
      const counts = new Map<number, number>();
      for (const row of align.slice(d * 12, d * 12 + 12)) counts.set(row, (counts.get(row) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    });
    const deckFrames: Record<string, number> = elevated.signal_color_to_structure_frame_index ?? frames;
    for (const l of layers) l.onDeck = false;
    for (const l of unwrapAll(elevated.structure)) {
      layers.push({
        layer: Layer.Object,
        onDeck: true,
        sprites: { ...l.sprite, columns: l.sprite.columns ?? 1 },
        column: { by: "signal-state", frames: deckFrames },
        row: { by: "direction16", rows, byShape: align },
      });
    }
    // The bracket that holds it off the deck, and its shadow on the ground:
    // one frame per facing and rail shape, picked the same way. A chain
    // signal has a second piece (upper_rail_piece) that reaches up over
    // the deck's bed; the tier each is given here stands for the deck tier
    // the renderer lifts it to.
    for (const [bracket, tier] of [[elevated.rail_piece, Layer.LowerObject], [elevated.upper_rail_piece, Layer.LowerObjectOverlay]] as const) {
      const bracketAlign: number[] | undefined = bracket?.align_to_frame_index;
      if (!bracket?.sprites || bracketAlign?.length !== 16 * 12) continue;
      const plain = (d: number) => {
        const counts = new Map<number, number>();
        for (const f of bracketAlign.slice(d * 12, d * 12 + 12)) counts.set(f, (counts.get(f) ?? 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      };
      const bracketFrames = Array.from({ length: 16 }, (_, d) => plain(d));
      const raw: any[] = bracket.sprites.layers ?? [bracket.sprites];
      for (const r of raw) {
        const sprite = toSprite(r);
        if (!sprite) continue;
        const lineLength = r.line_length || r.frame_count || 1;
        const axis = { by: "direction16Grid", lineLength, frames: bracketFrames, byShape: bracketAlign } as const;
        layers.push({
          layer: r.draw_as_shadow ? Layer.Shadow : tier,
          onDeck: true,
          sprites: { ...sprite, columns: lineLength },
          column: { ...axis, axis: "column" },
          row: { ...axis, axis: "row" },
        });
      }
    }
  }
  // The cables from the signal to the rail beside it (rail_piece): one frame
  // per facing in a line_length grid. Its align_to_frame_index picks a
  // slightly different frame for some rail shapes; frame = facing is the
  // plain one the game uses on straight track. Drawn over the rails, under
  // the signal itself.
  const piece = toSprite(proto.ground_picture_set?.rail_piece?.sprites);
  if (piece) {
    const { line_length, frame_count } = proto.ground_picture_set.rail_piece.sprites;
    // Without a line_length every frame sits in one row.
    const lineLength = line_length || frame_count || 1;
    layers.unshift({
      layer: Layer.LowerObject,
      onDeck: elevated?.structure ? false : undefined,
      sprites: { ...piece, columns: lineLength },
      column: { by: "direction16Grid", axis: "column", lineLength },
      row: { by: "direction16Grid", axis: "row", lineLength },
    });
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** Locomotives and wagons: a shadow, two sets of wheels and a body, each
 *  one frame per heading on the sheets pack-rolling-stock.ts writes. */
function rollingStockGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const { sheet, source, shadow, count, halfTurn, bogieOffset } of rollingStockLayout(proto)) {
    const axis = { by: "orientation", lineLength: STOCK_LINE_LENGTH, count, halfTurn: halfTurn || undefined } as const;
    const sprites = { sheet, frameWidth: source.width, frameHeight: source.height, columns: STOCK_LINE_LENGTH, shift: source.shift, scale: source.scale ?? 1 };
    if (bogieOffset !== undefined) {
      // A set of wheels under each end. A frame's coupling points back
      // from its heading, so the front set is the one turned round: both
      // couplings point out of the wagon. They sit a tier below the
      // bodies, so no wagon's wheels paint over its own body or a
      // neighbour's.
      for (const along of [bogieOffset, -bogieOffset]) {
        const turned = { ...axis, reversed: along > 0 || undefined };
        layers.push({ layer: Layer.ObjectUnder, sprites, along, column: { ...turned, axis: "column" }, row: { ...turned, axis: "row" } });
      }
      continue;
    }
    layers.push({
      layer: shadow ? Layer.Shadow : Layer.Object,
      sprites,
      column: { ...axis, axis: "column" },
      row: { ...axis, axis: "row" },
    });
  }
  // Shadows paint first.
  layers.sort((a, b) => a.layer - b.layer);
  return layers.length > 0 ? { layers } : undefined;
}

/** A rolling stock prototype's collision box: how wide it is and how long. */
function rollingStockSize(proto: any): { width: number; length: number } {
  const [[x1, y1], [x2, y2]] = proto.collision_box;
  return { width: x2 - x1, length: y2 - y1 };
}

/** Gates only have two real orientations, so north aliases south and east
 *  aliases west. */
function gateGraphics(proto: any): EntityGraphics | undefined {
  const vertical = unwrap(proto.vertical_animation);
  const horizontal = unwrap(proto.horizontal_animation);
  if (!vertical.main || !horizontal.main) return undefined;
  const spread = (v: Sprite, h: Sprite) => ({ north: v, south: v, east: h, west: h });
  const layers: GraphicsLayer[] = [];
  if (vertical.shadow && horizontal.shadow) {
    layers.push({ layer: Layer.Shadow, sprites: spread(vertical.shadow, horizontal.shadow), per: "dir4" });
  }
  layers.push({ layer: Layer.Object, sprites: spread(vertical.main, horizontal.main), per: "dir4" });
  return { layers };
}

function fusionGeneratorGraphics(proto: any): EntityGraphics | undefined {
  const gs = proto.graphics_set;
  const mains = {} as Record<(typeof DIR4)[number], Sprite>;
  const shadows = {} as Record<(typeof DIR4)[number], Sprite>;
  let anyShadow = false;
  for (const d of DIR4) {
    const { main, shadow } = unwrap(gs?.[`${d}_graphics_set`]?.animation);
    if (!main) return undefined;
    mains[d] = main;
    if (shadow) {
      shadows[d] = shadow;
      anyShadow = true;
    } else {
      shadows[d] = main;
    }
  }
  const layers: GraphicsLayer[] = [];
  if (anyShadow) layers.push({ layer: Layer.Shadow, sprites: shadows, per: "dir4" });
  layers.push({ layer: Layer.Object, sprites: mains, per: "dir4" });

  // The plasma intake housings: `fluid_input_graphics` has one entry per
  // input_fluid_box pipe connection, in order (empty for the pass-through
  // outputs, whose angular caps are already part of the body sprite). An
  // intake is only there while something feeds that port.
  const inputs: any[] = proto.input_fluid_box?.pipe_connections ?? [];
  for (let index = 0; index < inputs.length; index++) {
    const point = { x: inputs[index].position[0], y: inputs[index].position[1], direction: inputs[index].direction };
    const intake: Partial<Record<(typeof DIR4)[number], Sprite>> = {};
    const intakeShadow: Partial<Record<(typeof DIR4)[number], Sprite>> = {};
    for (const d of DIR4) {
      const { main, shadow } = unwrap(gs[`${d}_graphics_set`]?.fluid_input_graphics?.[index]?.sprite);
      if (main) intake[d] = main;
      if (shadow) intakeShadow[d] = shadow;
    }
    const columns = { connected: 0 };
    if (Object.keys(intakeShadow).length > 0) layers.push({ layer: Layer.Shadow, sprites: intakeShadow, per: "fluid-point", point, columns });
    if (Object.keys(intake).length > 0) layers.push({ layer: Layer.Object, sprites: intake, per: "fluid-point", point, columns });
  }
  return { layers };
}

/** pipe-to-ground and valve ship one whole file per facing, no shadow. */
function perFacingGraphics(proto: any, field: string): EntityGraphics | undefined {
  const sprites = perDirection(proto[field], DIR4);
  if (!sprites) return undefined;
  return { layers: [{ layer: Layer.Object, sprites, per: "dir4" }] };
}

/** A storage tank only has two real looks, not four: its `pictures.picture`
 *  sheet's `frames: 2` isn't animation frame count despite the field name —
 *  it's flipped tank/pipe-window art for the vertical (north/south) vs.
 *  horizontal (east/west) placement, confirmed against the reference
 *  renderer's own draw_storage_tank (frame = floor(dir/4) % frames, dir
 *  0..15). Plain `directionColumnGraphics`/`isDirectionIndexed` would treat
 *  this `frames` field as an animation length and always draw frame 0,
 *  which is why the tank never appeared to rotate. */
function storageTankGraphics(proto: any): EntityGraphics | undefined {
  const { main, shadow } = unwrap(proto.pictures?.picture);
  if (!main) return undefined;
  const layers: GraphicsLayer[] = [];
  if (shadow) layers.push({ layer: Layer.Shadow, sprites: shadow, column: { by: "direction" } });
  layers.push({ layer: Layer.Object, sprites: main, column: { by: "direction" } });
  return { layers };
}

/** A rail's five pieces stack bottom-to-top: ballast, path, ties, backplates,
 *  metals. Only four of the eight facings carry art for straight and
 *  half-diagonal rails — the other four are the same piece seen from the
 *  opposite end. Curves carry all eight.
 *
 *  Each piece gets its own render tier (the game's own rail-stone-path-lower
 *  … rail-metal layers) rather than one shared Floor tier, so where two
 *  rails cross every bed paints under every rail. Elevated rails use the
 *  same pieces on the elevated tiers, and their ballast piece is a stack of
 *  the deck plus the ground shadow it casts. */
const RAIL_PIECES = ["stone_path_background", "stone_path", "ties", "backplates", "metals"] as const;

const RAIL_PIECE_LAYER: Record<(typeof RAIL_PIECES)[number], { ground: Layer; elevated: Layer }> = {
  stone_path_background: { ground: Layer.RailStonePathLower, elevated: Layer.ElevatedRailStonePathLower },
  stone_path: { ground: Layer.RailStonePath, elevated: Layer.ElevatedRailStonePath },
  ties: { ground: Layer.RailTie, elevated: Layer.ElevatedRailTie },
  backplates: { ground: Layer.RailScrew, elevated: Layer.ElevatedRailScrew },
  metals: { ground: Layer.RailMetal, elevated: Layer.ElevatedRailMetal },
};

const RAIL_MIRROR: Record<(typeof DIR8)[number], (typeof DIR8)[number]> = {
  north: "north",
  northeast: "northeast",
  east: "east",
  southeast: "southeast",
  south: "north",
  southwest: "northeast",
  west: "east",
  northwest: "southeast",
};

/** Each rail type's track bounds in tiles, north facing. The renderer's
 *  railGeometry works these out per direction; these only seed the catalog. */
const RAIL_FOOTPRINT: Record<string, [number, number]> = {
  "straight-rail": [2, 2],
  "half-diagonal-rail": [4, 4],
  "curved-rail-a": [4, 6],
  "curved-rail-b": [4, 6],
  "elevated-straight-rail": [2, 2],
  "elevated-half-diagonal-rail": [4, 4],
  "elevated-curved-rail-a": [4, 6],
  "elevated-curved-rail-b": [4, 6],
};

function railGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const elevated = String(proto.name).startsWith("elevated-");
  const layers: GraphicsLayer[] = [];
  for (const piece of RAIL_PIECES) {
    // A piece is either one sprite or a stack (an elevated deck plus its
    // shadow); each stack slot becomes its own layer.
    const slots: { shadow: boolean; sprites: Partial<Record<(typeof DIR8)[number], Sprite>> }[] = [];
    let missing = false;
    for (const dir of DIR8) {
      const own = pics?.[dir];
      const source = own && Object.keys(own).length > 0 ? own : pics?.[RAIL_MIRROR[dir]];
      const raw = source?.[piece];
      if (!raw) {
        missing = true;
        break;
      }
      const parts: any[] = Array.isArray(raw.layers) ? raw.layers : [raw];
      parts.forEach((part, i) => {
        const sprite = toSprite(part);
        if (sprite) (slots[i] ??= { shadow: !!part.draw_as_shadow, sprites: {} }).sprites[dir] = sprite;
      });
    }
    // Elevated rails have no ties piece; a ground rail missing one is broken.
    if (missing) {
      if (!elevated) return undefined;
      continue;
    }
    const tier = RAIL_PIECE_LAYER[piece][elevated ? "elevated" : "ground"];
    for (const slot of slots) {
      if (Object.keys(slot.sprites).length !== DIR8.length) continue;
      layers.push({ layer: slot.shadow ? Layer.Shadow : tier, sprites: slot.sprites, per: "dir8" });
    }
  }
  layers.push(...railFenceLayers(proto, DIR8, "dir8", Layer.ElevatedRailMetal, (dir) => RAIL_MIRROR[dir]));
  // The end cap where track stops (rail_endings): 16 frames in a row, one
  // per direction an end points out along. On the ground the buffer and
  // its gravel go under the rails and the rail tips over them; an elevated
  // cap is one piece over the deck, with its shadow on the ground.
  const endings: any[] = pics?.rail_endings?.sheets ?? [];
  endings.forEach((sheet, i) => {
    const sprite = toSprite(sheet);
    if (!sprite) return;
    const tier = sheet.draw_as_shadow ? Layer.Shadow : elevated ? Layer.ElevatedRailMetal : i === 0 ? Layer.RailScrew : Layer.RailMetal;
    layers.push({ layer: tier, sprites: { ...sprite, columns: 16 }, per: "rail-ending" });
  });
  return layers.length > 0 ? { layers } : undefined;
}

/** The guard rails along both sides of elevated track and ramps
 *  (fence_pictures): per side, the fence itself with its ground shadow, and
 *  on elevated track an upper part the game draws over passing trains. Both
 *  go over the track here. The separate end pieces, and leaving the fence
 *  off where track branches, aren't drawn. */
function railFenceLayers<D extends string>(
  proto: any,
  dirs: readonly D[],
  per: "dir4" | "dir8",
  tier: Layer,
  mirror: (dir: D) => D,
): GraphicsLayer[] {
  const layers: GraphicsLayer[] = [];
  for (const side of ["side_A", "side_B"]) {
    for (const part of ["fence", "fence_upper"]) {
      const set = proto.fence_pictures?.[side]?.[part];
      if (!set) continue;
      const slots: { shadow: boolean; sprites: Partial<Record<D, Sprite>> }[] = [];
      for (const dir of dirs) {
        const own = set[dir];
        const raw = own && Object.keys(own).length > 0 ? own : set[mirror(dir)];
        if (!raw) continue;
        const stack: any[] = Array.isArray(raw.layers) ? raw.layers : [raw];
        let slot = 0;
        for (const piece of stack) {
          const sprite = toSprite(piece);
          // A curve's or half-diagonal's fence is cut into variations, side
          // by side in the sheet, each holding part of its length: all of
          // them together are the whole fence.
          for (let v = 0; v < (piece.variation_count || 1); v++, slot++) {
            if (!sprite) continue;
            // line_length counts the sheet's facings, not animation frames.
            (slots[slot] ??= { shadow: !!piece.draw_as_shadow, sprites: {} }).sprites[dir] = {
              ...sprite,
              columns: undefined,
              x: (sprite.x ?? 0) + v * sprite.frameWidth || undefined,
            };
          }
        }
      }
      for (const slot of slots) {
        if (Object.keys(slot.sprites).length !== dirs.length) continue;
        layers.push({ layer: slot.shadow ? Layer.Shadow : tier, sprites: slot.sprites, per } as GraphicsLayer);
      }
    }
  }
  return layers;
}

/** A rail ramp ships one frame per cardinal facing: the ground shadow, the
 *  ramp's concrete body (`ties`) and the track on top of it (`stone_path`).
 *  The ramp climbs from ground to deck height, so it sits in the object tier,
 *  track over body. */
function railRampGraphics(proto: any): EntityGraphics | undefined {
  const pics = proto.pictures;
  const layers: GraphicsLayer[] = [];
  for (const piece of ["stone_path_background", "ties", "stone_path"]) {
    const sprites = {} as Record<(typeof DIR4)[number], Sprite>;
    for (const dir of DIR4) {
      const sprite = toSprite(pics?.[dir]?.[piece]);
      if (!sprite) return undefined;
      // line_length counts this sheet's facings, not animation frames.
      sprites[dir] = { ...sprite, columns: undefined };
    }
    layers.push({ layer: pics?.north?.[piece]?.draw_as_shadow ? Layer.Shadow : Layer.Object, sprites, per: "dir4" });
  }
  layers.push(...railFenceLayers(proto, DIR4, "dir4", Layer.Object, (dir) => dir));
  return { layers };
}

/** A rail support's pylon packs its 8 facings into one grid (line_length
 *  columns per row). It looks the same from both sides (back_equals_front),
 *  so those 8 are the first half of the 16-way facings, in 22.5° steps: the
 *  facing, wrapped round the 8, picks the frame. */
function railSupportGraphics(proto: any): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  const structure = proto.graphics_set?.structure;
  // A rotated sprite may be a stack of layers or a single sprite.
  const parts: any[] = structure?.layers ?? (structure ? [structure] : []);
  for (const part of parts) {
    const base = toSprite(part);
    if (!base) continue;
    const count = part.direction_count || 8;
    // No (or a zero) line_length means all facings sit in one row.
    const lineLength = part.line_length || count;
    layers.push({
      layer: part.draw_as_shadow ? Layer.Shadow : Layer.Object,
      sprites: { ...base, columns: lineLength },
      column: { by: "direction16Grid", axis: "column", lineLength, count },
      row: { by: "direction16Grid", axis: "row", lineLength, count },
    });
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** The game render layers a cargo hub's art is spread over, as this
 *  renderer's tiers. Finer than sprite-shapes' RENDER_LAYERS, which folds
 *  everything between lower-object and object into one tier for every other
 *  entity: a hub's pieces overlap its neighbours' wholesale, so here the
 *  game's own order has to hold. */
const CARGO_RENDER_LAYERS: Record<string, Layer> = {
  "lower-object-above-shadow": Layer.LowerObjectAboveShadow,
  "lower-object-overlay": Layer.LowerObjectOverlay,
  "object-under": Layer.ObjectUnder,
  object: Layer.Object,
  "cargo-hatch": Layer.CargoHatch,
  "above-inserters": Layer.AboveObject,
};

function cargoLayer(raw: any, renderLayer: string | undefined): Layer {
  if (raw.draw_as_shadow) return Layer.Shadow;
  return (renderLayer ? CARGO_RENDER_LAYERS[renderLayer] : undefined) ?? layerOf(renderLayer);
}

/** The sprites of a layered sprite or animation, minus the glow and additive
 *  ones — those need a blend mode this renderer lacks, and drawn plainly
 *  they paint a black box over the art beneath. */
function drawableLayers(source: any): any[] {
  const raws: any[] = source?.layers ?? (source?.filename ? [source] : []);
  return raws.filter((l) => !l.draw_as_glow && !l.draw_as_light && l.blend_mode !== "additive");
}

/** One sprite of a hub's own art: its first frame (idle, hatches shut),
 *  sorted at the hub's centre whatever its shift, so that within a tier the
 *  pieces paint in the order the prototype stacks them. */
function cargoPiece(raw: any, renderLayer: string | undefined, [ox, oy]: [number, number] = [0, 0]): GraphicsLayer | undefined {
  const sprite = toSprite(raw);
  if (!sprite) return undefined;
  const shift: [number, number] = [(sprite.shift?.[0] ?? 0) + ox, (sprite.shift?.[1] ?? 0) + oy];
  return { layer: cargoLayer(raw, renderLayer), sprites: { ...sprite, columns: undefined, shift }, ySortBias: -shift[1] };
}

/** The 17 shapes a cargo hub or bay plates its outline and seams with — see
 *  the renderer's neighbours/cargoBay.ts for which goes where. */
const CARGO_CONNECTION_SHAPES = [
  "top_wall",
  "right_wall",
  "bottom_wall",
  "left_wall",
  "top_left_outer_corner",
  "top_right_outer_corner",
  "bottom_left_outer_corner",
  "bottom_right_outer_corner",
  "top_left_inner_corner",
  "top_right_inner_corner",
  "bottom_left_inner_corner",
  "bottom_right_inner_corner",
  "bridge_horizontal_narrow",
  "bridge_vertical_narrow",
  "bridge_horizontal_wide",
  "bridge_vertical_wide",
  "bridge_crossing",
] as const;

/** Each shape ships a few interchangeable variants, and each variant is a
 *  stack of sub-images, one per render layer — floor, overlay, under-body,
 *  body — the last sometimes with a shadow. One GraphicsLayer per position
 *  in that stack, holding every shape and variant that has art there. */
function cargoConnectionLayers(connections: any): GraphicsLayer[] {
  const variants: Record<string, number> = {};
  const slots = new Map<string, { layer: Layer; sprites: Record<string, Sprite> }>();
  for (const shape of CARGO_CONNECTION_SHAPES) {
    const looks: any[] = connections?.[shape] ?? [];
    if (looks.length === 0) continue;
    variants[shape] = looks.length;
    looks.forEach((look: any, variant: number) => {
      (Array.isArray(look) ? look : [look]).forEach((sub: any, position: number) => {
        drawableLayers(sub).forEach((raw, index) => {
          const sprite = toSprite(raw);
          if (!sprite) return;
          const layer = cargoLayer(raw, sub.render_layer);
          const key = `${position}/${layer === Layer.Shadow ? "shadow" : index}`;
          let slot = slots.get(key);
          if (!slot) slots.set(key, (slot = { layer, sprites: {} }));
          slot.sprites[`${shape}.${variant}`] = sprite;
        });
      });
    });
  }
  return [...slots.values()].map((slot) => ({ ...slot, per: "cargo-connection" as const, variants }));
}

/** A cargo hub or bay. `picture` is not a list of looks to choose between
 *  but one stack: each entry names the render layer its sprites belong to,
 *  from the floor plating up to the body and the rim round a hatch. On top
 *  of it come the idle `animation`, the hatches (shut — a hatch's doors
 *  close over the rim, so they follow the picture), and the connection art
 *  that joins the entity to its neighbours.
 *
 *  A cargo bay carries a second, complete set for space platforms; both are
 *  emitted, each layer marked with the surface it belongs to. */
function cargoBayGraphics(proto: any, cargoSurface?: "planet" | "space"): EntityGraphics | undefined {
  const station = proto.cargo_station_parameters;
  const hatches: GraphicsLayer[] = [];
  const addHatch = (graphics: any, renderLayer: string, offset?: [number, number]) => {
    for (const raw of drawableLayers(graphics)) {
      const piece = cargoPiece(raw, renderLayer, offset);
      if (piece) hatches.push(piece);
    }
  };
  // A landing pad's door for logistic robots, set into its body.
  addHatch(proto.robot_animation, "object");
  for (const hatch of [...(proto.hatch_definitions ?? []), ...(station?.hatch_definitions ?? [])]) {
    addHatch(hatch.hatch_graphics, hatch.hatch_render_layer ?? "cargo-hatch", hatch.offset);
  }
  for (const giga of station?.giga_hatch_definitions ?? []) {
    addHatch(giga.hatch_graphics_back, giga.hatch_render_layer_back ?? "higher-object-under");
    addHatch(giga.hatch_graphics_front, giga.hatch_render_layer_front ?? "higher-object-above");
  }

  const setLayers = (gs: any): GraphicsLayer[] => {
    const layers: GraphicsLayer[] = [];
    for (const entry of [gs?.picture ?? []].flat()) {
      for (const raw of drawableLayers(entry)) {
        const piece = cargoPiece(raw, entry.render_layer);
        if (piece) layers.push(piece);
      }
    }
    for (const raw of drawableLayers(gs?.animation)) {
      const piece = cargoPiece(raw, gs.animation_render_layer ?? "object");
      if (piece) layers.push(piece);
    }
    return [...layers, ...hatches, ...cargoConnectionLayers(gs?.connections)];
  };

  const layers = proto.platform_graphics_set
    ? [
        ...setLayers(proto.graphics_set).map((l) => ({ ...l, onSpacePlatform: false })),
        ...setLayers(proto.platform_graphics_set).map((l) => ({ ...l, onSpacePlatform: true })),
      ]
    : setLayers(proto.graphics_set);
  return layers.length > 0 ? { layers, connector: "cargo-bay", cargoSurface } : undefined;
}

/** The largest y-shift among an entity's body (Object-layer) sprites — the
 *  sort position anything drawn on top of the body has to clear. */
export function bodyShiftY(graphics: EntityGraphics | undefined): number {
  let max = 0;
  for (const layer of graphics?.layers ?? []) {
    if (layer.layer !== Layer.Object || !("sprites" in layer)) continue;
    const sprites: Sprite[] = "per" in layer ? (Object.values(layer.sprites) as Sprite[]) : [layer.sprites];
    for (const sprite of sprites) max = Math.max(max, sprite.shift?.[1] ?? 0);
  }
  return max;
}

/** Prototype tables whose entities show their operation on a display. */
const COMBINATOR_TABLES = new Set(["arithmetic-combinator", "decider-combinator", "selector-combinator"]);

const ROTATES_FOOTPRINT = new Set([
  // 1x2 combinators: without the swap an east/west-facing one snapped (and
  // hit-tested) as if it still stood upright, half a tile off the grid.
  "arithmetic-combinator",
  "decider-combinator",
  "selector-combinator",
  "splitter",
  "fast-splitter",
  "express-splitter",
  "turbo-splitter",
  // A loader's real footprint (loader-1x1 is square and needs none of
  // this) is 1x2 — confirmed via its own selection_box, [-0.5,-1] to
  // [0.5,1] — so facing East/West needs the same width/height swap a
  // splitter's non-square footprint does, or the grid-snap axes (picked
  // by each dimension's own odd/even parity in render.ts's snapAxis) end
  // up snapping the wrong axis to whole vs. half tiles, misaligning the
  // ghost/placed box by half a tile whenever it's rotated sideways.
  "loader",
  "fast-loader",
  "express-loader",
  "turbo-loader",
  // pump is 1x2 (selection_box [-0.5,-1] to [0.5,1]), same non-square
  // footprint issue as loader above.
  "pump",
  // boiler/heat-exchanger are 3x2 (selection_box [-1.5,-1] to [1.5,1]),
  // same non-square footprint issue as loader/pump above.
  "boiler",
  "heat-exchanger",
  // offshore-pump is ~1.2x1.98 (selection_box [-0.6,-1.49] to [0.6,0.49]),
  // same non-square footprint issue as pump above.
  "offshore-pump",
  // 3x5 generators (collision_box 2.8x4.8 / 2.7x4.7), the same shape as
  // steam-engine, which entityLookup.ts covers on the machine side.
  "fusion-generator",
  "burner-generator",
  // Rotatable turrets with a non-square collision_box: flamethrower-turret
  // is 2x3 (1.4x2.4), railgun-turret 3x5 (2.82x4, tile_height 5).
  "flamethrower-turret",
  "railgun-turret",
]);

/** table -> how to pull graphics out of that table's prototypes. Kept as an
 *  explicit map (not inferred) so adding a new entity kind means adding one
 *  line here with its confirmed field name, not guessing at runtime. */
const PICTURE_FIELD: Record<string, string> = {
  container: "picture",
  "logistic-container": "picture",
  pump: "animations",
  "offshore-pump": "graphics_set",
  "solar-panel": "picture",
  accumulator: "chargable_graphics",
  boiler: "pictures",
  "heat-interface": undefined as any,
  radar: "pictures",
  "rocket-silo": "graphics_set",
  "electric-pole": "pictures",
  // `picture_off` is the real unlit fixture (with its own proper shadow
  // layer) — confirmed by spike the previously-used `picture_on` is only
  // the glow-bulb overlay meant to sit ON TOP of the fixture when lit, not
  // the fixture itself, which is why lamps rendered as a bare floating
  // bulb with no shadow and no visible base.
  lamp: "picture_off",
  "arithmetic-combinator": "sprites",
  "decider-combinator": "sprites",
  "constant-combinator": "sprites",
  "programmable-speaker": "sprite",
  "power-switch": "power_on_animation",
  "display-panel": "sprites",
  "land-mine": "picture_safe",
  "train-stop": "rail_overlay_animations",
  "asteroid-collector": "graphics_set",
  "mining-drill": "graphics_set",
  // Turrets: graphics_set.base_visualisation.animation is the turret's real
  // stationary base/body sprite (per-direction {north,east,south,west[,
  // diagonals]} — extractPicture's own base_visualisation fallback recurses
  // into it), universal across every ammo/electric/fluid-turret prototype
  // (confirmed by spike). `folded_animation` was tried first but is NOT a
  // reliable substitute: for gun-turret/laser-turret/tesla-turret/
  // rocket-turret it happens to BE the base body, but for flamethrower-
  // turret/railgun-turret it's only the gun NOZZLE piece (a much smaller,
  // separately-shifted sprite), which rendered as a nonsensical fragment
  // rather than the turret's actual body. Each base sprite also has a
  // `*-mask` layer (a team-color tint mask) extractPicture doesn't know
  // about; picking the first non-shadow layer as `main` skips it, matching
  // the "one main + one shadow" simplification used everywhere else here.
  "ammo-turret": "graphics_set",
  "electric-turret": "graphics_set",
  "fluid-turret": "graphics_set",
  "linked-container": "picture",
  "infinity-container": "picture",
  "electric-energy-interface": "picture",
  "burner-generator": "animation",
  "selector-combinator": "sprites",
  "lightning-attractor": "chargable_graphics",
};

/** Tables whose art spans several fields, stacked bottom to top. A turret's
 *  gun sits on its base; a train stop's post and sign on its rail overlay. */
const STACKED_FIELDS: Record<string, string[]> = {
  "train-stop": ["rail_overlay_animations", "animations", "top_animations"],
  "ammo-turret": ["graphics_set", "folded_animation"],
  "electric-turret": ["graphics_set", "folded_animation"],
  "fluid-turret": ["graphics_set", "folded_animation"],
};

const SIMPLE_STATIC_TABLES = [...new Set([...Object.keys(PICTURE_FIELD), ...Object.keys(STACKED_FIELDS)])];

/** Item tables that can carry a `place_result` — every prototype table an
 *  actually-placeable item could belong to. Kept as an explicit list rather
 *  than scanning every top-level table, matching this file's own house
 *  style of explicit per-kind lists over blind traversal. */
const ITEM_TABLES = ["item", "item-with-entity-data", "capsule", "gun", "armor", "module", "rail-planner"];

/** Every prototype table an item that a recipe can PRODUCE might belong to
 *  — broader than ITEM_TABLES above (that one only needs tables that can
 *  carry `place_result`; this one needs every item-ish table at all, since
 *  a recipe's product is often something with no place_result whatsoever —
 *  science packs are `tool`, ammo is `ammo`, etc). Mirrors dump-to-
 *  gamedata.ts's own mapItems table list. */
const RECIPE_PRODUCT_ITEM_TABLES = [
  "item",
  "item-with-entity-data",
  "module",
  "tool",
  "ammo",
  "capsule",
  "gun",
  "armor",
  "repair-tool",
  "rail-planner",
  "spidertron-remote",
  "selection-tool",
  "copy-paste-tool",
  "deconstruction-item",
  "upgrade-item",
  "blueprint",
  "blueprint-book",
  "space-platform-starter-pack",
];

function resolvePosition(
  subgroupToGroup: Map<string, { group: string; subgroupOrder: string }>,
  menuGroups: MenuGroup[],
  subgroupName: unknown,
  order: unknown,
): MenuPosition {
  const resolved = typeof subgroupName === "string" ? subgroupToGroup.get(subgroupName) : undefined;
  // No subgroup, or a subgroup naming a group this dump's item-group table
  // doesn't have an icon for (matches the game's own "Other" catch-all
  // tab) — confirmed by spike this is a real, if uncommon, case rather
  // than a data gap to work around.
  const group = resolved && menuGroups.some((g) => g.name === resolved.group) ? resolved.group : "other";
  return {
    group,
    subgroup: typeof subgroupName === "string" ? subgroupName : "other",
    subgroupOrder: resolved?.subgroupOrder ?? "",
    order: typeof order === "string" ? order : "",
  };
}

/** Resolves the real game's own build-menu structure (item-group ->
 *  item-subgroup -> item.order) from the raw dump — confirmed by spike this
 *  is exactly what the in-game build menu itself sorts by, not a guessed
 *  categorization. Returns menuGroups sorted by their own order, one
 *  menuPositions entry per placeable entity name (resolved from whichever
 *  item has `place_result === entityName`; an entity with no such item, or
 *  whose item has no subgroup, is simply absent — the palette skips it
 *  rather than inventing a slot), and one recipeMenuPositions entry per
 *  recipe name — resolved from the recipe's own main (first) product item's
 *  subgroup, NOT place_result, since a recipe's product (a science pack, an
 *  ammo type, ...) is usually not itself a placeable entity. This is what
 *  the recipe-picker window's category tabs use, matching the real game's
 *  own recipe-selection GUI, which groups recipes by the SAME item-group
 *  tabs the build menu shows — confirmed by the user against their own
 *  in-game reference — not RecipeProto.category (Factorio's internal
 *  crafting_category field: "crafting", "smelting", ...), which doesn't
 *  correspond to any real in-game UI grouping. */
function buildMenuIndex(
  raw: Raw,
  locale: LocaleTables,
): {
  menuGroups: MenuGroup[];
  menuPositions: Record<string, MenuPosition>;
  itemMenuPositions: Record<string, MenuPosition>;
  recipeMenuPositions: Record<string, MenuPosition>;
  itemNames: Record<string, string>;
  signals: RenderCatalog["signals"];
} {
  const subgroupToGroup = new Map<string, { group: string; subgroupOrder: string }>();
  for (const sg of Object.values(raw["item-subgroup"] ?? {})) {
    subgroupToGroup.set(sg.name, { group: sg.group, subgroupOrder: sg.order ?? "" });
  }

  const groupProtos = Object.values(raw["item-group"] ?? {});
  const menuGroups: MenuGroup[] = groupProtos
    .filter((g: any) => typeof g.icon === "string")
    .map((g: any) => ({
      name: g.name,
      icon: g.icon,
      localised: locale.itemGroupName?.get(g.name) ?? g.name,
      order: g.order ?? "",
    }))
    .sort((a, b) => a.order.localeCompare(b.order));

  const menuPositions: Record<string, MenuPosition> = {};
  for (const table of ITEM_TABLES) {
    for (const item of Object.values(raw[table] ?? {}) as any[]) {
      const entityName = item.place_result;
      if (typeof entityName !== "string" || menuPositions[entityName]) continue;
      menuPositions[entityName] = resolvePosition(subgroupToGroup, menuGroups, item.subgroup, item.order);
    }
  }

  const itemSubgroupByName = new Map<string, unknown>();
  const itemOrderByName = new Map<string, unknown>();
  const itemMenuPositions: Record<string, MenuPosition> = {};
  const itemNames: Record<string, string> = {};
  for (const table of RECIPE_PRODUCT_ITEM_TABLES) {
    for (const item of Object.values(raw[table] ?? {}) as any[]) {
      if (itemSubgroupByName.has(item.name)) continue;
      itemSubgroupByName.set(item.name, item.subgroup);
      itemOrderByName.set(item.name, item.order);
      itemMenuPositions[item.name] = resolvePosition(subgroupToGroup, menuGroups, item.subgroup, item.order);
      // A buildable item without its own [item-name] takes its entity's
      // name, as the game does.
      itemNames[item.name] =
        locale.itemName.get(item.name) ??
        (typeof item.place_result === "string" ? locale.entityName.get(item.place_result) : undefined) ??
        locale.entityName.get(item.name) ??
        item.name;
    }
  }
  // Fluids have their own subgroup too (usually "fluid" itself) — a
  // fluid-producing recipe (e.g. sulfuric-acid) needs the same lookup.
  for (const fluid of Object.values(raw.fluid ?? {}) as any[]) {
    if (itemSubgroupByName.has(fluid.name)) continue;
    itemSubgroupByName.set(fluid.name, fluid.subgroup);
    itemOrderByName.set(fluid.name, fluid.order);
  }

  // Fluids and virtual signals: the non-item signals a blueprint's icons can
  // name, each in its own Fluids / Signals tab of the icon picker.
  const signals: NonNullable<RenderCatalog["signals"]> = {};
  for (const fluid of Object.values(raw.fluid ?? {}) as any[]) {
    if (fluid.hidden === true || fluid.parameter === true) continue;
    signals[fluid.name] = {
      type: "fluid",
      localised: locale.fluidName.get(fluid.name) ?? fluid.name,
      position: resolvePosition(subgroupToGroup, menuGroups, fluid.subgroup, fluid.order),
    };
  }
  for (const signal of Object.values(raw["virtual-signal"] ?? {}) as any[]) {
    // signal-unknown has no subgroup: it's the game's placeholder, not pickable.
    if (typeof signal.subgroup !== "string" || signal.hidden === true) continue;
    signals[signal.name] = {
      type: "virtual",
      localised: locale.virtualSignalName.get(signal.name) ?? signal.name,
      position: resolvePosition(subgroupToGroup, menuGroups, signal.subgroup, signal.order),
    };
  }

  const recipeMenuPositions: Record<string, MenuPosition> = {};
  for (const recipe of Object.values(raw.recipe ?? {}) as any[]) {
    const results = Array.isArray(recipe.results) ? recipe.results : [];
    const mainProduct = results[0]?.name;
    if (typeof mainProduct !== "string") continue;
    recipeMenuPositions[recipe.name] = resolvePosition(
      subgroupToGroup,
      menuGroups,
      itemSubgroupByName.get(mainProduct),
      itemOrderByName.get(mainProduct),
    );
  }

  return { menuGroups, menuPositions, itemMenuPositions, recipeMenuPositions, itemNames, signals };
}

/** A material texture is one picture per 8x8 tiles (the prototype's
 *  `material_texture_width_in_tiles` default). */
const MATERIAL_TILES = 8;

/** Floor art for every tile the player can lay — the only tiles a
 *  blueprint carries. Just the flat floor: the edge transitions against
 *  neighbouring tiles are not extracted.
 *
 *  A tile that is only ever a changed form of a laid one (Aquilo's frozen
 *  concrete) keeps its map colour but no art, which would otherwise be
 *  ~4 MB a sheet for something a blueprint rarely holds. */
function buildTiles(raw: Raw): Record<string, TileProto> {
  const laid = new Set<string>();
  for (const table of ITEM_TABLES) {
    for (const item of Object.values(raw[table] ?? {})) {
      const tile = item.place_as_tile?.result;
      if (!tile) continue;
      laid.add(tile);
      const other = raw.tile?.[tile]?.next_direction;
      if (other) laid.add(other);
    }
  }
  const tiles: Record<string, TileProto> = {};
  for (const proto of Object.values(raw.tile ?? {})) {
    if (!proto.minable) continue;
    const material = proto.variants?.material_background;
    const variants: TileVariantSheet[] = [];
    if (!laid.has(proto.name)) {
      // Map colour only.
    } else if (material) {
      const tilePx = 32 / (material.scale ?? 1);
      variants.push({
        sheet: material.picture, size: MATERIAL_TILES, count: material.count, x: material.x ?? 0, y: material.y ?? 0,
        lineLength: material.line_length ?? material.count, tilePx, probability: 1, repeats: true,
      });
    } else {
      for (const main of proto.variants?.main ?? []) {
        variants.push({
          sheet: main.picture, size: main.size, count: main.count, x: main.x ?? 0, y: main.y ?? 0,
          lineLength: main.line_length ?? main.count, tilePx: 32 / (main.scale ?? 1),
          probability: main.size === 1 ? 1 : (main.probability ?? 1),
        });
      }
      variants.sort((a, b) => b.size - a.size);
    }
    const c = proto.map_color ?? {};
    // A Color is 0-1 floats unless any channel is above 1, then 0-255.
    const channels = [c.r ?? c[0] ?? 0, c.g ?? c[1] ?? 0, c.b ?? c[2] ?? 0];
    const rgb = channels.every((channel) => channel <= 1) ? channels.map((channel) => Math.round(channel * 255)) : channels;
    tiles[proto.name] = { name: proto.name, variants, mapColor: `rgb(${rgb.join(",")})` };
  }
  return tiles;
}

/** Groups the game keeps apart but the editor treats as one: a long-handed
 *  inserter has its own group because its reach differs, which is no reason
 *  to make swapping it for another inserter a delete-and-rebuild here. */
const REPLACE_GROUP_OVERRIDES: Record<string, string> = {
  "long-handed-inserter": "inserter",
};

/** `fast_replaceable_group` of every entity an item places, keyed by entity
 *  name. Entities without a group (or without an item) are left out. */
function buildReplaceGroups(raw: Raw, menuPositions: Record<string, MenuPosition>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of Object.values(raw)) {
    for (const proto of Object.values(table ?? {})) {
      const group = proto?.fast_replaceable_group;
      if (typeof group !== "string" || !group || !menuPositions[proto.name]) continue;
      out[proto.name] = REPLACE_GROUP_OVERRIDES[group] ?? group;
    }
  }
  return out;
}

/** Builds the whole RenderCatalog from a raw data dump: each prototype
 *  family goes through its own adapter above for its base graphics, and
 *  `add` then records every entity's fluid and heat connection points and
 *  appends the art that hangs off them. */
export function buildRenderCatalog(raw: Raw, locale: LocaleTables, version: string): RenderCatalog {
  const entities: Record<string, RenderEntityProto> = {};

  // Cutscene set-dressing and map-generated ruins that share a real
  // prototype type but have no placing item, so can't appear in a blueprint.
  const NOT_PLACEABLE = /^(crash-site-|dummy-|factorio-logo-|factorio-space-age-logo|fulgoran-ruin-)/;

  // Every prototype with a fluid box gets its connection points recorded and
  // a pipe-covers layer appended, regardless of which adapter above built
  // its base graphics — added once here rather than at each call site so a
  // new fluid-box entity picks this up automatically instead of needing its
  // own adapter updated too. Every prototype with a heat-network connection
  // (heatConnectionsOf reads both a producer's heat_buffer and a consumer's
  // energy_source) gets the same treatment for the separate heat network:
  // its connection points recorded, plus whichever of two mutually
  // exclusive patch mechanisms it actually ships — a reactor's own
  // connection_patches_* (heat-connection-patches, always one of two
  // variants) or a heat consumer's own energy_source.pipe_covers
  // (heat-covers, drawn only when UNconnected, same rule as fluid
  // pipe-covers — see heatCoversOf's own doc comment for why heat-exchanger
  // needed this at all).
  const add = (proto: any, graphics: EntityGraphics | undefined, footprintOverride?: [number, number], rollingStock?: { width: number; length: number }) => {
    if (entities[proto.name] || NOT_PLACEABLE.test(proto.name)) return;
    const pipeConnections = pipeConnectionsOf(proto);
    const pictureLayers = pipePictureLayers(proto);
    const coverLayers = pipeCoversLayers(proto);
    const heatConnections = heatConnectionsOf(proto);
    const heatPatchLayers = heatConnectionPatchLayers(proto);
    const heatCoverLayers = heatCoversOf(proto);
    const extraLayers = [...pictureLayers, ...coverLayers, ...heatPatchLayers, ...heatCoverLayers];
    if (extraLayers.length > 0) {
      graphics = { ...(graphics ?? { layers: [] }), layers: [...(graphics?.layers ?? []), ...extraLayers] };
    }
    const display = COMBINATOR_TABLES.has(proto.type) ? combinatorDisplayLayer(proto, bodyShiftY(graphics)) : undefined;
    if (display && graphics) {
      graphics = { ...graphics, layers: [...graphics.layers, display], connector: "combinator" };
    }
    entities[proto.name] = {
      name: proto.name,
      tileFootprint: footprintOverride ?? footprintOf(proto),
      graphics,
      rotatesFootprint: ROTATES_FOOTPRINT.has(proto.name),
      rollingStock,
      pipeConnections: pipeConnections.length > 0 ? pipeConnections : undefined,
      heatConnections: heatConnections.length > 0 ? heatConnections : undefined,
      wireConnections: wireConnectionsOf(proto),
      outputWireConnections: outputWireConnectionsOf(proto),
      // Poles only. Both are read straight off the prototype rather than
      // tabled here: the vanilla four are well known (small 2.5/7.5,
      // medium 3.5/9, big 2/32, substation 9/18), but a mod's pole is not,
      // and a hardcoded table would silently mis-size its overlay.
      supplyAreaDistance: typeof proto.supply_area_distance === "number" ? proto.supply_area_distance : undefined,
      maxWireDistance: typeof proto.maximum_wire_distance === "number" ? proto.maximum_wire_distance : undefined,
      localised: locale.entityName.get(proto.name) ?? proto.name,
    };
  };

  // These three tables' folded_animation gun piece must always draw above
  // its graphics_set base — see stackSources's own promoteLaterSources doc.
  const PROMOTE_GUN_ABOVE_BASE = new Set(["ammo-turret", "electric-turret", "fluid-turret"]);

  for (const table of SIMPLE_STATIC_TABLES) {
    const stacked = STACKED_FIELDS[table];
    const field = PICTURE_FIELD[table];
    for (const proto of Object.values(raw[table] ?? {})) {
      if (stacked) {
        add(proto, stackSources(stacked.map((f) => proto[f]), PROMOTE_GUN_ABOVE_BASE.has(table)));
        continue;
      }
      // A prototype may not use its table's usual field — passive chests
      // carry `animation` where other containers carry `picture`.
      const source = (field ? proto[field] : undefined) ?? proto.animation ?? proto.picture ?? proto.pictures;
      add(proto, directionColumnGraphics(source));
    }
  }

  for (const proto of Object.values(raw["storage-tank"] ?? {})) {
    add(proto, storageTankGraphics(proto));
  }
  for (const proto of Object.values(raw["fusion-reactor"] ?? {})) {
    add(proto, fusionReactorGraphics(proto));
  }
  for (const proto of Object.values(raw.reactor ?? {})) {
    add(proto, reactorGraphics(proto));
  }
  for (const table of ["rail-signal", "rail-chain-signal"]) {
    for (const proto of Object.values(raw[table] ?? {})) {
      add(proto, railSignalGraphics(proto));
    }
  }
  for (const table of ROLLING_STOCK_TABLES) {
    for (const proto of Object.values(raw[table] ?? {})) {
      const size = rollingStockSize(proto);
      add(proto, rollingStockGraphics(proto), [size.width, size.length], size);
    }
  }
  for (const proto of Object.values(raw.pipe ?? {})) {
    add(proto, pipeGraphics(proto.pictures));
  }
  for (const proto of Object.values(raw["heat-pipe"] ?? {})) {
    add(proto, pipeGraphics(proto.connection_sprites, "heat-pipe"));
  }
  for (const proto of Object.values(raw["pipe-to-ground"] ?? {})) {
    add(proto, perFacingGraphics(proto, "pictures"));
  }
  for (const proto of Object.values(raw.valve ?? {})) {
    add(proto, perFacingGraphics(proto, "animations"));
  }
  for (const proto of Object.values({ ...(raw["underground-belt"] ?? {}), ...(raw["loader-1x1"] ?? {}), ...(raw.loader ?? {}) })) {
    add(proto, undergroundGraphics(proto));
  }
  for (const proto of Object.values(raw.splitter ?? {})) {
    add(proto, splitterGraphics(proto));
  }
  for (const proto of Object.values(raw.gate ?? {})) {
    add(proto, gateGraphics(proto));
  }
  for (const proto of Object.values(raw.roboport ?? {})) {
    add(proto, roboportGraphics(proto));
  }
  for (const proto of Object.values(raw["artillery-turret"] ?? {})) {
    add(proto, artilleryTurretGraphics(proto));
  }
  for (const proto of Object.values(raw.thruster ?? {})) {
    add(proto, thrusterGraphics(proto), collisionFootprint(proto));
  }
  for (const proto of Object.values(raw["agricultural-tower"] ?? {})) {
    add(proto, agriculturalTowerGraphics(proto));
  }
  for (const proto of Object.values(raw["fusion-generator"] ?? {})) {
    add(proto, fusionGeneratorGraphics(proto));
  }
  for (const proto of Object.values(raw.wall ?? {})) {
    add(proto, wallGraphics(proto));
  }
  // Rails share one generic selection_box across every rail type, so each
  // type's real track bounds (north facing) are passed explicitly instead —
  // the renderer's railGeometry turns them per direction.
  for (const [table, footprint] of Object.entries(RAIL_FOOTPRINT)) {
    for (const proto of Object.values(raw[table] ?? {})) {
      add(proto, railGraphics(proto), footprint);
    }
  }
  for (const proto of Object.values(raw["rail-ramp"] ?? {})) {
    add(proto, railRampGraphics(proto), [4, 16]);
  }
  for (const proto of Object.values(raw["rail-support"] ?? {})) {
    // Its 2.78 collision box sits on a rail joint (a tile corner), so it
    // reaches into a 4×4 block of tiles.
    add(proto, railSupportGraphics(proto), [4, 4]);
  }
  for (const proto of Object.values(raw["cargo-landing-pad"] ?? {})) {
    add(proto, cargoBayGraphics(proto, "planet"));
  }
  for (const proto of Object.values(raw["space-platform-hub"] ?? {})) {
    add(proto, cargoBayGraphics(proto, "space"));
  }
  for (const proto of Object.values(raw["cargo-bay"] ?? {})) {
    add(proto, cargoBayGraphics(proto));
  }
  for (const proto of Object.values(raw.inserter ?? {})) {
    add(proto, undefined);
  }

  const { menuGroups, menuPositions, itemMenuPositions, recipeMenuPositions, itemNames, signals } = buildMenuIndex(raw, locale);
  const replaceGroups = buildReplaceGroups(raw, menuPositions);
  return { version, entities, replaceGroups, menuGroups, menuPositions, itemMenuPositions, recipeMenuPositions, itemNames, signals, tiles: buildTiles(raw) };
}
