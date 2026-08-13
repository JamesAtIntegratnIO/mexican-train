import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { rooms, createRoom, MAX_ROOMS } from './rooms.js';
import { Err } from './game.js';
import { dispatch } from './dispatch.js';
import { log, setLevel } from './log.js';
import { clientIp, originAllowed, rateLimiter, securityHeaders } from './security.js';

setLevel(process.env.LOG_LEVEL);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

// Creating a table allocates memory that lives for a while; looking one up is
// how you'd sweep for codes. Both are throttled per IP.
const newRoomLimit = rateLimiter({ capacity: 5, perSec: 1 / 30 });   // ~2/min sustained
const lookupLimit = rateLimiter({ capacity: 30, perSec: 1 });
const socketLimit = rateLimiter({ capacity: 10, perSec: 1 / 3 });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);

  if (url.pathname.startsWith('/api/')) {
    if (!originAllowed(req)) {
      log.throttle('warn', 'origin_denied', { path: url.pathname, origin: req.headers.origin });
      return json(res, req, 403, { error: 'Bad origin.' });
    }

    if (url.pathname === '/api/new' && req.method === 'POST') {
      if (!newRoomLimit(ip)) {
        log.throttle('warn', 'rate_limited', { path: url.pathname, limit: 'new' }, 'rl:new');
        return json(res, req, 429, { error: "You're making tables too quickly." });
      }
      try {
        return json(res, req, 200, { code: createRoom().code });
      } catch (e) {
        if (e instanceof Err) return json(res, req, 503, { error: e.message });
        log.error('room_create_failed', { err: e });
        return json(res, req, 500, { error: 'Server error.' });
      }
    }
    if (url.pathname === '/api/health') {
      return json(res, req, 200, { ok: true, rooms: rooms.size, max: MAX_ROOMS, uptime: Math.round(process.uptime()) });
    }
    if (url.pathname.startsWith('/api/room/')) {
      if (!lookupLimit(ip)) {
        log.throttle('warn', 'rate_limited', { path: url.pathname, limit: 'lookup' }, 'rl:lookup');
        return json(res, req, 429, { error: 'Slow down.' });
      }
      const code = url.pathname.slice('/api/room/'.length).toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, req, 404, { error: 'No such session.' });
      return json(res, req, 200, { code, phase: room.game ? 'game' : 'lobby', players: room.players.length });
    }
    return json(res, req, 404, { error: 'Not found.' });
  }

  // Everything else is the single-page app; /g/CODE resolves to index.html.
  const rel = url.pathname === '/' || url.pathname.startsWith('/g/') ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return json(res, req, 403, { error: 'Nope.' });

  fs.readFile(file, (err, buf) => {
    if (err) {
      // A missing file is ordinary; anything else (permissions, too many open
      // files) is the server's problem and would otherwise hide as a 404.
      if (err.code !== 'ENOENT') log.error('static_read_failed', { path: url.pathname, code: err.code, err });
      return json(res, req, 404, { error: 'Not found.' });
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Assets are a few KB and change often while iterating — never serve a stale one.
      'cache-control': 'no-cache',
      ...securityHeaders(req, ext === '.html'),
    });
    res.end(buf);
  });
});

// 8 KB is far more than any legitimate message; the ws default is 100 MB.
// noServer + an explicit upgrade handler so the origin check runs *before* the
// handshake — attaching a second 'upgrade' listener would run after ws's own.
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, clientTracking: true });

server.on('upgrade', (req, socket, head) => {
  const deny = (code, why, evt) => {
    if (evt) log.throttle('warn', evt, { path: '/ws', origin: req.headers.origin });
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  // A half-finished handshake still owns a socket, so don't let one linger.
  socket.on('error', (e) => log.debug('upgrade_socket_error', { err: e }));
  if (new URL(req.url, 'http://x').pathname !== '/ws') return deny(404, 'Not Found');
  if (!originAllowed(req)) return deny(403, 'Forbidden', 'origin_denied');
  if (!socketLimit(clientIp(req))) return deny(429, 'Too Many Requests', 'rate_limited');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const room = rooms.get(code);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (!room) {
    send(ws, { t: 'fatal', msg: 'That session has expired or never existed. Start a new one.' });
    return ws.close(4004, 'No room');
  }

  // Per-socket flood control: burst of 40, then ~8/s. Kept inline rather than a
  // rateLimiter() so we don't spawn a sweep interval for every connection.
  let tokens = 40, lastMsg = Date.now();
  const allowMsg = () => {
    const now = Date.now();
    tokens = Math.min(40, tokens + ((now - lastMsg) / 1000) * 8);
    lastMsg = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  let me = null;
  ws.on('message', (raw) => {
    if (!allowMsg()) {
      log.throttle('warn', 'socket_flooded', { code });
      try { ws.close(4008, 'Too chatty'); } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      if (msg.t === 'join') {
        me = room.join(ws, msg);
        log.debug('joined', { code, pid: me.id, spectator: !!me.spectator });
        send(ws, { t: 'you', pid: me.id });
        return room.tick();
      }
      if (!me) return send(ws, { t: 'error', msg: 'Not joined.' });

      const { reply } = dispatch(room, me, msg);
      if (reply) send(ws, reply);
    } catch (e) {
      if (e instanceof Err) {
        // A refused join is terminal — the client has no way to carry on from
        // it, so end the socket rather than leave it sitting on a spinner.
        if (msg.t === 'join') {
          log.throttle('info', 'join_refused', { code, why: e.message });
          send(ws, { t: 'fatal', msg: e.message });
          try { ws.close(4005, 'Join refused'); } catch {}
          return;
        }
        return send(ws, { t: 'error', msg: e.message });
      }
      // Keyed by the fault itself: a bug a client can retry into would
      // otherwise bill a line per attempt, while a *different* bug still gets
      // through immediately rather than hiding behind the noisy one.
      log.throttle('error', 'message_failed', { code, pid: me?.id, t: msg.t, err: e }, `msg:${e?.message}`);
      send(ws, { t: 'error', msg: 'Something went wrong on the server.' });
    }
  });

  ws.on('close', () => { if (me) room.leave(ws); });
  ws.on('error', (e) => log.debug('socket_error', { code, err: e }));
});

// Drop half-open sockets so disconnects register promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20_000).unref();

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const json = (res, req, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders(req, false) });
  res.end(JSON.stringify(body));
};

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutting_down', { sig, rooms: rooms.size, sockets: wss.clients.size });
    for (const ws of wss.clients) { try { ws.close(1001, 'Server restarting'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Every table lives in this process's memory, so exiting throws away every game
// in progress. A fault in one socket's handler is not worth that, and Node's
// default for an unhandled rejection is to exit — so absorb both, log them
// loudly, and keep the other tables running.
//
// The exception is a fault that repeats: if the process is broken rather than
// merely unlucky, staying up serves nobody, so a burst trips a real exit and
// lets the platform restart us clean.
let faults = 0;
const survive = (evt) => (err) => {
  log.error(evt, { err, rooms: rooms.size });
  faults++;
  setTimeout(() => { faults--; }, 60_000).unref();
  if (faults >= 10) {
    log.error('fault_loop', { faults, note: 'exiting so the platform restarts us' });
    process.exit(1);
  }
};
process.on('uncaughtException', survive('uncaught_exception'));
process.on('unhandledRejection', survive('unhandled_rejection'));

// Without this, a port already in use exits on a raw stack trace.
server.on('error', (err) => {
  log.error('server_error', { err, port: PORT, host: HOST });
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') process.exit(1);
});

server.listen(PORT, HOST, () => {
  log.info('listening', { port: PORT, host: HOST, maxRooms: MAX_ROOMS });
  console.log(`\n  Mexican Train on http://localhost:${PORT}  (max ${MAX_ROOMS} tables)\n`);
});
