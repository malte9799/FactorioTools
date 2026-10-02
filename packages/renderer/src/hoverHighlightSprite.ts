/** Loads Factorio's own UI overlay sheets, copied as-is from the game's
 *  core/graphics: cursor-boxes.png (the rounded corner brackets the game
 *  draws around whatever's under the cursor, one row per colour, one column
 *  per size tier) and arrows/underground-lines.png (the dashed tunnel line
 *  drawn between a hovered underground and its pair). */

const CURSOR_BOXES_URL = "./data/sprites/ui/cursor-boxes.png";
const UNDERGROUND_LINES_URL = "./data/sprites/ui/underground-lines.png";

const sheets = new Map<string, HTMLImageElement | null>();

/** Synchronous, for the draw loop — returns undefined until the sheet has
 *  loaded; triggers the load on first call otherwise, mirroring
 *  SpriteAtlas.get()'s "ask now, draw later" pattern. */
function getSheet(url: string): HTMLImageElement | undefined {
  if (sheets.has(url)) return sheets.get(url) ?? undefined;
  sheets.set(url, null);
  const img = new Image();
  img.onload = () => sheets.set(url, img);
  img.onerror = () => console.warn(`UI sprite failed to load: ${url}`);
  img.src = url;
  return undefined;
}

export function getHoverHighlightSprite(): HTMLImageElement | undefined {
  return getSheet(CURSOR_BOXES_URL);
}

export function getUndergroundLinesSprite(): HTMLImageElement | undefined {
  return getSheet(UNDERGROUND_LINES_URL);
}
