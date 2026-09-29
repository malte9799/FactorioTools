import "./style.css";
import { renderNav, ROUTES } from "./nav.js";
import { mountBlueprintViewer } from "./tools/blueprint-viewer/index.js";

const navRoot = document.getElementById("nav-root")!;
const toolRoot = document.getElementById("tool-root")!;

let unmountCurrent: (() => void) | null = null;

function currentHash(): string {
  return window.location.hash || ROUTES[0]!.hash;
}

/** Guards against a slow dynamic import landing after the user has already
 *  routed somewhere else, which would mount a tool over the current one. */
let routeToken = 0;

async function route() {
  const hash = currentHash();
  const token = ++routeToken;
  renderNav(navRoot, hash);
  unmountCurrent?.();
  unmountCurrent = null;

  switch (hash) {
    case "#/blueprint-viewer":
      unmountCurrent = mountBlueprintViewer(toolRoot);
      break;
    // Design playground for the on-map rate calculator; loaded on demand so
    // the main bundle doesn't carry the simulation.
    case "#/overlay-lab": {
      const { mountOverlayLab } = await import("./tools/overlay-lab/index.js");
      if (token !== routeToken) return;
      unmountCurrent = mountOverlayLab(toolRoot);
      break;
    }
    // Dev aid, not a product route — reachable by URL but deliberately not
    // in ROUTES/the nav bar (see mountLayerDebug's own doc comment). Loaded
    // on demand so it stays out of the main bundle, which every visitor pays
    // for and almost none of them opens this with.
    case "#/layer-debug": {
      const { mountLayerDebug } = await import("./tools/layer-debug/index.js");
      if (token !== routeToken) return;
      unmountCurrent = mountLayerDebug(toolRoot);
      break;
    }
    default:
      window.location.hash = ROUTES[0]!.hash;
  }
}

window.addEventListener("hashchange", () => void route());
void route();
