/** Renders Factorio rich text (see packages/engine/src/richtext.ts) as
 *  HTML: coloured and bold runs, and inline icons for `[item=…]`,
 *  `[virtual-signal=…]`, `[img=type/name]` and the rest. Used wherever the
 *  app shows a text the game would render as rich text: blueprint names
 *  and descriptions, display panel messages, map labels. */

import { parseRichText, type RichRun } from "@factoriotools/engine";
import { escapeHtml } from "./html.js";
import { icon, iconHtml } from "./legacy-view/icons.js";

const textStyle = (r: Extract<RichRun, { kind: "text" }>): string => {
  const css: string[] = [];
  if (r.color) css.push(`color:${r.color}`);
  if (r.bold) css.push("font-weight:700");
  if (r.scale !== 1) css.push(`font-size:${r.scale}em`);
  return css.join(";");
};

/** A DocumentFragment of styled text spans and icon elements. Text only
 *  ever reaches the DOM as text nodes, so a label can't inject markup. */
export function renderRichLabel(label: string, iconSize = 16): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const r of parseRichText(label)) {
    if (r.kind === "icon") {
      const el = icon(r.name, r.name.replace(/-/g, " "), iconSize);
      el.classList.add("rich-text-icon");
      fragment.appendChild(el);
      continue;
    }
    const style = textStyle(r);
    if (!style) {
      fragment.appendChild(document.createTextNode(r.text));
      continue;
    }
    const span = document.createElement("span");
    span.style.cssText = style;
    span.textContent = r.text;
    fragment.appendChild(span);
  }
  return fragment;
}

/** The same as an HTML string, escaped, for markup rebuilt often (hover
 *  cards). */
export function richTextHtml(label: string, iconSize = 16): string {
  return parseRichText(label)
    .map((r) => {
      if (r.kind === "icon") return iconHtml(r.name, iconSize);
      const style = textStyle(r);
      return style ? `<span style="${style}">${escapeHtml(r.text)}</span>` : escapeHtml(r.text);
    })
    .join("");
}

/** Whether `label` has any markup at all — a plain label can skip the
 *  rich rendering. */
export function hasRichText(label: string): boolean {
  return parseRichText(label).some((r) => r.kind === "icon" || r.color !== undefined || r.bold || r.scale !== 1);
}
