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

/** Unwraps the nesting Factorio puts around sprite declarations, returning the
 *  main sprite and its shadow if one is declared alongside. */
export function unwrap(source: any): { main?: Sprite; shadow?: Sprite } {
  if (!source) return {};

  const layers: any[] | undefined =
    source.layers ?? source.sheets ?? (source.filename || source.filenames ? [source] : undefined);

  if (!layers) {
    if (source.north) return unwrap(source.north);
    if (source.animation) return unwrap(source.animation);
    if (source.picture) return unwrap(source.picture);
    if (source.single) return unwrap(source.single);
    if (source.base_visualisation) {
      const bv = Array.isArray(source.base_visualisation) ? source.base_visualisation[0] : source.base_visualisation;
      return unwrap(bv?.animation);
    }
    if (source.structure) return unwrap(source.structure);
    return {};
  }

  return {
    main: toSprite(layers.find((l) => !l.draw_as_shadow) ?? layers[0]),
    shadow: toSprite(layers.find((l) => l.draw_as_shadow)),
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

/** True for a {north,east,south,west} wrapper holding a whole sprite each,
 *  rather than one sheet with facings as columns. */
function isPerDirection(source: any): boolean {
  return DIR4.every((d) => source?.[d] !== undefined);
}

/** An entity's main art plus shadow, however its facings are expressed: one
 *  sheet with facing columns, one whole sheet per facing, or neither.
 *  `animated` chooses what a multi-column sheet's columns mean when the data
 *  itself is ambiguous. */
export function directionColumnGraphics(source: any, animated = false): EntityGraphics | undefined {
  if (isPerDirection(source)) {
    const mains = {} as Record<(typeof DIR4)[number], Sprite>;
    const shadows = {} as Record<(typeof DIR4)[number], Sprite>;
    let anyShadow = false;
    for (const d of DIR4) {
      const { main, shadow } = unwrap(source[d]);
      if (!main) return undefined;
      mains[d] = main;
      shadows[d] = shadow ?? main;
      if (shadow) anyShadow = true;
    }
    const column: GraphicsLayer["column"] = animated ? { by: "animation" } : { by: "none" };
    const layers: GraphicsLayer[] = [];
    if (anyShadow) layers.push({ layer: Layer.Shadow, sprites: shadows, per: "dir4" });
    layers.push({ layer: Layer.Object, sprites: mains, per: "dir4", column });
    return { layers };
  }

  const { main, shadow } = unwrap(source);
  if (!main) return undefined;
  const raw = source?.layers?.[0] ?? source;
  const column: GraphicsLayer["column"] = isDirectionIndexed(raw)
    ? { by: "direction" }
    : animated && (main.columns ?? 1) > 1
      ? { by: "animation" }
      : { by: "none" };
  return { layers: withShadow({ layer: Layer.Object, sprites: main, column }, shadow) };
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
