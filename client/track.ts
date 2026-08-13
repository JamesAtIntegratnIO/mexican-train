// The handful of moments the server cannot see for itself.
//
// Everything before a socket opens is invisible to it: someone who lands on the
// front page and leaves, or opens a shared link and never says who they are,
// creates no table and produces no log line. Those are exactly the people worth
// knowing about, so the client says when they happen.
//
// What goes out is one name from a closed list and nothing else — no id, no
// cookie, no path, nothing that could follow one person between two of them.
// The server counts the name and discards the request. Same-origin, so the
// page's own `connect-src 'self'` already allows it and no CSP has to be
// loosened to let telemetry out.
//
// Never awaited, never retried, and it cannot throw: a counter is not worth a
// broken button. `keepalive` lets the last one survive the navigation that
// immediately follows it, which is the whole reason `made` is ever recorded.

import type { FunnelEvent } from '../shared/protocol.js';

export function track(e: FunnelEvent): void {
  try {
    void fetch('/api/event?e=' + e, { method: 'POST', keepalive: true }).catch(() => {});
  } catch { /* an offline browser refusing outright is still not worth a fault */ }
}
