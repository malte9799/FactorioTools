/** Cargo hubs and bays tile their floor plating like an auto-tiled region:
 *  each of the entity's 4 edges gets a wall or a bridge depending on whether
 *  another platform-connectable entity sits flush against it, and each of
 *  its 4 corners gets an outer or inner corner piece depending on its two
 *  adjacent edges. Best-effort port of Factorio's own (unpublished) rule,
 *  inferred from the shape names Space Age ships — walls/corners/bridges is
 *  the same vocabulary the game's tile auto-tiler uses elsewhere. */

export interface PlatformBox {
  entityNumber: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EPS = 0.05;

/** True when `other` sits flush against `box`'s given edge — same span,
 *  touching edge to edge — which is how two adjacently-placed hubs/bays
 *  meet on Factorio's build grid. */
function flushNeighbour(
  box: PlatformBox,
  other: PlatformBox,
  edge: "top" | "right" | "bottom" | "left",
): boolean {
  switch (edge) {
    case "top":
      return Math.abs(other.bottom - box.top) < EPS && other.left < box.right - EPS && other.right > box.left + EPS;
    case "bottom":
      return Math.abs(other.top - box.bottom) < EPS && other.left < box.right - EPS && other.right > box.left + EPS;
    case "left":
      return Math.abs(other.right - box.left) < EPS && other.top < box.bottom - EPS && other.bottom > box.top + EPS;
    case "right":
      return Math.abs(other.left - box.right) < EPS && other.top < box.bottom - EPS && other.bottom > box.top + EPS;
  }
}

export function classifyPlatformEdges(box: PlatformBox, neighbours: PlatformBox[]): {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
} {
  const test = (edge: "top" | "right" | "bottom" | "left") =>
    neighbours.some((n) => n.entityNumber !== box.entityNumber && flushNeighbour(box, n, edge));
  return { top: test("top"), right: test("right"), bottom: test("bottom"), left: test("left") };
}

/** Picks the shape names for one entity's edges and corners from which sides
 *  connect. An edge with a flush neighbour draws as a bridge instead of a
 *  wall; each corner draws an outer piece only when NEITHER adjacent edge
 *  connects (a fully open corner) — an inner corner needs knowing about a
 *  third hub diagonally placed to close that corner off, which this
 *  best-effort version doesn't attempt, so a connected corner draws nothing
 *  rather than guess at art that may not fit. */
export function classifyPlatform(box: PlatformBox, neighbours: PlatformBox[]): string[] {
  const { top, right, bottom, left } = classifyPlatformEdges(box, neighbours);
  const shapes: string[] = [];
  shapes.push(top ? "bridge_horizontal_wide" : "top_wall");
  shapes.push(right ? "bridge_vertical_wide" : "right_wall");
  shapes.push(bottom ? "bridge_horizontal_wide" : "bottom_wall");
  shapes.push(left ? "bridge_vertical_wide" : "left_wall");
  if (!top && !left) shapes.push("top_left_outer_corner");
  if (!top && !right) shapes.push("top_right_outer_corner");
  if (!bottom && !left) shapes.push("bottom_left_outer_corner");
  if (!bottom && !right) shapes.push("bottom_right_outer_corner");
  return shapes;
}
