/** Standalone entry for the Overlay Lab (lab.html): the same tool as
 *  #/overlay-lab, without the rest of the app, so it can be shared as a
 *  single page. */
import "./style.css";
import { mountOverlayLab } from "./tools/overlay-lab/index.js";

document.getElementById("nav-root")!.innerHTML = `
  <header class="site-nav">
    <span class="brand">FactorioTools</span>
    <nav><a class="is-active" href="#">Overlay Lab</a></nav>
  </header>`;
mountOverlayLab(document.getElementById("tool-root")!, { standalone: true });
