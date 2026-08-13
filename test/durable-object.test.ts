// The Cloudflare transport. This is the build that actually serves players, and
// it is the one no local tool exercises — wrangler isn't a dependency and a
// deploy is the only other way to find out. So it gets the same scrutiny as the
// Node path, against a stand-in for the runtime.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomDO } from '../worker/room.js';
import { fakeCtx, DEFAULT_ENV, settled } from './helpers/durable-object.js';

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
  await t.doo.webSocketMessage(host, JSON.stringify({ t: 'join', name: 'Host' }));
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
    const info = await doo.fetch(new Request('https://do/info')).then((r) => r.json());
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
    const you = host.find('you');
    assert.ok(you?.pid);
    assert.equal(host.att?.pid, you.pid, 'the socket must carry its identity across hibernation');
    assert.equal(store.get('room').players.length, 1);
  });

  test('a refused join is fatal and closes the socket', async () => {
    const { doo, connect, host } = await seatedHost();
    await doo.webSocketMessage(host, JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(host, JSON.stringify({ t: 'start' }));

    const late = connect();
    await doo.webSocketMessage(late, JSON.stringify({ t: 'join', name: 'Latecomer' }));
    assert.equal(late.last()?.t, 'fatal');
    assert.equal(late.closed?.code, 4005);
  });

  test('a spectator may join a running game but not play', async () => {
    const { doo, connect, host } = await seatedHost();
    await doo.webSocketMessage(host, JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(host, JSON.stringify({ t: 'start' }));

    const watcher = connect();
    await doo.webSocketMessage(watcher, JSON.stringify({ t: 'join', name: 'Nosy', spectate: true }));
    assert.ok(watcher.find('you'));
    await doo.webSocketMessage(watcher, JSON.stringify({ t: 'start' }));
    assert.equal(watcher.last()?.msg, "You're watching this game.");
  });
});

// Every message that changes the table costs a storage write, and every message
// that doesn't must not. A heartbeat arriving every few seconds from every
// socket is the case that would quietly run up a bill.
describe('storage writes', () => {
  test('a real action is persisted', async () => {
    const { doo, host, counts, store } = await seatedHost();
    const before = counts.puts;
    await doo.webSocketMessage(host, JSON.stringify({ t: 'addBot' }));
    assert.ok(counts.puts > before, 'seating a bot was not persisted');
    assert.equal(store.get('room').players.length, 2);
  });

  test('a heartbeat costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    const before = counts.puts;
    for (let i = 0; i < 20; i++) await doo.webSocketMessage(host, JSON.stringify({ t: 'ping' }));
    assert.equal(counts.puts, before, `20 pings cost ${counts.puts - before} writes`);
    assert.equal(host.last()?.t, 'pong', 'but they must still be answered');
  });

  test('an unknown verb costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    const before = counts.puts;
    await doo.webSocketMessage(host, JSON.stringify({ t: 'nonsense-verb' }));
    assert.equal(counts.puts, before);
  });

  test('a rejected action costs nothing', async () => {
    const { doo, host, counts } = await seatedHost();
    await doo.webSocketMessage(host, JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(host, JSON.stringify({ t: 'start' }));
    const before = counts.puts;
    await doo.webSocketMessage(host, JSON.stringify({ t: 'start' }));   // already started
    assert.equal(host.last()?.t, 'error');
    assert.equal(counts.puts, before, 'a refusal should not be written to storage');
  });
});

describe('hibernation', () => {
  test('a table rebuilds from storage with its sockets reattached', async () => {
    const { ctx, host, doo } = await seatedHost();
    await doo.webSocketMessage(host, JSON.stringify({ t: 'addBot' }));
    await doo.webSocketMessage(host, JSON.stringify({ t: 'start' }));

    // Evicted and woken: a brand new instance over the same storage and sockets.
    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();

    assert.equal(woken.room?.code, 'TESTAB');
    assert.equal(woken.room.players.length, 2);
    assert.ok(woken.room.game, 'the game did not survive eviction');
    assert.ok(woken.room.players.some((p) => p.connected), 'no socket was rebound');
  });

  test('a woken table still answers its sockets', async () => {
    const { ctx, host } = await seatedHost();
    const woken = new RoomDO(ctx, DEFAULT_ENV);
    await settled();
    await woken.webSocketMessage(host, JSON.stringify({ t: 'ping' }));
    assert.equal(host.last()?.t, 'pong');
  });
});
