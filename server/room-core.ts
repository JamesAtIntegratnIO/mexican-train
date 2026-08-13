// The room, with no idea what a socket or a timer is.
//
// Connections are opaque ids; the host platform maps them to real sockets and
// decides how to run the bot clock. Node uses setTimeout and keeps this object
// in memory; a Durable Object uses alarms and rehydrates it from storage. Both
// share this file, so the rules of the table can't drift between them.

import { Game, Err, maxPlayersFor, handSize } from './game.js';
import type { EnginePlayer, DrawResult } from './game.js';
import { chooseMove, botName, randomTemper } from './bots.js';
import { log } from './log.js';
import { metrics } from './metrics.js';
import type { ClearedWhy, TableSample } from './metrics.js';
import type {
  PlayerId, Settings, RoomSnapshot, GameView, EngineGameView, ChatLine, ClientMessage,
} from '../shared/protocol.js';

/** A connection handle. The core never looks inside one — it only ever hands it
 *  back to the adapter — which is exactly what lets a Node socket and a
 *  hibernatable Durable Object socket be the same thing here. */
export type Conn = unknown;

export interface Seat {
  id: PlayerId;
  /** Never set on a seated player. Present so `Seat | Watcher` discriminates on
   *  it — the one question every caller asks of a member is which they are. */
  spectator?: false;
  name: string;
  bot: boolean;
  temper?: number;
  conn: Conn | null;
  connected: boolean;
  lastSeen?: number;
}

export interface Watcher {
  id: PlayerId;
  name: string;
  conn: Conn | null;
  connected: boolean;
  spectator: true;
}

/** What a host must provide. Every method is optional so a room can be built
 *  with no adapter at all, which is what the tests do when they only care about
 *  the table's state. */
export interface Adapter {
  send?(conn: Conn, obj: unknown): void;
  close?(conn: Conn, code: number, reason: string): void;
  scheduleBot?(delayMs: number): void;
  cancelBot?(): void;
  onChange?(): void;
}


export { Err };

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const CODE_LEN = 6;                    // 32^6 ≈ 1.07e9 — not worth sweeping
export const MAX_PLAYERS = 8;
export const MAX_WATCHERS = 20;

export const BOT_DELAY: readonly [number, number] = [700, 1500];
export const ABSENT_TAKEOVER_MS = 15000;

// Rejection sampling off crypto bytes — no modulo bias, and not guessable the
// way Math.random() codes were. Web Crypto so it runs unchanged on Workers.
export function newCode(len: number = CODE_LEN): string {
  const out = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;                       // drop the biased tail
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
      if (out.length === len) break;
    }
  }
  return out.join('');
}

export function rid(n = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '').slice(0, n);
}

const clean = (name: unknown, fallback: string): string => {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return s || fallback;
};
const wait = ([lo, hi]: readonly [number, number]): number => lo + Math.random() * (hi - lo);

/** A throttle key has to be a string, and a thrown value is not necessarily an
 *  Error — keying on the message is what keeps one recurring fault to one line
 *  a minute without hiding a different one behind it. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A Game is plain data plus methods, so it round-trips through JSON intact.
const reviveGame = (data: unknown): Game | null => (data ? Object.assign(Object.create(Game.prototype), data) : null);

/** Running totals for the one telemetry line this table will ever produce.
 *
 *  Kept as the table goes rather than worked out at the end, because by the end
 *  most of it is gone: a lobby seat is removed the moment its player leaves, a
 *  watcher likewise, and a table is only cleared once everyone has left. Asking
 *  "how many people were here" at disposal time answers zero almost every time,
 *  which is how an abandoned lobby and a table nobody ever opened came to look
 *  identical in the logs. */
export interface RoomStats {
  peakPlayers: number;
  peakWatchers: number;
  humans: number;
  bots: number;
  moves: number;
  rounds: number;
  finished: boolean;
}

const newStats = (): RoomStats => ({ peakPlayers: 0, peakWatchers: 0, humans: 0, bots: 0, moves: 0, rounds: 0, finished: false });

// Why a table was cleared, and what the people at it are told. These were one
// string until the first of them had to be counted: a sentence is the right
// thing to show a player and the wrong thing to group a metric by.
const CLEARED: Record<ClearedWhy, string> = {
  empty: 'Everyone left this table, so it was cleared.',
  idle: 'This table sat idle for a while and was cleared. Start a new one.',
  other: 'This table was cleared.',
};

const clearedMessage = (why: ClearedWhy): string => CLEARED[why];

export class Room {
  code: string;
  adapter: Adapter;
  createdAt: number;
  /** When the last person left, or null while anyone is still here. */
  emptySince: number | null;
  lastActivity: number;
  players: Seat[];
  watchers: Watcher[];
  hostId: PlayerId | null;
  settings: Settings;
  game: Game | null;
  chat: ChatLine[];
  stats: RoomStats;

  // adapter: { send(conn, obj), close(conn, code, reason), scheduleBot(delayMs), cancelBot(), onChange() }
  constructor(code: string, adapter: Adapter = {}) {
    this.code = code;
    this.adapter = adapter;
    this.createdAt = Date.now();
    this.emptySince = Date.now();
    this.lastActivity = Date.now();
    this.players = [];       // {id, name, bot, temper, conn, connected, lastSeen}
    this.watchers = [];      // spectators — named, but they hold no tiles
    this.hostId = null;
    this.settings = { max: 12, foot: 1, scoring: 'house' };
    this.game = null;
    this.chat = [];
    this.stats = newStats();
  }

  // ------------------------------------------------------------------ persistence

  toJSON(): Record<string, unknown> {
    const strip = (p: Seat | Watcher) => ({ ...p, conn: null, connected: false });
    return {
      code: this.code, createdAt: this.createdAt, emptySince: this.emptySince,
      lastActivity: this.lastActivity, hostId: this.hostId, settings: this.settings,
      chat: this.chat, game: this.game, stats: this.stats,
      players: this.players.map(strip), watchers: this.watchers.map(strip),
    };
  }

  static revive(data: any, adapter: Adapter): Room {
    const r = new Room(data.code, adapter);
    // Stats are merged over the defaults rather than assigned: a table stored
    // by the previous deploy has no `stats` at all, or an older shape of one,
    // and a counter that comes back undefined would poison every sum it lands
    // in. Missing means zero, which is the truth about a table we weren't
    // counting yet.
    Object.assign(r, data, { adapter, game: reviveGame(data.game), stats: { ...r.stats, ...data.stats } });
    return r;
  }

  // ------------------------------------------------------------------ membership

  join(conn: Conn, { pid, name, spectate }: { pid?: PlayerId | null; name?: string; spectate?: boolean }): Seat | Watcher {
    if (spectate) return this.watch(conn, { pid, name });
    const seat = pid && this.players.find((x) => x.id === pid);
    const p = seat ? this.reclaimSeat(seat, conn, name) : this.takeSeat(conn, name);
    if (!this.hostId || !this.players.some((x) => x.id === this.hostId && x.connected && !x.bot)) this.reassignHost();
    this.emptySince = null;
    return p; // caller sends the identity message, then ticks — order matters to the client
  }

  // A second connection for an identity that is already at the table supersedes
  // the first — a reload, or the same link opened in another tab. Shared by
  // players and watchers, who reconnect on identical terms.
  adopt(member: Seat | Watcher, conn: Conn): void {
    if (member.conn && member.conn !== conn) this.adapter.close?.(member.conn, 4001, 'Reconnected elsewhere');
    member.conn = conn;
    member.connected = true;
  }

  // A returning human takes their seat back off the bot that stood in for them.
  reclaimSeat(p: Seat, conn: Conn, name?: string): Seat {
    this.adopt(p, conn);
    p.bot = false;
    if (this.game) this.game.player(p.id)!.bot = false;
    if (name) p.name = clean(name, p.name);
    return p;
  }

  takeSeat(conn: Conn, name?: string): Seat {
    if (this.game) throw new Err('That game is already under way.');
    if (this.players.length >= MAX_PLAYERS) throw new Err('This table is full (8 players).');
    const p = { id: rid(), name: clean(name, `Player ${this.players.length + 1}`), bot: false, conn, connected: true, lastSeen: Date.now() };
    this.players.push(p);
    this.stats.humans++;               // a seat taken, not a seat currently held
    this.say(`${p.name} joined.`);
    return p;
  }

  // Spectators may arrive at any point, including mid-game, but must say who
  // they are — the table always knows exactly who is watching.
  watch(conn: Conn, { pid, name }: { pid?: PlayerId | null; name?: string }): Watcher {
    const nm = clean(name, '');
    if (!nm) throw new Err('Give a name before watching.');
    let w = pid && this.watchers.find((x) => x.id === pid);
    if (w) {
      this.adopt(w, conn);
      w.name = nm;
    } else {
      if (this.watchers.length >= MAX_WATCHERS) throw new Err('Too many people are watching already.');
      w = { id: rid(), name: nm, conn, connected: true, spectator: true };
      this.watchers.push(w);
      this.say(`${w.name} is watching.`);
    }
    this.emptySince = null;
    return w;
  }

  member(id: PlayerId): Seat | Watcher | undefined { return this.players.find((x) => x.id === id) || this.watchers.find((x) => x.id === id); }
  watcher(id: PlayerId): Watcher | undefined { return this.watchers.find((x) => x.id === id); }
  anyoneHere(): boolean { return this.players.some((x) => x.connected) || this.watchers.some((x) => x.connected); }

  leave(conn: Conn): void {
    const w = this.watchers.find((x) => x.conn === conn);
    if (w) {
      this.watchers = this.watchers.filter((x) => x !== w);
      this.say(`${w.name} stopped watching.`);
      if (!this.anyoneHere()) this.emptySince = Date.now();
      return this.tick();
    }
    const p = this.players.find((x) => x.conn === conn);
    if (!p) return;
    p.conn = null; p.connected = false; p.lastSeen = Date.now();
    if (!this.game) {
      this.players = this.players.filter((x) => x !== p);
      this.say(`${p.name} left.`);
    }
    if (this.hostId === p.id) this.reassignHost();
    if (!this.anyoneHere()) this.emptySince = Date.now();
    this.tick();
  }

  reassignHost(): void {
    const next = this.players.find((x) => x.connected && !x.bot) || this.players.find((x) => !x.bot);
    this.hostId = next ? next.id : null;
  }

  requireHost(id: PlayerId): void { if (id !== this.hostId) throw new Err('Only the host can do that.'); }

  addBot(byId: PlayerId): void {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if (this.players.length >= MAX_PLAYERS) throw new Err('This table is full (8 players).');
    const p = { id: rid(), name: botName(this.players.map((x) => x.name)), bot: true, temper: randomTemper(), conn: null, connected: true };
    this.players.push(p);
    this.stats.bots++;
    this.say(`${p.name} (bot) joined.`);
    this.tick();
  }

  removePlayer(byId: PlayerId, targetId: PlayerId): void {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if (targetId === this.hostId) throw new Err("You can't remove yourself.");
    const p = this.players.find((x) => x.id === targetId);
    if (!p) return;
    this.players = this.players.filter((x) => x !== p);
    if (p.conn) this.adapter.close?.(p.conn, 4002, 'Removed');
    this.say(`${p.name} was removed.`);
    this.tick();
  }

  rename(id: PlayerId, name: string): void {
    const p = this.member(id);
    if (!p) return;
    p.name = clean(name, p.name);
    if (this.game) { const g = this.game.player(id); if (g) g.name = p.name; }
    this.tick();
  }

  setSettings(byId: PlayerId, s: Partial<Settings>): void {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if (s.max !== undefined && [6, 9, 12].includes(s.max)) this.settings.max = s.max;
    if (s.foot !== undefined && [1, 2, 3].includes(s.foot)) this.settings.foot = s.foot;
    if (s.scoring !== undefined && ['house', 'official', 'pips'].includes(s.scoring)) this.settings.scoring = s.scoring;
    this.tick();
  }

  // ------------------------------------------------------------------ game flow

  start(byId: PlayerId): void {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if (this.players.length < 2) throw new Err('You need at least 2 players.');
    const seats = maxPlayersFor(this.settings.max);
    if (this.players.length > seats) {
      throw new Err(`A double-${this.settings.max} set only seats ${seats}. Pick a bigger set or drop a player.`);
    }
    this.game = new Game({
      players: this.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, temper: p.temper ?? randomTemper() })),
      max: this.settings.max, foot: this.settings.foot, scoring: this.settings.scoring,
    });
    this.tick();
  }

  nextRound(byId: PlayerId): void {
    this.requireHost(byId);
    if (!this.game || this.game.status !== 'roundOver') throw new Err('The round is still in play.');
    this.game.startRound();
    this.tick();
  }

  playAgain(byId: PlayerId): void {
    this.requireHost(byId);
    this.game = null;
    this.players = this.players.filter((p) => p.connected || p.bot);
    this.say('New game — back to the lobby.');
    this.tick();
  }

  act(id: PlayerId, msg: ClientMessage): DrawResult | void {
    if (!this.game) throw new Err('The game has not started.');
    if (msg.t === 'play') this.game.play(id, msg.tile, msg.train, msg.seg);
    else if (msg.t === 'draw') { const r = this.game.draw(id); this.stats.moves++; this.tick(); return r; }
    else if (msg.t === 'pass') this.game.pass(id);
    else if (msg.t === 'marker') this.game.marker(id, msg.up);
    else if (msg.t === 'engine') this.game.layEngine(id);
    // Counted after the engine accepted it, so an illegal move is not a move. A
    // marker is a flag on a train rather than a turn taken, so it isn't one
    // either — otherwise every bot pass would score two.
    if (msg.t !== 'marker') this.stats.moves++;
    this.tick();
  }

  fillSeat(byId: PlayerId, targetId: PlayerId): void {
    this.requireHost(byId);
    const p = this.players.find((x) => x.id === targetId);
    if (!p || p.bot || p.connected) throw new Err('That seat is still occupied.');
    p.bot = true;
    if (this.game) this.game.player(p.id)!.bot = true;
    this.say(`${p.name} is now played by a bot.`);
    this.tick();
  }

  // ------------------------------------------------------------------ automation

  // Who, if anyone, the clock is waiting on — a bot, or someone who dropped.
  pendingSeat(): { seat: Seat; delay: number } | null {
    const g = this.game;
    if (!g || g.status !== 'playing') return null;
    const seat = this.players.find((x) => x.id === g.current.id);
    if (!seat) return null;
    const absent = !seat.bot && !seat.connected;
    if (!seat.bot && !absent) return null;
    return { seat, delay: absent ? ABSENT_TAKEOVER_MS : wait(BOT_DELAY) };
  }

  schedule(): void {
    this.adapter.cancelBot?.();
    const pending = this.pendingSeat();
    if (pending) this.adapter.scheduleBot?.(pending.delay);
  }

  // Play one automated turn. Returns true if the board moved.
  runBot(): boolean {
    const g = this.game;
    if (!g || g.status !== 'playing') return false;
    const seat = this.players.find((x) => x.id === g.current.id);
    if (!seat || (!seat.bot && seat.connected)) return false;
    try { this.takeBotTurn(g, seat); }
    catch (e) { this.botWedged(g, seat, e); }
    this.tick();
    return true;
  }

  takeBotTurn(g: Game, seat: Seat): void {
    const mv = chooseMove(g, seat.id);
    // Markers are manual, so bots have to work theirs deliberately — and only
    // while it is still their turn, hence before the move lands.
    if (g.phase === 'play') {
      if (mv.type === 'pass') g.marker(seat.id, true);
      else if (mv.type === 'play' && mv.train === seat.id) g.marker(seat.id, false);
    }
    if (mv.type === 'engine') g.layEngine(seat.id);
    else if (mv.type === 'play') g.play(seat.id, mv.tile, mv.train, mv.seg);
    else if (mv.type === 'draw') g.draw(seat.id);
    else g.pass(seat.id);
    this.stats.moves++;              // a bot's turn is a turn like anyone's
  }

  // A bot only ever picks from legalMoves(), so landing here means the rules
  // engine contradicted itself — the one bug class worth waking up for. Log
  // everything needed to rebuild the position, then give up the turn rather than
  // let a bad move wedge the table.
  //
  // Throttled by the fault: a position the engine keeps mishandling comes round
  // again every bot turn, and one line a minute says as much as hundreds would.
  botWedged(g: Game, seat: Seat, e: unknown): void {
    log.throttle('error', 'bot_move_failed', {
      code: this.code, seat: seat.id, phase: g.phase, round: g.roundIndex,
      boneyard: g.boneyard.length, hand: g.player(seat.id)?.hand.length, err: e,
    }, `bot:${errText(e)}`);
    try { g.pass(seat.id); }
    catch (e2) {
      log.throttle('error', 'bot_pass_failed', { code: this.code, seat: seat.id, err: e2 }, `botpass:${errText(e2)}`);
      g.forceSkip(seat.id);
    }
  }

  // ------------------------------------------------------------------ lifetime

  // A game in play never expires, however long it runs. Answers with the reason
  // code; clearedMessage() turns that into the sentence the players see.
  expiry(emptyGraceMs: number, idleMs: number, now = Date.now()): ClearedWhy | null {
    if (this.emptySince && now - this.emptySince > emptyGraceMs) return 'empty';
    if (now - this.lastActivity > idleMs) return 'idle';
    return null;
  }

  // ------------------------------------------------------------------ output

  say(text: string): void {
    this.chat.push({ system: true, text, ts: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
  }

  chatFrom(id: PlayerId, text: unknown): void {
    const p = this.member(id);
    if (!p) return;
    const body = String(text || '').slice(0, 240).trim();
    if (!body) return;
    this.chat.push({ from: p.name, text: body, ts: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
    this.tick();
  }

  // The rules engine has no idea whether anyone is on the other end of a
  // socket, so the room stitches presence into the players it produced. Doing
  // it here means the client gets one list to render rather than two it has to
  // join by id at paint time.
  withPresence(view: EngineGameView): GameView {
    return {
      ...view,
      players: view.players.map((p) => ({
        ...p,
        connected: !!this.players.find((x) => x.id === p.id)?.connected,
      })),
    };
  }

  snapshot(forId: PlayerId): RoomSnapshot {
    return {
      t: 'room',
      code: this.code,
      youId: forId,
      hostId: this.hostId,
      settings: { ...this.settings, seats: maxPlayersFor(this.settings.max), deal: handSize(Math.max(2, this.players.length), this.settings.max) },
      phase: this.game ? 'game' : 'lobby',
      seats: this.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, connected: p.connected })),
      watchers: this.watchers.map((w) => ({ id: w.id, name: w.name, connected: w.connected })),
      spectating: !!this.watcher(forId),
      chat: this.chat.slice(-30),
      game: this.game ? this.withPresence(this.game.view(forId)) : null,   // an unknown id yields the public view: no hand, no moves
    };
  }

  // Every state change funnels through tick(), so this is the honest definition
  // of "something happened" — including bots taking their turns.
  tick(): void {
    this.lastActivity = Date.now();
    this.count();
    for (const p of [...this.players, ...this.watchers]) {
      if (p.conn) this.adapter.send?.(p.conn, this.snapshot(p.id));
    }
    this.schedule();
    this.adapter.onChange?.();
  }

  // Every state change funnels through tick(), so this is the cheapest honest
  // place to take the measurements that only make sense as a high-water mark.
  // Round progress is read rather than counted for the same reason it is kept
  // at all: playAgain() throws the game away, and a table that played two games
  // has played both of them.
  count(): void {
    const s = this.stats;
    if (this.players.length > s.peakPlayers) s.peakPlayers = this.players.length;
    if (this.watchers.length > s.peakWatchers) s.peakWatchers = this.watchers.length;
    if (!this.game) return;
    s.rounds = Math.max(s.rounds, this.game.roundIndex + 1);
    s.finished ||= this.game.status === 'gameOver';
  }

  /** The table's whole story, assembled at the one moment all of it is true. */
  sample(why: ClearedWhy): TableSample {
    const { peakPlayers, peakWatchers, humans, bots, rounds, finished, moves } = this.stats;
    return {
      why, scoring: this.settings.scoring, max: this.settings.max, foot: this.settings.foot,
      ageMin: Math.round((Date.now() - this.createdAt) / 60_000),
      peakPlayers, peakWatchers, humans, bots, rounds, finished, moves,
    };
  }

  dispose(why?: ClearedWhy): void {
    const sample = this.sample(why ?? 'other');
    // The single line a table costs, and now the single line that says whether
    // it was ever played. The same numbers go to metrics, where they can be
    // summed without anyone parsing a log.
    log.info('room_disposed', { code: this.code, ...sample });
    metrics.table(sample);
    this.adapter.cancelBot?.();
    for (const p of [...this.players, ...this.watchers]) {
      if (!p.conn) continue;
      // Say why, so anyone still looking at the page doesn't just see it die.
      if (why) this.adapter.send?.(p.conn, { t: 'fatal', msg: clearedMessage(why) });
      this.adapter.close?.(p.conn, 4003, 'Room closed');
    }
  }
}
