// The Cloudflare transport. This is the build that actually serves players, and
// it is the one no local tool exercises — wrangler isn't a dependency and a
// deploy is the only other way to find out. So it gets the same scrutiny as the
// Node path, against a stand-in for the runtime.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomDO } from '../worker/room.js';
import worker from '../worker/index.js';
import { fakeCtx, DEFAULT_ENV, assetEnv, settled, FakeWS } from './helpers/durable-object.js';
import type { Env } from '../worker/env.js';

/** RoomDO takes runtime WebSockets; FakeWS implements the handful of methods it
 *  actually calls, so it is handed over explicitly rather than by accident. */
const asWS = (ws: FakeWS) => ws as unknown as WebSocket;

async function freshTable(code = 'TESTAB') {
  const harness = fakeCtx();
  const doo = new RoomDO(harness.ctx, DEFAULT_ENV);
  await settled();
  const res = await doo.fetch(new Request(`https://do/create?code=${code}`));
  assert.equal(res.status, 200);
  return { doo, ...harness };
}

async function seatedHost(code = 'TESTAB') {
  const t = await freshTable(code);
  const host = t.connect();
  await t.doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'join', name: 'Host' }));
  return { ...t, host };
}

describe('routing', () => {
  test('a table can be created once', async () => {
    const { doo, store } = await freshTable();
    assert.ok(store.has('room'));
    const again = await doo.fetch(new Request('https://do/create?code=TESTAB'));
    assert.equal(again.status, 409, 'creating the same table twice should conflict');
  });

  test('info describes the table without leaking it', async () => {
    const { doo } = await seatedHost();
    const info: any = await doo.fetch(new Request('https://do/info')).then((r) => r.json());
    assert.equal(info.code, 'TESTAB');
    assert.equal(info.phase, 'lobby');
    assert.equal(info.players, 1);
    assert.equal(info.game, undefined, 'the lookup must not carry game state');
  });

  test('an unknown path is a 404', async () => {
    const { doo } = await freshTable();
    assert.equal((await doo.fetch(new Request('https://do/nope'))).status, 404);
  });
});

describe('joining', () => {
  test('a join is answered, stamped on the socket, and persisted', async () => {
    const { host, store } = await seatedHost();
    const you = (host.find('you') as any);
    assert.ok(you?.pid);
    assert.equal((host.att as any)?.pid, you.pid, 'the socket must carry its identity across hibernation');
    assert.equal((store.get('room') as any).players.length, 1);
  });

  test('a refused join is fatal and closes the socket', async () => {
    const { doo, connect, host } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));

    const late = connect();
    await doo.webSocketMessage(asWS(late), JSON.stringify({ t: 'join', name: 'Latecomer' }));
    assert.equal(late.last()?.t, 'fatal');
    assert.equal(late.closed?.code, 4005);
  });

  test('a spectator may join a running game but not play', async () => {
    const { doo, connect, host } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));

    const watcher = connect();
    await doo.webSocketMessage(asWS(watcher), JSON.stringify({ t: 'join', name: 'Nosy', spectate: true }));
    assert.ok((watcher.find('you') as any));
    await doo.webSocketMessage(asWS(watcher), JSON.stringify({ t: 'start' }));
    assert.equal((watcher.last() as any)?.msg, "You're watching this game.");
  });
});

// Every message that changes the table costs a storage write, and every message
// that doesn't must not. A heartbeat arriving every few seconds from every
// socket is the case that would quietly run up a bill.
describe('storage writes', () => {
  test('a real action is persisted', async () => {
    const { doo, host, counts, store } = await seatedHost();
    const before = counts.puts;
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    assert.ok(counts.puts > before, 'seating a bot was not persisted');
    assert.equal((store.get('room') as any).players.length, 2);
  });

  test('a heartbeat costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    const before = counts.puts;
    for (let i = 0; i < 20; i++) await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'ping' }));
    assert.equal(counts.puts, before, `20 pings cost ${counts.puts - before} writes`);
    assert.equal(host.last()?.t, 'pong', 'but they must still be answered');
  });

  test('an unknown verb costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    const before = counts.puts;
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'nonsense-verb' }));
    assert.equal(counts.puts, before);
  });

  test('a rejected action costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));
    const before = counts.puts;
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));   // already started
    assert.equal(host.last()?.t, 'error');
    assert.equal(counts.puts, before, 'a refusal should not be written to storage');
  });
});

// Skipping the write for a failed message only keeps the table honest while the
// table it half-changed is also gone, and the object is not evicted just
// because a message failed. So a fault is answered with a reload and a refusal
// is not — the two costs are different because the two risks are.
describe('a message that goes wrong', () => {
  test('an ordinary refusal is not paid for with a reload', async () => {
    const { doo, host, counts } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));
    const before = counts.gets;
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));    // already started
    assert.equal(host.last()?.t, 'error');
    assert.equal(counts.gets, before, 'a refusal read the table back out of storage');
  });

  test('a fault is rolled back rather than carried out by the next write', async () => {
    const { doo, host, store } = await seatedHost();
    // Nothing in the engine throws after it has mutated — that is exactly what
    // makes a refusal safe to answer cheaply — so the dangerous shape has to be
    // arranged by hand: a change applied, and then a fault.
    const room = doo.room!;
    const real = room.tick.bind(room);
    let boom = true;
    room.tick = () => { if (boom) { boom = false; throw new TypeError('mid-way fault'); } real(); };

    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    assert.equal(host.last()?.t, 'error');
    assert.equal(doo.room!.players.length, 1, 'the half-seated bot is still in memory');

    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    assert.equal((store.get('room') as any).players.length, 2, 'the next action wrote the half-applied change out');
  });
});

describe('hibernation', () => {
  test('a table rebuilds from storage with its sockets reattached', async () => {
    const { ctx, host, doo } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));

    // Evicted and woken: a brand new instance over the same storage and sockets.
    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();

    assert.equal(woken.room?.code, 'TESTAB');
    assert.equal(woken.room.players.length, 2);
    assert.ok(woken.room.game, 'the game did not survive eviction');
    assert.ok(woken.room.players.some((p) => p.connected), 'no socket was rebound');
  });

  // The flag is deployment config, not table state. If it rode along in storage,
  // turning chat off would leave every table minted before the deploy talking
  // until it expired — which is the opposite of what turning it off is for.
  test('chat does not survive the flag being turned off', async () => {
    const harness = fakeCtx();
    const doo = new RoomDO(harness.ctx, { ...DEFAULT_ENV, CHAT_ENABLED: '1' });
    await settled();
    await doo.fetch(new Request('https://do/create?code=TESTAB'));
    const host = harness.connect();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'join', name: 'Host' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'chat', text: 'hello' }));
    assert.equal(doo.room!.chat.filter((c) => !c.system).length, 1, 'the flag did not turn chat on');

    // Evicted, and woken by a deploy that no longer runs chat.
    const woken = new RoomDO(harness.ctx, DEFAULT_ENV);
    await settled();
    await woken.webSocketMessage(asWS(host), JSON.stringify({ t: 'chat', text: 'again' }));

    assert.equal(host.last()?.t, 'error');
    assert.equal(woken.room!.chat.filter((c) => !c.system).length, 1, 'a line landed after the flag went off');
  });

  // A variant is behaviour, and behaviour does not survive storage — structured
  // clone refuses an object with functions on it, so the game is stored by name
  // and put back on the way in. Get that wrong and a Chicken Foot table wakes
  // up either unable to write at all or holding a variant with no methods, and
  // the next play throws rather than failing anywhere visible.
  test('a chicken foot table wakes up still playing chicken foot', async () => {
    const { ctx, host, doo } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'settings', settings: { game: 'chickenFoot' } }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));
    assert.equal(doo.room!.game!.trains.length, 1, 'the table did not start as chicken foot');

    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();

    const game = woken.room!.game!;
    assert.equal(game.variant.name, 'chickenFoot', 'the variant did not survive eviction');
    assert.equal(typeof game.variant.layTrains, 'function', 'the variant came back with no behaviour');
    // The proof it is usable and not merely present: dealing a round runs
    // straight through the variant that was just put back.
    game.startRound();
    assert.equal(game.trains.length, 1, 'a woken chicken foot table dealt itself trains');
  });

  // A table stored before there was a game to choose has no name in it at all.
  test('a table stored without a game name comes back as mexican train', async () => {
    const { ctx, host, doo } = await seatedHost();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'start' }));

    const stored = doo.room!.toJSON() as Record<string, any>;
    delete stored.settings.game;
    delete (stored.game as Record<string, unknown>).game;
    await ctx.storage.put('state', stored);

    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();
    assert.equal(woken.room!.game!.variant.name, 'mexicanTrain');
    assert.equal(woken.room!.settings.game, 'mexicanTrain');
  });

  test('a woken table still answers its sockets', async () => {
    const { ctx, host } = await seatedHost();
    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();
    await woken.webSocketMessage(asWS(host), JSON.stringify({ t: 'ping' }));
    assert.equal(host.last()?.t, 'pong');
  });
});

// Usage telemetry on this build cannot go in the logs — they are billed per
// line — and cannot go in memory, because there isn't any that outlives a
// request. It goes to Analytics Engine, so what matters here is that the points
// are written at all, and that a deploy without the datasets still works.
const dataset = (into: any[]) => ({ writeDataPoint: (p: any) => into.push(p) });
function analyticsEnv() {
  const tables: any[] = [], funnel: any[] = [];
  return { tables, funnel, env: { ...DEFAULT_ENV, TABLES: dataset(tables), FUNNEL: dataset(funnel) } as unknown as Env };
}

describe('telemetry', () => {
  const post = (path: string, env: Env) => worker.fetch(new Request(`https://mexicantrain.example${path}`, { method: 'POST' }), env);

  test('a cleared table writes one point, with the people who were here', async () => {
    const { tables, env } = analyticsEnv();
    const harness = fakeCtx();
    const doo = new RoomDO(harness.ctx, env);
    await settled();
    await doo.fetch(new Request('https://do/create?code=TESTAB'));
    const host = harness.connect();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'join', name: 'Host' }));
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'addBot' }));
    await doo.webSocketClose(asWS(host));

    doo.room!.emptySince = Date.now() - 60 * 60_000;    // abandoned an hour ago
    await doo.alarm();

    assert.equal(tables.length, 1, `a cleared table wrote ${tables.length} points`);
    const [p] = tables;
    assert.equal(p.blobs[0], 'empty');
    assert.equal(p.doubles[1], 2, 'peak players');
    assert.equal(p.doubles[2], 1, 'humans');
    assert.equal(p.doubles[3], 1, 'bots');
  });

  test('a funnel event is a point and an empty answer', async () => {
    const { funnel, env } = analyticsEnv();
    const r = await post('/api/event?e=made', env);
    assert.equal(r.status, 204);
    assert.deepEqual(funnel.map((p: any) => p.blobs[0]), ['made']);
  });

  test('a name nobody agreed on writes nothing', async () => {
    const { funnel, env } = analyticsEnv();
    assert.equal((await post('/api/event?e=havoc', env)).status, 400);
    assert.equal((await post('/api/event', env)).status, 400);
    assert.equal(funnel.length, 0);
  });

  test('a deploy with no datasets is a deploy without telemetry, not a broken one', async () => {
    assert.equal((await post('/api/event?e=home', DEFAULT_ENV)).status, 204);
    const { doo } = await seatedHost('NODATA');
    doo.room!.emptySince = Date.now() - 60 * 60_000;
    await assert.doesNotReject(() => doo.alarm());
  });
});

// The 24-hour ceiling is the promise that nothing is kept, and on this host it
// has to be kept twice over: emptying the storage does not evict the object, so
// a table cleared by the alarm has to be dropped from memory in the same breath
// or the guards that turn people away still see one.
describe('a cleared table', () => {
  async function clearedByCeiling() {
    const { tables, env } = analyticsEnv();
    const harness = fakeCtx();
    const doo = new RoomDO(harness.ctx, env);
    await settled();
    await doo.fetch(new Request('https://do/create?code=TESTAB'));
    const host = harness.connect();
    await doo.webSocketMessage(asWS(host), JSON.stringify({ t: 'join', name: 'Host' }));

    doo.room!.createdAt = Date.now() - 25 * 3_600_000;    // past MAX_LIFETIME_HOURS
    await doo.alarm();
    return { doo, tables, ...harness };
  }

  test('it is gone from memory as well as from storage', async () => {
    const { doo, store } = await clearedByCeiling();
    assert.equal(doo.room, null, 'the object is still holding a table it disposed of');
    // The alarm included: deleteAll() leaves it standing on a Worker dated
    // before 2026-02-24, so it has to be unset by hand.
    assert.deepEqual([...store.keys()], [], 'something outlived the table');
  });

  test('nobody can open a socket on it or join it', async () => {
    const { doo, connect, store } = await clearedByCeiling();
    assert.equal((await doo.fetch(new Request('https://do/ws'))).status, 404, 'a cleared table accepted a new socket');

    const late = connect();
    await doo.webSocketMessage(asWS(late), JSON.stringify({ t: 'join', name: 'Latecomer' }));
    assert.equal(late.last()?.t, 'fatal');
    assert.equal(late.find('you'), undefined, 'a cleared table seated somebody');
    assert.deepEqual([...store.keys()], [], 'the table was written back to storage by a join it should have refused');
  });

  // The sample is the one row a table is ever worth, and it is written by
  // dispose. A table that came back to life would file a second one for itself.
  test('it is sampled exactly once, however often the alarm fires again', async () => {
    const { doo, tables } = await clearedByCeiling();
    await doo.alarm();
    await doo.alarm();
    assert.equal(tables.length, 1, `one table wrote ${tables.length} points`);
  });
});

// The front door of the Worker itself. A shared link is the only way anyone but
// the host reaches a table, so what /g/CODE answers with is worth pinning.
describe('serving the app', () => {
  const get = (path: string) => worker.fetch(new Request(`https://mexicantrain.example${path}`), assetEnv());

  test('a shared link serves the app itself, never a redirect', async () => {
    const r = await get('/g/ABC123');
    assert.equal(r.status, 200, 'a redirect here sends the player to the front door without their code');
    assert.match(r.headers.get('content-type')!, /text\/html/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  });

  test('the front door is served the same way', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/html/);
  });

  test('static files are cacheable, and nothing else is', async () => {
    assert.equal((await get('/app.js')).headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await get('/nope.png')).headers.get('cache-control'), 'no-cache');
  });

  // Those two things together are the trap: the shell is always fresh, the
  // files it names are cached for an hour, and the names never change. A phone
  // that was playing an hour before a deploy pairs the new script with the old
  // stylesheet, which is how a change ships green and lands broken.
  test('the shell names this deploy of the files it points at', async () => {
    const body = await (await get('/')).text();
    assert.match(body, /href="\/styles\.css\?v=dep1oy"/);
    assert.match(body, /src="\/app\.js\?v=dep1oy"/);
  });

  test('a shared link gets the same stamped shell', async () => {
    assert.match(await (await get('/g/ABC123')).text(), /src="\/app\.js\?v=dep1oy"/);
  });

  test('somebody else\'s URL keeps somebody else\'s cache policy', async () => {
    assert.match(await (await get('/')).text(), /href="data:image\/svg\+xml,%3Csvg\/%3E"/);
  });

  // A validator that outlives the stamp is the bug wearing a different hat: the
  // browser revalidates, is told 304, and keeps a shell naming the last deploy.
  test('a stamped shell carries no validator for its old body', async () => {
    const r = await get('/');
    assert.equal(r.headers.get('etag'), null);
    assert.equal(r.headers.get('content-length'), null);
  });

  test('no version to stamp with leaves the shell alone rather than breaking it', async () => {
    const r = await worker.fetch(new Request('https://mexicantrain.example/'), assetEnv(null));
    const body = await r.text();
    assert.equal(r.status, 200);
    assert.match(body, /href="\/styles\.css"/, 'an hour stale beats a shell that does not load');
    assert.doesNotMatch(body, /\?v=/);
  });
});
