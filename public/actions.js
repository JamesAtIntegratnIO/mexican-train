// Committing a tile is the same three steps whether it was tapped in the hand
// with only one legal home or dropped onto a glowing branch, and both callers
// live in different modules — so it sits here, where neither has to import the
// other.

import { S } from './state.js';
import { Snd } from './sound.js';
import { send } from './net.js';

export function playTile(tile, train, seg) {
  Snd.clack();
  send({ t: 'play', tile, train, seg });
  S.sel = null;
}
