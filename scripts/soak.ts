// Plays complete games across every rule combination and asserts the invariants
// that matter. The rules engine is pure, so this needs no server and no network.
//
//   node scripts/soak.mjs [gamesPerCombo]

import { Game, parse } from '../server/game.js';
import type { EnginePlayer, Seg, PendingFoot } from '../server/game.js';
import type { TileId, Foot, Scoring, PlayerId, Move } from '../shared/protocol.js';
import type { BotMove } from '../server/bots.js';

/** One cell of the sweep: a table set up a particular way. */
interface Combo {
  foot: Foot;
  scoring: Scoring;
  max: number;
  n: number;
}
import { chooseMove, randomTemper } from '../server/bots.js';

const REPS = Number(process.argv[2] || 1);
const fail = (m: string): never => { throw new Error(m); };

let games = 0, rounds = 0, blocked = 0, moves = 0, forks = 0;
let feetOpened = 0, feetFilled = 0, siblingChecks = 0;
const t0 = Date.now();

// ---------------------------------------------------------------- pigeon feet
//
// The rule, stated once: a double opens a foot on the branch it lands on, and
// until that foot is full *that branch* takes nothing but toes. The rest of the
// train is unaffected — including branches that forked off earlier. Getting
// this wrong is invisible in a scoring check and very visible at the table, so
// it is pinned here as a scripted position rather than left to the fuzzer to
// stumble into.
function forkScenario(): void {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], max: 12, foot: 2, scoring: 'house' });
  g.phase = 'play';                     // skip the engine hunt and drive the board by hand
  g.engineDown = true;
  const A = g.player('a')!;
  A.openingDone = true;
  const lay = (tile: TileId, seg: number) => { g.turn = 0; A.hand = [tile, '0-0', '1-1']; g.play('a', tile, 'a', seg); };

  lay('6-12', 0);                       // train a: 12 -> 6
  lay('6-6', 0);                        // a double on 6 opens a foot needing two toes
  lay('6-3', 0);                        // toe 1 starts branch 1, ending 3
  lay('6-4', 0);                        // toe 2 starts branch 2, ending 4 — the foot is full

  const segs = g.train('a')!.segs;
  if (segs.length !== 3) fail(`forks: expected 3 branches after a filled foot, got ${segs.length}`);
  if (!segs[0].closed) fail('forks: the doubled branch should be spent once its foot filled');

  lay('3-3', 1);                        // now a double on one of the two forks
  if (g.pending.length !== 1 || g.pending[0].seg !== 1) fail('forks: expected exactly one open foot, on branch 1');

  g.turn = 0; A.hand = ['4-5', '3-9'];
  // The bug this guards: an open foot on branch 1 must not close branch 2.
  if (!g.legalMoves(A).some((m) => m.seg === 2 && m.tile === '4-5')) {
    fail('forks: a foot on one branch suppressed the legal move on a sibling branch');
  }
  try { g.play('a', '4-5', 'a', 2); }
  catch (e) { fail(`forks: sibling branch rejected a matching tile — ${e instanceof Error ? e.message : String(e)}`); }

  // ...while the branch that owes toes still takes toes and nothing else.
  g.turn = 0; A.hand = ['8-8', '3-9'];
  let refused = false;
  try { g.play('a', '8-8', 'a', 1); } catch { refused = true; }
  if (!refused) fail('forks: a branch owing toes accepted a tile that cannot feed it');
}
forkScenario();

// ---------------------------------------------------------------- the sweep

// Every rule combination the table can be set to, flattened. Nesting the sweep
// around the thing being tested buries the game loop five levels deep and makes
// the invariants harder to read than the loops that reach them. A double-6 set
// can't seat 8 and still leave a boneyard, so that pairing is dropped rather
// than played.
const COMBOS: Combo[] = ([1, 2, 3] as Foot[]).flatMap((foot) =>
  (['house', 'official', 'pips'] as Scoring[]).flatMap((scoring) =>
    [12, 9, 6].flatMap((max) =>
      [2, 4, 8].filter((n) => !(max === 6 && n === 8))
        .map((n) => ({ foot, scoring, max, n })))));

for (const combo of COMBOS) {
  for (let rep = 0; rep < REPS; rep++) playGame(combo);
}

function playGame({ foot, scoring, max, n }: Combo): void {
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, bot: true, temper: randomTemper() }));
  let g;
  try { g = new Game({ players, max, foot, scoring }); }
  catch { return; }                       // set too small for this many seats
  games++;

  let guard = 0;
  while (g.status !== 'gameOver') {
    if (++guard > 500_000) fail(`game did not terminate (foot=${foot} max=${max} n=${n})`);
    if (g.status === 'roundOver') endRound(g, max);
    else takeTurn(g, foot);
  }
}

function endRound(g: Game, max: number): void {
  rounds++;
  if (!g.roundWinner) blocked++;
  if (!g.engineDown) fail('round ended without the engine ever being laid');
  audit(g, max);
  for (const p of g.players) {
    if (p.roundScores.reduce((a, b) => a + b, 0) !== p.score) fail('score does not match its round history');
    if (p.score < 0) fail('negative score');
  }
  g.startRound();
}

// One turn: check the position the player is handed, then make the move and
// check what it did.
function takeTurn(g: Game, foot: Foot): void {
  const id = g.current.id;
  const me = g.player(id)!;
  checkPosition(g, me, foot);

  const mv = chooseMove(g, id);
  if (mv.type === 'engine') { g.layEngine(id); moves++; return; }
  if (g.phase === 'seeking') { g.draw(id); moves++; return; }
  if (mv.type !== 'play' && g.legalMoves(me).length) fail('drew or passed while holding a legal play');
  applyMove(g, id, mv);
}

function checkPosition(g: Game, me: EnginePlayer, foot: Foot): void {
  const offered = g.legalMoves(me);
  checkOffers(g, me, offered);
  checkFeet(g, foot);
  siblingChecks += checkSiblingsStayOpen(g, me, offered);

  // A spectator view must never carry anyone's hand.
  const pub = g.view('nobody');
  if (pub.hand.length || pub.moves.length) fail('public view leaked a hand');
}

function applyMove(g: Game, id: PlayerId, mv: BotMove): void {
  // Markers are manual, so the bot works its own while it is still its turn.
  if (mv.type === 'pass') g.marker(id, true);
  else if (mv.type === 'play' && mv.train === id) g.marker(id, false);

  // Snapshot the feet so the play can be checked against what it did to them:
  // a filled foot has to fork its branch, exactly once.
  const feetBefore = g.pending.map((f) => ({ ...f }));

  if (mv.type === 'play') g.play(id, mv.tile, mv.train, mv.seg);
  else if (mv.type === 'draw') g.draw(id);
  else g.pass(id);
  moves++;

  if (mv.type === 'play') checkFootTransition(g, feetBefore);
}

// ---------------------------------------------------------------- invariants

// Nothing illegal may ever be offered.
function checkOffers(g: Game, me: EnginePlayer, offered: Move[]): void {
  for (const mv of offered) {
    if (!g.canPlayOn(me, g.train(mv.train)!)) fail('offered a move on a train closed to that player');
    const seg = g.seg(g.train(mv.train)!, mv.seg)!;
    const f = g.footOn(mv.train, mv.seg);
    // A foot binds its own branch: on that branch only toes may be played.
    if (f && !parse(mv.tile).includes(f.value)) fail('offered a tile that does not feed the open foot');
    if (!f && seg.closed) fail('offered a play on a branch that has already forked');
  }
}

// Every open foot has to describe a real, still-growable branch. A foot left
// pointing at a spent branch would freeze that branch for the rest of the round.
function checkFeet(g: Game, foot: Foot): void {
  if (foot < 2 && g.pending.length) fail('feet opened on a table that covers doubles once');
  for (const f of g.pending) {
    const train = g.train(f.train);
    if (!train) return fail('an open foot names a train that does not exist');
    const seg = g.seg(train!, f.seg);
    if (!seg) return fail('an open foot names a branch that does not exist');
    if (seg.closed) fail('an open foot sits on a branch that has already forked');
    if (f.value !== seg.end) fail(`foot wants ${f.value} but its branch ends on ${seg.end}`);
    if (f.placed >= f.need) fail('a foot is still open with all its toes down');
    if (f.need !== foot) fail(`foot needs ${f.need} toes, table is set to ${foot}`);
  }
}

// The rule the table cares about: a foot binds its own branch, not the train.
// So whenever one branch owes toes and a sibling branch is open and matchable,
// the sibling must still be on offer. Returns how many times that situation
// actually came up, so a run that never exercised it can't look like a pass.
function checkSiblingsStayOpen(g: Game, me: EnginePlayer, offered: Move[]): number {
  let checked = 0;
  for (const f of g.pending) {
    const train = g.train(f.train);
    if (!train || !g.canPlayOn(me, train)) continue;
    for (const s of train.segs) {
      if (s.id === f.seg || s.closed) continue;
      if (g.footOn(train.id, s.id)) continue;             // owes toes of its own
      const playable = me.hand.filter((t) => parse(t).includes(s.end));
      if (!playable.length) continue;
      checked++;
      for (const tile of playable) {
        if (!offered.some((m) => m.train === train.id && m.seg === s.id && m.tile === tile)) {
          fail(`a foot on branch ${f.seg} suppressed ${tile} on open sibling branch ${s.id}`);
        }
      }
    }
  }
  return checked;
}

// Filling a foot forks its branch: the branch is spent, and it has exactly as
// many children as the foot demanded toes — no more, no fewer.
function checkFootTransition(g: Game, feetBefore: PendingFoot[]): void {
  for (const before of feetBefore) {
    const still = g.pending.find((f) => f.train === before.train && f.seg === before.seg);
    if (still) {
      if (still.placed < before.placed) fail('a foot lost a toe it had already been given');
      continue;
    }
    feetFilled++;
    const train = g.train(before.train)!;
    const parent = g.seg(train, before.seg)!;
    if (!parent.closed) fail('a filled foot left its branch open instead of forking it');
    const children = train.segs.filter((s) => s.parent === before.seg);
    if (children.length !== before.need) {
      fail(`a filled foot forked into ${children.length} branches, expected ${before.need}`);
    }
    for (const c of children) {
      if (c.from !== before.value) fail('a toe hangs off the wrong value');
    }
  }
  feetOpened += g.pending.filter((f) => f.placed === 0 && !feetBefore.some((b) => b.train === f.train && b.seg === f.seg)).length;
}

// Every tile accounted for exactly once, and every branch a valid chain.
function audit(g: Game, max: number): void {
  const seen = new Set();
  const claim = (t: TileId) => { if (seen.has(t)) fail(`tile ${t} exists twice`); seen.add(t); };
  for (const p of g.players) for (const t of p.hand) claim(t);
  for (const tr of g.trains) {
    if (tr.segs.length > 1) forks++;
    for (const s of tr.segs) auditChain(s, claim);
  }
  for (const t of g.boneyard) claim(t);
  const total = (max + 1) * (max + 2) / 2;
  if (seen.size !== total - 1) fail(`${seen.size} tiles accounted for, expected ${total - 1}`);
}

// A branch is a chain: every tile is laid against the end the tile before it
// left open, and the branch's recorded end is where the last one finished.
function auditChain(s: Seg, claim: (t: TileId) => void): void {
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

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (!siblingChecks) fail('never once saw a foot open beside a playable sibling branch — the fork rule went untested');
console.log(`soak OK — ${games} games, ${rounds} rounds, ${moves} moves, ${blocked} blocked rounds, ${secs}s`);
console.log(`  feet: ${feetOpened} opened, ${feetFilled} filled, ${forks} forked trains, ${siblingChecks} sibling-branch checks`);
