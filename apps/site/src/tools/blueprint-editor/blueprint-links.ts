/**
 * Blueprint-site links → blueprint strings.
 *
 * The site is static (GitHub Pages), so every lookup runs in the browser and
 * only works where the blueprint site allows cross-origin reads:
 *
 * - factorioprints.com keeps its blueprints in a public Firebase Realtime
 *   Database; `/blueprints/<id>/blueprintString.json` returns just the
 *   string (the whole record also carries a multi-MB image).
 * - fprints.xyz reads from Supabase with the public browser ("anon") key
 *   shipped in its own bundle. If they rotate it, this lookup breaks and the
 *   key needs copying again from fprints.xyz's index-*.js.
 * - factorioblueprints.tech sends no CORS headers on any endpoint, so a
 *   browser app can't read it; the user gets told to copy the string from
 *   the page instead.
 *
 * Each backend must also be listed in index.html's CSP connect-src. Other
 * sites get a "not supported" message rather than a blind fetch the CSP
 * would block anyway. A pasted blueprint string (rather than a link) is
 * passed straight through.
 */

const FACTORIOPRINTS_DB = "https://facorio-blueprints.firebaseio.com";
const FPRINTS_SUPABASE = "https://tutpmokznoxsgodpklag.supabase.co";
const FPRINTS_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1dHBtb2t6bm94c2dvZHBrbGFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzEzMDQwODgsImV4cCI6MjA0Njg4MDA4OH0.sa0iS2etN1Vr4nLv7kyJ7cn8Q1uOaCegJzMtUVMQXNc";

/** Where "Share on …" sends the user after copying the string: each site's
 *  own upload page (both need an account, and neither has an upload API). */
export const SHARE_TARGETS = [
  { name: "factorioprints.com", url: "https://factorioprints.com/create" },
  { name: "fprints.xyz", url: "https://fprints.xyz/my-blueprints" },
] as const;

export class BlueprintLinkError extends Error {}

/** A blueprint string as the game exports it: version byte "0" + base64. */
export function looksLikeBlueprintString(text: string): boolean {
  return /^0[A-Za-z0-9+/=\s]{20,}$/.test(text.trim());
}

type LinkSource =
  | { site: "factorioprints"; id: string }
  | { site: "fprints"; id: string }
  | { site: "factorioblueprints.tech"; id: string }
  | { site: "other"; host: string };

export function parseBlueprintLink(text: string): LinkSource | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "factorioprints.com" && parts[0] === "view" && parts[1]) return { site: "factorioprints", id: parts[1] };
  if (host === "fprints.xyz" && parts[0] === "blueprint" && parts[1]) return { site: "fprints", id: parts[1] };
  if (host === "factorioblueprints.tech" && parts[0] === "page" && parts[1]) return { site: "factorioblueprints.tech", id: parts[1] };
  return { site: "other", host };
}

/** Resolve a link (or a pasted string) to a blueprint string. Throws
 *  BlueprintLinkError with a message fit to show the user. */
export async function resolveBlueprintLink(text: string): Promise<string> {
  if (looksLikeBlueprintString(text)) return text.trim();
  const source = parseBlueprintLink(text);
  if (!source) throw new BlueprintLinkError("That isn't a link or a blueprint string.");

  switch (source.site) {
    case "factorioprints": {
      const res = await get(`${FACTORIOPRINTS_DB}/blueprints/${encodeURIComponent(source.id)}/blueprintString.json`);
      const value = (await res.json()) as unknown;
      if (typeof value !== "string" || !value) throw new BlueprintLinkError("factorioprints.com has no blueprint under that link.");
      return value;
    }
    case "fprints": {
      const res = await get(
        `${FPRINTS_SUPABASE}/rest/v1/blueprints?id=eq.${encodeURIComponent(source.id)}&select=blueprint_string`,
        { apikey: FPRINTS_ANON_KEY },
      );
      const rows = (await res.json()) as Array<{ blueprint_string?: string | null }>;
      const value = rows[0]?.blueprint_string;
      if (!value) throw new BlueprintLinkError("fprints.xyz has no blueprint under that link.");
      return value;
    }
    case "factorioblueprints.tech":
      throw new BlueprintLinkError(
        "factorioblueprints.tech doesn't let other sites read its blueprints — copy the string from the page and import from clipboard.",
      );
    case "other":
      throw new BlueprintLinkError(`Links from ${source.host} aren't supported — factorioprints.com and fprints.xyz are.`);
  }
}

async function get(url: string, headers?: Record<string, string>): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    // A CORS refusal and a dropped connection look the same from here.
    throw new BlueprintLinkError("Couldn't reach that site — it may not allow other sites to read it, or you're offline.");
  }
  if (!res.ok) throw new BlueprintLinkError(`The site answered ${res.status} — check the link.`);
  return res;
}
