/** Icons for the planner, drawn from the same packed sheet the editor's
 *  panels use, plus a colour per item sampled from its own icon so a belt of
 *  copper reads copper and a pipe of petroleum reads purple. */

import { CELL, SHEET_URL, getIconPosition, getSheetSize, onIconsReady } from "../blueprint-editor/legacy-view/icons.js";
import { escapeHtml } from "../blueprint-editor/html.js";

export function iconsReady(): Promise<void> {
  return new Promise((resolve) => onIconsReady(resolve));
}

/** An icon as markup. `size` is the rendered pixel size. Blank if the sheet
 *  has no icon by that name. */
export function sprite(name: string, size: number, extraClass = ""): string {
  const pos = getIconPosition(name);
  const cls = `pl-sprite${extraClass ? ` ${extraClass}` : ""}`;
  if (!pos) return `<span class="${cls} is-missing" style="width:${size}px;height:${size}px"></span>`;
  const { width, height } = getSheetSize();
  const scale = size / CELL;
  return `<span class="${cls}" style="width:${size}px;height:${size}px;background:url(${SHEET_URL}) ${-pos.x * scale}px ${-pos.y * scale}px / ${width * scale}px ${height * scale}px no-repeat"></span>`;
}

/** An item-group tab icon (Logistics, Production, ...), from its own 128px sheet. */
export function groupSprite(iconPath: string, size: number): string {
  let file = iconPath.split("/").pop() ?? "";
  if (file === "military.png" || file === "combat.png") file = "military.png";
  return `<span class="pl-sprite" style="width:${size}px;height:${size}px;background:url(./data/sprites/item-groups/${escapeHtml(file)}) center / contain no-repeat"></span>`;
}

const colors = new Map<string, string>();
let colorsLoading: Promise<void> | null = null;

/** Samples every icon's average colour once. Weighted towards saturated
 *  pixels, so a grey-rimmed icon still reads by its coloured part. */
export function loadItemColors(names: string[]): Promise<void> {
  if (colorsLoading) return colorsLoading;
  colorsLoading = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const { width, height } = getSheetSize();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve();
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, width, height).data;
        for (const name of names) {
          const pos = getIconPosition(name);
          if (!pos) continue;
          let r = 0, g = 0, b = 0, w = 0;
          for (let y = pos.y; y < pos.y + CELL; y += 2) {
            for (let x = pos.x; x < pos.x + CELL; x += 2) {
              const i = (y * width + x) * 4;
              const a = data[i + 3]! / 255;
              if (a < 0.5) continue;
              const pr = data[i]!, pg = data[i + 1]!, pb = data[i + 2]!;
              const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
              const sat = max === 0 ? 0 : (max - min) / max;
              const weight = a * (0.15 + sat * sat * 3) * (0.3 + max / 255);
              r += pr * weight; g += pg * weight; b += pb * weight; w += weight;
            }
          }
          if (w > 0) colors.set(name, liven(r / w, g / w, b / w));
        }
      } catch {
        // A tainted canvas or no 2D context: flows fall back to neutral grey.
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = SHEET_URL;
  });
  return colorsLoading;
}

/** Pushes a sampled colour to a readable lightness on a dark background. */
function liven(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    const rr = r / 255, gg = g / 255, bb = b / 255;
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  s = Math.min(1, s * 1.35);
  const light = Math.min(0.68, Math.max(0.5, l * 1.1));
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(light * 100).toFixed(0)}%)`;
}

export function itemColor(name: string): string {
  return colors.get(name) ?? "hsl(30 8% 62%)";
}

/** The icon to draw for a recipe: its own, or for the few recipes the sheet
 *  has none for (scrap recycling, fluoroketone), what goes in or comes out. */
export function recipeIcon(recipe: { id: string; icon: string; ingredients: { item: string }[]; products: { item: string }[] }): string {
  if (getIconPosition(recipe.icon)) return recipe.icon;
  if (recipe.id.endsWith("-recycling") && recipe.ingredients[0]) return recipe.ingredients[0].item;
  return recipe.products[0]?.item ?? recipe.icon;
}
