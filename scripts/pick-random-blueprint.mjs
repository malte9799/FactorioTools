#!/usr/bin/env node
/**
 * Dev-only test helper: picks a random individual blueprint out of
 * blueprint_book.txt (a real Space Age blueprint book-of-books, 177 leaf
 * blueprints across Nauvis/Space/Vulcanus/Fulgora/Gleba/etc.) and prints it
 * as a standalone, re-encoded blueprint string — for exercising the
 * renderer against real, varied, un-curated blueprints instead of only the
 * two hand-picked test fixtures used so far. Not part of the app itself.
 *
 * Usage: node scripts/pick-random-blueprint.mjs [--seed <name-substring>]
 */
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = path.join(__dirname, "../blueprint_book.txt");

function decode(bpString) {
  const buf = Buffer.from(bpString.trim().slice(1), "base64");
  return JSON.parse(inflateSync(buf).toString("utf-8"));
}

function encode(envelope) {
  const deflated = deflateSync(JSON.stringify(envelope), { level: 9 });
  return "0" + deflated.toString("base64");
}

function collectLeafBlueprints(envelope, pathParts, out) {
  if (envelope.blueprint) {
    out.push({ path: pathParts.concat(envelope.blueprint.label ?? "(unnamed)").join(" / "), blueprint: envelope.blueprint });
  } else if (envelope.blueprint_book) {
    for (const entry of envelope.blueprint_book.blueprints ?? []) {
      collectLeafBlueprints(entry, pathParts.concat(envelope.blueprint_book.label ?? "(unnamed book)"), out);
    }
  }
}

const raw = readFileSync(BOOK_PATH, "utf-8");
const book = decode(raw);
const leaves = [];
collectLeafBlueprints(book, [], leaves);

const seedArgIndex = process.argv.indexOf("--seed");
const filter = seedArgIndex !== -1 ? process.argv[seedArgIndex + 1]?.toLowerCase() : undefined;
const candidates = filter ? leaves.filter((l) => l.path.toLowerCase().includes(filter)) : leaves;

if (candidates.length === 0) {
  console.error(`No blueprint matches filter "${filter}". ${leaves.length} total available.`);
  process.exit(1);
}

const pick = candidates[Math.floor(Math.random() * candidates.length)];
const entityCount = pick.blueprint.entities?.length ?? 0;
console.error(`Picked: ${pick.path} (${entityCount} entities)`);
console.log(encode({ blueprint: pick.blueprint }));
