// Mexican Train rules engine. Pure state + transitions; no I/O, no timers.
// The tile algebra it stands on is in `dominoes.ts`; what is here is the part
// that is Mexican Train rather than dominoes.
//
// A train is not a single line. Playing a double opens a "foot" that must be
// covered by `foot` tiles (1, 2 or 3, chosen at the table). With a foot of 2 or
// 3 the train FORKS: each covering tile starts its own branch, and from then on
// the train has several live open ends. Branches are modelled as segments.

import { isDouble, label, makeSet, parse, shuffle, sortTiles } from './dominoes.js';
import { DEFAULT_HUB, HUBS, VARIANTS } from './variants.js';
import { owedPhrase } from '../shared/phrasing.js';
import type { Variant } from './variants.js';
import type {
  TileId, PlayerId, TrainId, Scoring, Foot, Hub, Phase, Status, Prompt, GameName,
  LaidTile, EngineGameView, Move, LogLine,
} from '../shared/protocol.js';

/** A player as the engine holds them: the public figures plus the hand itself,
 *  which never leaves this process except as a count. */
export interface EnginePlayer {
  id: PlayerId;
  name: string;
  bot: boolean;
  temper?: number;
  hand: TileId[];
  score: number;
  roundScores: number[];
  openingDone: boolean;
  /** Whether a tile has gone down since this player's marker last went up. A
   *  marker is raised because you could not play, so it is a play that earns
   *  the right to lower it again — see `marker`. */
  playedSinceMark: boolean;
}

/** One branch of a train. `closed` means it has forked and is spent. */
export interface Seg {
  id: number;
  parent: number | null;
  from: number;
  tiles: LaidTile[];
  end: number;
  closed: boolean;
}

export interface Train {
  id: TrainId;
  owner: PlayerId | null;
  open: boolean;
  nextSeg: number;
  segs: Seg[];
}

/** An open pigeon foot, waiting on `need - placed` more toes of `value`. */
export interface PendingFoot {
  train: TrainId;
  seg: number;
  value: number;
  need: number;
  placed: number;
}

/** What a draw hands back to the player who made it. `engine` is only ever set
 *  while the round's double is still being hunted; `ended` means the draw was
 *  unplayable, so the marker went up and the turn is over. */
export interface DrawResult {
  tile: TileId;
  playable?: boolean;
  ended?: boolean;
  engine?: boolean;
}

/** What one communal draw handed out. The hunt is not a turn — everybody
 *  reaches into the boneyard at once — so a draw during it produces a tile per
 *  player rather than one for whoever pressed. */
export interface SeekResult {
  drawn: Array<{ id: PlayerId; tile: TileId }>;
  found: PlayerId | null;
}

export interface GameOptions {
  players: Array<{ id: PlayerId; name: string; bot?: boolean; temper?: number }>;
  game?: GameName;
  max?: number;
  foot?: Foot;
  hub?: Hub;
  scoring?: Scoring;
}

/** How long the hunt for the round's double may run before the boneyard is made
 *  to give it up: three to six times round the table, drawn fresh each round.
 *  See `floatEngine`. */
export const HUNT_ROUNDS: [min: number, max: number] = [3, 6];

// What a table may be set to. Written once because the engine and the lobby
// both have to agree on it, and a whitelist that exists twice is a whitelist
// that will disagree with itself eventually.
export const FOOTS: Foot[] = [1, 2, 3];
export const SCORINGS: Scoring[] = ['house', 'official', 'pips'];
export const MAXES: number[] = [6, 9, 12];

/** A value off the wire, or the fallback if it isn't one we offer. Anything
 *  else is ignored rather than refused: a client a deploy behind the server
 *  should not be able to fail a table. */
export const oneOf = <T>(choices: readonly T[], v: T | undefined, fallback: T): T =>
  (v !== undefined && choices.includes(v) ? v : fallback);

export class Err extends Error {}

export class Game {
  // Set once, for the whole game.
  variant: Variant;
  /** Tiles the opening double is ringed with. Only Chicken Foot rings one. */
  hub: Hub;
  max: number;
  foot: Foot;
  scoring: Scoring;
  players: EnginePlayer[];
  roundIndex: number;
  status: Status;
  log: LogLine[];

  // Set by startRound(), which the constructor always calls — so these are
  // never actually undefined on a live game. They are declared separately
  // because a round can be dealt again over the top of a finished one.
  boneyard!: TileId[];
  trains!: Train[];
  starter!: number;
  turn!: number;
  pending!: PendingFoot[];
  drewThisTurn!: boolean;
  passStreak!: number;
  lastPlay!: { tile: TileId; trainId: TrainId; segId: number } | null;
  phase!: Phase;
  engineDown!: boolean;
  roundWinner!: PlayerId | null;

  constructor({ players, game = 'mexicanTrain', max = 12, foot = 1, hub = DEFAULT_HUB, scoring = 'house' }: GameOptions) {
    // Before startRound(), which deals through it.
    this.variant = VARIANTS[game] ?? VARIANTS.mexicanTrain;
    this.max = max;
    this.hub = oneOf(HUBS, hub, DEFAULT_HUB);
    // A game that fixes its foot wins over whatever was asked for, so no
    // construction path can produce a table that isn't the game it names.
    this.foot = this.variant.foot ?? oneOf(FOOTS, foot, 1);
    this.scoring = oneOf(SCORINGS, scoring, 'house');
    this.players = players.map((p) => ({
      id: p.id, name: p.name, bot: !!p.bot, temper: p.temper,
      hand: [], score: 0, roundScores: [], openingDone: false, playedSinceMark: false,
    }));
    this.roundIndex = -1;
    this.status = 'idle';
    this.log = [];
    this.startRound();
  }

  get totalRounds() { return this.max + 1; }
  get engine() { return this.max - this.roundIndex; }
  get current() { return this.players[this.turn]; }

  player(id: PlayerId): EnginePlayer | undefined { return this.players.find((p) => p.id === id); }
  train(id: TrainId): Train | undefined { return this.trains.find((t) => t.id === id); }
  seg(train: Train, segId: number): Seg | undefined { return train.segs.find((s) => s.id === segId); }

  // Resolve the train and branch a move names, saying which of the two was
  // wrong. A client that has fallen behind the table will name a branch that
  // has since forked away, so this is an ordinary refusal, not a fault.
  locate(trainId: TrainId, segId: number): { train: Train; seg: Seg } {
    const train = this.train(trainId);
    if (!train) throw new Err('Unknown train.');
    const seg = this.seg(train, segId);
    if (!seg) throw new Err('Unknown branch.');
    return { train, seg };
  }

  // Every action opens the same way: the round has to be live, the table has to
  // be in the phase that action belongs to, and it has to be your turn. Only
  // the phase complaint is passed in — "you can't do that yet" reads differently
  // depending on what you tried to do.
  requireTurn(playerId: PlayerId, phase: Phase, notYet: string, notYours = "It isn't your turn."): EnginePlayer {
    if (this.status !== 'playing') throw new Err('The round is over.');
    if (this.phase !== phase) throw new Err(notYet);
    const p = this.current;
    if (p.id !== playerId) throw new Err(notYours);
    return p;
  }

  note(text: string, kind = 'info'): void {
    this.log.push({ text, kind, n: this.log.length });
    if (this.log.length > 60) this.log.shift();
  }

  // ---------------------------------------------------------------- round setup

  startRound() {
    this.roundIndex++;
    if (this.roundIndex >= this.totalRounds) { this.status = 'gameOver'; return; }

    this.deal();
    this.layTrains();

    this.starter = this.roundIndex % this.players.length;
    this.turn = this.starter;
    this.pending = [];        // open feet: [{train, seg, value, need, placed}]
    this.drewThisTurn = false;
    this.passStreak = 0;
    this.lastPlay = null;
    this.status = 'playing';
    this.phase = 'seeking';   // nobody plays until the engine is on the table
    this.engineDown = false;
    this.roundWinner = null;
    this.note(`Round ${this.roundIndex + 1} — looking for the double ${this.engine}.`, 'round');
    this.seatEngineHolder();
  }

  // The engine double is dealt like any other tile — somebody has to turn it up.
  deal() {
    const deck = shuffle(makeSet(this.max));
    const size = this.variant.deal(this.players.length, this.max);
    for (const p of this.players) {
      p.hand = deck.splice(0, size).sort(sortTiles);
      p.openingDone = false;
    }
    this.boneyard = deck;
    this.floatEngine();
  }

  // A deep boneyard can bury the round's double, and nothing at all happens
  // until it turns up: at two players on a double-12 set it sits about thirty
  // draws down, which is a quarter of an hour of taking turns to flip a tile
  // over before the game starts. So if it is further down than the next few
  // times round the table, it is brought up into that window.
  //
  // A ceiling, not a target: a double sitting near the top is left where the
  // shuffle put it, so a round that would have opened straight away still does,
  // and it can still turn up on the very first draw. Nothing else moves — every
  // other tile keeps the order it was dealt — and this only ever touches the
  // round's own double, so once the engine is down the boneyard is the one the
  // shuffle made. Hands are never touched: if the double was dealt, there is no
  // hunt to shorten.
  floatEngine(rng: () => number = Math.random): void {
    const at = this.boneyard.indexOf(`${this.engine}-${this.engine}`);
    if (at < 0) return;
    const [lo, hi] = HUNT_ROUNDS;
    const rounds = lo + Math.floor(rng() * (hi - lo + 1));
    const window = Math.min(rounds * this.players.length, this.boneyard.length);
    // Drawn from the end, so depth from the top is what says when it turns up.
    if (this.boneyard.length - 1 - at < window) return;
    const [tile] = this.boneyard.splice(at, 1);
    this.boneyard.splice(this.boneyard.length - Math.floor(rng() * window), 0, tile);
  }

  layTrains() {
    this.trains = this.variant.layTrains(this);
  }

  newTrain(id: TrainId, owner: PlayerId | null): Train {
    return {
      id, owner, open: false, nextSeg: 1,
      segs: [{ id: 0, parent: null, from: this.engine, tiles: [], end: this.engine, closed: false }],
    };
  }

  // Point the turn at whoever was dealt the round's double, checked from the
  // lead seat around. They lay it themselves — the table should see who leads,
  // so this never happens behind a player's back.
  seatEngineHolder() {
    const engineTile = `${this.engine}-${this.engine}`;
    for (let i = 0; i < this.players.length; i++) {
      const idx = (this.starter + i) % this.players.length;
      if (this.players[idx].hand.includes(engineTile)) { this.turn = idx; return true; }
    }
    this.note(`Nobody was dealt the double ${this.engine} — drawing for it.`, 'draw');
    return false;
  }

  // Laying the engine is a play in its own right, so it uses up your turn.
  layEngine(playerId: PlayerId): void {
    const p = this.requireTurn(playerId, 'seeking', 'The engine is already down.');
    const engineTile = `${this.engine}-${this.engine}`;
    if (!p.hand.includes(engineTile)) throw new Err(`You don't have the double ${this.engine}.`);

    p.hand.splice(p.hand.indexOf(engineTile), 1);
    this.engineDown = true;
    this.phase = 'play';
    this.note(`${p.name} laid the double ${this.engine} to start.`, 'round');
    this.variant.engineDown(this);
    this.advanceTurn();
  }

  // Hands play on without marking an opening turn as taken — the engine layer
  // still owes their own train a first tile when it comes back round.
  advanceTurn() {
    this.drewThisTurn = false;
    this.turn = (this.turn + 1) % this.players.length;
  }

  // The hunt is not a turn. Nobody has the round's double, so everybody reaches
  // into the boneyard at once and keeps what they get, over and over until it
  // turns up — which is the rule, and is also the only version that is fair.
  //
  // Drawing one at a time round the table, as this did, handed the lead seat
  // more chances at the double than the seat behind it and left the table
  // holding uneven hands before a tile had been played. The turn does not move
  // while the hunt runs: there is nothing to take turns over, and whoever it
  // rests on is only the player whose client asks the table to draw.
  seekDraw(playerId: PlayerId): SeekResult {
    if (this.current.id !== playerId) throw new Err("It isn't your turn.");
    if (!this.boneyard.length) throw new Err('The boneyard is empty.');

    const engineTile = `${this.engine}-${this.engine}`;
    const drawn: Array<{ id: PlayerId; tile: TileId }> = [];
    let found: PlayerId | null = null;

    // Dealt from the lead seat so that a boneyard too shallow to go all the way
    // round runs out in the order the round would have been played in.
    for (let i = 0; i < this.players.length && this.boneyard.length; i++) {
      const p = this.players[(this.starter + i) % this.players.length]!;
      const tile = this.boneyard.pop()!;
      p.hand.push(tile);
      p.hand.sort(sortTiles);
      drawn.push({ id: p.id, tile });
      if (tile === engineTile) found = p.id;
    }

    if (!found) {
      this.note(`Everyone drew — still no double ${this.engine}.`, 'draw');
      return { drawn, found };
    }
    // They lay it themselves, so the turn goes to them rather than the tile
    // going down behind their back.
    this.turn = this.players.findIndex((p) => p.id === found);
    this.note(`${this.player(found)!.name} drew the double ${this.engine}.`, 'draw');
    return { drawn, found };
  }

  // ---------------------------------------------------------------- legality

  footOn(trainId: TrainId, segId: number): PendingFoot | undefined { return this.pending.find((f) => f.train === trainId && f.seg === segId); }

  // The foot, if any, that has this train frozen. At most one can ever be open
  // on a train: a toe has to match the double's value, and the only double that
  // does is the one that opened the foot — so no toe is itself a double, and
  // nothing else on the train can be played to open a second.
  footFreezing(trainId: TrainId): PendingFoot | undefined { return this.pending.find((f) => f.train === trainId); }

  // Which trains this player may touch, ignoring per-segment detail.
  canPlayOn(player: EnginePlayer, train: Train): boolean {
    return this.variant.canPlayOn(this, player, train);
  }

  // The branches of a train that can take a tile at all. An unfilled pigeon foot
  // freezes the whole train: until the last toe is down, the only branch that
  // grows is the one owing toes — not the toes already laid, and not branches
  // that forked off an earlier double. Every other train carries on as normal,
  // and nobody is ever obliged to feed a foot instead of playing elsewhere.
  liveSegs(train: Train): Seg[] {
    const frozen = this.footFreezing(train.id);
    if (frozen) return train.segs.filter((s) => s.id === frozen.seg);
    // A branch that has forked is spent; its toes are the live ends now.
    return train.segs.filter((s) => !s.closed);
  }

  legalMoves(player: EnginePlayer): Move[] {
    if (this.phase !== 'play') return [];
    const moves = [];
    for (const train of this.trains) {
      if (!this.canPlayOn(player, train)) continue;
      // A branch awaiting toes ends on the double's value, so the ordinary
      // end-matching test already picks out exactly the tiles that feed it.
      for (const s of this.liveSegs(train)) {
        for (const tile of player.hand) {
          const [a, b] = parse(tile);
          if (a === s.end || b === s.end) moves.push({ tile, train: train.id, seg: s.id });
        }
      }
    }
    return moves;
  }

  prompt() {
    if (this.status !== 'playing') return null;
    if (this.phase === 'seeking') {
      return this.current.hand.includes(`${this.engine}-${this.engine}`) ? 'engine' : 'seek';
    }
    if (this.legalMoves(this.current).length) return 'play';
    if (this.boneyard.length && !this.drewThisTurn) return 'draw';
    return 'pass';
  }

  // ---------------------------------------------------------------- actions

  play(playerId: PlayerId, tile: TileId, trainId: TrainId, segId: number): void {
    const { p, train, seg, foot, attach, outer } = this.checkPlay(playerId, tile, trainId, segId);

    p.hand.splice(p.hand.indexOf(tile), 1);
    const target = this.attachTile(train, seg, foot, tile, attach, outer);
    const footDone = this.settleFeet(seg, target, foot, tile, trainId, outer);

    this.note(`${p.name} played ${label(tile)} on ${this.whose(train, p)}.`, 'play');
    if (footDone) this.note(`The ${attach} foot filled up — it forks ${this.foot} ways now.`, 'round');
    // A tile went down, so this player has earned the right to close their
    // train again — whenever they choose to, not automatically.
    p.playedSinceMark = true;

    if (p.hand.length === 0) { this.finishRound(p.id); return; }
    this.endTurn();
  }

  // Everything that can refuse a play, in roughly the order a player at the
  // table would notice it: whose turn, whose tile, which train, which branch,
  // then whether the tile actually fits. Throws Err, or hands back the pieces
  // the play itself needs so they aren't looked up twice.
  checkPlay(playerId: PlayerId, tile: TileId, trainId: TrainId, segId: number) {
    const p = this.requireTurn(playerId, 'play', `The double ${this.engine} still has to turn up.`);
    if (!p.hand.includes(tile)) throw new Err("That tile isn't in your hand.");
    const { train, seg } = this.locate(trainId, segId);

    if (!this.canPlayOn(p, train)) {
      if (!p.openingDone) throw new Err('Your first tile must start your own train.');
      throw new Err('That train is closed to you.');
    }
    // An unfilled foot holds up the whole train, so the only branch it leaves
    // playable is the one owing toes.
    const foot = this.footOn(trainId, segId);   // only ever set when this.foot > 1
    if (!foot) {
      const frozen = this.footFreezing(trainId);
      if (frozen) throw new Err(`That train is frozen until its foot fills — it still wants ${owedPhrase(frozen)}.`);
      if (seg.closed) throw new Err('That branch has already forked.');
    }

    const attach = seg.end;
    const [a, b] = parse(tile);
    if (a !== attach && b !== attach) throw new Err(`That tile doesn't match the open ${attach}.`);
    return { p, train, seg, foot, attach, outer: a === attach ? b : a };
  }

  // Feeding a foot starts a fresh branch each time; ordinary play extends the
  // line. Either way the tile lands on `target`, which is what carries on.
  attachTile(train: Train, seg: Seg, foot: PendingFoot | undefined, tile: TileId, attach: number, outer: number): Seg {
    let target = seg;
    if (foot) {
      target = { id: train.nextSeg++, parent: seg.id, from: attach, tiles: [], end: attach, closed: false };
      train.segs.push(target);
    }
    target.tiles.push({ a: attach, b: outer, tile });
    target.end = outer;
    this.lastPlay = { tile, trainId: train.id, segId: target.id };
    this.passStreak = 0;
    return target;
  }

  // Book-keeping for pigeon feet: the one this tile just fed, and the new one it
  // may itself have opened. Returns whether a foot filled up.
  settleFeet(seg: Seg, target: Seg, foot: PendingFoot | undefined, tile: TileId, trainId: TrainId, outer: number): boolean {
    let footDone = false;
    if (foot && ++foot.placed >= foot.need) {
      seg.closed = true;                        // the double's branch is spent; its toes carry on
      this.pending = this.pending.filter((f) => f !== foot);
      footDone = true;
    }
    // A double with a foot of 2 or 3 becomes a branch point that can take that
    // many tiles. With a foot of 1 it is simply a tile like any other.
    if (isDouble(tile) && this.foot > 1) {
      this.pending.push({ train: trainId, seg: target.id, value: outer, need: this.foot, placed: 0 });
    }
    return footDone;
  }

  // How the log refers to the train a tile just landed on.
  whose(train: Train, p: EnginePlayer): string {
    return this.variant.whose(this, train, p);
  }

  draw(playerId: PlayerId): DrawResult | SeekResult | void {
    if (this.status !== 'playing') throw new Err('The round is over.');
    // Drawing is the one action that means something in both phases, so the
    // seeking case is a redirect rather than a refusal — and it hands back a
    // tile per player, not one.
    if (this.phase === 'seeking') return this.seekDraw(playerId);
    const p = this.requireTurn(playerId, 'play', 'The round is over.');
    if (this.drewThisTurn) throw new Err('You already drew this turn.');
    if (!this.boneyard.length) throw new Err('The boneyard is empty.');
    if (this.legalMoves(p).length) throw new Err('You have a playable tile — you must play it.');

    const tile = this.boneyard.pop()!;   // guarded above: the boneyard is not empty
    p.hand.push(tile);
    p.hand.sort(sortTiles);
    this.drewThisTurn = true;
    this.note(`${p.name} drew from the boneyard.`, 'draw');

    if (!this.legalMoves(p).length) {
      // Nothing to decide here — the marker goes up and the turn is over.
      this.autoMark(p);
      return { tile, playable: false, ended: true };
    }
    return { tile, playable: true };
  }

  // Being unable to play is forced, so where there are markers the marker goes
  // up for you. Choosing to raise or lower it at any other point is still
  // entirely yours. Where there are none — no train belongs to anybody — being
  // stuck is simply the end of your turn, and there is nothing to announce.
  autoMark(p: EnginePlayer): void {
    // The turn that could not find a play is the turn that takes the right to
    // close your train away again.
    p.playedSinceMark = false;
    const train = this.variant.markers ? this.train(p.id) : undefined;
    if (train && !train.open) { train.open = true; this.note(`${p.name} can't play — marker up.`, 'mark'); }
    else this.note(`${p.name} can't play.`, 'mark');
    this.passStreak++;
    this.endTurn();
  }

  pass(playerId: PlayerId): void {
    const p = this.requireTurn(playerId, 'play', 'Draw for the engine first.');
    if (this.legalMoves(p).length) throw new Err('You have a playable tile — you must play it.');
    if (this.boneyard.length && !this.drewThisTurn) throw new Err('You must draw first.');
    this.autoMark(p);
  }

  // *When* a marker moves is the player's call, and not only on their own turn:
  // playing a tile ends the turn, so a marker meant to come down after a play
  // would otherwise have no moment to come down in, and would sit up for a
  // whole lap while everyone else had a go at the train it was exposing.
  //
  // *Whether* it may come down is not the player's call. A marker goes up
  // because you could not play, and it is playing that earns it back — so a
  // turn that ended in a draw and a shrug leaves the train open, which is the
  // entire point of having put a marker on it.
  marker(playerId: PlayerId, up: boolean): void {
    const { p, train } = this.requireMarker(playerId);
    if (train.open === !!up) return;
    if (!up && !p.playedSinceMark) throw new Err('Play a tile before taking your marker down.');
    train.open = !!up;
    this.note(`${p.name} ${up ? 'put their marker up' : 'took their marker down'}.`, 'mark');
  }

  // Everything that has to be true before a marker can move at all, as against
  // the one thing that decides which way it may move.
  requireMarker(playerId: PlayerId): { p: EnginePlayer; train: Train } {
    if (!this.variant.markers) throw new Err(`There are no markers in ${this.variant.title}.`);
    if (this.status !== 'playing') throw new Err('The round is over.');
    if (this.phase !== 'play') throw new Err('The round has not started.');
    const p = this.player(playerId);
    const train = p ? this.train(playerId) : undefined;
    if (!p || !train) throw new Err("You don't have a train at this table.");
    return { p, train };
  }

  // Somebody else has taken this seat over. The hand, the train and the score
  // stay exactly where they are — they belong to the seat, not to whoever was
  // sitting in it — but the identity moves across, which is what makes the old
  // occupant unable to pick the seat back up and the new one able to.
  //
  // Every reference to the old id has to travel with it, or the seat is left
  // holding a hand it can no longer play.
  reseat(from: PlayerId, to: PlayerId): void {
    const p = this.player(from);
    if (!p) throw new Err('There is nobody in that seat.');
    if (this.player(to)) throw new Err('They are already at this table.');
    p.id = to;
    this.reseatTrains(from, to);
    if (this.lastPlay?.trainId === from) this.lastPlay.trainId = to;
    if (this.roundWinner === from) this.roundWinner = to;
  }

  // A player's train is keyed by their id twice over — it *is* the train id as
  // well as its owner — and an open foot is keyed by the train, so the three
  // move together or a frozen train is left owing toes to a train that has
  // stopped existing, which nothing can then thaw.
  reseatTrains(from: PlayerId, to: PlayerId): void {
    for (const t of this.trains) {
      if (t.id === from) t.id = to;
      if (t.owner === from) t.owner = to;
    }
    for (const f of this.pending) if (f.train === from) f.train = to;
  }

  forceSkip(playerId: PlayerId): void {
    if (this.status !== 'playing' || this.current.id !== playerId) return;
    if (this.phase === 'seeking') { this.turn = (this.turn + 1) % this.players.length; return; }
    this.passStreak++;
    this.endTurn();
  }

  endTurn() {
    this.current.openingDone = true;
    this.drewThisTurn = false;
    this.turn = (this.turn + 1) % this.players.length;
    if (this.passStreak >= this.players.length && !this.boneyard.length) {
      this.note('Everyone is blocked — the round ends.', 'round');
      this.finishRound(null);
    }
  }

  // house    — blanks are free, but the 0|0 stings (the rule at this table)
  // official — every blank side is 25, the 0|0 is 50
  // pips     — straight dot count, nothing special
  tileScore(id: TileId): number {
    const [a, b] = parse(id);
    if (a === 0 && b === 0) return this.scoring === 'pips' ? 0 : 50;
    if (this.scoring === 'official') return (a === 0 ? 25 : a) + (b === 0 ? 25 : b);
    return a + b;
  }

  finishRound(winnerId: PlayerId | null): void {
    this.status = 'roundOver';
    this.roundWinner = winnerId;
    for (const p of this.players) {
      const points = p.hand.reduce((s, t) => s + this.tileScore(t), 0);
      p.roundScores.push(points);
      p.score += points;
    }
    if (winnerId) this.note(`${this.player(winnerId)!.name} went out!`, 'win');
    if (this.roundIndex + 1 >= this.totalRounds) this.status = 'gameOver';
  }

  // ---------------------------------------------------------------- serialisation

  // The variant is behaviour, not state, and behaviour does not cross a storage
  // boundary: the Durable Object writes with structured clone, which refuses an
  // object carrying functions outright. So what is stored is the variant's
  // name, and `reviveGame` puts the object back on the way in.
  toJSON(): Record<string, unknown> {
    const { variant, ...rest } = this;
    return { ...rest, game: variant.name };
  }

  view(forId: PlayerId): EngineGameView {
    const me = this.player(forId);
    const yours = this.status === 'playing' && me && this.current.id === forId;
    return {
      game: this.variant.name,
      max: this.max,
      foot: this.foot,
      hub: this.hub,
      scoring: this.scoring,
      round: this.roundIndex + 1,
      totalRounds: this.totalRounds,
      engine: this.engine,
      engineDown: this.engineDown,
      phase: this.phase,
      status: this.status,
      turn: this.status === 'playing' ? this.current.id : null,
      prompt: yours ? this.prompt() : null,
      pending: this.pending.map((f) => ({ train: f.train, seg: f.seg, value: f.value, need: f.need, placed: f.placed })),
      boneyard: this.boneyard.length,
      lastPlay: this.lastPlay,
      roundWinner: this.roundWinner,
      log: this.log.slice(-14),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, bot: p.bot, tiles: p.hand.length,
        score: p.score, roundScores: p.roundScores, openingDone: p.openingDone,
        playedSinceMark: p.playedSinceMark,
        // Temperaments stay secret until the game is over and can't be exploited.
        temper: this.status === 'gameOver' && p.bot ? p.temper : undefined,
      })),
      trains: this.trains.map((t) => ({
        id: t.id, owner: t.owner, open: t.open,
        playable: yours ? this.canPlayOn(me, t) : false,
        segs: t.segs.map((s) => {
          const f = this.footOn(t.id, s.id);
          return {
            id: s.id, parent: s.parent, from: s.from, end: s.end, closed: s.closed,
            tiles: s.tiles.map(({ a, b, tile }) => ({ a, b, tile })),
            foot: f ? { need: f.need, placed: f.placed, value: f.value } : null,
          };
        }),
      })),
      hand: me ? me.hand : [],
      moves: yours ? this.legalMoves(me) : [],
    };
  }
}

