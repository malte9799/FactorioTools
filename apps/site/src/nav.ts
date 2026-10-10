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

export function renderNav(container: HTMLElement, activeHash: string): void {
  container.innerHTML = `
    <header class="site-nav">
      <a class="brand" href="#/blueprint-editor">FactorioTools</a>
      <nav>
        ${ROUTES.map(
          (r) =>
            `<a href="${r.hash}" class="${r.hash === activeHash ? "is-active" : ""}">${r.label}</a>`,
        ).join("")}
      </nav>
    </header>
  `;
}
