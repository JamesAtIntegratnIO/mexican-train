// One Durable Object per table. The DO is the single owner of that room's
// state, which is exactly the guarantee the game needs and the thing a plain
// Worker can't give you.
//
// Sockets use WebSocket Hibernation: between messages the object is evicted from
// memory and the connections stay open, so an idle table costs nothing. That
// means state has to survive eviction, so every mutation is written to storage.

import { Room, Err } from '../server/room-core.js';
import { dispatch } from '../server/dispatch.js';
import { log, setLevel } from '../server/log.js';

const STATE_KEY = 'room';
const BOT_AT = 'botAt';

// Per-socket flood control — a burst of 40, then ~8/s. The bucket rides on the
// socket attachment rather than in memory, because there is no memory to keep it
// in: the object is evicted between messages. Returns the attachment to write
// back, or null if this socket has been too chatty to keep.
function spendToken(att, now) {
  const tokens = Math.min(40, (att.tokens ?? 40) + ((now - (att.ts ?? now)) / 1000) * 8);
  if (tokens < 1) return null;
  return { ...att, tokens: tokens - 1, ts: now };
}

const parseMessage = (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  return msg && typeof msg.t === 'string' ? msg : null;
};

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    setLevel(env.LOG_LEVEL);
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

    const att = this.admit(ws);
    if (!att) return;

    const msg = parseMessage(raw);
    if (!msg) return;
    const me = att.pid ? this.room.member(att.pid) : null;

    let mutated = false;
    try {
      if (msg.t === 'join') mutated = this.onJoin(ws, att, msg);
      else if (!me) return this.reply(ws, { t: 'error', msg: 'Not joined.' });
      else mutated = this.onAction(ws, me, msg);
    } catch (e) {
      // The save below is deliberately skipped: a half-applied change is left
      // unsaved so the next wake rebuilds the table from the last good state
      // rather than a broken one.
      return this.messageFailed(ws, me, msg, e);
    }
    if (mutated) await this.save();
  }

  // Charge this message against the socket's flood budget and hand back its
  // attachment. Null means the socket was too chatty and has been closed.
  admit(ws) {
    const att = ws.deserializeAttachment() || {};
    const spent = spendToken(att, Date.now());
    if (!spent) { try { ws.close(4008, 'Too chatty'); } catch {} return null; }
    ws.serializeAttachment(spent);
    return spent;
  }

  // `join` is the message that establishes identity, which is the one thing the
  // two builds genuinely differ on — here it is a socket attachment, because
  // that is what survives hibernation.
  onJoin(ws, att, msg) {
    const p = this.room.join(ws, msg);
    ws.serializeAttachment({ ...att, pid: p.id, spectator: !!p.spectator });
    this.reply(ws, { t: 'you', pid: p.id });
    this.room.tick();
    return true;
  }

  onAction(ws, me, msg) {
    const { reply, mutated } = dispatch(this.room, me, msg);
    if (reply) this.reply(ws, reply);
    return mutated;   // a heartbeat must not cost a storage write per beat
  }

  messageFailed(ws, me, msg, e) {
    if (e instanceof Err) {
      // A refused join is terminal — the client has no way to carry on from it,
      // so end the socket rather than leave it sitting on a spinner.
      if (msg.t === 'join') {
        log.throttle('info', 'join_refused', { code: this.room.code, why: e.message });
        this.reply(ws, { t: 'fatal', msg: e.message });
        try { ws.close(4005, 'Join refused'); } catch {}
        return;
      }
      return this.reply(ws, { t: 'error', msg: e.message });
    }
    // Keyed by the fault itself, so a client retrying into a bug costs one line
    // a minute rather than one per attempt.
    log.throttle('error', 'message_failed', { code: this.room.code, pid: me?.id, t: msg.t, err: e }, `msg:${e?.message}`);
    return this.reply(ws, { t: 'error', msg: 'Something went wrong on the server.' });
  }

  async webSocketClose(ws) { await this.dropped(ws); }
  async webSocketError(ws, err) {
    log.debug('socket_error', { code: this.room?.code, err });
    await this.dropped(ws);
  }

  async dropped(ws) {
    if (!this.room) return;
    this.room.leave(ws);
    await this.save();
  }

  reply(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
