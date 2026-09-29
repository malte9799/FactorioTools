/** Blueprints the lab opens with. The gear build is the concept page's test
 *  build made of real entities: a fast belt carrying iron (left lane) and
 *  copper (right lane) is split between a bus and a feed belt for four gear
 *  assemblers, each fed by one fast inserter, with the gears leaving under
 *  two pipes. It has one starved machine and three arm-bound ones on
 *  purpose. */
import { decodeBlueprintString, normaliseEntities, type PlacedEntity } from "@factoriotools/engine";
import type { LaneFeed } from "@factoriotools/sim";

export interface LabBuild {
  label: string;
  note: string;
  entities: () => Promise<PlacedEntity[]>;
  /** Input feeds to set instead of the guessed ones, by port tile. */
  feeds?: { x: number; y: number; left: LaneFeed | null; right: LaneFeed | null }[];
}

const N = 0, E = 4, W = 12;

function gearBuild(): PlacedEntity[] {
  const out: PlacedEntity[] = [];
  let n = 1;
  const add = (name: string, x: number, y: number, direction = 0, extra: Partial<PlacedEntity> = {}) =>
    out.push({ entityNumber: n++, name, x, y, direction, quality: "normal", modules: [], filterItems: [], ...extra });
  const belt = (x: number, y: number, d = E) => add("fast-transport-belt", x + 0.5, y + 0.5, d);
  for (let x = 0; x <= 5; x++) belt(x, 3);
  add("fast-splitter", 6.5, 3, E);
  for (let x = 7; x <= 31; x++) belt(x, 2);
  for (let x = 7; x <= 25; x++) belt(x, 3);
  for (let x = 9; x <= 25; x++) belt(x, 9);
  add("fast-underground-belt", 26.5, 9.5, E, { undergroundType: "input" });
  add("fast-underground-belt", 29.5, 9.5, W, { undergroundType: "output" });
  belt(30, 9);
  belt(31, 9);
  for (let i = 0; i < 4; i++) {
    const x = 10 + 4 * i;
    add("assembling-machine-2", x + 1.5, 6.5, N, { recipe: "iron-gear-wheel" });
    add("fast-inserter", x + 1.5, 4.5, N);
    add("fast-inserter", x + 1.5, 8.5, N);
  }
  for (const x of [9, 13, 17, 21, 25]) add("medium-electric-pole", x + 0.5, 6.5);
  for (const x of [27, 28]) for (let y = 6; y <= 11; y++) add("pipe", x + 0.5, y + 0.5);
  return out;
}

async function fromExamples(label: string): Promise<PlacedEntity[]> {
  const res = await fetch("./data/example-blueprints.json");
  const all = (await res.json()) as { label: string; bp: string }[];
  const found = all.find((e) => e.label === label);
  if (!found) throw new Error(`example "${label}" not found`);
  const env = decodeBlueprintString(found.bp);
  if (!env.blueprint) throw new Error(`"${label}" is a book, not a blueprint`);
  return normaliseEntities(env.blueprint);
}

export const BUILDS: LabBuild[] = [
  {
    label: "Gear test build",
    note: "One starved machine, three limited by their arm. Try splitter priority.",
    entities: async () => gearBuild(),
    feeds: [{ x: 0, y: 3, left: { item: "iron-plate", rate: "full" }, right: { item: "copper-plate", rate: "full" } }],
  },
  { label: "Green Circuit", note: "Direct insertion from cable to circuit machines.", entities: () => fromExamples("Green Circuit") },
  { label: "Red Circuits", note: "Small and mostly healthy.", entities: () => fromExamples("Red Circuits") },
  { label: "Blue Circuits", note: "A mix of starved, arm-bound and full outputs.", entities: () => fromExamples("Blue Circuits") },
  { label: "Legendary Batteries", note: "Bulk inserters off a single belt.", entities: () => fromExamples("Legendary Batteries") },
];

export function entitiesFromString(text: string): PlacedEntity[] {
  const env = decodeBlueprintString(text.trim());
  if (!env.blueprint) throw new Error("That's a blueprint book. Paste a single blueprint.");
  return normaliseEntities(env.blueprint);
}
