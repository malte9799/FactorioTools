#!/usr/bin/env node
/**
 * Builds apps/site/public/data/example-blueprints.json from
 * blueprint_book.txt (a real Space Age blueprint book-of-books at the repo
 * root) — every leaf blueprint, re-encoded standalone, so the app's "Load
 * an example" button can fetch this once and pick a random real blueprint
 * client-side instead of shipping one hand-picked (and, per user feedback,
 * not very good) fixture blueprint baked into the JS bundle.
 *
 * Blueprints with fewer than MIN_ENTITIES are dropped — a handful of leaves
 * in the book are single-tile scraps (e.g. one lone unnamed 1-entity
 * blueprint under Gleba) that make for a useless "example."
 *
 * Usage: node scripts/build-example-blueprints.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = path.join(__dirname, "../blueprint_book.txt");
const OUT_PATH = path.join(__dirname, "../apps/site/public/data/example-blueprints.json");
const MIN_ENTITIES = 3;

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

const kept = leaves.filter((l) => (l.blueprint.entities?.length ?? 0) >= MIN_ENTITIES);
const examples = kept.map((l) => ({
  label: l.blueprint.label || l.path,
  entities: l.blueprint.entities?.length ?? 0,
  bp: encode({ blueprint: l.blueprint }),
}));

writeFileSync(OUT_PATH, JSON.stringify(examples));
console.error(
  `Wrote ${OUT_PATH}: ${examples.length} example blueprints ` +
    `(${leaves.length - kept.length} dropped for < ${MIN_ENTITIES} entities), ` +
    `${(JSON.stringify(examples).length / 1024).toFixed(0)}KB.`,
);
