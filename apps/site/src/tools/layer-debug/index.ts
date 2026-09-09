/** Debug-only tool: pick any entity, see its real render-catalog graphics
 *  layers as a reorderable list, and preview changes through the exact same
 *  mountRenderer()/paint.ts pipeline the live Blueprint Viewer uses — so
 *  what you see here is guaranteed to match the real app, unlike a
 *  standalone reimplementation of the paint loop. Reachable at
 *  #/layer-debug (not linked from the nav bar — this is a dev aid, not a
 *  product feature).
 *
 *  Mutates the loaded RenderCatalog's entity graphics in place (the same
 *  object mountRenderer's buildVisualLookup captured a reference to at
 *  mount, so a mutation here is picked up by the next draw without
 *  remounting) — this is throwaway in-memory state, never persisted or sent
 *  anywhere; reloading the page discards it. Use the printed JSON summary
 *  to hand-translate a confirmed order back into
 *  packages/data-pipeline/src/dump-to-gamedata.ts. */
import { getData, getRenderCatalog, loadData, Layer, type PlacedEntity, type GraphicsLayer, type Sprite } from "@factoriotools/engine";
import { mountRenderer, getSharedSpriteAtlas, PIXELS_PER_TILE, type BlueprintRenderer } from "@factoriotools/renderer";

const LAYER_NAMES: Record<Layer, string> = {
  [Layer.Floor]: "Floor",
  [Layer.Shadow]: "Shadow",
  [Layer.LowerObject]: "LowerObject",
  [Layer.Object]: "Object",
  [Layer.AboveObject]: "AboveObject",
};
const LAYER_VALUES = [Layer.Floor, Layer.Shadow, Layer.LowerObject, Layer.Object, Layer.AboveObject];

const DIR_BY_LABEL: Record<string, number> = { N: 0, E: 4, S: 8, W: 12 };

const TEMPLATE = `
  <div id="ld-sidebar">
    <h2>Entity</h2>
    <input id="ld-filter" placeholder="filter by name…" autocomplete="off">
    <div id="ld-entity-list"></div>

    <h2>Last viewed</h2>
    <div id="ld-recent" class="ld-hint">None yet.</div>

    <h2>Facing</h2>
    <div class="ld-row" id="ld-facing"></div>

    <h2>Layers (drag to reorder, dropdown to change tier)</h2>
    <div class="ld-hint">Rendered through the real mountRenderer()/paint.ts — what you see here is exactly what the Blueprint Viewer would draw.</div>
    <div id="ld-layer-list"></div>

    <h2>Result</h2>
    <button id="ld-copy" type="button">Copy layer summary</button>
    <textarea id="ld-json" readonly></textarea>
  </div>
  <div id="ld-canvas-wrap"></div>
`;

const RECENT_KEY = "layer-debug:recent";
const RECENT_MAX = 5;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(names: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(names));
  } catch {
    // Private window, storage disabled, or quota hit — fine for a dev tool.
  }
}

export function mountLayerDebug(root: HTMLElement): () => void {
  root.innerHTML = TEMPLATE;
  root.classList.add("layer-debug-root");

  const filterBox = root.querySelector<HTMLInputElement>("#ld-filter")!;
  const entityListEl = root.querySelector<HTMLDivElement>("#ld-entity-list")!;
  const recentEl = root.querySelector<HTMLDivElement>("#ld-recent")!;
  const facingEl = root.querySelector<HTMLDivElement>("#ld-facing")!;
  const layerListEl = root.querySelector<HTMLDivElement>("#ld-layer-list")!;
  const jsonOut = root.querySelector<HTMLTextAreaElement>("#ld-json")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#ld-copy")!;
  const canvasWrap = root.querySelector<HTMLDivElement>("#ld-canvas-wrap")!;
  const highlightCanvas = document.createElement("canvas");
  highlightCanvas.id = "ld-highlight-canvas";

  let destroyed = false;
  let renderer: BlueprintRenderer | null = null;
  let currentName: string | null = null;
  let currentLayers: GraphicsLayer[] = [];
  let direction = 0;
  let recentNames = loadRecent();
  // hoveredLayer pulses transiently while a sidebar card is under the
  // pointer; selectedLayer persists (click a card, or click the layer's own
  // sprite directly on the canvas) and pulses whenever nothing is hovered,
  // so the choice stays visible after the mouse moves away.
  let hoveredLayer: GraphicsLayer | null = null;
  let selectedLayer: GraphicsLayer | null = null;
  let pulseLoopRunning = false;
  const atlas = getSharedSpriteAtlas();

  function entityNames(): string[] {
    const data = getData();
    const catalog = getRenderCatalog();
    const names = new Set<string>();
    for (const m of Object.values(data.machines)) if (m.graphics) names.add(m.name);
    for (const b of Object.values(data.beacons)) if (b.graphics) names.add(b.name);
    for (const b of Object.values(data.belts)) if (b.graphics) names.add(b.name);
    for (const e of Object.values(catalog.entities)) if (e.graphics) names.add(e.name);
    return [...names].sort();
  }

  function graphicsFor(name: string) {
    const data = getData();
    const catalog = getRenderCatalog();
    return data.machines[name]?.graphics ?? data.beacons[name]?.graphics ?? data.belts[name]?.graphics ?? catalog.entities[name]?.graphics;
  }

  function renderEntityList(filter: string): void {
    entityListEl.innerHTML = "";
    for (const name of entityNames().filter((n) => n.includes(filter))) {
      const row = document.createElement("div");
      row.className = "ld-entity-row" + (name === currentName ? " active" : "");
      row.textContent = name;
      row.onclick = () => selectEntity(name);
      entityListEl.appendChild(row);
    }
  }

  function renderRecent(): void {
    if (recentNames.length === 0) {
      recentEl.textContent = "None yet.";
      return;
    }
    recentEl.innerHTML = "";
    recentEl.className = "";
    for (const name of recentNames) {
      const chip = document.createElement("div");
      chip.className = "ld-chip" + (name === currentName ? " active" : "");
      chip.textContent = name;
      chip.onclick = () => selectEntity(name);
      recentEl.appendChild(chip);
    }
  }

  function pushRecent(name: string): void {
    recentNames = [name, ...recentNames.filter((n) => n !== name)].slice(0, RECENT_MAX);
    saveRecent(recentNames);
    renderRecent();
  }

  function placedEntity(): PlacedEntity {
    return {
      entityNumber: 1,
      name: currentName!,
      x: 0,
      y: 0,
      direction,
      quality: "normal",
      modules: [],
      filterItems: [],
    };
  }

  /** Called on entity/facing changes — reframes the camera to fit, matching
   *  loadBlueprint's "first load / switching blueprints" contract. */
  function loadAndFrame(): void {
    if (!renderer || !currentName) return;
    renderer.loadBlueprint([placedEntity()]);
  }

  /** Called on every layer reorder/tier change — repaints without touching
   *  the camera, so dragging a card never jumps the view mid-drag. */
  function redraw(): void {
    if (!renderer || !currentName) return;
    renderer.updateEntities([placedEntity()]);
  }

  function selectEntity(name: string): void {
    const graphics = graphicsFor(name);
    if (!graphics) return;
    currentName = name;
    currentLayers = graphics.layers;
    renderEntityList(filterBox.value);
    renderLayerList();
    pushRecent(name);
    loadAndFrame();
  }

  function renderLayerList(): void {
    layerListEl.innerHTML = "";
    currentLayers.forEach((layer, idx) => {
      const card = document.createElement("div");
      card.className = "ld-layer-card";
      card.draggable = true;
      card.dataset.idx = String(idx);

      const nameEl = document.createElement("div");
      nameEl.className = "ld-layer-name";
      nameEl.textContent = layerSheetLabel(layer);
      card.appendChild(nameEl);

      const meta = document.createElement("div");
      meta.className = "ld-layer-meta";
      const orig = document.createElement("span");
      orig.textContent = "pos #" + idx;
      meta.appendChild(orig);
      const sel = document.createElement("select");
      for (const lv of LAYER_VALUES) {
        const opt = document.createElement("option");
        opt.value = String(lv);
        opt.textContent = LAYER_NAMES[lv];
        if (lv === layer.layer) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        layer.layer = Number(sel.value);
        updateOutput();
        redraw();
      };
      meta.appendChild(sel);
      card.appendChild(meta);

      card.addEventListener("dragstart", () => {
        card.classList.add("dragging");
        // Dragging suppresses normal mouseenter/mouseleave, so whatever was
        // hovered before the drag started is now stale.
        hoveredLayer = null;
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        syncOrderFromDOM();
      });
      // Reads dataset.idx live rather than closing over idx: syncOrderFromDOM
      // renumbers dataset.idx in place after a drag reorder without
      // rebuilding these cards, so a closed-over idx would keep pointing at
      // this card's original position, not its current one.
      card.addEventListener("mouseenter", () => {
        hoveredLayer = currentLayers[Number(card.dataset.idx)] ?? null;
        startPulseLoop();
      });
      card.addEventListener("mouseleave", () => {
        hoveredLayer = null;
      });
      // Selecting persists the pulse after the mouse leaves — clicking the
      // tier dropdown itself shouldn't also (re)select the card underneath.
      card.addEventListener("click", (e) => {
        if (e.target === sel) return;
        selectLayer(currentLayers[Number(card.dataset.idx)] ?? null);
      });
      layerListEl.appendChild(card);
    });
    markSelectedCard();

    layerListEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = layerListEl.querySelector<HTMLElement>(".dragging");
      if (!dragging) return;
      const after = [...layerListEl.querySelectorAll<HTMLElement>(".ld-layer-card:not(.dragging)")].find((el) => {
        const box = el.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
      });
      if (after) layerListEl.insertBefore(dragging, after);
      else layerListEl.appendChild(dragging);
    });
  }

  function selectLayer(layer: GraphicsLayer | null): void {
    selectedLayer = selectedLayer === layer ? null : layer; // click again to deselect
    markSelectedCard();
    startPulseLoop();
  }

  function markSelectedCard(): void {
    for (const el of layerListEl.querySelectorAll<HTMLElement>(".ld-layer-card")) {
      el.classList.toggle("selected", currentLayers[Number(el.dataset.idx)] === selectedLayer);
    }
  }

  function syncOrderFromDOM(): void {
    const cards = [...layerListEl.querySelectorAll<HTMLElement>(".ld-layer-card")];
    currentLayers = cards.map((el) => currentLayers[Number(el.dataset.idx)]!);
    cards.forEach((el, i) => (el.dataset.idx = String(i)));
    // Mutate the SAME graphics object mountRenderer's visualLookup already
    // holds a reference to, so the next redraw() picks up the new order
    // without remounting the renderer.
    const graphics = graphicsFor(currentName!);
    if (graphics) graphics.layers = currentLayers;
    updateOutput();
    redraw();
  }

  function spriteForLayer(layer: GraphicsLayer): Sprite | undefined {
    if (!("per" in layer)) return layer.sprites;
    if (layer.per === "heat-connection-patches") return layer.disconnected[0];
    if (layer.per === "module-slot") return layer.slots[0]?.empty;
    return layer.sprites[dirLabel(direction) as keyof typeof layer.sprites];
  }

  function layerSheetLabel(layer: GraphicsLayer): string {
    const sprite = spriteForLayer(layer);
    return sprite ? sprite.sheet.split("/").pop()! : "(no sprite for this facing)";
  }

  function dirLabel(dir: number): "north" | "east" | "south" | "west" {
    return (["north", "east", "south", "west"] as const)[Math.round(dir / 4) % 4]!;
  }

  /** Redraws every frame only while a layer card is hovered, pulsing that
   *  sprite's own silhouette at its real world position (via the live
   *  renderer's own camera, so it tracks pan/zoom) — stops itself once
   *  nothing is hovered, clearing the overlay on the way out. */
  function startPulseLoop(): void {
    if (pulseLoopRunning) return;
    pulseLoopRunning = true;
    const step = () => {
      drawHighlight();
      // The loop only needs to stop itself for the hover case — a
      // selectedLayer with no hover still pulses forever, which is exactly
      // the point (the choice stays visible after the mouse moves away),
      // so keep rAF-ing as long as either is set.
      if (hoveredLayer !== null || selectedLayer !== null) requestAnimationFrame(step);
      else pulseLoopRunning = false;
    };
    requestAnimationFrame(step);
  }

  function resizeHighlightCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasWrap.getBoundingClientRect();
    highlightCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    highlightCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  /** A sprite's own bounding box in world tiles — matches push()'s dx/dy/dw/dh
   *  math in draw/collect.ts exactly (entity is always placed at world
   *  (0,0) here, so offsetX/offsetY drop out). */
  function worldRect(sprite: Sprite): { x: number; y: number; w: number; h: number } {
    const scale = sprite.scale ?? 1;
    const w = (sprite.frameWidth * scale) / PIXELS_PER_TILE;
    const h = (sprite.frameHeight * scale) / PIXELS_PER_TILE;
    const [shiftX, shiftY] = sprite.shift ?? [0, 0];
    return { x: shiftX - w / 2, y: shiftY - h / 2, w, h };
  }

  function drawHighlight(): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = highlightCanvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = highlightCanvas.width / dpr;
    const cssH = highlightCanvas.height / dpr;
    ctx.clearRect(0, 0, cssW, cssH);
    const activeLayer = hoveredLayer ?? selectedLayer;
    if (!activeLayer || !renderer) return;

    const sprite = spriteForLayer(activeLayer);
    if (!sprite) return;
    const img = atlas.get(sprite.sheet);
    if (!img) return;

    const world = worldRect(sprite);
    const topLeft = renderer.camera.worldToScreen(world.x, world.y, cssW, cssH);
    const bottomRight = renderer.camera.worldToScreen(world.x + world.w, world.y + world.h, cssW, cssH);
    const dx = topLeft.x;
    const dy = topLeft.y;
    const dw = bottomRight.x - topLeft.x;
    const dh = bottomRight.y - topLeft.y;

    // Composited on an isolated offscreen canvas first — source-atop
    // against the live overlay would wash out whatever's already drawn
    // there (nothing, currently, but matches the technique paint.ts itself
    // uses for the placement ghost's tint, for the same reason: it must
    // follow only this sprite's own silhouette).
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(dw));
    off.height = Math.max(1, Math.round(dh));
    const octx = off.getContext("2d")!;
    octx.imageSmoothingEnabled = false;
    octx.drawImage(img, sprite.x ?? 0, sprite.y ?? 0, sprite.frameWidth, sprite.frameHeight, 0, 0, off.width, off.height);
    octx.globalCompositeOperation = "source-atop";
    octx.fillStyle = "white";
    octx.fillRect(0, 0, off.width, off.height);

    const pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 260));
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = pulse;
    ctx.drawImage(off, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  }

  /** Finds which layer a canvas click landed on: candidates are every layer
   *  whose world-space box contains the click, tested topmost-first (the
   *  reverse of paint order — layer tier, then y, then array position, the
   *  same precedence compareDrawCommands uses to decide what paints last/on
   *  top), and the first one whose actual sprite pixel there isn't
   *  transparent wins — a click on a see-through corner of a bounding box
   *  falls through to whatever's really beneath it, matching what the eye
   *  perceives as "on top" rather than just which box is biggest/frontmost. */
  function pickLayerAt(clientX: number, clientY: number): GraphicsLayer | null {
    if (!renderer) return null;
    const rect = renderer.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const world = renderer.camera.screenToWorld(cssX, cssY, rect.width, rect.height);

    const candidates = currentLayers
      .map((layer, order) => ({ layer, order, sprite: spriteForLayer(layer) }))
      .filter((c): c is { layer: GraphicsLayer; order: number; sprite: Sprite } => {
        if (!c.sprite) return false;
        const box = worldRect(c.sprite);
        return world.x >= box.x && world.x <= box.x + box.w && world.y >= box.y && world.y <= box.y + box.h;
      });
    candidates.sort((a, b) => b.layer.layer - a.layer.layer || b.order - a.order);

    for (const c of candidates) {
      const img = atlas.get(c.sprite.sheet);
      if (!img) continue;
      const box = worldRect(c.sprite);
      const localU = (world.x - box.x) / box.w;
      const localV = (world.y - box.y) / box.h;
      const px = Math.floor((c.sprite.x ?? 0) + localU * c.sprite.frameWidth);
      const py = Math.floor((c.sprite.y ?? 0) + localV * c.sprite.frameHeight);
      if (isOpaqueAt(img, c.sprite.sheet, px, py)) return c.layer;
    }
    return null;
  }

  const pixelSampleCache = new Map<string, CanvasRenderingContext2D>();
  /** `key` identifies the sheet for the cache: the atlas now hands back an
   *  ImageBitmap, which has no `src` to key on (and, unlike an <img>, exposes
   *  its size as plain width/height). */
  function isOpaqueAt(img: CanvasImageSource, key: string, px: number, py: number): boolean {
    let sampleCtx = pixelSampleCache.get(key);
    if (!sampleCtx) {
      const off = document.createElement("canvas");
      off.width = img instanceof HTMLImageElement ? img.naturalWidth : (img as ImageBitmap).width;
      off.height = img instanceof HTMLImageElement ? img.naturalHeight : (img as ImageBitmap).height;
      sampleCtx = off.getContext("2d", { willReadFrequently: true })!;
      sampleCtx.drawImage(img, 0, 0);
      pixelSampleCache.set(key, sampleCtx);
    }
    if (px < 0 || py < 0 || px >= sampleCtx.canvas.width || py >= sampleCtx.canvas.height) return false;
    return sampleCtx.getImageData(px, py, 1, 1).data[3]! > 10;
  }

  function updateOutput(): void {
    const out = currentLayers.map((l, i) => ({
      order: i,
      layerTier: LAYER_NAMES[l.layer],
      sheet: spriteForLayer(l)?.sheet,
    }));
    jsonOut.value = JSON.stringify(out, null, 1);
  }

  filterBox.addEventListener("input", () => renderEntityList(filterBox.value));
  copyBtn.addEventListener("click", () => {
    jsonOut.select();
    document.execCommand("copy");
  });

  for (const label of ["N", "E", "S", "W"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.onclick = () => {
      direction = DIR_BY_LABEL[label]!;
      renderLayerList();
      updateOutput();
      redraw();
    };
    facingEl.appendChild(btn);
  }

  window.addEventListener("resize", resizeHighlightCanvas);

  (async () => {
    await loadData();
    if (destroyed) return;
    // mountRenderer() calls container.replaceChildren(canvas) internally,
    // wiping anything already inside canvasWrap — so the highlight overlay
    // canvas has to be appended AFTER this, not templated in up front.
    renderer = mountRenderer(canvasWrap, getData(), getRenderCatalog());
    canvasWrap.appendChild(highlightCanvas);
    resizeHighlightCanvas();

    // Click-to-pick: reuses the real renderer's own click-vs-drag
    // distinction (onSelect only fires for a genuine click, never a pan
    // drag) rather than re-deriving it — this scene only ever has the one
    // placed entity, so any click getting through onSelect is a click on
    // it; the picker's own job is just figuring out which LAYER within
    // that entity's stack was actually clicked.
    // Captured on pointerdown, not pointerup: the real renderer's own
    // internal pointerup handler (registered inside mountRenderer, before
    // this listener exists at all) calls selectCallback SYNCHRONOUSLY
    // within that same pointerup dispatch — a pointerup listener added here
    // would run after it, reading this click's coordinates one click late.
    let lastClientX = 0;
    let lastClientY = 0;
    renderer.canvas.addEventListener("pointerdown", (e) => {
      lastClientX = e.clientX;
      lastClientY = e.clientY;
    });
    renderer.onSelect(() => {
      const picked = pickLayerAt(lastClientX, lastClientY);
      if (picked) {
        selectedLayer = picked;
        markSelectedCard();
        startPulseLoop();
        layerListEl.querySelector(".selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });

    recentNames = recentNames.filter((n) => entityNames().includes(n));
    renderEntityList("");
    renderRecent();
  })();

  return () => {
    destroyed = true;
    window.removeEventListener("resize", resizeHighlightCanvas);
    root.classList.remove("layer-debug-root");
    root.innerHTML = "";
  };
}
