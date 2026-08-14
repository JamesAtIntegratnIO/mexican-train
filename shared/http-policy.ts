// What both front doors say to a browser: the content security policy, the
// permissions policy, the headers every response carries, and the one question
// about an Origin header that has a single right answer.
//
// It knows nothing about a request. The Node host holds an `IncomingMessage`
// and the Worker holds a `Request`, and the two have nothing in common but the
// strings you can pull out of them — so this file takes strings and returns
// strings rather than inventing a request of its own, which would cost more
// than it saved. Each host keeps a short adapter that reads its own type and
// adds the part only it can decide: Node claims HSTS solely when the proxy in
// front says it terminated TLS, while a Worker is never reached any other way.
//
// This policy lived twice, once per host, identical down to the comments but
// for that HSTS line. A policy written down twice drifts on exactly one of the
// two builds, and a header quietly weaker on one host is the hardest kind of
// regression to notice — nothing fails, it just stops defending.

/** The nine directives the app actually needs, and nothing it doesn't. */
export const CSP = [
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

/** Nothing here asks for a device, and `interest-cohort` opts the page out of
 *  being profiled by one. */
export const PERMISSIONS_POLICY = 'geolocation=(), camera=(), microphone=(), interest-cohort=()';

/** A year, subdomains included. Only ever claimed over TLS — a browser told
 *  this by a plain-http process would refuse to reach it again. */
export const HSTS = 'max-age=31536000; includeSubDomains';

/** The headers a response carries, given whether it is the page or an answer.
 *  A JSON body cannot be framed and cannot run a script, so the page-shaped
 *  half rides only on the page. */
export function policyHeaders(isHtml: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (!isHtml) return h;
  h['x-frame-options'] = 'DENY';
  h['content-security-policy'] = CSP;
  h['permissions-policy'] = PERMISSIONS_POLICY;
  return h;
}

/** The allow-list as both hosts receive it: one comma-separated string of
 *  hosts, e.g. "mexicantrain.fly.dev,train.example.com". Empty means nobody was
 *  named, which is not the same as naming nobody — see below. */
export const parseOrigins = (value: string | undefined): string[] =>
  (value || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Browsers always send Origin on cross-site requests and on every WS upgrade,
 *  so this blocks other sites driving our tables. A non-browser client can
 *  forge it and that's fine — it was never the threat this defends against.
 *
 *  Naming an allow-list replaces the same-origin default rather than adding to
 *  it: a deployment that lists its hosts has said which they are. */
export function originAllowed(origin: string | null | undefined, allowed: readonly string[], selfHost: string): boolean {
  if (!origin) return true;                         // curl, tests, native clients
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  if (allowed.length) return allowed.includes(host);
  // A host of '' comes from an origin with no authority at all, and would
  // otherwise match a request that arrived without a Host header to compare to.
  return host !== '' && host === selfHost;          // same-origin default
}
