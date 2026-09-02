/** Reading Factorio's sprite declarations, which come in a handful of
 *  historically-grown shapes, into this project's flat Sprite type. */
import { Layer, type EntityGraphics, type GraphicsLayer, type Sprite } from "@factoriotools/engine";

/** A leaf sprite declaration: {filename,width,height,...}. Some use a single
 *  square `size` instead of width/height, some split a long frame strip over
 *  `filenames` (only file 0 holds frame 0, which is all this pipeline draws). */
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
  return {
    sheet: filename,
    frameWidth: w,
    frameHeight: h,
    columns: columns > 1 ? columns : undefined,
    x: raw.x || undefined,
    y: raw.y || undefined,
    shift: raw.shift,
    scale: raw.scale ?? 1,
  };
}

export interface UnwrappedLayer {
  sprite: Sprite;
  shadow: boolean;
  /** Columns of this layer's own grid, which the layer's frame axes index. */
  columns: number;
  /** True when those columns are facings rather than animation frames. */
  directionIndexed: boolean;
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
    if (layer.apply_runtime_tint || layer.flags?.includes("mask")) continue;
    const sprite = toSprite(layer);
    if (!sprite) continue;
    out.push({
      sprite,
      shadow: layer.draw_as_shadow === true,
      columns: sprite.columns ?? 1,
      directionIndexed: isDirectionIndexed(layer),
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

/** True when a sheet's columns are facings rather than animation frames. */
export function isDirectionIndexed(raw: any): boolean {
  return (raw?.direction_count ?? 1) > 1 && !raw?.frame_count && !raw?.line_length;
}

/** The common case: a main sprite plus optional shadow, both fixed. */
export function staticGraphics(source: any): EntityGraphics | undefined {
  const { main, shadow } = unwrap(source);
  if (!main) return undefined;
  return { layers: withShadow({ layer: Layer.Object, sprites: main }, shadow) };
}

const DIR4 = ["north", "east", "south", "west"] as const;

/** Finds the {north,east,south,west} wrapper holding a whole sprite per
 *  facing, which may sit a level or two inside the field an entity names —
 *  an asteroid collector's is under graphics_set.animation. */
function perDirectionSource(source: any): any {
  if (!source || typeof source !== "object") return undefined;
  if (DIR4.every((d) => source[d] !== undefined)) return source;
  for (const key of ["animation", "idle_animation", "picture", "pictures", "structure"]) {
    const found = perDirectionSource(source[key]);
    if (found) return found;
  }
  return undefined;
}

/** Stacks several art sources bottom to top, for entities whose pieces live
 *  under separate fields — a turret's base and its gun, a train stop's rail
 *  overlay, post and sign. */
export function stackSources(sources: any[]): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const source of sources) {
    const part = directionColumnGraphics(source);
    if (part) layers.push(...part.layers);
  }
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
    const perFacing: { sprites: Record<string, Sprite>; shadow: boolean }[] = [];
    for (const d of DIR4) {
      const layers = unwrapAll(perDir[d]);
      if (layers.length === 0) return undefined;
      layers.forEach((l, i) => {
        const slot = (perFacing[i] ??= { sprites: {}, shadow: l.shadow });
        slot.sprites[d] = l.sprite;
      });
    }
    // Facings must agree on how many layers they have, or a slot would be
    // missing art for some directions.
    const complete = perFacing.filter((slot) => DIR4.every((d) => slot.sprites[d]));
    if (complete.length === 0) return undefined;
    return {
      layers: complete.map((slot) => ({
        layer: slot.shadow ? Layer.Shadow : Layer.Object,
        sprites: slot.sprites as Record<(typeof DIR4)[number], Sprite>,
        per: "dir4" as const,
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

/** Stacks the always-visible entries of an animation_list, honouring each
 *  entry's own render_layer. */
export function animationListGraphics(list: any[] | undefined): EntityGraphics | undefined {
  const layers: GraphicsLayer[] = [];
  for (const entry of list ?? []) {
    if (entry.always_draw === false) continue;
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

/** Every sheet an entity's graphics reference, for the sprite extractor. */
export function sheetsOf(graphics: EntityGraphics | undefined): string[] {
  const out: string[] = [];
  for (const layer of graphics?.layers ?? []) {
    if ("per" in layer) out.push(...Object.values(layer.sprites).map((s) => s.sheet));
    else out.push(layer.sprites.sheet);
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
