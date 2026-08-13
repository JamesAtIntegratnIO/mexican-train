// Cloudflare Worker entry. Serves the static app, mints table codes, and hands
// every socket to the Durable Object that owns that table.

import { newCode } from '../server/room-core.js';
import { log, setLevel } from '../server/log.js';

export { RoomDO } from './room.js';

const CODE_RE = /^[A-Z0-9]{3,8}$/;

const securityHeaders = (isHtml) => {
  const h = {
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
function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;                       // curl, tests, native clients
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) return allowed.includes(host);
  return host === new URL(request.url).host;      // same-origin default
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...securityHeaders(false) } });

const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));

export default {
  // An uncaught throw here would hand the player Cloudflare's 1101 page, which
  // tells them nothing and tells us nothing either. Everything real happens in
  // route(); this only exists to make sure a fault is logged and answered in
  // the shape the client already knows how to read.
  async fetch(request, env, ctx) {
    setLevel(env.LOG_LEVEL);
    try {
      return await route(request, env, ctx);
    } catch (e) {
      const url = new URL(request.url);
      log.error('request_failed', { path: url.pathname, method: request.method, err: e });
      if (url.pathname === '/ws') return new Response('Server error', { status: 500 });
      return json({ error: 'Server error.' }, 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/ws') {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    if (!originAllowed(request, env)) {
      log.throttle('warn', 'origin_denied', { path: pathname, origin: request.headers.get('origin') });
      return new Response('Forbidden', { status: 403 });
    }
    const code = (url.searchParams.get('code') || '').toUpperCase();
    if (!CODE_RE.test(code)) return new Response('Bad code', { status: 400 });
    return roomStub(env, code).fetch(new Request('https://do/ws', request));
  }

  if (pathname.startsWith('/api/')) {
    if (!originAllowed(request, env)) {
      log.throttle('warn', 'origin_denied', { path: pathname, origin: request.headers.get('origin') });
      return json({ error: 'Bad origin.' }, 403);
    }

    if (pathname === '/api/new' && request.method === 'POST') {
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

    if (pathname === '/api/health') {
      // No room count here, unlike the Node build: every table is its own
      // Durable Object, so there is no registry to count. The deployed version
      // is the thing worth reporting — it says which build answered.
      return json({
        ok: true,
        runtime: 'workers',
        version: env.CF_VERSION?.id || null,
        colo: request.cf?.colo || null,
      });
    }

    if (pathname.startsWith('/api/room/')) {
      const code = pathname.slice('/api/room/'.length).toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'No such session.' }, 404);
      const res = await roomStub(env, code).fetch(new Request('https://do/info'));
      return json(await res.json(), res.status);
    }

    return json({ error: 'Not found.' }, 404);
  }

  // Everything else is the single-page app; /g/CODE resolves to index.html.
  const assetReq = pathname.startsWith('/g/')
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
async function mintAllowed(request, env) {
  if (!env.NEW_ROOM_LIMIT) {
    log.throttle('warn', 'rate_limiter_missing', { limit: 'new', note: 'NEW_ROOM_LIMIT binding not configured' });
    return true;
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.NEW_ROOM_LIMIT.limit({ key: ip });
  return success;
}
