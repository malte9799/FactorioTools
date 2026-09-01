/** Loads the entity sprite sheets extracted by
 *  packages/data-pipeline/src/extract-sprites.ts into `<img>` elements the
 *  canvas renderer can `drawImage` from directly — one real Factorio
 *  spritesheet per entity, not a single packed atlas (unlike the icon
 *  sheet), since these are already large multi-frame sheets on their own. */

const ENTITY_SPRITE_BASE = "/data/sprites/entities/";

/** Mirrors dump-to-gamedata.ts's mod-path convention: a GameData/RenderCatalog
 *  `graphics.sheet` value looks like "__base__/graphics/entity/foo/foo.png".
 *  The extracted copy on the site keeps only the basename. */
function sheetUrl(modPath: string): string {
  const basename = modPath.split("/").pop();
  return ENTITY_SPRITE_BASE + basename;
}

export class SpriteAtlas {
  // Keyed by the raw modPath (e.g. "__base__/graphics/entity/foo/foo.png"),
  // not the derived local URL — get() is called for every visible entity
  // every frame, so resolving sheetUrl()'s string split/concat on every
  // call (only ever needed once per sheet, at first load) would be wasted
  // work in the hot path.
  private images = new Map<string, HTMLImageElement>();
  private loading = new Map<string, Promise<HTMLImageElement>>();

  /** Returns the image if already loaded (synchronous, for the draw loop);
   *  triggers a load in the background otherwise so a later frame picks it
   *  up once ready. Never throws — a missing/broken sheet just means that
   *  entity draws as its outline fallback, mirroring the calc engine's
   *  graceful-degradation philosophy for unrecognised entities. */
  get(modPath: string): HTMLImageElement | undefined {
    const existing = this.images.get(modPath);
    if (existing) return existing;
    if (!this.loading.has(modPath)) {
      const url = sheetUrl(modPath);
      const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          this.images.set(modPath, img);
          resolve(img);
        };
        img.onerror = () => reject(new Error(`sprite failed to load: ${url}`));
        img.src = url;
      }).catch((err) => {
        console.warn(err.message);
        throw err;
      });
      this.loading.set(modPath, promise);
    }
    return undefined;
  }

  /** Resolves once every currently-known sheet load settles (success or
   *  failure) — used to trigger one redraw after the initial burst of loads
   *  a freshly-rendered blueprint kicks off, so entities don't stay as
   *  outlines until the next unrelated redraw. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.loading.values()]);
  }
}
