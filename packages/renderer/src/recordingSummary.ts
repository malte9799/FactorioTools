/** Turns a raw frame log into the numbers a person actually asks for when
 *  chasing a stutter. Kept as a pure function over FrameRecord[] rather than
 *  accumulated while recording: the recording path stays as cheap as
 *  possible, and the same summary can be recomputed over any slice of a log
 *  afterwards (e.g. "just the second where it hitched"). */
import type { FramePhases, FrameRecord, Percentiles, RebuildReason, RecordingSummary } from "./render.js";

const PHASE_NAMES: (keyof FramePhases)[] = [
  "grid", "cull", "collect", "animate", "paint", "inserters", "overlays", "ghost",
];

/** One 60 Hz vsync interval. A frame longer than this missed its slot. */
const VSYNC_MS = 1000 / 60;

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { min: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: for the small samples a recording produces, interpolating
  // between neighbours would invent values that no frame actually had.
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    min: sorted[0]!,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}

export function summariseRecording(log: readonly FrameRecord[], viewportArea = 0): RecordingSummary {
  const empty: RecordingSummary = {
    frames: 0, durationMs: 0, framesSkipped: 0,
    frameMs: percentiles([]), renderMs: percentiles([]), outsideMs: percentiles([]),
    phaseTotals: [], janky: 0, jankyMs: 0, rebuilds: [],
    framesWithMissingSprites: 0, peakDrawCommands: 0, peakVisibleEntities: 0,
    peakHeapMB: null, peakOverdraw: 0,
  };
  if (log.length === 0) return empty;

  const totals = new Map<keyof FramePhases, number>();
  const byReason = new Map<RebuildReason, number>();
  let janky = 0, jankyMs = 0, skipped = 0, missing = 0;
  let peakCmds = 0, peakVis = 0, peakHeap: number | null = null, peakOverdraw = 0;
  let renderTotal = 0;

  for (const f of log) {
    for (const phase of PHASE_NAMES) {
      totals.set(phase, (totals.get(phase) ?? 0) + f.phases[phase]);
    }
    renderTotal += f.renderMs;
    // The very first record has no previous frame to measure against, so its
    // frameMs is 0 and would otherwise count as a suspiciously fast frame.
    if (f.frameMs > VSYNC_MS) { janky++; jankyMs += f.frameMs; }
    skipped += f.skippedSince;
    if (f.paint.skipped > 0) missing++;
    if (f.drawCommands > peakCmds) peakCmds = f.drawCommands;
    if (f.visibleEntities > peakVis) peakVis = f.visibleEntities;
    if (f.heapMB !== null && (peakHeap === null || f.heapMB > peakHeap)) peakHeap = f.heapMB;
    if (viewportArea > 0) {
      const overdraw = f.paint.area / viewportArea;
      if (overdraw > peakOverdraw) peakOverdraw = overdraw;
    }
    byReason.set(f.rebuildReason, (byReason.get(f.rebuildReason) ?? 0) + 1);
  }

  const phaseTotals = PHASE_NAMES
    .map((phase) => ({
      phase,
      ms: totals.get(phase) ?? 0,
      share: renderTotal > 0 ? (totals.get(phase) ?? 0) / renderTotal : 0,
    }))
    .sort((a, b) => b.ms - a.ms);

  const rebuilds = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    frames: log.length,
    durationMs: log[log.length - 1]!.t - log[0]!.t,
    framesSkipped: skipped,
    frameMs: percentiles(log.map((f) => f.frameMs)),
    renderMs: percentiles(log.map((f) => f.renderMs)),
    outsideMs: percentiles(log.map((f) => f.outsideMs)),
    phaseTotals,
    janky,
    jankyMs,
    rebuilds,
    framesWithMissingSprites: missing,
    peakDrawCommands: peakCmds,
    peakVisibleEntities: peakVis,
    peakHeapMB: peakHeap,
    peakOverdraw,
  };
}

/** The n slowest frames, worst first — where a stutter actually lives.
 *  Ranked by frameMs (what the user feels) rather than renderMs (what we
 *  control), so a stall the browser caused still shows up. */
export function slowestFrames(log: readonly FrameRecord[], n = 10): FrameRecord[] {
  return [...log].sort((a, b) => b.frameMs - a.frameMs).slice(0, n);
}

/** Which phase dominated a single frame. */
export function worstPhase(frame: FrameRecord): keyof FramePhases {
  return PHASE_NAMES.reduce((a, b) => (frame.phases[b] > frame.phases[a] ? b : a), PHASE_NAMES[0]!);
}
