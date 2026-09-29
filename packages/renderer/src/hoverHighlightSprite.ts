/** Loads Factorio's own cursor-box corner art (the rounded yellow bracket
 *  the game itself draws around whatever's under the cursor) so the hover
 *  overlay can stamp it at each corner of the hovered entity's footprint
 *  instead of a plain stroked rectangle. One 64x64 cell, cropped ahead of
 *  time from `core/graphics/cursor-boxes.png`'s top-left ("regular", full
 *  size) sprite — see [[apps/site/public/data/sprites/ui/cursor-box-corner.png]]. */

const SHEET_URL = "./data/sprites/ui/cursor-box-corner.png";

let sheet: HTMLImageElement | undefined;
let loadStarted = false;

/** Synchronous, for the draw loop — returns undefined until the sheet has
 *  loaded; triggers the load on first call otherwise, mirroring
 *  SpriteAtlas.get()'s "ask now, draw later" pattern. */
export function getHoverHighlightSprite(): HTMLImageElement | undefined {
  if (sheet) return sheet;
  if (!loadStarted) {
    loadStarted = true;
    const img = new Image();
    img.onload = () => {
      sheet = img;
    };
    img.onerror = () => console.warn(`hover highlight sprite failed to load: ${SHEET_URL}`);
    img.src = SHEET_URL;
  }
  return undefined;
}
