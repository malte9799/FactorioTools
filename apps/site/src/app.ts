import "./style.css";
import { renderNav, ROUTES } from "./nav.js";
import { mountBlueprintViewer } from "./tools/blueprint-viewer/index.js";
import { mountLayerDebug } from "./tools/layer-debug/index.js";

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
    // Dev aid, not a product route — reachable by URL but deliberately not
    // in ROUTES/the nav bar (see mountLayerDebug's own doc comment).
    case "#/layer-debug":
      unmountCurrent = mountLayerDebug(toolRoot);
      break;
    default:
      window.location.hash = ROUTES[0]!.hash;
  }
}

window.addEventListener("hashchange", route);
route();
