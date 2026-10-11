export interface ToolRoute {
  hash: string;
  label: string;
}

export const ROUTES: ToolRoute[] = [
  { hash: "#/blueprint-editor", label: "Blueprint Editor" },
  { hash: "#/planner", label: "Planner" },
  { hash: "#/overlay-lab", label: "Overlay Lab" },
  { hash: "#/seed-viewer", label: "Seed Viewer" },
];

let outsideListening = false;

/** On a phone the tool links don't fit in a row, so the nav shows only the
 *  current tool, as a switcher that drops the full list down (style.css
 *  decides which of the two shows). A plain <details>, so it opens and
 *  closes without script; a press anywhere else closes it too. */
function closeSwitcherOnOutsidePress(): void {
  if (outsideListening) return;
  outsideListening = true;
  document.addEventListener("pointerdown", (e) => {
    const open = document.querySelector<HTMLDetailsElement>(".nav-switch[open]");
    if (open && !open.contains(e.target as Node)) open.open = false;
  }, true);
}

export function renderNav(container: HTMLElement, activeHash: string): void {
  const links = ROUTES.map(
    (r) => `<a href="${r.hash}" class="${r.hash === activeHash ? "is-active" : ""}">${r.label}</a>`,
  ).join("");
  const current = ROUTES.find((r) => r.hash === activeHash) ?? ROUTES[0]!;
  container.innerHTML = `
    <header class="site-nav">
      <a class="brand" href="#/blueprint-editor">FactorioTools</a>
      <nav class="nav-links">${links}</nav>
      <details class="nav-switch">
        <summary aria-label="Switch tool">${current.label}<span class="nav-switch-caret" aria-hidden="true">▾</span></summary>
        <nav class="nav-switch-menu">${links}</nav>
      </details>
    </header>
  `;
  // Picking the tool already showing changes no hash, so nothing would
  // re-render the nav and close the list.
  const switcher = container.querySelector<HTMLDetailsElement>(".nav-switch")!;
  switcher.querySelector(".nav-switch-menu")!.addEventListener("click", () => (switcher.open = false));
  closeSwitcherOnOutsidePress();
}
