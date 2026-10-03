/** The on-map rate calculator: runs a simulation of a blueprint and draws
 *  the overlay on a transparent canvas above the renderer's own, with a
 *  hover card and clickable port tabs. The blueprint editor and the
 *  Overlay Lab both drive one of these; each brings its own windows. */
import "./rate-overlay.css";
import { getData, getRenderCatalog, type PlacedEntity } from "@factoriotools/engine";
import { getSharedIconAtlas, type BlueprintRenderer } from "@factoriotools/renderer";
import type { LaneFeed } from "@factoriotools/sim";
import { hoverCardHtml } from "./card.js";
import { FULL_RESEARCH, LabFactory, type Research } from "./factory.js";
import { detectIssues, type Issue } from "./issues.js";
import { drawOverlay, type HoverTarget, type PortTabRect } from "./overlay.js";
import { loadSettings, saveSettings, type LabSettings } from "./settings.js";

type Lanes = [LaneFeed | null, LaneFeed | null];

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
  private justLoaded: PlacedEntity[] | undefined;
  /** What the user set on ports by hand, by port id. Port ids come from
   *  tile positions, so these survive an edit to the blueprint and are laid
   *  back over the fresh guesses after every rebuild. */
  private readonly userInputs = new Map<string, Lanes>();
  private readonly userArms = new Map<string, string[]>();
  private readonly userEnabled = new Map<string, boolean>();
  private hover: HoverTarget | undefined;
  private pointer: { x: number; y: number } | undefined;
  private portTabs: PortTabRect[] = [];
  private tabDown: string | undefined;
  private warm = 0;
  private enabled = false;
  private dirty = false;
  private rebuildTimer = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
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
    (options.cardHost ?? stage.parentElement ?? document.body).appendChild(this.card);
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

  /** Shows or hides the overlay. Hidden, nothing is simulated or drawn; an
   *  edit made meanwhile is picked up when it's shown again. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.canvas.hidden = !on;
    if (!on) {
      cancelAnimationFrame(this.raf);
      this.hover = undefined;
      this.card.hidden = true;
      return;
    }
    if (this.dirty || !this.factory) this.rebuild();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** A new blueprint: forget hand-made port settings and start over. */
  load(entities: PlacedEntity[]) {
    this.entities = entities;
    this.userInputs.clear();
    this.userArms.clear();
    this.userEnabled.clear();
    this.justLoaded = entities;
    if (this.enabled) this.rebuild();
    else this.dirty = true;
  }

  /** The same blueprint, edited: rebuild shortly, keeping port settings. */
  update(entities: PlacedEntity[]) {
    // The host's usual "something changed" call right after a load.
    if (entities === this.justLoaded) {
      this.justLoaded = undefined;
      return;
    }
    this.justLoaded = undefined;
    this.entities = entities;
    if (!this.enabled) {
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
    const f = new LabFactory(getData(), this.entities, this.research, footprint);
    const ids = new Set(f.ports().map((p) => p.id));
    for (const [id, [l, r]] of this.userInputs) if (ids.has(id)) f.setInput(id, l, r);
    for (const [id, items] of this.userArms) if (ids.has(id)) f.setArmPortItems(id, items);
    for (const [id, on] of this.userEnabled) if (ids.has(id)) f.setPortEnabled(id, on);
    this.factory = f;
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
    this.options.onPortsChange?.();
  }

  setInput(id: string, left: LaneFeed | null, right: LaneFeed | null) {
    this.factory?.setInput(id, left, right);
    this.userInputs.set(id, [left, right]);
    this.options.onPortsChange?.();
  }

  setArmPortItems(id: string, items: string[]) {
    this.factory?.setArmPortItems(id, items);
    this.userArms.set(id, items);
    this.options.onPortsChange?.();
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
      if (!this.enabled || !this.factory) return undefined;
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
      if (tab && tab.id === this.tabDown && this.factory) this.setPortEnabled(tab.id, !this.factory.portEnabled.get(tab.id));
    }, { signal, capture: true });
    stage.addEventListener("click", (e) => {
      if (this.tabDown === undefined) return;
      this.tabDown = undefined;
      e.stopPropagation();
    }, { signal, capture: true });

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
    return undefined;
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
    if (!this.enabled) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const f = this.factory;
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
      this.acc += dt * 60 * this.speed;
      const n = Math.min(600, Math.floor(this.acc));
      this.acc -= n;
      f.step(n);
    }
    // Same limits as the renderer underneath: its render preset caps the
    // pixel ratio and the frame rate, and the overlay follows suit.
    const quality = this.renderer?.getQuality();
    const mayDraw = !quality || now - this.lastDraw >= 1000 / quality.maxFps - 2;
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
        settings: this.settings,
        issues: this.issues,
        hover: this.settings.layers.hover ? this.hover : undefined,
        icons: getSharedIconAtlas(),
        showPorts: this.settings.layers.ports || this.forcePorts,
        highlightPort: this.highlightPort,
      });
      if (now - this.lastUi > 400 && this.warm === 0) {
        this.lastUi = now;
        this.issues = detectIssues(f);
        this.options.onUpdate?.();
        this.renderCard();
      }
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
