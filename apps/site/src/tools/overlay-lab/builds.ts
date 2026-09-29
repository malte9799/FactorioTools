/** Blueprints the lab opens with. The gear build is the concept page's test
 *  build made of real entities: a fast belt carrying iron (left lane) and
 *  copper (right lane) is split between a bus and a feed belt for four gear
 *  assemblers, each fed by one fast inserter, with the gears leaving under
 *  two pipes. The splitter sends half the iron to the bus, so the machines
 *  at the end of the feed belt go short on purpose. */
import { decodeBlueprintString, normaliseEntities, type PlacedEntity } from "@factoriotools/engine";
import type { LaneFeed } from "@factoriotools/sim";

export interface LabBuild {
  label: string;
  note: string;
  entities: () => Promise<PlacedEntity[]>;
  /** Input feeds to set instead of the guessed ones, by port tile. */
  feeds?: { x: number; y: number; left: LaneFeed | null; right: LaneFeed | null }[];
}

const N = 0, E = 4;

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
  add("fast-underground-belt", 29.5, 9.5, E, { undergroundType: "output" });
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
    note: "The last machine starves, the one before it runs half fed. Try the research switch.",
    entities: async () => gearBuild(),
    feeds: [{ x: 0, y: 3, left: { item: "iron-plate", rate: "full" }, right: { item: "copper-plate", rate: "full" } }],
  },
  {
    label: "Red science 240/s",
    note: "Stacked turbo belts, stack inserters, legendary machines and beacons.",
    entities: async () => entitiesFromString(RED_SCIENCE),
  },
  {
    label: "Belt labels",
    note: "A constant combinator and a display panel name what's on two belts.",
    entities: async () => entitiesFromString(BELT_LABELS),
  },
  { label: "Green Circuit", note: "Direct insertion from cable to circuit machines.", entities: () => fromExamples("Green Circuit") },
  { label: "Red Circuits", note: "Small and mostly healthy.", entities: () => fromExamples("Red Circuits") },
  { label: "Blue Circuits", note: "A mix of starved, arm-bound and full outputs.", entities: () => fromExamples("Blue Circuits") },
  { label: "Legendary Batteries", note: "Bulk inserters off a single belt.", entities: () => fromExamples("Legendary Batteries") },
];

/** A Space Age red science build that fills a stacked turbo belt in game. */
const RED_SCIENCE =
  "0eNrtW9lu4zgQ/Bc+SwPxJv0rgRHINpER1jpWR3aDwP++tJ1JvI5sd5PzwoGAID4kd5PNruoiRb6TzX5yXV81I1m9k2rbNgNZPb2ToXppyv3xu6asHVmRjSv9RZKRv6dyX41v/qu9e3HNruzfyCEjVbNz/5IVPWQzPy6HwdWbfdW85HW5/Vk1LucPTbHDOiOuGauxcudGnT68PTdTvXG995X9sj9O/abNx75shq7tx3zj9qO337WD/7FvtW/JsW3yh8yId5cza39I72lX9W57voOyY8uvPDCsB431wLEeFNaD+PQwjOX2r7xqBteP/sp32/bLtrm2LWZMyyDTFmJaYeNi/t/2GZM6wiQs1CZ7kPBXHhi9DvgcIjLivVbdyew0tnV5tJAP28o1W5d3PvCftzx//b5p+9pj0KNpdPUZPtXuApJd3+4m35lXf3te+/f7+5g8W/FGmueqefUdb/2Fk9WvTz7VTolAVsUxOrNX6M0r7OYVflgf/N/3gNvsGz3dwYu6E+IbURo653a/Kzz0ZnjoRXhudJUW2PS9gJwGpS+lQXhW18bNnG0Gt22wtq9JdPIFpH/pW/8KwPY5OOPbCWHtNHbTSOa8wImUMWwP5MNEZuJPSWSFZMnLXBMLS+JZkmp45tLrWD+o0/Sr5tVuV0117vb+/r7a5l27d/c9yJujOefJIgnwEoVyXhKwIsKmuGGToooSTxnLjEUxL7tk3qq5QbwMT++Xw8Rh9M4EioLTHjaJStEi6b6qIFFDIeTHdJCoKSCSgJkoaFFg1tuIKQtdijG+GPMCxTNJY4/TcKlnlglxSHaxEKlnQKs9nIdMgIyFsB0XMTX+o/2PhARHlT2jk4aeiikfRsECqqNGDTjx5gbDmIkPG2pFy4iU+yqKEGVmJISrBA1RZkZAuEpETXo+2v8w6wUPV2ZGLrUTXzsFagaYOPZkhDJjS3YFZJcKUmYMxHY6SJlxENuZqBoPW+IRuLJHU4aeLKLKRwEKqKThy7J3wjvniUXlB3CdQnIUN6edIAIDBm2S7mvQFgIN2kIgVYgG1AbCilLHgPij/Y+zPmJDwYePpUqjqrS0GJ5JG3uqCNeAWi3Zhc8uRUM0oFagDVMsRANqDWE7FfUETsMWkxSu7MmkoSejyoeABVRFjRpwnUJpFGOmPWwGlaIs6b7aIGXGIVyliyBlxiBcpWkUtIC7BTSLUGZ8qZ342qlRM8C0sadFhDIrluwKyC4ZpMwKENupIGVGQWwX9QROwxaTNKrsKZs09GxM+VCwB9GmiBk1BVw9MBTDmGkPm2GoFE16A7XhIcpMaQhXGRGizBRok7uJmvQo4G4Bo8KVmdJL7cTXToOaASaOPROuzNRyeCEku2yIMlOgwwu2CH9KplCHFywN0YBKQnjVRj2BU7DFJMtRBTbp7fFWhJ8KOfV8zibqhFdK8Vtn5B+foMcWPVGTyUzSTK6zp+NL5hEm1+uz02PXPw+bZ+TV9cOp81IxK6yVRijt/x0O/wEVUs8+";

/** Two belts labelled by a constant combinator and a display panel, plus a
 *  requester and an infinity chest. */
const BELT_LABELS =
  "0eNqlVX+PojAQ/S79u2xARYXkPsllQwqM2qS03f7wzhi++01B2V1BT5eYSGg7896beR3OpBQetOHSkfxMeKWkJfnvM7F8L5kIa5I1QHLivClV5AyTVivjohKEIy0lXNbwl+RJS+8GeTxi9kbh8zZs0b5TAtJxx6EH7l5OhfRNCQbz0ocEKNHKYrCSARUTbt5SSk4kj5bx9i1FoJobqPoD28DxJv/ixfzZi/mXQ34DHx6sAxNVB3yOUyefqddd6ktEseMCw2w4ZnusvlTX0lMynPi2egHWRlVgLZd77AQPwB+eCSSJe1KZBjtGSaUazQxzCjmTX92CD55I4jhu3/E3oW01QHC545j6dE/a8lbaNaCw4Bwy68QZaNQRCi97OVAX3EGDWzsmLHxXeQH+o1QNcoC9kE5jShrcwAPMRQJYtzk4dVJMOhajuYaxlvQpLVd+DBmHHGAqBGR76DqDsnCFoeXCezpmO8VwPTAMt9Qx6SLsWsll17VHN2E9cmoolXRGiaKEAzvy0Pav7vqZ07i0YHrBr1is99eE4g39zyB5JHozIdqddM9T+zCFRoDblwGzeYDZAFhzqwVD0zEJ4iHOVDfD4P5iO6Hwsh8Ysq+joSlTFU7iOSVO7ytW3t2RnMwY6atnRm4yY6Y/B7CcY5MniobfxDD5cOXz60zJEe9dF5CuF9kqy9Ltar3Bv7b9B4Qcl+A=";

export function entitiesFromString(text: string): PlacedEntity[] {
  const env = decodeBlueprintString(text.trim());
  if (!env.blueprint) throw new Error("That's a blueprint book. Paste a single blueprint.");
  return normaliseEntities(env.blueprint);
}
