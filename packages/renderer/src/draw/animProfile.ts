/** Which of an entity's draw commands animate, and how: the scene cache
 *  collects a scene once at frame 0 and then only patches the sx of these
 *  commands each frame. Kept free of the DOM so it can be tested on its own. */
import type { PlacedEntity } from "@factoriotools/engine";
import { hasAnimatedLayer, type ResolvedVisual } from "../entityLookup.js";
import { collectEntity, type CollectContext } from "./collect.js";
import type { DrawCommand } from "./commands.js";

/** Upper bound on how far the scene cache probes for an animation's cycle
 *  length. Vanilla's longest belt cycle is well under this; anything that
 *  does not repeat within it is treated as non-animating and left static. */
export const MAX_ANIM_PERIOD = 256;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export interface AnimProfile {
  /** Indices into one entity's own command list, and their sx behaviour. */
  animated: number[];
  stride: number[];
  period: number[];
  /** The column index (not pixels) this command sits on at animation frame
   *  0, and how many columns its sheet row holds. sx is reconstructed as
   *  origin + ((phase0 + frame/slowdown) % columns) * stride, mirroring the
   *  `rawColumn % sprite.columns` wrap push() itself applies — a plain
   *  base + frame * stride ramp cannot express a phase-shifted sprite,
   *  because such a sprite wraps partway through its cycle rather than at
   *  the end of it. */
  phase0: number[];
  columns: number[];
  /** Columns advanced over one full period (see SceneCache.animSteps). */
  steps: number[];
  origin: number[];
  /** How many commands the probed (isolated) entity emitted. The caller
   *  compares this against what the same entity emitted in the real scene:
   *  the indices above only mean anything when the two agree. */
  commandCount: number;
  /** The frame-0 cell of each of those commands. Two entities of one type
   *  can emit the same NUMBER of commands made of different sprites (an
   *  underground entrance with or without its lane's end cap, in place of
   *  some other piece), and then the indices above point at the wrong
   *  ones; see fits(). */
  cells: Cell[];
}

/** A command's frame-0 cell: which sprite it is, before anything animates. */
interface Cell {
  sheet: string;
  sx: number;
  sy: number;
}

export const NO_ANIMATION: AnimProfile = { animated: [], stride: [], period: [], phase0: [], columns: [], steps: [], origin: [], commandCount: -1, cells: [] };

const cellOf = (c: DrawCommand): Cell => ({ sheet: c.sheet, sx: c.sx, sy: c.sy });

/** True when `profile` describes exactly the commands `commands[start..]`:
 *  as many of them, drawing the same cells at frame 0. */
function fits(profile: AnimProfile, commands: DrawCommand[], start: number): boolean {
  if (profile.commandCount !== commands.length - start) return false;
  for (let i = 0; i < profile.cells.length; i++) {
    const cell = profile.cells[i]!;
    const c = commands[start + i]!;
    if (c.sheet !== cell.sheet || c.sx !== cell.sx || c.sy !== cell.sy) return false;
  }
  return true;
}

/** One sprite's animation as probe() measured it. */
interface SpriteAnimation {
  stride: number;
  period: number;
  phase0: number;
  columns: number;
  steps: number;
  origin: number;
}

/** What an entity's animation profile is shared across. Direction matters:
 *  the same entity facing two ways can lay its frames out differently, and
 *  turbo belts offset alternate tiles by parity. So does an underground's
 *  end: entrance and exit keep opposite halves of the belt frame, so their
 *  lane's frame origin differs by half a frame. */
function profileKey(entity: PlacedEntity): string {
  return `${entity.name}|${entity.direction}|${Math.abs(Math.round(entity.x) + Math.round(entity.y)) % 2}|${entity.undergroundType ?? ""}`;
}

/** A sprite of one entity type, as drawn at frame 0. */
function spriteKey(key: string, c: DrawCommand): string {
  return `${key}|${c.sheet}:${c.sx}:${c.sy}:${c.sw}:${c.sh}`;
}

/** Per-entity-type animation profile: for one entity of this name+direction,
 *  which of its commands move, and how.
 *
 *  Probing is done ONCE per entity type and memoised, not per scene. Probing
 *  the whole visible set on every cache miss made panning and zooming
 *  catastrophically slow — the visible set changes every frame while moving,
 *  so a 257-pass probe over thousands of entities ran 60 times a second. */
export class AnimProfileCache {
  private readonly byType = new Map<string, AnimProfile>();
  /** Every sprite a probe has measured, keyed by spriteKey(); null for one
   *  that does not animate. */
  private readonly bySprite = new Map<string, SpriteAnimation | null>();
  /** How many probes have run — each up to MAX_ANIM_PERIOD + 1 collects. */
  probes = 0;

  /** The profile shared by every entity of this one's type, facing, parity
   *  and underground end — probed on the first one met. */
  forEntity(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext): AnimProfile {
    const key = profileKey(entity);
    const cached = this.byType.get(key);
    if (cached) return cached;

    if (!hasAnimatedLayer(visual)) {
      this.byType.set(key, NO_ANIMATION);
      return NO_ANIMATION;
    }

    const profile = this.probe(entity, visual, ctx);
    this.byType.set(key, profile);
    return profile;
  }

  /** The profile for the commands `commands[start..]` that `entity` just
   *  emitted into a scene collected at frame 0: its type's, when those
   *  commands are the ones its type's probe saw, otherwise its shape's. */
  forCommands(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext, commands: DrawCommand[], start: number): AnimProfile {
    const profile = this.forEntity(entity, visual, ctx);
    if (profile.animated.length === 0 || fits(profile, commands, start)) return profile;
    return this.forShape(entity, visual, ctx, commands, start);
  }

  /** The profile of an entity whose shape differs from its type's — its
   *  neighbours added or removed commands, so forEntity()'s indices don't
   *  line up — for its commands `commands[start..]` in the real scene. Not
   *  cached under the shared key: that would poison the fast path for every
   *  other instance. Instead it is pieced together sprite by sprite: probe()
   *  analyses each command on its own, and a sprite of a given entity type
   *  animates the same way whichever shape it appears in (a belt's body row
   *  or end cap, a machine's pipe cover). Only a shape with a sprite no probe
   *  has met yet is probed. Probing every such entity on every scene rebuild
   *  (every pan and hover) made a blueprint full of belt ends, curves and
   *  plumbed machines take seconds per rebuild. */
  forShape(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext, commands: DrawCommand[], start: number): AnimProfile {
    const key = profileKey(entity);
    const pieced: AnimProfile = {
      animated: [], stride: [], period: [], phase0: [], columns: [], steps: [], origin: [],
      commandCount: commands.length - start,
      cells: commands.slice(start).map(cellOf),
    };
    for (let i = start; i < commands.length; i++) {
      const sprite = this.bySprite.get(spriteKey(key, commands[i]!));
      if (sprite === undefined) {
        const profile = this.probe(entity, visual, ctx);
        return fits(profile, commands, start) ? profile : NO_ANIMATION;
      }
      if (sprite === null) continue;
      pieced.animated.push(i - start);
      pieced.stride.push(sprite.stride);
      pieced.period.push(sprite.period);
      pieced.phase0.push(sprite.phase0);
      pieced.columns.push(sprite.columns);
      pieced.steps.push(sprite.steps);
      pieced.origin.push(sprite.origin);
    }
    return pieced;
  }

  /** Probes one entity and remembers each of its sprites' behaviour for
   *  forShape(). An entity whose command count changes with the frame has
   *  no per-command answer, so none is recorded for it. */
  private probe(entity: PlacedEntity, visual: ResolvedVisual, ctx: CollectContext): AnimProfile {
    this.probes++;
    const { profile, structural, base } = probe(entity, visual, ctx);
    if (!structural) {
      const key = profileKey(entity);
      base.forEach((command, i) => {
        const k = profile.animated.indexOf(i);
        this.bySprite.set(spriteKey(key, command), k < 0 ? null : {
          stride: profile.stride[k]!, period: profile.period[k]!, phase0: profile.phase0[k]!,
          columns: profile.columns[k]!, steps: profile.steps[k]!, origin: profile.origin[k]!,
        });
      });
    }
    return profile;
  }
}

/** Collects a single entity at one animation frame, against whatever
 *  neighbour context it is handed.
 *
 *  Neighbours do not change how a sprite's own frames advance, but they do
 *  change HOW MANY commands the entity emits — a belt or splitter alone
 *  draws end caps that the same entity mid-run does not. The profile's
 *  indices are therefore only valid for a command list of the same length,
 *  which buildSceneCache checks before using them. */
function collectAt(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext, frame: number): DrawCommand[] {
  const out: DrawCommand[] = [];
  collectEntity(out, entity, visual, { ...baseCtx, animationFrame: frame }, 1);
  return out;
}

/** Works out, by sampling, which of one entity's commands animate and how.
 *  Shared by the memoised per-type path and the per-entity fallback. */
function probe(entity: PlacedEntity, visual: ResolvedVisual, baseCtx: CollectContext): { profile: AnimProfile; structural: boolean; base: DrawCommand[] } {
  const base = collectAt(entity, visual, baseCtx, 0);
  const animated: number[] = [];
  const stride: number[] = [];
  const period: number[] = [];

  const samples: DrawCommand[][] = [];
  let structural = false;
  for (let frame = 1; frame <= MAX_ANIM_PERIOD; frame++) {
    const at = collectAt(entity, visual, baseCtx, frame);
    if (at.length !== base.length) { structural = true; break; }
    samples.push(at);
  }

  const phase0: number[] = [];
  const columnCount: number[] = [];
  const stepCount: number[] = [];
  const origin: number[] = [];

  if (!structural) {
    for (let i = 0; i < base.length; i++) {
      // The frame width is the greatest common divisor of every sx step
      // the command takes across the cycle, wraps included. Reading it from
      // the samples rather than from the sprite keeps this independent of
      // how the layer was described; a gcd rather than the smallest step
      // because a fast belt moves several columns a tick (a blue belt's
      // +3 and its -29 wrap only agree on one column).
      let width = 0;
      for (let frame = 0; frame < samples.length; frame++) {
        const delta = Math.abs(samples[frame]![i]!.sx - (frame === 0 ? base[i]!.sx : samples[frame - 1]![i]!.sx));
        if (delta > 0) width = gcd(width, delta);
      }
      if (width === 0) continue;

      // The shortest period the sampled sx sequence repeats with. Not simply
      // the first frame back on the frame-0 cell: a slowed sprite (a rail
      // signal's lights, slowdown 30) holds that cell for its first frames,
      // which made it look like a 1-frame cycle that never moves, so it
      // was left frozen on frame 0.
      const sxAt = (frame: number) => (frame === 0 ? base[i]! : samples[frame - 1]![i]!).sx;
      let cycle = 0;
      for (let p = 1; p <= samples.length && cycle === 0; p++) {
        if (sxAt(p) !== sxAt(0)) continue;
        let repeats = true;
        for (let frame = 0; frame + p <= samples.length && repeats; frame++) repeats = sxAt(frame + p) === sxAt(frame);
        if (repeats) cycle = p;
      }
      if (cycle <= 0) continue;

      // The lowest sx the command ever reaches is its row's column 0; the
      // frame-0 offset above it is the sprite's starting phase. For a turbo
      // belt's odd-parity tile that phase is half the sheet, which is
      // exactly the case the old linear-only model had to reject.
      let low = base[i]!.sx;
      for (let frame = 0; frame < cycle; frame++) low = Math.min(low, samples[frame]![i]!.sx);
      const startPhase = (base[i]!.sx - low) / width;
      if (!Number.isInteger(startPhase)) continue;

      // Derive the column count from the widest sx actually reached.
      let high = base[i]!.sx;
      for (let frame = 0; frame < cycle; frame++) high = Math.max(high, samples[frame]![i]!.sx);
      const columns = (high - low) / width + 1;

      // How many columns the command walks through over one cycle: a
      // forward step from one frame to the next, modulo the row. Frames
      // advance `speedup / slowdown` columns a tick, so this is cycle /
      // slowdown for a slowed sprite and a multiple of `columns` for a
      // belt faster than one column a tick.
      let steps = 0;
      let previous = startPhase;
      for (let frame = 1; frame <= cycle; frame++) {
        const current = (samples[frame - 1]![i]!.sx - low) / width;
        steps += (((current - previous) % columns) + columns) % columns;
        previous = current;
      }
      if (steps === 0) continue;

      // Accept only an exact wrapping ramp with nothing else moving;
      // anything else stays on its frame-0 art rather than risking wrong
      // sprites.
      let matches = true;
      for (let frame = 1; frame <= samples.length && matches; frame++) {
        const sample = samples[frame - 1]![i]!;
        const column = (startPhase + Math.floor(((frame % cycle) * steps) / cycle)) % columns;
        matches =
          sample.sx === low + column * width &&
          sample.sheet === base[i]!.sheet &&
          sample.sy === base[i]!.sy &&
          sample.layer === base[i]!.layer &&
          sample.order === base[i]!.order;
      }
      if (!matches) continue;

      animated.push(i);
      stride.push(width);
      period.push(cycle);
      phase0.push(startPhase);
      columnCount.push(columns);
      stepCount.push(steps);
      origin.push(low);
    }
  }

  return { profile: { animated, stride, period, phase0, columns: columnCount, steps: stepCount, origin, commandCount: base.length, cells: base.map(cellOf) }, structural, base };
}
