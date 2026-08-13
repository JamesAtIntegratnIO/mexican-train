// A stand-in for the Durable Object runtime: storage that survives, sockets
// that carry an attachment across "hibernation", and a counter on writes so a
// test can assert that a ping costs nothing.
//
// Not a Workers emulator — it implements exactly the surface RoomDO touches,
// which is small and stable. The alternative is running wrangler in CI to test
// twenty lines of routing, and this catches the same mistakes far faster.

export class FakeWS {
  constructor() { this.sent = []; this.att = null; this.closed = null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, reason) { this.closed = { code, reason }; }
  serializeAttachment(v) { this.att = structuredClone(v); }
  deserializeAttachment() { return this.att; }
  last() { return this.sent[this.sent.length - 1]; }
  find(t) { return this.sent.find((m) => m.t === t); }
}

export function fakeCtx() {
  const store = new Map();
  const sockets = [];
  const counts = { puts: 0, deletes: 0, alarms: 0 };

  const ctx = {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { counts.puts++; store.set(k, structuredClone(v)); },
      delete: async (k) => { counts.deletes++; store.delete(k); },
      deleteAll: async () => { store.clear(); },
      getAlarm: async () => store.get('__alarm') ?? null,
      setAlarm: async (t) => { counts.alarms++; store.set('__alarm', t); },
    },
    blockConcurrencyWhile: (fn) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => { sockets.push(ws); },
  };

  return {
    ctx, store, sockets, counts,
    // Attach a socket the way the runtime would once it has been accepted.
    connect() { const ws = new FakeWS(); sockets.push(ws); return ws; },
  };
}

export const DEFAULT_ENV = { EMPTY_GRACE_MIN: '15', IDLE_MIN: '30', LOG_LEVEL: 'error' };

// The constructor kicks off blockConcurrencyWhile, which can't be awaited from
// a constructor — give it a turn before touching the object.
export const settled = () => new Promise((r) => setTimeout(r, 0));
