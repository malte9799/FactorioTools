/** Persistent sprite storage on top of the Cache Storage API.
 *
 *  GitHub Pages serves every file with `cache-control: max-age=600` and
 *  offers no way to change that, and Safari in particular evicts large
 *  entries from its HTTP cache aggressively — so the ~100MB of sprite sheets
 *  were re-downloaded on nearly every visit. Cache Storage is ours to manage:
 *  entries stay until we delete them (or the browser clears site data).
 *
 *  Invalidation is by content: the site build hashes public/data/sprites and
 *  injects it as __SPRITE_VERSION__ (see apps/site/vite.config.ts). A new
 *  hash opens a fresh cache and deletes the old ones, so a deploy that
 *  doesn't touch sprites keeps everything cached, and one that does never
 *  serves stale art. Undefined in dev and in tests, where caching is skipped
 *  so freshly re-extracted sprites show up on reload. */

declare const __SPRITE_VERSION__: string | undefined;

const CACHE_PREFIX = "factoriotools-sprites-";

let cachePromise: Promise<Cache | undefined> | undefined;

function openCache(): Promise<Cache | undefined> {
  if (!cachePromise) {
    const version = typeof __SPRITE_VERSION__ === "string" ? __SPRITE_VERSION__ : undefined;
    // `caches` only exists in secure contexts (https, localhost).
    if (!version || typeof caches === "undefined") {
      cachePromise = Promise.resolve(undefined);
    } else {
      const name = CACHE_PREFIX + version;
      cachePromise = (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => caches.delete(k)));
        // Best-effort: asks the browser not to evict this origin's storage
        // under pressure. Browsers may ignore or deny it; nothing depends on it.
        navigator.storage?.persist?.().catch(() => {});
        return caches.open(name);
      })().catch((err) => {
        console.warn(`sprite cache unavailable: ${err?.message ?? err}`);
        return undefined;
      });
    }
  }
  return cachePromise;
}

/** Fetches a sprite as a Blob, serving it from the persistent cache when
 *  present and storing it there otherwise. Falls back to a plain fetch
 *  whenever Cache Storage is missing or fails (quota, private mode). */
export async function fetchSprite(url: string): Promise<Blob> {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined);
    if (hit) return hit.blob();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sprite failed to load: ${url} (${res.status})`);
  // Not awaited: storing is a side effect, the caller only needs the pixels.
  cache?.put(url, res.clone()).catch(() => {});
  return res.blob();
}
