// Usage telemetry, which is only worth having if the numbers are true.
//
// The one that matters most is the peak. A table is cleared *because* everyone
// left, and a lobby seat is removed the moment its player does — so anything
// counted at disposal time reports an empty room, and an abandoned lobby of six
// looks exactly like a table nobody ever opened. Half the tables we care about
// are in that gap.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room-core.js';
import { metrics, setSink, isFunnelEvent } from '../server/metrics.js';
import type { TableSample } from '../server/metrics.js';
import { setLevel } from '../server/log.js';

// dispose() writes its log line as well as its sample, and this file is about
// the sample.
setLevel('error');

let samples: TableSample[] = [];
let funnels: string[] = [];

beforeEach(() => {
  samples = []; funnels = [];
  metrics.reset();
  setSink({ table: (s) => samples.push(s), funnel: (e) => funnels.push(e) });
});

/** A table with `n` people sitting at it, ticked the way a transport ticks. */
function seated(n: number, code = 'TESTAB') {
  const room = new Room(code);
  const conns = Array.from({ length: n }, (_, i) => ({ who: i }));
  for (const [i, c] of conns.entries()) { room.join(c, { name: `P${i}` }); room.tick(); }
  return { room, conns };
}

describe('what a finished table reports', () => {
  test('the people who were here are still counted once they have gone', () => {
    const { room, conns } = seated(6);
    for (const c of conns) room.leave(c);
    assert.equal(room.players.length, 0, 'the premise: a lobby empties itself out');

    room.dispose('empty');
    assert.equal(samples[0]!.peakPlayers, 6, 'an abandoned lobby of six must not report zero');
    assert.equal(samples[0]!.humans, 6);
  });

  test('a table nobody ever sat at looks nothing like one they left', () => {
    const untouched = new Room('AAAAAA');
    untouched.dispose('ceiling');
    const abandoned = seated(4, 'BBBBBB');
    for (const c of abandoned.conns) abandoned.room.leave(c);
    abandoned.room.dispose('empty');

    assert.equal(samples[0]!.peakPlayers, 0);
    assert.equal(samples[1]!.peakPlayers, 4);
    assert.notEqual(samples[0]!.why, samples[1]!.why);
  });

  test('bots are counted apart from people', () => {
    const { room } = seated(1);
    room.addBot(room.hostId!);
    room.addBot(room.hostId!);
    room.dispose('empty');
    assert.equal(samples[0]!.humans, 1, 'bots must not inflate how many people played');
    assert.equal(samples[0]!.bots, 2);
    assert.equal(samples[0]!.peakPlayers, 3);
  });

  test('watchers are counted at their peak too', () => {
    const { room } = seated(1);
    const w1 = { w: 1 }, w2 = { w: 2 };
    room.join(w1, { name: 'Watcher one', spectate: true }); room.tick();
    room.join(w2, { name: 'Watcher two', spectate: true }); room.tick();
    room.leave(w1); room.leave(w2);
    room.dispose('empty');
    assert.equal(samples[0]!.peakWatchers, 2);
  });

  test('the settings the table actually chose ride along', () => {
    const { room } = seated(2);
    room.setSettings(room.hostId!, { max: 9, foot: 3, scoring: 'pips' });
    room.dispose('empty');
    assert.equal(samples[0]!.max, 9);
    assert.equal(samples[0]!.foot, 3);
    assert.equal(samples[0]!.scoring, 'pips');
  });

  test('exactly one sample per table, ever', () => {
    const { room } = seated(2);
    room.dispose('empty');
    assert.equal(samples.length, 1);
  });

  // The reason a table was cleared is now two things: a code to group by and a
  // sentence to read. Anyone still looking at the page gets the sentence.
  test('the players are told in words, not in the code the metric uses', () => {
    const { room } = seated(2);
    const said: any[] = [];
    room.adapter.send = (_c, obj) => said.push(obj);
    room.dispose('ceiling');
    const fatal = said.find((m) => m.t === 'fatal');
    assert.match(fatal.msg, /time limit/, `players were shown ${JSON.stringify(fatal.msg)}`);
  });
});

describe('play', () => {
  // Bots drive this: with the human's seat empty, the clock plays every seat, so
  // a real game runs without a test having to know the rules.
  //
  // The watcher is load-bearing. Bots do not play to an empty room — that is
  // what makes stepping away from a game safe — so somebody has to still be
  // here for the clock to run at all. A spectator is the cheapest way to be
  // present without occupying a seat the bots would then refuse to play.
  function playedOut(turns: number) {
    const { room, conns } = seated(1);
    room.addBot(room.hostId!);
    room.start(room.hostId!);
    room.join({ w: 'looker' }, { name: 'Looker', spectate: true });
    const seat = room.hostId!;
    room.leave(conns[0]!);                 // in game, the seat stays behind
    // Nothing plays a human's hand for them, however long they have been gone,
    // so the seat has to be handed over deliberately before the clock has a
    // whole table to drive. See lifetime.test.ts, where that rule lives.
    room.fillSeat(seat, seat);
    let taken = 0;
    while (taken < turns && room.runBot()) taken++;
    return { room, taken };
  }

  test('a turn is a move, and a marker going up is not a second one', () => {
    const { room, taken } = playedOut(40);
    assert.ok(taken > 10, `the bots only took ${taken} turns`);
    assert.equal(room.stats.moves, taken, 'a bot turn that raises a marker must still count once');
  });

  test('a table that dealt is not a table that only gathered', () => {
    const { room } = playedOut(20);
    room.dispose('empty');
    assert.ok(samples[0]!.rounds >= 1, 'a round was played and went unreported');
    assert.equal(samples[0]!.finished, false, 'nobody reached the end of a 13-round game in 20 turns');
    assert.equal(seated(2).room.stats.rounds, 0);
  });

  test('a second game at the same table does not erase the first', () => {
    const { room } = playedOut(20);
    const played = room.stats.rounds;
    room.playAgain(room.hostId!);
    assert.equal(room.game, null, 'the premise: playAgain throws the game away');
    assert.equal(room.stats.rounds, played, 'the rounds already played are still played');
  });

  test('an illegal move is not a move', () => {
    const { room } = seated(2);
    assert.throws(() => room.act(room.hostId!, { t: 'pass' }));   // no game yet
    assert.equal(room.stats.moves, 0);
  });
});

// The Durable Object is evicted between messages and rebuilt from storage, so a
// counter that does not survive the round trip counts only the last few seconds
// of a table's life.
describe('hibernation', () => {
  test('the counters survive being stored and rebuilt', () => {
    const { room } = seated(3);
    room.addBot(room.hostId!);
    const back = Room.revive(JSON.parse(JSON.stringify(room.toJSON())), {});
    assert.deepEqual(back.stats, room.stats);
  });

  test('a table stored before any of this existed comes back at zero, not undefined', () => {
    const old = Room.revive({ code: 'OLD123', players: [], watchers: [], chat: [] }, {});
    assert.equal(old.stats.peakPlayers, 0);
    assert.equal(old.stats.finished, false);
    old.dispose('empty');
    for (const [k, v] of Object.entries(samples[0]!)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} came back as ${v}`);
    }
  });
});

describe('the sink', () => {
  test('a sink that throws costs the sample, not the table', () => {
    setSink({ table: () => { throw new Error('analytics is having a day'); } });
    const { room, conns } = seated(2);
    const closed: unknown[] = [];
    room.adapter.close = (c) => closed.push(c);
    room.adapter.send = () => {};
    assert.doesNotThrow(() => room.dispose('empty'));
    assert.equal(closed.length, conns.length, 'the table still has to be taken down properly');
  });

  test('counters are kept whether or not a host installed a sink', () => {
    setSink(null);
    const { room } = seated(2);
    room.dispose('empty');
    assert.equal(metrics.snapshot().tables, 1);
    assert.equal(metrics.snapshot().players, 2);
  });
});

describe('the funnel', () => {
  test('only the names both ends agreed on are events', () => {
    assert.equal(isFunnelEvent('home'), true);
    assert.equal(isFunnelEvent('seat'), true);
    assert.equal(isFunnelEvent('whatever-a-stranger-sends'), false);
    assert.equal(isFunnelEvent('toString'), false, 'inherited names are not events');
  });

  test('events are tallied and passed on', () => {
    metrics.funnel('home');
    metrics.funnel('home');
    metrics.funnel('made');
    assert.equal(metrics.snapshot()['funnel.home'], 2);
    assert.equal(metrics.snapshot()['funnel.made'], 1);
    assert.deepEqual(funnels, ['home', 'home', 'made']);
  });

  test('a refusal is counted, never logged', () => {
    metrics.refused();
    assert.equal(metrics.snapshot()['funnel.refused'], 1);
    assert.equal(funnels.length, 0, 'junk must not reach the sink');
  });
});
