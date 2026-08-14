// Abuse controls and browser hardening. Nothing here is game logic — it exists
// because the server is a long-lived process holding everyone's state in memory,
// so cheap requests must stay cheap.

import type { IncomingMessage } from 'node:http';
import { HSTS, originAllowed as allowsOrigin, parseOrigins, policyHeaders } from '../shared/http-policy.js';

// Behind Fly/Render the client IP arrives in x-forwarded-for. That header is
// forgeable if the process is ever exposed directly, so this is a throttle, not
// an identity — never authorise anything with it.
export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
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
