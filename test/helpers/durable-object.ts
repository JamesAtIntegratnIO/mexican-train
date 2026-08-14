// A stand-in for the Durable Object runtime: storage that survives, sockets
// that carry an attachment across "hibernation", and a counter on writes so a
// test can assert that a ping costs nothing.
//
// Not a Workers emulator — it implements exactly the surface RoomDO touches,
// which is small and stable. The alternative is running wrangler in CI to test
// twenty lines of routing, and this catches the same mistakes far faster.

import type { ServerMessage } from '../../shared/protocol.js';

export class FakeWS {
  sent: ServerMessage[] = [];
  att: unknown = null;
  closed: { code: number; reason: string } | null = null;

  send(s: string): void { this.sent.push(JSON.parse(s)); }
  close(code: number, reason: string): void { this.closed = { code, reason }; }
  serializeAttachment(v: unknown): void { this.att = structuredClone(v); }
  deserializeAttachment(): unknown { return this.att; }
  last(): ServerMessage | undefined { return this.sent[this.sent.length - 1]; }
  find<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.sent.find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

export function fakeCtx() {
  const store = new Map<string, unknown>();
  const sockets: FakeWS[] = [];
  // Reads are counted alongside writes because the Worker spends them
  // deliberately: rebuilding the table after a fault is a read, and not
  // rebuilding it after an ordinary refusal is the whole point of that choice.
  const counts = { puts: 0, deletes: 0, alarms: 0, gets: 0 };

  const ctx = {
    storage: {
      get: async (k: string) => { counts.gets++; return store.get(k); },
      put: async (k: string, v: unknown) => { counts.puts++; store.set(k, structuredClone(v)); },
      delete: async (k: string) => { counts.deletes++; store.delete(k); },
      // The alarm survives deleteAll here because it survives it on the real
      // thing: only Workers dated 2026-02-24 or later have deleteAll() clear a
      // pending alarm, and this one is dated 2025-04-01. A fake that swept it
      // away would quietly excuse the Worker from unsetting it.
      deleteAll: async () => { const alarm = store.get('__alarm'); store.clear(); if (alarm !== undefined) store.set('__alarm', alarm); },
      getAlarm: async () => store.get('__alarm') ?? null,
      setAlarm: async (t: number) => { counts.alarms++; store.set('__alarm', t); },
      deleteAlarm: async () => { store.delete('__alarm'); },
    },
    blockConcurrencyWhile: <T>(fn: () => T): T => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => { sockets.push(ws); },
  };

  return {
    // The fake implements exactly the surface RoomDO touches, which is why it
    // is handed over with a cast rather than pretending to be the real thing.
    ctx: ctx as unknown as DurableObjectState,
    store, sockets, counts,
    // Attach a socket the way the runtime would once it has been accepted.
    connect() { const ws = new FakeWS(); sockets.push(ws); return ws; },
  };
}

import type { Env } from '../../worker/env.js';

export const DEFAULT_ENV = {
  EMPTY_GRACE_MIN: '15', EMPTY_GRACE_GAME_MIN: '720', MAX_LIFETIME_HOURS: '24', LOG_LEVEL: 'error',
} as unknown as Env;

/** An env whose ASSETS binding behaves the way Cloudflare's does by default —
 *  `html_handling: "auto-trailing-slash"`, under which the app shell lives at
 *  `/` and asking for `/index.html` gets you a 307 back to it. Serving a shared
 *  link means never handing that redirect to the browser, so the stand-in has
 *  to redirect exactly where the real one does. */
export const assetEnv = (version: string | null = 'dep1oy'): Env => ({
  ...DEFAULT_ENV,
  CF_VERSION: version ? { id: version } : undefined,
  ASSETS: {
    fetch: async (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      if (pathname === '/index.html') return new Response(null, { status: 307, headers: { location: '/' } });
      // Shaped like the real shell: the two files that get version-stamped, an
      // icon that must not be (a data: URL), and a validator, so a test can
      // tell a stamped response from a passed-through one.
      if (pathname === '/') {
        return new Response(
          '<!doctype html><title>Mexican Train</title><link rel="icon" href="data:image/svg+xml,%3Csvg/%3E">'
          + '<link rel="stylesheet" href="/styles.css"><script type="module" src="/app.js"></script>',
          { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"shell"', 'content-length': '190' } },
        );
      }
      if (pathname === '/app.js') return new Response('export {}', { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      return new Response('Not found', { status: 404 });
    },
  },
} as unknown as Env);

// The constructor kicks off blockConcurrencyWhile, which can't be awaited from
// a constructor — give it a turn before touching the object.
export const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
