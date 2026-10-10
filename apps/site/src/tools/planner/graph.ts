/** The production chain as a flow diagram: raw resources on the left, the
 *  targets on the right, one card per recipe and a band per item flow whose
 *  width follows its rate. Laid out in columns by distance from the targets,
 *  ordered to keep bands from crossing, then relaxed towards their
 *  neighbours the way a Sankey diagram is. */

import type { PlanFlow, PlanResult, PlanStep, PlannerData } from "@factoriotools/engine";
import { escapeHtml } from "../blueprint-editor/html.js";
import { fmtBelts, fmtMachines, fmtRate, UNIT_LABEL } from "./format.js";
import { itemColor, recipeIcon, sprite } from "./sprites.js";
import type { TimeUnit } from "./state.js";

type NodeKind = "step" | "target" | "import" | "surplus";

interface GNode {
  id: string;
  kind: NodeKind;
  step?: PlanStep;
  item: string;
  rate: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ins: GEdge[];
  outs: GEdge[];
  order: number;
}

interface GEdge {
  flow: PlanFlow;
  from: GNode;
  to: GNode;
  w: number;
  sy: number;
  ty: number;
}

const NODE_W = 176;
const SMALL_W = 140;
const COL_GAP = 152;
const ROW_GAP = 30;
const MIN_H = 78;
const MAX_BAND = 40;
/** Height of an output label, for spacing them apart. */
const PORT_H = 23;

/** The belt the diagram measures item flows in. */
export interface BeltMeasure {
  name: string;
  label: string;
  /** Items per second on a full belt. */
  throughput: number;
}

export interface GraphHandlers {
  onSelect(id: string | null): void;
}

export class FlowGraph {
  readonly el: HTMLElement;
  private viewport: HTMLElement;
  private svg: SVGSVGElement;
  private nodesLayer: HTMLElement;
  private tx = 0;
  private ty = 0;
  private k = 1;
  private bounds = { w: 0, h: 0 };
  private nodes = new Map<string, GNode>();
  private edges: GEdge[] = [];
  private selected: string | null = null;
  private layoutKey = "";
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  private pinchStart: { d: number; k: number; cx: number; cy: number; tx: number; ty: number } | null = null;

  constructor(private handlers: GraphHandlers) {
    this.el = document.createElement("div");
    this.el.className = "pl-graph";
    this.el.innerHTML = `
      <div class="pl-graph-viewport">
        <svg class="pl-graph-edges" xmlns="http://www.w3.org/2000/svg"></svg>
        <div class="pl-graph-nodes"></div>
      </div>
      <div class="pl-graph-controls" role="toolbar" aria-label="Diagram view">
        <button type="button" data-zoom="in" aria-label="Zoom in" data-tip="Zoom in">+</button>
        <button type="button" data-zoom="out" aria-label="Zoom out" data-tip="Zoom out">−</button>
        <button type="button" data-zoom="fit" aria-label="Fit to screen" data-tip="Fit to screen">⤢</button>
        <button type="button" data-zoom="anim" aria-label="Animate flows" data-tip="Animate flows" class="is-on">≋</button>
      </div>`;
    this.viewport = this.el.querySelector(".pl-graph-viewport")!;
    this.svg = this.el.querySelector("svg")!;
    this.nodesLayer = this.el.querySelector(".pl-graph-nodes")!;
    try {
      if (localStorage.getItem("factoriotools.planner.anim") === "off") this.setAnimated(false);
    } catch {
      /* storage blocked */
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.setAnimated(false);
    this.bindInput();
  }

  private setAnimated(on: boolean): void {
    this.el.classList.toggle("is-still", !on);
    this.el.querySelector('[data-zoom="anim"]')?.classList.toggle("is-on", on);
  }

  private bindInput(): void {
    this.el.querySelector(".pl-graph-controls")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      const r = this.el.getBoundingClientRect();
      if (b.dataset.zoom === "in") this.zoomAt(r.width / 2, r.height / 2, 1.25);
      else if (b.dataset.zoom === "out") this.zoomAt(r.width / 2, r.height / 2, 0.8);
      else if (b.dataset.zoom === "fit") this.fit();
      else if (b.dataset.zoom === "anim") {
        const on = this.el.classList.contains("is-still");
        this.setAnimated(on);
        try {
          localStorage.setItem("factoriotools.planner.anim", on ? "on" : "off");
        } catch {
          /* storage blocked */
        }
      }
    });

    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });

    this.el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".pl-graph-controls")) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.dragStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const r = this.el.getBoundingClientRect();
        this.pinchStart = {
          d: Math.hypot(a.x - b.x, a.y - b.y),
          k: this.k,
          cx: (a.x + b.x) / 2 - r.left,
          cy: (a.y + b.y) / 2 - r.top,
          tx: this.tx,
          ty: this.ty,
        };
        this.dragStart = null;
      }
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinchStart && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const k = clamp(this.pinchStart.k * Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStart.d, 0.08, 3);
        const p = this.pinchStart;
        this.k = k;
        this.tx = p.cx - (p.cx - p.tx) * (k / p.k);
        this.ty = p.cy - (p.cy - p.ty) * (k / p.k);
        this.apply();
        return;
      }
      const d = this.dragStart;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        this.el.setPointerCapture(e.pointerId);
        this.el.classList.add("is-panning");
      }
      this.tx = d.tx + dx;
      this.ty = d.ty + dy;
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
      const d = this.dragStart;
      this.dragStart = null;
      this.el.classList.remove("is-panning");
      if (e.type === "pointerup" && d && !d.moved) {
        const node = (e.target as HTMLElement).closest<HTMLElement>(".pl-node, .pl-port");
        this.handlers.onSelect(node?.dataset.id ?? node?.dataset.node ?? null);
      }
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
    this.el.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest(".pl-node, .pl-graph-controls")) this.fit();
    });

    // Hovering a card lights its own bands and dims the rest.
    this.el.addEventListener("pointerover", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>(".pl-node");
      this.focus(node?.dataset.id ?? this.selected);
    });
    this.el.addEventListener("pointerleave", () => this.focus(this.selected));
  }

  private zoomAt(x: number, y: number, factor: number): void {
    const k = clamp(this.k * factor, 0.08, 3);
    this.tx = x - (x - this.tx) * (k / this.k);
    this.ty = y - (y - this.ty) * (k / this.k);
    this.k = k;
    this.apply();
  }

  private apply(): void {
    this.viewport.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
    this.el.classList.toggle("is-far", this.k < 0.45);
  }

  fit(): void {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !this.bounds.w) return;
    const pad = 48;
    const whole = Math.min((r.width - pad * 2) / this.bounds.w, (r.height - pad * 2 - 40) / this.bounds.h);
    // Past a point the cards are unreadable; then show the output end at a
    // usable size and let the rest be panned to.
    const k = clamp(whole, 0.28, 1.15);
    this.k = k;
    this.tx = whole < k ? r.width - pad - this.bounds.w * k : (r.width - this.bounds.w * k) / 2;
    this.ty = Math.max(pad, (r.height - this.bounds.h * k) / 2);
    this.apply();
  }

  select(id: string | null): void {
    this.selected = id;
    for (const el of this.nodesLayer.querySelectorAll<HTMLElement>(".pl-node")) el.classList.toggle("is-selected", el.dataset.id === id);
    this.focus(id);
  }

  private focus(id: string | null): void {
    const node = id ? this.nodes.get(id) : undefined;
    this.el.classList.toggle("is-focus", !!node);
    const hot = new Set<GEdge>(node ? [...node.ins, ...node.outs] : []);
    const near = new Set<string>();
    for (const e of hot) {
      near.add(e.from.id);
      near.add(e.to.id);
    }
    this.edges.forEach((e, i) => {
      const on = hot.has(e);
      this.svg.querySelectorAll(`[data-edge="${i}"]`).forEach((p) => p.classList.toggle("is-hot", on));
    });
    for (const el of this.nodesLayer.querySelectorAll<HTMLElement>(".pl-node, .pl-port")) {
      el.classList.toggle("is-near", near.has(el.dataset.id ?? el.dataset.node ?? ""));
    }
  }

  render(pd: PlannerData, result: PlanResult, unit: TimeUnit, belt: BeltMeasure): void {
    this.build(result);
    this.layout();
    this.draw(pd, unit, belt);
    const key = [...this.nodes.keys()].sort().join("|");
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      requestAnimationFrame(() => this.fit());
    }
    this.select(this.selected && this.nodes.has(this.selected) ? this.selected : null);
  }

  private build(result: PlanResult): void {
    this.nodes.clear();
    this.edges = [];
    const add = (n: Omit<GNode, "x" | "y" | "w" | "h" | "ins" | "outs" | "order">) => {
      const node: GNode = { ...n, x: 0, y: 0, w: n.kind === "step" || n.kind === "target" ? NODE_W : SMALL_W, h: MIN_H, ins: [], outs: [], order: 0 };
      this.nodes.set(n.id, node);
      return node;
    };
    for (const s of result.steps) {
      const main = s.outputs.find((o) => o.item === s.item) ?? s.outputs[0];
      add({ id: s.id, kind: "step", step: s, item: s.item, rate: main?.rate ?? 0, col: s.depth });
    }
    for (const t of result.targets) add({ id: `target:${t.item}`, kind: "target", item: t.item, rate: t.rate, col: 0 });
    for (const f of result.flows) {
      for (const id of [f.from, f.to]) {
        if (this.nodes.has(id)) continue;
        const [kind, item] = id.split(/:(.*)/s) as [NodeKind, string];
        add({ id, kind, item, rate: 0, col: 0 });
      }
    }
    for (const f of result.flows) {
      const from = this.nodes.get(f.from)!;
      const to = this.nodes.get(f.to)!;
      const edge: GEdge = { flow: f, from, to, w: 0, sy: 0, ty: 0 };
      from.outs.push(edge);
      to.ins.push(edge);
      this.edges.push(edge);
      if (from.kind === "import") from.rate += f.rate;
      if (to.kind === "surplus") to.rate += f.rate;
    }
    // Columns count from the right: targets 0, then each step's depth.
    // Leftovers sit just right of what makes them, imports just left of the
    // first thing that uses them.
    for (const n of this.nodes.values()) {
      if (n.kind === "surplus") n.col = Math.max(0, Math.min(...n.ins.map((e) => e.from.col)) - 1);
      if (n.kind === "import") n.col = Math.max(...n.outs.map((e) => e.to.col), 0) + 1;
    }
    let maxCol = 0;
    for (const n of this.nodes.values()) maxCol = Math.max(maxCol, n.col);
    for (const n of this.nodes.values()) n.col = maxCol - n.col;
  }

  private layout(): void {
    const vis = (e: GEdge) => e.flow.rate * (isFluid(e.flow.item) ? 0.1 : 1);
    const maxVis = Math.max(1e-9, ...this.edges.map(vis));
    // Width grows slower than rate, so a trickle of acid is still a visible
    // band next to a river of ore.
    const kw = MAX_BAND / Math.pow(maxVis, 0.6);
    for (const e of this.edges) e.w = clamp(kw * Math.pow(vis(e), 0.6), 2.5, MAX_BAND);

    const columns: GNode[][] = [];
    for (const n of this.nodes.values()) {
      const minH = n.kind === "step" || n.kind === "target" ? MIN_H : 58;
      const ins = n.ins.reduce((s, e) => s + e.w, 0) + Math.max(0, n.ins.length - 1) * 2;
      const outs = n.outs.reduce((s, e) => s + e.w, 0) + Math.max(0, n.outs.length - 1) * 2;
      n.h = Math.max(minH, ins + 16, outs + 16);
      n.x = n.col * (NODE_W + COL_GAP) + (NODE_W - n.w) / 2 * (n.kind === "surplus" || n.kind === "import" ? 1 : 0);
      (columns[n.col] ??= []).push(n);
    }
    for (const col of columns) col?.sort((a, b) => b.rate - a.rate);

    // Order each column by where its neighbours sit, sweeping both ways.
    const centre = (n: GNode) => n.y + n.h / 2;
    const stack = (col: GNode[]) => {
      let y = 0;
      col.forEach((n, i) => {
        n.order = i;
        n.y = y;
        y += n.h + ROW_GAP;
      });
    };
    columns.forEach((c) => c && stack(c));
    for (let pass = 0; pass < 6; pass++) {
      const forward = pass % 2 === 0;
      const order = forward ? columns : [...columns].reverse();
      for (const col of order) {
        if (!col) continue;
        const bary = (n: GNode) => {
          const links = forward ? n.ins : n.outs;
          const other = forward ? (e: GEdge) => e.from : (e: GEdge) => e.to;
          let sum = 0, w = 0;
          for (const e of links) {
            sum += centre(other(e)) * e.w;
            w += e.w;
          }
          return w ? sum / w : centre(n);
        };
        const keyed = col.map((n) => [n, bary(n)] as const);
        keyed.sort((a, b) => a[1] - b[1]);
        col.splice(0, col.length, ...keyed.map(([n]) => n));
        stack(col);
      }
    }

    // Relax: pull each card towards the bands it is tied to, then push
    // overlapping cards apart without changing their order.
    const resolve = (col: GNode[]) => {
      let y = -Infinity;
      for (const n of col) {
        if (n.y < y) n.y = y;
        y = n.y + n.h + ROW_GAP;
      }
    };
    for (let iter = 0; iter < 24; iter++) {
      const alpha = 0.5 * (1 - iter / 24);
      for (const col of columns) {
        if (!col) continue;
        for (const n of col) {
          let sum = 0, w = 0;
          for (const e of n.ins) {
            sum += centre(e.from) * e.w;
            w += e.w;
          }
          for (const e of n.outs) {
            sum += centre(e.to) * e.w;
            w += e.w;
          }
          if (w) n.y += (sum / w - centre(n)) * alpha;
        }
        col.sort((a, b) => a.y - b.y);
        resolve(col);
      }
    }
    let minY = Infinity, maxY = -Infinity, maxX = 0;
    for (const n of this.nodes.values()) {
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + n.h);
      maxX = Math.max(maxX, n.x + n.w);
    }
    for (const n of this.nodes.values()) n.y -= minY;
    this.bounds = { w: maxX + 90, h: maxY - minY };

    // Where each band leaves and enters its cards.
    for (const n of this.nodes.values()) {
      const outs = [...n.outs].sort((a, b) => outGroup(n, a) - outGroup(n, b) || centre(a.to) - centre(b.to));
      let total = outs.reduce((s, e) => s + e.w, 0) + Math.max(0, outs.length - 1) * 2;
      let y = n.y + (n.h - total) / 2;
      for (const e of outs) {
        e.sy = y + e.w / 2;
        y += e.w + 2;
      }
      const ins = [...n.ins].sort((a, b) => centre(a.from) - centre(b.from));
      total = ins.reduce((s, e) => s + e.w, 0) + Math.max(0, ins.length - 1) * 2;
      y = n.y + (n.h - total) / 2;
      for (const e of ins) {
        e.ty = y + e.w / 2;
        y += e.w + 2;
      }
    }
  }

  private draw(pd: PlannerData, unit: TimeUnit, belt: BeltMeasure): void {
    const fluid = (item: string) => pd.items[item]?.kind === "fluid";
    const beltSub = (item: string, rate: number) =>
      fluid(item) ? "" : ` · ${fmtBelts(rate / belt.throughput)} ${belt.label.toLowerCase()}${rate / belt.throughput === 1 ? "" : "s"}`;
    const { w, h } = this.bounds;
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    let paths = "";
    this.edges.forEach((e, i) => {
      const sx = e.from.x + e.from.w;
      const tx = e.to.x;
      const d = tx > sx ? curve(sx, e.sy, tx, e.ty) : loop(sx, e.sy, tx, e.ty, Math.max(e.from.y + e.from.h, e.to.y + e.to.h) + 40 + i % 5 * 8);
      const color = itemColor(e.flow.item);
      const label = `${pd.items[e.flow.item]?.label ?? e.flow.item}`;
      const sub = `${fmtRate(e.flow.rate, unit)}${UNIT_LABEL[unit]}${beltSub(e.flow.item, e.flow.rate)}`;
      paths += `<path class="pl-band" data-edge="${i}" d="${d}" stroke="${color}" stroke-width="${e.w.toFixed(1)}" data-tip="${escapeHtml(label)}" data-tip-sub="${escapeHtml(sub)}" data-tip-icon="${escapeHtml(e.flow.item)}"/>`;
      paths += `<path class="pl-flowline" data-edge="${i}" d="${d}" stroke-width="${Math.max(1, Math.min(3, e.w / 5)).toFixed(1)}" style="animation-duration:${(1.6 + 2.4 / Math.sqrt(1 + e.flow.rate)).toFixed(2)}s"/>`;
    });
    this.svg.innerHTML = paths;

    let html = "";
    for (const n of this.nodes.values()) {
      html += nodeHtml(pd, n, unit);
      // One label per item a card sends out, at the middle of its bands.
      const groups = new Map<string, GEdge[]>();
      for (const e of n.outs) {
        if (!groups.has(e.flow.item)) groups.set(e.flow.item, []);
        groups.get(e.flow.item)!.push(e);
      }
      const ports = [...groups].map(([item, list]) => {
        const top = Math.min(...list.map((e) => e.sy - e.w / 2));
        const bottom = Math.max(...list.map((e) => e.sy + e.w / 2));
        return { item, y: (top + bottom) / 2, rate: list.reduce((s, e) => s + e.flow.rate, 0) };
      });
      // Thin bands from a multi-product card (a refinery) sit closer than a
      // label is tall: spread the labels, keeping the group centred.
      ports.sort((a, b) => a.y - b.y);
      const mean = ports.reduce((s, p) => s + p.y, 0) / (ports.length || 1);
      for (let i = 1; i < ports.length; i++) ports[i]!.y = Math.max(ports[i]!.y, ports[i - 1]!.y + PORT_H);
      const shift = mean - ports.reduce((s, p) => s + p.y, 0) / (ports.length || 1);
      for (const p of ports) {
        // Solids also read in belts of the chosen tier; more than one full
        // belt is called out, since that is where a line has to split.
        const belts = p.rate / belt.throughput;
        const beltTag = fluid(p.item)
          ? ""
          : `<span class="pl-port-belt${belts > 1 + 1e-9 ? " is-over" : ""}">${sprite(belt.name, 16)}${fmtBelts(belts)}</span>`;
        html += `<div class="pl-port" data-node="${escapeHtml(n.id)}" style="left:${n.x + n.w + 6}px;top:${p.y + shift}px;--c:${itemColor(p.item)}" data-tip="${escapeHtml(pd.items[p.item]?.label ?? p.item)}" data-tip-sub="${escapeHtml(fmtRate(p.rate, unit) + UNIT_LABEL[unit] + beltSub(p.item, p.rate))}" data-tip-icon="${escapeHtml(p.item)}">${sprite(p.item, 18)}<span>${fmtRate(p.rate, unit)}</span>${beltTag}</div>`;
      }
    }
    this.nodesLayer.innerHTML = html;
    this.nodesLayer.style.width = `${w}px`;
    this.nodesLayer.style.height = `${h}px`;
  }
}

/** Sorts a card's outgoing bands so each item's bands sit together. */
function outGroup(n: GNode, e: GEdge): number {
  const items = [...new Set(n.outs.map((o) => o.flow.item))];
  return items.indexOf(e.flow.item) * 1e6;
}

function curve(sx: number, sy: number, tx: number, ty: number): string {
  const mx = (tx - sx) * 0.5;
  return `M${sx.toFixed(1)},${sy.toFixed(1)} C${(sx + mx).toFixed(1)},${sy.toFixed(1)} ${(tx - mx).toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`;
}

/** A band that runs backwards (a loop in the chain) dips under both cards. */
function loop(sx: number, sy: number, tx: number, ty: number, below: number): string {
  const r = 60;
  return `M${sx},${sy} C${sx + r},${sy} ${sx + r},${below} ${sx},${below} L${tx},${below} C${tx - r},${below} ${tx - r},${ty} ${tx},${ty}`;
}

let fluidCheck: (item: string) => boolean = () => false;
export function setFluidCheck(fn: (item: string) => boolean): void {
  fluidCheck = fn;
}
function isFluid(item: string): boolean {
  return fluidCheck(item);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function nodeHtml(pd: PlannerData, n: GNode, unit: TimeUnit): string {
  const label = escapeHtml(pd.items[n.item]?.label ?? n.item);
  const style = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--c:${itemColor(n.item)}`;
  const rate = `${fmtRate(n.rate, unit)}<small>${UNIT_LABEL[unit]}</small>`;
  if (n.kind === "target") {
    return `<div class="pl-node is-target" data-id="${escapeHtml(n.id)}" style="${style}" data-tip="${label}" data-tip-sub="Target">
      <span class="pl-node-tag">Output</span>
      <div class="pl-node-main">${sprite(n.item, 44, "pl-node-icon")}<div class="pl-node-info"><div class="pl-node-rate is-big">${rate}</div><div class="pl-node-name">${label}</div></div></div>
    </div>`;
  }
  if (n.kind === "surplus" || n.kind === "import") {
    const tag = n.kind === "surplus" ? "Leftover" : "Import";
    return `<div class="pl-node is-${n.kind}" data-id="${escapeHtml(n.id)}" style="${style}" data-tip="${label}" data-tip-sub="${tag}">
      <span class="pl-node-tag">${tag}</span>
      <div class="pl-node-main">${sprite(n.item, 32, "pl-node-icon")}<div class="pl-node-info"><div class="pl-node-rate">${rate}</div></div></div>
    </div>`;
  }
  const s = n.step!;
  const kind = s.recipe.kind;
  const whole = Math.ceil(s.machines - 1e-6);
  const machine = s.machine
    ? `<div class="pl-node-machine" data-tip="${escapeHtml(s.machine.label)}" data-tip-sub="${escapeHtml(`${fmtMachines(s.machines)} needed, build ${whole}`)}">${sprite(s.machine.icon, 22)}<b>×${fmtMachines(s.machines)}</b></div>`
    : `<div class="pl-node-machine is-none">${kind === "spoil" ? "spoils" : "no machine"}</div>`;
  const mods = s.modules.length || s.beacons
    ? `<div class="pl-node-mods">${compressModules(s.modules).map(([m, c]) => `${sprite(m, 14)}${c > 1 ? `<i>${c}</i>` : ""}`).join("")}${s.beacons && s.beaconModule ? `<span class="pl-node-beacon">${sprite("beacon", 14)}<i>${s.beacons}</i>${sprite(s.beaconModule, 12)}</span>` : ""}</div>`
    : "";
  const util = s.machine && whole > 0 ? s.machines / whole : 0;
  return `<div class="pl-node is-step kind-${kind}" data-id="${escapeHtml(n.id)}" style="${style}">
    <div class="pl-node-main">${sprite(recipeIcon(s.recipe), 40, "pl-node-icon")}<div class="pl-node-info">${machine}<div class="pl-node-rate">${rate}</div></div></div>
    ${mods}
    ${s.machine ? `<div class="pl-node-bar" data-tip="${escapeHtml(`${Math.round(util * 100)}% of ${whole} machine${whole === 1 ? "" : "s"} busy`)}"><i style="width:${(util * 100).toFixed(1)}%"></i></div>` : ""}
  </div>`;
}

export function compressModules(modules: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (const m of modules) {
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}
