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

function score(game, me, mv, ends) {
  const train = game.train(mv.train);
  const seg = game.seg(train, mv.seg);
  const foot = game.footOn(mv.train, mv.seg);
  const end = foot ? foot.value : seg.end;
  const [a, b] = parse(mv.tile);
  const outer = a === end ? b : a;
  const dbl = isDouble(mv.tile);

  // Shedding pips is the whole game — that's the baseline.
  let s = game.tileScore(mv.tile) * 1.2;

  if (train.owner === me.id) {
    s += 14;                                   // getting your marker down is worth a lot
    s += (ends[outer] || 0) * 3.5;             // ...and leaving an end you can follow up on
    if (!seg.tiles.length) s += 6;             // get started early
  } else if (train.owner === null) {
    s += 4;                                    // Mexican train is a safe dumping ground
  } else {
    s += 7;                                    // dumping on an opponent's open train is better still
    s -= (ends[outer] || 0) * 1.2;             // but don't hand them an end you wanted
  }

  const cover = dbl ? me.hand.filter((t) => t !== mv.tile && parse(t).includes(a)).length : 0;
  if (dbl) {
    if (game.foot === 1) s += cover > 0 ? 9 : -6;   // a double you can follow up on is worth more
    else s += 4 + cover * 2;                        // a foot opens fresh ends you might use
  }

  // ---- temperament: -1 fully friendly .. +1 fully aggressive ----
  const aggro = ((me.temper ?? 0.5) - 0.5) * 2;
  const rival = train.owner !== me.id && train.owner !== null ? game.player(train.owner) : null;

  if (rival) {
    if (dbl) {
      // Dropping a double on an open train jams it — with pigeon feet it freezes
      // the whole thing until several tiles land. The nastier bots love this.
      s += aggro * (game.foot > 1 ? 24 : 11);
      if (!cover) s += aggro * 7;                   // nastier still if you can't unstick it yourself
      if (rival.hand.length <= 4) s += aggro * 9;   // and best of all against whoever is about to go out
    }
    // Feeding someone's foot frees their train up again. Friendly bots offer;
    // aggressive ones leave them stewing.
    if (foot) s -= aggro * 17;
  }

  // A friendly bot would rather not strand a double on a neighbour at all.
  if (dbl && rival && !cover) s += aggro * 4;

  // Late in the round, unload the heaviest tiles first.
  if (me.hand.length <= 4) s += game.tileScore(mv.tile) * 1.5;

  return s;
}
