/** Cycles the tab icon through a few variants of the FactorioTools mark: same
 *  dark tile as public/favicon.svg, a different gold glyph each time (gear,
 *  belt, electric pole, rate bars). Icons are built as data: URIs, which the
 *  CSP's img-src already allows. Skipped under prefers-reduced-motion, where
 *  the static favicon.svg stays. */

const INTERVAL_MS = 2500;

const TILE = `
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3938"/><stop offset="1" stop-color="#232222"/></linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd999"/><stop offset="0.5" stop-color="#f5a742"/><stop offset="1" stop-color="#d98a1f"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#b)"/>
  <rect x="6" y="6" width="500" height="500" rx="98" fill="none" stroke="#171717" stroke-width="12"/>
  <rect x="15" y="15" width="482" height="482" rx="90" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="6"/>`;

function gear(cx: number, cy: number, tip: number, root: number, teeth: number, hole: number): string {
  const step = (Math.PI * 2) / teeth;
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    pts.push(pt(root, a - step * 0.3), pt(tip, a - step * 0.17), pt(tip, a + step * 0.17), pt(root, a + step * 0.3));
  }
  return `M${pts.join(" L")} Z M${cx + hole} ${cy} A${hole} ${hole} 0 1 0 ${cx - hole} ${cy} A${hole} ${hole} 0 1 0 ${cx + hole} ${cy} Z`;
}

/** Right-pointing chevron, 96 wide and 112 tall, left edge at x. */
const chevron = (x: number) => `M${x} 200 H${x + 40} L${x + 96} 256 L${x + 40} 312 H${x} L${x + 56} 256 Z`;

const GLYPHS: string[] = [
  // Gear with belt chevrons — matches public/favicon.svg.
  `<path d="${gear(256, 256, 192, 146, 8, 88)}" fill="url(#g)" fill-rule="evenodd"/>
   <path d="M212 216 L256 176 L300 216 L300 246 L256 206 L212 246 Z M212 266 L256 226 L300 266 L300 296 L256 256 L212 296 Z" fill="url(#g)"/>`,
  // Belt: three chevrons running along a lane.
  `<rect x="40" y="176" width="432" height="160" rx="16" fill="#171717"/>
   <path d="${chevron(88)} ${chevron(208)} ${chevron(328)}" fill="url(#g)"/>`,
  // Electric pole with a wire swinging off each arm.
  `<path d="M236 96 H276 V440 H236 Z M130 168 H382 V204 H130 Z" fill="url(#g)"/>
   <path d="M140 204 Q96 330 60 330 M372 204 Q416 330 452 330" fill="none" stroke="url(#g)" stroke-width="14" stroke-linecap="round"/>
   <circle cx="256" cy="96" r="30" fill="url(#g)"/>`,
  // Rate bars climbing.
  `<path d="M82 400 H430" stroke="#5a5958" stroke-width="14" stroke-linecap="round"/>
   <path d="M84 320 H152 V384 H84 Z M170 260 H238 V384 H170 Z M256 200 H324 V384 H256 Z M342 130 H410 V384 H342 Z" fill="url(#g)"/>`,
];

const toDataUri = (glyph: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${TILE}${glyph}</svg>`)}`;

export function startFaviconCycle(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const icons = GLYPHS.map(toDataUri);
  let i = 0;
  window.setInterval(() => {
    i = (i + 1) % icons.length;
    link.href = icons[i]!;
  }, INTERVAL_MS);
}
