// Plays complete games across every rule combination and asserts the invariants
// that matter. The rules engine is pure, so this needs no server and no network.
//
//   node scripts/soak.mjs [gamesPerCombo]

import { Game, parse } from '../server/game.js';
import { chooseMove, randomTemper } from '../server/bots.js';

const REPS = Number(process.argv[2] || 1);
const fail = (m) => { throw new Error(m); };

let games = 0, rounds = 0, blocked = 0, moves = 0, forks = 0;
const t0 = Date.now();

for (const foot of [1, 2, 3]) {
  for (const scoring of ['house', 'official', 'pips']) {
    for (const max of [12, 9, 6]) {
      for (const n of [2, 4, 8]) {
        for (let rep = 0; rep < REPS; rep++) {
          const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, bot: true, temper: randomTemper() }));
          let g;
          try { g = new Game({ players, max, foot, scoring }); }
          catch { continue; }                       // set too small for this many seats
          if (max === 6 && n === 8) continue;
          games++;
          let guard = 0;

          while (g.status !== 'gameOver') {
            if (++guard > 500_000) fail(`game did not terminate (foot=${foot} max=${max} n=${n})`);

            if (g.status === 'roundOver') {
              rounds++;
              if (!g.roundWinner) blocked++;
              if (!g.engineDown) fail('round ended without the engine ever being laid');
              audit(g, max);
              for (const p of g.players) {
                if (p.roundScores.reduce((a, b) => a + b, 0) !== p.score) fail('score does not match its round history');
                if (p.score < 0) fail('negative score');
              }
              g.startRound();
              continue;
            }

            const id = g.current.id;
            const me = g.player(id);

            // Nothing illegal may ever be offered.
            for (const mv of g.legalMoves(me)) {
              if (!g.canPlayOn(me, g.train(mv.train))) fail('offered a move on a train closed to that player');
              const feet = g.trainFeet(mv.train);
              if (feet.length && !feet.some((f) => f.seg === mv.seg)) fail('offered a non-foot play on a train with an unfilled foot');
            }
            // A spectator view must never carry anyone's hand.
            const pub = g.view('nobody');
            if (pub.hand.length || pub.moves.length) fail('public view leaked a hand');

            const mv = chooseMove(g, id);
            if (mv.type === 'engine') { g.layEngine(id); moves++; continue; }
            if (g.phase === 'seeking') { g.draw(id); moves++; continue; }
            if (mv.type !== 'play' && g.legalMoves(me).length) fail('drew or passed while holding a legal play');

            if (mv.type === 'pass') g.marker(id, true);
            else if (mv.type === 'play' && mv.train === id) g.marker(id, false);

            if (mv.type === 'play') g.play(id, mv.tile, mv.train, mv.seg);
            else if (mv.type === 'draw') g.draw(id);
            else g.pass(id);
            moves++;
          }
        }
      }
    }
  }
}

// Every tile accounted for exactly once, and every branch a valid chain.
function audit(g, max) {
  const seen = new Set();
  const claim = (t) => { if (seen.has(t)) fail(`tile ${t} exists twice`); seen.add(t); };
  for (const p of g.players) for (const t of p.hand) claim(t);
  for (const tr of g.trains) {
    if (tr.segs.length > 1) forks++;
    for (const s of tr.segs) {
      let end = s.from;
      for (const t of s.tiles) {
        if (t.a !== end) fail(`broken chain: ${t.a} laid against open ${end}`);
        const [a, b] = parse(t.tile);
        if (!(a === t.a && b === t.b) && !(a === t.b && b === t.a)) fail('laid tile does not match its own id');
        end = t.b;
        claim(t.tile);
      }
      if (s.end !== end) fail('segment end disagrees with its last tile');
    }
  }
  for (const t of g.boneyard) claim(t);
  const total = (max + 1) * (max + 2) / 2;
  if (seen.size !== total - 1) fail(`${seen.size} tiles accounted for, expected ${total - 1}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`soak OK — ${games} games, ${rounds} rounds, ${moves} moves, ${forks} forked trains, ${blocked} blocked rounds, ${secs}s`);
