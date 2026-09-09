import type { GameData, QualityName, RenderCatalog } from "@factoriotools/engine";
import { buildGridMenu, type GridMenuEntry, type GridMenuHandle } from "./grid-menu.js";

/** Every placeable entity, as grid-menu entries — the real game's own
 *  item-group -> item-subgroup -> item.order structure carries the grouping
 *  and ordering (RenderCatalog.menuPositions, resolved by the data pipeline
 *  from the dump's item-group table; confirmed by spike this is exactly what
 *  the in-game build menu sorts by, not a guessed categorization). An entity
 *  with no menuPositions entry has no item that places it, so it isn't
 *  directly placeable and is skipped rather than given an invented slot. */
function placeableEntries(data: GameData, catalog: RenderCatalog): GridMenuEntry[] {
  const protos = [
    ...Object.values(data.machines),
    ...Object.values(data.beacons),
    ...Object.values(data.belts),
    ...Object.values(data.inserters),
    ...Object.values(catalog.entities),
  ];

  const entries: GridMenuEntry[] = [];
  const seen = new Set<string>();
  for (const proto of protos) {
    if (seen.has(proto.name)) continue; // GameData takes precedence over catalog duplicates
    seen.add(proto.name);
    const position = catalog.menuPositions[proto.name];
    if (!position) continue;
    entries.push({ name: proto.name, localised: proto.localised, position });
  }
  return entries;
}

/** Builds the build menu — the placeable-entity picker, using the shared
 *  grid-menu body (see grid-menu.ts) so it is structurally identical to the
 *  recipe and module pickers. `onPick` fires on confirm (the green check, or
 *  'E' via the caller's own key handling), not on a plain cell click, so
 *  every menu in the tool commits the same way. */
export function buildPalette(
  container: HTMLElement,
  data: GameData,
  catalog: RenderCatalog,
  initialQuality: QualityName,
  onPick: (entityName: string, quality: QualityName) => void,
  onCancel: () => void,
): GridMenuHandle {
  return buildGridMenu(container, {
    entries: placeableEntries(data, catalog),
    groups: catalog.menuGroups,
    filterLabel: "Filter placeable entities",
    showQuality: true,
    initialQuality,
    onConfirm: ({ name, quality }) => onPick(name, quality),
    onCancel,
  });
}
