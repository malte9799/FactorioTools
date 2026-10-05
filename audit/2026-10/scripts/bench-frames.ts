/** Per-frame and per-edit renderer cost on the three largest examples.
 *
 *    npx tsx audit/2026-10/scripts/bench-frames.ts
 *
 *  Before/after the probe fix:
 *    git apply audit/2026-10/shape-memo.patch && npx tsx audit/2026-10/scripts/bench-frames.ts
 *    git apply -R audit/2026-10/shape-memo.patch */
import { mount, pump, biggest, time } from "./harness.js";

const r = mount();
for (const { label, entities } of biggest(3)) {
  r.loadBlueprint(entities);
  pump(3);
  await new Promise((res) => setTimeout(res, 100));
  pump(3);
  const animated = time(() => pump(1), 60);
  const { visibleEntities, drawCommands } = r.getDebugStats();
  r.setAnimationFrozen(true);
  pump(2);
  const idle = time(() => pump(1), 60);
  r.setAnimationFrozen(false);
  pump(2);
  // A drag pans a few screen pixels a frame: the visible set changes, so the
  // scene cache misses every frame.
  const pan = time(() => { r.camera.panByScreenDelta(6, 2); pump(1); }, 30);
  const zoom = time(() => { r.camera.zoomAt(1.02, 800, 450, 1600, 900); pump(1); }, 15);
  r.camera.zoomAt(1 / Math.pow(1.02, 18), 800, 450, 1600, 900);
  pump(2);
  // What the editor's applyEdit asks of the renderer for every placed entity.
  const edit = time(() => { r.updateEntities(entities.slice()); pump(1); }, 6);
  console.log(`${label.padEnd(40)} entities=${entities.length} visible=${visibleEntities} commands=${drawCommands}`);
  console.log(`  ms/frame: animated ${animated.toFixed(2)} · idle ${idle.toFixed(3)} · pan ${pan.toFixed(1)} · zoom ${zoom.toFixed(1)} · edit ${edit.toFixed(1)}`);
}
r.destroy();
