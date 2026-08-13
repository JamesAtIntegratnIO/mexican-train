// Logging is a running cost on Workers, which bills per line, and a stranger
// decides how many requests to send. So the throttle isn't tidiness — it is the
// thing standing between an attacker and the bill.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log, setLevel } from '../server/log.js';
import { rooms, createRoom, sweep } from '../server/rooms.js';

let captured: any[] = [];
let realLog: any, realErr: any;

beforeEach(() => {
  captured = [];
  realLog = console.log; realErr = console.error;
  const take = (fallback: any) => (s: any) => {
    if (typeof s === 'string' && s.startsWith('{"ts"')) captured.push(JSON.parse(s));
    else fallback(s);
  };
  console.log = take(realLog);
  console.error = take(realErr);
});
afterEach(() => { console.log = realLog; console.error = realErr; });

describe('levels', () => {
  test('every line is valid JSON with an event and a level', () => {
    log.info('something_happened', { code: 'ABC123' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].evt, 'something_happened');
    assert.equal(captured[0].level, 'info');
    assert.equal(captured[0].code, 'ABC123');
    assert.ok(captured[0].ts);
  });

  test('debug is off by default', () => {
    log.debug('chatty', {});
    assert.equal(captured.length, 0);
    setLevel('debug');
    log.debug('chatty', {});
    assert.equal(captured.length, 1);
    setLevel('info');
  });

  test('an error keeps its message and a trimmed stack', () => {
    log.error('it_broke', { err: new TypeError('a specific problem') });
    assert.equal(captured[0].err, 'a specific problem');
    assert.ok(captured[0].stack?.length, 'no stack was kept');
    assert.ok(captured[0].stack.split('|').length <= 4, 'the stack should be trimmed, not dumped');
  });

  test('a value that will not serialise costs the line, not the process', () => {
    const circular: any = {}; circular.self = circular;
    assert.doesNotThrow(() => log.info('awkward', { circular }));
    assert.equal(captured[0].unserialisable, true);
  });
});

describe('throttling', () => {
  test('a burst collapses to a single line', () => {
    for (let i = 0; i < 50; i++) log.throttle('warn', 'flood_a', { n: i });
    assert.equal(captured.length, 1, `50 events wrote ${captured.length} lines`);
    assert.equal(captured[0].n, 0, 'the first event is the one worth reporting');
  });

  test('what was swallowed is reported, not lost', () => {
    for (let i = 0; i < 30; i++) log.throttle('warn', 'flood_b', { n: i });
    const realNow = Date.now;
    Date.now = () => realNow() + 90_000;            // step past the window
    try { log.throttle('warn', 'flood_b', { n: 999 }); } finally { Date.now = realNow; }

    const summary = captured.find((l) => l.alsoSeen !== undefined);
    assert.equal(summary?.alsoSeen, 29);
    assert.ok(captured.some((l) => l.n === 999), 'the new window should report normally');
  });

  test('a different fault is not hidden behind a noisy one', () => {
    for (let i = 0; i < 20; i++) log.throttle('error', 'boom', { which: 'known' }, 'k:known');
    log.throttle('error', 'boom', { which: 'new-and-different' }, 'k:different');
    assert.equal(captured.length, 2);
    assert.equal(captured[1].which, 'new-and-different');
  });
});

// One line per table is the whole usage signal for the Workers build, which has
// no registry to count. If that line stops carrying its detail, there is nothing
// else to look at.
describe('the table lifecycle', () => {
  test('opening a table is silent at info', () => {
    const room = createRoom();
    assert.equal(captured.length, 0, `creating a table wrote ${captured.length} lines`);
    rooms.delete(room.code);
  });

  test('clearing one leaves a single line that says what happened', () => {
    const room = createRoom();
    room.emptySince = Date.now() - 60 * 60_000;     // abandoned an hour ago
    captured = [];

    assert.equal(sweep(), 1);
    assert.equal(rooms.has(room.code), false);

    const disposed = captured.filter((l) => l.evt === 'room_disposed');
    assert.equal(disposed.length, 1);
    assert.equal(captured.length, 1, 'the sweep should not also write a summary line');
    assert.equal(disposed[0].code, room.code);
    // A code, not the sentence the players are shown: this field is grouped by.
    assert.equal(disposed[0].why, 'empty');
    assert.equal(typeof disposed[0].ageMin, 'number');
    assert.equal(disposed[0].rounds, 0, 'whether anyone actually played is the point of the line');
    assert.equal(disposed[0].finished, false);
  });

  test('a table still in play is never swept', () => {
    const room = createRoom();
    room.emptySince = null;
    room.lastActivity = Date.now();
    assert.equal(sweep(), 0);
    rooms.delete(room.code);
  });
});
