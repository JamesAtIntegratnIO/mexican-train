// The refusals a player actually reads.
//
// The soak plays whole games across every rule combination, but a bot only ever
// picks a move out of `legalMoves()`, so nothing in it ever tries something it
// may not do — the refusal paths are reached only where the scripted table in
// `scripts/soak.ts` happens to walk into them. What is left over is this file:
// somebody playing out of turn, naming a train that isn't there, passing with a
// tile in hand.
//
// Each case asserts the sentence as well as the refusal, because these are not
// internal errors. They are what the table says to a player, and a tidy-up of
// `requireTurn` or `checkPlay` that reworded one of them would otherwise be
// invisible until somebody read it on screen.
//
// Positions are driven by hand — phase, engine, hands, boneyard — the way the
// soak's `scriptedTable()` drives them, because a dealt game cannot be steered
// into most of these without fixing the shuffle.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Game, Err } from '../server/game.js';

/** A two-player Mexican Train table mid-round, with the board still bare: the
 *  engine is the double 12, every train ends on it, and both players are past
 *  their opening turn. Every test sets the hand it needs, so none of this
 *  depends on what was dealt. */
function table() {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], max: 12 });
  g.phase = 'play';                       // skip the hunt; these are play-phase refusals
  g.engineDown = true;
  g.turn = 0;
  // Two tiles matching nothing, so a hand is never empty and never playable
  // unless a test says so.
  for (const p of g.players) { p.openingDone = true; p.hand = ['5-4', '3-2']; }
  return g;
}

/** The sentence the table refused with. Anything that goes through is a failure
 *  in itself: a test that asserts a message but not the refusal would pass on a
 *  table that accepted the move and said nothing. */
function refusal(fn: () => void): string {
  try { fn(); } catch (e) {
    assert.ok(e instanceof Err, `refused with something that is not an Err: ${e}`);
    return e.message;
  }
  return assert.fail('the table accepted a move it was meant to refuse');
}

describe('whose turn it is', () => {
  test('every action B tries on A\'s turn is turned away in the same words', () => {
    const g = table();
    g.player('b')!.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.play('b', '12-6', 'b', 0)), "It isn't your turn.");
    assert.equal(refusal(() => g.draw('b')), "It isn't your turn.");
    assert.equal(refusal(() => g.pass('b')), "It isn't your turn.");
    assert.equal(g.player('b')!.hand.length, 2, 'a refused play must not spend the tile');
    assert.equal(g.train('b')!.segs[0].tiles.length, 0, '...nor put it down');
  });
});

describe('the tile has to be one you hold', () => {
  test('a tile that is not in your hand', () => {
    const g = table();
    assert.equal(refusal(() => g.play('a', '12-6', 'a', 0)), "That tile isn't in your hand.");
  });

  test('...which is still the complaint when the train is nonsense too', () => {
    const g = table();
    assert.equal(refusal(() => g.play('a', '12-6', 'nowhere', 0)), "That tile isn't in your hand.");
  });
});

describe('which train, and which branch of it', () => {
  test('a train nobody has and a branch that is not there say which was wrong', () => {
    const g = table();
    g.player('a')!.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.play('a', '12-6', 'nowhere', 0)), 'Unknown train.');
    assert.equal(refusal(() => g.play('a', '12-6', 'a', 9)), 'Unknown branch.');
  });

  test('your first tile has to start your own train', () => {
    const g = table();
    const a = g.player('a')!;
    a.openingDone = false;
    a.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.play('a', '12-6', 'b', 0)), 'Your first tile must start your own train.');
    assert.equal(refusal(() => g.play('a', '12-6', 'mexican', 0)),
      'Your first tile must start your own train.', 'the communal train is no exception on the opening turn');
  });

  test("...and once it has, a closed train is a different sentence", () => {
    const g = table();
    g.player('a')!.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.play('a', '12-6', 'b', 0)), 'That train is closed to you.');
    // The same play, once B's marker is up — otherwise the refusal above could
    // be coming from something other than the train being shut.
    g.train('b')!.open = true;
    g.play('a', '12-6', 'b', 0);
    assert.equal(g.train('b')!.segs[0].tiles.length, 1);
  });
});

describe('the tile has to fit', () => {
  test('a tile that does not match names the end it did not match', () => {
    const g = table();
    const a = g.player('a')!;
    assert.equal(refusal(() => g.play('a', '5-4', 'a', 0)), "That tile doesn't match the open 12.");

    // The sentence follows the branch's open end, not the round's engine.
    a.hand = ['12-6', '5-4', '3-2'];
    g.play('a', '12-6', 'a', 0);
    g.turn = 0;
    assert.equal(refusal(() => g.play('a', '5-4', 'a', 0)), "That tile doesn't match the open 6.");
  });
});

describe('laying the engine', () => {
  test('you cannot lay a double you were not dealt', () => {
    const g = table();
    g.phase = 'seeking';                  // back before the round opened
    g.engineDown = false;
    assert.equal(refusal(() => g.layEngine('a')), "You don't have the double 12.");
    assert.equal(g.engineDown, false);
  });

  test('and you cannot lay it twice', () => {
    const g = table();                    // in play, so the engine is already down
    g.player('a')!.hand = ['12-12', '3-2'];
    assert.equal(refusal(() => g.layEngine('a')), 'The engine is already down.');
    assert.ok(g.player('a')!.hand.includes('12-12'), 'a refused engine must stay in the hand');
  });
});

describe('passing', () => {
  test('a pass while you are holding a play', () => {
    const g = table();
    g.player('a')!.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.pass('a')), 'You have a playable tile — you must play it.');
  });

  test('a pass before drawing, with tiles still in the yard', () => {
    const g = table();
    assert.ok(g.boneyard.length, 'the premise: this table has a yard left to draw from');
    assert.equal(refusal(() => g.pass('a')), 'You must draw first.');
    assert.equal(g.train('a')!.open, false, 'a refused pass must not raise the marker');

    // Having drawn and still found nothing, the same pass is the right move.
    g.drewThisTurn = true;
    g.pass('a');
    assert.equal(g.train('a')!.open, true);
  });
});

describe('drawing', () => {
  test('a draw while you are holding a play', () => {
    const g = table();
    g.player('a')!.hand = ['12-6', '3-2'];
    assert.equal(refusal(() => g.draw('a')), 'You have a playable tile — you must play it.');
    assert.equal(g.player('a')!.hand.length, 2, 'a refused draw must not hand out a tile');
  });

  test('a second draw in the same turn', () => {
    const g = table();
    g.boneyard = ['9-8', '12-5'];         // drawn from the end, so the 12-5 comes up first
    // Playable, so the turn stays with A rather than ending on the draw.
    assert.deepEqual(g.draw('a'), { tile: '12-5', playable: true });
    assert.equal(refusal(() => g.draw('a')), 'You already drew this turn.');
    assert.equal(g.boneyard.length, 1, 'a refused draw must leave the yard alone');
  });
});

describe('handing a seat on', () => {
  test('a seat cannot be handed to somebody already at the table', () => {
    const g = table();
    assert.equal(refusal(() => g.reseat('a', 'b')), 'They are already at this table.');
    assert.ok(g.player('a'), 'a refused reseat must leave the seat where it was');
    assert.equal(g.player('b')!.hand.length, 2, "...and must not have touched the other seat's hand");
  });
});
