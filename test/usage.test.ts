// The usage report does arithmetic on numbers nobody can check by eye, which is
// the kind of code that is wrong quietly and for months. The queries themselves
// need an account and a token, so what is pinned here is everything after the
// rows come back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { funnel, totals } from '../scripts/usage.js';
import type { Step, Day } from '../scripts/usage.js';

const steps = (o: Record<string, number>): Step[] => Object.entries(o).map(([step, n]) => ({ step, n }));

const day = (o: Partial<Day>): Day => ({
  day_utc: '2026-08-13', n_tables: 0, n_people: 0, n_games: 0,
  n_finished: 0, n_bots: 0, table_minutes: 0, n_moves: 0, ...o,
});

describe('the funnel', () => {
  test('the drop-off is everyone who did neither', () => {
    const f = funnel(steps({ home: 100, made: 8, code: 2 }));
    assert.equal(f.startedOfHome, '10.0%');
    assert.equal(f.leftHome, '90.0%', 'joining by code is playing too, and must count');
  });

  test('a shared link is judged on its own denominator', () => {
    const f = funnel(steps({ home: 500, link: 40, seat: 24, watch: 6 }));
    assert.equal(f.enteredOfLink, '75.0%', 'links must not be measured against front-door traffic');
  });

  test('a step nobody has taken is zero, not missing', () => {
    const f = funnel(steps({ home: 3 }));
    assert.equal(f.seat, 0);
    assert.equal(f.enteredOfLink, '—', 'no links opened is not 0% of links opened');
  });

  test('nothing at all divides by nothing at all', () => {
    const f = funnel([]);
    assert.equal(f.startedOfHome, '—');
    assert.equal(f.leftHome, '—');
  });
});

describe('table totals', () => {
  test('days add up', () => {
    const t = totals([
      day({ n_tables: 4, n_people: 12, n_games: 3, n_finished: 1, n_bots: 2, table_minutes: 200, n_moves: 900 }),
      day({ n_tables: 6, n_people: 18, n_games: 3, n_finished: 2, n_bots: 1, table_minutes: 400, n_moves: 1100 }),
    ]);
    assert.equal(t.tables, 10);
    assert.equal(t.people, 30);
    assert.equal(t.moves, 2000);
    assert.equal(t.dealtOfTables, '60.0%');
    assert.equal(t.finishedOfGames, '50.0%', 'finished is a share of games, not of tables');
  });

  test('an average is taken over the whole period, not averaged out of daily averages', () => {
    const t = totals([
      day({ n_tables: 1, table_minutes: 10 }),
      day({ n_tables: 9, table_minutes: 990 }),
    ]);
    // The mean of the daily means would be 60. The honest answer weights by how
    // many tables each day actually had.
    assert.equal(t.avgMinutes, 100);
  });

  test('an empty period reports nothing rather than dividing by it', () => {
    const t = totals([]);
    assert.equal(t.tables, 0);
    assert.equal(t.avgMinutes, 0);
    assert.equal(t.dealtOfTables, '—');
  });
});
