# FactorioTools

A browser-based Factorio blueprint viewer and rate calculator. Paste a
blueprint string and it renders the factory with real game sprites, then tells
you what it produces, what it consumes, and where the bottleneck is.

Everything runs client-side — no server, no upload, no account. Blueprint
strings never leave the page.

## What it does

**Renders blueprints** with the game's own art: belts animate, poles turn to
face their wires, pipes and walls pick their connection art from their
neighbours, and machines show their recipe and modules in alt-mode.

**Calculates rates** across the whole blueprint — items per second by machine
group, module and beacon effects, quality tiers, and productivity research.

**Edits** — place, rotate, erase, configure recipes and modules, wire poles and
combinators, undo/redo, then export the result back to a blueprint string.

## Requirements

The renderer draws real Factorio sprites, and those are Wube's copyrighted
assets — they are not in this repository and never will be. You need your own
copy of the game to generate them locally.

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

Running the first step alone leaves the catalog claiming uncropped column
counts against cropped images, which silently breaks about 29 entities. If you
regenerate, regenerate all three.

Non-standard install paths are read from `FACTORIO_DATA` and `FACTORIO_DUMP`.

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
| `packages/data-pipeline` | One-time scripts that turn a Factorio install into the dataset above. |
| `apps/site` | The page itself — panels, menus, editing, library. |

`engine` and most of `renderer` are DOM-free and tested directly with `tsx`;
`apps/site` is the browser layer.

## Audit

`audit/` holds a full code audit — 19 findings with severity and effort
ratings, the implementation reports, and the verification scripts that back
them. Those scripts are runnable and self-checking, and one of them
(`verify-render-identical.ts`) hashes the entire render path so a refactor can
prove it changed no pixels.

## Licence

The code is MIT (see `LICENSE`).

Factorio, its prototype data and its sprite art are the property of
[Wube Software](https://factorio.com) and are **not** covered by that licence.
This project reads them from your own installation at build time and
redistributes none of them.
