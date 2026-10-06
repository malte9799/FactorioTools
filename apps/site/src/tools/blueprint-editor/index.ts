import {
  BlueprintError,
  collectBlueprints,
  buildBlueprintTree,
  decodeBlueprintString,
  encodeBlueprintString,
  toBlueprint,
  normaliseEntities,
  normaliseWires,
  calculate,
  attachBottlenecks,
  computeScaleFactor,
  findScaleWarnings,
  getData,
  getRenderCatalog,
  loadData,
  ROTATION_TEST_BLUEPRINT,
  loadDebugBlueprint,
  TIMESCALE_FACTOR,
  remapSelectionForPaste,
  refreshSignalItems,
  stripRichText,
} from "@factoriotools/engine";
import type { CalculationResult, Timescale, Blueprint, BlueprintTreeNode, PlacedEntity, QualityName, MachineGroup, ModuleStack, ThroughputContext, BottleneckSubgroup, BpSignalId, WireColor, WireLink } from "@factoriotools/engine";
import { mountRenderer, entitiesCollide, isRail, railEndsAt, isElevatedRail, buildableRails, supportHolds, type RailPiece, isPoleLike, isUndergroundLike, canBuildOver, undergroundForPlacement, undergroundPartner, isTwoDirectionOnly, rotationStep, rotationCount, effectiveFootprint, rotateAroundCenter, summariseRecording, slowestFrames, worstPhase, autoConnectPole, canWire, dropWiresFor, terminalSideAt, toggleWire, type BlueprintRenderer, type HighlightRole } from "@factoriotools/renderer";
import { buildRecipeCard, renderResults, type ViewOptions } from "./legacy-view/panels.js";
import { icon } from "./legacy-view/icons.js";
import { makeFloatingWindow } from "../../window-manager.js";
import { buildPalette, placeableEntries } from "./edit-palette.js";
import { appendQualityOptions, QUALITY_TIERS } from "./quality-options.js";
import { buildPropertiesPanel, buildRecipeMenu, buildModuleMenu, buildFilterItemMenu, localisedNameOf } from "./edit-properties.js";
import { buildSignalMenu, circuitWindowKind, type Wildcards } from "./edit-circuit.js";
import { CircuitSim } from "@factoriotools/sim";
import { SimClock } from "../../sim-clock.js";
import type { GridMenuHandle } from "./grid-menu.js";
import { buildLibrarySidebar } from "./library-sidebar.js";
import { buildQuickbar, readAltLayers, writeAltLayers, type AltLayers, type QuickbarHandle, type QuickbarItem } from "./quickbar.js";
import { buildGridMenu } from "./grid-menu.js";
import { BlueprintLinkError, looksLikeBlueprintString, parseBlueprintLink, resolveBlueprintLink, SHARE_TARGETS } from "./blueprint-links.js";
import { BLUEPRINT_FILE_ACCEPT, BlueprintFileError, readBlueprintFile } from "./blueprint-file.js";
import { listSaved, replaceContentsInLibrary, saveFailureMessage, saveToLibrary } from "./blueprint-library.js";
import { RateOverlay } from "../../rate-overlay/controller.js";
import { setCurrentBlueprint, EDITOR_AUTOSAVE_KEY, readAutosave } from "../../current-blueprint.js";
import { currentQuality, onQualityChange } from "../../render-presets.js";
import { GRAPHICS_WINDOW_HTML, wireGraphicsPanel } from "../../graphics-panel.js";
import { clockText, overviewHtml, rateUnitHtml, renderLayerList, renderPortList, RESEARCH_HTML, wireLayerList, wirePortList, wireRateUnit, wireResearch } from "../../rate-overlay/panels.js";

const TEMPLATE = `
  <div id="schematic" class="schematic-frame"></div>
  <div id="machine-tooltip" class="machine-tooltip gui-window" hidden></div>

  <div id="load-spinner" class="load-spinner" aria-hidden="true">
    <div id="load-spinner-file" class="load-spinner-file"></div>
    <div class="load-spinner-ring"></div>
  </div>

  <div id="unsaved-modal-backdrop" class="modal-backdrop" hidden>
    <div id="unsaved-modal" class="gui-window modal-window" role="dialog" aria-modal="true" aria-labelledby="unsaved-modal-title">
      <div class="gui-titlebar">
        <span id="unsaved-modal-title">Unsaved changes</span>
      </div>
      <div class="gui-body">
        <p>The current blueprint has unsaved changes. What would you like to do?</p>
        <div id="unsaved-modal-save-row" class="library-save-row" hidden>
          <input id="unsaved-modal-name" type="text" placeholder="Name…" class="library-save-input" aria-label="Name for the blueprint to save" />
        </div>
        <div class="intake-actions">
          <button id="unsaved-modal-save" class="primary" type="button">Save</button>
          <button id="unsaved-modal-discard" class="ghost" type="button">Discard</button>
          <button id="unsaved-modal-cancel" class="ghost" type="button">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <div id="save-as-modal-backdrop" class="modal-backdrop" hidden>
    <div id="save-as-modal" class="gui-window modal-window" role="dialog" aria-modal="true" aria-labelledby="save-as-modal-title">
      <div class="gui-titlebar">
        <span id="save-as-modal-title">Save blueprint as</span>
      </div>
      <div class="gui-body">
        <div class="library-save-row">
          <input id="save-as-modal-name" type="text" placeholder="Name…" class="library-save-input" aria-label="Name for the blueprint to save" />
        </div>
        <div class="intake-actions">
          <button id="save-as-modal-save" class="primary" type="button">Save</button>
          <button id="save-as-modal-cancel" class="ghost" type="button">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <div id="library-window" class="gui-window docked-window" hidden>
    <div class="gui-titlebar">
      <span>Blueprints</span>
      <button type="button" id="library-collapse-toggle" class="library-collapse-toggle" title="Collapse sidebar" aria-label="Collapse sidebar">◂</button>
    </div>
    <div class="gui-body" id="library-body"></div>
  </div>

  <div id="results-window" class="gui-window floating-window" hidden>
    <div class="gui-titlebar">
      <span>Rate Calculator</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="summary" class="summary"></div>
      <div class="controls">
        <div class="segmented" role="group" aria-label="Timescale">
          <button type="button" data-timescale="second">per second</button>
          <button type="button" data-timescale="minute" class="is-active">per minute</button>
          <button type="button" data-timescale="hour">per hour</button>
        </div>
        <label class="inline">
          <span>Multiplier</span>
          <input id="multiplier" type="number" min="0.1" step="0.5" value="1" />
        </label>
        <label class="inline">
          <span>Measure against</span>
          <select id="measure-kind">
            <option value="">nothing</option>
            <option value="belt">belt</option>
            <option value="inserter">inserter</option>
          </select>
        </label>
        <label class="inline" id="measure-belt-fields" hidden>
          <span id="belt-icon" class="icon-slot"></span>
          <select id="belt" aria-label="Belt type"></select>
          <span>stack size</span>
          <input id="belt-stack" type="number" min="1" step="1" value="1" />
        </label>
        <label class="inline" id="measure-inserter-fields" hidden>
          <span id="inserter-icon" class="icon-slot"></span>
          <select id="inserter" aria-label="Inserter type"></select>
          <select id="inserter-quality" aria-label="Inserter quality"></select>
        </label>
      </div>
      <div class="controls">
        <label class="inline">
          <span>Target</span>
          <select id="target-item" aria-label="Item to target"></select>
        </label>
        <label class="inline" id="target-rate-fields" hidden>
          <input id="target-rate" type="number" min="0" step="1" placeholder="rate" />
          <select id="target-timescale" aria-label="Target rate timescale">
            <option value="second">/s</option>
            <option value="minute" selected>/m</option>
            <option value="hour">/h</option>
          </select>
          <button id="target-clear" class="ghost" type="button">Clear</button>
        </label>
        <p id="target-status" class="sub"></p>
      </div>
      <p class="sub legend-note">Drag windows by their titlebar. Drag the canvas to pan, scroll to zoom, hover a rate to light up the machines behind it.</p>
      <div id="results"></div>
    </div>
  </div>

  <div id="rate-window" class="gui-window floating-window lab-window rate-window" hidden>
    <div class="gui-titlebar">
      <span>Rate Calculator</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div class="lab-row">
        <button type="button" id="rate-play">Pause</button>
        <div class="segmented" role="group" aria-label="Speed" id="rate-speed">
          <button type="button" data-speed="1" class="is-active">1×</button>
          <button type="button" data-speed="4">4×</button>
          <button type="button" data-speed="16">16×</button>
        </div>
        <span class="lab-clock" id="rate-clock">0:00</span>
      </div>
      <div id="rate-summary" class="lab-summary"></div>
      <div id="rate-unit"></div>
      <div class="segmented lab-seg rate-tabs" role="tablist" id="rate-tabs">
        <button type="button" data-pane="layers">Layers</button>
        <button type="button" data-pane="ports">Ports</button>
        <button type="button" data-pane="sim">Simulation</button>
      </div>
      <div class="rate-pane" data-pane="layers" hidden><div id="rate-layer-list" class="lab-layer-list"></div></div>
      <div class="rate-pane" data-pane="ports" hidden>
        <p class="lab-note">Every open belt end is a port, and so is an inserter connected on one side only. Click a tab on the map to edit that port: on/off, item, stack size and rate limit (blank for none). Every port is also listed here.</p>
        <div id="rate-port-list" class="lab-port-list"></div>
      </div>
      <div class="rate-pane" data-pane="sim" hidden>
        <div id="rate-research"></div>
        <div class="lab-row rate-sim-actions">
          <button type="button" id="rate-skip">Skip ahead 60 s</button>
          <button type="button" id="rate-restart">Restart</button>
        </div>
        <p class="lab-note">Belts, splitters, undergrounds and belt stacking are simulated per lane, 1:1. Machines and inserters use a stand-in model, so their numbers are close, not exact.</p>
      </div>
      <div class="lab-row rate-footer">
        <button type="button" id="rate-open-table">Rate table</button>
        <a href="#/overlay-lab" class="rate-lab-link">Style it in the Overlay Lab</a>
      </div>
    </div>
  </div>

  <div id="graphics-window" class="gui-window floating-window lab-window" hidden>${GRAPHICS_WINDOW_HTML}</div>

  <div id="about-window" class="gui-window floating-window" hidden>
    <div class="gui-titlebar">
      <span>About</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <p>
        Blueprint math ported from
        <a href="https://codeberg.org/raiguard/RateCalculator">Rate Calculator</a>
        by raiguard, MIT licensed. Not affiliated with Wube Software.
      </p>
    </div>
  </div>

  <div id="palette-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Build</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="palette-body"></div>
    </div>
  </div>

  <div id="properties-window" class="gui-window floating-window entity-gui" hidden>
    <div class="gui-titlebar">
      <span>Entity</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body" id="properties-body"></div>
  </div>

  <div id="recipe-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Select recipe</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="recipe-body"></div>
    </div>
  </div>

  <div id="module-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Select module</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="module-body"></div>
    </div>
  </div>

  <div id="filter-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Select filter item</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="filter-body"></div>
    </div>
  </div>

  <div id="signal-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Select signal</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="signal-body"></div>
    </div>
  </div>

  <div id="quickbar" role="toolbar" aria-label="Quickbar"></div>

  <div id="hotbar-pick-window" class="gui-window floating-window menu-window" hidden>
    <div class="gui-titlebar">
      <span>Set quickbar slot</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <div id="hotbar-pick-body"></div>
    </div>
  </div>

  <div id="window-toolbar" role="toolbar" aria-label="Windows">
    <button type="button" id="import-menu-button" data-icon="blueprint" title="Import and export" aria-haspopup="menu" aria-expanded="false"><span class="tab-label">Import / Export</span><span class="tab-caret" aria-hidden="true">▾</span></button>
    <select id="bp-picker" hidden aria-label="Blueprint in book"></select>
    <button type="button" data-toggle="rate-window" data-icon="arithmetic-combinator" title="Simulate"><span class="tab-label">Simulate</span></button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button type="button" data-toggle="graphics-window" data-icon="small-lamp" title="Graphics"><span class="tab-label">Graphics</span></button>
    <button type="button" data-toggle="debug-window" data-icon="radar" title="Performance stats (F8)"><span class="tab-label">Debug</span></button>
    <button type="button" data-toggle="about-window" data-icon="programmable-speaker" title="About"><span class="tab-label">About</span></button>
  </div>

  <div id="import-menu" class="toolbar-menu" role="menu" hidden>
    <button type="button" role="menuitem" id="import-clipboard" class="toolbar-menu-item">Import from clipboard</button>
    <button type="button" role="menuitem" id="import-file" class="toolbar-menu-item" title="A text file holding a blueprint string — or drop one on the editor">Import from file…</button>
    <input id="import-file-input" type="file" accept="${BLUEPRINT_FILE_ACCEPT}" hidden />
    <form id="import-link-form" class="toolbar-menu-link">
      <input id="import-link" type="text" placeholder="Link or blueprint string…" aria-label="Blueprint link"
        autocomplete="off" spellcheck="false" />
      <button type="submit" class="toolbar-menu-go" title="Import from link">Import</button>
    </form>
    <p class="toolbar-menu-hint">factorioprints.com or fprints.xyz link, or a string</p>
    <button type="button" role="menuitem" id="import-example" class="toolbar-menu-item">Load a random example</button>
    <div class="toolbar-menu-sep" role="separator"></div>
    <button type="button" role="menuitem" id="export-clipboard" class="toolbar-menu-item">Export to clipboard</button>
    <div id="export-share"></div>
  </div>

  <p id="status" class="status-toast" data-kind="info" role="status" hidden></p>
  <textarea id="bp-input" hidden></textarea>

  <div id="debug-window" class="gui-window floating-window" hidden>
    <div class="gui-titlebar">
      <span>Debug</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body debug-body">
      <div class="debug-tabs" role="tablist">
        <button type="button" class="debug-tab is-active" data-debug-tab="overview">Overview</button>
        <button type="button" class="debug-tab" data-debug-tab="phases">Frame</button>
        <button type="button" class="debug-tab" data-debug-tab="entities">Entities</button>
        <button type="button" class="debug-tab" data-debug-tab="record">Record</button>
        <button type="button" class="debug-tab" data-debug-tab="stress">Stress</button>
      </div>

      <section class="debug-pane is-active" data-debug-pane="overview">
        <table class="debug-stats-table">
          <tbody>
            <tr><td>FPS</td><td id="debug-fps">–</td></tr>
            <tr><td>Frame time</td><td id="debug-frame-time">–</td></tr>
            <tr><td>Render time</td><td id="debug-render-time">–</td></tr>
            <tr><td>Entities (total)</td><td id="debug-total-entities">–</td></tr>
            <tr><td>Entities (visible)</td><td id="debug-visible-entities">–</td></tr>
            <tr><td>Draw commands</td><td id="debug-draw-commands">–</td></tr>
            <tr><td>Scene cache</td><td id="debug-cache">–</td></tr>
            <tr><td>Frames drawn / skipped</td><td id="debug-frame-counts">–</td></tr>
            <tr><td>JS heap</td><td id="debug-heap">–</td></tr>
          </tbody>
        </table>
      </section>

      <section class="debug-pane" data-debug-pane="phases">
        <p class="debug-hint">Where the last frame's time went. A bar that grows while
        you pan is the one to look at.</p>
        <div id="debug-phase-bars" class="debug-bars"></div>
      </section>

      <section class="debug-pane" data-debug-pane="entities">
        <p class="debug-hint">Cost per entity type in the last scene rebuild. Timing each
        entity separately slows rebuilds down, so this is off until you switch it on.</p>
        <label class="debug-check">
          <input type="checkbox" id="debug-entity-accounting" /> Measure per entity
        </label>
        <table class="debug-stats-table debug-entity-table">
          <thead><tr><th>Entity</th><th>×</th><th>Cmds</th><th>Collect</th></tr></thead>
          <tbody id="debug-entity-rows"><tr><td colspan="4" class="debug-empty">Not measuring.</td></tr></tbody>
        </table>
      </section>

      <section class="debug-pane" data-debug-pane="record">
        <p class="debug-hint">Records one row per drawn frame. Start it, reproduce the
        stutter, then read the slowest frames or copy the whole log.</p>
        <div class="debug-actions">
          <button type="button" id="debug-record-toggle">Record 30 s</button>
          <button type="button" id="debug-record-copy" disabled>Copy JSON</button>
          <span id="debug-record-status" class="debug-hint"></span>
        </div>
        <div id="debug-record-summary"></div>
        <table class="debug-stats-table debug-record-table">
          <thead><tr><th>t</th><th>Frame</th><th>Render</th><th>Outside</th><th>Slowest phase</th><th>Painted</th><th>Atlas</th><th>Rebuild</th></tr></thead>
          <tbody id="debug-record-rows"><tr><td colspan="8" class="debug-empty">Nothing recorded yet.</td></tr></tbody>
        </table>
      </section>

      <section class="debug-pane" data-debug-pane="stress">
        <p class="debug-hint">Fills the canvas with copies of one building in a grid —
        for isolating a single sprite's own rendering cost from everything else on
        screen. Replaces whatever's currently loaded; use Undo (Ctrl+Z) to get it back.</p>
        <label class="debug-field">
          <span>Building</span>
          <select id="stress-entity" aria-label="Building type to stamp"></select>
        </label>
        <label class="debug-field">
          <span>Grid size</span>
          <input type="number" id="stress-grid-size" min="1" max="50" step="1" value="10" aria-label="Grid width/height, in buildings" />
        </label>
        <label class="debug-field">
          <span>Spacing</span>
          <input type="number" id="stress-spacing" min="0" max="20" step="0.5" value="1" aria-label="Extra empty tiles between buildings" />
        </label>
        <div class="debug-actions">
          <button type="button" id="stress-place">Place grid</button>
        </div>
        <p id="stress-status" class="debug-hint"></p>
      </section>
    </div>
  </div>
`;

interface ExampleBlueprint {
  label: string;
  entities: number;
  bp: string;
}

/** Module-level so every mount reuses the same fetch instead of re-fetching
 *  ~1.3MB every time the tool is opened. The examples are real leaf
 *  blueprints from the user's own Space Age blueprint book (built by
 *  scripts/build-example-blueprints.mjs into this static file) rather than
 *  one hand-picked fixture, so "Load an example" gives a different real
 *  build each time instead of always the same small demo. */
let examplePool: Promise<ExampleBlueprint[]> | undefined;

function loadExamplePool(): Promise<ExampleBlueprint[]> {
  if (!examplePool) {
    examplePool = fetch("./data/example-blueprints.json")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .catch((err) => {
        examplePool = undefined; // let a later click retry instead of caching the failure
        throw err;
      });
  }
  return examplePool;
}

export function mountBlueprintEditor(root: HTMLElement): () => void {
  root.innerHTML = TEMPLATE;

  const $ = <T extends HTMLElement>(selector: string): T => {
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`missing element ${selector}`);
    return el;
  };

  const input = $<HTMLTextAreaElement>("#bp-input");
  const status = $<HTMLParagraphElement>("#status");
  const picker = $<HTMLSelectElement>("#bp-picker");
  const canvas = $<HTMLDivElement>("#schematic");
  const results = $<HTMLDivElement>("#results");
  const resultsWindowEl = $<HTMLDivElement>("#results-window");
  const summary = $<HTMLDivElement>("#summary");
  const tooltip = $<HTMLDivElement>("#machine-tooltip");

  // The library panel is docked (fixed left edge, positioned entirely by
  // CSS) rather than draggable like every other .gui-window, so it gets a
  // minimal show/hide stand-in instead of makeFloatingWindow — that helper
  // unconditionally takes over inline left/top/position for dragging, which
  // would fight the docked CSS position.
  const libraryWindowEl = $<HTMLDivElement>("#library-window");
  const libraryWindow = {
    el: libraryWindowEl,
    show: () => { libraryWindowEl.hidden = false; },
    hide: () => { libraryWindowEl.hidden = true; },
    bringToFront: () => {},
  };

  const resultsWindow = makeFloatingWindow(resultsWindowEl, { x: Math.max(16, window.innerWidth - 460), y: 66 });
  const aboutWindow = makeFloatingWindow($("#about-window"), { x: 16, y: window.innerHeight - 120 });
  const graphicsWindow = makeFloatingWindow($("#graphics-window"), { x: Math.max(8, window.innerWidth - 356), y: 96, width: 340 });

  // The Rate Calculator: a live simulation drawn over the build itself.
  // Its window being open is what switches the overlay on; the classic
  // rate table (resultsWindow) is one button away inside it.
  const rateOverlay = new RateOverlay(canvas, {
    cardHost: root,
    onUpdate: () => renderRateWindow(),
    onPortsChange: () => {
      if (ratePane === "ports") renderPortList($("#rate-port-list"), rateOverlay);
    },
  });
  const rateWindowRaw = makeFloatingWindow($("#rate-window"), {
    x: Math.max(16, window.innerWidth - 396),
    y: 66,
    width: 380,
    onClose: () => rateOverlay.setEnabled(false),
  });
  const rateWindow = {
    ...rateWindowRaw,
    show() {
      rateWindowRaw.show();
      rateOverlay.setEnabled(true);
      renderRateWindow();
    },
    hide() {
      rateWindowRaw.hide();
      rateOverlay.setEnabled(false);
    },
  };
  let ratePane: string | undefined;
  function renderRateWindow() {
    if (rateWindowRaw.el.hidden) return;
    $("#rate-clock").textContent = clockText(rateOverlay);
    $("#rate-play").textContent = rateOverlay.playing ? "Pause" : "Play";
    $("#rate-summary").innerHTML = overviewHtml(rateOverlay);
  }
  function showRatePane(pane: string | undefined) {
    ratePane = pane;
    for (const b of root.querySelectorAll<HTMLButtonElement>("#rate-tabs [data-pane]")) b.classList.toggle("is-active", b.dataset.pane === pane);
    for (const el of root.querySelectorAll<HTMLElement>(".rate-pane")) el.hidden = el.dataset.pane !== pane;
    rateOverlay.forcePorts = pane === "ports";
    if (pane === "layers") renderLayerList($("#rate-layer-list"), rateOverlay.settings);
    if (pane === "ports") renderPortList($("#rate-port-list"), rateOverlay);
  }
  const paletteWindow = makeFloatingWindow($("#palette-window"), { x: 16, y: Math.max(280, window.innerHeight - 340) });
  const debugWindow = makeFloatingWindow($("#debug-window"), { x: Math.max(16, window.innerWidth - 280), y: window.innerHeight - 260 });
  const propertiesWindow = makeFloatingWindow($("#properties-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: deselect,
  });
  const recipeWindow = makeFloatingWindow($("#recipe-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: () => enterMenuState(recipeExitState()),
  });
  const moduleWindow = makeFloatingWindow($("#module-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: () => enterMenuState("machine-info"),
  });
  const hotbarPickWindow = makeFloatingWindow($("#hotbar-pick-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: () => enterMenuState("default"),
  });
  /** Built once the editor functions it drives exist (see buildQuickbar's
   *  call below); every syncQuickbar() before then is a no-op. */
  let quickbar: QuickbarHandle | undefined;
  /** Which quickbar slot the open "Set quickbar slot" picker fills. */
  let hotbarTarget = { bar: 0, slot: 0 };
  const filterWindow = makeFloatingWindow($("#filter-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: () => enterMenuState("machine-info"),
  });
  const signalWindow = makeFloatingWindow($("#signal-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: () => enterMenuState("machine-info"),
  });
  /** What the open signal picker fills, and which wildcards it offers. */
  let signalPick: { allow: Wildcards; onPick: (signal: BpSignalId) => void } | undefined;
  /** The signal picker's last tab, kept while one building's GUI stays
   *  open so every slot opens where the last pick was made. */
  let signalTab: { entity: number; group: string } | undefined;

  // All floating windows start hidden so the blueprint fills the screen
  // uninterrupted — the toolbar below (bottom-of-template, always visible)
  // toggles each one back on. propertiesWindow/recipeWindow aren't in this
  // map — they have no toolbar entry, opening on demand instead (selection,
  // and the recipe gear button respectively) and closing via their own
  // close button or Escape, matching the real game's own "click a building
  // to open its GUI" convention rather than a manually-toggled panel.
  const allWindows: Record<string, { el: HTMLElement; show(): void; hide(): void; bringToFront(): void }> = {
    "library-window": libraryWindow,
    "results-window": resultsWindow,
    "rate-window": rateWindow,
    "graphics-window": graphicsWindow,
    "about-window": aboutWindow,
    "palette-window": paletteWindow,
    "debug-window": debugWindow,
  };
  for (const w of Object.values(allWindows)) w.hide();
  propertiesWindow.hide();
  recipeWindow.hide();
  moduleWindow.hide();
  filterWindow.hide();
  hotbarPickWindow.hide();
  // The library starts open (unlike the others) — it's the entry point for
  // picking a blueprint to work on, matching the reference Surfaces panel
  // being a persistent, always-visible sidebar rather than a popup.
  libraryWindow.show();

  const controller = new AbortController();
  const { signal } = controller;

  $("#rate-unit").innerHTML = rateUnitHtml(rateOverlay.settings);
  $("#rate-research").innerHTML = RESEARCH_HTML;
  wireRateUnit($("#rate-unit"), rateOverlay, signal);
  wireLayerList($("#rate-layer-list"), rateOverlay, signal);
  wirePortList($("#rate-port-list"), rateOverlay, signal);
  wireResearch($("#rate-research"), rateOverlay, signal);
  $("#rate-tabs").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pane]");
    // Clicking the open tab folds the window back down to its summary.
    if (b) showRatePane(ratePane === b.dataset.pane ? undefined : b.dataset.pane);
  }, { signal });
  $("#rate-play").addEventListener("click", () => {
    rateOverlay.playing = !rateOverlay.playing;
    renderRateWindow();
  }, { signal });
  $("#rate-speed").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-speed]");
    if (!b) return;
    rateOverlay.speed = Number(b.dataset.speed);
    for (const x of $("#rate-speed").querySelectorAll("button")) x.classList.toggle("is-active", x === b);
    rateOverlay.playing = true;
    renderRateWindow();
  }, { signal });
  $("#rate-skip").addEventListener("click", () => rateOverlay.skip(3600), { signal });
  $("#rate-restart").addEventListener("click", () => rateOverlay.rebuild(), { signal });
  $("#rate-open-table").addEventListener("click", () => {
    resultsWindow.show();
    resultsWindow.bringToFront();
  }, { signal });

  function toggleWindow(target: { el: HTMLElement; show(): void; hide(): void; bringToFront(): void }): void {
    if (target.el.hidden) {
      target.show();
      target.bringToFront();
    } else {
      target.hide();
    }
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
    button.addEventListener("click", () => {
      const target = allWindows[button.dataset.toggle!];
      if (target) toggleWindow(target);
    }, { signal });
  }

  // Toolbar tabs: a game item icon in front of each label, and the tab lit
  // gold while its window is open. Watching each window's `hidden` attribute
  // rather than hooking every show/hide covers the paths that bypass the
  // toolbar too — a titlebar close button, Escape, the Build menu state.
  for (const button of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-icon]")) {
    button.prepend(icon(button.dataset.icon!, "", 20));
  }
  const toolbarObserver = new MutationObserver(syncToolbarTabs);
  function syncToolbarTabs(): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
      const target = root.querySelector<HTMLElement>(`#${button.dataset.toggle}`);
      const open = !!target && !target.hidden;
      button.classList.toggle("is-active", open);
      button.setAttribute("aria-pressed", String(open));
    }
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("#window-toolbar [data-toggle]")) {
    const target = root.querySelector<HTMLElement>(`#${button.dataset.toggle}`);
    if (target) toolbarObserver.observe(target, { attributes: true, attributeFilter: ["hidden"] });
  }
  syncToolbarTabs();
  signal.addEventListener("abort", () => toolbarObserver.disconnect());

  // F8 toggles the Debug panel — an out-of-the-way key nothing else in
  // this app claims, matching the convention several game engines/browser
  // devtools already use for a stats overlay.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F8") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    toggleWindow(debugWindow);
  }, { signal });

  // Polls renderer.getDebugStats() at a fixed rate independent of the draw
  // loop's own frame rate (updating the DOM every single rAF tick would
  // itself be wasted layout/paint work, and defeats the point of a panel
  // meant to diagnose a SLOW frame rate) — only while the panel is
  // actually visible, so it costs nothing the rest of the time.
  const debugFps = $<HTMLTableCellElement>("#debug-fps");
  const debugFrameTime = $<HTMLTableCellElement>("#debug-frame-time");
  const debugRenderTime = $<HTMLTableCellElement>("#debug-render-time");
  const debugTotalEntities = $<HTMLTableCellElement>("#debug-total-entities");
  const debugVisibleEntities = $<HTMLTableCellElement>("#debug-visible-entities");
  const debugDrawCommands = $<HTMLTableCellElement>("#debug-draw-commands");
  const debugHeap = $<HTMLTableCellElement>("#debug-heap");
  const debugCache = $<HTMLTableCellElement>("#debug-cache");
  const debugFrameCounts = $<HTMLTableCellElement>("#debug-frame-counts");
  const debugPhaseBars = $<HTMLDivElement>("#debug-phase-bars");
  const debugEntityRows = $<HTMLTableSectionElement>("#debug-entity-rows");
  const debugEntityAccounting = $<HTMLInputElement>("#debug-entity-accounting");
  const debugRecordToggle = $<HTMLButtonElement>("#debug-record-toggle");
  const debugRecordCopy = $<HTMLButtonElement>("#debug-record-copy");
  const debugRecordStatus = $<HTMLSpanElement>("#debug-record-status");
  const debugRecordSummary = $<HTMLDivElement>("#debug-record-summary");
  const debugRecordRows = $<HTMLTableSectionElement>("#debug-record-rows");
  const stressEntitySelect = $<HTMLSelectElement>("#stress-entity");
  const stressGridSizeInput = $<HTMLInputElement>("#stress-grid-size");
  const stressSpacingInput = $<HTMLInputElement>("#stress-spacing");
  const stressPlaceButton = $<HTMLButtonElement>("#stress-place");
  const stressStatus = $<HTMLParagraphElement>("#stress-status");

  /** Which pane is showing. Only the visible one is refreshed — the whole
   *  point of this panel is to diagnose slow frames, so it must not itself
   *  do avoidable per-tick DOM work. */
  let debugTab: "overview" | "phases" | "entities" | "record" | "stress" = "overview";
  const debugPanes = [...root.querySelectorAll<HTMLElement>("[data-debug-pane]")];
  const debugTabs = [...root.querySelectorAll<HTMLButtonElement>("[data-debug-tab]")];
  for (const tab of debugTabs) {
    tab.addEventListener("click", () => {
      debugTab = tab.dataset.debugTab as typeof debugTab;
      for (const t of debugTabs) t.classList.toggle("is-active", t === tab);
      for (const pane of debugPanes) pane.classList.toggle("is-active", pane.dataset.debugPane === debugTab);
      refreshDebug();
    }, { signal });
  }

  debugEntityAccounting.addEventListener("change", () => {
    renderer.setEntityAccounting(debugEntityAccounting.checked);
    if (!debugEntityAccounting.checked) {
      debugEntityRows.replaceChildren(emptyRow(4, "Not measuring."));
    }
  }, { signal });

  function emptyRow(columns: number, text: string): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns;
    td.className = "debug-empty";
    td.textContent = text;
    tr.appendChild(td);
    return tr;
  }

  /** Rows of "label — bar — value", built with textContent throughout: these
   *  labels are fixed strings, but the entity pane below shows blueprint-
   *  derived names, and one escaping convention across the panel is safer
   *  than two. */
  function renderBars(host: HTMLElement, rows: { label: string; value: number; unit: string }[]): void {
    const max = Math.max(...rows.map((r) => r.value), 0.0001);
    host.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement("div");
        line.className = "debug-bar-row";
        const label = document.createElement("span");
        label.className = "debug-bar-label";
        label.textContent = row.label;
        const track = document.createElement("span");
        track.className = "debug-bar-track";
        const fill = document.createElement("span");
        fill.className = "debug-bar-fill";
        fill.style.width = `${Math.min(100, (row.value / max) * 100)}%`;
        track.appendChild(fill);
        const value = document.createElement("span");
        value.className = "debug-bar-value";
        value.textContent = `${row.value.toFixed(2)}${row.unit}`;
        line.append(label, track, value);
        return line;
      }),
    );
  }

  function refreshDebug(): void {
    if (debugWindow.el.hidden) return;
    const stats = renderer.getDebugStats();

    if (debugTab === "overview") {
      debugFps.textContent = stats.fps.toFixed(0);
      debugFrameTime.textContent = `${stats.frameTimeMs.toFixed(1)} ms`;
      debugRenderTime.textContent = `${stats.renderTimeMs.toFixed(2)} ms`;
      debugTotalEntities.textContent = String(stats.totalEntities);
      debugVisibleEntities.textContent = String(stats.visibleEntities);
      debugDrawCommands.textContent = String(stats.drawCommands);
      const total = stats.framesDrawn || 1;
      debugCache.textContent = `${stats.sceneRebuildCount} rebuilds (${((1 - stats.sceneRebuildCount / total) * 100).toFixed(0)}% reused)`;
      debugFrameCounts.textContent = `${stats.framesDrawn} / ${stats.framesSkipped}`;
      debugHeap.textContent = stats.jsHeapUsedMb !== undefined ? `${stats.jsHeapUsedMb.toFixed(1)} MB` : "n/a (not Chrome)";
    }

    if (debugTab === "phases") {
      renderBars(debugPhaseBars, [
        { label: "grid", value: stats.phases.grid, unit: " ms" },
        { label: "cull", value: stats.phases.cull, unit: " ms" },
        { label: "collect", value: stats.phases.collect, unit: " ms" },
        { label: "animate", value: stats.phases.animate, unit: " ms" },
        { label: "paint", value: stats.phases.paint, unit: " ms" },
        { label: "inserters", value: stats.phases.inserters, unit: " ms" },
        { label: "overlays", value: stats.phases.overlays, unit: " ms" },
        { label: "ghost", value: stats.phases.ghost, unit: " ms" },
      ]);
    }

    if (debugTab === "entities" && debugEntityAccounting.checked) {
      const costs = renderer.getEntityCostBreakdown();
      if (costs.length === 0) {
        debugEntityRows.replaceChildren(emptyRow(4, "Pan or zoom once to trigger a rebuild."));
      } else {
        debugEntityRows.replaceChildren(
          ...costs.slice(0, 25).map((cost) => {
            const tr = document.createElement("tr");
            for (const text of [cost.name, String(cost.count), String(cost.drawCommands), `${cost.collectMs.toFixed(2)} ms`]) {
              const td = document.createElement("td");
              td.textContent = text;
              tr.appendChild(td);
            }
            return tr;
          }),
        );
      }
    }

    if (debugTab === "record") updateRecordPane();
  }

  /** CSS-pixel area of the canvas, for turning painted area into an overdraw
   *  factor. Zero (the summary then omits overdraw) if the canvas has no
   *  layout yet. */
  function viewportArea(): number {
    const rect = renderer.canvas.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function updateRecordPane(): void {
    const recording = renderer.isRecording();
    const log = renderer.getFrameLog();
    debugRecordToggle.textContent = recording ? "Stop" : "Record 30 s";
    debugRecordCopy.disabled = recording || log.length === 0;
    debugRecordStatus.textContent = recording
      ? `recording… ${log.length} frames`
      : log.length > 0 ? `${log.length} frames captured` : "";

    if (recording || log.length === 0) return;

    const summary = summariseRecording(log, viewportArea());
    debugRecordSummary.replaceChildren();
    const table = document.createElement("table");
    table.className = "debug-stats-table";
    const body = document.createElement("tbody");

    const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
    const rows: [string, string][] = [
      ["Frame (med / p95 / max)",
        `${summary.frameMs.median.toFixed(1)} / ${summary.frameMs.p95.toFixed(1)} / ${summary.frameMs.max.toFixed(1)} ms`],
      ["Render (med / p95 / max)",
        `${summary.renderMs.median.toFixed(2)} / ${summary.renderMs.p95.toFixed(2)} / ${summary.renderMs.max.toFixed(1)} ms`],
      // The single most diagnostic line: time the browser spent NOT in our
      // draw call. Large here with a small render means the stall is decode,
      // GC or compositing, not the renderer.
      ["Outside draw (med / max)",
        `${summary.outsideMs.median.toFixed(1)} / ${summary.outsideMs.max.toFixed(1)} ms`],
      ["Janky frames (>16.7 ms)",
        `${summary.janky} of ${summary.frames} — ${summary.jankyMs.toFixed(0)} ms total`],
      ["Frames skipped (idle)", `${summary.framesSkipped}`],
      ["Peak draw commands", `${summary.peakDrawCommands}`],
      ["Peak visible entities", `${summary.peakVisibleEntities}`],
    ];
    if (summary.framesWithMissingSprites > 0) {
      rows.push(["Frames with unloaded sprites",
        `${summary.framesWithMissingSprites} — paint times not representative`]);
    }
    if (summary.peakOverdraw > 0) rows.push(["Peak overdraw", `${summary.peakOverdraw.toFixed(2)}×`]);
    if (summary.peakHeapMB !== null) rows.push(["Peak JS heap", `${summary.peakHeapMB} MB`]);

    const topPhases = summary.phaseTotals.filter((p) => p.ms > 0).slice(0, 3);
    if (topPhases.length > 0) {
      rows.push(["Cost by phase",
        topPhases.map((p) => `${p.phase} ${p.ms.toFixed(0)} ms (${pct(p.share)})`).join(", ")]);
    }
    const realRebuilds = summary.rebuilds.filter((r) => r.reason !== "none");
    if (realRebuilds.length > 0) {
      rows.push(["Scene rebuilds",
        realRebuilds.map((r) => `${r.reason} ×${r.count}`).join(", ")]);
    }

    for (const [label, value] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("td"); th.textContent = label;
      const td = document.createElement("td"); td.textContent = value;
      tr.append(th, td);
      body.appendChild(tr);
    }
    table.appendChild(body);
    debugRecordSummary.appendChild(table);

    debugRecordRows.replaceChildren(
      ...slowestFrames(log, 10).map((frame) => {
        const phase = worstPhase(frame);
        const tr = document.createElement("tr");
        const painted = frame.paint.skipped > 0
          ? `${frame.paint.drawn}/${frame.paint.drawn + frame.paint.skipped}`
          : `${frame.paint.drawn}`;
        const atlasBusy = frame.atlas.decoding + frame.atlas.queued;
        for (const text of [
          `${(frame.t / 1000).toFixed(1)}s`,
          `${frame.frameMs.toFixed(1)} ms`,
          `${frame.renderMs.toFixed(2)} ms`,
          `${frame.outsideMs.toFixed(1)} ms`,
          `${phase} ${frame.phases[phase].toFixed(2)} ms`,
          painted,
          atlasBusy > 0 ? `${atlasBusy} busy` : "idle",
          frame.rebuildReason === "none" ? "" : frame.rebuildReason,
        ]) {
          const td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        }
        return tr;
      }),
    );
  }

  debugRecordToggle.addEventListener("click", () => {
    if (renderer.isRecording()) renderer.stopFrameRecording();
    else {
      renderer.startFrameRecording(30);
      debugRecordRows.replaceChildren(emptyRow(8, "Recording…"));
      debugRecordSummary.replaceChildren();
    }
    updateRecordPane();
  }, { signal });

  debugRecordCopy.addEventListener("click", () => {
    const log = renderer.getFrameLog();
    const payload = JSON.stringify({
      capturedAt: new Date().toISOString(),
      totalEntities: renderer.getDebugStats().totalEntities,
      viewport: { width: renderer.canvas.getBoundingClientRect().width, height: renderer.canvas.getBoundingClientRect().height, dpr: window.devicePixelRatio },
      userAgent: navigator.userAgent,
      // The same aggregate the panel shows, so whoever reads the JSON does
      // not have to recompute it before knowing where to look.
      summary: summariseRecording(log, viewportArea()),
      frames: log,
    }, null, 2);
    void navigator.clipboard?.writeText(payload).then(
      () => { debugRecordStatus.textContent = "copied to clipboard"; },
      () => { debugRecordStatus.textContent = "clipboard blocked — see console"; console.log(payload); },
    );
  }, { signal });

  // Stress test: stamps a size×size grid of one chosen building, spaced far
  // enough apart that footprints never touch/overlap regardless of the
  // building's own size or facing — for isolating a single sprite's own
  // paint cost from everything else that could be slow (belt animation,
  // wire drawing, other entity kinds mixed in).
  function populateStressEntitySelect(): void {
    // Keeps whatever was picked, if it's still in the (possibly now larger,
    // post-loadData()) list — otherwise falls back to the first entry so the
    // select is never left showing a stale selection with no matching
    // option after the vanilla → real dataset swap below.
    const previous = stressEntitySelect.value;
    stressEntitySelect.replaceChildren();
    for (const entry of placeableEntries(getData(), getRenderCatalog()).sort((a, b) => a.localised.localeCompare(b.localised))) {
      stressEntitySelect.appendChild(new Option(entry.localised, entry.name));
    }
    if (previous && [...stressEntitySelect.options].some((o) => o.value === previous)) {
      stressEntitySelect.value = previous;
    }
  }
  populateStressEntitySelect();

  stressPlaceButton.addEventListener("click", () => {
    const name = stressEntitySelect.value;
    if (!name) {
      stressStatus.textContent = "No building selected.";
      return;
    }
    const gridSize = Math.max(1, Math.min(50, Math.round(Number(stressGridSizeInput.value) || 10)));
    const spacing = Math.max(0, Number(stressSpacingInput.value) || 0);
    const visual = visualLookup().get(name);
    const [fw, fh] = visual ? effectiveFootprint(visual, 0) : [1, 1];
    const cellW = fw + spacing;
    const cellH = fh + spacing;

    const stamped: PlacedEntity[] = [];
    let entityNumber = 1;
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        stamped.push({
          entityNumber: entityNumber++,
          name,
          x: col * cellW,
          y: row * cellH,
          direction: 0,
          quality: "normal",
          modules: [],
          filterItems: [],
        });
      }
    }

    // Replaces whatever's currently loaded rather than adding to it — a
    // repeat click with a different building/size starts clean instead of
    // piling grids on top of each other, and the existing undo stack still
    // gets you back to what was there before (see the pane's own hint text).
    currentBookTree = null;
    librarySidebar?.refresh();
    blueprints = [];
    // No longer the library entry that was open: a plain save must not
    // write the grid over it.
    setOpenEntry(undefined);
    picker.replaceChildren();
    picker.hidden = true;
    input.value = "";
    deselect();
    nextEntityNumber = entityNumber;
    applyEdit(() => {
      entities = stamped;
      wires = [];
    });
    const rect = canvas.getBoundingClientRect();
    const box = { minX: 0, minY: 0, maxX: (gridSize - 1) * cellW, maxY: (gridSize - 1) * cellH };
    renderer.camera.frame(box, rect.width, rect.height);
    const label = stressEntitySelect.selectedOptions[0]?.textContent ?? name;
    stressStatus.textContent = `Placed ${stamped.length} × ${label}.`;
  }, { signal });

  // Polls at a fixed rate independent of the draw loop's own frame rate
  // (updating the DOM every rAF tick would itself be wasted layout/paint
  // work, and defeats the point of a panel meant to diagnose a SLOW frame
  // rate) — only while the panel is actually visible.
  const DEBUG_POLL_MS = 500;
  const debugPollHandle = setInterval(refreshDebug, DEBUG_POLL_MS);

  let blueprints: Blueprint[] = [];
  /** Which of `blueprints` is on the canvas (a book holds several). */
  let selectedBlueprint = 0;
  /** What a blueprint built from the canvas keeps from the one it was
   *  opened as: its name, description, icons and grid settings. */
  function currentTemplate(): Pick<Blueprint, "item" | "label" | "version"> & Partial<Blueprint> {
    return blueprints[selectedBlueprint] ?? { item: "blueprint" as const, label: undefined, version: undefined };
  }
  /** The currently-loaded book's folder structure (nested sub-books kept
   *  intact), for the library sidebar's "Current book" section — null for a
   *  loose blueprint (nothing to show as a folder) or before anything's been
   *  imported yet. Set by every load() call, read by the sidebar's own
   *  refresh(). */
  let currentBookTree: BlueprintTreeNode | null = null;
  let entities: PlacedEntity[] = [];
  /** The blueprint's wires — both the ones it was loaded with and any the
   *  user has since made, by placing a pole (copper auto-connects) or by
   *  wiring two entities by hand. Kept beside `entities` because a wire
   *  names the entities it joins by number, so the two must stay in step. */
  let wires: WireLink[] = [];
  /** The first entity picked in a two-click wire gesture, or null when the
   *  next click starts a fresh pair. Cleared by the first 'q' press; a
   *  second 'q' leaves wire mode entirely (see the 'q' handler). */
  let pendingWireFrom: number | null = null;
  /** Which terminal of pendingWireFrom the wire leaves from: 2 for a
   *  combinator's output, else 1. */
  let pendingWireSide: 1 | 2 = 1;

  /** Arms or clears the half-finished wire pick, keeping the renderer in
   *  step so it can trail the in-progress wire to the cursor. Every write
   *  goes through here rather than assigning the variable directly — the
   *  pick is cleared from seven places (undo, redo, erase, mode changes,
   *  completing a wire, 'q'), and one of them forgetting to notify would
   *  leave a wire dangling from an entity the app no longer considers
   *  armed. */
  function setPendingWireFrom(entityNumber: number | null, side: 1 | 2 = 1): void {
    pendingWireFrom = entityNumber;
    pendingWireSide = side;
    renderer.setPendingWire(entityNumber, side);
  }
  /** Which wire colour is on the cursor (Alt+C/R/G), or null outside wire
   *  mode. Mirrors the renderer's own 'wire' InteractionMode so the app can
   *  answer "is a wire in hand" without asking the renderer back. */
  let wireColorInHand: WireColor | null = null;
  let result: CalculationResult | null = null;
  // Set by every edit (applyEdit/undo/redo), cleared by load()/startNew()
  // and after a successful library save — drives the "Save/Discard/Cancel"
  // guard before loading over an in-progress edit the user hasn't saved.
  let hasUnsavedChanges = false;

  const options: ViewOptions = {
    timescale: "minute",
    multiplier: 1,
    scaleFactor: 1,
    measure: { kind: "none" },
    rocketCargo: null,
    researchLevels: {},
  };
  let scaleTarget: { itemName: string; rate: number; timescale: Timescale } | null = null;
  let latestBottlenecks: Map<string, BottleneckSubgroup[]> = new Map();

  let renderer: BlueprintRenderer = mountRenderer(canvas, getData(), getRenderCatalog(), currentQuality());
  // The Graphics window's preset applies to whichever renderer is current.
  const stopQuality = onQualityChange((q) => renderer.setQuality(q));
  wireGraphicsPanel($(".graphics-panel"), signal);
  renderer.onHover(onSchematicHover);
  rateOverlay.attach(renderer);
  // Rebuilt alongside every renderer remount (loadData() resolving with the
  // real dataset, or a later dataset swap) — placeEntity's collision check
  // reads this rather than calling buildVisualLookup per click.
  // Read from the renderer rather than built here: the renderer already has
  // exactly this table, and keeping a second copy meant remembering to
  // rebuild both whenever the dataset was swapped.
  const visualLookup = () => renderer.getVisualLookup();

  // Alt mode: Factorio's own alt-key view — recipe icons on machines,
  // module icons on machines/beacons. A persistent toggle (button or the
  // 'Alt' key itself, tap not hold) rather than a held-key overlay, since a
  // held modifier fights normal web page behavior (alt+click, alt+tab)
  // more than it helps here. Survives the loadData() renderer swap below
  // by being re-applied to the fresh instance rather than living on the
  // renderer itself.
  let altModeOn = false;
  // What alt mode shows, picked from the alt-mode button's right-click
  // menu. Ports are the rate overlay's tabs, shown on their own here even
  // with the Rate Calculator window closed.
  let altLayers = readAltLayers();
  function setAltMode(enabled: boolean) {
    altModeOn = enabled;
    applyAltMode();
    syncQuickbar();
  }
  function setAltLayers(layers: AltLayers) {
    altLayers = { ...layers };
    writeAltLayers(altLayers);
    applyAltMode();
    syncQuickbar();
  }
  function applyAltMode() {
    renderer.setAltMode(altModeOn);
    renderer.setAltModeLayers(altLayers);
    rateOverlay.setPortsOnly(altModeOn && altLayers.ports);
    rateOverlay.setAltDisplays(altModeOn);
  }

  /** Mirrors the editor state onto the quickbar: undo/redo availability,
   *  which tool toggles are on, and which slot's item is in the cursor.
   *  Called from every place that changes one of those. */
  function syncQuickbar(): void {
    quickbar?.sync({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      boxMode: boxModeKind === "copyBox" || boxModeKind === "deleteBox" ? boxModeKind : null,
      altMode: altModeOn,
      altLayers,
      wire: wireColorInHand,
      held: paletteSelection ? { name: paletteSelection, quality: paletteQuality } : null,
    });
  }

  /** True while one of the three box-drag action modes (copyBox/cutBox/
   *  deleteBox) is active — Cmd+C/Cmd+X/Alt+D each set this via setMode
   *  (see setMode's own comment). No toolbar button for these: they're
   *  keyboard-only, matching the user's "Cmd+C activates the copy tool"
   *  framing (real Factorio doesn't toolbar-button its own cut/copy/delete
   *  shortcuts either). */
  let boxModeOn = false;
  /** Which of the three box tools boxModeOn means — the quickbar lights the
   *  matching planner button. */
  let boxModeKind: "copyBox" | "cutBox" | "deleteBox" | null = null;
  /** Set while the library window's reassign waits for a copy box. */
  let pendingReselect: ((bpString: string) => void) | null = null;
  /** True while a copy/cut's multi-entity ghost is armed on the cursor
   *  ('paste' mode) — set by copyBoxToClipboardAndGhost, cleared by setMode
   *  (any call puts the renderer into a mode other than 'paste'). Tracked
   *  separately from boxModeOn since a completed copy/cut box hands off
   *  from copyBox/cutBox mode straight to paste mode; Escape needs to know
   *  about both to decide whether it should intercept the keypress. */
  let pasteArmed = false;
  // Toggles on key-UP, not key-DOWN — matches the real game's own Alt-mode
  // gesture (holding Alt doesn't preview it here, it's a plain toggle) and
  // avoids a held key's own OS-level repeat re-firing this on every
  // auto-repeat tick the way keydown would.
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Alt") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    // The Alt release that ends an Alt-modified gesture (Shift+Alt+scroll
    // quality cycling, Alt+right-click module stamping) isn't a plain "tap
    // Alt" toggle press — skip the toggle just this once and clear the flag
    // for the next, genuinely plain release.
    if (usedAltAsModifier) {
      usedAltAsModifier = false;
      return;
    }
    setAltMode(!altModeOn);
  }, { signal });

  /** Status lines surface as a short toast under the toolbar. Errors always
   *  show; routine info (tool hints, "placed 3 entities") only when the
   *  caller asks, so working on the canvas doesn't flash a toast per click. */
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  function setStatus(message: string, kind: "info" | "error" = "info", show = kind === "error") {
    status.textContent = message;
    status.dataset.kind = kind;
    if (!show) return;
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, kind === "error" ? 6000 : 3500);
  }

  function groupForEntity(entityNumber: number): MachineGroup | null {
    if (!result) return null;
    return result.groups.find((g) => g.entityNumbers.includes(entityNumber)) ?? null;
  }

  /** Identifies what the tooltip is currently showing, so a pointer move over
   *  the same machine group doesn't rebuild the card — and, more importantly,
   *  doesn't have to re-measure it. Measuring right after replacing the
   *  tooltip's children forces a synchronous layout, and that was happening on
   *  every single hover move. */
  let tooltipContentKey: string | null = null;
  let tooltipSize = { width: 0, height: 0 };

  /** Positions the tooltip from the cached size — pure arithmetic, no layout
   *  read. Uses transform rather than left/top so the browser can skip layout
   *  and paint entirely and just re-composite. */
  function positionTooltip(event: PointerEvent) {
    const margin = 16;
    const { width, height } = tooltipSize;
    let x = event.clientX + margin;
    let y = event.clientY + margin;
    if (x + width > window.innerWidth - margin) x = event.clientX - width - margin;
    if (y + height > window.innerHeight - margin) y = event.clientY - height - margin;
    tooltip.style.transform = `translate(${Math.max(margin, x)}px, ${Math.max(margin, y)}px)`;
  }

  function onSchematicHover(entityNumber: number | undefined, event: PointerEvent) {
    // Tracked independently of the rate-group lookup below (which only
    // resolves for entities the calc engine groups — poles/belts/etc. have
    // none) since the 'q' pipette shortcut needs to know what's under the
    // cursor regardless of whether it's rate-bearing.
    hoveredEntityNumber = entityNumber;
    // With the rate overlay on, its own hover card speaks for the build.
    if (rateOverlay.isEnabled) {
      tooltip.hidden = true;
      tooltipContentKey = null;
      renderer.setHighlight(null);
      return;
    }
    const group = entityNumber === undefined ? null : groupForEntity(entityNumber);
    if (!group || entityNumber === undefined) {
      tooltip.hidden = true;
      tooltipContentKey = null;
      renderer.setHighlight(null);
      return;
    }

    // Two machines of the same group render the identical card, so key on what
    // the card actually shows rather than on the entity: moving along a row of
    // identical assemblers then costs no rebuild and no measurement at all.
    // group.key covers beacon count and effects too — machines that differ
    // only in beacon coverage are separate groups with different rates.
    const contentKey = `${group.key}|${group.count}|${options.timescale}|${options.multiplier}|${options.scaleFactor}`;
    if (contentKey !== tooltipContentKey) {
      tooltipContentKey = contentKey;
      const card = buildRecipeCard(group, getData(), options);
      const window_ = document.createElement("div");
      window_.className = "gui-body";
      window_.appendChild(card);
      tooltip.replaceChildren(window_);
      tooltip.hidden = false;
      // The one layout read, and only when the content actually changed. Width
      // is fixed in CSS (.machine-tooltip), so only the height really varies.
      const rect = tooltip.getBoundingClientRect();
      tooltipSize = { width: rect.width, height: rect.height };
    } else {
      tooltip.hidden = false;
    }
    positionTooltip(event);

    const beacons = new Set(result!.beaconsInRange.get(entityNumber) ?? []);
    const role: HighlightRole = {
      producers: new Set(group.entityNumbers),
      consumers: new Set(),
      beacons,
    };
    renderer.setHighlight(role);
  }

  // Dev-loop convenience: persists whatever's currently on the canvas so a
  // manually-placed layout survives the page reloads this session's own
  // code edits trigger via Vite HMR — without this, every renderer.ts/
  // entityRenderers.ts save wiped out hand-placed test entities the user
  // was mid-edit on, which is exactly what prompted adding this. Keyed to
  // one fixed slot (not per-blueprint) since this is a single-tab dev aid,
  // not a real save-slot feature; silently no-ops if storage is
  // unavailable (private browsing, quota) rather than surfacing an error
  // for what's just a convenience.
  const AUTOSAVE_KEY = EDITOR_AUTOSAVE_KEY;
  /** False only for a truly empty canvas: a blueprint of nothing but floor
   *  tiles is still something to save, export and restore. */
  function hasBlueprintContent(): boolean {
    return entities.length > 0 || (currentTemplate().tiles?.length ?? 0) > 0;
  }
  function persistEntities(): void {
    if (!hasBlueprintContent()) return;
    try {
      const template = currentTemplate();
      const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, template, wires) });
      localStorage.setItem(AUTOSAVE_KEY, bpString);
    } catch {
      /* storage unavailable — not worth surfacing for a dev convenience */
    }
  }

  // Remembers where the camera was pointed (world position + zoom) across
  // page reloads, so refreshing mid-session doesn't snap back to the
  // blueprint's auto-framed overview. Keyed alongside AUTOSAVE_KEY, one fixed
  // slot rather than per-blueprint — same dev-convenience scope as the
  // autosave next to it.
  const CAMERA_KEY = "factoriotools.blueprint-viewer.camera";

  function persistCamera(): void {
    try {
      localStorage.setItem(CAMERA_KEY, JSON.stringify(renderer.camera.state));
    } catch {
      /* storage unavailable — not worth surfacing for a dev convenience */
    }
  }

  /** Overrides whatever auto-frame loadBlueprint() just did with the last
   *  saved position/zoom, if one exists. Called right after every
   *  loadBlueprint() so a restored session reopens exactly where it left
   *  off instead of re-fitting to the blueprint's extent.
   *
   *  Reads the value captured BEFORE loadBlueprint() ran (passed in as
   *  `savedBeforeLoad`) rather than re-reading localStorage here: framing
   *  the blueprint fires the camera's onChange listener, which includes
   *  persistCamera — so by the time this function would read localStorage,
   *  loadBlueprint's own auto-frame has already clobbered the very value
   *  this is trying to restore. */
  function restoreCamera(savedBeforeLoad: string | null): void {
    if (!savedBeforeLoad) return;
    try {
      const state = JSON.parse(savedBeforeLoad) as { x: number; y: number; pixelsPerTile: number };
      if (typeof state.x !== "number" || typeof state.y !== "number" || typeof state.pixelsPerTile !== "number") return;
      renderer.camera.state.x = state.x;
      renderer.camera.state.y = state.y;
      renderer.camera.state.pixelsPerTile = state.pixelsPerTile;
      renderer.updateEntities(entities, wires); // repaint with the restored view, not the auto-framed one
      // Mutating .state directly doesn't fire the camera's onChange, so
      // re-save explicitly — otherwise the auto-framed value loadBlueprint's
      // own frame() just persisted stays in storage, and the NEXT
      // loadBlueprint (the loadData() dataset swap) would read that stale
      // auto-framed value instead of the one just restored here.
      persistCamera();
    } catch {
      /* malformed saved state — keep whatever loadBlueprint() just framed */
    }
  }

  /** Snapshot of CAMERA_KEY taken right before a loadBlueprint() call, for
   *  restoreCamera() to use — see its own doc comment for why it can't just
   *  read localStorage fresh at that point. */
  function readSavedCamera(): string | null {
    try {
      return localStorage.getItem(CAMERA_KEY);
    } catch {
      return null;
    }
  }

  /** Wired onto whichever BlueprintRenderer instance is currently mounted —
   *  mirrors wireEditCallbacks() below, needed again after loadData()'s
   *  renderer swap since a fresh Camera has an empty listener set. */
  function wireCameraPersistence() {
    renderer.camera.onChange(persistCamera);
  }
  wireCameraPersistence();

  /** `restoreCameraFromSave` is true only for the one startup path that
   *  re-opens whatever was on screen before a page reload (the autosave
   *  restore) — every other caller (picking a blueprint from the library,
   *  importing one, switching sub-blueprints in the picker) is loading
   *  content the camera has never been positioned for, so it should
   *  auto-frame like it always did rather than jump to wherever the
   *  camera happened to be pointed for the PREVIOUS blueprint. */
  function selectBlueprint(index: number, restoreCameraFromSave = false) {
    const blueprint = blueprints[index];
    if (!blueprint) return;
    selectedBlueprint = index;
    entities = normaliseEntities(blueprint);
    wires = normaliseWires(blueprint);
    nextEntityNumber = entities.reduce((max, e) => Math.max(max, e.entityNumber), 0) + 1;
    undoStack = [];
    redoStack = [];
    // Reset in lockstep with the entity stacks: leaving the previous
    // blueprint's wire snapshots behind would make the first undo after a
    // load restore stale wires against the freshly-loaded entities.
    undoWires = [];
    redoWires = [];
    hasUnsavedChanges = false;
    deselect();
    const savedCamera = restoreCameraFromSave ? readSavedCamera() : null;
    renderer.loadBlueprint(entities, wires, blueprint.tiles);
    restoreCamera(savedCamera);
    rateOverlay.load(entities, wires);
    recalculate();
    persistEntities();
    syncQuickbar();
  }

  /** Clears the canvas to an empty blueprint — the Library sidebar's "+ New
   *  blueprint" button. Clears the autosave slot directly (rather than
   *  relying on persistEntities, which deliberately no-ops on an empty
   *  entities list so a genuinely-empty in-progress edit never wipes a
   *  previous autosave) so a reload doesn't resurrect the blueprint just
   *  cleared. */
  function startNew(): void {
    blueprints = [];
    currentBookTree = null;
    librarySidebar?.refresh();
    entities = [];
    wires = [];
    nextEntityNumber = 1;
    undoStack = [];
    redoStack = [];
    undoWires = [];
    redoWires = [];
    hasUnsavedChanges = false;
    setOpenEntry(undefined);
    deselect();
    renderer.loadBlueprint(entities, wires);
    recalculate();
    syncQuickbar();
    picker.replaceChildren();
    picker.hidden = true;
    input.value = "";
    setStatus("Started a new, empty blueprint.");
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* storage unavailable — not worth surfacing here */
    }
  }

  // ---------- editing ----------

  let nextEntityNumber = 1;
  let selectedEntity: PlacedEntity | undefined;
  /** Whatever's currently under the cursor, kept live by onSchematicHover
   *  regardless of mode — what the 'q' pipette shortcut reads. */
  let hoveredEntityNumber: number | undefined;

  // Undo/redo: plain snapshot stack (not diff/command-pattern — unwarranted
  // complexity at this scale). The one real footgun: entity.modules is
  // itself an array of objects, and recipe/module edits mutate an existing
  // entity (and its nested modules array) in place — a shallow
  // entities.map(e => ({...e})) would leave `modules` a shared reference,
  // so a later module-edit on a live entity would silently corrupt an
  // already-pushed snapshot. Clone two levels deep: entity + its modules
  // array + each module object — exactly as deep as PlacedEntity nests.
  let undoStack: PlacedEntity[][] = [];
  let redoStack: PlacedEntity[][] = [];
  /** Wire snapshots, pushed and popped in lockstep with the entity stacks
   *  above. Kept as a parallel array rather than folded into the entity
   *  snapshot because a wire names entities by number: undoing entities
   *  without undoing wires would leave copper pointing at an entity number
   *  that no longer exists, and undoing wires without entities would drop
   *  connections the restored poles still expect. */
  let undoWires: WireLink[][] = [];
  let redoWires: WireLink[][] = [];

  /** Ceiling on how many snapshots either history keeps. Each entry is a full
   *  copy of every entity — measured at ~1.1 MB on a 6.5k-entity blueprint —
   *  and a drag places or mines one entity per cell crossed, so an
   *  uncapped history grew by hundreds of megabytes over a normal editing
   *  session (200 edits measured at 224 MB) on top of the decoded sprite
   *  sheets. 50 steps covers any realistic "undo what I just did" and bounds
   *  the cost at roughly a tenth of that. */
  const HISTORY_LIMIT = 50;

  /** Pushes onto a history stack, dropping the oldest entry once the limit is
   *  reached — the far end of a long history is what nobody reaches for. */
  function pushHistory(stack: PlacedEntity[][], snapshot: PlacedEntity[]): void {
    stack.push(snapshot);
    if (stack.length > HISTORY_LIMIT) stack.shift();
  }

  function snapshotEntities(): PlacedEntity[] {
    return entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));
  }

  /** Every mutating edit (place/remove/rotate/recipe/module) goes through
   *  this one choke point: snapshot for undo, clear redo (a new edit
   *  invalidates redo history), run the mutation, then push the shared
   *  entities/renderer/recalculate/re-render sequence every edit needs. */
  function applyEdit(mutate: () => void): void {
    pushHistory(undoStack, snapshotEntities());
    // Wires ride the same history as entities — see undoWires' own comment
    // for why they cannot be undone independently of each other.
    undoWires.push(wires);
    if (undoWires.length > HISTORY_LIMIT) undoWires.shift();
    redoStack = [];
    redoWires = [];
    mutate();
    hasUnsavedChanges = true;
    renderer.updateEntities(entities, wires);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
    syncQuickbar();
  }

  function undo(): void {
    if (!undoStack.length) return;
    pushHistory(redoStack, snapshotEntities());
    redoWires.push(wires);
    entities = undoStack.pop()!;
    // Popped in lockstep: the two stacks are pushed together by every edit,
    // so they are always the same depth.
    wires = undoWires.pop() ?? wires;
    selectedEntity = undefined; // safest default: it may not exist post-undo
    setPendingWireFrom(null); // the half-picked entity may not exist post-undo
    hasUnsavedChanges = true;
    renderer.updateEntities(entities, wires);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
    syncQuickbar();
  }

  function redo(): void {
    if (!redoStack.length) return;
    pushHistory(undoStack, snapshotEntities());
    undoWires.push(wires);
    entities = redoStack.pop()!;
    wires = redoWires.pop() ?? wires;
    selectedEntity = undefined;
    setPendingWireFrom(null);
    hasUnsavedChanges = true;
    renderer.updateEntities(entities, wires);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
    syncQuickbar();
  }

  function deselect() {
    selectedEntity = undefined;
    propertiesWindow.hide();
    recipeWindow.hide();
  }

  /** How far an underground-belt tier can tunnel (0 for loaders, which
   *  never pair). */
  function undergroundMaxDistance(name: string): number {
    return getData().undergroundBelts?.[name]?.maxDistance ?? 0;
  }

  /** Building over an existing entity at the SAME spot rebuilds it in place
   *  instead of colliding with it — the real game's own build-over
   *  convention. Over the same entity that re-faces it or changes its
   *  quality (chosen instead of a quality field in the entity GUI, which no
   *  longer exists); over another one from its fast-replace group with the
   *  same footprint (any inserter over any inserter, a turbine over a steam
   *  engine — see canBuildOver) it swaps the entity, keeping its wires and
   *  whatever settings the new one can still hold. Anything else there
   *  still blocks the placement. */
  function placeEntity(worldX: number, worldY: number, name: string, direction: number, quality: QualityName, railLayer?: "elevated") {
    const lookup = visualLookup();
    // A signal on the deck and one on the ground below it are separate spots.
    const existing = entities.find(
      (e) => e.railLayer === railLayer && canBuildOver(e, name, worldX, worldY, direction, (n) => lookup.get(n), getRenderCatalog().replaceGroups),
    );
    // Building the exact same thing again (same quality AND facing) is a
    // no-op.
    if (existing && existing.name === name && existing.quality === quality && existing.direction === direction) return;
    // In real Factorio nothing shares a tile — reject a placement that
    // collides with any already-placed entity (entitiesCollide: footprint
    // boxes, except that track blocks only the tiles it runs over, elevated
    // track blocks nothing on the ground, and signals and train stops stand
    // beside track). Unknown-footprint entities fall back to 1x1, matching
    // buildVisualLookup's own default. The one entity being built over is
    // exempt, but everything else is still checked: re-facing a non-square
    // entity in place can swing it onto a neighbour.
    const candidate: PlacedEntity = { entityNumber: -1, name, x: worldX, y: worldY, direction, railLayer, quality, modules: [], filterItems: [] };
    const collides = entities.some((e) => e !== existing && entitiesCollide(candidate, e, footprintOfEntity));
    if (collides) {
      setStatus("Can't build here — something else already occupies that space.", "error");
      return;
    }
    if (existing && existing.name !== name) {
      replaceEntity(existing, name, direction, quality);
      return;
    }
    if (existing) {
      // This rebuild-in-place upgrades whichever of quality and facing
      // actually changed — matches the real game's own "build over it to
      // reconfigure" convention.
      mutateEntity(existing, (e) => {
        e.quality = quality;
        e.direction = direction;
      });
      return;
    }
    // Auto-paired like the game (and render.ts's ghost): held facing back
    // at an entrance in range, this becomes its exit.
    const underground = isUndergroundLike(name)
      ? undergroundForPlacement(entities, name, worldX, worldY, direction, undergroundMaxDistance(name), undefined)
      : undefined;
    applyEdit(() => {
      const newEntity: PlacedEntity = {
        entityNumber: nextEntityNumber++,
        name,
        x: worldX,
        y: worldY,
        direction: underground?.direction ?? direction,
        railLayer,
        quality,
        modules: [],
        filterItems: [],
        // collect.ts needs undergroundType defined to draw an
        // underground/loader as one (half-cropped lane, own-end cap only)
        // rather than as a plain belt.
        undergroundType: underground?.undergroundType,
      };
      entities = [...entities, newEntity];
      // A pole dropped beside a powered one joins the network on the spot,
      // the way the game does it — copper only, and only for poles.
      // autoConnectPole is a no-op for everything else. Runs inside the same
      // applyEdit as the placement, so the pole and its wires undo together
      // rather than as two separate steps.
      wires = autoConnectPole(newEntity, entities, wires, visualLookup().get.bind(visualLookup()), isPoleLike);
    });
  }

  /** The swap half of placeEntity: turns `target` into `name` where it
   *  stands. It keeps its entityNumber, so every wire on it survives, and
   *  its settings carry over except the ones the new entity can't hold — a
   *  recipe it can't craft is cleared and modules beyond its slot count are
   *  dropped. An underground swapped for another tier stays the same end of
   *  its pair and takes the other end along when the new tier still reaches
   *  it, the way the game upgrades a pair. */
  function replaceEntity(target: PlacedEntity, name: string, direction: number, quality: QualityName) {
    const data = getData();
    const underground = isUndergroundLike(name)
      ? undergroundForPlacement(entities, name, target.x, target.y, direction, undergroundMaxDistance(name), target)
      : undefined;
    const partner =
      underground && target.undergroundType !== undefined
        ? undergroundPartner(entities, target, undergroundMaxDistance(target.name))
        : undefined;
    const partnerInReach =
      partner && Math.abs(partner.x - target.x) + Math.abs(partner.y - target.y) <= undergroundMaxDistance(name) ? partner : undefined;
    const machine = data.machines[name];
    const moduleSlots = machine?.moduleSlots ?? data.beacons[name]?.moduleSlots ?? 0;
    applyEdit(() => {
      target.name = name;
      target.quality = quality;
      target.direction = underground?.direction ?? direction;
      target.undergroundType = underground?.undergroundType;
      const recipe = target.recipe ? data.recipes[target.recipe] : undefined;
      if (!recipe || !machine?.categories.includes(recipe.category)) target.recipe = undefined;
      target.modules = collapseModules(
        expandModuleSlots(target.modules)
          .slice(0, moduleSlots)
          .filter((slot) => slot !== null),
      );
      if (partnerInReach) partnerInReach.name = name;
      entities = [...entities];
    });
  }

  function footprintOfEntity(e: PlacedEntity): [number, number] {
    const visual = visualLookup().get(e.name);
    return visual ? effectiveFootprint(visual, e.direction) : [1, 1];
  }

  /** Lays planned track (and the supports under its elevated part) as one
   *  undo step. Pieces already in place are kept as they are; a piece or
   *  support that would land on something is skipped, which only happens
   *  when the blueprint changed under a stale plan. */
  function placeRails(pieces: RailPiece[], supports: RailPiece[]) {
    const { pieces: fresh, supports: freshSupports } = buildableRails(entities, footprintOfEntity, pieces, supports);
    if (fresh.length === 0 && freshSupports.length === 0) return;
    applyEdit(() => {
      const added = [...fresh, ...freshSupports].map((p): PlacedEntity => ({
        entityNumber: nextEntityNumber++,
        name: p.name,
        x: p.x,
        y: p.y,
        direction: p.direction,
        quality: "normal",
        modules: [],
        filterItems: [],
      }));
      entities = [...entities, ...added];
    });
  }

  function removeEntity(entityNumber: number) {
    if (selectedEntity?.entityNumber === entityNumber) deselect();
    // A half-picked wire whose first end is the entity being erased has no
    // valid second click left, so drop the pick rather than let the next
    // click complete a wire to something that no longer exists.
    if (pendingWireFrom === entityNumber) setPendingWireFrom(null);
    applyEdit(() => {
      entities = entities.filter((e) => e.entityNumber !== entityNumber);
      // Otherwise its wires would hang in the air pointing at a gone entity.
      wires = dropWiresFor(wires, new Set([entityNumber]));
    });
  }

  /** Batch delete for the box-drag delete tool (Alt+D) and the delete half
   *  of cut — same shape as removeEntity, generalized to a Set so the whole
   *  box undoes as ONE step instead of one per entity. */
  function removeEntities(numbers: ReadonlySet<number>) {
    if (numbers.size === 0) return;
    if (selectedEntity && numbers.has(selectedEntity.entityNumber)) deselect();
    if (pendingWireFrom !== null && numbers.has(pendingWireFrom)) setPendingWireFrom(null);
    applyEdit(() => {
      entities = entities.filter((e) => !numbers.has(e.entityNumber));
      wires = dropWiresFor(wires, new Set(numbers));
    });
  }

  /** Shared by the copy and cut box tools: writes the given entities to the
   *  system clipboard as a real, Factorio-compatible blueprint string (same
   *  encode path the Export button uses, just filtered to the box), AND
   *  arms them as a multi-entity paste ghost so the group can be stamped
   *  straight back down without a separate Cmd+V. Entities carry placeholder
   *  entityNumbers in the ghost — onPaste below remaps to fresh ones on
   *  every stamp, since the ghost stays armed for repeated placement. Takes
   *  the box's entity numbers directly (not read from renderer state) since
   *  both callers already have them as the argument their onCopyBox/onCutBox
   *  callback was fired with. */
  async function copyBoxToClipboardAndGhost(numbers: ReadonlySet<number>): Promise<void> {
    const boxedEntities = entities.filter((e) => numbers.has(e.entityNumber));
    if (boxedEntities.length === 0) return;
    const boxedWires = wires.filter((w) => numbers.has(w.from) && numbers.has(w.to));

    const template = currentTemplate();
    try {
      const bpString = encodeBlueprintString({ blueprint: toBlueprint(boxedEntities, template, boxedWires) });
      await navigator.clipboard.writeText(bpString);
    } catch {
      setStatus("Copied as a ghost, but couldn't write to the system clipboard.", "error");
    }

    // The ghost is held from the group's CENTER, not a corner — matches
    // where the cursor naturally sits relative to what you're dragging.
    // minX/maxX use each entity's own center coordinate (PlacedEntity.x is
    // already a center), not footprint-inset edges, same precision the
    // rest of this feature already uses (e.g. the marquee-box hit test).
    const minX = Math.min(...boxedEntities.map((e) => e.x));
    const minY = Math.min(...boxedEntities.map((e) => e.y));
    const maxX = Math.max(...boxedEntities.map((e) => e.x));
    const maxY = Math.max(...boxedEntities.map((e) => e.y));
    // Placeholder ids are per-copy array indices (-1, -2, ...), NOT the
    // original entityNumbers — boxedWires still points at the originals, so
    // it must be remapped onto the placeholders here too, or every wire
    // between two entities in the group (e.g. two power poles) silently
    // fails to find its endpoints once onPaste's remapSelectionForPaste
    // looks them up by the placeholder ids it actually has.
    const placeholderIdByOriginal = new Map(boxedEntities.map((e, i) => [e.entityNumber, -1 - i]));
    const placeholders = boxedEntities.map((e) => ({ ...e, entityNumber: placeholderIdByOriginal.get(e.entityNumber)! }));
    const placeholderWires = boxedWires.map((w) => ({
      ...w,
      from: placeholderIdByOriginal.get(w.from)!,
      to: placeholderIdByOriginal.get(w.to)!,
    }));
    pasteArmed = true;
    renderer.setInteractionMode({
      kind: "paste",
      entities: placeholders,
      wires: placeholderWires,
      anchor: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      groupRotation: 0,
    });
    setStatus(`Copied ${boxedEntities.length} ${boxedEntities.length === 1 ? "entity" : "entities"} — click to place (Esc to stop).`);
  }

  /** Groups a "one slot = one module" working array back into the data
   *  model's ModuleStack[] shape (same name+quality collapsed with a
   *  count) — keeps entity.modules exactly what the calc engine already
   *  expects, no engine-side changes needed. */
  function collapseModules(slots: { name: string; quality: QualityName }[]): ModuleStack[] {
    const byKey = new Map<string, ModuleStack>();
    for (const slot of slots) {
      const key = `${slot.name}/${slot.quality}`;
      const existing = byKey.get(key);
      if (existing) existing.count += 1;
      else byKey.set(key, { name: slot.name, quality: slot.quality, count: 1 });
    }
    return [...byKey.values()];
  }

  /** Inverse of collapseModules — expands entity.modules into one entry per
   *  slot, in slot order. Shared by the entity GUI's module-slot buttons
   *  (which edit one slot at a time) so a single-slot change round-trips
   *  through the exact same expand -> mutate -> collapse the old
   *  multi-slot-select UI used, just triggered per-button instead of
   *  per-form-submit. */
  function expandModuleSlots(modules: ModuleStack[]): ({ name: string; quality: QualityName } | null)[] {
    const slots: { name: string; quality: QualityName }[] = [];
    for (const stack of modules) {
      for (let i = 0; i < stack.count; i++) slots.push({ name: stack.name, quality: stack.quality });
    }
    return slots;
  }

  /** Mutates the currently-selected entity in place (matches the
   *  codebase's normalized PlacedEntity shape — the calc engine reads
   *  whatever's on the object directly) and re-renders/recalculates. */
  /** Mutates any live entity in place and re-renders/recalculates — the
   *  shared primitive updateSelectedEntity (below) and placeEntity's
   *  build-over-to-upgrade-quality path both go through, so every edit
   *  path pushes exactly one undo snapshot via applyEdit regardless of
   *  which UI triggered it. */
  function mutateEntity(target: PlacedEntity, mutate: (entity: PlacedEntity) => void) {
    applyEdit(() => {
      mutate(target);
      entities = [...entities];
    });
  }

  function updateSelectedEntity(mutate: (entity: PlacedEntity) => void) {
    if (!selectedEntity) return;
    mutateEntity(selectedEntity, mutate);
  }

  /** Quarter-turn step in the 16-way scheme (step 4 of a full turn of 16)
   *  for most entities — matches toCardinal()'s own commitment to
   *  16-way-only (see its doc comment in
   *  packages/renderer/src/beltGraph.ts): every direction value this app
   *  produces or reads is 16-way, since that's the only scheme Factorio 2.0
   *  blueprint exports use. rotationStep gives a finer step (1 of 16) for
   *  rail-signal/rail-chain-signal, matching the real game's own 22.5°
   *  rotate gesture for those two. Shared by the properties panel's Rotate
   *  button and the 'r'/Shift+R keyboard shortcut (both the
   *  currently-selected AND the merely-hovered-under-cursor path) so every
   *  trigger rotates identically. `reverse` turns counter-clockwise
   *  (Shift+R) instead of the default clockwise (r). */
  function rotateEntity(target: PlacedEntity, reverse = false) {
    if (isPoleLike(target.name)) return;
    // A support holding up track is fixed by it: only a bare one turns.
    if (
      target.name === "rail-support" &&
      entities.some((e) => isElevatedRail(e.name) && railEndsAt(e).some((end) => end.x === target.x && end.y === target.y && supportHolds(target.direction, end.dir)))
    ) {
      return;
    }
    if (target.undergroundType !== undefined) {
      // Like the game, R on an underground swaps entrance and exit instead
      // of turning it: the hood stays put and the flow reverses, so the
      // stored travel direction flips too. Its paired other half (if any)
      // flips with it, keeping the pair intact — one undo step for both.
      const partner = undergroundPartner(entities, target, undergroundMaxDistance(target.name));
      applyEdit(() => {
        for (const e of partner ? [target, partner] : [target]) {
          e.undergroundType = e.undergroundType === "output" ? "input" : "output";
          e.direction = (e.direction + 8) % 16;
        }
        entities = [...entities];
      });
      return;
    }
    if (isTwoDirectionOnly(target.name)) {
      // Only two facings exist at all (north=0, east=4) — R just toggles
      // between them, `reverse` is a no-op.
      mutateEntity(target, (e) => {
        e.direction = e.direction === 0 ? 4 : 0;
      });
      return;
    }
    let step = rotationStep(target.name);
    // A non-square footprint that swaps width/height on rotation (e.g. a
    // 3x2 assembler-adjacent building) can't take a plain 90° turn once
    // it's already placed: swapping the footprint's dimensions in place
    // flips which axis is odd/even, and snapAxis's tile-grid rounding then
    // lands the entity's center on a half-tile offset it was never built
    // on. The real game avoids this by only offering a 180° turn for these
    // — same facing-pair, footprint unchanged, no misalignment — so double
    // the step here too rather than actually moving the entity to
    // compensate. A square footprint (or one that doesn't rotate at all)
    // has no such axis to flip and keeps its normal 90° step.
    const visual = visualLookup().get(target.name);
    if (visual?.rotatesFootprint && visual.tileFootprint[0] !== visual.tileFootprint[1]) {
      step *= 2;
    }
    mutateEntity(target, (e) => {
      e.direction = (e.direction + (reverse ? -step : step) + 16) % rotationCount(e.name);
    });
  }

  function rotateSelected(reverse = false) {
    if (!selectedEntity) return;
    rotateEntity(selectedEntity, reverse);
  }

  let paletteSelection: string | null = null;
  /** Quality newly-placed entities carry — set by the palette's quality
   *  strip (edit-palette.ts's buildQualityStrip), read here by onPlace.
   *  Defaults to "normal" for the 'q' pipette path, which has no quality
   *  strip of its own to read from. */
  let paletteQuality: QualityName = "normal";

  /** Matches the real game's own cursor model — no separate select-mode
   *  toggle to remember. "idle" means nothing's in hand: left-click on an
   *  entity opens it, left-click on empty space pans. "place" means an
   *  entity IS in hand (picked from the palette, or via the 'q' pipette
   *  below): left-click places it. "copyBox"/"cutBox"/"deleteBox" are the
   *  three box-drag action tools (Cmd+C/Cmd+X/Alt+D): drag a marquee, or
   *  click one entity, and the box acts immediately — no intermediate
   *  "selected, now confirm" step. Right-click erases in every mode except
   *  these three (wired once in render.ts, not here). */
  function setMode(
    newMode:
      | "idle"
      | "copyBox"
      | "cutBox"
      | "deleteBox"
      | { place: string; quality?: QualityName; direction?: number }
      | { wire: WireColor },
  ) {
    // Leaving wire mode always drops a half-finished pick — otherwise the
    // first end would still be armed the next time wire mode came back on.
    const hadWire = wireColorInHand !== null;
    if (typeof newMode === "string" || !("wire" in newMode)) {
      setPendingWireFrom(null);
      wireColorInHand = null;
    }
    // Any explicit setMode call means the app is switching to a mode OTHER
    // than 'paste' (a completed copy/cut box arms 'paste' directly through
    // the renderer, bypassing setMode entirely) — so a paste ghost armed
    // before this call is no longer current and should stop being tracked
    // as such.
    pasteArmed = false;
    // Any other tool (or Escape) abandons a pending reassign.
    pendingReselect = null;
    if (newMode === "idle") {
      paletteSelection = null;
      renderer.setInteractionMode({ kind: "idle" });
    } else if (newMode === "copyBox" || newMode === "cutBox" || newMode === "deleteBox") {
      paletteSelection = null;
      if (heldModule) {
        heldModule = null;
        updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
      }
      renderer.setInteractionMode({ kind: newMode });
    } else if ("wire" in newMode) {
      // Switching straight from one wire colour to another abandons a pick
      // made in the old colour: its second click would otherwise create a
      // wire in a colour the user has already moved on from.
      if (wireColorInHand !== newMode.wire) setPendingWireFrom(null);
      wireColorInHand = newMode.wire;
      // A wire on the cursor replaces whatever else was in hand — the
      // cursor only ever carries one thing.
      paletteSelection = null;
      if (heldModule) {
        heldModule = null;
        updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
      }
      renderer.setInteractionMode({ kind: "wire", color: newMode.wire });
    } else {
      // Taking an entity into the cursor drops any held module, so the
      // cursor only ever carries one thing (the mirror of setHeldModule's
      // own setMode("idle")).
      if (heldModule) {
        heldModule = null;
        updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
      }
      paletteSelection = newMode.place;
      paletteQuality = newMode.quality ?? "normal";
      renderer.setInteractionMode({ kind: "place", entityName: newMode.place, direction: newMode.direction, quality: paletteQuality });
    }
    // Putting a wire away has to clear its cursor icon here: nothing else
    // will, since the pointermove refresh is gated on something being held.
    if (hadWire && wireColorInHand === null) updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
    // The yellow inward-fading border is the at-a-glance "you have
    // something in hand" cue, matching the real game's own cursor-ghost
    // feedback — on only while actually placing, off once idle.
    canvas.classList.toggle("edit-mode", newMode !== "idle");
    // Centralized here (not just each shortcut's own keydown handler) so
    // ANY path that changes mode — Cmd+C/X, Alt+D, a palette pick, Escape —
    // keeps this in sync. There's no toolbar button to sync anymore (see
    // boxModeOn's own comment), just the cursor styling and the Escape
    // guard's own flag.
    boxModeOn = newMode === "copyBox" || newMode === "cutBox" || newMode === "deleteBox";
    boxModeKind = newMode === "copyBox" || newMode === "cutBox" || newMode === "deleteBox" ? newMode : null;
    canvas.classList.toggle("select-mode", boxModeOn);
    syncQuickbar();
  }

  /** Wired onto whichever BlueprintRenderer instance is currently mounted —
   *  called once at initial mount and again after loadData()'s swap, since
   *  a fresh renderer instance has empty callback slots. */
  function wireEditCallbacks() {
    renderer.onPlace((worldX, worldY, direction, railLayer) => {
      if (!paletteSelection) return;
      placeEntity(worldX, worldY, paletteSelection, direction, paletteQuality, railLayer);
    });
    renderer.onPlaceRails(placeRails);
    renderer.onSelect((entityNumber) => {
      const entity = entities.find((e) => e.entityNumber === entityNumber);
      if (!entity) {
        enterMenuState("default");
        return;
      }
      selectedEntity = entity;
      // A machine with no recipe set yet opens straight into the recipe
      // menu — picking one is the only thing its GUI could usefully offer
      // at that point, so the machine-info screen would just be a step in
      // the way. Everything else (including a recipe-less non-machine like
      // a belt) opens its own GUI.
      const machine = getData().machines[entity.name];
      const needsRecipe = machine !== undefined && machine.kind === "crafting" && !entity.recipe;
      enterMenuState(needsRecipe ? "recipe" : "machine-info");
    });
    renderer.onErase((entityNumber) => {
      removeEntity(entityNumber);
    });
    // Two clicks make or break one wire. The first arms `pendingWireFrom`,
    // the second completes the pair. A click on an entity that has no
    // terminal of the held colour is refused outright rather than armed, so
    // the gesture never strands the user half-way through a wire that could
    // not exist (a belt has no circuit terminals at all).
    renderer.onWireClick((entityNumber, world) => {
      if (wireColorInHand === null) return;
      const entity = entities.find((e) => e.entityNumber === entityNumber);
      if (!entity) return;
      if (!canWire(visualLookup().get(entity.name), wireColorInHand)) {
        setStatus(`A ${entity.name.replace(/-/g, " ")} has no ${wireColorInHand} wire terminal.`, "error");
        return;
      }
      // A combinator's click picks the terminal nearer the cursor: its
      // input or its output side.
      const visual = visualLookup().get(entity.name);
      const side = wireColorInHand === "copper" ? 1 : terminalSideAt(entity, visual, entity.direction, wireColorInHand, world);
      const sideWord = visual?.outputWireConnections && wireColorInHand !== "copper" ? (side === 2 ? " output" : " input") : "";
      if (pendingWireFrom === null) {
        setPendingWireFrom(entityNumber, side);
        setStatus(`Picked one end${sideWord} — click another entity to connect or disconnect the ${wireColorInHand} wire.`);
        return;
      }
      // Re-clicking the same terminal is inert, per the user's own design:
      // only 'q' clears a pick, never a click. The other side of the same
      // combinator is a real wire (input to output).
      if (pendingWireFrom === entityNumber && pendingWireSide === side) return;
      const from = pendingWireFrom;
      const fromSide = pendingWireSide;
      setPendingWireFrom(null);
      applyEdit(() => {
        const result = toggleWire(wires, wireColorInHand!, from, entityNumber, fromSide, side);
        wires = result.wires;
        setStatus(result.connected ? `Connected with a ${wireColorInHand} wire.` : `Disconnected the ${wireColorInHand} wire.`);
      });
    });
    // Alt+right-click a machine with a module in hand: stamp that module
    // into every one of its slots at once. Without a module held there's
    // nothing to stamp, so the gesture is simply inert (it deliberately
    // does NOT fall through to erasing — see onAltRightClickEntity).
    renderer.onAltRightClickEntity((entityNumber) => {
      // Alt was held as a modifier here, so its release must not also
      // toggle alt mode (same guard Shift+Alt+scroll uses).
      usedAltAsModifier = true;
      const entity = entities.find((e) => e.entityNumber === entityNumber);
      if (entity) fillAllModuleSlots(entity);
    });
    // A box drawn in delete mode acts immediately — no intermediate
    // "selected, now confirm" step — and one applyEdit call inside
    // removeEntities gives the whole box one undo step. Mode stays
    // 'deleteBox' (the renderer itself never changes it), ready for the
    // next box.
    renderer.onDeleteBox((numbers) => {
      const count = numbers.size;
      removeEntities(numbers);
      setStatus(`Deleted ${count} ${count === 1 ? "entity" : "entities"}.`);
    });
    // A box drawn in cut mode copies (clipboard + armed paste ghost, same
    // as copy) THEN deletes the originals — confirmed with the user: cut
    // both moves (via the ghost) and clears the source in one gesture.
    renderer.onCutBox((numbers) => {
      void copyBoxToClipboardAndGhost(numbers).then(() => removeEntities(numbers));
    });
    // A box drawn in copy mode copies (clipboard + armed paste ghost) and
    // leaves the originals untouched.
    renderer.onCopyBox((numbers) => {
      // The library window's reassign: the box becomes that blueprint's
      // new contents instead of going onto the cursor.
      if (pendingReselect) {
        const apply = pendingReselect;
        pendingReselect = null;
        const boxedEntities = entities.filter((e) => numbers.has(e.entityNumber));
        const boxedWires = wires.filter((w) => numbers.has(w.from) && numbers.has(w.to));
        setMode("idle");
        if (boxedEntities.length === 0) return;
        apply(encodeBlueprintString({ blueprint: toBlueprint(boxedEntities, { item: "blueprint", label: undefined, version: blueprints[0]?.version }, boxedWires) }));
        return;
      }
      void copyBoxToClipboardAndGhost(numbers);
    });
    // Commits one stamp of an armed paste ghost (see copyBoxToClipboardAndGhost).
    // Stays in 'paste' mode afterward — the ghost is repeat-stampable,
    // matching place mode's own "stays in hand until you put it away" feel.
    renderer.onPaste((pasteEntities, pasteWires, newAnchor, origAnchor, groupRotation, collisionMode) => {
      const dx = newAnchor.x - origAnchor.x;
      const dy = newAnchor.y - origAnchor.y;
      // Apply the ghost's rotation FIRST (around the original center), then
      // the cursor offset — matches exactly what render.ts's draw() loop
      // previewed, so the placed result is never a surprise relative to
      // what the ghost showed.
      const rotationSteps = groupRotation / 4;
      const rotated = rotationSteps === 0 ? pasteEntities : pasteEntities.map((e) => rotateAroundCenter(e, origAnchor, rotationSteps));
      const remapped = remapSelectionForPaste(
        rotated.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy })),
        pasteWires,
        nextEntityNumber,
      );
      nextEntityNumber = remapped.nextNumber;

      const collidesWithAny = (e: PlacedEntity, against: PlacedEntity[]) =>
        against.some((other) => entitiesCollide(e, other, footprintOfEntity));

      let toPlace = remapped.entities;
      let toRemoveFirst: number[] = [];
      if (collisionMode === "block") {
        if (toPlace.some((e) => collidesWithAny(e, entities))) {
          setStatus("Can't place here — something in the group overlaps existing entities.", "error");
          return;
        }
      } else if (collisionMode === "skip") {
        toPlace = toPlace.filter((e) => !collidesWithAny(e, entities));
        if (toPlace.length === 0) {
          setStatus("Nothing to place — everything overlaps.", "error");
          return;
        }
      } else {
        // "replace": place everything; whatever an incoming entity overlaps
        // gets erased first, mirroring the real game's own build-over-it
        // replace gesture rather than leaving two footprints on one tile.
        toRemoveFirst = entities.filter((existing) => collidesWithAny(existing, toPlace)).map((e) => e.entityNumber);
      }

      applyEdit(() => {
        if (toRemoveFirst.length > 0) {
          const removed = new Set(toRemoveFirst);
          entities = entities.filter((e) => !removed.has(e.entityNumber));
          wires = dropWiresFor(wires, removed);
        }
        entities = [...entities, ...toPlace];
        const placedIds = new Set(toPlace.map((e) => e.entityNumber));
        wires = [...wires, ...remapped.wires.filter((w) => placedIds.has(w.from) && placedIds.has(w.to))];
      });
      setStatus(`Placed ${toPlace.length} ${toPlace.length === 1 ? "entity" : "entities"}.`);
    });
    // Small non-blocking "still loading sprites" badge — fires while a
    // pan/zoom brings never-before-seen entities into view (or the
    // initial burst on loading a blueprint) and their sheets are still
    // fetching/decoding. Not gating anything: the canvas keeps drawing
    // outline fallbacks for those entities the whole time, this is purely
    // an at-a-glance "why do some things look unfinished" cue. Shares the
    // same #load-spinner element guardedLoad's own withSpinner uses — spinner
    // itself is declared further down (only ever CALLED once actual sprite
    // loads happen, well after that point in module init, so no temporal-
    // dead-zone issue registering the callback here first). */
    renderer.onLoadingChange((loading, group) => {
      setSpinnerReason("sprite-load", loading);
      if (group) setSpinnerFile(group);
    });
  }
  wireEditCallbacks();

  const paletteBody = $<HTMLDivElement>("#palette-body");
  let lastPalettePointer = { x: 0, y: 0 };

  /* ---------- menu state machine ----------
   *
   * Every picker (Build / Recipe / Module) is the same grid-menu body in its
   * own floating window, and exactly one menu state is live at a time:
   *
   *   default ──E──▶ build ──E/Esc──▶ default
   *   default ──click machine──▶ machine-info (has a recipe)
   *                           └▶ recipe      (has none yet)
   *   machine-info ──E/Esc──▶ default
   *   machine-info ──gear──▶ recipe     ──E/Esc──▶ machine-info / default
   *   machine-info ──slot──▶ module     ──E/Esc──▶ machine-info
   *
   * 'E' confirms the open menu's selection when it has one (the same thing
   * the green check button does) and otherwise backs out, so one key drives
   * the whole graph; Escape always backs out. Keeping the transitions in one
   * function is what stops the four windows from being shown/hidden
   * ad-hoc from a dozen call sites and drifting into impossible
   * combinations. */
  type MenuState = "default" | "build" | "hotbar" | "machine-info" | "recipe" | "module" | "filter" | "signal";
  let menuState: MenuState = "default";
  /** The open menu's handle, for 'E' to confirm/cancel through. Undefined in
   *  the two states that aren't a grid menu (default, machine-info). */
  let activeMenu: GridMenuHandle | undefined;
  let activeModuleSlot = 0;
  let activeFilterSlot = 0;

  /** Backing out of the recipe menu lands on the machine's own GUI once it
   *  has a recipe to show there, and on the bare canvas when it still
   *  doesn't — the recipe menu is the first thing a fresh, recipe-less
   *  machine opens, so there's no machine-info screen behind it yet. */
  function recipeExitState(): MenuState {
    return selectedEntity?.recipe ? "machine-info" : "default";
  }

  function centerWindow(target: { el: HTMLElement; setPosition(x: number, y: number): void }): void {
    // Measuring needs the element actually laid out — callers show() first
    // (display:none has zero size), then centre on its real dimensions.
    const rect = target.el.getBoundingClientRect();
    target.setPosition((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
  }

  function openMenuWindow(
    target: { el: HTMLElement; show(): void; bringToFront(): void; setPosition(x: number, y: number): void },
    handle: GridMenuHandle,
  ): void {
    activeMenu = handle;
    target.show();
    centerWindow(target);
    target.bringToFront();
  }

  function enterMenuState(next: MenuState): void {
    // The three entity-scoped states have nothing to show without a
    // selection (an undo can drop the selected entity out from under an
    // open GUI), so they collapse to the canvas rather than leaving an
    // empty window behind.
    if (next !== "default" && next !== "build" && next !== "hotbar" && !selectedEntity) next = "default";
    menuState = next;
    activeMenu = undefined;
    paletteWindow.hide();
    recipeWindow.hide();
    moduleWindow.hide();
    filterWindow.hide();
    signalWindow.hide();
    hotbarPickWindow.hide();
    // The properties window is the machine-info state itself, so it closes
    // for every other state — including while a picker it launched is open,
    // keeping one menu on screen at a time.
    if (next !== "machine-info") propertiesWindow.hide();

    switch (next) {
      case "default":
        signalTab = undefined;
        deselect();
        return;
      case "build":
        openMenuWindow(paletteWindow, buildPaletteMenu());
        return;
      case "hotbar":
        openMenuWindow(hotbarPickWindow, buildHotbarPickMenu());
        return;
      case "machine-info":
        renderPropertiesPanel();
        return;
      case "recipe":
        openMenuWindow(recipeWindow, buildRecipeMenuForSelection());
        return;
      case "module":
        openMenuWindow(moduleWindow, buildModuleMenuForSlot(activeModuleSlot));
        return;
      case "filter":
        openMenuWindow(filterWindow, buildFilterMenuForSlot(activeFilterSlot));
        return;
      case "signal": {
        const pick = signalPick;
        if (!pick) return enterMenuState("machine-info");
        const owner = selectedEntity!.entityNumber;
        openMenuWindow(signalWindow, buildSignalMenu($<HTMLDivElement>("#signal-body"), getRenderCatalog(), pick.allow, (signal) => {
          signalPick = undefined;
          pick.onPick(signal);
          enterMenuState("machine-info");
        }, () => enterMenuState("machine-info"), {
          initial: signalTab?.entity === owner ? signalTab.group : undefined,
          onChange: (group) => (signalTab = { entity: owner, group }),
        }));
        return;
      }
    }
  }

  /** Backs out of whichever menu is open — the reverse of the transition
   *  that opened it. Both Escape and a selection-less 'E' route through
   *  here, so the two can't disagree about where "back" goes. */
  function exitCurrentMenuState(): void {
    switch (menuState) {
      case "build":
      case "hotbar":
      case "machine-info":
        enterMenuState("default");
        return;
      case "recipe":
        enterMenuState(recipeExitState());
        return;
      case "module":
      case "filter":
      case "signal":
        enterMenuState("machine-info");
        return;
      case "default":
        return;
    }
  }

  function buildPaletteMenu(): GridMenuHandle {
    return buildPalette(
      paletteBody,
      getData(),
      getRenderCatalog(),
      paletteQuality,
      (entityName, quality) => {
        setMode({ place: entityName, quality });
        enterMenuState("default");
        // Confirming changes paletteSelection without the pointer itself
        // moving — pointermove won't refire on its own, so the cursor icon
        // needs this explicit nudge to pick up the newly-picked item.
        updateCursorIcon(lastPalettePointer.x, lastPalettePointer.y);
      },
      () => enterMenuState("default"),
    );
  }

  /** The "Set quickbar slot" picker: the build menu's own entity list, its
   *  confirm filling the slot that opened it instead of the cursor. */
  function buildHotbarPickMenu(): GridMenuHandle {
    return buildGridMenu($<HTMLDivElement>("#hotbar-pick-body"), {
      entries: placeableEntries(getData(), getRenderCatalog()),
      groups: getRenderCatalog().menuGroups,
      filterLabel: "Filter placeable entities",
      showQuality: true,
      initialQuality: "normal",
      onConfirm: ({ name, quality }) => {
        quickbar?.setSlot(hotbarTarget.bar, hotbarTarget.slot, { name, quality });
        enterMenuState("default");
      },
      onCancel: () => enterMenuState("default"),
    });
  }

  function buildRecipeMenuForSelection(): GridMenuHandle {
    const entity = selectedEntity;
    const machine = entity ? getData().machines[entity.name] : undefined;
    return buildRecipeMenu(
      $<HTMLDivElement>("#recipe-body"),
      getData(),
      getRenderCatalog(),
      machine?.categories ?? [],
      entity?.recipe,
      entity?.quality ?? "normal",
      (recipeName, quality) => {
        updateSelectedEntity((e) => {
          e.recipe = recipeName;
          e.quality = quality;
        });
        enterMenuState("machine-info");
      },
      () => enterMenuState(recipeExitState()),
    );
  }

  /** Writes one module slot (a module, or null to empty it) back onto the
   *  selected entity. Shared by the module menu's confirm and the
   *  right-click-a-slot removal so both go through the same undoable edit. */
  function setModuleSlot(slotIndex: number, module: { name: string; quality: QualityName } | null): void {
    updateSelectedEntity((e) => {
      const slots = expandModuleSlots(e.modules);
      slots[slotIndex] = module;
      e.modules = collapseModules(slots.filter((s): s is { name: string; quality: QualityName } => s !== null));
    });
  }

  /** Writes one filter slot (an item name, or "" to empty it) back onto the
   *  selected entity's position-preserving filterItems array — see
   *  PlacedEntity's own doc comment for why a gap is "" rather than
   *  compacted away. Shared by the filter menu's confirm and the
   *  right-click-a-slot removal, same as setModuleSlot above. */
  function setFilterSlot(slotIndex: number, itemName: string): void {
    updateSelectedEntity((e) => {
      // A splitter has one filter, and it leaves on the output priority
      // side: the game picks left when none was set.
      if (getData().splitters?.[e.name]) {
        e.splitterFilter = itemName || undefined;
        if (itemName) e.splitterOutputPriority ??= "left";
        return;
      }
      const slots = [...e.filterItems];
      while (slots.length <= slotIndex) slots.push("");
      slots[slotIndex] = itemName;
      // Trim trailing empties so an emptied LAST slot doesn't leave the
      // array permanently longer than what's actually filled — matches
      // readFilterItems' own "length is the highest filled index" shape.
      while (slots.length > 0 && !slots[slots.length - 1]) slots.pop();
      e.filterItems = slots;
    });
  }

  /* ---------- held module ("module in cursor") ----------
   *
   * A module picked up with 'q' rides the cursor the same way a placeable
   * entity does, and is spent by clicking a module slot (one slot) or
   * Alt+right-clicking a machine (every slot at once). It's deliberately
   * exclusive with the entity ghost: the cursor holds one thing, so picking
   * up a module drops whatever entity was in hand and vice versa. */
  let heldModule: { name: string; quality: QualityName } | null = null;

  /** The open menu's quality tier, for picks that bypass its confirm button
   *  (the 'q' pipette over a module cell) — "normal" with no menu open. */
  function activeMenuQuality(): QualityName {
    return activeMenu?.quality() ?? "normal";
  }

  function setHeldModule(module: { name: string; quality: QualityName } | null): void {
    heldModule = module;
    // Dropping the entity ghost keeps "what's in the cursor" single-valued
    // — otherwise a left-click on the canvas would both place a building and
    // still be carrying a module.
    if (module) setMode("idle");
    updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
  }

  /** Fills every module slot of `entity` with the held module — the
   *  Alt+right-click gesture. One edit for the whole machine, so it undoes
   *  as a single step rather than per-slot. */
  function fillAllModuleSlots(entity: PlacedEntity): void {
    const module = heldModule;
    if (!module) return;
    const data = getData();
    const slots = data.machines[entity.name]?.moduleSlots ?? data.beacons[entity.name]?.moduleSlots ?? 0;
    if (slots === 0) return;
    applyEdit(() => {
      const target = entities.find((e) => e.entityNumber === entity.entityNumber);
      if (!target) return;
      target.modules = collapseModules(Array.from({ length: slots }, () => ({ ...module })));
    });
  }

  function buildModuleMenuForSlot(slotIndex: number): GridMenuHandle {
    // Only the quality carries over from whatever is in the slot — the
    // module itself opens unselected (picking is the menu's only job now
    // that removal is a right-click on the slot).
    const current = selectedEntity ? expandModuleSlots(selectedEntity.modules)[slotIndex] ?? null : null;
    return buildModuleMenu(
      $<HTMLDivElement>("#module-body"),
      getData(),
      getRenderCatalog(),
      current?.quality ?? "normal",
      (module) => {
        setModuleSlot(slotIndex, module);
        enterMenuState("machine-info");
      },
      () => enterMenuState("machine-info"),
    );
  }

  function buildFilterMenuForSlot(slotIndex: number): GridMenuHandle {
    return buildFilterItemMenu(
      $<HTMLDivElement>("#filter-body"),
      getRenderCatalog(),
      (itemName) => {
        setFilterSlot(slotIndex, itemName);
        enterMenuState("machine-info");
      },
      () => enterMenuState("machine-info"),
    );
  }

  /** Which item icon stands for a wire on the cursor. These are real items
   *  in the dataset and real cells in the icon atlas, so the cursor shows
   *  the same art the game puts in your hand. */
  const WIRE_CURSOR_ICON: Record<WireColor, string> = {
    copper: "copper-cable",
    red: "red-wire",
    green: "green-wire",
  };

  // The cursor-stack icon, matching the real game's own. Three things can put
  // something in it, with different reach:
  //   - a held MODULE follows the cursor everywhere, since a module has no
  //     canvas ghost of its own and its targets (module slots, machines)
  //     live in both the entity GUI and the canvas;
  //   - a held WIRE likewise follows the cursor everywhere: it has no canvas
  //     ghost either, and its targets are entities out on the canvas, so
  //     without this there is no visible sign of what is in hand at all;
  //   - a picked ENTITY only shows here while over the Build window, since
  //     everywhere else the canvas already draws a real placement ghost and
  //     a second floating icon would just double up on it.
  const cursorIcon = document.createElement("div");
  cursorIcon.className = "palette-cursor-icon";
  cursorIcon.hidden = true;
  document.body.appendChild(cursorIcon);
  let cursorIconFor: string | null = null;
  let pointerOverPalette = false;
  let lastPointerPos = { x: 0, y: 0 };

  function updateCursorIcon(clientX: number, clientY: number): void {
    const heldWire = wireColorInHand ? WIRE_CURSOR_ICON[wireColorInHand] : null;
    const held = heldModule?.name ?? heldWire ?? (pointerOverPalette ? paletteSelection : null);
    if (!held) {
      cursorIcon.hidden = true;
      cursorIconFor = null;
      return;
    }
    if (cursorIconFor !== held) {
      cursorIcon.replaceChildren(icon(held, held, 28));
      cursorIconFor = held;
    }
    cursorIcon.hidden = false;
    // Offset down-right of the cursor (matches the reference screenshot),
    // not centred under it — a cursor-anchored icon centred on the pointer
    // itself would obscure exactly what's being pointed at.
    cursorIcon.style.left = `${clientX + 12}px`;
    cursorIcon.style.top = `${clientY + 12}px`;
  }

  // Document-level so a held module's icon keeps up over the canvas and the
  // entity GUI too, not just inside the Build window.
  document.addEventListener("pointermove", (e) => {
    lastPointerPos = { x: e.clientX, y: e.clientY };
    // A wire follows the cursor for the same reason a module does — neither
    // has a canvas ghost of its own to show where it is.
    if (heldModule || wireColorInHand) updateCursorIcon(e.clientX, e.clientY);
  }, { signal });

  paletteWindow.el.addEventListener("pointermove", (e) => {
    pointerOverPalette = true;
    lastPalettePointer = { x: e.clientX, y: e.clientY };
    updateCursorIcon(e.clientX, e.clientY);
  }, { signal });
  paletteWindow.el.addEventListener("pointerleave", () => {
    pointerOverPalette = false;
    updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
  }, { signal });

  /** Live parts of the open entity GUI (network numbers, signal grids). */
  let panelRefresh: (() => void) | undefined;
  /** The editor's own circuit simulation, for live values in the entity
   *  GUI while the Simulate overlay is off. Rebuilt after every edit. */
  let editorCircuits: CircuitSim | undefined;
  let circuitLoopId = 0;
  const circuitClock = new SimClock();
  /** The tick the open GUI last showed, so a frame without a new tick
   *  costs nothing. */
  let shownTick = -1;

  /** The circuit state the GUI shows: the Simulate overlay's own while it
   *  runs, so both agree, else the editor's. */
  function liveCircuits(): CircuitSim | undefined {
    const overlay = rateOverlay.isEnabled ? rateOverlay.factory : undefined;
    if (overlay) return overlay.circuits;
    editorCircuits ??= new CircuitSim(entities, wires, { stackSizeOf: (n) => getData().items[n]?.stackSize });
    return editorCircuits;
  }

  /** While an entity GUI with live values is open: runs the editor's
   *  circuit simulation one tick per frame (SimClock), or follows the
   *  Simulate overlay's while that runs, and shows every tick. */
  function circuitLoop(now: number) {
    if (propertiesWindow.el.hidden || menuState !== "machine-info" || !panelRefresh) {
      circuitLoopId = 0;
      return;
    }
    const sim = liveCircuits()!;
    if (!(rateOverlay.isEnabled && rateOverlay.factory)) {
      const ticks = circuitClock.advance(now, 1, true);
      for (let i = 0; i < ticks; i++) sim.step();
    }
    if (sim.tick !== shownTick) {
      shownTick = sim.tick;
      panelRefresh();
    }
    circuitLoopId = requestAnimationFrame(circuitLoop);
  }

  function renderPropertiesPanel() {
    if (!selectedEntity) {
      propertiesWindow.hide();
      return;
    }
    // Every edit funnels through applyEdit, which re-renders this panel so
    // it reflects the change — but an edit can land while a picker menu is
    // open (confirming a recipe, an undo, rotating a hovered entity), and
    // this must not pop the machine GUI up over that menu. Showing is the
    // machine-info state's own job; from any other state this call only
    // rebuilds the (hidden) panel for when that state is next entered.
    if (menuState !== "machine-info") return;
    const wasHidden = propertiesWindow.el.hidden;
    const propertiesBody = $<HTMLDivElement>("#properties-body");
    const data = getData();
    const catalog = getRenderCatalog();
    // The game titles an entity's window with its name.
    propertiesWindow.el.querySelector(".gui-titlebar span")!.textContent = localisedNameOf(data, catalog, selectedEntity.name);
    const wide = circuitWindowKind(selectedEntity);
    if (wide) propertiesWindow.el.dataset.gui = wide;
    else delete propertiesWindow.el.dataset.gui;
    panelRefresh = buildPropertiesPanel(propertiesBody, selectedEntity, getData(), getRenderCatalog(), visualLookup(), latestBottlenecks, {
      onOpenRecipePicker: () => enterMenuState("recipe"),
      onModuleSlotClick(slotIndex) {
        // With a module in hand, clicking a slot stamps it straight in
        // (and keeps holding it, so the remaining slots can be filled with
        // more clicks) rather than opening the picker.
        if (heldModule) {
          setModuleSlot(slotIndex, { ...heldModule });
          return;
        }
        activeModuleSlot = slotIndex;
        enterMenuState("module");
      },
      // Stays in machine-info: the panel rebuilds itself through applyEdit,
      // so the emptied slot just re-renders in place.
      onClearModuleSlot: (slotIndex) => setModuleSlot(slotIndex, null),
      onFilterSlotClick(slotIndex) {
        activeFilterSlot = slotIndex;
        enterMenuState("filter");
      },
      onClearFilterSlot: (slotIndex) => setFilterSlot(slotIndex, ""),
      onToggleUseFilters(enabled) {
        updateSelectedEntity((e) => {
          e.useFilters = enabled;
          // Matches the real GUI: filterMode/filterItems default in the
          // moment filters are first turned on, rather than staying
          // undefined until something else sets them — an inserter that
          // never had a filterMode still needs "whitelist" written out once
          // useFilters is true (see denormaliseEntities), and the slot row
          // needs SOME array to index into even before anything's picked.
          if (enabled && e.filterMode === undefined) e.filterMode = "whitelist";
        });
      },
      onSetFilterMode(mode) {
        updateSelectedEntity((e) => { e.filterMode = mode; });
      },
      onToggleOverrideStackSize(enabled) {
        updateSelectedEntity((e) => { e.overrideStackSize = enabled ? 1 : undefined; });
      },
      onSetOverrideStackSize(value) {
        updateSelectedEntity((e) => { e.overrideStackSize = value; });
      },
      onSetSpoilPriority(priority) {
        updateSelectedEntity((e) => { e.spoilPriority = priority; });
      },
      onSetSplitterPriority(which, side) {
        updateSelectedEntity((e) => {
          if (which === "input") e.splitterInputPriority = side;
          else e.splitterOutputPriority = side;
        });
      },
      circuit: {
        wired: wires.some((w) => w.color !== "copper" && (w.from === selectedEntity!.entityNumber || w.to === selectedEntity!.entityNumber)),
        commit(mutate) {
          updateSelectedEntity((e) => {
            // Copy on write: undo snapshots share nested objects.
            const cb = structuredClone(e.controlBehavior ?? {});
            if (e.panel) e.panel = { ...e.panel };
            mutate(cb, e);
            e.controlBehavior = Object.keys(cb).length ? cb : undefined;
            if (/combinator|display-panel/.test(e.name)) refreshSignalItems(e);
          });
        },
        pickSignal(allow, onPick) {
          signalPick = { allow, onPick };
          enterMenuState("signal");
        },
        live: liveCircuits,
        redraw: renderPropertiesPanel,
      },
    });
    shownTick = -1;
    if (panelRefresh && !circuitLoopId) {
      circuitClock.reset(performance.now());
      circuitLoopId = requestAnimationFrame(circuitLoop);
    }
    propertiesWindow.show();
    propertiesWindow.bringToFront();
    // Opens centered in the viewport every time a NEW selection triggers
    // it (matches the real game popping its machine GUI up fresh per
    // click) — only on the hidden -> shown transition, so a re-render
    // triggered by editing the already-open GUI (recipe/module change)
    // doesn't yank it back to center out from under the user's drag.
    if (wasHidden) {
      requestAnimationFrame(() => {
        const rect = propertiesWindow.el.getBoundingClientRect();
        // Never under the toolbar, even when the window is taller than half
        // the screen (a display panel with many messages).
        propertiesWindow.setPosition((window.innerWidth - rect.width) / 2, Math.max(110, (window.innerHeight - rect.height) / 2));
      });
    }
  }

  function recalculate() {
    // Every edit lands here; the overlay rebuilds its model shortly after,
    // and the Overlay Lab picks up the same blueprint when it's opened.
    rateOverlay.update(entities, wires);
    setCurrentBlueprint(entities, wires);
    editorCircuits = undefined;
    const data = getData();
    result = calculate(data, entities, options.researchLevels);
    const throughputCtx: ThroughputContext = {
      data,
      entities,
      footprintOf: (name) => data.machines[name]?.size ?? data.beacons[name]?.size ?? [1, 1],
    };
    latestBottlenecks = attachBottlenecks(throughputCtx, result.groups);

    const scale = computeScaleFactor(
      result,
      scaleTarget ? { itemName: scaleTarget.itemName, ratePerSecond: scaleTarget.rate / TIMESCALE_FACTOR[scaleTarget.timescale] } : null,
    );
    options.scaleFactor = scale.factor;
    const targetStatus = $<HTMLParagraphElement>("#target-status");
    if (scaleTarget && scale.unreachable) {
      targetStatus.textContent = `Nothing in this blueprint produces ${scaleTarget.itemName} — target ignored.`;
      targetStatus.dataset.kind = "error";
    } else if (scaleTarget) {
      targetStatus.textContent = `Scaling ×${scale.factor.toFixed(3)} from a theoretical max of ${scale.theoreticalMaxPerSecond.toFixed(2)}/s.`;
      targetStatus.dataset.kind = "info";
    } else {
      targetStatus.textContent = "";
    }
    const scaleWarnings = scaleTarget && !scale.unreachable ? findScaleWarnings(result, scale, latestBottlenecks) : [];

    renderResults(
      { results, summary },
      data,
      result,
      options,
      (hover) => renderer.setHighlight(hover ? { producers: hover.producers, consumers: hover.consumers } : null),
      recalculate,
      latestBottlenecks,
      scaleWarnings,
    );
    populateTargetOptions();
  }

  const spinner = $<HTMLDivElement>("#load-spinner");
  // Two independent sources can each want the spinner showing at once — a
  // blueprint decode/rebuild (withSpinner) and the sprite atlas's own
  // loading state (renderer.onLoadingChange, wired in wireEditCallbacks) —
  // a bare boolean would let whichever finishes first hide it out from
  // under the other. Small pending-reason set instead: visible whenever
  // it's non-empty, each source only ever adds/removes its own key.
  const spinnerReasons = new Set<string>();
  function setSpinnerReason(reason: string, active: boolean): void {
    if (active) spinnerReasons.add(reason);
    else spinnerReasons.delete(reason);
    const show = spinnerReasons.size > 0;
    clearTimeout(spinnerHideTimer);
    if (show === spinner.classList.contains("is-visible")) return;
    // A load that settles within a frame or two would otherwise start
    // leaving before the badge has even faded in — hold it on screen for
    // a minimum stretch so a fast load still reads as one.
    if (!show) {
      const wait = spinnerShownAt + SPINNER_MIN_VISIBLE_MS - performance.now();
      if (wait > 0) {
        spinnerHideTimer = window.setTimeout(() => setSpinnerReason(reason, false), wait);
        return;
      }
    } else {
      spinnerShownAt = performance.now();
    }
    clearTimeout(spinnerLeaveTimer);
    spinner.classList.toggle("is-visible", show);
    // Enters from below, leaves upward: is-leaving holds the exit pose
    // until the transition is over, then the badge snaps back (invisible)
    // to its resting spot below, ready for the next entrance.
    spinner.classList.toggle("is-leaving", !show);
    if (!show) {
      spinnerLeaveTimer = window.setTimeout(() => {
        spinner.classList.remove("is-leaving");
        clearTimeout(spinnerFileTimer);
        spinnerFile.replaceChildren();
        spinnerFileName = "";
      }, SPINNER_LEAVE_MS);
    }
  }

  // What the sprite atlas is fetching right now — the building, not the
  // individual sheet, so a wall's sixteen sheets read as one "wall" rather
  // than sixteen names flashing past — as a one-line ticker
  // beside the ring: each new name rises in from below while the one it
  // replaces slides out the top. Left in place when loading finishes so
  // the last name rides out with the badge instead of blanking first.
  const SPINNER_LEAVE_MS = 260;
  const SPINNER_MIN_VISIBLE_MS = 700;
  const SPINNER_FILE_HOLD_MS = 220;
  let spinnerShownAt = 0;
  let spinnerHideTimer: number | undefined;
  let spinnerFileTimer: number | undefined;
  let spinnerFileSwappedAt = 0;
  const spinnerFile = $<HTMLDivElement>("#load-spinner-file");
  let spinnerLeaveTimer: number | undefined;
  let spinnerFileName = "";
  function setSpinnerFile(file: string): void {
    // Sheets settle faster than the slide takes during a burst, and a name
    // swapped out mid-slide never gets read at all — each name holds for
    // a beat, with only the newest one waiting to take its place.
    clearTimeout(spinnerFileTimer);
    if (file === spinnerFileName) return;
    const wait = spinnerFileSwappedAt + SPINNER_FILE_HOLD_MS - performance.now();
    if (wait > 0) {
      spinnerFileTimer = window.setTimeout(() => setSpinnerFile(file), wait);
      return;
    }
    spinnerFileSwappedAt = performance.now();
    spinnerFileName = file;
    for (const old of spinnerFile.querySelectorAll(".is-out")) old.remove();
    const previous = spinnerFile.firstElementChild;
    if (previous) {
      previous.classList.add("is-out");
      previous.addEventListener("animationend", () => previous.remove(), { once: true });
    }
    const line = document.createElement("span");
    line.className = "load-spinner-file-line";
    line.textContent = file;
    spinnerFile.append(line);
  }

  /** Shows the loading spinner, yields one frame so it actually paints
   *  (decoding + rebuilding the renderer/spatial index for a large
   *  blueprint is synchronous and can block the main thread long enough
   *  that skipping this would leave the spinner invisible the whole
   *  time), then runs `work` and hides the spinner again. */
  async function withSpinner<T>(work: () => T): Promise<T> {
    setSpinnerReason("blueprint-load", true);
    await new Promise(requestAnimationFrame);
    try {
      return work();
    } finally {
      setSpinnerReason("blueprint-load", false);
    }
  }

  const unsavedBackdrop = $<HTMLDivElement>("#unsaved-modal-backdrop");
  const unsavedSaveRow = $<HTMLDivElement>("#unsaved-modal-save-row");
  const unsavedNameInput = $<HTMLInputElement>("#unsaved-modal-name");
  const unsavedSaveButton = $<HTMLButtonElement>("#unsaved-modal-save");
  const unsavedDiscardButton = $<HTMLButtonElement>("#unsaved-modal-discard");
  const unsavedCancelButton = $<HTMLButtonElement>("#unsaved-modal-cancel");

  /** Asks "Save / Discard / Cancel" over the current unsaved changes.
   *  Resolves once the user picks one — Save additionally prompts for a
   *  name inline (same flow as the Library sidebar's own "Save current")
   *  before resolving, so a "save" result means the save already
   *  succeeded. Rejecting/closing without a real choice (e.g. a future
   *  Escape/backdrop-click) isn't wired — the three buttons are the only
   *  way out, matching a blocking "you must decide" guard. */
  function confirmUnsavedChanges(): Promise<"save" | "discard" | "cancel"> {
    return new Promise((resolve) => {
      unsavedSaveRow.hidden = true;
      unsavedNameInput.value = "";
      unsavedBackdrop.hidden = false;

      function cleanup(): void {
        unsavedBackdrop.hidden = true;
        unsavedSaveButton.removeEventListener("click", onSaveClick);
        unsavedDiscardButton.removeEventListener("click", onDiscard);
        unsavedCancelButton.removeEventListener("click", onCancel);
        unsavedNameInput.removeEventListener("keydown", onNameKeydown);
      }
      function onSaveClick(): void {
        // First press reveals the name field instead of saving blindly —
        // matches the sidebar's own "Save current" row, which always has
        // the name field visible; here it only appears once Save is
        // actually chosen, so Discard/Cancel stay one click away.
        if (unsavedSaveRow.hidden) {
          unsavedSaveRow.hidden = false;
          unsavedNameInput.focus();
          return;
        }
        const template = currentTemplate();
        const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, template, wires) });
        const label = unsavedNameInput.value.trim() || "Untitled blueprint";
        try {
          saveToLibrary(bpString, label);
          librarySidebar.refresh();
          cleanup();
          resolve("save");
        } catch (err) {
          setStatus(saveFailureMessage(err, "Couldn't save — the current blueprint doesn't decode."), "error");
        }
      }
      function onDiscard(): void {
        cleanup();
        resolve("discard");
      }
      function onCancel(): void {
        cleanup();
        resolve("cancel");
      }
      function onNameKeydown(e: KeyboardEvent): void {
        if (e.key === "Enter") onSaveClick();
      }
      unsavedSaveButton.addEventListener("click", onSaveClick);
      unsavedDiscardButton.addEventListener("click", onDiscard);
      unsavedCancelButton.addEventListener("click", onCancel);
      unsavedNameInput.addEventListener("keydown", onNameKeydown);
    });
  }

  /** Every load entry point (clipboard import, library pick, demo,
   *  built-in fixtures) goes through this instead of calling load()
   *  directly: guards against silently discarding an in-progress edit,
   *  then shows the spinner while the actual (synchronous, can be slow
   *  for a big blueprint) decode/build work runs. */
  async function guardedLoad(text: string, entryId?: string): Promise<void> {
    if (hasUnsavedChanges) {
      const choice = await confirmUnsavedChanges();
      if (choice === "cancel") return;
    }
    const loaded = await withSpinner(() => load(text));
    // load() forgot the previous entry; this one came out of the library.
    // A load that failed left the old blueprint and its entry in place.
    if (loaded && entryId) setOpenEntry(entryId);
  }

  /** The library entry the editor's blueprint was opened from or last saved
   *  to — what Cmd/Ctrl+S writes back to. Undefined for anything that did
   *  not come out of the library (an import, an example, a new blueprint).
   *  Remembered across a reload alongside the autosave, and keyed with it so
   *  a preview build's autosave is never paired with another build's entry. */
  const OPEN_ENTRY_KEY = `${AUTOSAVE_KEY}.open-entry`;
  let openEntryId: string | undefined;

  function setOpenEntry(id: string | undefined): void {
    openEntryId = id;
    try {
      if (id) localStorage.setItem(OPEN_ENTRY_KEY, id);
      else localStorage.removeItem(OPEN_ENTRY_KEY);
    } catch {
      /* storage unavailable — the entry is still remembered for this visit */
    }
  }

  /** Switches to another blueprint of the book that is loaded. Whatever
   *  entry an earlier one was saved to is not this one's, so a plain save
   *  asks for a name again rather than overwriting it. */
  function selectBookBlueprint(index: number): void {
    if (index !== selectedBlueprint) setOpenEntry(undefined);
    selectBlueprint(index);
  }

  /** Cmd/Ctrl+S: writes the current blueprint back to the library entry it
   *  is open from, keeping that entry's name, description and icons. With
   *  no such entry (never saved, or deleted since) it asks for a name
   *  instead, like Save As. */
  function saveCurrent(): void {
    if (!saveAsBackdrop.hidden) return; // the Save As prompt is already up
    const entry = openEntryId ? listSaved().find((e) => e.id === openEntryId) : undefined;
    if (!entry) {
      void saveCurrentAs();
      return;
    }
    // An open entry emptied out is an edit like any other, so it saves as
    // an empty blueprint; one that was empty all along has nothing to save.
    if (!hasBlueprintContent() && !hasUnsavedChanges) {
      setStatus("Nothing to save yet.", "error");
      return;
    }
    const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, currentTemplate(), wires) });
    try {
      replaceContentsInLibrary(entry.id, bpString);
    } catch (err) {
      setStatus(saveFailureMessage(err, "Couldn't save — the current blueprint doesn't decode."), "error");
      return;
    }
    hasUnsavedChanges = false;
    // The autosave still holds what was there before the canvas was
    // emptied; a reload must not bring that back as this entry.
    if (!hasBlueprintContent()) {
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* storage unavailable — not worth surfacing here */
      }
    }
    librarySidebar.refresh();
    setStatus(`Saved “${entry.label}”.`, "info", true);
  }

  const saveAsBackdrop = $<HTMLDivElement>("#save-as-modal-backdrop");
  const saveAsNameInput = $<HTMLInputElement>("#save-as-modal-name");
  const saveAsSaveButton = $<HTMLButtonElement>("#save-as-modal-save");
  const saveAsCancelButton = $<HTMLButtonElement>("#save-as-modal-cancel");

  /** Cmd/Ctrl+Shift+S: asks for a name and saves the current blueprint as a
   *  new library entry, which becomes the one later plain saves write to. */
  function saveCurrentAs(): Promise<void> {
    if (!currentBpString()) {
      setStatus("Nothing to save yet.", "error");
      return Promise.resolve();
    }
    if (!saveAsBackdrop.hidden) return Promise.resolve(); // already asking
    return new Promise((resolve) => {
      const open = openEntryId ? listSaved().find((e) => e.id === openEntryId) : undefined;
      saveAsNameInput.value = open?.label ?? currentTemplate().label ?? "";
      saveAsBackdrop.hidden = false;
      saveAsNameInput.focus();
      saveAsNameInput.select();

      function cleanup(): void {
        saveAsBackdrop.hidden = true;
        saveAsSaveButton.removeEventListener("click", onSave);
        saveAsCancelButton.removeEventListener("click", onCancel);
        saveAsNameInput.removeEventListener("keydown", onKeydown);
        resolve();
      }
      function onSave(): void {
        const label = saveAsNameInput.value.trim() || "Untitled blueprint";
        // Read now rather than when the prompt opened: undo and redo still
        // reach the canvas while the name is being typed.
        const bpString = currentBpString();
        if (!bpString) {
          setStatus("Nothing to save yet.", "error");
          return;
        }
        try {
          const before = new Set(listSaved().map((e) => e.id));
          const saved = saveToLibrary(bpString, label).find((e) => !before.has(e.id));
          setOpenEntry(saved?.id);
          hasUnsavedChanges = false;
          librarySidebar.refresh();
          setStatus(`Saved “${label}”.`, "info", true);
          cleanup();
        } catch (err) {
          setStatus(saveFailureMessage(err, "Couldn't save — the current blueprint doesn't decode."), "error");
        }
      }
      function onCancel(): void {
        cleanup();
      }
      function onKeydown(e: KeyboardEvent): void {
        // Kept from the editor's own shortcuts (Escape backing out of a
        // menu, letters picking tools) while the name is being typed —
        // except Cmd/Ctrl combos, so Cmd+S is still claimed from the
        // browser.
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
        if (e.key === "Enter") onSave();
        else if (e.key === "Escape") onCancel();
      }
      saveAsSaveButton.addEventListener("click", onSave);
      saveAsCancelButton.addEventListener("click", onCancel);
      saveAsNameInput.addEventListener("keydown", onKeydown);
    });
  }

  /** Same guard as guardedLoad, for the "+ New blueprint" action — it has
   *  no blueprint STRING to spinner-load (startNew is instant, clearing
   *  the canvas), just the same "you have unsaved changes" question
   *  first. */
  async function guardedStartNew(): Promise<void> {
    if (hasUnsavedChanges) {
      const choice = await confirmUnsavedChanges();
      if (choice === "cancel") return;
    }
    startNew();
  }

  /** Whether the blueprint was read and is now the one on the canvas. */
  function load(text: string, restoreCameraFromSave = false): boolean {
    try {
      const envelope = decodeBlueprintString(text);
      // Only replaces what is open once there is something to open.
      const leaves = collectBlueprints(envelope);
      if (leaves.length === 0) {
        setStatus("That decoded fine but contains no blueprints.", "error");
        return false;
      }
      blueprints = leaves;
      // Whatever was open before is replaced; guardedLoad sets the entry
      // again when this load came out of the library.
      setOpenEntry(undefined);
      // null for a loose blueprint (no book) — the sidebar's "Current book"
      // folder then simply has nothing to show, same as before this string
      // was ever imported.
      currentBookTree = buildBlueprintTree(envelope);
      librarySidebar?.refresh();

      picker.replaceChildren();
      blueprints.forEach((bp, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        // An <option> can only hold plain text: the label without markup.
        option.textContent = (bp.label && stripRichText(bp.label)) || `Blueprint ${i + 1}`;
        picker.appendChild(option);
      });
      picker.hidden = blueprints.length < 2;

      const total = blueprints.reduce((sum, bp) => sum + (bp.entities?.length ?? 0), 0);
      setStatus(
        blueprints.length > 1
          ? `Read ${blueprints.length} blueprints, ${total} entities.`
          : `Read ${total} entities.`,
      );
      selectBlueprint(0, restoreCameraFromSave);
      // persistEntities leaves the autosave alone for an empty canvas, so an
      // empty blueprint would otherwise come back after a reload as the one
      // that was open before it.
      if (!hasBlueprintContent()) {
        try {
          localStorage.removeItem(AUTOSAVE_KEY);
        } catch {
          /* storage unavailable — not worth surfacing here */
        }
      }
      return true;
    } catch (error) {
      resultsWindow.hide();
      setStatus(
        error instanceof BlueprintError ? error.message : "Couldn't read that blueprint.",
        "error",
      );
      return false;
    }
  }

  const librarySidebar = buildLibrarySidebar($<HTMLDivElement>("#library-body"), {
    onLoad(bpString, entryId) {
      input.value = bpString;
      void guardedLoad(bpString, entryId);
    },
    getCurrentBpString: () => currentBpString(),
    onNew: guardedStartNew,
    getCurrentBookTree: () => currentBookTree,
    // Same as the picker dropdown's own change handler just below — a
    // sub-blueprint pick within the book already loaded stays a plain
    // selectBlueprint call, no unsaved-changes guard, since that dropdown
    // never had one either and this is the same gesture from the sidebar.
    onSelectCurrent: (flatIndex) => selectBookBlueprint(flatIndex),
    onReselect(apply) {
      setMode("copyBox");
      pendingReselect = apply;
      setStatus("Reselect — drag a box over the buildings this blueprint should hold (Esc to cancel).", "info", true);
    },
    onPickUp: pickUpBlueprint,
    notify: (message, kind = "info") => setStatus(message, kind, true),
  });

  /** Takes a saved blueprint into the cursor as a paste ghost, like picking
   *  it out of the game's library — with its snap-to-grid, if it has one. */
  function pickUpBlueprint(bpString: string): void {
    let bp: Blueprint | undefined;
    try {
      bp = collectBlueprints(decodeBlueprintString(bpString))[0];
    } catch {
      bp = undefined;
    }
    const picked = bp ? normaliseEntities(bp) : [];
    if (!bp || picked.length === 0) {
      setStatus("That blueprint has nothing to place.", "error");
      return;
    }
    const placeholderIdByOriginal = new Map(picked.map((e, i) => [e.entityNumber, -1 - i]));
    const placeholders = picked.map((e) => ({ ...e, entityNumber: placeholderIdByOriginal.get(e.entityNumber)! }));
    const placeholderWires = normaliseWires(bp)
      .filter((w) => placeholderIdByOriginal.has(w.from) && placeholderIdByOriginal.has(w.to))
      .map((w) => ({ ...w, from: placeholderIdByOriginal.get(w.from)!, to: placeholderIdByOriginal.get(w.to)! }));
    // A whole-tile anchor keeps every entity on its own grid parity however
    // the ghost moves.
    const xs = picked.map((e) => e.x);
    const ys = picked.map((e) => e.y);
    const anchor = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
    const size = bp["snap-to-grid"];
    setMode("idle");
    pasteArmed = true;
    renderer.setInteractionMode({
      kind: "paste",
      entities: placeholders,
      wires: placeholderWires,
      anchor,
      groupRotation: 0,
      snap: size
        ? {
            size: { x: size.x, y: size.y },
            absolute: bp["absolute-snapping"] === true,
            offset: { x: bp["position-relative-to-grid"]?.x ?? 0, y: bp["position-relative-to-grid"]?.y ?? 0 },
          }
        : undefined,
    });
    canvas.classList.add("edit-mode");
    setStatus(`Holding “${bp.label || "blueprint"}” — click to place (Esc to stop).`, "info", true);
  }

  /** The blueprint on screen as a string, or null with nothing placed —
   *  what the library saves. */
  function currentBpString(): string | null {
    if (!hasBlueprintContent()) return null;
    const template = currentTemplate();
    return encodeBlueprintString({ blueprint: toBlueprint(entities, template, wires) });
  }

  /** Takes a quickbar item into the cursor as a ghost, as a Build-menu pick
   *  would. */
  function pickQuickbarItem(item: QuickbarItem): void {
    if (!placeableEntries(getData(), getRenderCatalog()).some((e) => e.name === item.name)) {
      setStatus(`${item.name} can't be placed with the current game data.`, "error");
      return;
    }
    deselect();
    setMode({ place: item.name, quality: item.quality });
    updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
  }

  /** The wire shortcuts' take/put-away toggle, shared with Alt+C/R/G. */
  function toggleWireInHand(color: WireColor): void {
    if (wireColorInHand === color) {
      setMode("idle");
      setStatus("Put the wire away.");
      return;
    }
    setMode({ wire: color });
    deselect();
    updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
    setStatus(`Holding a ${color} wire — click two entities to connect or disconnect them.`);
  }

  quickbar = buildQuickbar($<HTMLDivElement>("#quickbar"), {
    onPickItem: pickQuickbarItem,
    onAltLayers: setAltLayers,
    onAssignSlot(bar, slot) {
      hotbarTarget = { bar, slot };
      enterMenuState("hotbar");
    },
    onTool(tool) {
      switch (tool) {
        case "undo":
          undo();
          return;
        case "redo":
          redo();
          return;
        case "deconstruct":
          if (boxModeKind === "deleteBox") {
            setMode("idle");
            return;
          }
          setMode("deleteBox");
          setStatus("Delete tool — drag a box to delete what's inside.");
          return;
        case "blueprint":
          if (boxModeKind === "copyBox") {
            setMode("idle");
            return;
          }
          setMode("copyBox");
          setStatus("Copy tool — drag a box to copy it onto the cursor.");
          return;
        case "upgrade":
          return;
        case "book": {
          const bpString = currentBpString();
          if (!bpString) {
            setStatus("Nothing on the canvas to put in a book yet.", "error");
            return;
          }
          try {
            saveToLibrary(bpString, "New blueprint book", undefined, { asBook: true });
            librarySidebar.refresh();
            libraryWindow.show();
            setStatus("Created a blueprint book with the current blueprint in the library.");
          } catch (err) {
            setStatus(saveFailureMessage(err, "Couldn't create the book — the current blueprint doesn't decode."), "error");
          }
          return;
        }
        case "alt":
          setAltMode(!altModeOn);
          return;
        case "copper":
        case "green":
        case "red":
          toggleWireInHand(tool);
          return;
      }
    },
  });
  syncQuickbar();

  // 1–9 and 0 take the active quickbar's slots into the cursor, as in the
  // game. e.code so the number row works whatever the layout's shift state.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const match = /^Digit([0-9])$/.exec(e.code);
    if (!match) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    const digit = Number(match[1]);
    if (quickbar?.pickSlot(digit === 0 ? 9 : digit - 1)) e.preventDefault();
  }, { signal });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && quickbar?.closePanel()) e.preventDefault();
  }, { signal });

  // Titlebar button slides the whole docked sidebar out to a slim collapsed
  // strip (not a category-collapse — that's the per-folder disclosure
  // triangles inside the list, a separate concern) so the canvas gets more
  // room without fully hiding the library the way the toolbar toggle does.
  let libraryCollapsed = false;
  const libraryWindowElForCollapse = $<HTMLDivElement>("#library-window");
  const libraryCollapseToggle = $<HTMLButtonElement>("#library-collapse-toggle");
  function setLibraryCollapsed(collapsed: boolean) {
    libraryCollapsed = collapsed;
    libraryWindowElForCollapse.classList.toggle("is-collapsed", libraryCollapsed);
    libraryCollapseToggle.textContent = libraryCollapsed ? "▸" : "◂";
    libraryCollapseToggle.title = libraryCollapsed ? "Expand sidebar" : "Collapse sidebar";
  }
  libraryCollapseToggle.addEventListener("click", () => setLibraryCollapsed(!libraryCollapsed), { signal });
  // On a phone the open sidebar would cover most of the map: start folded.
  if (matchMedia("(max-width: 640px)").matches) setLibraryCollapsed(true);

  // Import/Export dropdown on the toolbar. The menu lives outside the
  // toolbar (which scrolls sideways on phones and would clip it) and is
  // placed under its button on open.
  const importMenuButton = $<HTMLButtonElement>("#import-menu-button");
  const importMenu = $<HTMLDivElement>("#import-menu");
  const importLink = $<HTMLInputElement>("#import-link");
  function setImportMenuOpen(open: boolean): void {
    importMenu.hidden = !open;
    importMenuButton.classList.toggle("is-active", open);
    importMenuButton.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const r = importMenuButton.getBoundingClientRect();
    importMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - importMenu.offsetWidth - 8))}px`;
    importMenu.style.top = `${r.bottom + 4}px`;
  }
  importMenuButton.addEventListener("click", () => setImportMenuOpen(importMenu.hidden), { signal });
  document.addEventListener("pointerdown", (e) => {
    if (importMenu.hidden) return;
    const target = e.target as Node;
    if (!importMenu.contains(target) && !importMenuButton.contains(target)) setImportMenuOpen(false);
  }, { signal });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !importMenu.hidden) {
      e.preventDefault();
      setImportMenuOpen(false);
    }
  }, { signal });

  async function importText(text: string): Promise<void> {
    input.value = text;
    await guardedLoad(text);
  }

  $("#import-clipboard").addEventListener("click", async () => {
    setImportMenuOpen(false);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setStatus("Couldn't read the clipboard — your browser may need permission granted first.", "error");
      return;
    }
    if (!text.trim()) {
      setStatus("Clipboard is empty.", "error");
      return;
    }
    // A copied link imports the same as one typed into the link field.
    if (!looksLikeBlueprintString(text) && parseBlueprintLink(text)) {
      await importFromLink(text);
      return;
    }
    await importText(text);
  }, { signal });

  async function importFromLink(text: string): Promise<void> {
    setStatus("Fetching blueprint…", "info", true);
    try {
      const bpString = await resolveBlueprintLink(text);
      status.hidden = true;
      await importText(bpString);
      importLink.value = "";
    } catch (err) {
      setStatus(err instanceof BlueprintLinkError ? err.message : "Couldn't import from that link.", "error");
    }
  }

  async function importFromFile(file: File): Promise<void> {
    try {
      const content = await readBlueprintFile(file);
      // The editor may have been left while the file was being read.
      if (signal.aborted) return;
      if (content.kind === "link") await importFromLink(content.value);
      else await importText(content.value);
    } catch (err) {
      setStatus(err instanceof BlueprintFileError ? err.message : `Couldn't read ${file.name}.`, "error");
    }
  }

  const importFileInput = $<HTMLInputElement>("#import-file-input");
  $("#import-file").addEventListener("click", () => {
    setImportMenuOpen(false);
    importFileInput.click();
  }, { signal });
  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    // Cleared so picking the same file again still fires "change".
    importFileInput.value = "";
    if (file) void importFromFile(file);
  }, { signal });

  // A file dragged from the desktop onto the editor imports the same way.
  // Only file drags are claimed; anything else keeps the browser default.
  const isFileDrag = (e: DragEvent): boolean => e.dataTransfer?.types.includes("Files") ?? false;
  window.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  }, { signal });
  window.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const file = e.dataTransfer!.files[0];
    if (file) void importFromFile(file);
  }, { signal });

  $<HTMLFormElement>("#import-link-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = importLink.value.trim();
    if (!text) {
      importLink.focus();
      return;
    }
    setImportMenuOpen(false);
    void importFromLink(text);
  }, { signal });

  $("#import-example").addEventListener("click", async () => {
    setImportMenuOpen(false);
    try {
      const pool = await loadExamplePool();
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      await importText(pick.bp);
    } catch {
      setStatus("Couldn't load an example blueprint — check your connection and try again.", "error");
    }
  }, { signal });

  /** Copies the current blueprint; false (with the reason shown) if there
   *  is nothing to copy or the clipboard refused. */
  async function exportToClipboard(): Promise<boolean> {
    if (!hasBlueprintContent()) {
      setStatus("Nothing to export yet — import or build a blueprint first.", "error");
      return false;
    }
    const template = currentTemplate();
    const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, template, wires) });
    try {
      await navigator.clipboard.writeText(bpString);
      input.value = bpString;
      return true;
    } catch {
      setStatus("Couldn't write to the clipboard — your browser may need permission granted first.", "error");
      return false;
    }
  }

  $("#export-clipboard").addEventListener("click", async () => {
    setImportMenuOpen(false);
    if (await exportToClipboard()) setStatus(`Copied ${entities.length} entities to clipboard.`, "info", true);
  }, { signal });

  // Neither site has an upload API (both need an account), so "share" is:
  // copy the string, open the site's upload page, paste it there.
  for (const target of SHARE_TARGETS) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "menuitem";
    item.className = "toolbar-menu-item";
    item.textContent = `Share on ${target.name} ↗`;
    item.title = `Copies the blueprint string and opens ${target.name} — paste it there to publish`;
    item.addEventListener("click", async () => {
      setImportMenuOpen(false);
      // Opened before the clipboard await so the popup still counts as
      // part of the click.
      const tab = window.open(target.url, "_blank", "noopener");
      if (await exportToClipboard()) {
        setStatus(`Copied — paste the string on ${target.name}.`, "info", true);
      } else {
        tab?.close();
      }
    }, { signal });
    $("#export-share").appendChild(item);
  }
  // Switching between blueprints WITHIN the same already-loaded book isn't
  // gated — it's not "loading something new" the way import/library-pick
  // is, and selectBlueprint's own reset (undoStack/hasUnsavedChanges) only
  // applies to the blueprint just switched TO, matching how the picker
  // already behaved before this guard existed.
  picker.addEventListener("change", () => selectBookBlueprint(Number(picker.value)), { signal });

  // Cmd/Ctrl+S saves to the library entry that is open (or asks for a name
  // when there is none); with Shift it always asks, saving a new entry.
  // Claimed even while typing in a field, so the browser's own "save page"
  // dialog never opens over the editor.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    if (e.shiftKey) void saveCurrentAs();
    else saveCurrent();
  }, { signal });

  // Cmd/Ctrl+Z undo, +Shift redo — guarded against firing while focus is in
  // the blueprint-string textarea so the browser's native textarea undo
  // wins there instead of fighting this one.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if (document.activeElement === input) return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }, { signal });

  // Alt+D activates the delete tool: drag a box (or click one entity) and
  // it's gone immediately, one undo step per box. Pressing Alt+D again
  // while already in delete mode is a harmless no-op re-arm — only 'q' or
  // Escape leaves the mode (see their own handlers). e.code, not e.key —
  // same reasoning as the Alt+C/R/G wire shortcuts just below: macOS emits
  // a special character for Alt+D as e.key.
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.code !== "KeyD") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    usedAltAsModifier = true; // same guard as Alt+C/R/G — its release must not also toggle alt mode
    setMode("deleteBox");
    setStatus("Delete tool — drag a box to delete what's inside.");
  }, { signal });

  // Cmd/Ctrl+C activates the copy tool: drag a box (or click one entity)
  // and it's copied immediately — a real blueprint string to the system
  // clipboard, plus an in-app paste ghost armed on the cursor (see
  // copyBoxToClipboardAndGhost, fired from onCopyBox). Guarded against
  // text-input focus so the browser's native copy still works in the
  // blueprint-string textarea and anywhere else text might be selected.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    setMode("copyBox");
    setStatus("Copy tool — drag a box to copy it onto the cursor.");
  }, { signal });

  // Cmd/Ctrl+X activates the cut tool: drag a box and it's copied (as
  // above) AND removed from the blueprint, in one undo step (see
  // onCutBox) — the armed ghost then lets the group be moved elsewhere in
  // one gesture.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "x") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    setMode("cutBox");
    setStatus("Cut tool — drag a box to cut it.");
  }, { signal });

  // Escape cancels an active box-drag mode or an armed paste ghost,
  // returning to idle — checked and consumed here, BEFORE the existing
  // menu-state Escape handler below, via stopImmediatePropagation, so a
  // box/paste-mode Escape doesn't also fall through and try to back out of
  // a (default, no-op) menu state.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // A rail plan in progress drops back to just holding the rail item.
    if (renderer.cancelRailPlan()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!boxModeOn && !pasteArmed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setMode("idle");
  }, { signal });

  // Cmd/Ctrl+V anywhere on the tool pastes a blueprint string straight in,
  // matching the real game's own "paste a blueprint to import it" gesture —
  // no need to focus the textarea and click Import first. Guarded against
  // firing while focus is in a text input so a normal paste there (the
  // blueprint-string textarea itself included, or any future text field)
  // keeps its native behavior instead of being hijacked. Uses the native
  // paste event's own clipboardData rather than navigator.clipboard.readText
  // — the latter needs a permission prompt the first time, the former
  // doesn't (it's already a user-initiated paste gesture).
  window.addEventListener("paste", (e) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text?.trim()) return;
    e.preventDefault();
    input.value = text;
    load(text);
  }, { signal });

  // Set whenever Alt is used as a gesture MODIFIER rather than tapped on
  // its own (Shift+Alt+scroll quality cycling, Alt+right-click module
  // stamping), checked and cleared by the Alt-keyup handler above — without
  // it, every such gesture would also toggle alt mode on release.
  let usedAltAsModifier = false;

  // Alt+C / Alt+R / Alt+G put a copper / red / green wire on the cursor.
  // Two clicks then make or break that wire between the pair (see
  // onWireClick); 'q' clears, in two stages.
  //
  // Bound on e.code, NOT e.key: on macOS Alt+letter emits a special
  // character (Alt+C is "ç", Alt+R "®", Alt+G "©"), so an e.key check would
  // simply never match. e.code is the physical key and is unaffected by the
  // modifier or the keyboard layout. Every other shortcut in this file
  // reads e.key and explicitly bails on altKey, which is why none of them
  // hit this problem.
  const WIRE_KEYS: Record<string, WireColor> = { KeyC: "copper", KeyR: "red", KeyG: "green" };
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const color = WIRE_KEYS[e.code];
    if (!color) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    // Alt is being held as a modifier here, so its eventual release must not
    // also toggle alt mode (the same guard Shift+Alt+scroll and Alt+right-
    // click already use).
    usedAltAsModifier = true;
    // Pressing the same colour again puts the wire away, so one shortcut
    // both takes and drops it — matching how 'q' toggles on a pipette.
    // Taken by keyboard, so no pointer move will follow to draw the cursor
    // icon — toggleWireInHand paints it at the pointer's last known position.
    toggleWireInHand(color);
  }, { signal });

  // Shift+Alt+scroll while a ghost is in hand cycles its quality tier
  // (up on scroll-up, down on scroll-down) — matches the real game's own
  // quality-cycle gesture. Captured on the container (not the renderer's
  // own inner <canvas>) so it can stopImmediatePropagation before the
  // renderer's own wheel listener (canvas.ts's zoom-at-cursor) sees it —
  // without that, scrolling to change quality would also zoom the camera.
  canvas.addEventListener("wheel", (e) => {
    if (!e.shiftKey || !e.altKey || !paletteSelection) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    usedAltAsModifier = true;
    const i = QUALITY_TIERS.indexOf(paletteQuality);
    const next = QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))]!;
    if (next === paletteQuality) return;
    // No direction passed — setMode/setInteractionMode preserve the
    // ghost's current facing as long as the entity name itself doesn't
    // change, which it doesn't here (only the quality does).
    setMode({ place: paletteSelection, quality: next });
    // Keeps a Build menu that happens to be open in sync, so its quality
    // strip never disagrees with the ghost actually in hand.
    activeMenu?.setQuality(next);
  }, { capture: true, signal });

  // 'r' rotates whatever you're currently "holding" — matches Factorio's
  // own convention. In place mode that's the not-yet-placed ghost (rotates
  // in the renderer, no edit/undo entry — nothing's been placed yet);
  // otherwise a click-opened entity's own selection rotates (undoable, via
  // rotateSelected); otherwise, matching the real game, whatever building is
  // merely under the cursor right now rotates in place too, with no click
  // needed first. Shift+R reverses the turn to counter-clockwise.
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "r" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    // No preventDefault here — 'r' isn't a key the browser does anything
    // with by default (no scroll/shortcut to suppress), and calling it
    // anyway was making the OS-level "hide pointer while typing" cursor
    // heuristic (macOS Trackpad/Mouse setting) trigger on every rotate,
    // leaving the system cursor invisible until the next mousemove.
    if (paletteSelection) {
      renderer.rotateGhost(e.shiftKey);
    } else if (pasteArmed) {
      renderer.rotatePasteGhost(e.shiftKey);
    } else if (selectedEntity) {
      rotateSelected(e.shiftKey);
    } else {
      const hovered = hoveredEntityNumber !== undefined ? entities.find((en) => en.entityNumber === hoveredEntityNumber) : undefined;
      if (hovered) rotateEntity(hovered, e.shiftKey);
    }
  }, { signal });

  // Escape always backs out one menu state — the reverse of whatever
  // opened the current one (see enterMenuState's own transition map). The
  // text-input guard is deliberately NOT applied to Escape the way it is to
  // the letter shortcuts: backing out of a menu while the cursor sits in
  // its filter box is exactly when Escape is most wanted.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (menuState === "default") return;
    e.preventDefault();
    exitCurrentMenuState();
  }, { signal });

  // 'e' is the one key that walks the whole menu graph: it opens the Build
  // menu from the canvas, confirms an open menu's selection when it has one
  // (the same thing that menu's green check button does), and otherwise
  // backs out exactly like Escape. Matches the real game's own "e opens
  // your inventory/crafting screen, e closes it again" convention.
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "e" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    if (menuState === "default") {
      enterMenuState("build");
      return;
    }
    if (activeMenu?.hasSelection()) {
      activeMenu.confirm();
      return;
    }
    exitCurrentMenuState();
  }, { signal });

  // 'q' is the smart pipette AND the "clear cursor" gesture, matching the
  // real game's own dual behavior: over an entity, it picks up that
  // entity's type and switches straight to place mode with it selected;
  // over empty space, it clears whatever's currently in hand back to idle
  // (replacing a separate Escape-to-clear shortcut, per the user's own
  // correction — Factorio itself overloads 'q' for both, it doesn't use
  // Escape for this). Reads hoveredEntityNumber (kept live by
  // onSchematicHover regardless of mode) rather than needing its own
  // pointer tracking. Also works over a hovered Build-menu cell — picks
  // that entity the same way clicking it would — checked first since a
  // palette cell under the cursor always takes priority over whatever's
  // hovered on the canvas underneath the (possibly overlapping) window.
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "q" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    // No preventDefault — same reasoning as 'r': nothing browser-default to
    // suppress, and calling it was triggering macOS's own "hide pointer
    // while typing" heuristic, leaving the system cursor invisible until
    // the next mousemove.
    // A wire on the cursor clears in two stages, per the user's own design:
    // the first 'q' drops a half-finished pick but KEEPS the wire in hand
    // (so a mis-click costs one keypress, not the whole mode), and only a
    // second 'q' puts the wire away. Checked before every branch below,
    // since none of them applies while a wire is in hand.
    if (wireColorInHand !== null) {
      if (pendingWireFrom !== null) {
        setPendingWireFrom(null);
        setStatus(`Cleared the pick — still holding the ${wireColorInHand} wire.`);
      } else {
        setMode("idle");
        setStatus("Put the wire away.");
      }
      return;
    }

    // A module under the cursor — either a cell in the module menu or a
    // filled slot in the machine GUI — goes into the cursor as a held
    // module rather than an entity ghost: a module isn't placeable on the
    // ground, its targets are slots and machines (see setHeldModule).
    const underPointer = document.elementFromPoint(lastPointerPos.x, lastPointerPos.y);
    const moduleCell = underPointer?.closest<HTMLElement>("#module-window .palette-cell");
    if (moduleCell?.dataset.value) {
      setHeldModule({ name: moduleCell.dataset.value, quality: activeMenuQuality() });
      return;
    }
    const moduleSlot = underPointer?.closest<HTMLElement>(".module-slot-cell");
    if (moduleSlot && selectedEntity) {
      const slotIndex = [...(moduleSlot.parentElement?.children ?? [])].indexOf(moduleSlot);
      const inSlot = expandModuleSlots(selectedEntity.modules)[slotIndex];
      // Pipetting an empty slot clears the cursor instead of picking up
      // "nothing", matching how 'q' over empty ground clears it.
      setHeldModule(inSlot ? { ...inSlot } : null);
      return;
    }

    // An item in a circuit GUI slot, or in the signal picker: into the
    // cursor as a ghost to build, like the game's pipette over a slot.
    const signalItem =
      underPointer?.closest<HTMLElement>(".circuit-slot[data-signal]")?.dataset.signal ??
      underPointer?.closest<HTMLElement>("#signal-window .palette-cell")?.dataset.value;
    if (signalItem) {
      const data = getData();
      if (data.modules[signalItem]) {
        setHeldModule({ name: signalItem, quality: "normal" });
      } else if (placeableEntries(data, getRenderCatalog()).some((en) => en.name === signalItem)) {
        setHeldModule(null);
        setMode({ place: signalItem, quality: paletteQuality });
        enterMenuState("default");
        updateCursorIcon(lastPointerPos.x, lastPointerPos.y);
      } else {
        const catalog = getRenderCatalog();
        setStatus(`${catalog.itemNames[signalItem] ?? catalog.signals?.[signalItem]?.localised ?? signalItem} can't be built.`, "error");
      }
      return;
    }

    const hoveredCell = !paletteWindow.el.hidden
      ? document.elementFromPoint(lastPalettePointer.x, lastPalettePointer.y)?.closest<HTMLElement>(".palette-cell")
      : null;
    if (hoveredCell?.dataset.entityName) {
      setHeldModule(null);
      setMode({ place: hoveredCell.dataset.entityName, quality: paletteQuality });
      deselect();
      updateCursorIcon(lastPalettePointer.x, lastPalettePointer.y);
      return;
    }
    if (heldModule) {
      // 'q' with a module in hand and nothing pipette-able under the cursor
      // drops it, the same way it drops an entity ghost.
      setHeldModule(null);
      return;
    }
    const entity = hoveredEntityNumber !== undefined ? entities.find((en) => en.entityNumber === hoveredEntityNumber) : undefined;
    if (entity && entity.name === paletteSelection) {
      // Pipetting the same building the ghost is already set to is a
      // second press on the same spot — toggle back to idle instead of
      // re-picking the identical thing, so 'q' twice on one spot clears it.
      setMode("idle");
    } else if (entity && isRail(entity.name)) {
      // Track is laid by the rail item, whatever piece is pointed at, on
      // the ground or up on the deck; only a ramp picks up the ramp item.
      const item = entity.name === "rail-ramp" ? "rail-ramp" : "straight-rail";
      if (item === paletteSelection) setMode("idle");
      else setMode({ place: item, quality: "normal", direction: entity.name === "straight-rail" ? entity.direction : undefined });
    } else if (entity) {
      // The pipette also picks up the hovered entity's own quality and
      // facing, not just its type — matches the real game's own
      // smart-pipette behavior (it copies the exact item stack you're
      // pointing at, ghost already facing the same way it was placed).
      setMode({ place: entity.name, quality: entity.quality, direction: entity.direction });
      deselect();
    } else {
      setMode("idle");
    }
  }, { signal });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-timescale]")) {
    button.addEventListener("click", () => {
      options.timescale = button.dataset.timescale as Timescale;
      for (const other of root.querySelectorAll("[data-timescale]")) {
        other.classList.toggle("is-active", other === button);
      }
      if (result) recalculate();
    }, { signal });
  }

  const multiplier = $<HTMLInputElement>("#multiplier");
  multiplier.addEventListener("input", () => {
    const value = Number(multiplier.value);
    options.multiplier = Number.isFinite(value) && value > 0 ? value : 1;
    if (result) recalculate();
  }, { signal });

  const measureKind = $<HTMLSelectElement>("#measure-kind");
  const beltFields = $<HTMLLabelElement>("#measure-belt-fields");
  const inserterFields = $<HTMLLabelElement>("#measure-inserter-fields");
  const beltSelect = $<HTMLSelectElement>("#belt");
  const beltStack = $<HTMLInputElement>("#belt-stack");
  const beltIcon = $<HTMLSpanElement>("#belt-icon");
  const inserterSelect = $<HTMLSelectElement>("#inserter");
  const inserterQuality = $<HTMLSelectElement>("#inserter-quality");
  appendQualityOptions(inserterQuality);
  const inserterIcon = $<HTMLSpanElement>("#inserter-icon");

  function populateMeasureOptions() {
    const data = getData();
    const prevBelt = beltSelect.value;
    beltSelect.replaceChildren();
    for (const belt of Object.values(data.belts)) {
      beltSelect.appendChild(new Option(belt.localised, belt.name));
    }
    if (prevBelt && data.belts[prevBelt]) beltSelect.value = prevBelt;

    const prevInserter = inserterSelect.value;
    inserterSelect.replaceChildren();
    for (const inserter of Object.values(data.inserters)) {
      inserterSelect.appendChild(new Option(inserter.localised, inserter.name));
    }
    if (prevInserter && data.inserters[prevInserter]) inserterSelect.value = prevInserter;
  }

  function updateMeasure() {
    const data = getData();
    beltFields.hidden = measureKind.value !== "belt";
    inserterFields.hidden = measureKind.value !== "inserter";

    if (measureKind.value === "belt") {
      const belt = data.belts[beltSelect.value];
      const stackSize = Number(beltStack.value);
      options.measure = belt
        ? { kind: "belt", belt, stackSize: Number.isFinite(stackSize) && stackSize > 0 ? stackSize : 1 }
        : { kind: "none" };
      beltIcon.replaceChildren(...(belt ? [icon(belt.name, belt.localised, 22)] : []));
    } else if (measureKind.value === "inserter") {
      const inserter = data.inserters[inserterSelect.value];
      options.measure = inserter
        ? { kind: "inserter", inserter, quality: inserterQuality.value as QualityName }
        : { kind: "none" };
      inserterIcon.replaceChildren(...(inserter ? [icon(inserter.name, inserter.localised, 22)] : []));
    } else {
      options.measure = { kind: "none" };
    }
    if (result) recalculate();
  }

  measureKind.addEventListener("change", updateMeasure, { signal });
  beltSelect.addEventListener("change", updateMeasure, { signal });
  beltStack.addEventListener("input", updateMeasure, { signal });
  inserterSelect.addEventListener("change", updateMeasure, { signal });
  inserterQuality.addEventListener("change", updateMeasure, { signal });

  const targetItemSelect = $<HTMLSelectElement>("#target-item");
  const targetRateFields = $<HTMLLabelElement>("#target-rate-fields");
  const targetRateInput = $<HTMLInputElement>("#target-rate");
  const targetTimescaleSelect = $<HTMLSelectElement>("#target-timescale");
  const targetClearButton = $<HTMLButtonElement>("#target-clear");

  /** Only items this blueprint actually produces make sense as a target —
   *  populated (and re-populated after loadData()'s dataset swap) from the
   *  current calculation's products/intermediates. */
  function populateTargetOptions() {
    if (!result) return;
    const prevValue = targetItemSelect.value;
    const producible = [...result.products, ...result.intermediates].sort((a, b) => a.label.localeCompare(b.label));
    targetItemSelect.replaceChildren(new Option("no target — show theoretical max", ""));
    for (const flow of producible) {
      targetItemSelect.appendChild(new Option(flow.label, flow.name));
    }
    if (prevValue && producible.some((f) => f.name === prevValue)) targetItemSelect.value = prevValue;
  }

  function updateTarget() {
    targetRateFields.hidden = !targetItemSelect.value;
    const rate = Number(targetRateInput.value);
    if (targetItemSelect.value && Number.isFinite(rate) && rate > 0) {
      scaleTarget = { itemName: targetItemSelect.value, rate, timescale: targetTimescaleSelect.value as Timescale };
    } else {
      scaleTarget = null;
    }
    if (result) recalculate();
  }

  targetItemSelect.addEventListener("change", updateTarget, { signal });
  targetRateInput.addEventListener("input", updateTarget, { signal });
  targetTimescaleSelect.addEventListener("change", updateTarget, { signal });
  targetClearButton.addEventListener("click", () => {
    targetItemSelect.value = "";
    targetRateInput.value = "";
    updateTarget();
  }, { signal });

  // The vanilla dataset covers enough to render instantly; swap in the
  // site's own generated dataset as soon as it loads and recompute so real
  // blueprints don't miss recipes.
  populateMeasureOptions();
  // A saved autosave (see persistEntities' own doc comment) takes priority
  // over a fresh random example — restoring whatever the user was last
  // working on beats replacing it with something else every reload.
  let autosaved: string | null = null;
  try {
    autosaved = readAutosave();
  } catch {
    /* storage unavailable — fall through to the random example below */
  }
  if (autosaved) {
    input.value = autosaved;
    // The autosave is the blueprint that was open, edits included — so it
    // is still the same library entry it was before the reload.
    let reopened: string | null = null;
    try {
      reopened = localStorage.getItem(OPEN_ENTRY_KEY);
    } catch {
      /* storage unavailable */
    }
    if (load(autosaved, true) && reopened) setOpenEntry(reopened);
  } else {
    loadExamplePool()
      .then((pool) => {
        const pick = pool[Math.floor(Math.random() * pool.length)]!;
        input.value = pick.bp;
        load(pick.bp);
      })
      .catch(() => setStatus("Couldn't load an example blueprint — check your connection and try again.", "error"));
  }

  loadData().then(() => {
    // The renderer's entity->sprite lookup is built once from whatever
    // GameData/RenderCatalog it was mounted with; loadData() only populates
    // the real catalog asynchronously (game-data.json + render-catalog.json
    // both need to resolve), so a freshly-mounted renderer using the vanilla
    // fallback's empty catalog needs rebuilding once the real data is in —
    // otherwise every entity would stay stuck rendering as outline boxes.
    renderer.destroy();
    renderer = mountRenderer(canvas, getData(), getRenderCatalog(), currentQuality());
    renderer.onHover(onSchematicHover);
    rateOverlay.attach(renderer);
    applyAltMode();
    wireEditCallbacks();
    wireCameraPersistence();
    // A fresh renderer starts in 'idle', so whatever was in hand when the
    // real dataset arrived has to be re-applied — otherwise the app still
    // believes a wire (or an entity) is on the cursor while the renderer
    // that actually handles the clicks has forgotten, and every click falls
    // through to panning. Only mattered for wire mode in practice: the
    // palette re-sets place mode on the next pick, but a wire is taken once
    // by keyboard and then expected to stay in hand.
    if (wireColorInHand) renderer.setInteractionMode({ kind: "wire", color: wireColorInHand });
    else if (paletteSelection) renderer.setInteractionMode({ kind: "place", entityName: paletteSelection, quality: paletteQuality });
    // A fresh renderer knows nothing of a half-finished pick either, so an
    // armed wire would stop trailing to the cursor across the swap.
    if (pendingWireFrom !== null) renderer.setPendingWire(pendingWireFrom, pendingWireSide);
    if (hasBlueprintContent()) {
      const savedCamera = readSavedCamera();
      renderer.loadBlueprint(entities, wires, blueprints[selectedBlueprint]?.tiles);
      restoreCamera(savedCamera);
    }

    populateMeasureOptions();
    updateMeasure();
    populateStressEntitySelect();
    // A menu open across the dataset swap is rebuilt against the new data
    // rather than left showing the vanilla fallback's much smaller set.
    if (menuState !== "default") enterMenuState(menuState);
    // Only re-parse the textarea if nothing's loaded yet (entities.length
    // still empty means the vanilla-dataset render above at line 926 had
    // nothing to hand off) — entities.length itself already survived the
    // renderer swap via loadBlueprint(entities), so re-running load() here
    // unconditionally would blow away any edit the user made (place/erase/
    // rotate) while waiting for this real dataset to arrive, resetting
    // entities/undoStack/redoStack back to whatever was last decoded from
    // input.value.
    // That reload is still the same library entry, if it was one.
    if (!hasBlueprintContent() && input.value.trim()) {
      const entry = openEntryId;
      if (load(input.value) && entry) setOpenEntry(entry);
    }
  });

  // Dev-only console helper for faster manual testing — pan/zoom/load a
  // blueprint from the browser console instead of clicking through the
  // wheel-zoom-drag-pan UI for every check. Not part of the app's real
  // feature surface, not user-facing, no i18n/accessibility concerns.
  // Reads `renderer` live (not a captured reference) since loadData()
  // above replaces it once the real dataset arrives.
  (window as any).__debug = {
    /** Move the camera to a world tile coordinate (default keeps current zoom). */
    panTo(x: number, y: number, pixelsPerTile?: number) {
      renderer.camera.state.x = x;
      renderer.camera.state.y = y;
      if (pixelsPerTile !== undefined) renderer.camera.state.pixelsPerTile = pixelsPerTile;
    },
    /** Set zoom directly, in screen pixels per world tile (camera.ts clamps to [2, 256]). */
    setZoom(pixelsPerTile: number) {
      renderer.camera.state.pixelsPerTile = pixelsPerTile;
    },
    /** Zoom in/out by a multiplicative factor, keeping the current center fixed. */
    zoomBy(factor: number) {
      renderer.camera.state.pixelsPerTile *= factor;
    },
    /** Fit the camera to the current blueprint's full extent, or to an explicit box. */
    frame(box?: { minX: number; minY: number; maxX: number; maxY: number }) {
      const rect = canvas.getBoundingClientRect();
      const target = box ?? (() => {
        if (!entities.length) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
        const xs = entities.map((e) => e.x);
        const ys = entities.map((e) => e.y);
        return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      })();
      renderer.camera.frame(target, rect.width, rect.height);
    },
    /** Load a blueprint string directly (same path as pasting into the intake box). */
    load(bpString: string) {
      input.value = bpString;
      load(bpString);
    },
    /** Load a random example from the user's own blueprint book. */
    async loadRandomExample() {
      const pool = await loadExamplePool();
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      input.value = pick.bp;
      load(pick.bp);
    },
    /** Load the built-in rotation/connection-sweep test blueprint. */
    loadRotationTest() {
      input.value = ROTATION_TEST_BLUEPRINT;
      load(ROTATION_TEST_BLUEPRINT);
    },
    /** Load the built-in renderer debug lab — every entity kind, every
     *  facing, grown over time as render bugs get fixed (see
     *  DEBUG_BLUEPRINT's own doc comment in packages/engine/src/data/
     *  debug-lab.ts). It is fetched as its own chunk on first use. */
    async loadDebugLab() {
      const bpString = await loadDebugBlueprint();
      input.value = bpString;
      load(bpString);
    },
    /** Every placed entity's name, position and facing. */
    listEntities() {
      return entities.map((e) => ({ name: e.name, x: e.x, y: e.y, direction: e.direction }));
    },
    /** Hide every floating GUI window for an unobstructed screenshot. */
    hideWindows() {
      for (const el of root.querySelectorAll<HTMLElement>(".gui-window")) el.style.display = "none";
    },
    showWindows() {
      for (const el of root.querySelectorAll<HTMLElement>(".gui-window")) el.style.removeProperty("display");
    },
    /** Current camera state, for orienting yourself after a pan/zoom call. */
    getCamera() {
      return { ...renderer.camera.state };
    },
    /** The currently-loaded entities (read-only inspection). */
    getEntities() {
      return entities;
    },
    /** Freeze the belt animation clock, then step through it frame-by-frame —
     *  for comparing exact frames instead of eyeballing a live 60fps loop. */
    freezeAnimation() {
      renderer.setAnimationFrozen(true);
    },
    unfreezeAnimation() {
      renderer.setAnimationFrozen(false);
    },
    stepAnimation(delta?: number) {
      renderer.stepAnimationFrame(delta);
      return renderer.getAnimationFrame();
    },
  };

  return () => {
    controller.abort();
    rateOverlay.destroy();
    stopQuality();
    renderer.destroy();
    graphicsWindow.destroy();
    rateWindowRaw.destroy();
    resultsWindow.destroy();
    aboutWindow.destroy();
    paletteWindow.destroy();
    propertiesWindow.destroy();
    recipeWindow.destroy();
    moduleWindow.destroy();
    hotbarPickWindow.destroy();
    quickbar?.destroy();
    debugWindow.destroy();
    clearInterval(debugPollHandle);
    cursorIcon.remove();
  };
}
