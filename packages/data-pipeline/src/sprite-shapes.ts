/** Reading Factorio's sprite declarations, which come in a handful of
 *  historically-grown shapes, into this project's flat Sprite type. */
import { Layer, type Dir4Name, type EntityGraphics, type GraphicsLayer, type HeatConnectionPoint, type PipeConnectionPoint, type Sprite, type WireAttachPoint, type WireAttachPoints } from "@factoriotools/engine";

/** A leaf sprite declaration: {filename,width,height,...}. Some use a single
 *  square `size` instead of width/height, some split a long frame strip over
 *  `filenames` — file 0 alone (holding frame 0) is enough for every caller
 *  that only ever draws the idle/frame-0 pose, but a caller indexing deeper
 *  into the grid (artillery-turret's 256-direction aiming sheet, split
 *  `lines_per_file` rows per file, needs frames from every file, not just
 *  the first) gets the full sheets/rowsPerSheet split instead — see
 *  Sprite's own doc comment and collect.ts's push(), which picks the right
 *  file from a row index at draw time. */
export function toSprite(raw: any): Sprite | undefined {
  const filename = raw?.filename ?? raw?.filenames?.[0];
  if (!filename) return undefined;
  const w = raw.width ?? raw.size;
  const h = raw.height ?? raw.size;
  if (typeof w !== "number" || typeof h !== "number") return undefined;
  // line_length is the row width where a grid wraps; otherwise the frame or
  // variation count is the whole row. direction_count only counts as columns
  // when it is the sheet's only axis (poles), not when it indexes rows
  // alongside an animation (belts).
  const columns =
    raw.line_length ??
    raw.frame_count ??
    raw.frames ??
    raw.variation_count ??
    raw.direction_count ??
    1;
  const multiFile = Array.isArray(raw.filenames) && raw.filenames.length > 1 && typeof raw.lines_per_file === "number";
  return {
    sheet: filename,
    frameWidth: w,
    frameHeight: h,
    columns: columns > 1 ? columns : undefined,
    x: raw.x || undefined,
    y: raw.y || undefined,
    shift: raw.shift,
    scale: raw.scale ?? 1,
    sheets: multiFile ? raw.filenames : undefined,
    rowsPerSheet: multiFile ? raw.lines_per_file : undefined,
  };
}

export interface UnwrappedLayer {
  sprite: Sprite;
  shadow: boolean;
  /** Columns of this layer's own grid, which the layer's frame axes index. */
  columns: number;
  /** True when those columns are facings rather than animation frames. */
  directionIndexed: boolean;
  /** True when direction AND a real animation are both packed into this
   *  one grid — direction as rows, the animation's own frames as columns
   *  (e.g. rocket-turret/tesla-turret's own raising sheet: direction_count
   *  4 rows of a genuine 18-frame raise animation each). Mutually
   *  exclusive with directionIndexed (that's the "columns ARE the
   *  direction, no separate animation" case); this is "columns are a real
   *  animation, direction is the row instead". */
  directionInRows: boolean;
}

/** Unwraps the nesting Factorio puts around sprite declarations into every
 *  layer it holds, in declaration order. Machines are routinely built from
 *  several — a centrifuge is three towers, each with its own shadow. */
export function unwrapAll(source: any): UnwrappedLayer[] {
  if (!source) return [];

  const raw: any[] | undefined =
    source.layers ?? source.sheets ?? (source.filename || source.filenames ? [source] : undefined);

  if (!raw) {
    if (source.north) return unwrapAll(source.north);
    if (source.animation) return unwrapAll(source.animation);
    if (source.picture) return unwrapAll(source.picture);
    if (source.single) return unwrapAll(source.single);
    if (source.base_visualisation) {
      const bv = Array.isArray(source.base_visualisation) ? source.base_visualisation[0] : source.base_visualisation;
      return unwrapAll(bv?.animation);
    }
    if (source.structure) return unwrapAll(source.structure);
    return [];
  }

  const out: UnwrappedLayer[] = [];
  for (const layer of raw) {
    // Tint masks recolour the layer beneath by force, which this renderer
    // has no concept of; drawn plainly they cover it with a flat silhouette.
    // Glow/additive layers are near-black outside their lit pixels, meant
    // for a blend mode this renderer doesn't implement — drawn with normal
    // alpha compositing they paint a black box over whatever's beneath.
    if (layer.apply_runtime_tint || layer.flags?.includes("mask") || layer.draw_as_glow || layer.draw_as_light || layer.blend_mode === "additive") continue;
    const sprite = toSprite(layer);
    if (!sprite) continue;
    out.push({
      sprite,
      shadow: layer.draw_as_shadow === true,
      columns: sprite.columns ?? 1,
      directionIndexed: isDirectionIndexed(layer),
      directionInRows: isDirectionInRows(layer),
    });
  }
  return out;
}

/** The first main sprite and its shadow, for callers that only want one pair. */
export function unwrap(source: any): { main?: Sprite; shadow?: Sprite } {
  const layers = unwrapAll(source);
  return {
    main: layers.find((l) => !l.shadow)?.sprite ?? layers[0]?.sprite,
    shadow: layers.find((l) => l.shadow)?.sprite,
  };
}

/** True when a sheet's columns are facings rather than animation frames —
 *  only when `line_length` is genuinely absent, meaning every direction's
 *  frame sits side by side in one single row (small-electric-pole: just
 *  direction_count, no line_length/frame_count at all). The moment
 *  `line_length` is present at all — even as an explicit 1 — Factorio is
 *  telling you the row wraps at that width, so direction overflows into
 *  ROWS instead; see isDirectionInRows, which owns every one of those
 *  cases instead (gun-turret's raising sheet: direction_count 4,
 *  line_length 1 → 4 rows of 1 column each, not 4 columns). */
export function isDirectionIndexed(raw: any): boolean {
  return (raw?.direction_count ?? 1) > 1 && raw?.line_length === undefined && (raw?.frame_count ?? 1) <= 1;
}

/** True when direction is packed into ROWS instead of columns — whenever
 *  `line_length` is explicitly declared alongside a real direction_count,
 *  regardless of frame_count (1, meaning no separate animation on top —
 *  gun-turret/laser-turret's raising sheet — or >1, a genuine multi-frame
 *  animation per direction — rocket-turret/tesla-turret's own). A
 *  blueprint shows the idle pose (frame 0 of whichever direction row), so
 *  this only needs to pick the right ROW; see UnwrappedLayer's own doc
 *  comment. */
export function isDirectionInRows(raw: any): boolean {
  return (raw?.direction_count ?? 1) > 1 && raw?.line_length !== undefined;
}

/** The common case: a main sprite plus optional shadow, both fixed. */
export function staticGraphics(source: any): EntityGraphics | undefined {
  const { main, shadow } = unwrap(source);
  if (!main) return undefined;
  return { layers: withShadow({ layer: Layer.Object, sprites: main }, shadow) };
}

const DIR4 = ["north", "east", "south", "west"] as const;
const DIR8 = ["north", "north_east", "east", "south_east", "south", "south_west", "west", "north_west"] as const;
// Factorio's own raw prototype keys (underscored) -> this codebase's
// Dir8Name convention (no underscore, matching packages/engine/src/types.ts
// and neighbours/grid.ts's dir8Name()) — output sprite objects must be
// keyed the way dir8Name() looks them up at draw time, or every diagonal
// facing silently finds nothing (confirmed: railgun-turret's 4 diagonals
// rendered blank because this mapping was missing — DIR8 fed the raw
// underscored key straight into the sprite record instead).
const DIR8_OUTPUT_NAME: Record<(typeof DIR8)[number], string> = {
  north: "north",
  north_east: "northeast",
  east: "east",
  south_east: "southeast",
  south: "south",
  south_west: "southwest",
  west: "west",
  north_west: "northwest",
};

/** Finds the {north,east,south,west[,north_east,...]} wrapper holding a
 *  whole sprite per facing, which may sit a level or two inside the field
 *  an entity names — an asteroid collector's is under graphics_set.animation,
 *  a turret's own rotating base under
 *  graphics_set.base_visualisation.animation. Prefers a full DIR8 match
 *  (railgun-turret's own folded_animation/preparing_animation/etc ship all
 *  8) over DIR4 so the 4 diagonal facings' own real art gets used instead
 *  of silently dropped — only entities that genuinely have no diagonal art
 *  fall back to the DIR4-only object. */
function perDirectionSource(source: any): any {
  if (!source || typeof source !== "object") return undefined;
  if (DIR8.every((d) => source[d] !== undefined)) return source;
  if (DIR4.every((d) => source[d] !== undefined)) return source;
  for (const key of ["animation", "idle_animation", "picture", "pictures", "structure"]) {
    const found = perDirectionSource(source[key]);
    if (found) return found;
  }
  if (source.base_visualisation) {
    const bv = Array.isArray(source.base_visualisation) ? source.base_visualisation[0] : source.base_visualisation;
    return perDirectionSource(bv?.animation);
  }
  return undefined;
}

/** Stacks several art sources bottom to top, for entities whose pieces live
 *  under separate fields — a turret's base and its gun, a train stop's rail
 *  overlay, post and sign.
 *
 *  Declaration order alone doesn't actually guarantee that stacking: the
 *  renderer's paint order is layer tier first, then each sprite's own
 *  y-shift, and only THEN array position (compareDrawCommands in
 *  draw/commands.ts), so a later source can still lose to an earlier one at
 *  the same Object tier if its shift happens to be smaller — confirmed by
 *  hand in the layer-order debug tool (#/layer-debug): gun-turret's base
 *  was covering its own raising gun piece. `promoteLaterSources` opts a
 *  caller into guaranteeing the intended order: every non-shadow layer from
 *  the second source onward is promoted to Layer.AboveObject. Off by
 *  default (train-stop/artillery-turret's own multi-source stacking hasn't
 *  been confirmed to need it) — turned on for the ammo/electric/fluid-
 *  turret family, whose folded_animation gun piece must always sit above
 *  its graphics_set base. */
export function stackSources(sources: any[], promoteLaterSources = false): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  sources.forEach((source, i) => {
    const part = directionColumnGraphics(source);
    if (!part) return;
    for (const layer of part.layers) {
      if (promoteLaterSources && i > 0 && layer.layer !== Layer.Shadow) layers.push({ ...layer, layer: Layer.AboveObject });
      else layers.push(layer);
    }
  });
  return layers.length > 0 ? { layers } : undefined;
}

/** An entity's art, however its facings are expressed: one sheet with facing
 *  columns, one whole sheet per facing, or neither. Every layer the source
 *  declares is kept — machines are routinely built from several.
 *
 *  Animation frames are never cycled: a blueprint shows idle buildings, so
 *  each layer holds frame 0, the pose the game's own ghost preview uses. */
export function directionColumnGraphics(source: any): EntityGraphics | undefined {
  const perDir = perDirectionSource(source);
  if (perDir) {
    const dirs: readonly string[] = DIR8.every((d) => perDir[d] !== undefined) ? DIR8 : DIR4;
    // Zip each facing's own layer list into shared slots — but by ROLE
    // (shadow vs. object) first, then by position within that role, not by
    // raw position across the whole list. A facing's own layer count/order
    // isn't guaranteed to match its siblings' (confirmed by spike: vanilla
    // electric-mining-drill's south animation has its shadow at a different
    // index than north/east/west, and electromagnetic-plant's top layer is
    // absent on some facings) — zipping by raw index there silently swaps a
    // shadow into an object slot (or vice versa) for the facing whose layer
    // order differs, producing an opaque shadow-shaped sprite or a missing
    // top layer instead of the real art.
    const shadowSlots: { sprites: Record<string, Sprite> }[] = [];
    const objectSlots: { sprites: Record<string, Sprite> }[] = [];
    for (const d of dirs) {
      const layers = unwrapAll(perDir[d]);
      if (layers.length === 0) return undefined;
      let shadowI = 0;
      let objectI = 0;
      const outputKey = dirs === DIR8 ? DIR8_OUTPUT_NAME[d as (typeof DIR8)[number]] : d;
      for (const l of layers) {
        const slots = l.shadow ? shadowSlots : objectSlots;
        const i = l.shadow ? shadowI++ : objectI++;
        const slot = (slots[i] ??= { sprites: {} });
        slot.sprites[outputKey] = l.sprite;
      }
    }
    // A slot doesn't need every facing filled in — electric-mining-drill's
    // small "output" decal layer is only absent for south, not missing
    // entirely — so a slot with at least one facing survives, and
    // spriteFor()/collectEntity() skip drawing it for a facing whose own
    // entry is absent rather than treating that as no art at all.
    const all = [
      ...shadowSlots.map((slot) => ({ ...slot, shadow: true })),
      ...objectSlots.map((slot) => ({ ...slot, shadow: false })),
    ];
    if (all.length === 0) return undefined;
    const per = dirs === DIR8 ? ("dir8" as const) : ("dir4" as const);
    return {
      layers: all.map((slot) => ({
        layer: slot.shadow ? Layer.Shadow : Layer.Object,
        sprites: slot.sprites,
        per,
      })),
    };
  }

  const unwrapped = unwrapAll(source);
  if (unwrapped.length === 0) return undefined;
  return {
    layers: unwrapped.map((l) => ({
      layer: l.shadow ? Layer.Shadow : Layer.Object,
      sprites: l.sprite,
      column: l.directionIndexed ? ({ by: "direction" } as const) : ({ by: "none" } as const),
      // directionInRows: direction is the ROW (4 rows), the sheet's own
      // real animation is the column — a blueprint's idle pose is frame 0
      // of whichever row, so column stays unset (defaults to 0) and only
      // row needs to pick the facing.
      row: l.directionInRows ? ({ by: "direction" } as const) : undefined,
    })),
  };
}

export function withShadow(main: GraphicsLayer, shadow: Sprite | undefined): GraphicsLayer[] {
  return shadow ? [{ layer: Layer.Shadow, sprites: shadow }, main] : [main];
}

/** Factorio's render_layer names, mapped onto the passes this renderer
 *  paints. Names it doesn't distinguish fall back to Object. */
const RENDER_LAYERS: Record<string, Layer> = {
  floor: Layer.Floor,
  "floor-mechanics": Layer.LowerObject,
  "ground-patch": Layer.Floor,
  "lower-object": Layer.LowerObject,
  "lower-object-above-shadow": Layer.LowerObject,
  "lower-object-overlay": Layer.LowerObject,
  "transport-belt-endings": Layer.LowerObject,
  "transport-belt-reader": Layer.Object,
  object: Layer.Object,
  "object-under": Layer.LowerObject,
  "higher-object-under": Layer.Object,
  "higher-object-above": Layer.AboveObject,
  "air-object": Layer.AboveObject,
  wires: Layer.AboveObject,
};

export function layerOf(renderLayer: string | undefined, fallback = Layer.Object): Layer {
  return (renderLayer ? RENDER_LAYERS[renderLayer] : undefined) ?? fallback;
}

/** Stacks the always-visible entries of an animation_list (or a
 *  working_visualisations list, same shape), honouring each entry's own
 *  render_layer. A `fadeout` entry is a transient running-state effect
 *  (steam, exhaust) with no `always_draw` of its own — skipped along with
 *  any entry explicitly marked always_draw: false, since a blueprint shows
 *  entities idle. */
export function animationListGraphics(list: any[] | undefined): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const entry of list ?? []) {
    if (entry.always_draw === false || entry.fadeout) continue;
    const { main, shadow } = unwrap(entry.animation ?? entry);
    if (!main) continue;
    if (shadow) layers.push({ layer: Layer.Shadow, sprites: shadow });
    layers.push({ layer: layerOf(entry.render_layer), sprites: main });
  }
  return layers.length > 0 ? { layers } : undefined;
}

/** A belt's sheet holds every connection shape as one of 20 rows; the column
 *  is the animation frame. */
export function beltGraphics(animationSet: any): EntityGraphics | undefined {
  const sprite = toSprite(animationSet?.animation_set);
  if (!sprite) return undefined;
  return {
    connector: "belt",
    layers: [
      {
        layer: Layer.LowerObject,
        sprites: sprite,
        column: { by: "animation" },
        row: { by: "connection" },
      },
    ],
  };
}

const DIR4_BY_VALUE: Record<number, Dir4Name> = { 0: "north", 4: "east", 8: "south", 12: "west" };

/** Every fluid box a prototype declares, single or several (a chemical plant
 *  has one `fluid_box`; a barrel-filling machine or turret can have several
 *  under `fluid_boxes`) — flattened together since rendering never needs to
 *  know which box a connection point belongs to. */
function fluidBoxesOf(proto: any): any[] {
  const boxes: any[] = [];
  if (proto.fluid_box) boxes.push(proto.fluid_box);
  if (Array.isArray(proto.fluid_boxes)) boxes.push(...proto.fluid_boxes.filter((b: any) => b && typeof b === "object"));
  // boiler/heat-exchanger split their water input and steam output into two
  // separate named boxes instead of one shared fluid_box/fluid_boxes — the
  // output socket (boiler's north-facing steam connection) is otherwise
  // silently dropped, leaving its pipe-cover patch permanently undrawn.
  if (proto.input_fluid_box) boxes.push(proto.input_fluid_box);
  if (proto.output_fluid_box) boxes.push(proto.output_fluid_box);
  return boxes;
}

/** Every fluid-box connection point a prototype declares, in its own
 *  unrotated (north-facing) local frame — straight off Factorio's own
 *  `pipe_connections` position/direction pairs, which is exactly the frame
 *  the fluid network graph's own rotation-by-placement-direction expects. */
export function pipeConnectionsOf(proto: any): PipeConnectionPoint[] {
  const out: PipeConnectionPoint[] = [];
  const boxes = fluidBoxesOf(proto);
  // Only tagged when there's more than one box to disambiguate — a plain
  // pump/boiler/etc's single box needs no index, and every point already
  // gets the box's own production_type either way.
  const multiBox = boxes.length > 1;
  const boxesOffWhenNoFluidRecipe = proto.fluid_boxes_off_when_no_fluid_recipe === true;
  boxes.forEach((box, boxIndex) => {
    for (const c of box.pipe_connections ?? []) {
      // A pipe-to-ground's second entry is its underground link to the
      // paired piece, not a normal surface socket — it has no matching
      // world-space neighbour to ever connect to and no cover art of its
      // own, so counting it here would leave it permanently "unconnected"
      // for no visual reason. Matches the reference renderer's own filter
      // (only undefined/'normal' connection_type counts).
      if (c.connection_type !== undefined && c.connection_type !== "normal") continue;
      const direction = DIR4_BY_VALUE[c.direction ?? 0];
      if (!direction) continue;
      const fluidboxIndex = multiBox ? boxIndex : undefined;
      const flowDirection = box.production_type;
      // Pumpjack's own output socket declares `positions` (plural, one
      // [x,y] per placement direction) instead of a single `position` —
      // see PipeConnectionPoint's own doc comment for why. x/y here are
      // meaningless in that case (no single north-frame point exists) and
      // ignored downstream whenever positionsByDirection is present.
      if (Array.isArray(c.positions) && c.positions.length === 4) {
        out.push({ x: c.positions[0][0], y: c.positions[0][1], direction: c.direction, positionsByDirection: c.positions, fluidboxIndex, flowDirection, boxesOffWhenNoFluidRecipe });
        continue;
      }
      if (!Array.isArray(c.position)) continue;
      out.push({ x: c.position[0], y: c.position[1], direction: c.direction, fluidboxIndex, flowDirection, boxesOffWhenNoFluidRecipe });
    }
  });
  return out;
}

/** `per: "pipe-covers"` layers from a fluid box's own `pipe_covers` field —
 *  the small end-cap Factorio draws over a fluid connection point that isn't
 *  actually plugged into anything, so an unconnected pipe socket doesn't
 *  show as a bare hole. One sprite per cardinal facing per layer, reused at
 *  every unconnected point sharing that facing (collect.ts draws one copy
 *  per point, not per layer) — shadow and main split into their own layers
 *  the same way every other multi-layer piece in this file is, so the
 *  shadow still paints in its own Shadow-tier pass. Every fluid-box-bearing
 *  prototype in the dump ships the same four
 *  `pipe_covers.{north,east,south,west}` shape, so this takes the first box
 *  that has one rather than merging across boxes. */
const NEVER_COVERED = new Set(["pipe", "infinity-pipe"]);

export function pipeCoversLayers(proto: any): GraphicsLayer[] {
  // A plain pipe's own ending_up/ending_down/etc. variant sprite (picked by
  // classifyPipe from its neighbours) already draws a closed, capped end —
  // confirmed against the reference renderer's own generateCovers, which
  // explicitly skips 'pipe' and 'infinity-pipe' for exactly this reason.
  // Attaching the generic cover here too would double-cap every open end,
  // including ends that already look correct, and — since a plain pipe's
  // own connection points sit at local (0,0) rather than offset toward each
  // side — would draw a cover on literally every side of every pipe tile
  // regardless of neighbours.
  if (NEVER_COVERED.has(proto.name)) return [];
  const covers = fluidBoxesOf(proto).find((b) => b.pipe_covers)?.pipe_covers;
  if (!covers) return [];
  const sprites: Partial<Record<Dir4Name, Sprite>> = {};
  const shadowSprites: Partial<Record<Dir4Name, Sprite>> = {};
  for (const dir of ["north", "east", "south", "west"] as const) {
    const { main, shadow } = unwrap(covers[dir]);
    if (main) sprites[dir] = main;
    if (shadow) shadowSprites[dir] = shadow;
  }
  const layers: GraphicsLayer[] = [];
  if (Object.keys(shadowSprites).length > 0) layers.push({ layer: Layer.Shadow, sprites: shadowSprites, per: "pipe-covers" });
  if (Object.keys(sprites).length > 0) layers.push({ layer: Layer.Object, sprites, per: "pipe-covers" });
  return layers;
}

/** Every heat-network connection point a prototype declares, in its own
 *  unrotated (north-facing) local frame — straight off Factorio's own
 *  position/direction pairs, same shape as `pipeConnectionsOf` but for the
 *  separate heat network (a heat pipe never carries fluid and vice versa).
 *
 *  Checks TWO different fields, because Factorio splits "has a heat
 *  network connection" across two unrelated prototype shapes depending on
 *  whether the entity produces or consumes heat: a heat producer/buffer
 *  (reactor, heat-pipe itself) declares `heat_buffer.connections`, while a
 *  heat CONSUMER (heat-exchanger; confirmed by spike to be the only
 *  placeable entity of this kind) instead has an `energy_source` of
 *  `type: "heat"` whose own `connections` field is shaped identically.
 *  Reading only `heat_buffer` (as this function used to) left the
 *  heat-exchanger with zero recorded connection points — not just missing
 *  patch art, but invisible to the heat network's adjacency graph
 *  entirely. A reactor's own connection-patch art is indexed by this exact
 *  array order (confirmed against the reference renderer's draw_reactor,
 *  which zips `heat_buffer.connections.entries()` 1:1 against
 *  `connection_patches_*`'s variation index) — energy_source.connections
 *  is never indexed that way (heat-covers keys by direction instead, see
 *  heatCoversOf), so mixing the two sources here is safe either way. */
export function heatConnectionsOf(proto: any): HeatConnectionPoint[] {
  const out: HeatConnectionPoint[] = [];
  const source = proto.heat_buffer?.connections ?? proto.energy_source?.connections ?? [];
  for (const c of source) {
    if (!Array.isArray(c.position) || typeof c.direction !== "number") continue;
    out.push({ x: c.position[0], y: c.position[1], direction: c.direction });
  }
  return out;
}

/** `per: "heat-covers"` layer from `energy_source.pipe_covers` — a heat
 *  CONSUMER's own small stub-cap sprite (confirmed by spike: heat-exchanger
 *  is the only placeable entity with this field), one per cardinal
 *  direction, shaped identically to a fluid box's own `pipe_covers` (see
 *  pipeCoversLayers) but drawn the opposite way round: fluid pipe-covers
 *  patch a gap that shows only when nothing is connected there (the
 *  connected neighbour's own art already closes that side); a heat
 *  consumer's plain idle sprite has no such closing art at all, so this
 *  cap is the thing that closes the gap, and only needs to appear once a
 *  heat pipe is actually plugged in there — reported live as a missing
 *  patch at the heat-exchanger's own heat-pipe connection. A reactor
 *  (heat_buffer, not energy_source) has no `pipe_covers` field and so
 *  never produces this layer — its own gap-filling is
 *  heat-connection-patches' `connected`/`disconnected` full sprite sets
 *  instead, a different shape for a different (always-drawn) case. */
export function heatCoversOf(proto: any): GraphicsLayer[] {
  const covers = proto.energy_source?.pipe_covers;
  if (!covers) return [];
  const sprites: Partial<Record<Dir4Name, Sprite>> = {};
  for (const dir of ["north", "east", "south", "west"] as const) {
    const sprite = toSprite(covers[dir]);
    if (sprite) sprites[dir] = sprite;
  }
  if (Object.keys(sprites).length === 0) return [];
  return [{ layer: Layer.Object, sprites, per: "heat-covers" }];
}

/** Where each colour of wire physically attaches to an entity's sprite, per
 *  facing — Factorio's own `connection_points` (a pole) or
 *  `circuit_wire_connection_points` (a combinator, constant combinator and
 *  friends), in tiles relative to the entity's centre.
 *
 *  Only the `wire` half is read, never `shadow`: the shadow offsets place a
 *  wire's shadow on the ground, which this renderer has no concept of (it
 *  draws no wire shadows), and using them for the wire itself would attach
 *  every wire to the base of the pole rather than its top.
 *
 *  A prototype declares one entry per 4-way facing; index is `direction / 4`.
 *  A power switch is the exception — it carries single, unindexed
 *  `left_wire_connection_point`/`right_wire_connection_point` objects — and
 *  is handled by repeating that one point across all four facings, so the
 *  consumer can index by facing uniformly. */
export function wireConnectionsOf(proto: any): WireAttachPoints | undefined {
  const read = (point: any): WireAttachPoint | undefined => {
    const wire = point?.wire;
    if (!wire) return undefined;
    const xy = (v: any): [number, number] | undefined =>
      Array.isArray(v) && v.length >= 2 ? [v[0], v[1]] : undefined;
    const copper = xy(wire.copper);
    const red = xy(wire.red);
    const green = xy(wire.green);
    if (!copper && !red && !green) return undefined;
    return { copper, red, green };
  };

  // A power switch's two copper terminals are single points shared by every
  // facing (the prototype has no per-direction array for them).
  if (proto.left_wire_connection_point || proto.right_wire_connection_point) {
    const left = read(proto.left_wire_connection_point);
    const right = read(proto.right_wire_connection_point);
    const circuit = read(proto.circuit_wire_connection_point);
    if (!left && !right && !circuit) return undefined;
    const merged: WireAttachPoint = {
      copper: left?.copper,
      red: circuit?.red,
      green: circuit?.green,
    };
    return { byDirection: [merged, merged, merged, merged], secondCopper: right?.copper };
  }

  // A combinator names its input side `input_connection_points`; a pole uses
  // `connection_points`; everything else circuit-wired uses
  // `circuit_wire_connection_points`.
  const source =
    proto.connection_points ?? proto.input_connection_points ?? proto.circuit_wire_connection_points;
  if (!Array.isArray(source) || source.length === 0) return undefined;
  const byDirection: (WireAttachPoint | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    // Some prototypes ship a single point rather than all four (a
    // non-rotatable entity); reuse index 0 for the facings it omits.
    byDirection.push(read(source[i]) ?? read(source[0]));
  }
  if (byDirection.every((p) => p === undefined)) return undefined;
  return { byDirection };
}

/** A combinator's output-side connection points, which sit at a different
 *  place on its sprite than its input side. Undefined for everything else. */
export function outputWireConnectionsOf(proto: any): WireAttachPoints | undefined {
  const source = proto.output_connection_points;
  if (!Array.isArray(source) || source.length === 0) return undefined;
  return wireConnectionsOf({ connection_points: source });
}

/** Splits a `variation_count`-grid sprite (one shared sheet, one frame per
 *  heat-connection point) into a flat per-index Sprite array, each pinned to
 *  its own column via `x` — matching the reference renderer's own
 *  `duplicateAndSetPropertyUsing(sheet, 'x', 'width', i)`. */
function splitVariations(sprite: Sprite, count: number): Sprite[] {
  const out: Sprite[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ ...sprite, x: (sprite.x ?? 0) + i * sprite.frameWidth, columns: undefined });
  }
  return out;
}

/** `per: "heat-connection-patches"` layer from a reactor's own
 *  `connection_patches_connected`/`connection_patches_disconnected` fields —
 *  the small pipe-stub cap Factorio draws at every one of its 12 fixed
 *  `heat_buffer.connections` points, switching sprite set depending on
 *  whether a heat pipe is actually adjacent there. Uses the plain (non-
 *  `heat_`-prefixed) fields deliberately: those carry the glow/tint overlay
 *  layers meant for a running reactor's "heated" pose, which this renderer
 *  has no concept of (see unwrapAll's draw_as_light filter) — the plain
 *  fields are the idle-pose art, matching `picture` (not `heat_picture`)
 *  being what render-catalog.ts already draws for the reactor's own body. */
export function heatConnectionPatchLayers(proto: any): GraphicsLayer[] {
  const connections = heatConnectionsOf(proto);
  if (connections.length === 0) return [];
  const connectedRaw = proto.connection_patches_connected?.sheet;
  const disconnectedRaw = proto.connection_patches_disconnected?.sheet;
  const connectedSprite = toSprite(Array.isArray(connectedRaw) ? connectedRaw[0] : connectedRaw);
  const disconnectedSprite = toSprite(Array.isArray(disconnectedRaw) ? disconnectedRaw[0] : disconnectedRaw);
  if (!connectedSprite || !disconnectedSprite) return [];
  const count = connections.length;
  return [
    {
      layer: Layer.Object,
      per: "heat-connection-patches",
      connected: splitVariations(connectedSprite, count),
      disconnected: splitVariations(disconnectedSprite, count),
    },
  ];
}

/** Every sheet an entity's graphics reference, for the sprite extractor —
 *  every file in Sprite.sheets too, for a sprite split across several (see
 *  toSprite's own doc comment), not just its fallback single `sheet`. */
export function sheetsOf(graphics: EntityGraphics | undefined): string[] {
  const out: string[] = [];
  const collect = (s: Sprite) => (s.sheets ? out.push(...s.sheets) : out.push(s.sheet));
  for (const layer of graphics?.layers ?? []) {
    if (!("per" in layer)) {
      collect(layer.sprites);
    } else if (layer.per === "heat-connection-patches") {
      layer.connected.forEach(collect);
      layer.disconnected.forEach(collect);
    } else if (layer.per === "module-slot") {
      for (const slot of layer.slots) {
        collect(slot.empty);
        slot.filled.forEach(collect);
      }
    } else {
      Object.values(layer.sprites).forEach(collect);
    }
  }
  return out;
}

/** Builds a Record keyed by direction name from a per-direction wrapper. */
export function perDirection<K extends string>(
  source: any,
  keys: readonly K[],
  pick: (raw: any) => any = (r) => r,
): Record<K, Sprite> | undefined {
  const out = {} as Record<K, Sprite>;
  for (const key of keys) {
    const sprite = toSprite(pick(source?.[key]));
    if (!sprite) return undefined;
    out[key] = sprite;
  }
  return out;
}
