// The room, with no idea what a socket or a timer is.
//
// Connections are opaque ids; the host platform maps them to real sockets and
// decides how to run the bot clock. Node uses setTimeout and keeps this object
// in memory; a Durable Object uses alarms and rehydrates it from storage. Both
// share this file, so the rules of the table can't drift between them.

import { Game, Err, maxPlayersFor, handSize } from './game.js';
import { chooseMove, botName, randomTemper } from './bots.js';

export { Err };

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const CODE_LEN = 6;                    // 32^6 ≈ 1.07e9 — not worth sweeping
export const MAX_PLAYERS = 8;
export const MAX_WATCHERS = 20;

export const BOT_DELAY = [700, 1500];
export const ABSENT_TAKEOVER_MS = 15000;

// Rejection sampling off crypto bytes — no modulo bias, and not guessable the
// way Math.random() codes were. Web Crypto so it runs unchanged on Workers.
export function newCode(len = CODE_LEN) {
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

export function rid(n = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '').slice(0, n);
}

const clean = (name, fallback) => {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return s || fallback;
};
const wait = ([lo, hi]) => lo + Math.random() * (hi - lo);

// A Game is plain data plus methods, so it round-trips through JSON intact.
const reviveGame = (data) => (data ? Object.assign(Object.create(Game.prototype), data) : null);

export class Room {
  // adapter: { send(conn, obj), close(conn, code, reason), scheduleBot(delayMs), cancelBot(), onChange() }
  constructor(code, adapter = {}) {
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
  }

  // ------------------------------------------------------------------ persistence

  toJSON() {
    const strip = (p) => ({ ...p, conn: null, connected: false });
    return {
      code: this.code, createdAt: this.createdAt, emptySince: this.emptySince,
      lastActivity: this.lastActivity, hostId: this.hostId, settings: this.settings,
      chat: this.chat, game: this.game,
      players: this.players.map(strip), watchers: this.watchers.map(strip),
    };
  }

  static revive(data, adapter) {
    const r = new Room(data.code, adapter);
    Object.assign(r, data, { adapter, game: reviveGame(data.game) });
    return r;
  }

  // ------------------------------------------------------------------ membership

  join(conn, { pid, name, spectate }) {
    if (spectate) return this.watch(conn, { pid, name });
    let p = pid && this.players.find((x) => x.id === pid);
    if (p) {
      if (p.conn && p.conn !== conn) this.adapter.close?.(p.conn, 4001, 'Reconnected elsewhere');
      p.conn = conn; p.connected = true; p.bot = false;  // a returning human reclaims their seat from the bot
      if (this.game) this.game.player(p.id).bot = false;
      if (name) p.name = clean(name, p.name);
    } else {
      if (this.game) throw new Err('That game is already under way.');
      if (this.players.length >= MAX_PLAYERS) throw new Err('This table is full (8 players).');
      p = { id: rid(), name: clean(name, `Player ${this.players.length + 1}`), bot: false, conn, connected: true, lastSeen: Date.now() };
      this.players.push(p);
      this.say(`${p.name} joined.`);
    }
    if (!this.hostId || !this.players.some((x) => x.id === this.hostId && x.connected && !x.bot)) this.reassignHost();
    this.emptySince = null;
    return p; // caller sends the identity message, then ticks — order matters to the client
  }

  // Spectators may arrive at any point, including mid-game, but must say who
  // they are — the table always knows exactly who is watching.
  watch(conn, { pid, name }) {
    const nm = clean(name, '');
    if (!nm) throw new Err('Give a name before watching.');
    let w = pid && this.watchers.find((x) => x.id === pid);
    if (w) {
      if (w.conn && w.conn !== conn) this.adapter.close?.(w.conn, 4001, 'Reconnected elsewhere');
      w.conn = conn; w.connected = true; w.name = nm;
    } else {
      if (this.watchers.length >= MAX_WATCHERS) throw new Err('Too many people are watching already.');
      w = { id: rid(), name: nm, conn, connected: true, spectator: true };
      this.watchers.push(w);
      this.say(`${w.name} is watching.`);
    }
    this.emptySince = null;
    return w;
  }

  member(id) { return this.players.find((x) => x.id === id) || this.watchers.find((x) => x.id === id); }
  watcher(id) { return this.watchers.find((x) => x.id === id); }
  anyoneHere() { return this.players.some((x) => x.connected) || this.watchers.some((x) => x.connected); }

  leave(conn) {
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

  reassignHost() {
    const next = this.players.find((x) => x.connected && !x.bot) || this.players.find((x) => !x.bot);
    this.hostId = next ? next.id : null;
  }

  requireHost(id) { if (id !== this.hostId) throw new Err('Only the host can do that.'); }

  addBot(byId) {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if (this.players.length >= MAX_PLAYERS) throw new Err('This table is full (8 players).');
    const p = { id: rid(), name: botName(this.players.map((x) => x.name)), bot: true, temper: randomTemper(), conn: null, connected: true };
    this.players.push(p);
    this.say(`${p.name} (bot) joined.`);
    this.tick();
  }

  removePlayer(byId, targetId) {
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

  rename(id, name) {
    const p = this.member(id);
    if (!p) return;
    p.name = clean(name, p.name);
    if (this.game) { const g = this.game.player(id); if (g) g.name = p.name; }
    this.tick();
  }

  setSettings(byId, s) {
    this.requireHost(byId);
    if (this.game) throw new Err('The game has already started.');
    if ([6, 9, 12].includes(s.max)) this.settings.max = s.max;
    if ([1, 2, 3].includes(s.foot)) this.settings.foot = s.foot;
    if (['house', 'official', 'pips'].includes(s.scoring)) this.settings.scoring = s.scoring;
    this.tick();
  }

  // ------------------------------------------------------------------ game flow

  start(byId) {
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

  nextRound(byId) {
    this.requireHost(byId);
    if (!this.game || this.game.status !== 'roundOver') throw new Err('The round is still in play.');
    this.game.startRound();
    this.tick();
  }

  playAgain(byId) {
    this.requireHost(byId);
    this.game = null;
    this.players = this.players.filter((p) => p.connected || p.bot);
    this.say('New game — back to the lobby.');
    this.tick();
  }

  act(id, msg) {
    if (!this.game) throw new Err('The game has not started.');
    if (msg.t === 'play') this.game.play(id, msg.tile, msg.train, msg.seg);
    else if (msg.t === 'draw') { const r = this.game.draw(id); this.tick(); return r; }
    else if (msg.t === 'pass') this.game.pass(id);
    else if (msg.t === 'marker') this.game.marker(id, msg.up);
    else if (msg.t === 'engine') this.game.layEngine(id);
    this.tick();
  }

  fillSeat(byId, targetId) {
    this.requireHost(byId);
    const p = this.players.find((x) => x.id === targetId);
    if (!p || p.bot || p.connected) throw new Err('That seat is still occupied.');
    p.bot = true;
    if (this.game) this.game.player(p.id).bot = true;
    this.say(`${p.name} is now played by a bot.`);
    this.tick();
  }

  // ------------------------------------------------------------------ automation

  // Who, if anyone, the clock is waiting on — a bot, or someone who dropped.
  pendingSeat() {
    const g = this.game;
    if (!g || g.status !== 'playing') return null;
    const seat = this.players.find((x) => x.id === g.current.id);
    if (!seat) return null;
    const absent = !seat.bot && !seat.connected;
    if (!seat.bot && !absent) return null;
    return { seat, delay: absent ? ABSENT_TAKEOVER_MS : wait(BOT_DELAY) };
  }

  schedule() {
    this.adapter.cancelBot?.();
    const pending = this.pendingSeat();
    if (pending) this.adapter.scheduleBot?.(pending.delay);
  }

  // Play one automated turn. Returns true if the board moved.
  runBot() {
    const g = this.game;
    if (!g || g.status !== 'playing') return false;
    const seat = this.players.find((x) => x.id === g.current.id);
    if (!seat || (!seat.bot && seat.connected)) return false;
    try {
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
    } catch (e) {
      // Never let a bot wedge the table: give up the turn outright.
      console.error('bot move failed', e);
      try { g.pass(seat.id); } catch { g.forceSkip(seat.id); }
    }
    this.tick();
    return true;
  }

  // ------------------------------------------------------------------ lifetime

  // A game in play never expires, however long it runs.
  expiry(emptyGraceMs, idleMs, now = Date.now()) {
    if (this.emptySince && now - this.emptySince > emptyGraceMs) return 'Everyone left this table, so it was cleared.';
    if (now - this.lastActivity > idleMs) return 'This table sat idle for a while and was cleared. Start a new one.';
    return null;
  }

  // ------------------------------------------------------------------ output

  say(text) {
    this.chat.push({ system: true, text, ts: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
  }

  chatFrom(id, text) {
    const p = this.member(id);
    if (!p) return;
    const body = String(text || '').slice(0, 240).trim();
    if (!body) return;
    this.chat.push({ from: p.name, text: body, ts: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
    this.tick();
  }

  snapshot(forId) {
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
      game: this.game ? this.game.view(forId) : null,   // an unknown id yields the public view: no hand, no moves
    };
  }

  // Every state change funnels through tick(), so this is the honest definition
  // of "something happened" — including bots taking their turns.
  tick() {
    this.lastActivity = Date.now();
    for (const p of [...this.players, ...this.watchers]) {
      if (p.conn) this.adapter.send?.(p.conn, this.snapshot(p.id));
    }
    this.schedule();
    this.adapter.onChange?.();
  }

  dispose(reason) {
    this.adapter.cancelBot?.();
    for (const p of [...this.players, ...this.watchers]) {
      if (!p.conn) continue;
      // Say why, so anyone still looking at the page doesn't just see it die.
      if (reason) this.adapter.send?.(p.conn, { t: 'fatal', msg: reason });
      this.adapter.close?.(p.conn, 4003, 'Room closed');
    }
  }
}
