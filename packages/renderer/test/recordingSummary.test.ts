import assert from "node:assert/strict";
import { summariseRecording, slowestFrames, worstPhase } from "../src/recordingSummary.js";
import type { FramePhases, FrameRecord, RebuildReason } from "../src/render.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const noPhases = (): FramePhases => ({
  grid: 0, cull: 0, collect: 0, animate: 0, paint: 0, inserters: 0, overlays: 0, ghost: 0,
});

function frame(over: Partial<FrameRecord> & { t: number }): FrameRecord {
  return {
    frameMs: 8, renderMs: 2, outsideMs: 6,
    phases: noPhases(),
    visibleEntities: 100, drawCommands: 400,
    paint: { drawn: 400, skipped: 0, sheets: 12, area: 0, compositeSwitches: 2 },
    atlas: { ready: 50, pending: 0, decoding: 0, queued: 0 },
    sceneRebuilt: false, rebuildReason: "none" as RebuildReason,
    skippedSince: 0, heapMB: null,
    cameraX: 0, cameraY: 0, pixelsPerTile: 32,
    ...over,
  };
}

/* ---------- percentiles ---------- */

test("an empty log summarises to zeros rather than NaN", () => {
  // A panel that renders NaN is worse than one that renders nothing.
  const s = summariseRecording([]);
  assert.equal(s.frames, 0);
  assert.equal(s.frameMs.median, 0);
  assert.equal(s.frameMs.max, 0);
  assert.deepEqual(s.phaseTotals, []);
  assert.equal(s.peakHeapMB, null);
});

test("percentiles come from real frames, never interpolated", () => {
  const log = [1, 2, 3, 100].map((ms, i) => frame({ t: i * 16, frameMs: ms }));
  const s = summariseRecording(log);
  assert.equal(s.frameMs.min, 1);
  assert.equal(s.frameMs.max, 100);
  // Every reported value must be a value some frame actually had.
  const seen = new Set([1, 2, 3, 100]);
  for (const v of [s.frameMs.median, s.frameMs.p95, s.frameMs.p99]) {
    assert.ok(seen.has(v), `${v} is not a real observation`);
  }
});

test("mean is the arithmetic mean", () => {
  const log = [10, 20, 30].map((ms, i) => frame({ t: i, frameMs: ms }));
  assert.equal(summariseRecording(log).frameMs.mean, 20);
});

/* ---------- jank ---------- */

test("only frames past one vsync interval count as janky", () => {
  const log = [16.6, 16.8, 8, 40].map((ms, i) => frame({ t: i * 16, frameMs: ms }));
  const s = summariseRecording(log);
  assert.equal(s.janky, 2, "16.6 ms still made its slot; 16.8 and 40 did not");
  assert.ok(Math.abs(s.jankyMs - 56.8) < 1e-9);
});

/* ---------- phases ---------- */

test("phase totals are ranked by cost and share sums to one", () => {
  const log = [
    frame({ t: 0, renderMs: 10, phases: { ...noPhases(), paint: 8, collect: 2 } }),
    frame({ t: 16, renderMs: 10, phases: { ...noPhases(), paint: 9, cull: 1 } }),
  ];
  const s = summariseRecording(log);
  assert.equal(s.phaseTotals[0]!.phase, "paint");
  assert.equal(s.phaseTotals[0]!.ms, 17);
  const share = s.phaseTotals.reduce((a, p) => a + p.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-9, `shares summed to ${share}`);
});

test("worstPhase names the dominant phase of one frame", () => {
  const f = frame({ t: 0, phases: { ...noPhases(), collect: 1, paint: 5, cull: 2 } });
  assert.equal(worstPhase(f), "paint");
});

/* ---------- rebuild attribution ---------- */

test("rebuild reasons are counted separately", () => {
  const log: FrameRecord[] = [
    frame({ t: 0, rebuildReason: "first", sceneRebuilt: true }),
    frame({ t: 16, rebuildReason: "visibility", sceneRebuilt: true }),
    frame({ t: 32, rebuildReason: "visibility", sceneRebuilt: true }),
    frame({ t: 48 }),
  ];
  const s = summariseRecording(log);
  const byReason = Object.fromEntries(s.rebuilds.map((r) => [r.reason, r.count]));
  assert.equal(byReason["visibility"], 2);
  assert.equal(byReason["first"], 1);
  assert.equal(byReason["none"], 1);
});

/* ---------- paint tally ---------- */

test("frames that could not paint every command are flagged", () => {
  // This is what makes a paint time trustworthy or not: a frame that skipped
  // half its commands was not cheap, it was incomplete.
  const log = [
    frame({ t: 0, paint: { drawn: 100, skipped: 300, sheets: 4, area: 0, compositeSwitches: 2 } }),
    frame({ t: 16 }),
  ];
  assert.equal(summariseRecording(log).framesWithMissingSprites, 1);
});

test("overdraw is painted area over viewport area, and omitted without one", () => {
  const log = [frame({ t: 0, paint: { drawn: 1, skipped: 0, sheets: 1, area: 2_000_000, compositeSwitches: 0 } })];
  assert.equal(summariseRecording(log, 1_000_000).peakOverdraw, 2);
  // No viewport given: report 0 rather than dividing by zero.
  assert.equal(summariseRecording(log).peakOverdraw, 0);
});

/* ---------- peaks and skips ---------- */

test("peaks track the maximum, and heap stays null when unavailable", () => {
  const log = [
    frame({ t: 0, drawCommands: 400, visibleEntities: 100 }),
    frame({ t: 16, drawCommands: 1400, visibleEntities: 365 }),
  ];
  const s = summariseRecording(log);
  assert.equal(s.peakDrawCommands, 1400);
  assert.equal(s.peakVisibleEntities, 365);
  assert.equal(s.peakHeapMB, null);
});

test("heap peak is reported when the browser exposes it", () => {
  const log = [frame({ t: 0, heapMB: 120 }), frame({ t: 16, heapMB: 340 })];
  assert.equal(summariseRecording(log).peakHeapMB, 340);
});

test("skipped frames accumulate across the recording", () => {
  const log = [frame({ t: 0, skippedSince: 3 }), frame({ t: 16, skippedSince: 5 })];
  assert.equal(summariseRecording(log).framesSkipped, 8);
});

test("duration spans first to last record", () => {
  const log = [frame({ t: 100 }), frame({ t: 5100 })];
  assert.equal(summariseRecording(log).durationMs, 5000);
});

/* ---------- slowestFrames ---------- */

test("slowestFrames ranks by what the user feels, not by render time", () => {
  // A frame the browser stalled on has a small renderMs and a huge frameMs;
  // ranking by renderMs would hide exactly the stutter being chased.
  const stalled = frame({ t: 0, frameMs: 700, renderMs: 0.5 });
  const busy = frame({ t: 16, frameMs: 20, renderMs: 19 });
  const ranked = slowestFrames([busy, stalled], 2);
  assert.equal(ranked[0], stalled);
});

test("slowestFrames caps at n and leaves the input untouched", () => {
  const log = [5, 1, 9, 3].map((ms, i) => frame({ t: i, frameMs: ms }));
  const ranked = slowestFrames(log, 2);
  assert.equal(ranked.length, 2);
  assert.deepEqual(ranked.map((f) => f.frameMs), [9, 5]);
  assert.deepEqual(log.map((f) => f.frameMs), [5, 1, 9, 3], "input must not be sorted in place");
});

console.log(`\n${passed} passing`);
