/** Renders a Factorio "rich text" label — plain text interleaved with
 *  `[type=name]` icon tags (item/entity/fluid/recipe/technology/quality/
 *  virtual-signal/tile/...), the syntax the game itself uses for blueprint
 *  and blueprint-book names set via the in-game rename dialog's icon
 *  picker. Only the `[type=name]` and `[type=name,quality=quality-name]`
 *  forms are parsed — those are the only ones the rename dialog can
 *  actually produce; colour/font tags and other rich-text markup exist in
 *  Factorio's wider text-rendering system but never end up in a save/load
 *  or blueprint-book label, so they're deliberately left unhandled (any
 *  tag this doesn't recognise, or a stray `[`/`]`, prints as literal text
 *  instead of vanishing silently). */

import { icon } from "./legacy-view/icons.js";

const TAG_PATTERN = /\[([a-z][a-z0-9-]*)=([a-z0-9][a-z0-9_-]*)(?:,quality=[a-z0-9][a-z0-9_-]*)?\]/gi;

/** Prototype-name types the icon sheet actually covers (see icons.ts's own
 *  doc comment — it's packed from items/entities/etc., not signals). A tag
 *  of a recognised TYPE but a name the sheet doesn't have falls through to
 *  icon()'s own "render nothing" handling for a missing sprite; a tag whose
 *  TYPE isn't in this set (virtual-signal, tile, quality, ...) has no sprite
 *  source at all, so it renders as a small placeholder square instead of
 *  silently disappearing — losing an icon entirely would make an otherwise
 *  descriptive name (e.g. a virtual-signal-only label) look blank. */
const ICON_TYPES = new Set(["item", "entity", "fluid", "recipe", "technology", "item-group", "armor", "capsule", "gun", "ammo", "module", "tool"]);

/** Builds a DocumentFragment with plain text runs and inline icon spans in
 *  place of each recognised `[type=name]` tag — for anywhere a blueprint or
 *  book label is displayed as a clickable row label rather than plain
 *  textContent. `iconSize` matches icon()'s own displaySize parameter. */
export function renderRichLabel(label: string, iconSize = 16): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(label)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(label.slice(lastIndex, match.index)));
    }
    const [, type, name] = match;
    fragment.appendChild(renderTag(type!, name!, iconSize));
    lastIndex = TAG_PATTERN.lastIndex;
  }
  if (lastIndex < label.length) {
    fragment.appendChild(document.createTextNode(label.slice(lastIndex)));
  }
  return fragment;
}

function renderTag(type: string, name: string, iconSize: number): HTMLElement {
  if (ICON_TYPES.has(type)) {
    const el = icon(name, name.replace(/-/g, " "), iconSize);
    el.classList.add("rich-text-icon");
    return el;
  }
  // A type the sprite sheet has no art for (virtual-signal, quality, tile,
  // space-location, ...) — a small lettered placeholder beats vanishing the
  // reference entirely, and beats printing the raw `[type=name]` markup a
  // plain-text fallback would show instead.
  const placeholder = document.createElement("span");
  placeholder.className = "rich-text-icon rich-text-icon-placeholder";
  placeholder.style.setProperty("--icon-size", `${iconSize}px`);
  placeholder.title = name.replace(/-/g, " ");
  placeholder.textContent = (type[0] ?? "?").toUpperCase();
  return placeholder;
}

/** Whether `label` contains at least one recognised rich-text tag — lets a
 *  caller skip the DocumentFragment machinery for the common case of a
 *  plain-text label (still handled correctly either way, just an easy early
 *  out). */
export function hasRichText(label: string): boolean {
  TAG_PATTERN.lastIndex = 0;
  return TAG_PATTERN.test(label);
}
