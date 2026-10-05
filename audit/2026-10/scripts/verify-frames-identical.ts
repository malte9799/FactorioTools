/** Hashes every drawImage call over three camera positions × 130 animation
 *  frames on the four largest examples. Run before and after a renderer
 *  change; identical hashes mean an identical draw stream.
 *
 *    npx tsx audit/2026-10/scripts/verify-frames-identical.ts */
import { mount, pump, biggest } from "./harness.js";

const g = globalThis as unknown as { __h: number; __n: number; __rec: boolean };
const r = mount();
for (const { label, entities } of biggest(4)) {
  r.loadBlueprint(entities);
  pump(3);
  await new Promise((res) => setTimeout(res, 100));
  pump(3);
  r.setAnimationFrozen(true);
  g.__h = 0; g.__n = 0; g.__rec = true;
  for (let pos = 0; pos < 3; pos++) {
    r.camera.panByScreenDelta(37, 11);
    for (let f = 0; f < 130; f++) r.stepAnimationFrame(1);
  }
  g.__rec = false;
  r.setAnimationFrozen(false);
  console.log(`${label.padEnd(40)} drawImage calls ${g.__n}  hash ${(g.__h >>> 0).toString(16)}`);
}
r.destroy();
