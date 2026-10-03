export { parseExpression, type Ast } from "./parser.js";
export { Program, type CompileSettings, type ExprDef, type FnDef, type NoiseSource, type Node, type Op } from "./compiler.js";
export { Evaluator } from "./evaluator.js";
export {
  compileSettings, presetOptions, startingLakePosition, surfaceSeed, type AutoplaceControlValue, type AutoplaceEntry, type CliffOptions, type MapGenData,
  type MapGenOptions, type MapGenPreset,
} from "./settings.js";
export {
  MapSurface, unsupportedFunctions, type EnemyBase, type LayerColors, type PatchAmount, type PatchMeasure, type PlacedResource, type Probe, type ResourceLayer, type ResourcePatch,
  type Rgb, type SampleGrid, type SampleOptions, type TileLayer,
} from "./surface.js";
export { NO_SIDE, SIDES, cliffCode, cliffFrom, cliffName, cliffPieces, cliffTo, onCliffLine, trimCliffs, type OrientedBox } from "./cliffs.js";
export type { Spot, SpotParams } from "./spot.js";
export { CHUNK, chunkStreamSeed, placementGroups, rollChunk, type Attempt, type PlacementEntity } from "./placement.js";
