// One Durable Object per table. The DO is the single owner of that room's
// state, which is exactly the guarantee the game needs and the thing a plain
// Worker can't give you.
//
// Sockets use WebSocket Hibernation: between messages the object is evicted from
// memory and the connections stay open, so an idle table costs nothing. That
// means state has to survive eviction, so every mutation is written to storage.

import { Room, Err } from '../server/room-core.js';
import type { Conn, Seat, Watcher, RoomOptions, Limits } from '../server/room-core.js';
import type { ClientMessage, PlayerId } from '../shared/protocol.js';
import { flagOn, num } from '../shared/flags.js';
import type { Env } from './env.js';

/** What rides on a hibernatable socket. It has to survive eviction, so it holds
 *  both the identity and the flood budget — there is no memory to keep them in
 *  between messages. */
interface Attachment {
  pid?: PlayerId;
  spectator?: boolean;
  tokens?: number;
  ts?: number;
}
import { dispatch } from '../server/dispatch.js';
import { log, setLevel } from '../server/log.js';
import { useAnalytics } from './analytics.js';

const STATE_KEY = 'room';
const BOT_AT = 'botAt';

// Per-socket flood control — a burst of 40, then ~8/s. The bucket rides on the
// socket attachment rather than in memory, because there is no memory to keep it
// in: the object is evicted between messages. Returns the attachment to write
// back, or null if this socket has been too chatty to keep.
function spendToken(att: Attachment, now: number): Attachment | null {
  const tokens = Math.min(40, (att.tokens ?? 40) + ((now - (att.ts ?? now)) / 1000) * 8);
  if (tokens < 1) return null;
  return { ...att, tokens: tokens - 1, ts: now };
}

const parseMessage = (raw: string | ArrayBuffer): ClientMessage | null => {
  let msg: ClientMessage;
  try { msg = JSON.parse(String(raw)); } catch { return null; }
  return msg && typeof msg.t === 'string' ? msg : null;
};

export class RoomDO {
  ctx: DurableObjectState;
  env: Env;
  /** Read from the environment on every wake, never from storage, so both are
   *  whatever the current deploy says they are. */
  limits: Limits;
  opts: RoomOptions;
  room: Room | null;
  /** When the bot clock is next due, or null when nothing is pending. Written
   *  to storage alongside the room, because the alarm has to survive eviction. */
  botAt!: number | null;
  /** Whether the bot clock is actually in storage, as against merely being
   *  null in memory. The two are not the same question, and only this one says
   *  whether a delete would erase anything. */
  botStored!: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    setLevel(env.LOG_LEVEL);
    // A table's one telemetry sample is written when it is cleared, and that
    // happens in here on an alarm — so the sink has to be installed here too,
    // not only on the Worker that fronts us.
    useAnalytics(env);
    // Holding an abandoned game for hours costs this host almost nothing: the
    // object hibernates, the state is a few KB of storage, and the alarm simply
    // fires later. The ceiling is what keeps "nothing is kept" honest.
    this.limits = {
      emptyLobbyMs: num(env.EMPTY_GRACE_MIN, 15) * 60_000,
      emptyGameMs: num(env.EMPTY_GRACE_GAME_MIN, 720) * 60_000,
      maxLifeMs: num(env.MAX_LIFETIME_HOURS, 24) * 3_600_000,
    };
    this.opts = { chat: flagOn(env.CHAT_ENABLED) };
    this.room = null;

    // Hibernation wakes us with sockets already open, so rebuild before any
    // handler can run.
    ctx.blockConcurrencyWhile(async () => { await this.load(); });
  }

  adapter(): import('../server/room-core.js').Adapter {
    return {
      send: (conn: Conn, obj: unknown) => { try { (conn as WebSocket).send(JSON.stringify(obj)); } catch {} },
      close: (conn: Conn, code: number, reason: string) => { try { (conn as WebSocket).close(code, reason); } catch {} },
      // A watcher given a seat: the attachment is this build's whole notion of
      // who a socket is, and it has to survive hibernation, so it is rewritten
      // rather than remembered anywhere else.
      identify: (conn: Conn, id: PlayerId) => {
        const ws = conn as WebSocket;
        const att = (ws.deserializeAttachment() as Attachment | null) || {};
        ws.serializeAttachment({ ...att, pid: id, spectator: false });
      },
      cancelBot: () => { this.botAt = null; },
      scheduleBot: (delay: number) => { this.botAt = Date.now() + delay; },
    };
  }

  async load(): Promise<void> {
    const data = await this.ctx.storage.get<unknown>(STATE_KEY);
    this.room = data
      ? Room.revive(data, this.adapter(), this.opts)
      : null;
    const at = await this.ctx.storage.get<number>(BOT_AT);
    this.botAt = at ?? null;
    this.botStored = at !== undefined;
    if (this.room) this.rebindConnections();
  }

  // Storage can't hold live sockets, so reattach them from the hibernated set.
  rebindConnections(): void {
    const room = this.room!;
    const byId = new Map<PlayerId, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid) byId.set(att.pid, ws);
    }
    for (const p of [...room.players, ...room.watchers]) {
      const ws = byId.get(p.id);
      p.conn = ws || null;
      p.connected = !!ws;
    }
    if (!room.anyoneHere() && !room.emptySince) room.emptySince = Date.now();
  }

  async save(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, this.room!.toJSON());
    // Only clear the bot clock when there is one to clear. A table with nobody
    // waiting on a bot is the ordinary case — every human turn, and every table
    // still in its lobby — and the unconditional delete spent a storage
    // operation on a key that was never written, on every one of them.
    if (this.botAt) { await this.ctx.storage.put(BOT_AT, this.botAt); this.botStored = true; }
    else if (this.botStored) { await this.ctx.storage.delete(BOT_AT); this.botStored = false; }
    await this.setNextAlarm();
  }

  // A DO gets one alarm, so it has to serve both the bot clock and the sweeper.
  // When the table dies is the room's own rule — asking it rather than
  // recomputing here is what keeps this host and the Node one agreeing.
  async setNextAlarm(): Promise<void> {
    const next = Math.min(this.botAt ?? Infinity, this.room!.expiresAt(this.limits));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - next) > 500) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    if (!this.room) return;
    const why = this.room.expiry(this.limits);
    if (why) {
      this.room.dispose(why);
      await this.ctx.storage.deleteAll();     // the table is gone for good
      // Emptying storage does not evict the object, so the copy in memory has
      // to go with it. Left set, it would keep the `!this.room` guards on /ws
      // and webSocketMessage passing: a table the ceiling had just declared
      // gone would take joins again, write itself back to storage, and be
      // disposed a second time — two log lines and two data points for
      // something meant to be sampled exactly once.
      this.room = null;
      this.botAt = null;
      this.botStored = false;   // deleteAll() took the key with everything else
      // deleteAll() clears a pending alarm only from compatibility date
      // 2026-02-24 onwards, and this Worker is dated well before that, so the
      // sweeper is unset by hand rather than left scheduled against storage
      // that no longer exists.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (this.botAt && Date.now() >= this.botAt - 50) {
      this.botAt = null;
      this.room.runBot();                     // tick() reschedules via the adapter
    }
    await this.save();
  }

  // ------------------------------------------------------------------ routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      if (this.room) return Response.json({ error: 'exists' }, { status: 409 });
      this.room = new Room(url.searchParams.get('code') ?? '', this.adapter(), this.opts);
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

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
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
      // The save below is skipped, so nothing this message half-applied reaches
      // storage. Whether the table still in memory can be trusted afterwards is
      // messageFailed's business, and it turns on what was thrown.
      return await this.messageFailed(ws, me, msg, e);
    }
    if (mutated) await this.save();
  }

  // Charge this message against the socket's flood budget and hand back its
  // attachment. Null means the socket was too chatty and has been closed.
  admit(ws: WebSocket): Attachment | null {
    const att = (ws.deserializeAttachment() as Attachment | null) || {};
    const spent = spendToken(att, Date.now());
    if (!spent) { try { ws.close(4008, 'Too chatty'); } catch {} return null; }
    ws.serializeAttachment(spent);
    return spent;
  }

  // `join` is the message that establishes identity, which is the one thing the
  // two builds genuinely differ on — here it is a socket attachment, because
  // that is what survives hibernation.
  onJoin(ws: WebSocket, att: Attachment, msg: Extract<ClientMessage, { t: 'join' }>): boolean {
    const p = this.room!.join(ws, msg);
    ws.serializeAttachment({ ...att, pid: p.id, spectator: !!p.spectator });
    this.reply(ws, { t: 'you', pid: p.id });
    this.room!.tick();
    return true;
  }

  onAction(ws: WebSocket, me: Seat | Watcher, msg: ClientMessage): boolean {
    const { reply, mutated } = dispatch(this.room!, me, msg);
    if (reply) this.reply(ws, reply);
    return mutated;   // a heartbeat must not cost a storage write per beat
  }

  // Two different things arrive here. An Err is the table saying no, and it is
  // thrown before anything has been touched — every action in the engine and
  // the room checks in full and only then mutates, which is what checkPlay is
  // shaped to make obvious — so the room in memory still matches storage and
  // nothing needs undoing. Anything else is a fault, and a fault may have got
  // half way; skipping this message's write is not enough on its own, because
  // the object is not evicted just because a message failed and the next
  // message that does mutate would write the broken state out. So a fault is
  // paid for with a reload, and a refusal is not: a refusal is ordinary — a
  // client one tick behind naming a branch that has since forked is a routine
  // no — and charging every one of them a storage read would be paying for
  // damage that isn't there.
  async messageFailed(ws: WebSocket, me: Seat | Watcher | null | undefined, msg: ClientMessage, e: unknown): Promise<void> {
    if (e instanceof Err) {
      // A refused join is terminal — the client has no way to carry on from it,
      // so end the socket rather than leave it sitting on a spinner.
      if (msg.t === 'join') {
        log.throttle('info', 'join_refused', { code: this.room!.code, why: e.message });
        this.reply(ws, { t: 'fatal', msg: e.message });
        try { ws.close(4005, 'Join refused'); } catch {}
        return;
      }
      return this.reply(ws, { t: 'error', msg: e.message });
    }
    // Keyed by the fault itself, so a client retrying into a bug costs one line
    // a minute rather than one per attempt.
    log.throttle('error', 'message_failed', { code: this.room!.code, pid: me?.id, t: msg.t, err: e }, `msg:${e instanceof Error ? e.message : String(e)}`);
    this.reply(ws, { t: 'error', msg: 'Something went wrong on the server.' });
    await this.load();   // back to the last good state, before anything can save
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.dropped(ws); }
  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    log.debug('socket_error', { code: this.room?.code, err });
    await this.dropped(ws);
  }

  async dropped(ws: WebSocket): Promise<void> {
    if (!this.room) return;
    this.room.leave(ws);
    await this.save();
  }

  reply(ws: WebSocket, obj: unknown): void { try { ws.send(JSON.stringify(obj)); } catch {} }
}
