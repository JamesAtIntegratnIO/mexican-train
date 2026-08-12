// Abuse controls and browser hardening. Nothing here is game logic — it exists
// because the server is a long-lived process holding everyone's state in memory,
// so cheap requests must stay cheap.

// Comma-separated hosts, e.g. "mexicantrain.fly.dev,train.example.com".
// Left unset, only same-origin browser requests are accepted.
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Behind Fly/Render the client IP arrives in x-forwarded-for. That header is
// forgeable if the process is ever exposed directly, so this is a throttle, not
// an identity — never authorise anything with it.
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Browsers always send Origin on cross-site requests and on every WS upgrade, so
// this blocks other sites driving our server. A non-browser client can forge it
// and that's fine — it was never the threat this defends against.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl, tests, native clients
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (ALLOWED.length) return ALLOWED.includes(host);
  return host === req.headers.host;               // same-origin default
}

// Token bucket: `capacity` in one burst, refilling at `perSec`.
export function rateLimiter({ capacity, perSec, idleMs = 10 * 60_000 }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
  }, 60_000);
  timer.unref();

  return function take(key, cost = 1) {
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

export function securityHeaders(req, isHtml) {
  const h = {
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
