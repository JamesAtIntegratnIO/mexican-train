// What separates one train game from another, in the six places they differ.
//
// Both games deal from a boneyard, count down a double a round, hunt the
// round's double, freeze a train until its double is covered, and score the
// pips you were caught holding. All of that is `game.ts` and neither game owns
// it. What is left is this file: who a train belongs to, how many tiles a
// double demands, and whether there is such a thing as a marker.
//
// Composed rather than subclassed. `Game`'s constructor deals a round before a
// subclass constructor body would have run, so an override could not read a
// field its own class had set — a variant object is handed in whole instead,
// and there is no moment where half of it exists.
//
// Types only from `game.js`, which is what keeps this out of a runtime import
// cycle: the engine imports these variants for real, and they import nothing
// back.

import { seatsFor, setSize } from './dominoes.js';
import type { Game, EnginePlayer, Train } from './game.js';
import type { Foot, GameName, Hub, PlayerId } from '../shared/protocol.js';

export interface Variant {
  name: GameName;
  /** Shown wherever the game has to be named to a player. */
  title: string;
  /** Tiles in a hand at the start of a round. */
  deal(playerCount: number, max: number): number;
  /** Set where the game fixes what a double demands, so the table can't be
   *  configured into a variant that isn't the game. Absent means the host
   *  chooses. */
  foot?: Foot;
  /** The board a round opens with. */
  layTrains(g: Game): Train[];
  /** Whether this player may touch this train at all, before per-branch detail. */
  canPlayOn(g: Game, p: EnginePlayer, t: Train): boolean;
  /** Run once the round's double is on the table. */
  engineDown(g: Game): void;
  /** Whether a train can be opened to the table. Without markers, being stuck
   *  is simply the end of your turn and `marker` is refused outright. */
  markers: boolean;
  /** How a log line names the train a tile just landed on. */
  whose(g: Game, t: Train, p: EnginePlayer): string;
}

// ------------------------------------------------------------------ Mexican Train

// Official double-12 table: 2-4 → 15, 5-6 → 11, 7-8 → 8. Smaller sets have no
// published table and are scaled to leave a comparable boneyard.
export function handSize(playerCount: number, max: number): number {
  if (max >= 12) return playerCount <= 4 ? 15 : playerCount <= 6 ? 11 : 8;
  if (max >= 9) return playerCount <= 4 ? 10 : playerCount <= 6 ? 8 : 6;
  return playerCount <= 2 ? 8 : playerCount <= 3 ? 7 : 5;
}

export const mexicanTrain: Variant = {
  name: 'mexicanTrain',
  title: 'Mexican Train',
  markers: true,
  deal: handSize,

  // A train each, plus the communal one that is open from the start.
  layTrains(g) {
    const trains = g.players.map((p) => g.newTrain(p.id, p.id));
    const mexican = g.newTrain('mexican', null);
    mexican.open = true;
    trains.push(mexican);
    return trains;
  },

  canPlayOn(_g, p, t) {
    if (!p.openingDone) return t.owner === p.id;   // first turn: your own train only
    if (t.owner === p.id) return true;
    return t.open;                                 // a marker exposes EVERY branch
  },

  engineDown() { /* nothing more to do — the trains are already down */ },

  whose(g, t, p) {
    if (t.owner === null) return 'the Mexican train';
    return t.owner === p.id ? 'their train' : `${g.player(t.owner)!.name}'s train`;
  },
};

// ------------------------------------------------------------------ Chicken Foot

/** What a table rings the opening double with unless the host says otherwise.
 *  Six is the common rule; the short and long versions are equally real, which
 *  is why it is the host's to pick rather than a constant in here. */
export const DEFAULT_HUB: Hub = 6;

/** Every ring a host may choose.
 *
 *  Six is also the most any set here could support. A ring is built from tiles
 *  bearing the engine's own value, and a double-`max` set holds exactly `max`
 *  of those once the engine itself is out — six on the smallest set offered.
 *  Ask for more than that and the round opens into a hub that can never fill
 *  and a board that never thaws, which is not a hard game but a broken one. */
export const HUBS: Hub[] = [4, 6];

/** The one train there is, so it needs an id no player can hold. */
export const BOARD: PlayerId = 'board';

// The published Chicken Foot deal, which is written for a double-9 set. It is
// not a smooth curve and it is not meant to be: what it holds constant is the
// *yard*, at eleven to fifteen tiles whatever the table size.
//
// That depth is the game, not a detail. A double stops the whole board until
// three toes land on it, and the yard is where a toe comes from when nobody
// holds one. Deal it away and rounds stop ending: an earlier guess at these
// numbers left seven tiles in the yard at six players and blocked 37% of
// rounds, against 0% for Mexican Train at the same table.
const CHICKEN_DEAL: Record<number, number> = { 2: 21, 3: 14, 4: 11, 5: 8, 6: 7, 7: 6, 8: 5 };

/** The yard depth the published table holds to, and what the other sets aim for. */
const YARD = 13;

const chickenDeal = (playerCount: number, max: number): number => {
  if (max === 9) return CHICKEN_DEAL[playerCount] ?? 5;
  // The other sets have no published table, so they get the same principle
  // rather than a second invented one: deal whatever leaves a yard that deep.
  return Math.max(4, Math.floor((setSize(max) - YARD) / playerCount));
};

export const chickenFoot: Variant = {
  name: 'chickenFoot',
  title: 'Chicken Foot',
  markers: false,
  deal: chickenDeal,
  foot: 3,   // every double is footed by three; the opening one by HUB

  // One board, open to everyone from the first tile to the last.
  layTrains(g) {
    const board = g.newTrain(BOARD, null);
    board.open = true;
    return [board];
  },

  canPlayOn() { return true; },

  // The hub is a pigeon foot that wants six. Everything that makes a foot work
  // already exists — it shuts every branch but the one owing toes, forks a
  // fresh branch per toe, and closes the double's own branch once it fills.
  // With a single train on the table, freezing that train freezes the board,
  // which is exactly the rule.
  engineDown(g) {
    g.pending.push({ train: BOARD, seg: 0, value: g.engine, need: g.hub, placed: 0 });
    g.note(`The double ${g.engine} wants ${g.hub} tiles around it before anything else moves.`, 'round');
  },

  whose() { return 'the board'; },
};

export const VARIANTS: Record<GameName, Variant> = { mexicanTrain, chickenFoot };

/** The largest table this game can seat on this set. */
export const maxPlayersFor = (name: GameName, max: number): number =>
  seatsFor(max, (n) => VARIANTS[name].deal(n, max));
