# Rails

How the blueprint editor draws, plans and places Factorio 2.0 track, and how to
refresh the rail data from the game.

## Using it

| Held item | What a click does |
| --- | --- |
| **Rail** | Starts the rail planner. Hovering a placed rail shows a green arrow: a press there starts building from the end on the cursor's half of that rail (mid-track too, to branch off). A click on open ground lays just the held straight piece; a drag from open ground lays it and plans on from it. Drag and release to lay track along the planned path. While a plan is active, the path previews from its end to the cursor and the next click lays it. |
| **Rail ramp** | Same planner, but the track finishes on the elevated layer. A ramp is inserted where the track climbs, and rail supports go under the elevated part. |
| **Rail signal / chain signal** | Snaps to the nearest signal slot beside placed track, facing the trains it stops. Which side of the track it goes on follows the cursor. Away from track the ghost is red and nothing is placed. |
| **Train stop** | Snaps to the slot beside a straight cardinal rail, on the right-hand side of travel. |

- **No length limit.** Every plan lays in full, however long.
- **R** turns the held straight piece in 45° steps (8 ways), and the
  direction a drag from open ground plans in. **Shift+R** turns it the other
  way.
- **Esc** or **right-click** drops the plan and keeps the rail in hand.
- **Q** over any rail picks up the rail item. Over elevated track or a ramp, it picks up the ramp item.
- **Undo** reverses each placement in a single step.

The planner routes around buildings. It crosses and reuses existing track, and
never lays a duplicate piece. Like the game, it always puts a straight piece
between two curves, so a full 90° turn is curve A, half-diagonal, curve B,
diagonal, curve B, half-diagonal, curve A.

## How it works

**`packages/renderer/src/railGeometry.ts`: the geometry.**
- Every rail piece joins two rail ends: a point, plus a 16-way direction pointing out of the piece.
- The engine hard-codes this geometry; it isn't in the prototype data. The base tables were derived from the example blueprints and checked against the rail sprites.
- `railGeometry.test.ts` requires the examples' rails to connect up end to end.
- The same file works out the tiles each piece covers (used for collision), the signal and train-stop slots, and a footprint for hover and selection.

**`packages/renderer/src/railPlanner.ts`: the planner.**
- A* over rail ends. From an end, any piece with an end at the same point facing back can follow, and its far end becomes the next state.
- Cost is track length plus the prototypes' `extra_planner_penalty`. A curve can't directly follow another curve.
- `supportsFor` places rail supports so that every elevated piece stays within `support_range` of a support or of the ramp it climbed out of.

**`packages/renderer/src/railPlacement.ts`: the link to the blueprint.**
- Rebuilt once per edit. It records which tiles are taken, where track ends, and where signals can go.
- `render.ts` uses it to drive the preview, and the app commits each placement through `onPlaceRails`.

**Drawing.**
- Each of a rail's five pieces gets its own render tier: `Layer.RailStonePathLower` up to `Layer.RailMetal`. Where tracks cross, every bed therefore paints under every rail.
- Elevated rails use the same five tiers, above all ground objects (`Layer.ElevatedRail*`).

## Refreshing the rail data

All rail entries in `render-catalog.json` come from the real prototypes. The
full pipeline produces them (`render-catalog.ts`: `railGraphics`,
`railRampGraphics`, `railSupportGraphics`).

When only rail data is at hand, `merge-rail-catalog` rebuilds just those
entries and copies their sprite sheets. Its inputs:
- a rail-only export, as on the `claude/rail-pipeline-data` branch: `rail-data/rail-prototypes.json` plus `rail-data/sprites/`
- or the full dump and the Factorio data directory

```sh
RAIL_DUMP=rail-data/rail-prototypes.json RAIL_SPRITES=rail-data/sprites \
  npm run merge-rail-catalog --workspace=@factoriotools/data-pipeline
```

To make a new export, run `factorio --dump-data` with Space Age, Quality and
Elevated Rails enabled. Keep the prototype tables `straight-rail`,
`half-diagonal-rail`, `curved-rail-a`, `curved-rail-b`, the four `elevated-*`
rails, `rail-ramp`, `rail-support`, `rail-signal`, `rail-chain-signal`,
`train-stop` and `rail-planner`. Copy the PNGs they reference, keeping their
mod paths.

## Not done yet

- Signals and train stops on elevated track draw with their ground art. The
  prototypes carry `elevated_picture_set`, a 25-direction sheet with its own
  frame alignment table, which isn't extracted yet. Elevated track also offers
  no signal or stop slots.
- Rail fences (`fence_pictures`), the elevated rail endings and water
  reflections aren't drawn.
- Diagonal train stops aren't offered.
