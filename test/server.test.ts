// The Node transport, over real HTTP and real sockets.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openSocket, sleep } from './helpers/server.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

// A table to share across the read-only checks, so they don't each burn one of
// the five the rate limiter allows per minute.
async function newTable() {
  const r = await fetch(`${srv.base}/api/new`, { method: 'POST' });
  const body: any = await r.json();
  assert.equal(r.status, 200, `mint failed: ${JSON.stringify(body)}`);
  return body.code;
}

describe('http', () => {
  test('health reports what the process is holding', async () => {
    const h: any = await fetch(`${srv.base}/api/health`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(typeof h.rooms, 'number');
    assert.equal(typeof h.uptime, 'number');
  });

  test('a minted code looks like a table code', async () => {
    assert.match(await newTable(), /^[A-HJ-NP-Z2-9]{6}$/);   // no I/O/0/1
  });

  test('an unknown table is a 404 that says so', async () => {
    const r = await fetch(`${srv.base}/api/room/ZZZZZZ`);
    assert.equal(r.status, 404);
    assert.ok(((await r.json()) as any).error);
  });

  test('a cross-site origin is refused', async () => {
    const r = await fetch(`${srv.base}/api/health`, { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
  });

  test('the single-page app is served for a table URL', async () => {
    const r = await fetch(`${srv.base}/g/ABC123`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/html/);
    assert.equal(r.headers.get('x-frame-options')!, 'DENY');
    assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
  });

  test('paths cannot climb out of the public directory', async () => {
    const r = await fetch(`${srv.base}/../server/index.js`);
    assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
    assert.doesNotMatch(await r.text(), /WebSocketServer/);
  });
});

// What the browser reports about the steps before a socket exists — the people
// who never reach a table and so never appear anywhere else.
describe('the funnel endpoint', () => {
  const counts = async (): Promise<Record<string, number>> =>
    ((await fetch(`${srv.base}/api/stats`).then((r) => r.json())) as any).counts;
  const event = (e: string) => fetch(`${srv.base}/api/event?e=${e}`, { method: 'POST' });

  test('an event is counted, and answered with nothing at all', async () => {
    const before = (await counts())['funnel.home'] ?? 0;
    const r = await event('home');
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    assert.equal((await counts())['funnel.home'], before + 1);
  });

  test('a name nobody agreed on is refused and counted as such', async () => {
    const before = (await counts())['funnel.refused'] ?? 0;
    const r = await event('please-count-something-else');
    assert.equal(r.status, 400);
    assert.equal((await counts())['funnel.refused'], before + 1);
  });

  test('a visit cannot inflate the count', async () => {
    const before = (await counts())['funnel.home'] ?? 0;
    // Crawlers, prefetchers and link previews all issue GETs. A counter that
    // moves when a page is merely fetched is not counting people.
    assert.equal((await fetch(`${srv.base}/api/event?e=home`)).status, 404);
    assert.equal((await counts())['funnel.home'] ?? 0, before);
  });

  test('an event is never a log line', async () => {
    const before = srv.logs.length;
    for (let i = 0; i < 8; i++) await event('link');
    await event('not-an-event');
    assert.equal(srv.logs.length, before, 'a stranger clicking must not write to the log');
  });

  test('stats say what this process has seen', async () => {
    const s: any = await fetch(`${srv.base}/api/stats`).then((r) => r.json());
    assert.equal(s.ok, true);
    assert.equal(typeof s.rooms, 'number');
    assert.equal(typeof s.uptime, 'number');
    assert.equal(typeof s.counts, 'object');
  });
});

describe('joining', () => {
  test('a join is answered with an identity and a snapshot', async () => {
    const code = await newTable();
    const ws = openSocket(srv.port, code);
    await ws.opened;
    ws.say({ t: 'join', name: 'Host' });

    const you = await ws.expect('you');
    assert.ok(you?.pid, 'no identity came back');
    const room = await ws.expect('room');
    assert.equal(room?.phase, 'lobby');
    assert.equal(room.seats.length, 1);
    ws.close();
  });

  test('an unknown table is fatal rather than silent', async () => {
    const ws = openSocket(srv.port, 'ZZZZZZ');
    await ws.opened;
    const fatal = await ws.expect('fatal');
    assert.match(fatal?.msg ?? '', /expired|never existed/);
    ws.close();
  });

  // The bug this pins: a refused join used to arrive as a toast, leaving the
  // client sitting on its "Joining…" spinner with no way forward.
  test('a refused join is fatal and closes the socket', async () => {
    const code = await newTable();
    const host = openSocket(srv.port, code);
    await host.opened;
    host.say({ t: 'join', name: 'Host' });
    await host.expect('you');
    host.say({ t: 'addBot' });
    await sleep(120);
    host.say({ t: 'start' });
    await sleep(200);

    const late = openSocket(srv.port, code);
    await late.opened;
    late.say({ t: 'join', name: 'Latecomer' });

    const fatal = await late.expect('fatal');
    assert.equal(fatal?.msg, 'That game is already under way.');
    assert.equal(await late.closedWith, 4005);
    assert.equal(late.seen.find((m: any) => m.t === 'error'), undefined, 'a refusal must not also arrive as a toast');
    host.close();
  });
});

describe('play', () => {
  let code: any, host: any;
  before(async () => {
    code = await newTable();
    host = openSocket(srv.port, code);
    await host.opened;
    host.say({ t: 'join', name: 'Host' });
    await host.expect('you');
  });
  after(() => host?.close());

  test('a heartbeat is answered', async () => {
    host.say({ t: 'ping' });
    assert.ok(await host.expect('pong'));
  });

  test('an unknown verb is ignored, not fatal', async () => {
    host.say({ t: 'nonsense-verb' });
    host.say({ t: 'ping' });
    assert.ok(await host.expect('pong'), 'the socket stopped answering');
  });

  test('the host can seat a bot and start', async () => {
    host.say({ t: 'addBot' });
    await sleep(150);
    host.say({ t: 'start' });
    const room = await host.expect('room', 4000);
    assert.ok(room);
    // The snapshot after start is the game; poll until it flips.
    for (let i = 0; i < 40 && host.seen.filter((m: any) => m.t === 'room').pop()?.phase !== 'game'; i++) await sleep(100);
    assert.equal(host.seen.filter((m: any) => m.t === 'room').pop()?.phase, 'game');
  });

  test('a rejected action is a readable error, not a disconnect', async () => {
    host.say({ t: 'start' });                       // already started
    const err = await host.expect('error');
    assert.equal(err?.msg, 'The game has already started.');
    assert.equal(host.readyState, 1, 'the socket should stay open');
  });

  test("a hand is never sent to anyone else", async () => {
    const watcher = openSocket(srv.port, code);
    await watcher.opened;
    watcher.say({ t: 'join', name: 'Nosy', spectate: true });
    await watcher.expect('you');
    const room = await watcher.expect('room');
    assert.deepEqual(room.game.hand, [], 'a spectator was dealt a hand');
    assert.deepEqual(room.game.moves, []);
    watcher.close();
  });

  test('spectators may watch but not play', async () => {
    const watcher = openSocket(srv.port, code);
    await watcher.opened;
    watcher.say({ t: 'join', name: 'Nosy2', spectate: true });
    await watcher.expect('you');
    watcher.say({ t: 'start' });
    const err = await watcher.expect('error');
    assert.equal(err?.msg, "You're watching this game.");
    watcher.close();
  });
});

// A room anyone can mint, that keeps no logs and disappears by morning, is a
// private channel as much as it is a card table. The feature is kept behind a
// flag rather than deleted, so both sides of the flag are tested: off is what
// deploys, and on has to still work for whoever turns it on.
describe('chat, which this deployment does not run', () => {
  test('a chat message is refused, and the socket carries on', async () => {
    const code = await newTable();
    const ws = openSocket(srv.port, code);
    await ws.opened;
    ws.say({ t: 'join', name: 'Talker' });
    await ws.expect('you');
    const room = await ws.expect('room');
    assert.equal(room.chatEnabled, false, 'the client was told chat was available');

    ws.say({ t: 'chat', text: 'meet me at the docks' });
    const err = await ws.expect('error');
    assert.equal(err?.msg, 'This table has no chat.');
    assert.equal(ws.readyState, 1, 'the socket should stay open');

    // The refusal has to be a refusal, not a hidden one: nothing may reach the
    // table for the next snapshot to hand back out.
    ws.say({ t: 'name', name: 'Talker' });
    await sleep(200);
    const after = ws.seen.filter((m: any) => m.t === 'room').pop() as any;
    assert.ok(!after.chat.some((c: any) => !c.system), 'a player line landed anyway');
    ws.close();
  });

  test('the flag still brings it back', async () => {
    const on = await startServer({ CHAT_ENABLED: '1' });
    try {
      const { code }: any = await fetch(`${on.base}/api/new`, { method: 'POST' }).then((r) => r.json());
      const ws = openSocket(on.port, code);
      await ws.opened;
      ws.say({ t: 'join', name: 'Talker' });
      await ws.expect('you');
      assert.equal((await ws.expect('room')).chatEnabled, true);

      ws.say({ t: 'chat', text: 'your go' });
      for (let i = 0; i < 40; i++) {
        const last = ws.seen.filter((m: any) => m.t === 'room').pop() as any;
        if (last?.chat.some((c: any) => c.text === 'your go' && !c.system)) { ws.close(); return; }
        await sleep(50);
      }
      assert.fail('the message never reached the table');
    } finally {
      await on.stop();
    }
  });
});

describe('abuse controls', () => {
  test('minting too fast is a 429 that explains itself', async () => {
    let limited: any = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await fetch(`${srv.base}/api/new`, { method: 'POST' });
      if (r.status === 429) limited = await r.json();
    }
    assert.ok(limited?.error, 'the limiter never tripped');
    assert.match(limited.error, /too quickly/);
  });

  // Volume is a cost on Workers, and a stranger decides how many requests to
  // send — so the rejections must not each buy a log line.
  test('a burst of rejections costs one log line, not one each', async () => {
    const before = srv.events().filter((e) => e === 'rate_limited').length;
    for (let i = 0; i < 60; i++) await fetch(`${srv.base}/api/new`, { method: 'POST' });
    await sleep(150);
    const after = srv.events().filter((e) => e === 'rate_limited').length;
    assert.ok(after - before <= 1, `60 rejections wrote ${after - before} lines`);
  });
});
