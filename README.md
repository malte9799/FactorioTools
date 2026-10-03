# FactorioTools

### [malte9799.github.io/](https://malte9799.github.io/FactorioTools)[`FactorioTools`](https://malte9799.github.io/FactorioTools)

A browser-based Factorio blueprint editor built for optimising production
lines. Paste a blueprint string and it calculates what the build produces and
consumes, simulates the belts tick by tick, and shows where output is being
lost — then lets you fix it in place and export the result.

Everything runs client-side — no server, no upload, no account. Blueprint
strings never leave the page.

## What it does

**Calculates rates** across the whole blueprint — items per second by machine
group, module and beacon effects, quality tiers, and productivity research.

**Simulates** the belts tick by tick: per-lane transport lines, curves,
side-loading, undergrounds and splitters, so lane imbalance and starved
inputs show up the way they would in game.

**Analyses** the result on the map itself — lane signals, machine uptime, and
a ranked list of what costs output, each traced from the symptom back to its
cause.

**Edits** — place, rotate, erase, configure recipes and modules, wire poles and
combinators, undo/redo, then export the result back to a blueprint string.

**Renders** with the game's own art: belts animate, poles turn to face their
wires, pipes and walls pick their connection art from their neighbours, and
machines show their recipe and modules in alt-mode.

## Seed Viewer

A second tool at `#/seed-viewer`: enter a map seed and explore the Nauvis it
generates, drawn the way the game's own map draws it — terrain and water,
resource patches as a checkerboard, cliffs, trees, and where enemy bases can
spawn. Hover a patch to see what it holds. Pan and zoom as far as you like;
the link in the address bar carries the seed and the view.

Nothing is pre-rendered. `packages/mapgen` runs the game's own noise
expressions in the browser, and its output is held to the real game: the
test fixtures are exact values recorded from Factorio, and every terrain,
resource, tree and enemy expression on Nauvis matches them bit for bit.

Oil wells and ore tiles are the ones the game places, with their amounts.
Where an entity lands is a roll, and the game rolls each chunk from one
random stream that every entity in the chunk draws from in turn; the viewer
replays that stream (see `packages/mapgen/src/placement.ts`). Cliffs follow
the game's placement rule as well. Both were worked out from what the real
game generated and are held to it by fixtures.

Two known gaps. After generating a chunk the game straightens its shoreline
(no water one tile wide), which the viewer does not reproduce: in the few
chunks where that moves a tile, every roll in the chunk shifts and its wells
can come out wrong. And a cliff next to an oil well may differ.

The panel has the game's map-generator settings: its presets (rail world,
death world, island and the rest), the map type, and frequency, size and
richness for every control. All nine presets are checked against the game.
The game-version list shows whichever versions the data pipeline has been run
for; within 2.0 the changelog shows no change to Nauvis generation, so one is
enough there, and 1.1 and earlier use a different noise system this does not
implement.

Vulcanus and Gleba generate too, from their own seed (the map seed plus the
CRC32 of the planet's name), and are held to the game by fixtures like Nauvis.
Fulgora and Aquilo are listed but cannot be chosen: they are built on the
game's Voronoi noise, whose point placement has not been worked out.

What it does not do yet: Fulgora and Aquilo; cliffs wherever the game smooths
them (the Lakes and Island presets, and Vulcanus), by a rule not reproduced
(none are drawn); resource entities on Gleba beyond stone; and the exact position of individual
trees and spawners — the rolls are replayed, but not yet which attempts
collide, so the viewer shows trees as a scatter of the right density and
enemy bases as the area they can occupy.

## Requirements

The renderer draws real Factorio sprites. To regenerate them yourself you
need your own copy of the game.

- **Node.js 22+**
- **Factorio 2.0** (Space Age, quality and elevated rails are all read if
  present)

## Setup

```bash
npm install
```

Then generate the dataset from your own Factorio install. First, dump the
prototype data from inside the game (this writes
`data-raw-dump.json` into Factorio's `script-output` directory):

```bash
factorio --dump-data
```

Then run the pipeline **in this order** — the steps are not independent:

```bash
npm run dump-to-gamedata --workspace=@factoriotools/data-pipeline
npm run extract-sprites --workspace=@factoriotools/data-pipeline
npm run crop-sprite-sheets --workspace=@factoriotools/data-pipeline
```

`dump-to-gamedata` reads the dump and writes `game-data.json` and
`render-catalog.json`. `extract-sprites` copies the referenced sheets out of
the install. `crop-sprite-sheets` then trims each sheet to the cells the
renderer actually samples (143 MB → 10.6 MB) and rewrites the catalog's column
counts to match.

The Seed Viewer's data is a separate, independent step:

```bash
npm run dump-to-mapgen --workspace=@factoriotools/data-pipeline
```

It reads the same dump and writes `data/mapgen/<version>.json`: the game's
named noise expressions and functions, the autoplace rule of every tile and
entity, each planet's map-gen settings and the generator's presets. Each game
version gets its own file and an entry in `index.json`, which is what the Seed
Viewer's version list shows; run the step once per install (with
`FACTORIO_DUMP` and `FACTORIO_DATA` pointing at it) to add one.

Running the first step alone leaves the catalog claiming uncropped column
counts against cropped images, which silently breaks about 29 entities. If you
regenerate, regenerate all three.

`extract-sprites` also copies the shortcut-bar art (every `shortcut`
prototype: undo, redo, the planners, alt mode, the wires) into
`public/data/sprites/shortcuts/` with `public/data/shortcut-icons.json`; the
editor's quickbar draws its tool buttons from these and shows plain text
labels until they exist.

Non-standard install paths are read from `FACTORIO_DATA` and `FACTORIO_DUMP`.

The belt simulation reads belt speeds, underground lengths and splitter
prototypes from `game-data.json`. A dataset generated before those were
extracted still works: `packages/sim` falls back to built-in vanilla values.

`extract-sprites` is incremental: it stamps each source file's size and
mtime, and skips anything unchanged whose output is still present. Re-running
it after a crop therefore leaves the cropped sheets alone instead of
replacing them with fresh uncropped copies. Pass `--force` to rebuild
regardless.

## Development

```bash
npm run dev      # dev server
npm run build    # production build into apps/site/dist
npm test         # engine + renderer test suites
npm run check    # typecheck every workspace
```

## Layout

| Workspace | What it holds |
|---|---|
| `packages/engine` | Blueprint decode/encode, the rate calculator, prototype types. No DOM. |
| `packages/renderer` | Canvas renderer: sprite atlas, neighbour classification, camera, draw passes. |
| `packages/sim` | Tick-by-tick belt simulation: per-lane transport lines, curves, side-loading, undergrounds, splitters. No DOM. |
| `packages/mapgen` | Map generation: a compiler and evaluator for the game's noise expressions, bit-exact with the game. No DOM. |
| `packages/data-pipeline` | One-time scripts that turn a Factorio install into the dataset above. |
| `apps/site` | The page itself — panels, menus, editing, library. |

`engine`, `sim`, `mapgen` and most of `renderer` are DOM-free and tested directly
with `tsx`; `apps/site` is the browser layer.

### Checking map generation against the game

`packages/mapgen` has two development scripts that run a real Factorio
install headless. Both use their own config and write directory, so a running
game and your saves are left alone. Neither is needed to run the tests.

```bash
npm run make-fixtures --workspace=@factoriotools/mapgen      # re-record the test fixtures
npm run compare-preview --workspace=@factoriotools/mapgen -- 123   # diff a seed against the game's map preview
```

`FACTORIO_BIN` and `FACTORIO_DATA` point them at a non-standard install.

## Audit

`audit/` holds a full code audit — 19 findings with severity and effort
ratings, the implementation reports, and the verification scripts that back
them. Those scripts are runnable and self-checking, and one of them
(`verify-render-identical.ts`) hashes the entire render path so a refactor can
prove it changed no pixels.

## Licence

The code is MIT (see `LICENSE`).

Map generation stands on other people's reverse engineering. The algorithms
behind the game's noise functions were worked out and published, with Wube's
permission, in [ness056/fast-factorio-seed-finder](https://github.com/ness056/fast-factorio-seed-finder);
`packages/mapgen` is an independent TypeScript implementation written from
them, and carries that project's table of gradient values, which cannot be
derived any other way. The RNG test vectors are from
[TOGoS/FactorioNoiseJS](https://github.com/TOGoS/FactorioNoiseJS), by the
author of the game's noise system.

Factorio, its prototype data and its sprite art are the property of
[Wube Software](https://factorio.com) and are **not** covered by that licence.
This project reads them from a Factorio installation at build time.
