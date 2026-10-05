# Rail data export

Raw Factorio rail data, exported for the rail rendering pipeline.

- **Factorio version:** 2.0.77 (build 84539, mac-arm64), with the Space Age,
  Quality and Elevated Rails mods enabled (all 2.0.77).
- **Source:** `factorio --dump-data` → `script-output/data-raw-dump.json`.

## Contents

- `rail-prototypes.json` — subset of `data-raw-dump.json` (pretty-printed,
  1.3 MB) holding the full prototype tables `straight-rail`,
  `half-diagonal-rail`, `curved-rail-a`, `curved-rail-b`,
  `elevated-straight-rail`, `elevated-half-diagonal-rail`,
  `elevated-curved-rail-a`, `elevated-curved-rail-b`, `rail-ramp`,
  `rail-support`, `rail-signal`, `rail-chain-signal`, `train-stop` and
  `rail-planner`.
- `sprites/` — every PNG those prototypes reference by filename, copied from
  the Factorio `data` directory with the mod path kept
  (e.g. `sprites/__elevated-rails__/graphics/...`).

## Sprites

113 PNG files, 37,491,834 bytes (35.8 MiB) in total:

| Mod path             | Files |
| -------------------- | ----: |
| `__base__`           |    42 |
| `__core__`           |     2 |
| `__elevated-rails__` |    69 |

The prototypes reference 122 PNGs in total. The 9 under
`__base__/graphics/entity/rails/rail/` are not copied, because the repo
already has them.
