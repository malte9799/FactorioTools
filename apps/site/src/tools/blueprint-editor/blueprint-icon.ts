/** A blueprint-like item's icon as the game draws it: the item's own art
 *  (blueprint, book, planner) with the blueprint's own icons laid over it.
 *  Used by the edit dialog's preview and the library sidebar's rows.
 *
 *  Proportions measured off the game's blueprint art: one icon ~73% of the
 *  art, centred; two or more ~47% each, centred on the art's quarter lines —
 *  side by side for two, a 2×2 grid for three or four (the third
 *  bottom-left). Gaps between set slots close up; the icons go in `index`
 *  order. */

import type { BpIcon } from "@factoriotools/engine";
import { icon } from "./legacy-view/icons.js";

export function blueprintIcon(itemName: string, icons: readonly BpIcon[], size: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "bp-composed-icon";
  wrap.style.width = wrap.style.height = `${size}px`;
  wrap.appendChild(icon(itemName, "", size));

  const signals = [...icons]
    .filter((i) => i?.signal?.name)
    .sort((a, b) => a.index - b.index)
    .slice(0, 4)
    .map((i) => i.signal);
  if (signals.length === 0) return wrap;

  const cell = Math.round((size * (signals.length === 1 ? 47 : 30)) / 64);
  const gap = Math.max(1, Math.round((size * 2) / 64));
  const overlay = document.createElement("span");
  overlay.className = "bp-composed-icon-grid";
  overlay.style.gridTemplateColumns = signals.length === 1 ? `${cell}px` : `repeat(2, ${cell}px)`;
  overlay.style.gridAutoRows = `${cell}px`;
  overlay.style.gap = `${gap}px`;
  for (const signal of signals) {
    const holder = document.createElement("span");
    holder.className = "bp-composed-icon-cell";
    holder.appendChild(icon(signal.name, "", cell));
    if (signal.quality && signal.quality !== "normal") holder.appendChild(qualityBadge(signal.quality, Math.max(6, Math.round(cell * 0.42))));
    overlay.appendChild(holder);
  }
  wrap.appendChild(overlay);
  return wrap;
}

/** The quality's own diamond icon, for the bottom-left corner of a slot. */
export function qualityBadge(quality: string, size: number): HTMLElement {
  const badge = icon(quality, quality, size);
  badge.classList.add("quality-badge");
  return badge;
}
