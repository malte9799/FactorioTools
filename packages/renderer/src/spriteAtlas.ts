/** Loads the entity sprite sheets extracted by
 *  packages/data-pipeline/src/extract-sprites.ts into `<img>` elements the
 *  canvas renderer can `drawImage` from directly — one real Factorio
 *  spritesheet per entity, not a single packed atlas (unlike the icon
 *  sheet), since these are already large multi-frame sheets on their own. */

/** What the draw loop receives for a sheet. An ImageBitmap in every browser
 *  that has createImageBitmap; an <img> only on the fallback path. Both are
 *  valid drawImage sources, so callers never need to tell them apart. */
export type SpriteSurface = ImageBitmap | HTMLImageElement;

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
  // ImageBitmap, not HTMLImageElement: an <img> keeps its pixels in the
  // browser's own compressed form and decodes lazily, and img.decode() only
  // promises it CAN be decoded — the real work still lands on the first
  // drawImage that samples it, on the main thread, mid-frame. A recorded
  // session on a real machine showed exactly that: 42% of 30 seconds spent
  // inside drawImage, with single frames of 1.4-2.0 s, including 108 ms to
  // paint THREE commands. createImageBitmap decodes once, off-thread, and
  // hands back an already-decoded surface that drawImage samples directly.
  private images = new Map<string, SpriteSurface>();
  private loading = new Map<string, Promise<SpriteSurface>>();
  // How many of `loading`'s promises haven't settled yet — used instead of
  // `loading.size` directly so a caller (render.ts's small loading-spinner
  // badge) can tell "actively fetching/decoding right now" apart from
  // "every sheet ever requested this session", which loading.size alone
  // conflates (entries are never removed once settled).
  private pendingCount = 0;
  private onPendingChange: ((pending: number) => void) | null = null;
  // Chrome/Firefox appear to seriously contend when many large (some
  // 10MB+) sheets start decoding in the same tick — a pan/zoom that
  // suddenly reveals dozens of never-before-seen entities at once
  // (confirmed by the user: happens specifically on first reveal, not on
  // cached re-entry) stalls the main thread for the better part of a
  // second in those browsers, while Safari's own decode pipeline handles
  // the same burst without visible hitching. img.decode() is already
  // off the drawImage-blocking path (see get()'s own doc comment) — this
  // caps how many run AT ONCE instead, queuing the rest, so the browser
  // never has more than DECODE_CONCURRENCY sheets competing for decode
  // time simultaneously. Doesn't change total load time much, just
  // spreads the cost so no single frame absorbs all of it.
  private static readonly DECODE_CONCURRENCY = 6;
  private decodeQueue: (() => void)[] = [];
  private activeDecodes = 0;

  private runOrQueueDecode(start: () => void): void {
    if (this.activeDecodes < SpriteAtlas.DECODE_CONCURRENCY) {
      this.activeDecodes++;
      start();
    } else {
      this.decodeQueue.push(start);
    }
  }

  private decodeSettled(): void {
    this.activeDecodes--;
    const next = this.decodeQueue.shift();
    if (next) {
      this.activeDecodes++;
      next();
    }
  }

  /** Subscribes to pendingCount changes — called with the new count every
   *  time a sheet load starts or settles. Only one subscriber at a time
   *  (render.ts's own small loading badge); a second call replaces the
   *  first, matching every other single-callback setter in this
   *  codebase (onHover, onPlace, etc). */
  setOnPendingChange(callback: ((pending: number) => void) | null): void {
    this.onPendingChange = callback;
  }

  /** Returns the image if already loaded (synchronous, for the draw loop);
   *  triggers a load in the background otherwise so a later frame picks it
   *  up once ready. Never throws — a missing/broken sheet just means that
   *  entity draws as its outline fallback, mirroring the calc engine's
   *  graceful-degradation philosophy for unrecognised entities.
   *
   *  Decodes to an ImageBitmap before making the sheet available. An <img>
   *  with img.decode() was not enough: decode() only promises the image CAN
   *  be decoded, and browsers still re-decode at draw resolution on the first
   *  drawImage that samples it — synchronously, mid-frame. An ImageBitmap is
   *  already-decoded pixels, so drawImage just samples them. */
  get(modPath: string): SpriteSurface | undefined {
    const existing = this.images.get(modPath);
    if (existing) return existing;
    if (!this.loading.has(modPath)) {
      const url = sheetUrl(modPath);
      this.pendingCount++;
      this.onPendingChange?.(this.pendingCount);
      const settle = () => {
        this.pendingCount--;
        this.onPendingChange?.(this.pendingCount);
        this.decodeSettled();
      };
      const promise = new Promise<SpriteSurface>((resolve, reject) => {
        this.runOrQueueDecode(() => {
          // fetch + createImageBitmap rather than <img>: this decodes once,
          // on a worker thread, and yields a surface drawImage can sample
          // without decoding again. The <img> fallback below covers browsers
          // without createImageBitmap, where the old lazy-decode behaviour
          // is still better than no sprite at all.
          if (typeof createImageBitmap === "function") {
            fetch(url)
              .then((res) => {
                if (!res.ok) throw new Error(`sprite failed to load: ${url} (${res.status})`);
                return res.blob();
              })
              .then((blob) => createImageBitmap(blob))
              .then((bitmap) => {
                this.images.set(modPath, bitmap);
                resolve(bitmap);
              })
              .catch(reject);
            return;
          }
          const img = new Image();
          img.decoding = "async";
          img.onload = () => {
            (img.decode?.() ?? Promise.resolve()).catch(() => {}).then(() => {
              this.images.set(modPath, img);
              resolve(img);
            });
          };
          img.onerror = () => reject(new Error(`sprite failed to load: ${url}`));
          img.src = url;
        });
      }).catch((err) => {
        console.warn(err.message);
        throw err;
      }).finally(settle);
      this.loading.set(modPath, promise);
    }
    return undefined;
  }

  /** A snapshot of what the atlas is doing right now, for the frame recorder.
   *  A stalled frame that coincides with a non-zero `decoding`/`queued` is a
   *  very different problem from one that stalls with the atlas fully idle,
   *  and without these counters the two are indistinguishable in a log. */
  stats(): { ready: number; pending: number; decoding: number; queued: number } {
    return {
      ready: this.images.size,
      pending: this.pendingCount,
      decoding: this.activeDecodes,
      queued: this.decodeQueue.length,
    };
  }

  /** Resolves once every currently-known sheet load settles (success or
   *  failure) — used to trigger one redraw after the initial burst of loads
   *  a freshly-rendered blueprint kicks off, so entities don't stay as
   *  outlines until the next unrelated redraw. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.loading.values()]);
  }
}

// A blueprint the size of the Debug Lab (one of every entity) touches
// nearly the full ~200MB sprite-sheet set, and decoding that is real CPU
// work independent of the browser's HTTP cache. mountRenderer() used to
// construct a fresh SpriteAtlas per mount, so navigating away from the
// tool and back (or any hashchange remount) re-decoded everything from
// scratch. One module-level instance survives remounts within the same
// page load, so a sheet is only ever ` new Image()`-decoded once per tab.
let sharedAtlas: SpriteAtlas | undefined;

export function getSharedSpriteAtlas(): SpriteAtlas {
  if (!sharedAtlas) sharedAtlas = new SpriteAtlas();
  return sharedAtlas;
}
