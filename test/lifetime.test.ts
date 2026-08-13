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

  // A socket drops for reasons that say nothing about the player — a locked
  // phone, a lift, a tab the browser suspended — so the table waits rather than
  // guessing. Having your hand played for you is the one thing at this table
  // nobody can undo, and it used to happen ninety seconds after a dropped
  // connection whether or not you were still sitting there.
  test('a seat is never played for the person in it, however long they are gone', () => {
    const { room, spy, ben, hostId } = tableInPlay();
    room.leave(ben);                      // Ana is still here, so the clock is running
    spy.scheduled.length = 0;
    room.game!.turn = room.game!.players.findIndex((p) => p.id !== hostId);   // Ben to play
    room.tick();

    assert.equal(room.anyoneHere(), true, 'the premise: somebody is still at the table');
    assert.equal(room.pendingSeat(), null, 'the clock took a seat its player never handed over');
    assert.equal(room.runBot(), false, "a bot played an absent human's hand");
    assert.equal(spy.scheduled.length, 0, 'a turn was scheduled for a seat nobody handed over');
  });

  // Which leaves the host to decide that somebody is not coming back. That is a
  // decision made by a person, and a returning player takes the seat back.
  test('the host can hand an empty seat over, and it comes back', () => {
    const { room, ben, hostId } = tableInPlay();
    const benId = room.players.find((p) => p.id !== hostId)!.id;
    room.leave(ben);
    room.fillSeat(hostId, benId);

    assert.equal(room.players.find((p) => p.id === benId)!.bot, true, 'the seat was not handed over');
    assert.equal(room.game!.player(benId)!.bot, true, 'the game still thinks that seat is human');

    room.join(ben, { pid: benId, name: 'Ben' });
    assert.equal(room.players.find((p) => p.id === benId)!.bot, false, 'Ben did not get his seat back');
  });

  test('a seat still occupied cannot be handed over', () => {
    const { room, hostId } = tableInPlay();
    const benId = room.players.find((p) => p.id !== hostId)!.id;
    assert.throws(() => room.fillSeat(hostId, benId), /still occupied/);
    const cara: Conn = { who: 'cara' };
    const w = room.join(cara, { name: 'Cara', spectate: true });
    assert.throws(() => room.giveSeat(hostId, benId, w.id), /still occupied/);
  });

  // The other half of it: a seat can go to somebody who is watching. What they
  // inherit is the seat — its hand, its train and its score — so the one thing
  // that must not survive is the old occupant's claim on it.
  describe('handing a seat to somebody watching', () => {
    function handedOver() {
      const t = tableInPlay();
      const seat = t.room.players.find((p) => p.id !== t.hostId)!;
      const benId = seat.id;
      const hand = [...t.room.game!.player(benId)!.hand];
      const cara: Conn = { who: 'cara' };
      const w = t.room.join(cara, { name: 'Cara', spectate: true });
      t.room.leave(t.ben);
      t.room.giveSeat(t.hostId, benId, w.id);
      return { ...t, benId, caraId: w.id, cara, hand };
    }

    test('the hand, the train and the score come with the seat', () => {
      const { room, caraId, hand } = handedOver();
      const seat = room.players.find((p) => p.id === caraId);
      assert.ok(seat, 'nobody is in the seat');
      assert.equal(seat.name, 'Cara');
      assert.equal(seat.bot, false);
      assert.deepEqual(room.game!.player(caraId)!.hand, hand, "the seat's hand did not come with it");
      assert.ok(room.game!.train(caraId), 'the train did not come with the seat');
      assert.equal(room.game!.train(caraId)!.owner, caraId);
    });

    test('they stop being a watcher, and are one player rather than two', () => {
      const { room, caraId, benId } = handedOver();
      assert.equal(room.watchers.length, 0, 'they are still in the gallery as well');
      assert.equal(room.players.length, 2, 'the table grew a seat');
      assert.equal(room.game!.players.length, 2);
      assert.equal(room.game!.player(benId), undefined, 'the old identity is still at the table');
    });

    // Ben's browser still remembers the seat, because nothing on this table can
    // reach into it. The claim it remembers is simply no longer anybody's, so
    // he is turned away like any latecomer — the client drops the dead seat on
    // a refusal and offers him the door again, where mid-game the only way in
    // is to watch.
    test('the player who left cannot take the seat back off them', () => {
      const { room, ben, benId, caraId, cara } = handedOver();

      assert.throws(() => room.join(ben, { pid: benId, name: 'Ben' }), /already under way/);
      assert.equal(room.players.length, 2, 'Ben was dealt back into a game already under way');
      const seat = room.players.find((p) => p.id === caraId)!;
      assert.equal(seat.name, 'Cara', 'Ben took the seat back off Cara');
      assert.equal(seat.conn, cara, 'Cara lost the socket she was given the seat on');
    });
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
