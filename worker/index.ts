// Cloudflare Worker entry. Serves the static app, mints table codes, and hands
// every socket to the Durable Object that owns that table.

import { newCode } from '../server/room-core.js';
import type { Env, RateLimiterBinding } from './env.js';
import { log, setLevel } from '../server/log.js';
import { metrics, isFunnelEvent } from '../server/metrics.js';
import { useAnalytics } from './analytics.js';

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
    useAnalytics(env);
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
  if (pathname === '/api/event' && request.method === 'POST') return trackEvent(request, env, url);
  if (pathname === '/api/health') return health(request, env);
  if (pathname.startsWith('/api/room/')) return roomInfo(env, pathname);
  return json({ error: 'Not found.' }, 404);
}

// A counter increment and deliberately nothing else: nothing is stored about
// who sent it, and no log line is written — otherwise the cheapest way to run up
// a logging bill would be to click. Refusals are counted rather than logged for
// the same reason. Held to the same shape as the Node build's route, down to
// the status codes, so the two cannot drift on what an event means.
//
// The name rides in the query string: there is no body to read, which is what
// keeps this the cheapest route in the Worker. POST rather than GET so a
// crawler, a prefetch or a link preview cannot inflate the count by visiting.
async function trackEvent(request: Request, env: Env, url: URL): Promise<Response> {
  // Charged before the name is looked at, so junk names are throttled on the
  // same budget as real ones.
  if (!(await allowed(env.EVENT_LIMIT, request, 'event'))) { metrics.refused(); return json({ error: 'Slow down.' }, 429); }
  const e = url.searchParams.get('e') || '';
  if (!isFunnelEvent(e)) { metrics.refused(); return json({ error: 'Unknown event.' }, 400); }
  metrics.funnel(e);
  return new Response(null, { status: 204, headers: securityHeaders(false) });
}

async function mintRoom(request: Request, env: Env, pathname: string): Promise<Response> {
  // Each table is its own Durable Object, so there's no shared pool to
  // exhaust — but minting one costs storage, so it is gated per IP.
  if (!(await allowed(env.NEW_ROOM_LIMIT, request, 'new'))) {
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

// Everything else is the single-page app; /g/CODE resolves to the app shell so
// a shared link opens that table.
//
// The shell is asked for as `/`, not `/index.html`. Under the assets binding's
// default html_handling — auto-trailing-slash — `/index.html` is not a file you
// can fetch: it answers 307 to `/`. That redirect used to be handed straight to
// the browser, which followed it to the front door and dropped the code out of
// the URL, so a shared link asked for a name and then for the code the link
// already carried.
async function assetRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const assetReq = url.pathname.startsWith('/g/')
    ? new Request(new URL('/', url), request)
    : request;
  const asset = await env.ASSETS.fetch(assetReq);
  const isHtml = (asset.headers.get('content-type') || '').includes('text/html');
  const out = new Response(asset.body, asset);
  for (const [k, v] of Object.entries(securityHeaders(isHtml))) out.headers.set(k, v);
  // Only a file that was actually found is worth an hour in a browser cache. A
  // redirect or a miss cached that long is a mistake you cannot take back.
  out.headers.set('cache-control', isHtml || out.status >= 300 ? 'no-cache' : 'public, max-age=3600');
  return isHtml && out.status < 300 ? stampAssets(out, env) : out;
}

/** A root-relative `href`/`src` — the shell's own stylesheet and script, and
 *  nothing else. The icon is a `data:` URL and the card image is an absolute
 *  one on a `content` attribute, so neither is matched: somebody else's URL is
 *  somebody else's cache policy. */
const ASSET_URL = /\b(href|src)="(\/[^"]*)"/g;

// The shell names `/app.js` and `/styles.css` without a hash, so a deploy
// changes what is behind those two URLs without changing the URLs themselves,
// and a browser still holding the previous hour's copy goes on using it. That
// is worse than either build on its own: a phone that was playing an hour ago
// gets the new script against the old stylesheet, which is how a change ships
// green and lands broken.
//
// The shell is the one thing never cached, so stamping the deployed version
// into it is enough — new deploy, new query, new URL, new fetch — while within
// a deploy the URLs are stable and the hour above still does its job. The
// assets binding matches on path alone, so the stamp costs the lookup nothing.
//
// A string pass rather than HTMLRewriter: this markup is ours, it is under
// 3KB, and the suites run under Node where that global does not exist. A rule
// that can only be checked in production is how this got shipped in the first
// place.
async function stampAssets(html: Response, env: Env): Promise<Response> {
  const v = env.CF_VERSION?.id;
  if (!v) return html;              // nothing to stamp with: an hour stale beats a broken shell
  const body = (await html.text()).replace(ASSET_URL, (_m, attr, path) => `${attr}="${path}?v=${v}"`);
  const out = new Response(body, html);
  // The body is no longer the one the assets binding measured and tagged, and a
  // validator that outlives the stamp is the very bug this is here to fix: the
  // browser would revalidate, be told 304, and keep a shell pointing at the
  // previous deploy's files.
  for (const h of ['content-length', 'etag', 'last-modified']) out.headers.delete(h);
  return out;
}

// Throttled per IP by Cloudflare's own rate limiter — there is no process here
// to hold token buckets in, the way the Node build does. Each binding keeps its
// own namespace, so the key is the caller and nothing else.
//
// If the binding is missing the gate cannot run, and quietly proceeding without
// it is exactly the gap this closes — so say so, and let it through rather than
// locking everyone out of a working deploy. Throttled, and keyed by which gate:
// without that a missing binding would cost a line on every single request, and
// a second missing one would hide behind the first.
async function allowed(limiter: RateLimiterBinding | undefined, request: Request, which: string): Promise<boolean> {
  if (!limiter) {
    log.throttle('warn', 'rate_limiter_missing', { limit: which }, `rl:${which}`);
    return true;
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: ip });
  return success;
}
