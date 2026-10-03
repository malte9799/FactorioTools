/** Turns animation frames into game ticks for everything that shows live
 *  simulation values: the map overlay, alt mode, the entity GUI's signals.
 *
 *  Run purely by elapsed time, a frame that comes late runs two or three
 *  ticks at once and only the last is ever drawn — a circuit value that
 *  lasts one tick (a pulse, a counter's step) is skipped. With `everyTick`
 *  at normal speed the clock never runs more than one tick per frame
 *  instead: every tick is drawn, and when frames come slower than 60 a
 *  second the game slows down with them, the way the game itself drops
 *  UPS. Faster speeds can't draw every tick by definition and stay on
 *  elapsed time. */
export class SimClock {
  private last: number | undefined;
  private acc = 0;

  /** Forget the time since the last frame (after a pause). */
  reset(now: number) {
    this.last = now;
    this.acc = 0;
  }

  /** Ticks to run for a frame drawn at `now` (ms). */
  advance(now: number, speed = 1, everyTick = false): number {
    const dt = this.last === undefined ? 0 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.acc += dt * 60 * speed;
    if (everyTick && speed <= 1) {
      const n = Math.min(1, Math.floor(this.acc));
      // No backlog: time a slow frame didn't get to is dropped, not
      // caught up on later in a burst.
      this.acc = Math.min(this.acc - n, 0.999);
      return n;
    }
    const n = Math.min(600, Math.floor(this.acc));
    this.acc -= n;
    return n;
  }
}
