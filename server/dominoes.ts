// The tile algebra every domino game shares: what a tile is, what a set holds,
// and how big a deal a set can stand.
//
// Deliberately knows nothing about trains, hands, turns, markers or scoring. A
// tile here is an id and two numbers. Everything that gives those numbers
// meaning — which end is open, what a double demands, what a tile left in hand
// costs you — belongs to whichever game is on the table.

import type { TileId } from '../shared/protocol.js';

export const parse = (id: TileId): number[] => id.split('-').map(Number);
export const isDouble = (id: TileId): boolean => { const [a, b] = parse(id); return a === b; };

/** How a tile reads in a log line: `"6 | 3"`. */
export const label = (id: TileId): string => id.replace('-', ' | ');

/** Heavy tiles first, grouped by their high end — the order most people fan by. */
export const sortTiles = (x: TileId, y: TileId): number => {
  const [a1, b1] = parse(x), [a2, b2] = parse(y);
  return b2 - b1 || a2 - a1;
};

export function makeSet(max: number): TileId[] {
  const tiles: TileId[] = [];
  for (let a = 0; a <= max; a++) for (let b = a; b <= max; b++) tiles.push(`${a}-${b}`);
  return tiles;
}

/** How many tiles a double-`max` set holds, without building it. */
export const setSize = (max: number): number => (max + 1) * (max + 2) / 2;

export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** The largest table a set can seat while leaving a boneyard worth drawing from,
 *  given that game's own deal policy — games disagree about how many tiles a
 *  hand starts with, but every one of them plays badly with nothing to draw.
 *  Eight is the ceiling because it is the most seats the lobby offers. */
export function seatsFor(max: number, deal: (playerCount: number) => number): number {
  const total = setSize(max);
  for (let n = 8; n >= 2; n--) if (total - n * deal(n) >= Math.max(4, n)) return n;
  return 2;
}
