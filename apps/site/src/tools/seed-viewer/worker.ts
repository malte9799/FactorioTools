/** Map generation off the main thread. One of a small pool: each worker
 *  holds its own compiled surface for the current seed and answers tile,
 *  patch and survey requests. */
import {
  MapSurface, type EnemyBase, type LayerColors, type MapGenData, type MapGenOptions, type PatchAmount, type PatchMeasure, type ResourceLayer,
  type ResourcePatch, type TileLayer,
} from "@factoriotools/mapgen";

export type PatchInfo = ResourcePatch & PatchAmount;

export type WorkerRequest =
  | { type: "init"; generation: number; data: MapGenData | null; options: MapGenOptions }
  | { type: "tile"; generation: number; key: string; x0: number; y0: number; size: number; step: number; trees: boolean }
  | { type: "survey"; generation: number; radius: number }
  | { type: "patch"; generation: number; request: number; x: number; y: number };

export type WorkerResponse =
  | { type: "ready"; generation: number; tiles: TileLayer[]; resources: ResourceLayer[]; colors: LayerColors; startingAreaRadius: number }
  | { type: "tile"; generation: number; key: string; tile: Uint8Array; resource: Uint8Array; enemy: Uint8Array; trees: Uint8Array; cliff: Uint8Array }
  | { type: "survey"; generation: number; patches: PatchInfo[]; bases: EnemyBase[] }
  | { type: "patch"; generation: number; request: number; patch: PatchMeasure | null }
  | { type: "error"; generation: number; message: string };

/** The slice of the worker global this file uses. Declared here rather than
 *  pulling in the WebWorker lib, which clashes with the DOM lib the rest of
 *  the site is checked against. */
const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
let data: MapGenData | null = null;
let surface: MapSurface | null = null;

function reply(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/** Every patch with its centre within `radius` of spawn, measured. */
function survey(map: MapSurface, radius: number): PatchInfo[] {
  const patches: PatchInfo[] = [];
  // Two spots of one resource can grow into a single patch; list it once.
  const seen = new Set<string>();
  for (const patch of map.resourcePatches(-radius, -radius, radius, radius)) {
    let measured = map.measurePatch(patch.x, patch.y);
    if (!measured || measured.resource !== patch.resource) {
      // Nothing of this resource at the centre: water, or an overlapping
      // patch of another resource drawn over it. Look for the nearest tile
      // that is, within the patch's own radius.
      const r = Math.ceil(patch.radius);
      const side = r * 2 + 1;
      const grid = map.sample(patch.x - r, patch.y - r, side, side, 1);
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < grid.resource.length; k++) {
        if (grid.resource[k] !== patch.resource + 1) continue;
        const d = Math.hypot((k % side) - r, Math.floor(k / side) - r);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      // Drowned, or covered entirely.
      if (best < 0) continue;
      measured = map.measurePatch(patch.x - r + (best % side), patch.y - r + Math.floor(best / side));
      if (!measured) continue;
    }
    const key = `${measured.resource}:${measured.x0}:${measured.y0}:${measured.tiles}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An oil field the game puts no well in is not worth listing.
    if (measured.entities === 0) continue;
    patches.push({ ...patch, amount: measured.amount, tiles: measured.tiles, entities: measured.entities });
  }
  return patches;
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "init") {
      // The data is sent once; a new seed only sends new options.
      if (req.data) data = req.data;
      if (!data) throw new Error("map data was never sent");
      surface = new MapSurface(data, req.options);
      reply({
        type: "ready", generation: req.generation, tiles: surface.tiles, resources: surface.resources, colors: surface.colors,
        startingAreaRadius: surface.startingAreaRadius,
      });
      return;
    }
    if (!surface) throw new Error("no surface yet");
    switch (req.type) {
      case "tile": {
        const grid = surface.sample(req.x0, req.y0, req.size, req.size, req.step, { trees: req.trees, cliffs: true, wells: true });
        reply(
          { type: "tile", generation: req.generation, key: req.key, tile: grid.tile, resource: grid.resource, enemy: grid.enemy, trees: grid.trees, cliff: grid.cliff },
          [grid.tile.buffer, grid.resource.buffer, grid.enemy.buffer, grid.trees.buffer, grid.cliff.buffer],
        );
        break;
      }
      case "survey": {
        const r = req.radius;
        reply({ type: "survey", generation: req.generation, patches: survey(surface, r), bases: surface.enemyBases(-r, -r, r, r) });
        break;
      }
      case "patch": {
        const patch = surface.measurePatch(req.x, req.y);
        reply({ type: "patch", generation: req.generation, request: req.request, patch }, patch ? [patch.mask.buffer] : []);
        break;
      }
    }
  } catch (error) {
    reply({ type: "error", generation: req.generation, message: error instanceof Error ? error.message : String(error) });
  }
};
