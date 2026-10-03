/** Factorio's rich text: plain text with `[color=…]…[/color]` and
 *  `[font=…]…[/font]` spans and inline icon tags (`[item=iron-plate]`,
 *  `[virtual-signal=signal-A]`, `[img=item/iron-plate]`, …), as the game
 *  shows in blueprint names, descriptions, display panels and map tags.
 *
 *  parseRichText turns a string into runs a renderer can draw: text with
 *  the colour and font in force, or an icon. Anything that isn't a tag the
 *  game knows stays literal text, as in game. */

export interface RichTextStyle {
  /** CSS colour, or undefined for the renderer's default. */
  color?: string;
  bold: boolean;
  /** Relative size: 1 is the surrounding text's. */
  scale: number;
}

export type RichRun =
  | ({ kind: "text"; text: string } & RichTextStyle)
  | { kind: "icon"; type: string; name: string; quality?: string };

/** Icon tags. `img` takes `type/name`; the rest take a prototype name. */
const ICON_TAGS = new Set([
  "img",
  "item",
  "entity",
  "technology",
  "recipe",
  "item-group",
  "fluid",
  "tile",
  "virtual-signal",
  "achievement",
  "special-item",
  "armor",
  "space-location",
  "planet",
  "quality",
  "asteroid-chunk",
  "shortcut",
]);

/** Tags that show text of their own (a GPS pin, a train): kept readable. */
const TEXT_TAGS = new Set(["gps", "train", "train-stop", "space-platform", "tooltip"]);

/** The game's named rich-text colours. */
const NAMED: Record<string, string> = {
  default: "#ffffff",
  red: "#ff2b2b",
  green: "#2bff2b",
  blue: "#3f7fff",
  orange: "#ff9f1b",
  yellow: "#ffd91b",
  pink: "#ff4fd0",
  purple: "#b14fff",
  white: "#ffffff",
  black: "#000000",
  gray: "#808080",
  grey: "#808080",
  brown: "#a0522d",
  cyan: "#1bffff",
  acid: "#a8ff1b",
};

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** A rich-text colour argument as CSS: `#rgb`, `#rrggbb`, `#rrggbbaa`, a
 *  name, or `r,g,b[,a]` in 0–1 (or 0–255 when any part is above 1). */
export function richTextColor(arg: string): string | undefined {
  const a = arg.trim().toLowerCase();
  if (NAMED[a]) return NAMED[a];
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(a);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return `#${h}`;
  }
  const parts = a.split(",").map((p) => Number(p.trim()));
  if ((parts.length === 3 || parts.length === 4) && parts.every((p) => Number.isFinite(p))) {
    const bytes = parts.some((p) => p > 1) ? parts : parts.map((p) => p * 255);
    const [r, g, b, al] = bytes.map(clampByte);
    return al === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(al / 255).toFixed(3)})`;
  }
  return undefined;
}

/** How a font name looks: bold for the bold and heading fonts, bigger for
 *  the large and heading ones, smaller for the slot-count fonts. */
function fontStyle(name: string): { bold: boolean; scale: number } {
  const n = name.toLowerCase();
  const bold = /bold|heading|semibold|count|level|title/.test(n);
  const scale = /heading-1|large|title/.test(n) ? 1.3 : /heading-2/.test(n) ? 1.15 : /small|count|level/.test(n) ? 0.9 : 1;
  return { bold, scale };
}

const TAG = /\[(\/?)([a-z][a-z0-9-]*)(?:=([^\]]*))?\]/gi;

export function parseRichText(text: string): RichRun[] {
  const runs: RichRun[] = [];
  const colors: string[] = [];
  const fonts: { bold: boolean; scale: number }[] = [];
  const style = (): RichTextStyle => {
    const font = fonts[fonts.length - 1];
    return { color: colors[colors.length - 1], bold: font?.bold ?? false, scale: font?.scale ?? 1 };
  };
  const pushText = (t: string) => {
    if (!t) return;
    const s = style();
    const last = runs[runs.length - 1];
    if (last?.kind === "text" && last.color === s.color && last.bold === s.bold && last.scale === s.scale) last.text += t;
    else runs.push({ kind: "text", text: t, ...s });
  };
  let at = 0;
  // Text before a tag takes the style in force before it.
  const flush = (m: RegExpExecArray) => {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
  };
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    const [, close, rawTag, arg] = m;
    const tag = rawTag!.toLowerCase();
    if (tag === "color" || tag === "colour") {
      if (close) {
        flush(m);
        colors.pop();
        continue;
      }
      const c = arg !== undefined ? richTextColor(arg) : undefined;
      if (!c) continue;
      flush(m);
      colors.push(c);
    } else if (tag === "font") {
      if (close) {
        flush(m);
        fonts.pop();
        continue;
      }
      if (!arg) continue;
      flush(m);
      fonts.push(fontStyle(arg));
    } else if (!close && arg !== undefined && ICON_TAGS.has(tag)) {
      const [value, ...extra] = arg.split(",");
      const quality = extra.map((e) => /^quality=(.+)$/.exec(e.trim())?.[1]).find(Boolean);
      let type = tag;
      let name = value!.trim();
      if (tag === "img") {
        const slash = name.indexOf("/");
        if (slash >= 0) {
          type = name.slice(0, slash);
          name = name.slice(slash + 1);
        }
      }
      if (!name) continue;
      flush(m);
      runs.push({ kind: "icon", type, name, quality });
    } else if (!close && TEXT_TAGS.has(tag)) {
      flush(m);
      // A GPS tag reads as its coordinates; the others as their name.
      pushText(tag === "gps" ? `📍${(arg ?? "").split(",").slice(0, 2).join(", ")}` : (arg ?? tag).split(",")[0]!);
    }
  }
  pushText(text.slice(at));
  return runs;
}

/** The text with every tag removed and icons as their names: for places
 *  that can only show plain text (a `<select>` option, a title). */
export function stripRichText(text: string): string {
  return parseRichText(text)
    .map((r) => (r.kind === "text" ? r.text : r.name.replace(/-/g, " ")))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
