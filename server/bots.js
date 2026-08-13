// Bot move selection. Deliberately heuristic rather than optimal — it should feel
// like a decent human opponent, not an oracle.

import { parse, isDouble } from './game.js';

const NAMES = ['Bo', 'Cleo', 'Dax', 'Effie', 'Gus', 'Hattie', 'Ida', 'Jonah', 'Kit', 'Lupe', 'Mo', 'Nell', 'Otis', 'Pip', 'Ruby', 'Sable'];

export function botName(taken) {
  const free = NAMES.filter((n) => !taken.includes(n));
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Temperament runs 0 (friendly — unjams people) to 1 (aggressive — jams them).
// Rolled once per bot and never exposed, so nobody can shop for a soft table.
// Pulled toward the middle so most bots are ordinary and extremes stay rare.
export function randomTemper() {
  return (Math.random() + Math.random() + Math.random()) / 3;
}

export function temperName(t) {
  return t < 0.2 ? 'obliging' : t < 0.4 ? 'good-natured' : t < 0.6 ? 'even-handed'
    : t < 0.8 ? 'competitive' : 'ruthless';
}

// Returns {type:'play', tile, train} | {type:'draw'} | {type:'pass'}
export function chooseMove(game, playerId) {
  if (game.phase === 'seeking') {
    // A bot lays the engine without ceremony; a human is asked to do it.
    const me = game.player(playerId);
    return me.hand.includes(`${game.engine}-${game.engine}`) ? { type: 'engine' } : { type: 'draw' };
  }
  const me = game.player(playerId);
  const moves = game.legalMoves(me);
  if (!moves.length) {
    if (game.boneyard.length && !game.drewThisTurn) return { type: 'draw' };
    return { type: 'pass' };
  }

  const ends = countEnds(me.hand);
  let best = null;
  for (const mv of moves) {
    const s = score(game, me, mv, ends) + Math.random() * 1.5;
    if (!best || s > best.s) best = { s, mv };
  }
  return { type: 'play', tile: best.mv.tile, train: best.mv.train, seg: best.mv.seg };
}

function countEnds(hand) {
  const c = {};
  for (const t of hand) { const [a, b] = parse(t); c[a] = (c[a] || 0) + 1; c[b] = (c[b] || 0) + 1; }
  return c;
}

// A move's score is a sum of independent considerations, each of which stands on
// its own. Keeping them as separate functions means a weight can be read, argued
// with and tuned without holding the rest of the arithmetic in your head.
function score(game, me, mv, ends) {
  const c = context(game, me, mv);
  const shed = game.tileScore(mv.tile);
  return shed * 1.2                                   // shedding pips is the whole game
    + placement(me, c, ends)
    + doubleValue(game, c)
    + spite(game, c)
    + (me.hand.length <= 4 ? shed * 1.5 : 0);         // late on, unload the heaviest first
}

// The facts about a move that several of the considerations below share.
function context(game, me, mv) {
  const train = game.train(mv.train);
  const seg = game.seg(train, mv.seg);
  const foot = game.footOn(mv.train, mv.seg);
  const end = foot ? foot.value : seg.end;
  const [a, b] = parse(mv.tile);
  const dbl = isDouble(mv.tile);
  return {
    train, seg, foot, dbl,
    outer: a === end ? b : a,
    // Tiles still in hand that could cover this double if it were played.
    cover: dbl ? me.hand.filter((t) => t !== mv.tile && parse(t).includes(a)).length : 0,
    rival: train.owner !== me.id && train.owner !== null ? game.player(train.owner) : null,
    // Temperament, rescaled: -1 fully friendly .. +1 fully aggressive.
    aggro: ((me.temper ?? 0.5) - 0.5) * 2,
  };
}

// Where to put it, ignoring who it hurts.
function placement(me, { train, seg, outer }, ends) {
  const followUps = ends[outer] || 0;
  if (train.owner === me.id) {
    return 14                        // getting your marker down is worth a lot
      + followUps * 3.5              // ...and leaving an end you can follow up on
      + (seg.tiles.length ? 0 : 6);  // get started early
  }
  if (train.owner === null) return 4;              // a safe dumping ground
  return 7 - followUps * 1.2;        // better still — but don't hand them an end you wanted
}

function doubleValue(game, { dbl, cover }) {
  if (!dbl) return 0;
  if (game.foot === 1) return cover > 0 ? 9 : -6;   // a double you can follow up on is worth more
  return 4 + cover * 2;                             // a foot opens fresh ends you might use
}

// Everything that only matters because somebody else is on the receiving end.
// On your own train and on the Mexican train there is nobody to be nasty to.
function spite(game, { dbl, cover, foot, rival, aggro }) {
  if (!rival) return 0;
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
