/** Loads the map-generation dataset the tests and dev scripts run against:
 *  the newest game version the data pipeline has written. */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MapGenData } from "../src/index.js";

const DIR = path.join(import.meta.dirname, "../../../apps/site/public/data/mapgen");

export function loadDataset(): MapGenData {
  const index = JSON.parse(readFileSync(path.join(DIR, "index.json"), "utf8")) as { file: string }[];
  return JSON.parse(readFileSync(path.join(DIR, index[0]!.file), "utf8")) as MapGenData;
}
