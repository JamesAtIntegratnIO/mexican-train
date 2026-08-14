// Abuse controls and browser hardening. Nothing here is game logic — it exists
// because the server is a long-lived process holding everyone's state in memory,
// so cheap requests must stay cheap.

import type { IncomingMessage } from 'node:http';
import { flagOn } from '../shared/flags.js';

// Comma-separated hosts, e.g. "mexicantrain.fly.dev,train.example.com".
// Left unset, only same-origin browser requests are accepted.
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Whether a reverse proxy stands in front of this process, and so whether its
// forwarding header is worth reading at all. Off unless the deployment says so:
// answering yes where there is no proxy hands every caller the keys to the
// limiter, while answering no where there is one merely lumps everybody into a
// single bucket. One of those mistakes is recoverable.
const PROXIED = flagOn(process.env.TRUST_PROXY);

// Which caller a request is charged to.
//
// x-forwarded-for is a list the caller starts and each hop appends to, so the
// *first* entry is whatever the client typed. Reading it — which is what this
// did — let anyone pick their own bucket by sending a fresh value per request:
// no limit at all, and a map entry per forgery besides. A proxy appends the peer
// it actually accepted the connection from, so the last entry is the only one
// our own infrastructure vouched for and everything before it is the caller's
// to invent. With nothing in front, the header says nothing and the socket is
// the only honest answer.
//
// Still a throttle and not an identity — never authorise anything with it.
export function clientIp(req: IncomingMessage): string {
  const direct = req.socket?.remoteAddress || 'unknown';
  if (!PROXIED) return direct;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',');
  return hops[hops.length - 1].trim() || direct;
}

// Browsers always send Origin on cross-site requests and on every WS upgrade, so
// this blocks other sites driving our server. A non-browser client can forge it
// and that's fine — it was never the threat this defends against.
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl, tests, native clients
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  if (ALLOWED.length) return ALLOWED.includes(host);
  return host === req.headers.host;               // same-origin default
}

// Token bucket: `capacity` in one burst, refilling at `perSec`.
export interface LimitOptions {
  capacity: number;
  perSec: number;
  idleMs?: number;
}

/** Returns false once the caller has spent its budget. */
export type Limiter = (key: string, cost?: number) => boolean;

export function rateLimiter({ capacity, perSec, idleMs = 10 * 60_000 }: LimitOptions): Limiter {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  const timer = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
  }, 60_000);
  timer.unref();

  return function take(key: string, cost = 1): boolean {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, ts: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * perSec);
    b.ts = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  };
}

export function securityHeaders(req: IncomingMessage, isHtml: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (req.headers['x-forwarded-proto'] === 'https') {
    h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
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
}
