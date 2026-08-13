// The WebSocket half of the Node host: who is allowed to open a socket, and what
// happens on it once open. The rules of the table are not here — every message
// past `join` goes to dispatch(), which the Worker build shares.

import { WebSocketServer } from 'ws';
import type { WebSocket, RawData } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Room, Seat, Watcher } from './room-core.js';
import type { ClientMessage } from '../shared/protocol.js';

/** ws sockets carry a liveness flag for the heartbeat sweep. */
type LiveSocket = WebSocket & { isAlive?: boolean };

/** One socket's world: the table it is on, and who it turned out to be.
 *  `me` is filled in by `join` — see the note where it is declared. */
interface Session {
  room: Room;
  code: string;
  me: Seat | Watcher | null;
}
import { rooms } from './rooms.js';
import { Err } from './game.js';
import { dispatch } from './dispatch.js';
import { log } from './log.js';
import { clientIp, originAllowed, rateLimiter } from './security.js';

const socketLimit = rateLimiter({ capacity: 10, perSec: 1 / 3 });

const send = (ws: WebSocket, obj: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// 8 KB is far more than any legitimate message; the ws default is 100 MB.
// noServer + an explicit upgrade handler so the origin check runs *before* the
// handshake — attaching a second 'upgrade' listener would run after ws's own.
export function attachSockets(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, clientTracking: true });
  server.on('upgrade', (req, socket, head) => gateUpgrade(wss, req, socket, head));
  wss.on('connection', openSession as (ws: WebSocket, req: IncomingMessage) => void);
  heartbeat(wss);
  return wss;
}

function gateUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const deny = (code: number, why: string, evt?: string): void => {
    if (evt) log.throttle('warn', evt, { path: '/ws', origin: req.headers.origin });
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  // A half-finished handshake still owns a socket, so don't let one linger.
  socket.on('error', (e: unknown) => log.debug('upgrade_socket_error', { err: e }));
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return deny(404, 'Not Found');
  if (!originAllowed(req)) return deny(403, 'Forbidden', 'origin_denied');
  if (!socketLimit(clientIp(req))) return deny(429, 'Too Many Requests', 'rate_limited');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

function openSession(ws: LiveSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const room = rooms.get(code);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (!room) {
    send(ws, { t: 'fatal', msg: 'That session has expired or never existed. Start a new one.' });
    return ws.close(4004, 'No room');
  }

  // `me` is this socket's identity, filled in by `join` and needed by everything
  // after it. On Node it lives here, in the closure; the Durable Object keeps
  // the same thing as a socket attachment. That difference is the whole reason
  // `join` is handled per host rather than in dispatch().
  const session: Session = { room, code, me: null };
  const allow = floodGate();

  ws.on('message', (raw: RawData) => {
    if (!allow()) {
      log.throttle('warn', 'socket_flooded', { code });
      try { ws.close(4008, 'Too chatty'); } catch {}
      return;
    }
    let msg: ClientMessage;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { onMessage(ws, session, msg); }
    catch (e) { onMessageFailed(ws, session, msg, e); }
  });

  ws.on('close', () => { if (session.me) room.leave(ws); });
  ws.on('error', (e: unknown) => log.debug('socket_error', { code, err: e }));
}

function onMessage(ws: WebSocket, session: Session, msg: ClientMessage): void {
  if (msg.t === 'join') {
    session.me = session.room.join(ws, msg);
    log.debug('joined', { code: session.code, pid: session.me.id, spectator: !!session.me.spectator });
    send(ws, { t: 'you', pid: session.me.id });
    return session.room.tick();
  }
  if (!session.me) return send(ws, { t: 'error', msg: 'Not joined.' });

  const { reply } = dispatch(session.room, session.me, msg);
  if (reply) send(ws, reply);
}

function onMessageFailed(ws: WebSocket, session: Session, msg: ClientMessage, e: unknown): void {
  if (e instanceof Err) {
    // A refused join is terminal — the client has no way to carry on from it,
    // so end the socket rather than leave it sitting on a spinner.
    if (msg.t === 'join') {
      log.throttle('info', 'join_refused', { code: session.code, why: e.message });
      send(ws, { t: 'fatal', msg: e.message });
      try { ws.close(4005, 'Join refused'); } catch {}
      return;
    }
    return send(ws, { t: 'error', msg: e.message });
  }
  // Keyed by the fault itself: a bug a client can retry into would otherwise
  // bill a line per attempt, while a *different* bug still gets through
  // immediately rather than hiding behind the noisy one.
  log.throttle('error', 'message_failed', { code: session.code, pid: session.me?.id, t: msg.t, err: e }, `msg:${e instanceof Error ? e.message : String(e)}`);
  send(ws, { t: 'error', msg: 'Something went wrong on the server.' });
}

// Per-socket flood control: burst of 40, then ~8/s. Kept as a closure rather
// than a rateLimiter() so we don't spawn a sweep interval for every connection.
function floodGate(): () => boolean {
  let tokens = 40, last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(40, tokens + ((now - last) / 1000) * 8);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// Drop half-open sockets so disconnects register promptly.
function heartbeat(wss: WebSocketServer): void {
  setInterval(() => {
    for (const ws of wss.clients as Set<LiveSocket>) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 20_000).unref();
}
