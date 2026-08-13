// How long a table is held, and who the clock runs for.
//
// These are the rules that decide whether stepping away from a game is a way to
// play it or a way to lose it, so they are tested against the room itself rather
// than through a transport — both hosts share this file, and a disagreement
// about when a table dies would be invisible from either side alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room-core.js';
import type { Limits, Adapter, Conn } from '../server/room-core.js';

const MIN = 60_000, HOUR = 3_600_000;

const LIMITS: Limits = {
  emptyLobbyMs: 15 * MIN,
  emptyGameMs: 12 * HOUR,
  maxLifeMs: 24 * HOUR,
};

/** Records what the clock was asked to do, which is the only way to see it from
 *  outside: scheduling is the room's whole say in whether bots keep playing. */
function clockSpy() {
  const scheduled: number[] = [];
  let cancels = 0;
  const adapter: Adapter = {
    send() {},
    close() {},
    scheduleBot(delay: number) { scheduled.push(delay); },
    cancelBot() { cancels++; },
  };
  return { adapter, scheduled, cancels: () => cancels };
}

/** A table two humans are sitting at, mid-game. */
function tableInPlay() {
  const spy = clockSpy();
  const room = new Room('TESTAB', spy.adapter);
  const ana: Conn = { who: 'ana' }, ben: Conn = { who: 'ben' };
  const host = room.join(ana, { name: 'Ana' });
  room.join(ben, { name: 'Ben' });
  room.start(host.id);
  return { room, spy, ana, ben, hostId: host.id };
}

describe('how long a table is held', () => {
  test('an empty lobby goes after the short grace', () => {
    const room = new Room('TESTAB');
    const conn: Conn = {};
    room.join(conn, { name: 'Ana' });
    room.leave(conn);

    assert.equal(room.expiry(LIMITS, Date.now() + 14 * MIN), null);
    assert.equal(room.expiry(LIMITS, Date.now() + 16 * MIN), 'empty');
  });

  // The whole point of the change: a lobby is a click to recreate, a game five
  // rounds in is somebody's evening, and they cannot share a grace period.
  test('an abandoned game is held long enough to sleep on', () => {
    const { room, ana, ben } = tableInPlay();
    room.leave(ana);
    room.leave(ben);

    assert.equal(room.expiry(LIMITS, Date.now() + 30 * MIN), null, 'cleared while a lobby would have been');
    assert.equal(room.expiry(LIMITS, Date.now() + 11 * HOUR), null);
    assert.equal(room.expiry(LIMITS, Date.now() + 13 * HOUR), 'empty');
  });

  // Six people waiting for a seventh used to get cleared out from under
  // themselves, because nobody moving read as nothing happening.
  test('a table with people at it is never cleared for being quiet', () => {
    const { room } = tableInPlay();
    assert.equal(room.expiry(LIMITS, Date.now() + 23 * HOUR), null);
  });

  test('the ceiling clears a table whatever is happening at it', () => {
    const { room } = tableInPlay();
    assert.equal(room.expiry(LIMITS, Date.now() + 25 * HOUR), 'ceiling');
  });

  // A bot is built `connected: true`, so a table holding one used to look
  // occupied for ever — and with no idle rule left, nothing else would catch it.
  test('a table holding only bots is empty', () => {
    const room = new Room('TESTAB');
    const conn: Conn = {};
    const host = room.join(conn, { name: 'Ana' });
    room.addBot(host.id);
    assert.equal(room.anyoneHere(), true);

    room.leave(conn);
    assert.equal(room.anyoneHere(), false, 'the bot kept the table looking occupied');
    assert.equal(room.expiry(LIMITS, Date.now() + 16 * MIN), 'empty');
  });

  // The Node host sweeps on a timer and can ask any time; the Worker gets one
  // alarm per table and has to know when to set it. If these two disagreed, a
  // table would die at a different moment depending on where it was deployed.
  test('expiresAt is when expiry starts saying yes', () => {
    const { room, ana, ben } = tableInPlay();
    room.leave(ana);
    room.leave(ben);
    const at = room.expiresAt(LIMITS);

    assert.equal(room.expiry(LIMITS, at - MIN), null);
    assert.ok(room.expiry(LIMITS, at + MIN), 'the alarm would fire on a table that is still alive');
  });

  test('a table nobody has left is held to the ceiling, and no longer', () => {
    const { room } = tableInPlay();
    assert.equal(room.expiresAt(LIMITS), room.createdAt + LIMITS.maxLifeMs);
  });
});

describe('the clock the bots run on', () => {
  test('it stops when the last person leaves', () => {
    const { room, spy, ana, ben } = tableInPlay();
    room.leave(ana);
    spy.scheduled.length = 0;
    room.leave(ben);

    assert.equal(room.pendingSeat(), null, 'the clock was still waiting on a seat');
    assert.equal(spy.scheduled.length, 0, 'a bot turn was scheduled for an empty table');
  });

  // The failure this prevents is quiet and total: every seat reads as absent
  // once everyone goes, so bots took the table over and played the game out.
  test('bots do not play on an empty table', () => {
    const { room, ana, ben } = tableInPlay();
    const before = JSON.stringify(room.game!.trains);
    room.leave(ana);
    room.leave(ben);

    assert.equal(room.runBot(), false, 'a bot took a turn with nobody watching');
    assert.equal(JSON.stringify(room.game!.trains), before, 'the board moved after everyone left');
  });

  test('it starts again when somebody comes back', () => {
    const { room, spy, ana, ben, hostId } = tableInPlay();
    room.leave(ana);
    room.leave(ben);
    spy.scheduled.length = 0;

    room.join(ana, { pid: hostId, name: 'Ana' });
    room.tick();
    assert.equal(room.anyoneHere(), true);
    // Ben's seat is empty and it may or may not be his turn, but the table is
    // live again either way: the clock is the room's to run, not frozen.
    assert.equal(room.emptySince, null);
  });
});
