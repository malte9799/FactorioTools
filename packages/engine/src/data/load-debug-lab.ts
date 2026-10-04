/** The renderer debug lab's blueprint string (see debug-lab.ts), loaded on
 *  demand: at ~44 kB of deflated base64 it is too big to ship in the main
 *  bundle for a fixture only developers open, so a bundler splits it into
 *  its own chunk. Scripts that want it synchronously import debug-lab.ts
 *  directly. */
export async function loadDebugBlueprint(): Promise<string> {
  return (await import("./debug-lab.js")).DEBUG_BLUEPRINT;
}
