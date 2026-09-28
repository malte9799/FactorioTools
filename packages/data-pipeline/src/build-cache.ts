/** Skipping work that a previous run already did.
 *
 *  The pipeline reprocesses 531 sprite sheets on every run, even when a
 *  single extractor function changed. Most of that is pure waste: the source
 *  files in the Factorio install do not move between runs.
 *
 *  The approach is Teoxoy's, from factorio-blueprint-editor's Rust exporter:
 *  record each source file's (size, mtime) alongside the output it produced,
 *  and skip when both still match. Cheap to check — two stat fields, no
 *  hashing — and mtime changes whenever Factorio is updated or a mod is
 *  reinstalled, which is exactly when the output is actually stale.
 *
 *  WHY THE KEY IS THE SOURCE, NOT THE OUTPUT
 *
 *  crop-sprite-sheets rewrites files in `public/` in place, so the output's
 *  own mtime changes every time it is cropped. Keying on that would make
 *  every run think the file had changed. The key is therefore always the
 *  file in the Factorio install, which nothing in this pipeline writes to.
 *
 *  The cache is advisory: deleting it, or any entry, only costs a rebuild.
 *  It is stored next to the generated data.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** (size, mtimeMs) of a source file, plus the outputs it produced. Outputs
 *  are tracked so a deleted output forces a rebuild even when the source is
 *  untouched — otherwise `rm` on a sprite would never be repaired. */
interface Entry {
  size: number;
  mtimeMs: number;
  outputs: string[];
}

export class BuildCache {
  private readonly file: string;
  private readonly previous: Record<string, Entry>;
  private readonly next: Record<string, Entry> = {};
  private hits = 0;
  private misses = 0;

  /** `ignorePrevious` makes every lookup a miss (a --force rebuild) while
   *  still writing fresh stamps on save(), so forcing once does not cost the
   *  next run its cache. */
  constructor(cacheFile: string, options: { ignorePrevious?: boolean } = {}) {
    this.file = cacheFile;
    let loaded: Record<string, Entry> = {};
    try {
      if (!options.ignorePrevious && existsSync(cacheFile)) {
        loaded = JSON.parse(readFileSync(cacheFile, "utf-8")) as Record<string, Entry>;
      }
    } catch {
      // A corrupt or half-written cache is not worth failing the build over;
      // an empty one just means everything rebuilds.
      loaded = {};
    }
    this.previous = loaded;
  }

  /** True when `source` is unchanged since the run that produced `outputs`,
   *  and every one of those outputs is still on disk.
   *
   *  Records the source's current stamp either way, so the caller can call
   *  save() once at the end without tracking anything itself. */
  isFresh(source: string, outputs: string[]): boolean {
    let stat;
    try {
      stat = statSync(source);
    } catch {
      // Source is gone — nothing to record, and the caller's own
      // existence check will report it.
      return false;
    }
    const stamp: Entry = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), outputs };
    this.next[source] = stamp;

    const before = this.previous[source];
    const fresh =
      before !== undefined &&
      before.size === stamp.size &&
      before.mtimeMs === stamp.mtimeMs &&
      outputs.every((out) => existsSync(out));

    if (fresh) this.hits++;
    else this.misses++;
    return fresh;
  }

  /** Drops an entry, forcing a rebuild next run. For a step that failed
   *  after isFresh() already recorded the stamp. */
  invalidate(source: string): void {
    delete this.next[source];
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** Writes the stamps gathered this run. Only entries the run actually
   *  looked at survive, so sources that are no longer referenced fall out of
   *  the cache instead of growing it forever. */
  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.next));
  }
}

/** One line reporting what the cache saved, or nothing when it was a cold
 *  run — a "0 reused" line on a first build is just noise. */
export function reportCache(cache: BuildCache, label: string): void {
  const { hits, misses } = cache.stats;
  if (hits === 0) return;
  console.log(`  ${label}: ${hits} reused, ${misses} rebuilt`);
}
