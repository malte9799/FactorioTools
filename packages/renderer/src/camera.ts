/** Camera state: world-space center + a zoom expressed as screen pixels per
 *  world tile. Matches Factorio's own feel: smooth continuous zoom (not
 *  discrete levels), zoom-to-cursor, drag-to-pan with light momentum. */
export interface CameraState {
  /** World-space (tile) coordinates the viewport is centered on. */
  x: number;
  y: number;
  /** Screen pixels per world tile. */
  pixelsPerTile: number;
}

export interface CameraLimits {
  minPixelsPerTile: number;
  maxPixelsPerTile: number;
}

const DEFAULT_LIMITS: CameraLimits = {
  // ~6px/tile shows a couple hundred tiles across a normal viewport (a large
  // base); ~256px/tile is a tight per-entity close-up before pixel-art
  // sprites would need upscaling blur, which is undesirable for crisp
  // Factorio-style art.
  minPixelsPerTile: 6,
  maxPixelsPerTile: 256,
};

export class Camera {
  state: CameraState;
  private limits: CameraLimits;

  constructor(initial: CameraState, limits: Partial<CameraLimits> = {}) {
    this.state = { ...initial };
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private clampZoom(pixelsPerTile: number): number {
    return Math.min(this.limits.maxPixelsPerTile, Math.max(this.limits.minPixelsPerTile, pixelsPerTile));
  }

  /** Convert a screen-space point (canvas-local pixels, origin top-left) to
   *  world-space tile coordinates, given the canvas's own pixel size. */
  screenToWorld(screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
    const { x, y, pixelsPerTile } = this.state;
    return {
      x: x + (screenX - viewportWidth / 2) / pixelsPerTile,
      y: y + (screenY - viewportHeight / 2) / pixelsPerTile,
    };
  }

  worldToScreen(worldX: number, worldY: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
    const { x, y, pixelsPerTile } = this.state;
    return {
      x: viewportWidth / 2 + (worldX - x) * pixelsPerTile,
      y: viewportHeight / 2 + (worldY - y) * pixelsPerTile,
    };
  }

  /** Zoom by an exponential factor (per-wheel-tick style), keeping the given
   *  screen point fixed in world-space — the "zoom centered on cursor" feel.
   *  `factor` > 1 zooms in, < 1 zooms out. */
  zoomAt(factor: number, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): void {
    const before = this.screenToWorld(screenX, screenY, viewportWidth, viewportHeight);
    this.state.pixelsPerTile = this.clampZoom(this.state.pixelsPerTile * factor);
    const after = this.screenToWorld(screenX, screenY, viewportWidth, viewportHeight);
    // Shift the camera by exactly the world-space drift so `before` lands
    // back under the cursor after the zoom.
    this.state.x += before.x - after.x;
    this.state.y += before.y - after.y;
  }

  /** Pan by a screen-space pixel delta (e.g. pointer movement since last
   *  frame). Scaling by 1/pixelsPerTile keeps the drag speed 1:1 with the
   *  cursor regardless of zoom level. */
  panByScreenDelta(dxScreen: number, dyScreen: number): void {
    this.state.x -= dxScreen / this.state.pixelsPerTile;
    this.state.y -= dyScreen / this.state.pixelsPerTile;
  }

  /** Frame a world-space bounding box (e.g. "fit the whole blueprint"),
   *  leaving `paddingTiles` of breathing room on each side. */
  frame(box: { minX: number; minY: number; maxX: number; maxY: number }, viewportWidth: number, viewportHeight: number, paddingTiles = 4): void {
    const w = box.maxX - box.minX + paddingTiles * 2;
    const h = box.maxY - box.minY + paddingTiles * 2;
    this.state.x = (box.minX + box.maxX) / 2;
    this.state.y = (box.minY + box.maxY) / 2;
    this.state.pixelsPerTile = this.clampZoom(Math.min(viewportWidth / w, viewportHeight / h));
  }
}

/** Rolling-average velocity from recent pointer samples, decayed each frame
 *  after release — a cheap "momentum scroll" that reads as game-like without
 *  a physics library. Velocity is in screen pixels/ms. */
export class PanMomentum {
  private samples: { t: number; dx: number; dy: number }[] = [];
  private velocity = { x: 0, y: 0 };
  private readonly sampleWindowMs = 100;
  private readonly decayPerSecond = 0.92 ** 60; // matches the plan's "0.92 per frame at 60fps" feel

  recordDelta(dx: number, dy: number, now: number): void {
    this.samples.push({ t: now, dx, dy });
    const cutoff = now - this.sampleWindowMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  /** Call on pointerup: derive a launch velocity from the recent samples. */
  release(now: number): void {
    const cutoff = now - this.sampleWindowMs;
    let dx = 0;
    let dy = 0;
    let span = 0;
    for (const s of this.samples) {
      if (s.t < cutoff) continue;
      dx += s.dx;
      dy += s.dy;
    }
    span = Math.max(1, (this.samples.at(-1)?.t ?? now) - (this.samples[0]?.t ?? now));
    this.velocity = { x: dx / span, y: dy / span };
    this.samples = [];
  }

  /** Advance momentum by `dtMs`, returning the screen-space delta to apply
   *  this frame. Stops (returns null) once velocity decays below a
   *  negligible threshold. */
  step(dtMs: number): { dx: number; dy: number } | null {
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    if (speed < 0.01) return null;
    const dx = this.velocity.x * dtMs;
    const dy = this.velocity.y * dtMs;
    const decay = Math.pow(this.decayPerSecond, dtMs / 1000);
    this.velocity.x *= decay;
    this.velocity.y *= decay;
    return { dx, dy };
  }

  stop(): void {
    this.velocity = { x: 0, y: 0 };
    this.samples = [];
  }
}
