/** Where a paste ghost's anchor lands for a cursor at `cursor`, when the
 *  ghost snaps to whole tiles: the copied position shifted by a whole number
 *  of tiles. The anchor is the group's centre, which is NOT on a tile corner
 *  for a group of odd width (one belt, one assembler: x.5), and rounding it
 *  to a whole tile would slide the stamp half a tile off the grid hand
 *  placement uses. Keeping the anchor's own fraction keeps every stamped
 *  entity exactly as far from the grid as the original was. */
export function snapAnchorToTiles(cursor: { x: number; y: number }, anchor: { x: number; y: number }): { x: number; y: number } {
  return {
    x: anchor.x + Math.round(cursor.x - anchor.x),
    y: anchor.y + Math.round(cursor.y - anchor.y),
  };
}
