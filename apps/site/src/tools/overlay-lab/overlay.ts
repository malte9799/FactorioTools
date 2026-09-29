/** Draws the lab's overlay layers onto a transparent canvas stacked over the
 *  real renderer's, in the same world coordinates its camera uses. */
import type { Camera, IconAtlas } from "@factoriotools/renderer";
import { DX, DY, lanePoint, type BeltNode, type Lane, type LaneSegment, type Port } from "@factoriotools/sim";
import { machineStatus, type InserterSim, type LabFactory, type MachineSim, type MachineStatus } from "./factory.js";
import type { Issue } from "./issues.js";
import { PALETTES, type LabSettings, type Palette } from "./settings.js";

export type HoverTarget =
  | { kind: "machine"; machine: MachineSim }
  | { kind: "inserter"; inserter: InserterSim }
  | { kind: "belt"; node: BeltNode }
  | { kind: "port"; port: Port };

export interface OverlayFrame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  camera: Camera;
  factory: LabFactory;
  settings: LabSettings;
  issues: Issue[];
  hover: HoverTarget | undefined;
  icons: IconAtlas;
}

type LaneState = "flow" | "held" | "empty" | "short";

const STATUS_WORD: Record<MachineStatus, string> = {
  working: "WORKING",
  arm: "INSERTER",
  starved: "STARVED",
  output: "OUTPUT FULL",
  idle: "IDLE",
};

export function statusColor(p: Palette, s: MachineStatus): string {
  return s === "working" ? p.ok : s === "arm" ? p.warn : s === "starved" ? p.bad : s === "output" ? p.held : p.idle;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Lane-centre points along one segment (curves sampled). */
function segmentPoints(geo: { segments: LaneSegment[]; length: number }, s: LaneSegment): { x: number; y: number }[] {
  const n = s.kind === "curve" ? 6 : 1;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = lanePoint(geo, s.start + (s.length * i) / n);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

export function laneMax(node: BeltNode): number {
  return (node.speed * 60) / 64;
}

export function laneState(f: LabFactory, node: BeltNode, lane: Lane, starvedNodes: Set<BeltNode>): { state: LaneState; load: number; rate: number } {
  const { count, capacity, items } = f.belts.tileLoad(node, lane);
  const load = count / capacity;
  const rate = f.tileRate(node, lane);
  // Compare slots moved against slots that fit, so stacked belts read the same.
  const slotRate = rate / Math.max(1, count ? items / count : 1);
  const max = laneMax(node);
  if (starvedNodes.has(node) && load < 0.35) return { state: "short", load, rate };
  if (load < 0.02 && rate < 0.05) return { state: "empty", load, rate };
  if (load >= 0.75 && slotRate < 0.3 * max) return { state: "held", load, rate };
  return { state: "flow", load: Math.max(load, slotRate / max), rate };
}

export function drawOverlay(fr: OverlayFrame): void {
  const { ctx, width: w, height: h, dpr, camera, factory: f, settings: st } = fr;
  const L = st.layers;
  const S = st.style;
  const pal = PALETTES[S.palette];
  const ppt = camera.state.pixelsPerTile;
  const detail = clamp01((ppt - S.detailZoom * 0.55) / (S.detailZoom * 0.45));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (L.dim) {
    ctx.fillStyle = `rgba(16,15,14,${S.dimAmount})`;
    ctx.fillRect(0, 0, w, h);
  }

  // World space from here until labels.
  const world = () => ctx.setTransform(dpr * ppt, 0, 0, dpr * ppt, dpr * (w / 2 - camera.state.x * ppt), dpr * (h / 2 - camera.state.y * ppt));
  const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (x: number, y: number) => camera.worldToScreen(x, y, w, h);
  world();

  const view = camera.screenToWorld(0, 0, w, h);
  const viewEnd = camera.screenToWorld(w, h, w, h);
  const visible = (x: number, y: number, pad = 2) => x > view.x - pad && x < viewEnd.x + pad && y > view.y - pad && y < viewEnd.y + pad;

  const starvedNodes = new Set<BeltNode>();
  for (const issue of fr.issues) if (issue.title.includes("starved")) for (const n of issue.nodes) starvedNodes.add(n);

  const laneColor = (state: LaneState, load: number) => {
    if (state === "short") return rgba(pal.bad, 0.9);
    if (state === "held") return rgba(pal.held, 0.85);
    if (state === "empty") return "rgba(255,255,255,0.08)";
    return rgba(pal.ok, 0.3 + 0.7 * clamp01(load));
  };

  /* ---------- lanes ---------- */
  if (L.lanes) {
    ctx.lineCap = "butt";
    for (const line of f.net.lines) {
      for (const lane of [0, 1] as const) {
        const geo = line.lanes[lane];
        for (const s of geo.segments) {
          const node = s.node;
          if (!node || !visible(node.x, node.y)) continue;
          if (s.kind === "tunnel") {
            if (S.laneStyle !== "strips") continue;
            const { state, load } = laneState(f, node, lane, starvedNodes);
            ctx.strokeStyle = laneColor(state, load);
            ctx.lineWidth = Math.max(0.03, S.laneWidth * 0.35);
            ctx.setLineDash([0.18, 0.14]);
            ctx.beginPath();
            ctx.moveTo(s.from.x, s.from.y);
            ctx.lineTo(s.to.x, s.to.y);
            ctx.stroke();
            ctx.setLineDash([]);
            continue;
          }
          const { state, load } = laneState(f, node, lane, starvedNodes);
          if (S.laneHideIdle && state === "empty") continue;
          const pts = segmentPoints(geo, s);
          if (S.laneStyle === "tint") {
            if (lane === 1) continue;
            const other = laneState(f, node, 1, starvedNodes);
            const rank = (x: LaneState) => ["short", "held", "flow", "empty"].indexOf(x);
            const pick = rank(other.state) < rank(state) ? other : { state, load };
            if (S.laneHideIdle && pick.state === "empty") continue;
            ctx.fillStyle = laneColor(pick.state, pick.load).replace(/[\d.]+\)$/, (a) => `${Math.min(0.45, parseFloat(a))})`);
            ctx.fillRect(node.x + 0.06, node.y + 0.06, 0.88, 0.88);
            continue;
          }
          let offset = 0;
          if (S.laneStyle === "edges") offset = lane === 0 ? 0.17 : -0.17;
          ctx.strokeStyle = laneColor(state, load);
          ctx.lineWidth = S.laneStyle === "edges" ? Math.max(0.04, S.laneWidth * 0.5) : S.laneWidth;
          ctx.beginPath();
          pts.forEach((p, i) => {
            let x = p.x;
            let y = p.y;
            if (offset) {
              const a = pts[Math.max(0, i - 1)]!;
              const b = pts[Math.min(pts.length - 1, i + 1)]!;
              const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
              // Left normal of the travel direction (y grows downward).
              x += ((b.y - a.y) / len) * offset;
              y += (-(b.x - a.x) / len) * offset;
            }
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
      }
    }
  }

  /* ---------- items ---------- */
  if (L.items && ppt >= 7) {
    const size = 0.3;
    f.belts.forEachItem((x, y, item, hidden, count) => {
      if (hidden || !visible(x, y, 1)) return;
      // A stacked slot draws as a small pile, each copy nudged up.
      for (let k = 0; k < count; k++) {
        const yk = y - k * 0.05;
        if (S.itemStyle === "icons") {
          const icon = fr.icons.get(item);
          if (icon) {
            ctx.drawImage(icon.sheet, icon.cell.x, icon.cell.y, icon.cell.w, icon.cell.h, x - size / 2, yk - size / 2, size, size);
            continue;
          }
        }
        ctx.fillStyle = itemColor(item);
        ctx.beginPath();
        ctx.arc(x, yk, 0.08, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  /* ---------- inserter activity ---------- */
  if (L.items && ppt >= 7) {
    for (const ins of f.inserters) {
      if (!visible(ins.entity.x, ins.entity.y)) continue;
      const busyCol = ins.busy > 0.9 ? pal.warn : pal.ok;
      if (S.armStyle === "arc") {
        ctx.strokeStyle = rgba(busyCol, 0.15 + 0.7 * ins.busy);
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        ctx.moveTo(ins.pickupAt.x, ins.pickupAt.y);
        ctx.quadraticCurveTo(ins.entity.x + (ins.pickupAt.y - ins.dropAt.y) * 0.25, ins.entity.y + (ins.dropAt.x - ins.pickupAt.x) * 0.25, ins.dropAt.x, ins.dropAt.y);
        ctx.stroke();
      } else if (S.armStyle === "dot") {
        ctx.fillStyle = rgba(busyCol, 0.35 + 0.6 * ins.busy);
        ctx.beginPath();
        ctx.arc(ins.entity.x, ins.entity.y, 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
      if (ins.hand && (S.armStyle === "carry" || S.armStyle === "arc")) {
        const t = f.armProgress(ins);
        const x = ins.pickupAt.x + (ins.dropAt.x - ins.pickupAt.x) * t;
        const y = ins.pickupAt.y + (ins.dropAt.y - ins.pickupAt.y) * t;
        const icon = fr.icons.get(ins.hand);
        if (icon && S.itemStyle === "icons") ctx.drawImage(icon.sheet, icon.cell.x, icon.cell.y, icon.cell.w, icon.cell.h, x - 0.17, y - 0.17, 0.34, 0.34);
        else {
          ctx.fillStyle = itemColor(ins.hand);
          ctx.beginPath();
          ctx.arc(x, y, 0.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /* ---------- machines ---------- */
  const labels: (() => void)[] = [];
  if (L.rings) {
    for (const m of f.machines) {
      const cx = m.entity.x;
      const cy = m.entity.y;
      if (!visible(cx, cy, 4)) continue;
      const status = machineStatus(m);
      const col = statusColor(pal, status);
      const bw = m.box.right - m.box.left;
      const bh = m.box.bottom - m.box.top;
      const r = Math.min(bw, bh) / 2 - 0.28;
      const hovered = fr.hover?.kind === "machine" && fr.hover.machine === m;
      const showLabel = S.ringLabel === "always" || (S.ringLabel === "hover" && hovered);
      if (S.ringStyle === "ring") {
        ctx.lineWidth = S.ringThickness;
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(m.uptime));
        ctx.stroke();
        if (showLabel && detail > 0) {
          ctx.fillStyle = `rgba(20,19,18,${0.82 * detail})`;
          ctx.beginPath();
          ctx.arc(cx, cy, r - S.ringThickness / 2 - 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (S.ringStyle === "light") {
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 10 * dpr;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(m.box.right - 0.35, m.box.top + 0.35, 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (S.ringStyle === "bar") {
        const x0 = m.box.left + 0.3;
        const y0 = m.box.bottom - 0.42;
        const bwid = bw - 0.6;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x0, y0, bwid, S.ringThickness);
        ctx.fillStyle = col;
        ctx.fillRect(x0, y0, bwid * clamp01(m.uptime), S.ringThickness);
      } else {
        ctx.fillStyle = rgba(col, 0.28);
        ctx.fillRect(m.box.left + 0.08, m.box.top + 0.08, bw - 0.16, bh - 0.16);
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.06;
        ctx.strokeRect(m.box.left + 0.08, m.box.top + 0.08, bw - 0.16, bh - 0.16);
      }
      if (showLabel && detail > 0) {
        labels.push(() => {
          const p = toScreen(cx, cy);
          const big = Math.max(10, Math.min(28, ppt * 0.42)) * S.labelScale;
          ctx.globalAlpha = detail;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `600 ${big}px "IBM Plex Mono", monospace`;
          ctx.fillStyle = "#e6e0d8";
          const y = S.ringStyle === "ring" ? p.y - big * 0.12 : p.y;
          ctx.fillText(`${Math.round(m.uptime * 100)}%`, p.x, y);
          if ((S.ringStyle === "ring" || S.ringStyle === "fill") && big * 0.38 >= 7.5) {
            ctx.font = `600 ${big * 0.38}px "IBM Plex Mono", monospace`;
            ctx.fillStyle = col;
            ctx.fillText(STATUS_WORD[status], p.x, y + big * 0.72);
          }
          ctx.globalAlpha = 1;
          ctx.textAlign = "left";
        });
      }
    }
  }

  /* ---------- ports ---------- */
  if (L.ports) {
    for (const port of f.net.ports) {
      const node = port.line.nodes[port.kind === "input" ? 0 : port.line.nodes.length - 1];
      if (!node || !visible(port.x, port.y, 3)) continue;
      const feed = f.inputs.get(port.id);
      if (port.kind === "input" && !feed?.some(Boolean)) continue;
      const rate = f.tileRate(node, 0) + f.tileRate(node, 1);
      // A port with nothing moving through it is worth a glance only when
      // it's what the cursor is on.
      if (rate < 0.05 && !(fr.hover?.kind === "belt" && fr.hover.node === node)) continue;
      const sign = port.kind === "input" ? -1 : 1;
      const wx = port.x + 0.5 + DX[port.dir] * 0.95 * sign;
      const wy = port.y + 0.5 + DY[port.dir] * 0.95 * sign;
      const items = port.kind === "input" ? [...new Set(feed!.filter(Boolean).map((l) => l!.item))] : [];
      labels.push(() => {
        const p = toScreen(wx, wy);
        if (detail <= 0.05) {
          ctx.fillStyle = pal.accent;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
          return;
        }
        ctx.globalAlpha = detail;
        portTab(ctx, fr.icons, p.x, p.y, port.kind === "input" ? "IN" : "OUT", items, `${rate.toFixed(1)}/s`, pal.accent, S.labelScale);
        ctx.globalAlpha = 1;
      });
    }
  }

  /* ---------- hover outline ---------- */
  if (fr.hover) {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = Math.max(0.05, 2 / ppt);
    const hv = fr.hover;
    if (hv.kind === "machine") ctx.strokeRect(hv.machine.box.left, hv.machine.box.top, hv.machine.box.right - hv.machine.box.left, hv.machine.box.bottom - hv.machine.box.top);
    else if (hv.kind === "inserter") ctx.strokeRect(hv.inserter.entity.x - 0.5, hv.inserter.entity.y - 0.5, 1, 1);
    else if (hv.kind === "belt") ctx.strokeRect(hv.node.x, hv.node.y, 1, 1);
  }

  screen();
  for (const draw of labels) draw();
}

/* ---------- screen-space primitives ---------- */

function font(px: number, weight = 500) {
  return `${weight} ${Math.round(px)}px "IBM Plex Mono", ui-monospace, monospace`;
}

function pillBox(ctx: CanvasRenderingContext2D, x: number, y: number, wdt: number, h: number, border: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, wdt, h, 3);
  ctx.fillStyle = "rgba(32,31,30,0.94)";
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
}



function portTab(ctx: CanvasRenderingContext2D, icons: IconAtlas, x: number, y: number, tag: string, items: string[], rate: string, col: string, scale: number) {
  const fs = 11 * scale;
  const h = fs * 1.9;
  const iconSize = fs * 1.35;
  ctx.font = font(fs, 600);
  const tagW = ctx.measureText(tag).width;
  ctx.font = font(fs);
  const rateW = ctx.measureText(rate).width;
  const wdt = fs * 0.6 + tagW + fs * 0.5 + items.length * (iconSize + 2) + (items.length ? fs * 0.3 : 0) + rateW + fs * 0.6;
  const x0 = x - wdt / 2;
  pillBox(ctx, x0, y - h / 2, wdt, h, col);
  let cx = x0 + fs * 0.6;
  ctx.textBaseline = "middle";
  ctx.font = font(fs, 600);
  ctx.fillStyle = col;
  ctx.fillText(tag, cx, y + 0.5);
  cx += tagW + fs * 0.5;
  for (const item of items) {
    const icon = icons.get(item);
    if (icon) ctx.drawImage(icon.sheet, icon.cell.x, icon.cell.y, icon.cell.w, icon.cell.h, cx, y - iconSize / 2, iconSize, iconSize);
    else {
      ctx.fillStyle = itemColor(item);
      ctx.fillRect(cx + 2, y - iconSize / 2 + 2, iconSize - 4, iconSize - 4);
    }
    cx += iconSize + 2;
  }
  if (items.length) cx += fs * 0.3;
  ctx.font = font(fs);
  ctx.fillStyle = "#e6e0d8";
  ctx.fillText(rate, cx, y + 0.5);
}

const itemColors = new Map<string, string>();
export function itemColor(name: string): string {
  let c = itemColors.get(name);
  if (!c) {
    let hsh = 0;
    for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    c = `hsl(${hsh % 360} 55% 62%)`;
    itemColors.set(name, c);
  }
  return c;
}
