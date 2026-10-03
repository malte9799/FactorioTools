/** The on-map rate calculator: runs a simulation of a blueprint and draws
 *  the overlay on a transparent canvas above the renderer's own, with a
 *  hover card and clickable port tabs. The blueprint editor and the
 *  Overlay Lab both drive one of these; each brings its own windows. */
import "./rate-overlay.css";
import { getData, getRenderCatalog, type PlacedEntity, type WireLink } from "@factoriotools/engine";
import { getSharedIconAtlas, type BlueprintRenderer } from "@factoriotools/renderer";
import type { LaneFeed } from "@factoriotools/sim";
import { hoverCardHtml } from "./card.js";
import { FULL_RESEARCH, LabFactory, type PortLimit, type Research } from "./factory.js";
import { detectIssues, type Issue } from "./issues.js";
import { drawOverlay, type HoverTarget, type PortTabRect } from "./overlay.js";
import { portEditorHtml, portTitle, replacePortHtml, wirePortList } from "./panels.js";
import { formatRate, loadSettings, saveSettings, type LabSettings } from "./settings.js";
import { makeFloatingWindow, type FloatingWindow } from "../window-manager.js";
import { SimClock } from "../sim-clock.js";

type Lanes = [LaneFeed | null, LaneFeed | null];

/** Every layer off: what the ports-only mode draws under its tabs. */
const NO_LAYERS: LabSettings["layers"] = { dim: false, lanes: false, rings: false, hover: false, items: false, ports: false, circuits: false };

/** Ticks simulated before the overlay counts as settled: a factory that
 *  has been running for a minute rather than one just switched on, so the
 *  overview's 30-second rates don't include belts still filling up. */
const WARM_TICKS = 3600;
/** Most of a frame the warm-up may take, so a big blueprint stays responsive
 *  while it catches up. */
const WARM_BUDGET_MS = 10;

const RESEARCH_KEY = "overlay-lab:research";
function loadResearch(): Research {
  try {
    const saved = JSON.parse(localStorage.getItem(RESEARCH_KEY) ?? "null") as Partial<Research> | null;
    return { ...FULL_RESEARCH, ...saved };
  } catch {
    return { ...FULL_RESEARCH };
  }
}
function saveResearch(r: Research) {
  try {
    localStorage.setItem(RESEARCH_KEY, JSON.stringify(r));
  } catch {
    // Storage blocked: the choice just won't be remembered.
  }
}

export interface RateOverlayOptions {
  /** Where the hover card lives (it's positioned in viewport coordinates).
   *  Defaults to the stage's parent. */
  cardHost?: HTMLElement;
  /** Called a couple of times a second while running, and after every
   *  rebuild, so windows can refresh their numbers. */
  onUpdate?: () => void;
  /** Called when the set of ports or their settings change. */
  onPortsChange?: () => void;
}

export class RateOverlay {
  factory: LabFactory | undefined;
  settings: LabSettings = loadSettings();
  research: Research = loadResearch();
  playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  speed = 1;
  issues: Issue[] = [];
  /** Draw port tabs even with the layer off (while a ports list is open). */
  forcePorts = false;
  /** A port to ring on the map (the one under the pointer in a list). */
  highlightPort: string | undefined;

  private renderer: BlueprintRenderer | undefined;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d")!;
  private readonly card: HTMLDivElement;
  private readonly cardBody: HTMLDivElement;
  private readonly abort = new AbortController();
  private entities: PlacedEntity[] = [];
  private wires: WireLink[] = [];
  private justLoaded: PlacedEntity[] | undefined;
  /** What the user set on ports by hand, by port id. Port ids come from
   *  tile positions, so these survive an edit to the blueprint and are laid
   *  back over the fresh guesses after every rebuild. */
  private readonly userInputs = new Map<string, Lanes>();
  private readonly userArms = new Map<string, string[]>();
  private readonly userEnabled = new Map<string, boolean>();
  private readonly userLimits = new Map<string, PortLimit>();
  private hover: HoverTarget | undefined;
  /** The port whose popup is open, if any. */
  private editingPort: string | undefined;
  private readonly portPopup: FloatingWindow;
  private readonly portPopupTitle: HTMLSpanElement;
  private readonly portPopupBody: HTMLDivElement;
  private pointer: { x: number; y: number } | undefined;
  private portTabs: PortTabRect[] = [];
  private tabDown: string | undefined;
  private warm = 0;
  private enabled = false;
  /** Port tabs alone, with the overlay itself off (alt mode's ports). */
  private portsOnly = false;
  private dirty = false;
  private rebuildTimer = 0;
  private raf = 0;
  private readonly clock = new SimClock();
  private lastUi = 0;
  private lastDraw = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly options: RateOverlayOptions = {},
  ) {
    this.canvas.className = "lab-overlay";
    this.canvas.hidden = true;
    this.card = document.createElement("div");
    this.card.className = "machine-tooltip gui-window lab-card";
    this.card.hidden = true;
    this.cardBody = document.createElement("div");
    this.cardBody.className = "gui-body";
    this.card.appendChild(this.cardBody);
    const host = options.cardHost ?? stage.parentElement ?? document.body;
    host.appendChild(this.card);

    // Clicking a port's tab on the map opens this to edit that one port.
    const popup = document.createElement("div");
    popup.className = "gui-window lab-port-popup";
    popup.hidden = true;
    popup.innerHTML = `<div class="gui-titlebar"><span></span><span class="grip" aria-hidden="true"></span></div><div class="gui-body"></div>`;
    host.appendChild(popup);
    this.portPopupTitle = popup.querySelector(".gui-titlebar span")!;
    this.portPopupBody = popup.querySelector(".gui-body")!;
    this.portPopup = makeFloatingWindow(popup, { x: 0, y: 0, width: 320, onClose: () => this.closePortPopup() });
    wirePortList(this.portPopupBody, this, this.abort.signal);
    this.listen();
  }

  /** Draw over this renderer (again after the host swaps renderers). */
  attach(renderer: BlueprintRenderer) {
    this.renderer = renderer;
    this.stage.appendChild(this.canvas);
  }

  get isEnabled() {
    return this.enabled;
  }

  /** True while the model is still catching up to a running factory. */
  get warming() {
    return this.warm > 0;
  }

  /** Running and drawing: the full overlay, or only its port tabs. */
  private get active() {
    return this.enabled || this.portsOnly || (this.altDisplays && this.hasAltDisplays);
  }

  /** Alt mode is on: draw display panels set to "Always show in Alt-mode".
   *  The model only runs for it while such a panel exists. */
  setAltDisplays(on: boolean) {
    if (on === this.altDisplays) return;
    const was = this.active;
    this.altDisplays = on;
    this.activeChanged(was);
  }

  private altDisplays = false;
  private hasAltDisplays = false;

  /** Picks up a display panel's alt-mode setting appearing or going away
   *  with an edit. */
  private checkAltDisplays() {
    const was = this.active;
    this.hasAltDisplays = this.entities.some((e) => /display-panel/.test(e.name) && e.panel?.alwaysShow);
    this.activeChanged(was);
  }

  /** Shows or hides the overlay. Hidden, nothing is simulated or drawn; an
   *  edit made meanwhile is picked up when it's shown again. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    const was = this.active;
    this.enabled = on;
    this.activeChanged(was);
  }

  /** Shows the port tabs even while the overlay is off. The model keeps
   *  running underneath, so their rates stay live. */
  setPortsOnly(on: boolean) {
    if (on === this.portsOnly) return;
    const was = this.active;
    this.portsOnly = on;
    this.activeChanged(was);
  }

  private activeChanged(was: boolean) {
    const now = this.active;
    this.canvas.hidden = !now;
    if (!this.enabled) {
      this.hover = undefined;
      this.card.hidden = true;
    }
    if (now === was) return;
    if (!now) {
      cancelAnimationFrame(this.raf);
      this.closePortPopup();
      return;
    }
    if (this.dirty || !this.factory) this.rebuild();
    this.clock.reset(performance.now());
    this.raf = requestAnimationFrame(this.frame);
  }

  /** A new blueprint: forget hand-made port settings and start over. */
  load(entities: PlacedEntity[], wires: WireLink[] = []) {
    this.entities = entities;
    this.wires = wires;
    this.userInputs.clear();
    this.userArms.clear();
    this.userEnabled.clear();
    this.userLimits.clear();
    this.closePortPopup();
    this.justLoaded = entities;
    this.dirty = true;
    this.checkAltDisplays();
    if (this.active && this.dirty) this.rebuild();
  }

  /** The same blueprint, edited: rebuild shortly, keeping port settings. */
  update(entities: PlacedEntity[], wires: WireLink[] = []) {
    // The host's usual "something changed" call right after a load.
    if (entities === this.justLoaded && wires === this.wires) {
      this.justLoaded = undefined;
      return;
    }
    this.justLoaded = undefined;
    this.entities = entities;
    this.wires = wires;
    this.checkAltDisplays();
    if (!this.active) {
      this.dirty = true;
      return;
    }
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuild(), 250);
  }

  /** Start the model again from empty belts and machines. */
  rebuild() {
    clearTimeout(this.rebuildTimer);
    this.dirty = false;
    if (!this.entities.length) {
      this.factory = undefined;
      this.issues = [];
      this.clearCanvas();
      this.options.onUpdate?.();
      this.options.onPortsChange?.();
      return;
    }
    const footprint = (name: string) => getRenderCatalog().entities[name]?.tileFootprint;
    const f = new LabFactory(getData(), this.entities, this.research, footprint, this.wires);
    const ids = new Set(f.ports().map((p) => p.id));
    for (const [id, [l, r]] of this.userInputs) if (ids.has(id)) f.setInput(id, l, r);
    for (const [id, items] of this.userArms) if (ids.has(id)) f.setArmPortItems(id, items);
    for (const [id, on] of this.userEnabled) if (ids.has(id)) f.setPortEnabled(id, on);
    for (const [id, limit] of this.userLimits) if (ids.has(id)) f.setPortLimit(id, limit);
    this.factory = f;
    if (this.editingPort && !ids.has(this.editingPort)) this.closePortPopup();
    else this.renderPortPopup();
    this.hover = undefined;
    this.issues = [];
    this.warm = WARM_TICKS;
    this.options.onUpdate?.();
    this.options.onPortsChange?.();
  }

  setResearch(next: Research) {
    this.research = next;
    saveResearch(next);
    // Hand sizes and stacking change the whole model.
    this.rebuild();
  }

  saveSettings() {
    saveSettings(this.settings);
  }

  /* ---------- ports, remembered across rebuilds ---------- */

  setPortEnabled(id: string, on: boolean) {
    this.factory?.setPortEnabled(id, on);
    this.userEnabled.set(id, on);
    this.renderPortPopup();
    this.options.onPortsChange?.();
  }

  setInput(id: string, left: LaneFeed | null, right: LaneFeed | null) {
    this.factory?.setInput(id, left, right);
    this.userInputs.set(id, [left, right]);
    this.renderPortPopup();
    this.options.onPortsChange?.();
  }

  setArmPortItems(id: string, items: string[]) {
    this.factory?.setArmPortItems(id, items);
    this.userArms.set(id, items);
    this.renderPortPopup();
    this.options.onPortsChange?.();
  }

  setPortLimit(id: string, limit: PortLimit) {
    this.factory?.setPortLimit(id, limit);
    this.userLimits.set(id, limit);
    this.renderPortPopup();
    this.options.onPortsChange?.();
  }

  /** Opens the editor for one port, beside its tab (screen pixels): to
   *  the right, or to the left where there's no room. */
  openPortPopup(id: string, tab?: { left: number; right: number; top: number }) {
    this.editingPort = id;
    this.renderPortPopup();
    if (this.portPopup.el.hidden || tab) {
      const w = this.portPopup.el.offsetWidth || 320;
      const x = !tab ? window.innerWidth / 2 - w / 2 : tab.right + 12 + w <= window.innerWidth - 8 ? tab.right + 12 : tab.left - 12 - w;
      this.portPopup.setPosition(x, tab ? tab.top - 12 : 120);
      this.portPopup.show();
    }
    this.portPopup.bringToFront();
  }

  closePortPopup() {
    this.editingPort = undefined;
    this.portPopup.hide();
    replacePortHtml(this.portPopupBody, "");
  }

  private renderPortPopup() {
    const id = this.editingPort;
    if (!id) return;
    const p = this.factory?.ports().find((q) => q.id === id);
    const html = portEditorHtml(this, id);
    if (!p || !html) return this.closePortPopup();
    if (this.portPopupTitle.textContent !== portTitle(p)) this.portPopupTitle.textContent = portTitle(p);
    replacePortHtml(this.portPopupBody, html);
  }

  /** Keeps the popup's live rate current without redrawing its fields. */
  private tickPortPopup() {
    const id = this.editingPort;
    const el = id ? this.portPopupBody.querySelector<HTMLElement>("[data-port-now]") : null;
    const p = el ? this.factory?.ports().find((q) => q.id === id) : undefined;
    const text = p && formatRate(p.rate, this.settings.style.rateUnit);
    if (el && text && el.textContent !== text) el.textContent = text;
  }

  /** Simulate ahead: a minute at a time from the Simulation controls. */
  skip(ticks: number) {
    if (!this.factory) return;
    this.factory.step(ticks);
    this.issues = detectIssues(this.factory);
    this.options.onUpdate?.();
  }

  destroy() {
    this.enabled = false;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.rebuildTimer);
    this.abort.abort();
    this.canvas.remove();
    this.card.remove();
    this.portPopup.destroy();
    this.portPopup.el.remove();
  }

  /* ---------- pointer ---------- */

  private listen() {
    const { signal } = this.abort;
    const stage = this.stage;
    const local = (e: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const tabAt = (e: MouseEvent) => {
      if (!this.active || !this.factory) return undefined;
      const { x, y } = local(e);
      return this.portTabs.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
    };
    // A port tab takes the click for itself: the host never sees it, so it
    // doesn't also select, place or pan underneath.
    stage.addEventListener("pointerdown", (e) => {
      const tab = e.button === 0 ? tabAt(e) : undefined;
      this.tabDown = tab?.id;
      if (tab) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, { signal, capture: true });
    stage.addEventListener("pointerup", (e) => {
      if (this.tabDown === undefined) return;
      e.stopPropagation();
      const tab = tabAt(e);
      if (tab && tab.id === this.tabDown) {
        const r = stage.getBoundingClientRect();
        this.openPortPopup(tab.id, { left: r.left + tab.x, right: r.left + tab.x + tab.w, top: r.top + tab.y });
      }
    }, { signal, capture: true });
    stage.addEventListener("click", (e) => {
      if (this.tabDown === undefined) return;
      this.tabDown = undefined;
      e.stopPropagation();
    }, { signal, capture: true });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.editingPort) this.closePortPopup();
    }, { signal });

    stage.addEventListener("pointermove", (e) => {
      if (!this.enabled || !this.renderer) return;
      this.pointer = { x: e.clientX, y: e.clientY };
      const { x, y } = local(e);
      const w = this.renderer.camera.screenToWorld(x, y, stage.clientWidth, stage.clientHeight);
      this.hover = e.buttons ? undefined : this.hitTest(w.x, w.y);
      this.renderCard();
    }, { signal });
    stage.addEventListener("pointerleave", () => {
      this.hover = undefined;
      this.renderCard();
    }, { signal });
  }

  private hitTest(wx: number, wy: number): HoverTarget | undefined {
    const f = this.factory;
    if (!f) return undefined;
    const m = f.machines.find((m) => wx >= m.box.left && wx < m.box.right && wy >= m.box.top && wy < m.box.bottom);
    if (m) return { kind: "machine", machine: m };
    const ins = f.inserters.find((i) => Math.abs(i.entity.x - wx) < 0.5 && Math.abs(i.entity.y - wy) < 0.5);
    if (ins) return { kind: "inserter", inserter: ins };
    const box = f.boxes.find((b) => Math.abs(b.x - wx) < 0.5 && Math.abs(b.y - wy) < 0.5);
    if (box) return { kind: "box", box };
    const node = f.net.nodeAt(Math.floor(wx), Math.floor(wy));
    if (node?.line) return { kind: "belt", node };
    // Combinators, lamps, poles…: the nearest within reach of the cursor.
    let best: HoverTarget | undefined;
    let bestD = 0.8;
    for (const e of f.circuitEntities) {
      const d = Math.max(Math.abs(e.x - wx), Math.abs(e.y - wy));
      if (d < bestD) {
        bestD = d;
        best = { kind: "circuit", entity: e };
      }
    }
    return best;
  }

  /** True while the pointer rests on something the card describes. */
  get hovering() {
    return this.enabled && this.settings.layers.hover && this.hover !== undefined;
  }

  private renderCard() {
    const card = this.card;
    const html = this.hover && this.factory ? hoverCardHtml(this.factory, this.hover, this.settings, this.issues) : "";
    if (!html || !this.settings.layers.hover || !this.pointer || !this.enabled) {
      card.hidden = true;
      return;
    }
    if (this.cardBody.innerHTML !== html) this.cardBody.innerHTML = html;
    card.hidden = false;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = this.pointer.x + 18;
    let y = this.pointer.y + 16;
    if (x + cw > window.innerWidth - 8) x = this.pointer.x - cw - 18;
    if (y + ch > window.innerHeight - 8) y = window.innerHeight - ch - 8;
    card.style.transform = `translate(${x}px, ${y}px)`;
  }

  /* ---------- loop ---------- */

  private clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.portTabs = [];
  }

  private readonly frame = (now: number) => {
    if (!this.active) return;
    const f = this.factory;
    // Same limits as the renderer underneath: its render preset caps the
    // pixel ratio and the frame rate, and the overlay follows suit.
    const quality = this.renderer?.getQuality();
    const mayDraw = !quality || now - this.lastDraw >= 1000 / quality.maxFps - 2;
    // With circuits on the map, every tick is drawn: one tick per drawn
    // frame at normal speed, so no circuit value is skipped.
    const everyTick = !!f && f.circuits.networks.length > 0;
    if (f && this.warm > 0) {
      // Catch up in slices so a big blueprint doesn't freeze the page.
      const until = performance.now() + WARM_BUDGET_MS;
      while (this.warm > 0 && performance.now() < until) {
        const n = Math.min(this.warm, 30);
        f.step(n);
        this.warm -= n;
      }
      if (this.warm === 0) {
        this.issues = detectIssues(f);
        this.options.onUpdate?.();
      }
    } else if (f && this.playing) {
      // Ticking every tick, the clock only runs on frames that are drawn;
      // the frames in between leave it alone, so their time still counts.
      if (mayDraw || !everyTick) f.step(this.clock.advance(now, this.speed, everyTick));
    } else this.clock.advance(now, 0);
    if (f && this.renderer && mayDraw) {
      this.lastDraw = now;
      const dpr = Math.min(window.devicePixelRatio || 1, quality?.maxPixelRatio ?? Infinity);
      const w = this.stage.clientWidth;
      const h = this.stage.clientHeight;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.portTabs = drawOverlay({
        ctx: this.ctx,
        width: w,
        height: h,
        dpr,
        camera: this.renderer.camera,
        factory: f,
        settings: this.enabled ? this.settings : { ...this.settings, layers: NO_LAYERS },
        issues: this.issues,
        hover: this.enabled && this.settings.layers.hover ? this.hover : undefined,
        icons: getSharedIconAtlas(),
        showPorts: this.settings.layers.ports || this.forcePorts || this.portsOnly,
        altDisplays: this.altDisplays && this.hasAltDisplays,
        highlightPort: this.highlightPort ?? this.editingPort,
      });
      // The hover card follows every drawn frame, so its signals do too;
      // it only touches the DOM when its text changed.
      if (this.hover && this.warm === 0) this.renderCard();
      if (now - this.lastUi > 400 && this.warm === 0) {
        this.lastUi = now;
        this.issues = detectIssues(f);
        this.options.onUpdate?.();
        this.tickPortPopup();
      }
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
