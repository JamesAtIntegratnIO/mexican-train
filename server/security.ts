// Abuse controls and browser hardening. Nothing here is game logic — it exists
// because the server is a long-lived process holding everyone's state in memory,
// so cheap requests must stay cheap.

import type { IncomingMessage } from 'node:http';
import { HSTS, originAllowed as allowsOrigin, parseOrigins, policyHeaders } from '../shared/http-policy.js';
import { flagOn } from '../shared/flags.js';

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

// The Node half of the origin check: pull the three strings out of the request
// and let shared/http-policy answer. The allow-list is read from the
// environment per call rather than once at load, so this host asks the question
// from the same place the Worker asks it — its env — and a table of origins can
// be put through both. It is a split of a short string on a route that already
// does more work than that.
export function originAllowed(req: IncomingMessage): boolean {
  return allowsOrigin(req.headers.origin, parseOrigins(process.env.ALLOWED_ORIGINS), req.headers.host ?? '');
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

// The policy itself is in shared/http-policy, said once for both hosts. All
// this host adds is the one line it alone can decide: HSTS is a promise the
// browser holds us to for a year, so it is claimed only when the proxy in front
// says it terminated TLS — a dev process on plain http that made it would lock
// the browser out of itself.
export function securityHeaders(req: IncomingMessage, isHtml: boolean): Record<string, string> {
  const h = policyHeaders(isHtml);
  if (req.headers['x-forwarded-proto'] === 'https') h['strict-transport-security'] = HSTS;
  return h;
}
