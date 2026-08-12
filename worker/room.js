// One Durable Object per table. The DO is the single owner of that room's
// state, which is exactly the guarantee the game needs and the thing a plain
// Worker can't give you.
//
// Sockets use WebSocket Hibernation: between messages the object is evicted from
// memory and the connections stay open, so an idle table costs nothing. That
// means state has to survive eviction, so every mutation is written to storage.

import { Room, Err } from '../server/room-core.js';

const STATE_KEY = 'room';
const BOT_AT = 'botAt';

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.emptyGraceMs = Number(env.EMPTY_GRACE_MIN || 15) * 60 * 1000;
    this.idleMs = Number(env.IDLE_MIN || 30) * 60 * 1000;
    this.room = null;

    // Hibernation wakes us with sockets already open, so rebuild before any
    // handler can run.
    ctx.blockConcurrencyWhile(async () => { await this.load(); });
  }

  adapter() {
    return {
      send: (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} },
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch {} },
      cancelBot: () => { this.botAt = null; },
      scheduleBot: (delay) => { this.botAt = Date.now() + delay; },
    };
  }

  async load() {
    const data = await this.ctx.storage.get(STATE_KEY);
    this.room = data
      ? Room.revive(data, this.adapter())
      : null;
    this.botAt = (await this.ctx.storage.get(BOT_AT)) ?? null;
    if (this.room) this.rebindConnections();
  }

  // Storage can't hold live sockets, so reattach them from the hibernated set.
  rebindConnections() {
    const byId = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.pid) byId.set(att.pid, ws);
    }
    for (const p of [...this.room.players, ...this.room.watchers]) {
      const ws = byId.get(p.id);
      p.conn = ws || null;
      p.connected = !!ws;
    }
    if (!this.room.anyoneHere() && !this.room.emptySince) this.room.emptySince = Date.now();
  }

  async save() {
    await this.ctx.storage.put(STATE_KEY, this.room.toJSON());
    if (this.botAt) await this.ctx.storage.put(BOT_AT, this.botAt);
    else await this.ctx.storage.delete(BOT_AT);
    await this.setNextAlarm();
  }

  // A DO gets one alarm, so it has to serve both the bot clock and the sweeper.
  async setNextAlarm() {
    const sweepAt = Math.min(
      (this.room.emptySince ?? Infinity) + this.emptyGraceMs,
      this.room.lastActivity + this.idleMs,
    );
    const next = Math.min(this.botAt ?? Infinity, sweepAt);
    if (!Number.isFinite(next)) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - next) > 500) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    if (!this.room) return;
    const reason = this.room.expiry(this.emptyGraceMs, this.idleMs);
    if (reason) {
      this.room.dispose(reason);
      await this.ctx.storage.deleteAll();     // the table is gone for good
      return;
    }
    if (this.botAt && Date.now() >= this.botAt - 50) {
      this.botAt = null;
      this.room.runBot();                     // tick() reschedules via the adapter
    }
    await this.save();
  }

  // ------------------------------------------------------------------ routing

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      if (this.room) return Response.json({ error: 'exists' }, { status: 409 });
      this.room = new Room(url.searchParams.get('code'), this.adapter());
      await this.save();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/info') {
      if (!this.room) return Response.json({ error: 'No such session.' }, { status: 404 });
      return Response.json({
        code: this.room.code,
        phase: this.room.game ? 'game' : 'lobby',
        players: this.room.players.length,
      });
    }

    if (url.pathname === '/ws') {
      if (!this.room) return new Response('No such session.', { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernatable: the runtime holds the socket while this object sleeps.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // ------------------------------------------------------------------ sockets

  async webSocketMessage(ws, raw) {
    if (!this.room) { this.reply(ws, { t: 'fatal', msg: 'That session has expired. Start a new one.' }); return; }

    // Per-socket flood control, carried on the socket so it survives hibernation.
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    const tokens = Math.min(40, (att.tokens ?? 40) + ((now - (att.ts ?? now)) / 1000) * 8);
    if (tokens < 1) { try { ws.close(4008, 'Too chatty'); } catch {} return; }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    const me = att.pid ? this.room.member(att.pid) : null;
    ws.serializeAttachment({ ...att, tokens: tokens - 1, ts: now });

    try {
      if (msg.t === 'join') {
        const p = this.room.join(ws, msg);
        ws.serializeAttachment({ pid: p.id, spectator: !!p.spectator, tokens: tokens - 1, ts: now });
        this.reply(ws, { t: 'you', pid: p.id });
        this.room.tick();
        return this.save();
      }
      if (!me) return this.reply(ws, { t: 'error', msg: 'Not joined.' });
      // Spectators are present and named, but they only get to talk.
      if (me.spectator && !['chat', 'ping', 'name'].includes(msg.t)) {
        return this.reply(ws, { t: 'error', msg: "You're watching this game." });
      }

      switch (msg.t) {
        case 'name': this.room.rename(me.id, msg.name); break;
        case 'settings': this.room.setSettings(me.id, msg.settings || {}); break;
        case 'addBot': this.room.addBot(me.id); break;
        case 'remove': this.room.removePlayer(me.id, msg.id); break;
        case 'fillSeat': this.room.fillSeat(me.id, msg.id); break;
        case 'start': this.room.start(me.id); break;
        case 'nextRound': this.room.nextRound(me.id); break;
        case 'playAgain': this.room.playAgain(me.id); break;
        case 'chat': this.room.chatFrom(me.id, msg.text); break;
        case 'play': case 'draw': case 'pass': case 'marker': case 'engine': {
          const r = this.room.act(me.id, msg);
          if (msg.t === 'draw' && r) this.reply(ws, { t: 'drew', tile: r.tile, playable: r.playable, engine: r.engine, seeking: 'engine' in r });
          break;
        }
        case 'ping': return this.reply(ws, { t: 'pong' });
      }
    } catch (e) {
      if (e instanceof Err) return this.reply(ws, { t: 'error', msg: e.message });
      console.error(e);
      return this.reply(ws, { t: 'error', msg: 'Something went wrong on the server.' });
    }
    await this.save();
  }

  async webSocketClose(ws) { await this.dropped(ws); }
  async webSocketError(ws) { await this.dropped(ws); }

  async dropped(ws) {
    if (!this.room) return;
    this.room.leave(ws);
    await this.save();
  }

  reply(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
