// Cloudflare Worker entry. Serves the static app, mints table codes, and hands
// every socket to the Durable Object that owns that table.

import { newCode } from '../server/room-core.js';

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      if (!originAllowed(request, env)) return new Response('Forbidden', { status: 403 });
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!CODE_RE.test(code)) return new Response('Bad code', { status: 400 });
      return roomStub(env, code).fetch(new Request('https://do/ws', request));
    }

    if (pathname.startsWith('/api/')) {
      if (!originAllowed(request, env)) return json({ error: 'Bad origin.' }, 403);

      if (pathname === '/api/new' && request.method === 'POST') {
        // Each table is its own Durable Object, so there's no shared pool to
        // exhaust — but minting is still gated so nobody can spray them.
        const code = newCode();
        const res = await roomStub(env, code).fetch(new Request(`https://do/create?code=${code}`));
        if (!res.ok) return json({ error: 'Could not create a table — try again.' }, 503);
        return json({ code });
      }

      if (pathname === '/api/health') return json({ ok: true, runtime: 'workers' });

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
  },
};
