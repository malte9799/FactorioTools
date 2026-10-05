/**
 * Blueprint files → blueprint strings, for "Import from file…" and for a
 * file dropped on the editor.
 *
 * Factorio itself has no per-blueprint file: everything in the game's
 * library lives in one binary blueprint-storage-2.dat, so what people keep
 * on disk is a text file holding an exported string. That file can be:
 *
 * - just the string (a .txt saved from the game's export box),
 * - the string among other text (notes, a forum post, a Markdown list) —
 *   the first string-shaped token is taken,
 * - a factorioprints.com / fprints.xyz link (resolved like a typed link),
 * - the decoded JSON envelope ({"blueprint": …} or {"blueprint_book": …}),
 *   re-encoded to a string here.
 *
 * .sbp / .sbpcfg are Satisfactory's blueprint files (its save folder is
 * %LOCALAPPDATA%\FactoryGame\…\blueprints\<session>) — a different game's
 * buildings in a binary format, so they get a message saying so rather
 * than a confusing decode error.
 */
import { encodeBlueprintString, type BlueprintEnvelope } from "@factoriotools/engine";
import { parseBlueprintLink } from "./blueprint-links.js";

export class BlueprintFileError extends Error {}

/** What a file held: a blueprint string, or a link still to be fetched. */
export type BlueprintFileContent = { kind: "string"; value: string } | { kind: "link"; value: string };

/** What the file picker offers. Satisfactory's files are listed on purpose,
 *  so picking one explains why it can't be read instead of being greyed out. */
export const BLUEPRINT_FILE_ACCEPT = ".txt,.json,.md,.bp,.blueprint,.sbp,.sbpcfg,text/plain,application/json";

/** Larger than any real blueprint string (a 10k-entity book is ~1 MB);
 *  stops a wrongly picked video from being read into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const SATISFACTORY_EXTENSIONS = new Set(["sbp", "sbpcfg"]);

/** A version-0 string inside running text: "0" then a long base64 run that
 *  doesn't start mid-word. */
const EMBEDDED_STRING = /(?:^|[^A-Za-z0-9+/=])(0[A-Za-z0-9+/]{40,}={0,2})/;

export async function readBlueprintFile(file: File): Promise<BlueprintFileContent> {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (SATISFACTORY_EXTENSIONS.has(ext)) {
    throw new BlueprintFileError(
      `${file.name} is a Satisfactory blueprint (.sbp/.sbpcfg), not a Factorio one. `
      + "Import a Factorio blueprint string instead — e.g. a .txt holding one exported from the game.",
    );
  }
  if (file.size > MAX_FILE_BYTES) throw new BlueprintFileError(`${file.name} is too large to be a blueprint file.`);
  return extractBlueprintText(await file.text(), file.name);
}

/** Finds the blueprint in a text file's contents. Throws BlueprintFileError
 *  with a message fit to show the user. */
export function extractBlueprintText(text: string, name = "That file"): BlueprintFileContent {
  // A binary file read as UTF-8 comes out with NULs and replacement chars.
  if (text.includes("\0")) throw new BlueprintFileError(`${name} isn't a text file — it should hold a blueprint string.`);
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new BlueprintFileError(`${name} is empty.`);

  // The whole file is one string (line breaks allowed: some editors wrap).
  const compact = trimmed.replace(/\s+/g, "");
  if (/^0[A-Za-z0-9+/]{20,}={0,2}$/.test(compact)) return { kind: "string", value: compact };

  if (trimmed.startsWith("{")) {
    const envelope = parseEnvelope(trimmed);
    if (envelope) return { kind: "string", value: encodeBlueprintString(envelope) };
  }

  const embedded = EMBEDDED_STRING.exec(trimmed);
  if (embedded) return { kind: "string", value: embedded[1]! };

  // A file holding just a link (a saved bookmark or a list of one).
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  const link = parseBlueprintLink(firstLine);
  if (link && link.site !== "other") return { kind: "link", value: firstLine };

  throw new BlueprintFileError(`No blueprint string found in ${name}.`);
}

function parseEnvelope(text: string): BlueprintEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.blueprint && typeof obj.blueprint === "object") return { blueprint: obj.blueprint } as BlueprintEnvelope;
  if (obj.blueprint_book && typeof obj.blueprint_book === "object") return { blueprint_book: obj.blueprint_book } as BlueprintEnvelope;
  return null;
}
