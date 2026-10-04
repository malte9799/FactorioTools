# FactorioTools audit, October 2026: performance and code simplicity

**Date:** 2026-10-04 · **Base:** `main` at `d7ecd28` · **Scope:** whole repository,
with a focus on runtime performance and code simplicity.
**Method:** every number below was measured, not estimated, unless it says
otherwise. The scripts live in [`scripts/`](scripts/) and run against the real
modules. Each finding names the script that produced it.

This is the follow-up to the September audit (`audit/00-…07-*.md`, in German).
That round's fixes held up, and its status is listed at the end. Since then
the codebase has grown from 15.7k to about 42k lines (rails, circuits, belt
simulation, map generator, editor). Most of the new findings come from that
growth.

---

## The short version

| # | Finding | Measured cost today | Fix | Effort |
|---|---|---|---|---|
| **P1** | Belt animation is re-probed (257 collect passes per belt) on every scene-cache miss | **Pan 260 ms/frame, zoom 600–2,060 ms/frame, one edit 670–2,250 ms** (largest examples, JS only) | Memoise the probe ([`shape-memo.patch`](shape-memo.patch), 20 lines): pan **14 ms**, zoom **28–57 ms**, edit **30–62 ms**, draw stream byte-identical | **S** |
| **P2** | 67% of decoded sprite memory is pixels that are never drawn | Median blueprint holds **93 MB** of decoded RGBA, p90 **333 MB**, max **1.13 GB**. Any rail blueprint: 5 × 134 MB sheets | Repack each sprite's used region (not only contiguous prefixes); release bitmaps the open blueprint doesn't use | **M–L** |
| **P3** | Every edit runs ~120 ms of synchronous app work besides the renderer | Bottleneck pass **52 ms** (quadratic), autosave deflate level 9 **62 ms**, for a results window that starts hidden | Index the adjacency, debounce autosave at deflate level 6, compute results lazily | **S** |
| **P4** | Panning still re-collects every visible entity | **14 ms/frame** on the largest example *after* P1, 84% of the 60 fps budget | Cache commands per entity, or sort once and filter by visibility | **M** |
| **P5** | Main JS chunk is 2.6× September's | **464 kB** (160 kB gzip); simulation + overlay ≈ 105 kB (23%), pako 48 kB (11%) | Lazy-load "Simulate", lazy debug fixtures | **M** |
| **P6** | First visit downloads every example to show one | **1.39 MB** (885 kB gzip; blueprint strings don't compress) | One index file plus one file per example | **S** |
| **P7** | Each branch preview copies the whole 165 MB build into gh-pages | GitHub Pages' 1 GB limit is reached at main + 5 previews; every push builds twice | Previews reuse the root's sprites; build once per push | **S–M** |
| **S1** | The two central closures have more than doubled | `mountBlueprintEditor` **3,562 lines / 699 branches** (was 1,666 / 283); `mountRenderer` **2,583 / 617** (was 889 / 170) | Pull out stateful pieces one at a time (list below) | **L, incremental** |
| **S2** | The September render-regression guards no longer run | `verify-render-identical`, `verify-f01-cache`, `bench-pan` crash; `verify-f01-dirty` draws 0 frames | Make the drawImage-hash check a real test in CI | **S** |
| **S3** | Test harness duplicated 29 times, run serially | `npm test` **25.0 s** | `node --import tsx --test` runs today's files unchanged in **10.8 s** | **S** |

If you only do one thing, apply **P1**. It is a 20-line change, it makes
panning on the largest example ~18× cheaper, and it is verified
byte-identical. Then add the two CI guards from **S2**: a draw-hash test
against wrong output, and a call-count budget against slowdowns like P1.

---

## Performance

### P1: belt animation re-probe on every scene-cache miss (critical, S)

**Where:** `packages/renderer/src/render.ts:1730` (`probeShape`), called from
`buildSceneCache` at `render.ts:2056`.

The scene cache stores the collected, sorted draw commands and patches only
the animated `sx` each frame. To know *how* a command animates, it probes:
`probe()` (`render.ts:1756`) runs `collectEntity` 257 times. That is
memoised per entity type, but entities whose command count differs from the
isolated probe get re-probed individually by `probeShape`. That includes
every belt in a run, because neighbours drop the end caps. Its comment says
it is "deliberately not memoised". So every scene-cache miss re-probes
each such belt 257 times: 265 belts per pan frame on the largest example,
94 on Legendary Blue Science.

A miss happens on every pan or zoom frame that changes the visible set, and
on every edit (`entitiesVersion` bumps). A CPU profile of panning shows
**78% of the frame inside `probeShape`**.

**Measured** (`scripts/bench-frames.ts`, JS only, headless, canvas stubbed,
1600×900 @2×):

| Example (entities) | Pan before → after | Zoom before → after | One edit before → after |
|---|---:|---:|---:|
| Legendary Bioflux (6,478) | 259.9 → **14.3 ms** | 597.4 → **27.9 ms** | 667.0 → **33.7 ms** |
| Heavy Promethium Cruiser (4,067) | 3.0 → 2.9 ms¹ | 2,060.7 → **56.8 ms** | 2,245.1 → **62.2 ms** |
| Legendary Blue Science (2,736) | 231.1 → **7.3 ms** | 736.7 → **19.4 ms** | 837.8 → **30.1 ms** |

¹ The whole blueprint is on screen, so panning never changes the visible set.

**Fix:** [`shape-memo.patch`](shape-memo.patch) memoises the per-entity probe
on the type key plus the frame-0 commands the entity actually emitted
(sheet, sx, sy, layer, order). Two belts that drew the same cells at frame 0
animate the same way.

**Verification:** `scripts/verify-frames-identical.ts` hashes every
`drawImage` call (source rect, destination rect, sheet) over 3 camera
positions × 130 animation frames on the 4 largest examples:
**4,311,531 / 3,164,241 / 1,199,625 / 1,157,025 calls, identical hashes
before and after.** All 204 renderer test cases pass with the patch applied.

```bash
npx tsx audit/2026-10/scripts/verify-frames-identical.ts   # note hashes
git apply audit/2026-10/shape-memo.patch
npx tsx audit/2026-10/scripts/verify-frames-identical.ts   # same hashes
npx tsx audit/2026-10/scripts/bench-frames.ts
```

**Structural alternative:** see S4. `collect.ts` already knows which layers
animate and how, so the probing can be deleted rather than cached.

### P2: decoded sprite memory, 67% never drawn (high, M–L)

The September audit was about **download** size. The cropping since then
worked: the median sprite download per example blueprint fell from 13.2 MB
to **5.1 MB** (p90 17.0 MB, max 37.9 MB; `scripts/bench-payload.ts`). The
remaining cost is **decoded memory**. `spriteAtlas.ts:123` decodes every
sheet to an `ImageBitmap`, which holds width × height × 4 bytes no matter
how well the PNG compressed:

| | Median example | p90 | Max |
|---|---:|---:|---:|
| Download (PNG) | 5.1 MB | 17.0 MB | 37.9 MB |
| **Decoded RGBA held** | **92.8 MB** | **333.2 MB** | **1,130.6 MB** |

`scripts/measure-sprite-usage.ts` uses the same cell sampling that
`crop-sprite-sheets.ts` already relies on for correctness. It records the
exact source rect of every sampled cell:

- 582 sheets, **2,183 MB decoded, 727 MB ever sampled: 66.7% never drawn.**
- The five rail sheets are **4096×8192 (134 MB decoded each)** and each uses
  20.8 MB. Any blueprint with one rail holds 671 MB of rail pixels, 104 MB
  of which are ever drawn. `turbo-transport-belt.png` is 84 MB decoded and
  13 MB used.

**Why the crop didn't catch these:** `crop-sprite-sheets.ts` only crops
when the used cells form a contiguous prefix on a shared frame grid
(`:230`, `:235`). Rails mix 256 px and 384 px frames on one sheet
("conflicting"), and belts use rows with gaps. The rail sheets also enter
through `merge-rail-catalog.ts:126`, which copies them whole.

**Fix:**
1. Generalise the crop to **repack per sprite descriptor**. Every descriptor
   addresses `x + column·frameWidth`, `y + row·frameHeight` over a known
   column/row range. Copy that block into a new sheet and rewrite the
   descriptor's `x`/`y`. This handles gaps and mixed frame sizes, and the
   renderer is unchanged, like the existing crop. Verify the same way as
   before (old-vs-new pixel comparison per command).
2. **Release what the open blueprint doesn't use.** `SpriteAtlas.images`
   (`spriteAtlas.ts:38`) only grows. Opening several blueprints in one tab
   accumulates every sheet ever seen. On `loadBlueprint`, `close()` bitmaps
   not referenced by the new blueprint (or keep an LRU with a byte budget).

Phones are where this matters: a tab holding 333 MB of bitmaps at p90 is
likely to be killed.

### P3: synchronous work on every edit (high, S)

`applyEdit` (`apps/site/src/tools/blueprint-editor/index.ts:1465`) runs this
on every placed, removed or rotated entity, including every tile of a
drag-placed belt line:

| Step (Legendary Bioflux, 6,478 entities) | ms | Source |
|---|---:|---|
| Renderer rebuild + first frame (after P1) | 33.7 | `bench-frames.ts` |
| `attachBottlenecks` | **51.7** | `bench-edit-app.ts` |
| Autosave: `toBlueprint` + `JSON.stringify` + deflate **level 9** | **61.6** | `bench-edit-app.ts` |
| `calculate` | 2.5 | `bench-edit-app.ts` |
| Undo snapshot | 0.7 | `bench-edit-app.ts` |

1. **`attachBottlenecks` is O(machines × entities).** For every machine,
   `findAdjacentInserters` (`packages/engine/src/calc/throughput.ts:85`)
   scans every entity. `computeBottleneck` scans again, and calls
   `findAdjacentOutputBelts` (`:104`) twice more per product (`:178`,
   `:199`). Build one map from tile to inserters (by drop and pickup tile)
   and one from tile to belts, then visit each machine's perimeter: O(N).
2. **Autosave uses maximum compression on the main thread, every edit**
   (`index.ts:1272` → `packages/engine/src/blueprint.ts:60`). Measured on
   the largest example (`scripts/bench-autosave-deflate.ts`): level 9
   takes 53 ms for 44 kB, level 6 takes 18 ms for 51 kB, level 1 takes
   9 ms for 70 kB. An autosave doesn't need maximum compression. Debounce
   it (about 1 s trailing, plus `pagehide`) and use level 6. Keep level 9
   for the export the user copies.
3. **The results window starts hidden** (`index.ts:565`), but `recalculate`
   (`index.ts:2653`) rebuilds its whole DOM on every edit. Mark it dirty and
   render it when it is shown. The properties panel only needs the
   selected machine's bottleneck.

The rate overlay already does this right: it debounces its rebuild by
250 ms (`rate-overlay/controller.ts:241`). Points 2 and 3 are the same
pattern applied to the editor. Together, points 1–3 save about **110 ms per
edit** on the largest example.

The renderer's share (`rebuildIndices`, `render.ts:2692`) is a full rebuild
too: entity map, wire network, grid, fluid, heat, spatial index, a preload
walk over every layer of every entity (`:2754`), and
`atlas.whenIdle()` (`:2777`), which awaits every sheet ever requested.
After P1 that is about a third of the renderer's 34 ms. Restricting the
preload walk to entity *names* not seen before is a cheap first step.
Incremental neighbour updates come later, if ever.

### P4: panning re-collects the visible scene every frame (medium, M)

After P1, a pan frame on the largest example costs **14.3 ms of JS**. The
canvas `drawImage` work comes on top of that and is not measured here. The
scene key (`render.ts:1283`) changes as soon as one entity enters or leaves
the viewport, and then the whole visible set is collected and sorted again.
A command's content doesn't depend on the camera. It depends only on the
blueprint (`entitiesVersion`) and the highlight (`highlightVersion`).

**Fix, either:**
- cache each entity's commands (plus its animation entries) in a map keyed
  by entity number, cleared on `entitiesVersion`/`highlightVersion`. A pan
  frame then gathers and sorts without classifying; or
- collect and sort the **whole** blueprint once per version, then filter
  that list by the visible-id set. No per-pan sort at all, and the
  animated-index bookkeeping is done once.

*Estimate, not measured:* this removes most of the remaining 14 ms, because
`resolveFrame`/`collectEntity` dominate the post-P1 profile.

### P5: main bundle grew to 464 kB (medium, M)

Production build: `index-*.js` **463.6 kB / 160.1 kB gzip**, CSS 77.6 kB /
15.0 kB gzip (September: 177 kB JS). Seed viewer, overlay lab and layer debug
are correctly split into their own chunks. Sourcemap attribution
(`audit/scripts/bundle-attribution.mjs`):

- **Rate overlay + belt and circuit simulation: ~105 kB (≈23%)**, loaded
  for every visitor although the simulation only runs once "Simulate" is
  opened. The coupling is `rateOverlay` being constructed eagerly, plus
  `CircuitSim` for the entity GUI's live values. Construct the controller
  behind a dynamic `import()` on first use. The GUI can import
  `CircuitSim` on demand the same way.
- **pako: 48 kB (≈11%).** Every target browser has `CompressionStream` /
  `DecompressionStream("deflate")`, which read and write the zlib format
  blueprint strings use. The catch: they are async, and
  `decodeBlueprintString`/`encodeBlueprintString` are sync today, so it's a
  signature change through the import and export paths. Worth it alongside
  the autosave change in P3.
- **Debug fixtures: ~13 kB** (`throughput-tests`, `debug-lab`, from the
  engine barrel, `packages/engine/src/index.ts:10-13`). They are used by the
  library sidebar, so load them with `import()` when that entry is clicked.

### P6: first visit downloads all 176 examples to show one (medium, S)

With no autosave, the editor fetches `example-blueprints.json` and picks one
at random (`index.ts:3817`). That file is **1.39 MB raw, 885 kB gzip**.
Blueprint strings are already deflated, so HTTP compression barely helps.
Split it into a small index (label, entity count) plus one file per example.
That saves ~880 kB on first visit. The index can also steer the random pick
away from 6,000-entity blueprints, which make a slow first impression on a
phone.

### P7: preview deploys and duplicate builds (medium, S–M)

- `.github/scripts/pages-store.sh:47` copies the **entire 165 MB build**
  (159 MB of it sprites) into `preview/<slug>/` for every branch. GitHub
  Pages limits a published site to 1 GB, so **main plus 5 open branches
  reaches the limit**, and every deploy uploads all of it. Previews should
  point at the root's `data/sprites/` (a build-time base URL), or copy only
  the sprite files that differ from main.
- Every push runs `npm ci && npm run build` twice: in `ci.yml:27` and in
  `pages-build.yml:30`. Build once: let CI upload `dist` as an artifact for
  the store step, or drop the build from `ci.yml`, since `npm run check`
  already type-checks the site.

### Smaller performance items (low, S)

- **Camera persisted on every camera change** (`index.ts:1344`): one
  synchronous `localStorage.setItem` per pointermove while panning and per
  wheel tick. Debounce it, or write on `pagehide` and `visibilitychange`.
- **The rate overlay redraws every frame while active, even when paused**
  (`rate-overlay/controller.ts:484-520`, no dirty flag). That is the same
  problem the renderer fixed in September (F-01). Redraw on a camera change
  or a simulation tick.
- **Keyboard pan speed depends on refresh rate** (`render.ts:2178`):
  `applyKeyboardPan(16)` assumes 16 ms per rAF tick, so WASD pans 2× faster
  at 120 Hz and 2.4× at 144 Hz. Pass the real elapsed time. Strictly a
  correctness bug.

---

## Code simplicity

### S1: the central closures have more than doubled (high, L, incremental)

| Function | Sept 2026 | Now | Mutable `let`s in closure |
|---|---|---|---:|
| `mountBlueprintEditor` (`blueprint-editor/index.ts:428`) | 1,666 lines / 283 branches | **3,562 lines / 699 branches** | 54 |
| `mountRenderer` (`renderer/src/render.ts:489`) | 889 / 170 | **2,583 / 617** | 99 |
| `draw()` inside it (`render.ts:973`) | — | **666 lines** | — |

(`audit/scripts/complexity.mjs`.) Everything is shared state reached through
one closure. That is why `apps/site` still has **zero tests**, and why P1
could hide: no test can build a scene and count probe calls. Suggested seams,
each a separate PR, ordered by payoff:

1. **`EditStore`** (editor): entities, wires, both histories, `applyEdit`,
   `undo`/`redo`, persistence. DOM-free and testable. Its "after edit" hook
   is where P3's debouncing goes.
2. **`SceneCache`** (renderer): `buildSceneCache`, the animation profiles,
   baking (`bakedLayersFor`), the scene key. Pure inputs to a command list,
   testable with the headless harness in `scripts/harness.ts`.
3. **`GhostPreview`** (renderer): place, paste and rail ghosts, about 300
   lines of `draw()` (`render.ts:1022-1239`, `1531-1609`) plus their caches.
4. **`FrameRecorder`** (renderer): the profiling ring buffer, phases, paint
   tally, about 12 state variables. It's useful, but it shouldn't share a
   closure with input handling.
5. **Pointer and keyboard input** (renderer): about 40 `let`s of press, drag,
   pinch, erase and rail-press state.
6. **One keymap** (editor): 15 separate `window.addEventListener("keydown")`
   handlers, each with its own guards, become one table from key to action.

### S2: the September audit's verification scripts have rotted (high, S)

The September fixes were proven with scripts that were never moved into CI
(September findings N-03/N-04). Today:

| Script | Result |
|---|---|
| `audit/scripts/verify-render-identical.ts` | crashes: `ctx.rotate is not a function` |
| `audit/scripts/verify-f01-cache.ts` | crashes: `getImageData` missing from the stub |
| `audit/scripts/bench-pan.ts` | crashes: same |
| `audit/scripts/verify-f01-dirty.ts` | "ABWEICHUNG": draws 0 frames, because the `maxFps` cap skips every frame under a synchronous fake rAF |

`crop-sprite-sheets.ts`'s header still cites "the render-hash regression
check is unchanged" as its proof of correctness. That check can no longer
run. **Fix:** `scripts/harness.ts` fakes the clock (so the frame cap never
skips) and stubs the full canvas API. Two tests on top of it, run in CI:

1. **Output:** move `verify-frames-identical.ts` into `packages/renderer/test/`
   as a golden-hash test over a couple of committed fixtures. This is what
   makes P2, P4 and S4 safe to do.
2. **Cost:** a hash can't catch P1, because P1's output was correct. Count
   `collectEntity` calls over a scripted pan (deterministic, unlike wall
   time) and fail above a budget. Today that count is roughly 257 × 265 per
   frame on the largest example; with the patch it is about one per visible
   entity.

### S3: tests: 29 copies of one helper, serial chains (medium, S)

All 29 test files define the same `test(name, fn)` / `passed++` /
`process.exitCode` helper. The four packages' `test` scripts are
hand-maintained `&&` chains: renderer runs 20 files one after another, each
paying ~550 ms of tsx startup. Without changing any test file:

```bash
node --import tsx --test packages/*/test/*.test.ts   # 10.8 s, 29/29 pass
npm test                                              # 25.0 s
```

Point the root `test` script at the first command, then gradually switch
files to `node:test`'s `test()` and delete the helpers. New files get picked
up automatically, with no chain to forget.

### S4: delete the animation probing instead of caching it (medium, M)

P1's patch is the quick fix. The simpler end state: `collect.ts` already
decides that a layer's column follows the animation clock (`axisIndex`,
`collect.ts:295`, with `speedup`/`slowdown`/`columns`), and `push()`
computes the wrap (`collect.ts:358`). Have `push()` attach
`{ origin, stride, columns, phase0, speedup, slowdown }` to the command when
the axis is `animation`. Then `probe`, `probeShape`, `animProfileFor`,
`AnimProfile`, `NO_ANIMATION`, `MAX_ANIM_PERIOD`, `gcd`, `collectAt` and the
seven parallel arrays in `SceneCache` all go away: roughly 250 lines of
`render.ts`, including the long comments that explain the probe's failure
modes. The 257-pass startup probe per entity type goes away with them. The
turbo-belt parity special case (`collect.ts:613`, matched by entity name)
would then sit next to the animation data it adjusts.

### S5: duplication worth consolidating (low, S each)

- **"Every sprite of a layer" walk, written five times:** `render.ts:2754`
  (preload), `data-pipeline/src/crop-sprite-sheets.ts:77`,
  `sprite-shapes.ts:653`, `dump-to-gamedata.ts:445`,
  `site/src/tools/layer-debug/index.ts:307`. Export one `spritesOfLayer()`
  from the renderer.
- **`rotatePoint`** in `neighbours/fluid.ts:28` and `neighbours/heat.ts:17`.
  The heat copy's comment calls it "identical to fluid.ts's own".
- **Placement collision, twice:** the editor's `placeEntity` scans every
  entity (`index.ts:1539`, `:1554`), while the renderer answers the same
  question for the ghost through its spatial index (`render.ts:1089`).
  Expose the renderer's check and drop the editor's O(N) scan.
- **Two rail data paths:** `merge-rail-catalog.ts` duplicates what
  `dump-to-gamedata` + `extract-sprites` already produce (its own header
  says so). It is also how the uncropped 134 MB rail sheets arrive (P2).
  Retire it, or run the crop after it.
- **Three rAF loops with their own clocks:** the renderer's `tick`, the
  overlay's `frame`, and the editor's `circuitLoop`. There are also two
  circuit simulations, the editor's and the overlay's, with
  `liveCircuits()` picking between them. One frame scheduler owned by the
  renderer, with subscribers, would replace the two extra loops and their
  `maxFps` checks.

### S6: comments that no longer match the code (low, S)

- `render.ts:1273-1277` justifies the short scene key (count, first id, last
  id) with "a stable insertion order" and "the `sceneEpoch` below bounds how
  long any such reuse could last". **There is no `sceneEpoch`**, and
  `SpatialIndex.queryRect` returns ids in bucket order, not insertion order
  (its own comment, `spatialIndex.ts:71`, says otherwise). I tested for the
  failure this could cause, a stale scene served after a pan: **0 of 2,400
  frames** across 6 examples differed from a full-key run. So there's no
  observed bug, but the argument for why it's safe is wrong. Fix the
  comments, or add the epoch they describe.

---

## Checked and not worth doing

| Idea | Measured | Verdict |
|---|---|---|
| Stop re-sorting the already-sorted scene in `paintPlain` | 0.16 ms for 9,323 commands | Not worth the churn |
| Integer instead of string Map keys (September F-05) | `NeighbourGrid.at` is ~4% of an edit after P1 | Re-measure after P1, P3 and P4 |
| Belt simulation tick | 0.12–0.26 ms/tick on the largest examples | Not a bottleneck |
| Undo snapshot cost | 0.4–0.9 ms per edit (cap 50 holds) | Fine |
| Unused CSS | 24 of 453 classes not found literally; several are built at runtime (`quality-*`, `is-*`) | Too little to gain |
| Stopping the rAF loop when idle | Idle frame costs 0.001 ms | Optional |

## What is good and should stay

- **Idle and settled frames are cheap:** a static view costs 0.001 ms per
  tick. An animated view with a still camera costs 1.1–4.2 ms, thanks to the
  dirty flag and the baked layers.
- **Listener hygiene:** every global listener in the editor is bound to one
  `AbortController`. The two elsewhere are removed by hand on unmount.
- **Seed viewer:** worker pool, generation tokens against stale replies,
  transferable typed arrays.
- **Rate overlay:** rebuilds debounced, and its loop stops entirely when it
  is off.
- **Strict TypeScript, 0 errors**, CI on every push, lazy chunks for the
  three secondary tools, self-hosted fonts and a strict CSP.

---

## Status of the September 2026 findings

| ID | Topic | Status |
|---|---|---|
| F-01 | Redraw every frame | ✅ Fixed (dirty flag, scene cache, baking). **Regressed for pan, zoom and edit by P1.** |
| F-02 | Ghost networks rebuilt per frame | ✅ Cached per cell |
| F-03, F-04 | paint() copies, tooltip reflow | ✅ |
| F-05 | String map keys | ⏸ Still open, still low (see above) |
| F-06 | Unaddressable sprite frames | ◐ Download fixed (median 13.2 → 5.1 MB); decoded memory open (P2) |
| F-07 | Debug code in bundle | ◐ Layer debug lazy; fixtures still in the barrel (P5) |
| F-08 | Sequential startup fetch | ✅ `Promise.allSettled` |
| F-10 | Unbounded undo | ✅ Capped at 50 |
| F-11 | Monolith | ✗ Grew from 1,666 to 3,562 lines (S1) |
| F-12 | No renderer tests | ✅ 20 renderer test files. `apps/site` and `data-pipeline` still have none |
| F-13 | No CI | ✅ |
| F-14 – F-19 | Lookup duplication, debug logs, XSS, storage validation, CSP, fonts | ✅ |
| N-03, N-04 | Verification scripts into CI | ✗ Not done, and the scripts have since rotted (S2) |

---

## Suggested order

1. **P1** (apply the patch) + **S2** (golden-hash test in CI): about half a
   day, removes the worst cost and adds the guard.
2. **P3** (bottleneck index, autosave debounce and level, lazy results): about a day.
3. **S3** (test runner): about an hour.
4. **P2** (per-sprite repack + bitmap release): 3–5 days, and the biggest
   win for phones.
5. **P4** (pan without re-collecting), **S4** (delete the probe): 2–3 days,
   ideally together.
6. **P5, P6, P7** (bundle split, example index, preview sprites): 1–2 days.
7. **S1** (one seam at a time, `EditStore` first), whenever that code is
   touched next.

## Reproducing

All measurements: Node 22, headless, 4-core cloud container. They cover
**JavaScript only**: `drawImage`, GPU upload and compositing are stubbed out,
so real frame times in a browser are higher. The ratios hold.

```bash
npx tsx audit/2026-10/scripts/bench-frames.ts             # P1, P4: animated, idle, pan, zoom, edit
npx tsx audit/2026-10/scripts/verify-frames-identical.ts  # P1: drawImage-stream hash
npx tsx audit/2026-10/scripts/bench-edit-app.ts           # P3: per-edit app work
npx tsx audit/2026-10/scripts/bench-autosave-deflate.ts   # P3: deflate levels
npx tsx audit/2026-10/scripts/bench-payload.ts            # P2: download vs decoded per example
npx tsx audit/2026-10/scripts/measure-sprite-usage.ts     # P2: sampled vs shipped pixels per sheet
node audit/scripts/bundle-attribution.mjs <dist>/assets/index-*.js.map   # P5
node audit/scripts/complexity.mjs                         # S1
node --import tsx --test packages/*/test/*.test.ts        # S3
```

No production code was changed by this audit. The P1 fix is provided as a
patch only.
