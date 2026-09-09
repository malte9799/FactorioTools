/** Camera state: world-space center + a zoom expressed as screen pixels per
 *  world tile. Matches Factorio's own feel: smooth continuous zoom (not
 *  discrete levels), zoom-to-cursor, drag-to-pan with no momentum — panning
 *  stops the instant the pointer is released. */
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
  private onChange: (() => void) | null = null;

  constructor(initial: CameraState, limits: Partial<CameraLimits> = {}) {
    this.state = { ...initial };
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Called whenever the camera actually moves or zooms. The renderer uses
   *  this to mark the frame dirty: making the camera announce its own changes
   *  is what keeps every pan/zoom/pinch/frame call site from having to
   *  remember to do it, which is exactly the kind of thing that gets missed
   *  when a new gesture is added later. */
  setOnChange(callback: (() => void) | null): void {
    this.onChange = callback;
  }

  private changed(): void {
    this.onChange?.();
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
    this.changed();
  }

  /** Pan by a screen-space pixel delta (e.g. pointer movement since last
   *  frame). Scaling by 1/pixelsPerTile keeps the drag speed 1:1 with the
   *  cursor regardless of zoom level. */
  panByScreenDelta(dxScreen: number, dyScreen: number): void {
    if (dxScreen === 0 && dyScreen === 0) return;
    this.state.x -= dxScreen / this.state.pixelsPerTile;
    this.state.y -= dyScreen / this.state.pixelsPerTile;
    this.changed();
  }

  /** Frame a world-space bounding box (e.g. "fit the whole blueprint"),
   *  leaving `paddingTiles` of breathing room on each side. */
  frame(box: { minX: number; minY: number; maxX: number; maxY: number }, viewportWidth: number, viewportHeight: number, paddingTiles = 4): void {
    const w = box.maxX - box.minX + paddingTiles * 2;
    const h = box.maxY - box.minY + paddingTiles * 2;
    this.state.x = (box.minX + box.maxX) / 2;
    this.state.y = (box.minY + box.maxY) / 2;
    this.state.pixelsPerTile = this.clampZoom(Math.min(viewportWidth / w, viewportHeight / h));
    this.changed();
  }
}

