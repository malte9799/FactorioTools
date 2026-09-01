import {
  BlueprintError,
  collectBlueprints,
  decodeBlueprintString,
  encodeBlueprintString,
  toBlueprint,
  normaliseEntities,
  calculate,
  attachBottlenecks,
  computeScaleFactor,
  findScaleWarnings,
  getData,
  getRenderCatalog,
  loadData,
  ROTATION_TEST_BLUEPRINT,
  DEBUG_BLUEPRINT,
  TIMESCALE_FACTOR,
} from "@factoriotools/engine";
import type { CalculationResult, Timescale, Blueprint, PlacedEntity, QualityName, MachineGroup, ModuleStack, ThroughputContext, BottleneckSubgroup } from "@factoriotools/engine";
import { mountRenderer, type BlueprintRenderer, type HighlightRole } from "@factoriotools/renderer";
import { buildRecipeCard, renderResults, type ViewOptions } from "./legacy-view/panels.js";
import { icon } from "./legacy-view/icons.js";
import { makeFloatingWindow } from "../../window-manager.js";
import { buildPalette } from "./edit-palette.js";
import { appendQualityOptions } from "./quality-options.js";
import { buildPropertiesPanel } from "./edit-properties.js";

const TEMPLATE = `
  <div id="schematic" class="schematic-frame"></div>
  <div id="machine-tooltip" class="machine-tooltip gui-window" hidden></div>

  <div id="intake-window" class="gui-window floating-window" hidden>
    <div class="gui-titlebar">
      <span>Blueprint Viewer</span>
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="gui-body">
      <p class="eyebrow">Blueprint analysis</p>
      <p class="lede">Import a blueprint string from your clipboard, or edit the layout directly.</p>
      <div class="intake-actions">
        <button id="import" class="primary" type="button">Import from clipboard</button>
        <button id="export" class="ghost" type="button">Export to clipboard</button>
      </div>
      <div class="intake-actions">
        <button id="demo" class="ghost" type="button">Load an example</button>
        <button id="rotation-test" class="ghost" type="button">Load rotation test</button>
        <button id="debug-lab" class="ghost" type="button">Load debug lab</button>
        <select id="bp-picker" hidden aria-label="Blueprint in book"></select>
      </div>
      <textarea id="bp-input" hidden></textarea>
      <p id="status" data-kind="info"></p>
    </div>
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

  <div id="palette-window" class="gui-window floating-window" hidden>
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

  <div id="window-toolbar">
    <button type="button" data-toggle="intake-window">Blueprint Viewer</button>
    <button type="button" data-toggle="results-window">Rate Calculator</button>
    <button type="button" data-toggle="palette-window">Build</button>
    <button type="button" data-toggle="about-window">About</button>
    <button type="button" id="alt-mode-toggle" title="Show recipes and modules (Alt)">Alt mode</button>
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
    examplePool = fetch("/data/example-blueprints.json")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .catch((err) => {
        examplePool = undefined; // let a later click retry instead of caching the failure
        throw err;
      });
  }
  return examplePool;
}

export function mountBlueprintViewer(root: HTMLElement): () => void {
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

  const intakeWindow = makeFloatingWindow($("#intake-window"), { x: 16, y: 66 });
  const resultsWindow = makeFloatingWindow(resultsWindowEl, { x: Math.max(16, window.innerWidth - 460), y: 66 });
  const aboutWindow = makeFloatingWindow($("#about-window"), { x: 16, y: window.innerHeight - 120 });
  const paletteWindow = makeFloatingWindow($("#palette-window"), { x: 16, y: Math.max(280, window.innerHeight - 340) });
  const propertiesWindow = makeFloatingWindow($("#properties-window"), {
    x: Math.max(16, window.innerWidth - 900),
    y: 66,
    onClose: deselect,
  });

  // All floating windows start hidden so the blueprint fills the screen
  // uninterrupted — the toolbar below (bottom-of-template, always visible)
  // toggles each one back on. propertiesWindow isn't in this map — it has
  // no toolbar entry, since it opens automatically on selection (see
  // wireEditCallbacks' onSelect) and closes via its own close button, 'e',
  // or Escape, matching the real game's own "click a building to open its
  // GUI" convention rather than a manually-toggled panel.
  const allWindows: Record<string, ReturnType<typeof makeFloatingWindow>> = {
    "intake-window": intakeWindow,
    "results-window": resultsWindow,
    "about-window": aboutWindow,
    "palette-window": paletteWindow,
  };
  for (const w of Object.values(allWindows)) w.hide();
  propertiesWindow.hide();

  const controller = new AbortController();
  const { signal } = controller;

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
    button.addEventListener("click", () => {
      const target = allWindows[button.dataset.toggle!];
      if (!target) return;
      if (target.el.hidden) {
        target.show();
        target.bringToFront();
      } else {
        target.hide();
      }
    }, { signal });
  }

  let blueprints: Blueprint[] = [];
  let entities: PlacedEntity[] = [];
  let result: CalculationResult | null = null;

  const options: ViewOptions = {
    timescale: "minute",
    multiplier: 1,
    scaleFactor: 1,
    measure: { kind: "none" },
    rocketCargo: null,
  };
  let scaleTarget: { itemName: string; rate: number; timescale: Timescale } | null = null;
  let latestBottlenecks: Map<string, BottleneckSubgroup[]> = new Map();

  let renderer: BlueprintRenderer = mountRenderer(canvas, getData(), getRenderCatalog());
  renderer.onHover(onSchematicHover);

  // Alt mode: Factorio's own alt-key view — recipe icons on machines,
  // module icons on machines/beacons. A persistent toggle (button or the
  // 'Alt' key itself, tap not hold) rather than a held-key overlay, since a
  // held modifier fights normal web page behavior (alt+click, alt+tab)
  // more than it helps here. Survives the loadData() renderer swap below
  // by being re-applied to the fresh instance rather than living on the
  // renderer itself.
  let altModeOn = false;
  const altModeButton = $<HTMLButtonElement>("#alt-mode-toggle");
  function setAltMode(enabled: boolean) {
    altModeOn = enabled;
    renderer.setAltMode(altModeOn);
    altModeButton.classList.toggle("is-active", altModeOn);
  }
  altModeButton.addEventListener("click", () => setAltMode(!altModeOn), { signal });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Alt") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    setAltMode(!altModeOn);
  }, { signal });

  function setStatus(message: string, kind: "info" | "error" = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function groupForEntity(entityNumber: number): MachineGroup | null {
    if (!result) return null;
    return result.groups.find((g) => g.entityNumbers.includes(entityNumber)) ?? null;
  }

  function positionTooltip(event: PointerEvent) {
    const margin = 16;
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + margin;
    let y = event.clientY + margin;
    if (x + rect.width > window.innerWidth - margin) x = event.clientX - rect.width - margin;
    if (y + rect.height > window.innerHeight - margin) y = event.clientY - rect.height - margin;
    tooltip.style.left = `${Math.max(margin, x)}px`;
    tooltip.style.top = `${Math.max(margin, y)}px`;
  }

  function onSchematicHover(entityNumber: number | undefined, event: PointerEvent) {
    // Tracked independently of the rate-group lookup below (which only
    // resolves for entities the calc engine groups — poles/belts/etc. have
    // none) since the 'q' pipette shortcut needs to know what's under the
    // cursor regardless of whether it's rate-bearing.
    hoveredEntityNumber = entityNumber;
    const group = entityNumber === undefined ? null : groupForEntity(entityNumber);
    if (!group || entityNumber === undefined) {
      tooltip.hidden = true;
      renderer.setHighlight(null);
      return;
    }

    tooltip.replaceChildren();
    const card = buildRecipeCard(group, getData(), options);
    const window_ = document.createElement("div");
    window_.className = "gui-body";
    window_.appendChild(card);
    tooltip.appendChild(window_);
    tooltip.hidden = false;
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
  const AUTOSAVE_KEY = "factoriotools.blueprint-viewer.autosave";
  function persistEntities(): void {
    if (!entities.length) return;
    try {
      const template = blueprints[0] ?? { item: "blueprint" as const, label: undefined, version: undefined };
      const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, template) });
      localStorage.setItem(AUTOSAVE_KEY, bpString);
    } catch {
      /* storage unavailable — not worth surfacing for a dev convenience */
    }
  }

  function selectBlueprint(index: number) {
    const blueprint = blueprints[index];
    if (!blueprint) return;
    entities = normaliseEntities(blueprint);
    nextEntityNumber = entities.reduce((max, e) => Math.max(max, e.entityNumber), 0) + 1;
    undoStack = [];
    redoStack = [];
    deselect();
    renderer.loadBlueprint(entities);
    recalculate();
    persistEntities();
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

  function snapshotEntities(): PlacedEntity[] {
    return entities.map((e) => ({ ...e, modules: e.modules.map((m) => ({ ...m })) }));
  }

  /** Every mutating edit (place/remove/rotate/recipe/module) goes through
   *  this one choke point: snapshot for undo, clear redo (a new edit
   *  invalidates redo history), run the mutation, then push the shared
   *  entities/renderer/recalculate/re-render sequence every edit needs. */
  function applyEdit(mutate: () => void): void {
    undoStack.push(snapshotEntities());
    redoStack = [];
    mutate();
    renderer.updateEntities(entities);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
  }

  function undo(): void {
    if (!undoStack.length) return;
    redoStack.push(snapshotEntities());
    entities = undoStack.pop()!;
    selectedEntity = undefined; // safest default: it may not exist post-undo
    renderer.updateEntities(entities);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
  }

  function redo(): void {
    if (!redoStack.length) return;
    undoStack.push(snapshotEntities());
    entities = redoStack.pop()!;
    selectedEntity = undefined;
    renderer.updateEntities(entities);
    recalculate();
    renderPropertiesPanel();
    persistEntities();
  }

  function deselect() {
    selectedEntity = undefined;
    propertiesWindow.hide();
  }

  /** Placing over an existing entity of the SAME name at the SAME tile with
   *  a different quality selected upgrades that entity's quality in place
   *  instead of adding a duplicate on top of it — matches the real game's
   *  own "build over it with a higher-quality item to upgrade" convention,
   *  per the user's own design (chosen instead of a quality field in the
   *  entity GUI, which no longer exists). A different NAME at the same tile
   *  still adds a new entity rather than silently replacing something
   *  incompatible — only a same-name, different-quality rebuild counts as
   *  an upgrade. */
  function placeEntity(worldX: number, worldY: number, name: string, direction: number, quality: QualityName) {
    const existing = entities.find((e) => e.name === name && e.x === worldX && e.y === worldY);
    if (existing) {
      if (existing.quality === quality) return; // building the exact same thing again is a no-op
      mutateEntity(existing, (e) => {
        e.quality = quality;
      });
      return;
    }
    applyEdit(() => {
      const newEntity: PlacedEntity = {
        entityNumber: nextEntityNumber++,
        name,
        x: worldX,
        y: worldY,
        direction,
        quality,
        modules: [],
        filterItems: [],
      };
      entities = [...entities, newEntity];
    });
  }

  function removeEntity(entityNumber: number) {
    if (selectedEntity?.entityNumber === entityNumber) deselect();
    applyEdit(() => {
      entities = entities.filter((e) => e.entityNumber !== entityNumber);
    });
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

  /** Quarter-turn step in the 16-way scheme (step 4 of a full turn of 16) —
   *  matches toCardinal()'s own commitment to 16-way-only (see its doc
   *  comment in packages/renderer/src/beltGraph.ts): every direction value
   *  this app produces or reads is 16-way, since that's the only scheme
   *  Factorio 2.0 blueprint exports use. Shared by the properties panel's
   *  Rotate button and the 'r' keyboard shortcut so both rotate a selected
   *  entity identically. */
  function rotateSelected() {
    updateSelectedEntity((e) => {
      e.direction = (e.direction + 4) % 16;
    });
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
   *  below): left-click places it. Right-click erases in either mode
   *  (wired once in render.ts, not here). */
  function setMode(newMode: "idle" | { place: string; quality?: QualityName }) {
    if (newMode === "idle") {
      paletteSelection = null;
      renderer.setInteractionMode({ kind: "idle" });
    } else {
      paletteSelection = newMode.place;
      paletteQuality = newMode.quality ?? "normal";
      renderer.setInteractionMode({ kind: "place", entityName: newMode.place });
    }
    // The yellow inward-fading border is the at-a-glance "you have
    // something in hand" cue, matching the real game's own cursor-ghost
    // feedback — on only while actually placing, off once idle.
    canvas.classList.toggle("edit-mode", newMode !== "idle");
  }

  /** Wired onto whichever BlueprintRenderer instance is currently mounted —
   *  called once at initial mount and again after loadData()'s swap, since
   *  a fresh renderer instance has empty callback slots. */
  function wireEditCallbacks() {
    renderer.onPlace((worldX, worldY, direction) => {
      if (!paletteSelection) return;
      placeEntity(worldX, worldY, paletteSelection, direction, paletteQuality);
    });
    renderer.onSelect((entityNumber) => {
      const entity = entities.find((e) => e.entityNumber === entityNumber);
      if (!entity) {
        deselect();
        return;
      }
      selectedEntity = entity;
      renderPropertiesPanel();
    });
    renderer.onErase((entityNumber) => {
      removeEntity(entityNumber);
    });
  }
  wireEditCallbacks();

  const paletteBody = $<HTMLDivElement>("#palette-body");

  function refreshPalette() {
    buildPalette(paletteBody, getData(), getRenderCatalog(), (entityName, quality) => {
      setMode({ place: entityName, quality });
      deselect();
    });
  }

  function renderPropertiesPanel() {
    if (!selectedEntity) {
      propertiesWindow.hide();
      return;
    }
    const wasHidden = propertiesWindow.el.hidden;
    const propertiesBody = $<HTMLDivElement>("#properties-body");
    buildPropertiesPanel(propertiesBody, selectedEntity, getData(), getRenderCatalog(), latestBottlenecks, {
      onRecipeChange(recipeName) {
        updateSelectedEntity((e) => {
          e.recipe = recipeName;
        });
      },
      onModuleSlotChange(slotIndex, module) {
        updateSelectedEntity((e) => {
          const slots = expandModuleSlots(e.modules);
          slots[slotIndex] = module;
          e.modules = collapseModules(slots.filter((s): s is { name: string; quality: QualityName } => s !== null));
        });
      },
    });
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
        propertiesWindow.setPosition((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
      });
    }
  }

  function recalculate() {
    const data = getData();
    result = calculate(data, entities);
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

  function load(text: string) {
    try {
      const envelope = decodeBlueprintString(text);
      blueprints = collectBlueprints(envelope);
      if (blueprints.length === 0) {
        setStatus("That decoded fine but contains no blueprints.", "error");
        return;
      }

      picker.replaceChildren();
      blueprints.forEach((bp, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = bp.label || `Blueprint ${i + 1}`;
        picker.appendChild(option);
      });
      picker.hidden = blueprints.length < 2;

      const total = blueprints.reduce((sum, bp) => sum + (bp.entities?.length ?? 0), 0);
      setStatus(
        blueprints.length > 1
          ? `Read ${blueprints.length} blueprints, ${total} entities.`
          : `Read ${total} entities.`,
      );
      selectBlueprint(0);
    } catch (error) {
      resultsWindow.hide();
      setStatus(
        error instanceof BlueprintError ? error.message : "Couldn't read that blueprint.",
        "error",
      );
    }
  }

  $("#import").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus("Clipboard is empty.", "error");
        return;
      }
      input.value = text;
      load(text);
    } catch {
      setStatus("Couldn't read the clipboard — your browser may need permission granted first.", "error");
    }
  }, { signal });

  $("#export").addEventListener("click", async () => {
    if (!entities.length) {
      setStatus("Nothing to export yet — import or build a blueprint first.", "error");
      return;
    }
    const template = blueprints[0] ?? { item: "blueprint" as const, label: undefined, version: undefined };
    const bpString = encodeBlueprintString({ blueprint: toBlueprint(entities, template) });
    try {
      await navigator.clipboard.writeText(bpString);
      input.value = bpString;
      setStatus(`Copied ${entities.length} entities to clipboard.`);
    } catch {
      setStatus("Couldn't write to the clipboard — your browser may need permission granted first.", "error");
    }
  }, { signal });

  $("#demo").addEventListener("click", async () => {
    try {
      const pool = await loadExamplePool();
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      input.value = pick.bp;
      load(pick.bp);
    } catch {
      setStatus("Couldn't load an example blueprint — check your connection and try again.", "error");
    }
  }, { signal });
  $("#rotation-test").addEventListener("click", () => {
    input.value = ROTATION_TEST_BLUEPRINT;
    load(ROTATION_TEST_BLUEPRINT);
  }, { signal });
  $("#debug-lab").addEventListener("click", () => {
    input.value = DEBUG_BLUEPRINT;
    load(DEBUG_BLUEPRINT);
  }, { signal });
  picker.addEventListener("change", () => selectBlueprint(Number(picker.value)), { signal });

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

  // 'r' rotates whatever you're currently "holding" — matches Factorio's
  // own convention. In place mode that's the not-yet-placed ghost (rotates
  // in the renderer, no edit/undo entry — nothing's been placed yet);
  // otherwise, if a click has opened an entity's properties panel, that
  // selected entity itself (goes through rotateSelected -> applyEdit, so
  // it's undoable).
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "r" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    if (paletteSelection) {
      e.preventDefault();
      renderer.rotateGhost();
    } else if (selectedEntity) {
      e.preventDefault();
      rotateSelected();
    }
  }, { signal });

  // 'e' and Escape both close the entity GUI, matching the real game's own
  // "e opens/closes the currently-hovered/open entity" and Escape's general
  // "back out of whatever's open" conventions. No-op when nothing's
  // selected (there's nothing to close), and guarded against firing while
  // focus is in a text input the same way every other shortcut here is.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key.toLowerCase() !== "e") return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    if (!selectedEntity) return;
    e.preventDefault();
    deselect();
  }, { signal });

  // 'q' is the smart pipette AND the "clear cursor" gesture, matching the
  // real game's own dual behavior: over an entity, it picks up that
  // entity's type and switches straight to place mode with it selected;
  // over empty space, it clears whatever's currently in hand back to idle
  // (replacing a separate Escape-to-clear shortcut, per the user's own
  // correction — Factorio itself overloads 'q' for both, it doesn't use
  // Escape for this). Reads hoveredEntityNumber (kept live by
  // onSchematicHover regardless of mode) rather than needing its own
  // pointer tracking.
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "q" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    const entity = hoveredEntityNumber !== undefined ? entities.find((en) => en.entityNumber === hoveredEntityNumber) : undefined;
    if (entity) {
      // The pipette also picks up the hovered entity's own quality, not
      // just its type — matches the real game's own smart-pipette
      // behavior (it copies the exact item stack you're pointing at).
      setMode({ place: entity.name, quality: entity.quality });
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
  refreshPalette();
  // A saved autosave (see persistEntities' own doc comment) takes priority
  // over a fresh random example — restoring whatever the user was last
  // working on beats replacing it with something else every reload.
  let autosaved: string | null = null;
  try {
    autosaved = localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    /* storage unavailable — fall through to the random example below */
  }
  if (autosaved) {
    input.value = autosaved;
    load(autosaved);
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
    renderer = mountRenderer(canvas, getData(), getRenderCatalog());
    renderer.onHover(onSchematicHover);
    renderer.setAltMode(altModeOn);
    wireEditCallbacks();
    if (entities.length) renderer.loadBlueprint(entities);

    populateMeasureOptions();
    updateMeasure();
    refreshPalette();
    // Only re-parse the textarea if nothing's loaded yet (entities.length
    // still empty means the vanilla-dataset render above at line 926 had
    // nothing to hand off) — entities.length itself already survived the
    // renderer swap via loadBlueprint(entities), so re-running load() here
    // unconditionally would blow away any edit the user made (place/erase/
    // rotate) while waiting for this real dataset to arrive, resetting
    // entities/undoStack/redoStack back to whatever was last decoded from
    // input.value.
    if (!entities.length && input.value.trim()) load(input.value);
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
    /** Set zoom directly, in screen pixels per world tile (camera.ts clamps to [6, 256]). */
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
     *  debug-lab.ts). */
    loadDebugLab() {
      input.value = DEBUG_BLUEPRINT;
      load(DEBUG_BLUEPRINT);
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
    renderer.destroy();
    intakeWindow.destroy();
    resultsWindow.destroy();
    aboutWindow.destroy();
    paletteWindow.destroy();
    propertiesWindow.destroy();
  };
}
