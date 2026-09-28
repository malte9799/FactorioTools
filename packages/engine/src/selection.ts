import type { PlacedEntity, WireLink } from "./types.js";

/** Clones a subset of entities with fresh entityNumbers starting at
 *  `startNumber`, remapping wires whose BOTH endpoints are within the
 *  subset; a wire touching anything outside the subset is dropped rather
 *  than left dangling. Positions are left untouched relative to each other
 *  — the caller (the paste-ghost's placement) applies an anchor offset
 *  separately.
 *
 *  Called once per paste-ghost STAMP, not once at copy time: the ghost
 *  stays armed for repeated stamping (see render.ts's 'paste' interaction
 *  mode), and each stamp needs entity numbers that don't collide with
 *  anything placed by an earlier stamp or by any other edit made while the
 *  ghost was armed. */
export function remapSelectionForPaste(
  entities: PlacedEntity[],
  wires: WireLink[],
  startNumber: number,
): { entities: PlacedEntity[]; wires: WireLink[]; nextNumber: number } {
  const idMap = new Map<number, number>();
  let next = startNumber;
  const newEntities = entities.map((e) => {
    const newNumber = next++;
    idMap.set(e.entityNumber, newNumber);
    return { ...e, entityNumber: newNumber, modules: e.modules.map((m) => ({ ...m })) };
  });
  const newWires: WireLink[] = [];
  for (const w of wires) {
    const from = idMap.get(w.from);
    const to = idMap.get(w.to);
    if (from === undefined || to === undefined) continue;
    newWires.push({ ...w, from, to });
  }
  return { entities: newEntities, wires: newWires, nextNumber: next };
}
