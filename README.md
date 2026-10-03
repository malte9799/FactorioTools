<div align="center">

# FactorioTools

**Paste a blueprint. Find the bottleneck. Fix it. Export.**

A browser-based Factorio blueprint editor built for optimising production lines —
with a rate calculator, a tick-by-tick belt simulation and the game's own art.
Plus a live map seed viewer.

[![Open the editor](https://img.shields.io/badge/Open_the_editor-malte9799.github.io-f5a742?style=for-the-badge&logo=githubpages&logoColor=white)](https://malte9799.github.io/FactorioTools)

[![CI](https://github.com/malte9799/FactorioTools/actions/workflows/ci.yml/badge.svg)](https://github.com/malte9799/FactorioTools/actions/workflows/ci.yml)
![Factorio 2.0](https://img.shields.io/badge/Factorio-2.0_·_Space_Age-e39827)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-22+-5fa04e?logo=nodedotjs&logoColor=white)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

[Features](#-features) · [Seed Viewer](#-seed-viewer) · [Quick start](#-quick-start) · [Build from source](#-build-from-source) · [Architecture](#-architecture) · [Licence](#-licence)

<br>

<img src="docs/screenshots/hero.webp" alt="FactorioTools showing a logistic science build with per-machine rate labels, machine status colours and the Rate Calculator panel reporting 56% efficiency" width="100%">

</div>

<br>

> [!NOTE]
> **Everything runs client-side.** No server, no upload, no account — blueprint
> strings never leave the page.

## ✨ Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>📊 Calculates rates</h3>
      Items per second across the whole blueprint, grouped by machine
      configuration — with module and beacon effects, quality tiers and
      productivity research all accounted for. Imports, exports and the
      share of theoretical max at a glance.
    </td>
    <td width="50%">
      <img src="docs/screenshots/rate-table.webp" alt="Rate table listing products, ingredients and machines for a red science build">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/simulation.webp" alt="Simulation pane with inserter capacity research and belt stacking controls">
    </td>
    <td width="50%" valign="top">
      <h3>⏱️ Simulates belts tick by tick</h3>
      Per-lane transport lines, curves, side-loading, undergrounds and
      splitters — so lane imbalance and starved inputs show up the way they
      would in game. Run at 1×, 4× or 16×, skip ahead a minute, and toggle
      inserter capacity research and belt stacking.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔍 Analyses on the map</h3>
      Lane signals, machine uptime, and a ranked list of what costs output,
      each traced from the symptom back to its cause. Hover any machine for
      its recipe, modules, beacons and exact per-minute flows.
    </td>
    <td width="50%">
      <img src="docs/screenshots/machine-tooltip.webp" alt="Zoomed-in assemblers with a tooltip showing recipe, modules and per-minute rates">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/space-platform.webp" alt="A full space platform rendered with game sprites">
    </td>
    <td width="50%" valign="top">
      <h3>🎨 Renders with the game's own art</h3>
      Belts animate, poles turn to face their wires, pipes and walls pick
      their connection art from their neighbours, and machines show their
      recipe and modules in alt-mode. Space Age, quality and elevated rails
      included.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🛠️ Edits in place</h3>
      Place, rotate and erase; configure recipes and modules; wire poles and
      combinators; undo and redo. Import from a string, a
      <a href="https://factorioprints.com">factorioprints.com</a> or
      <a href="https://fprints.xyz">fprints.xyz</a> link, then export the
      result back to a blueprint string.
    </td>
    <td width="50%">
      <img src="docs/screenshots/import-export.webp" alt="Import / Export menu with clipboard import, random example and share links">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/overlay-lab.webp" alt="Overlay Lab with layer controls for dimming, lane signals and machine status">
    </td>
    <td width="50%" valign="top">
      <h3>🧪 Overlay Lab</h3>
      Tune how the analysis is drawn: dim the build, choose lane-signal and
      machine-status styles, and filter to just the lanes or machines you
      care about — flowing, backed up, starved, output full, idle.
    </td>
  </tr>
</table>

## 🌍 Seed Viewer

<div align="center">
<img src="docs/screenshots/seed-viewer.webp" alt="Seed Viewer showing the Nauvis map of seed 123 with ore patches, enemy bases, forests and cliffs, and a panel listing the nearest patches" width="100%">
</div>

<br>

> [!WARNING]
> **Early prototype.** The numbers behind the map are checked against the
> game; how the page looks next to the real map has not been.

Enter a map seed and explore the world it generates — where the ore is, how
much, and where the biters are. Nothing is pre-rendered: the page runs the
game's own map generation live, so every seed, preset and slider setting works.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>⛏️ Finds the resources</h3>
      Ore patches, oil wells, trees, cliffs and enemy bases, drawn the way
      the in-game map draws them. Hover a patch for its exact amount and
      size; the panel lists the nearest patches with distance and bearing.
      Pan, zoom and share the view as a link.
    </td>
    <td width="50%">
      <img src="docs/screenshots/seed-viewer-patch.webp" alt="A hovered iron ore patch outlined in white with a tooltip reading 425k in 702 tiles, 48 tiles from spawn">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/seed-viewer-planets.webp" alt="The same seed on Vulcanus, Gleba, Fulgora and Aquilo">
    </td>
    <td width="50%" valign="top">
      <h3>🪐 All five planets, all the settings</h3>
      Nauvis, Vulcanus, Gleba, Fulgora and Aquilo, each from the seed the
      game gives it. The game's presets (rail world, death world, island…),
      the map type, frequency, size and richness for every resource, the
      moisture and terrain sliders, the starting area and the map size.
    </td>
  </tr>
</table>

<details>
<summary><b>How close it is to the game, and where it is not</b></summary>

<br>

[`packages/mapgen`](packages/mapgen) reimplements Factorio 2.0 map generation
in TypeScript, in single precision and in the game's order of operations. Its
tests hold it to exact values recorded from the real game:

| Checked bit for bit | |
|---|---|
| Every tile, resource, tree and enemy expression on Nauvis | two seeds, three presets, two custom settings files |
| Vulcanus, Gleba, Fulgora, Aquilo | every tile and entity expression |
| Each noise function on its own | basis, multi-octave, spot and all Voronoi variants |
| Cliffs and resource entities around spawn on Nauvis | what the game actually placed |

Where an entity lands is a roll, and the game rolls each chunk from one random
stream that every entity in the chunk draws from in turn. The viewer replays
that stream (see [`placement.ts`](packages/mapgen/src/placement.ts)), so ore
tiles and oil wells are the ones the game places, with their amounts.

**Known gaps**

- The game straightens shorelines after generating a chunk. That is not
  reproduced, and in the few chunks it touches the wells can come out wrong —
  about a third of them on Aquilo, which is mostly coast.
- No cliffs are drawn where the game smooths them: the Lakes and Island
  presets, and Vulcanus.
- On Fulgora about one cliff in six differs, and scrap is drawn as a filled
  field although the game fills only about half of its tiles.
- On Gleba only a sixth of the stone is placed.
- Trees are a scatter of the right density and enemy bases the area they can
  occupy, not individual entities.
- Only Factorio 2.0 is supported; 1.1 uses a different noise system.

</details>

## 🚀 Quick start

1. Open **[malte9799.github.io/FactorioTools](https://malte9799.github.io/FactorioTools)**.
2. In game, copy a blueprint to the clipboard.
3. Click **Import / Export → Import from clipboard** and paste the string or link.
   No blueprint handy? **Load a random example** picks from 170+ curated builds.
4. Open **Rates** to see what it produces, where it loses output, and why.

## 🧰 Build from source

### Requirements

- **Node.js 22+**
- **Factorio 2.0** — only if you want to regenerate the sprites and game data
  (Space Age, quality and elevated rails are read if present)

The generated dataset in `apps/site/public/data/` is checked in, so cloning
and running is enough to work on the app:

```bash
git clone https://github.com/malte9799/FactorioTools.git
cd FactorioTools
npm install
npm run dev
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build into `apps/site/dist` |
| `npm test` | Engine, simulation, renderer and map-generation test suites |
| `npm run check` | Typecheck every workspace |

### Regenerating the game data

<details>
<summary><b>Rebuild sprites and prototypes from your own Factorio install</b></summary>

<br>

First, dump the prototype data from inside the game. This writes
`data-raw-dump.json` into Factorio's `script-output` directory:

```bash
factorio --dump-data
```

Then run the pipeline **in this order** — the steps are not independent:

```bash
npm run dump-to-gamedata   --workspace=@factoriotools/data-pipeline
npm run extract-sprites    --workspace=@factoriotools/data-pipeline
npm run crop-sprite-sheets --workspace=@factoriotools/data-pipeline
```

| Step | Output |
|---|---|
| `dump-to-gamedata` | Reads the dump and writes `game-data.json` and `render-catalog.json`. |
| `extract-sprites` | Copies the referenced sheets out of the install, plus the shortcut-bar art the quickbar draws its buttons from. |
| `crop-sprite-sheets` | Trims each sheet to the cells the renderer actually samples (143 MB → 10.6 MB) and rewrites the catalog's column counts to match. |

> [!WARNING]
> Running the first step alone leaves the catalog claiming uncropped column
> counts against cropped images, which silently breaks about 29 entities.
> If you regenerate, regenerate all three.

The Seed Viewer's data is a separate, independent step that reads the same
dump and writes `data/mapgen/<version>.json`:

```bash
npm run dump-to-mapgen --workspace=@factoriotools/data-pipeline
```

**Good to know**

- Non-standard install paths are read from `FACTORIO_DATA` and `FACTORIO_DUMP`.
- `extract-sprites` is incremental: it stamps each source file's size and
  mtime and skips anything unchanged whose output is still present, so
  re-running it after a crop leaves the cropped sheets alone. Pass `--force`
  to rebuild regardless.
- Until the shortcut art exists, the quickbar shows plain text labels.
- The belt simulation reads belt speeds, underground lengths and splitter
  prototypes from `game-data.json`. A dataset generated before those were
  extracted still works — `packages/sim` falls back to built-in vanilla values.

</details>

<details>
<summary><b>Check map generation against a real Factorio install</b></summary>

<br>

`packages/mapgen` has two development scripts that run the game headless.
Both use their own config and write directory, so a running game and your
saves are left alone. Neither is needed to run the tests.

```bash
npm run make-fixtures   --workspace=@factoriotools/mapgen          # re-record the test fixtures
npm run compare-preview --workspace=@factoriotools/mapgen -- 123   # diff a seed against the game's map preview
```

`FACTORIO_BIN` and `FACTORIO_DATA` point them at a non-standard install.

</details>

## 🏗️ Architecture

An npm-workspaces monorepo. `engine`, `sim`, `mapgen` and most of `renderer` are
DOM-free and tested directly with `tsx`; `apps/site` is the browser layer.

```mermaid
flowchart LR
    F[(Factorio install)] -->|data-pipeline| D[/game-data.json<br/>render-catalog.json<br/>sprites/]
    F -->|data-pipeline| N[/mapgen data/]
    D --> E[engine]
    D --> S[sim]
    D --> R[renderer]
    N --> M[mapgen]
    E --> A[apps/site]
    S --> A
    R --> A
    M --> A
```

| Workspace | What it holds |
|---|---|
| [`packages/engine`](packages/engine) | Blueprint decode/encode, the rate calculator, prototype types. No DOM. |
| [`packages/sim`](packages/sim) | Tick-by-tick belt simulation: per-lane transport lines, curves, side-loading, undergrounds, splitters. No DOM. |
| [`packages/mapgen`](packages/mapgen) | Factorio 2.0 map generation: noise expressions, spot and Voronoi noise, cliffs, entity placement. No DOM. |
| [`packages/renderer`](packages/renderer) | Canvas renderer: sprite atlas, neighbour classification, camera, draw passes. |
| [`packages/data-pipeline`](packages/data-pipeline) | One-time scripts that turn a Factorio install into the dataset. |
| [`apps/site`](apps/site) | The page itself — panels, menus, editing, library. |

Every pushed branch is built and published as a preview under
`https://malte9799.github.io/FactorioTools/preview/<branch>/`.

## 📜 Licence

The code is [MIT](LICENSE). Blueprint math is ported from
[Rate Calculator](https://codeberg.org/raiguard/RateCalculator) by raiguard,
also MIT licensed.

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
This project reads them from a Factorio installation at build time and is not
affiliated with Wube Software.

## Star History

<a href="https://www.star-history.com/?type=date&repos=malte9799%2FFactorioTools">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=malte9799/FactorioTools&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=malte9799/FactorioTools&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=malte9799/FactorioTools&type=date&legend=top-left" />
 </picture>
</a>
