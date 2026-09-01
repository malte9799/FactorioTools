export interface ToolRoute {
  hash: string;
  label: string;
}

export const ROUTES: ToolRoute[] = [
  { hash: "#/blueprint-viewer", label: "Blueprint Viewer" },
];

export function renderNav(container: HTMLElement, activeHash: string): void {
  container.innerHTML = `
    <header class="site-nav">
      <a class="brand" href="#/blueprint-viewer">FactorioTools</a>
      <nav>
        ${ROUTES.map(
          (r) =>
            `<a href="${r.hash}" class="${r.hash === activeHash ? "is-active" : ""}">${r.label}</a>`,
        ).join("")}
      </nav>
    </header>
  `;
}
