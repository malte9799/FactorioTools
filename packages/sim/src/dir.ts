/** Cardinal direction as 0..3, clockwise from north. Blueprint direction
 *  values are 16-way (0 N, 4 E, 8 S, 12 W) — see the renderer's toCardinal
 *  in neighbours/grid.ts for why the scheme is never guessed. */
export type Card = 0 | 1 | 2 | 3;

export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export const cardOf = (direction: number): Card => (Math.round(direction / 4) % 4) as Card;
export const opposite = (d: Card): Card => ((d + 2) % 4) as Card;
export const leftOf = (d: Card): Card => ((d + 3) % 4) as Card;
export const rightOf = (d: Card): Card => ((d + 1) % 4) as Card;

/** The side vector of one lane relative to travel: lane 0 is the left lane,
 *  lane 1 the right lane. */
export const laneSide = (d: Card, lane: 0 | 1): Card => (lane === 0 ? leftOf(d) : rightOf(d));
