import "./style.css";
import { renderNav, ROUTES } from "./nav.js";
import { mountBlueprintViewer } from "./tools/blueprint-viewer/index.js";

const navRoot = document.getElementById("nav-root")!;
const toolRoot = document.getElementById("tool-root")!;

let unmountCurrent: (() => void) | null = null;

function currentHash(): string {
  return window.location.hash || ROUTES[0]!.hash;
}

function route() {
  const hash = currentHash();
  renderNav(navRoot, hash);
  unmountCurrent?.();
  unmountCurrent = null;

  switch (hash) {
    case "#/blueprint-viewer":
      unmountCurrent = mountBlueprintViewer(toolRoot);
      break;
    default:
      window.location.hash = ROUTES[0]!.hash;
  }
}

window.addEventListener("hashchange", route);
route();
