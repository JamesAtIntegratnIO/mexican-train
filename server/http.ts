// The HTTP half of the Node host: a small JSON API, and the single-page app
// behind it. The socket half is in sockets.js, and index.js bolts the two onto
// one port.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rooms, createRoom, MAX_ROOMS } from './rooms.js';
import { Err } from './game.js';
import { log } from './log.js';
import { metrics, isFunnelEvent } from './metrics.js';
import { clientIp, originAllowed, rateLimiter, securityHeaders } from './security.js';

// This file runs from two places: dist/server/http.js in the built tree, and
// server/http.ts directly under tsx in development. public/ sits beside dist/
// in the first and beside server/ in the second, so both are tried rather than
// assuming one — getting this wrong 404s the entire app while every API route
// keeps answering, which is a confusing way to spend an afternoon.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = [path.join(HERE, '..', '..', 'public'), path.join(HERE, '..', 'public')]
  .find((dir) => fs.existsSync(dir)) ?? path.join(HERE, '..', '..', 'public');

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

// Creating a table allocates memory that lives for a while; looking one up is
// how you'd sweep for codes. Both are throttled per IP.
const newRoomLimit = rateLimiter({ capacity: 5, perSec: 1 / 30 });   // ~2/min sustained
const lookupLimit = rateLimiter({ capacity: 30, perSec: 1 });
// A whole session sends a handful of funnel events, so this is generous and
// still firmly bounded. Being cheap is the entire point of that endpoint, and a
// bound is what keeps it cheap.
const eventLimit = rateLimiter({ capacity: 20, perSec: 1 / 6 });     // ~10/min sustained

export const json = (res: ServerResponse, req: IncomingMessage, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders(req, false) });
  res.end(JSON.stringify(body));
};

const noContent = (res: ServerResponse, req: IncomingMessage): void => {
  res.writeHead(204, securityHeaders(req, false));
  res.end();
};

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  return serveAsset(req, res, url);
}

function api(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!originAllowed(req)) {
    log.throttle('warn', 'origin_denied', { path: url.pathname, origin: req.headers.origin });
    return json(res, req, 403, { error: 'Bad origin.' });
  }
  const ip = clientIp(req);

  if (url.pathname === '/api/new' && req.method === 'POST') return mintRoom(req, res, url, ip);
  if (url.pathname === '/api/event' && req.method === 'POST') return trackEvent(req, res, url, ip);
  if (url.pathname === '/api/health') {
    return json(res, req, 200, { ok: true, rooms: rooms.size, max: MAX_ROOMS, uptime: Math.round(process.uptime()) });
  }
  if (url.pathname === '/api/stats') return stats(req, res, ip);
  if (url.pathname.startsWith('/api/room/')) return roomInfo(req, res, url, ip);
  return json(res, req, 404, { error: 'Not found.' });
}

// Everything this process has counted since it started: tables cleared, people
// who sat down, games finished, and the browser-side steps that never reach a
// socket. Held in memory like everything else here, so a restart is a reset —
// which is the honest shape for a server that keeps no database.
//
// The Workers build has no equivalent and shouldn't: its counters would be
// per-isolate, so they go to Analytics Engine instead, which outlives them.
function stats(req: IncomingMessage, res: ServerResponse, ip: string): void {
  if (!lookupLimit(ip)) return json(res, req, 429, { error: 'Slow down.' });
  return json(res, req, 200, {
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: rooms.size,
    counts: metrics.snapshot(),
  });
}

// One counter increment, and deliberately nothing else: nothing is stored about
// who sent it, and no log line is written — a stranger must not be able to run
// up a logging bill by clicking. Refusals are counted instead, so a client
// gone wrong is still visible in /api/stats.
//
// The event name rides in the query string because this server has no body
// parser at all, and adding one for six characters would be the largest thing
// in this file. POST rather than GET so a crawler, a prefetch or a link preview
// can't inflate the count by visiting.
function trackEvent(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): void {
  // Charged before the name is looked at, so a flood of junk names is throttled
  // on the same budget as a flood of real ones.
  if (!eventLimit(ip)) { metrics.refused(); return json(res, req, 429, { error: 'Slow down.' }); }
  const e = url.searchParams.get('e') || '';
  if (!isFunnelEvent(e)) { metrics.refused(); return json(res, req, 400, { error: 'Unknown event.' }); }
  metrics.funnel(e);
  return noContent(res, req);
}

function mintRoom(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): void {
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

function roomInfo(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): void {
  if (!lookupLimit(ip)) {
    log.throttle('warn', 'rate_limited', { path: url.pathname, limit: 'lookup' }, 'rl:lookup');
    return json(res, req, 429, { error: 'Slow down.' });
  }
  const code = url.pathname.slice('/api/room/'.length).toUpperCase();
  const room = rooms.get(code);
  if (!room) return json(res, req, 404, { error: 'No such session.' });
  return json(res, req, 200, { code, phase: room.game ? 'game' : 'lobby', players: room.players.length });
}

// Everything that isn't the API is the single-page app; /g/CODE resolves to
// index.html so a shared link opens the table rather than a 404.
function serveAsset(req: IncomingMessage, res: ServerResponse, url: URL): void {
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
}
