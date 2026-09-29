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
    label: "Green science 240/s",
    note: "Vulcanus: foundries, direct insertion, a chest buffer and rocket silos.",
    entities: async () => entitiesFromString(GREEN_SCIENCE),
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

/** A Vulcanus green science build that makes 240/s in game. */
const GREEN_SCIENCE =
  "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";

export function entitiesFromString(text: string): PlacedEntity[] {
  const env = decodeBlueprintString(text.trim());
  if (!env.blueprint) throw new Error("That's a blueprint book. Paste a single blueprint.");
  return normaliseEntities(env.blueprint);
}
