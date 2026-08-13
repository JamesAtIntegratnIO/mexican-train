// Cloudflare Worker entry. Serves the static app, mints table codes, and hands
// every socket to the Durable Object that owns that table.

import { newCode } from '../server/room-core.js';
import type { Env } from './env.js';
import { log, setLevel } from '../server/log.js';

export { RoomDO } from './room.js';

const CODE_RE = /^[A-Z0-9]{3,8}$/;

const securityHeaders = (isHtml: boolean): Record<string, string> => {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  };
  if (isHtml) {
    h['x-frame-options'] = 'DENY';
    h['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      // Tile colours ride on inline style attributes, so this one has to stay.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",              // the favicon is an inline SVG data URI
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; ');
    h['permissions-policy'] = 'geolocation=(), camera=(), microphone=(), interest-cohort=()';
  }
  return h;
};

// Browsers always send Origin cross-site and on every WS upgrade, so this stops
// other sites driving our tables. Forgeable by non-browsers, which is fine —
// that was never the threat it defends against.
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;                       // curl, tests, native clients
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) return allowed.includes(host);
  return host === new URL(request.url).host;      // same-origin default
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...securityHeaders(false) } });

const roomStub = (env: Env, code: string): DurableObjectStub => env.ROOM.get(env.ROOM.idFromName(code));

export default {
  // An uncaught throw here would hand the player Cloudflare's 1101 page, which
  // tells them nothing and tells us nothing either. Everything real happens in
  // route(); this only exists to make sure a fault is logged and answered in
  // the shape the client already knows how to read.
  async fetch(request: Request, env: Env): Promise<Response> {
    setLevel(env.LOG_LEVEL);
    try {
      return await route(request, env);
    } catch (e) {
      const url = new URL(request.url);
      log.error('request_failed', { path: url.pathname, method: request.method, err: e });
      if (url.pathname === '/ws') return new Response('Server error', { status: 500 });
      return json({ error: 'Server error.' }, 500);
    }
  },
};

function route(request: Request, env: Env): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.pathname === '/ws') return socketRoute(request, env, url);
  if (url.pathname.startsWith('/api/')) return apiRoute(request, env, url);
  return assetRoute(request, env, url);
}

// Checked identically on sockets and on the API, but refused in each one's own
// currency — a plain body for an upgrade, JSON for everything else.
function originOk(request: Request, env: Env, pathname: string): boolean {
  if (originAllowed(request, env)) return true;
  log.throttle('warn', 'origin_denied', { path: pathname, origin: request.headers.get('origin') });
  return false;
}

// Every socket for a table goes to the single Durable Object that owns it.
function socketRoute(request: Request, env: Env, url: URL): Promise<Response> | Response {
  if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
  if (!originOk(request, env, url.pathname)) return new Response('Forbidden', { status: 403 });
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) return new Response('Bad code', { status: 400 });
  return roomStub(env, code).fetch(new Request('https://do/ws', request));
}

function apiRoute(request: Request, env: Env, url: URL): Promise<Response> | Response {
  const { pathname } = url;
  if (!originOk(request, env, pathname)) return json({ error: 'Bad origin.' }, 403);

  if (pathname === '/api/new' && request.method === 'POST') return mintRoom(request, env, pathname);
  if (pathname === '/api/health') return health(request, env);
  if (pathname.startsWith('/api/room/')) return roomInfo(env, pathname);
  return json({ error: 'Not found.' }, 404);
}

async function mintRoom(request: Request, env: Env, pathname: string): Promise<Response> {
  // Each table is its own Durable Object, so there's no shared pool to
  // exhaust — but minting one costs storage, so it is gated per IP.
  if (!(await mintAllowed(request, env))) {
    log.throttle('warn', 'rate_limited', { path: pathname, limit: 'new' });
    return json({ error: "You're making tables too quickly." }, 429);
  }
  const code = newCode();
  const res = await roomStub(env, code).fetch(new Request(`https://do/create?code=${code}`));
  if (!res.ok) {
    log.error('room_create_failed', { code, status: res.status });
    return json({ error: 'Could not create a table — try again.' }, 503);
  }
  log.debug('room_created', { code });   // room_disposed carries the fuller story
  return json({ code });
}

// No room count here, unlike the Node build: every table is its own Durable
// Object, so there is no registry to count. The deployed version is the thing
// worth reporting — it says which build answered.
const health = (request: Request, env: Env): Response => json({
  ok: true,
  runtime: 'workers',
  version: env.CF_VERSION?.id || null,
  colo: request.cf?.colo || null,
});

async function roomInfo(env: Env, pathname: string): Promise<Response> {
  const code = pathname.slice('/api/room/'.length).toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: 'No such session.' }, 404);
  const res = await roomStub(env, code).fetch(new Request('https://do/info'));
  return json(await res.json(), res.status);
}

// Everything else is the single-page app; /g/CODE resolves to index.html.
async function assetRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const assetReq = url.pathname.startsWith('/g/')
    ? new Request(new URL('/index.html', url), request)
    : request;
  const asset = await env.ASSETS.fetch(assetReq);
  const isHtml = (asset.headers.get('content-type') || '').includes('text/html');
  const out = new Response(asset.body, asset);
  for (const [k, v] of Object.entries(securityHeaders(isHtml))) out.headers.set(k, v);
  out.headers.set('cache-control', isHtml ? 'no-cache' : 'public, max-age=3600');
  return out;
}

// Table minting, throttled per IP by Cloudflare's own rate limiter — there is
// no process here to hold buckets in, the way the Node build does.
//
// If the binding is missing the gate cannot run, and quietly minting without it
// is exactly the gap this closes — so say so, and let it through rather than
// locking everyone out of a working deploy. Throttled: without it a missing
// binding would cost a log line on every single request.
async function mintAllowed(request: Request, env: Env): Promise<boolean> {
  if (!env.NEW_ROOM_LIMIT) {
    log.throttle('warn', 'rate_limiter_missing', { limit: 'new', note: 'NEW_ROOM_LIMIT binding not configured' });
    return true;
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.NEW_ROOM_LIMIT.limit({ key: ip });
  return success;
}
