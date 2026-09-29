/** Positions along a lane are integers in 1/256 of a tile, the game's own
 *  fixed-point unit, so belt movement is exact and never drifts. */
export const TILE = 256;

/** Minimum distance between two items on one lane: a quarter tile, i.e.
 *  four items per lane per straight tile. */
export const ITEM_SPACING = 64;

/** Lane lengths through a 90° curve, in 1/256 tile.
 *
 *  UNVERIFIED against the game: derived from quarter-circle arcs through the
 *  lane centre lines (radius 0.25 tile inner, 0.75 tile outer), which is the
 *  geometry the renderer draws. Only curve capacity depends on these —
 *  throughput through a curve is the same either way, since every lane moves
 *  at belt speed. Replace with the game's exact numbers once confirmed. */
export const CURVE_INNER_LENGTH = Math.round((TILE * Math.PI) / 8); // 101
export const CURVE_OUTER_LENGTH = Math.round((TILE * 3 * Math.PI) / 8); // 302

/** Ticks per second. */
export const TICKS_PER_SECOND = 60;
