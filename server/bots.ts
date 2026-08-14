// Bot move selection. Deliberately heuristic rather than optimal — it should feel
// like a decent human opponent, not an oracle.

import { parse, isDouble } from './dominoes.js';
import type { Game, EnginePlayer, Train, Seg, PendingFoot } from './game.js';
import type { TileId, PlayerId, TrainId, Move } from '../shared/protocol.js';

/** How many of each pip value a hand holds, so a play can be judged on the end
 *  it leaves behind as well as the tile it sheds. */
type Ends = Record<number, number>;

/** What a bot decided to do. `play` carries the move; the rest are their own
 *  whole answer. */
export type BotMove =
  | { type: 'engine' }
  | { type: 'draw' }
  | { type: 'pass' }
  | { type: 'play'; tile: TileId; train: TrainId; seg: number };

/** The facts about one candidate move that the scoring considerations share. */
interface Considered {
  train: Train;
  seg: Seg;
  foot: PendingFoot | undefined;
  dbl: boolean;
  outer: number;
  cover: number;
  rival: EnginePlayer | null;
  aggro: number;
  /** One communal board rather than a train each, so every play lands in front
   *  of everybody and there is no such thing as a train of your own. */
  board: boolean;
  /** Somebody other than you is close enough to going out to be worth
   *  inconveniencing. */
  chase: boolean;
}

const NAMES = ['Bo', 'Cleo', 'Dax', 'Effie', 'Gus', 'Hattie', 'Ida', 'Jonah', 'Kit', 'Lupe', 'Mo', 'Nell', 'Otis', 'Pip', 'Ruby', 'Sable'];

export function botName(taken: string[]): string {
  const free = NAMES.filter((n) => !taken.includes(n));
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Temperament runs 0 (friendly — unjams people) to 1 (aggressive — jams them).
// Rolled once per bot and never exposed, so nobody can shop for a soft table.
// Pulled toward the middle so most bots are ordinary and extremes stay rare.
export function randomTemper(): number {
  return (Math.random() + Math.random() + Math.random()) / 3;
}

// Returns {type:'play', tile, train} | {type:'draw'} | {type:'pass'}
export function chooseMove(game: Game, playerId: PlayerId): BotMove {
  if (game.phase === 'seeking') {
    // A bot lays the engine without ceremony; a human is asked to do it.
    const me = game.player(playerId)!;
    return me.hand.includes(`${game.engine}-${game.engine}`) ? { type: 'engine' } : { type: 'draw' };
  }
  const me = game.player(playerId)!;
  const moves = game.legalMoves(me);
  if (!moves.length) {
    if (game.boneyard.length && !game.drewThisTurn) return { type: 'draw' };
    return { type: 'pass' };
  }

  const ends = countEnds(me.hand);
  let best: { s: number; mv: Move } | null = null;
  for (const mv of moves) {
    const s = score(game, me, mv, ends) + Math.random() * 1.5;
    if (!best || s > best.s) best = { s, mv };
  }
  return { type: 'play', tile: best!.mv.tile, train: best!.mv.train, seg: best!.mv.seg };
}

function countEnds(hand: TileId[]): Ends {
  const c: Ends = {};
  for (const t of hand) { const [a, b] = parse(t); c[a] = (c[a] || 0) + 1; c[b] = (c[b] || 0) + 1; }
  return c;
}

// A move's score is a sum of independent considerations, each of which stands on
// its own. Keeping them as separate functions means a weight can be read, argued
// with and tuned without holding the rest of the arithmetic in your head.
function score(game: Game, me: EnginePlayer, mv: Move, ends: Ends): number {
  const c = context(game, me, mv);
  const shed = game.tileScore(mv.tile);
  return shed * 1.2                                   // shedding pips is the whole game
    + placement(me, c, ends)
    + doubleValue(game, c)
    + spite(game, c)
    + (me.hand.length <= 4 ? shed * 1.5 : 0);         // late on, unload the heaviest first
}

// The facts about a move that several of the considerations below share.
function context(game: Game, me: EnginePlayer, mv: Move): Considered {
  const train = game.train(mv.train)!;
  const seg = game.seg(train, mv.seg)!;
  const foot = game.footOn(mv.train, mv.seg);
  const end = foot ? foot.value : seg.end;
  const [a, b] = parse(mv.tile);
  const dbl = isDouble(mv.tile);
  return {
    train, seg, foot, dbl,
    outer: a === end ? b : a,
    // Tiles still in hand that could cover this double if it were played.
    cover: dbl ? me.hand.filter((t) => t !== mv.tile && parse(t).includes(a)).length : 0,
    rival: train.owner !== me.id && train.owner !== null ? game.player(train.owner)! : null,
    // Temperament, rescaled: -1 fully friendly .. +1 fully aggressive.
    aggro: ((me.temper ?? 0.5) - 0.5) * 2,
    board: !game.variant.markers,
    chase: game.players.some((p) => p.id !== me.id && p.hand.length <= 3),
  };
}

// Where to put it, ignoring who it hurts.
function placement(me: EnginePlayer, { train, seg, outer, board }: Considered, ends: Ends): number {
  const followUps = ends[outer] || 0;
  if (train.owner === me.id) {
    return 14                        // getting your marker down is worth a lot
      + followUps * 3.5              // ...and leaving an end you can follow up on
      + (seg.tiles.length ? 0 : 6);  // get started early
  }
  // On one shared board every branch is yours as much as anyone's, so the only
  // thing to weigh is whether the end it leaves is one you can use next turn.
  if (train.owner === null) return board ? 4 + followUps * 2.6 : 4;
  return 7 - followUps * 1.2;        // better still — but don't hand them an end you wanted
}

function doubleValue(game: Game, { dbl, cover }: Considered): number {
  if (!dbl) return 0;
  if (game.foot === 1) return cover > 0 ? 9 : -6;   // a double you can follow up on is worth more
  return 4 + cover * 2;                             // a foot opens fresh ends you might use
}

// Everything that only matters because somebody else is on the receiving end.
// Which is a different question on a board nobody owns: there is no one train
// to jam, but a double stops the whole table until its toes are down, so the
// person it costs is whoever was closest to going out.
function spite(game: Game, c: Considered): number {
  if (c.board) return spiteOnBoard(c);
  if (!c.rival) return 0;
  return spiteOnRival(game, c, c.rival);
}

// On one shared board there is no such thing as jamming somebody else. A double
// stops everybody, the player who laid it included, so whether to lay one is
// mostly a question about your own hand and only slightly about temperament.
//
// Reading it the other way round — treating a double as an act of aggression a
// friendly bot should avoid — is what made the obliging bots the dangerous
// ones: they declined doubles until their hands were nothing but doubles, and
// blocked 79% of rounds against the ruthless bots' 28%.
function spiteOnBoard({ dbl, cover, foot, chase, aggro }: Considered): number {
  let s = 0;
  if (dbl) {
    // A double you can follow up on is simply good play. One you cannot is a
    // risk you are taking too; temperament decides how much you enjoy it, not
    // whether it is a risk.
    s += cover ? 6 : -10;
    if (chase) s += aggro * 8;             // stalling somebody about to go out is the real spite
  }
  // Feeding a foot frees the board, your own next turn included. Aggressive
  // bots dawdle over it; nobody refuses outright, because a board no one will
  // thaw ends the round with every hand still full.
  if (foot) s += 6 - aggro * 5;
  return s;
}

function spiteOnRival(game: Game, { dbl, cover, foot, aggro }: Considered, rival: EnginePlayer): number {
  let s = 0;
  if (dbl) {
    // Dropping a double on an open train jams it — with pigeon feet it freezes
    // the whole thing until several tiles land. The nastier bots love this.
    s += aggro * (game.foot > 1 ? 24 : 11);
    // Nastier still if they can't unstick it themselves, and a friendly bot
    // would rather not strand a double on a neighbour at all.
    if (!cover) s += aggro * 7 + aggro * 4;
    if (rival.hand.length <= 4) s += aggro * 9;   // best of all against whoever is about to go out
  }
  // Feeding someone's foot frees their train up again. Friendly bots offer;
  // aggressive ones leave them stewing.
  if (foot) s -= aggro * 17;
  return s;
}
