# Rails

How the blueprint editor draws, plans and places Factorio 2.0 track, and how to
refresh the rail data from the game.

## Using it

| Held item | What a click does |
| --- | --- |
| **Rail** | Starts the rail planner, which stays on the layer it starts from: ground track from ground track, elevated track from elevated track, a ramp's top or a rail support. Hovering a placed rail shows a green arrow: a press there starts building from the end on the cursor's half of that rail (mid-track too, to branch off). A click on open ground lays just the held straight piece; a drag from open ground lays it and plans on from it. Drag and release to lay track along the planned path. While a plan is active, the path previews from its end to the cursor and the next click lays it. Panning the camera (WASD) while the mouse is held voids that press: nothing is laid on release. |
| **Rail ramp** | Same planner, but the track crosses to the other layer: started on the ground it climbs a ramp and carries on elevated, started on elevated track (or a rail support) it comes down a ramp and carries on along the ground. The layer is fixed when the plan starts, so track laid on in stages stays up (or down) once it is there. On open ground the held piece is a ramp, which R turns 4 ways; a drag plans on from its top. |
| **Rail support** | Snaps under the nearest bare joint of elevated track within 3 tiles, turned to carry it. Anywhere else it stands where it is put; R turns it in 22.5° steps. |
| **Rail signal / chain signal** | Snaps to the nearest signal slot beside placed track, ground or elevated, facing the trains it stops. Which side of the track it goes on follows the cursor. Green handles mark every free signal spot on track within 12 tiles of the cursor, and the track shows the rail blocks signals divide it into: a line down the middle in each block's colour, ending at each signalled joint in a triangle on both sides pointing the way the signals there let trains through, or a diamond on both sides where signals face both ways. Away from track the ghost is red and nothing is placed. Over a spot that already has a signal (or the other spot on the same side of that joint), the ghost stays there in red rather than jumping to a free spot beside it. One click places at most one signal. |
| **Train stop** | Snaps to the slot beside a straight cardinal rail, on the right-hand side of travel. Larger green handles mark the free slots near the cursor. Over a slot that already has a stop, the ghost stays there in red rather than jumping to the free slot beside it, and a click places nothing. One click places at most one stop. |

- **Length limit.** One placement lays at most the rail item's
  `manual_length_limit` of track (22.5 tiles: 11 straights, or 3–4 curves),
  heading as close to the cursor as that gets. When no track can get any
  closer, a red X shows at the cursor instead.
- **Shift** lifts the limit: the plan reaches the cursor however long and
  winding it has to be.
- **R** turns the held straight piece in 45° steps (8 ways), and the
  direction a drag from open ground plans in. **Shift+R** turns it the other
  way.
- **Esc** or **right-click** drops the plan and keeps the rail in hand.
- **Q** over any rail, ground or elevated, picks up the rail item. Over a ramp, it picks up the ramp item.
- **Undo** reverses each placement in a single step.

Elevated track is drawn three tiles above its ground position, and that is
where it is pointed at: its hover box, the start arrow, signal handles, box
selection and the cursor a plan heads for are all up on the deck.

**Supports.** Every point of elevated track has to be within 11 tiles, along
the track, of a rail support, or within 9 of the top of a ramp. The planner
adds the fewest supports that keep a plan held, each under a joint between
two pieces and as far along as it can go, counting supports and ramps already
on the track it continues. A support can't stand on a building, ground track
or a ramp; when a stretch has no free joint in reach the plan can't be built
and the red X shows.

The planner routes around buildings. It crosses and reuses existing track, and
never lays a duplicate piece. It takes the tightest turn that fits: a minimal
90° corner is curve A, curve B, curve B, curve A, back to back.

## How it works

**`packages/renderer/src/railGeometry.ts`: the geometry.**
- Every rail piece joins two rail ends: a point, plus a 16-way direction pointing out of the piece.
- The engine hard-codes this geometry; it isn't in the prototype data. The base tables were derived from the example blueprints and checked against the rail sprites.
- `railGeometry.test.ts` requires the examples' rails to connect up end to end.
- The same file works out the tiles each piece covers (used for collision), the signal and train-stop slots, and a footprint for hover and selection.

**`packages/renderer/src/collision.ts`: what blocks what.** One rule for every placement, paste and box selection: footprints for most entities, but track blocks only the tiles it runs over, rails cross freely, elevated track stands above the ground, and signals and stops stand beside track. A ramp is solid from the ground to the deck, so nothing shares its tiles, track on either layer included. A rail support blocks by its own 2.78-tile box, which turns with it: a 4×4 block of tiles under a cardinal one, a diamond under a diagonal one. A signal on elevated track collides with nothing on the ground.

**`packages/renderer/src/railPlanner.ts`: the planner.**
- A* over rail ends. From an end, any piece with an end at the same point facing back can follow, and its far end becomes the next state.
- Cost is track length plus the prototypes' `extra_planner_penalty`.
- A ramp takes the track to the layer the plan is headed for, and blocks by its tiles like any building.
- `supportsFor` places rail supports so that every stretch of deck stays within `support_range` of a support or of a ramp's top.

**`packages/renderer/src/railPlacement.ts`: the link to the blueprint.**
- Rebuilt once per edit. It records which tiles are taken on each layer, where track ends, what holds elevated track up, and where signals and supports can go.
- `render.ts` uses it to drive the preview, and the app commits each placement through `onPlaceRails`.

**Drawing.**
- Each of a rail's five pieces gets its own render tier: `Layer.RailStonePathLower` up to `Layer.RailMetal`. Where tracks cross, every bed therefore paints under every rail.
- Elevated rails use the same five tiers, above all ground objects (`Layer.ElevatedRail*`).
- Track stops in an end cap (`rail_endings`) at every end no other track carries on from, ground and elevated; a rail's hover box takes the cap in.
- Elevated rails and ramps carry their guard rails (`fence_pictures`, both sides) over the track.
- A rail support has 8 facings in 22.5° steps (the 16-way direction folded in half, since it looks the same from both sides); its direction is that of the track it carries.
- A signal on elevated track keeps the blueprint's `rail_layer` (`PlacedEntity.railLayer`). Its position is the spot on the ground below.

## Refreshing the rail data

All rail entries in `render-catalog.json` come from the real prototypes. The
full pipeline produces them (`render-catalog.ts`: `railGraphics`,
`railRampGraphics`, `railSupportGraphics`, `railFenceLayers`).

When only rail data is at hand, `merge-rail-catalog` rebuilds just those
entries and copies their sprite sheets. Its inputs:
- a rail-only export (see below for making one): `rail-data/rail-prototypes.json` plus `rail-data/sprites/`
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

- Signals on elevated track draw with their ground art, lifted onto the deck.
  The prototypes carry `elevated_picture_set`, a 25-direction sheet with its
  own frame alignment table, which isn't extracted yet.
- Guard rails (`fence_pictures`) run the full length of both sides of every
  elevated piece and ramp. The game leaves them off where track branches and
  caps them with end pieces; neither is done.
- Ramps have no end caps, and water reflections aren't drawn.
- Diagonal train stops aren't offered.
