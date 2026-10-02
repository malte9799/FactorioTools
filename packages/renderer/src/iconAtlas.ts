/** Loads the packed icon sheet (recipe/item/module icons, keyed by plain
 *  prototype name — the same sheet apps/site's legacy-view/icons.ts uses for
 *  panel/tooltip icons) so alt-mode overlays (entityDraw.ts's
 *  drawAltModeOverlay) can `drawImage` icon cells directly onto the canvas,
 *  mirroring Factorio's own alt-mode: a small recipe icon centered on a
 *  crafting machine, module icons in a row beneath it. */

import { fetchSprite } from "./spriteCache.js";

const SHEET_URL = "./data/sprites/icons.png";
const MANIFEST_URL = "./data/sprite-icon-manifest.json";

export interface IconCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class IconAtlas {
  private sheet: HTMLImageElement | undefined;
  private cells: Map<string, IconCell> | undefined;
  private ready: Promise<void>;

  constructor() {
    this.ready = Promise.all([
      fetch(MANIFEST_URL)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`icon manifest ${res.status}`))))
        .then((manifest: { icons: { id: string; x: number; y: number; w: number; h: number }[] }) => {
          this.cells = new Map(manifest.icons.map((i) => [i.id, i]));
        }),
      // Through the persistent sprite cache (see spriteCache.ts), then
      // handed to the <img> as an object URL.
      fetchSprite(SHEET_URL).then(
        (blob) =>
          new Promise<void>((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              this.sheet = img;
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              reject(new Error("icon sheet failed to load"));
            };
            img.src = objectUrl;
          }),
      ),
    ])
      .then(() => undefined)
      .catch((err) => {
        // Icons are decoration for the alt-mode overlay, not required for
        // the underlying entity render — fail quiet, mirroring SpriteAtlas's
        // own graceful-degradation philosophy.
        console.warn(err.message);
      });
  }

  /** Synchronous, for the draw loop — returns undefined until both the
   *  manifest and sheet have resolved, or if `name` has no icon. */
  get(name: string): { sheet: HTMLImageElement; cell: IconCell } | undefined {
    if (!this.sheet || !this.cells) return undefined;
    const cell = this.cells.get(name);
    if (!cell) return undefined;
    return { sheet: this.sheet, cell };
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }
}

// See spriteAtlas.ts's getSharedSpriteAtlas() for why this is a module-level
// singleton rather than per-mount state: the icon sheet is small compared to
// the entity sprites, but there's no reason to re-fetch/re-decode it either.
let sharedIconAtlas: IconAtlas | undefined;

export function getSharedIconAtlas(): IconAtlas {
  if (!sharedIconAtlas) sharedIconAtlas = new IconAtlas();
  return sharedIconAtlas;
}
