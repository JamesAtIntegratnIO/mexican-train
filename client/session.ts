// What to do with a fresh snapshot of the table. The server sends the whole
// room on every change, so this is where "what changed since last time" is
// worked out — which is the only reason the client keeps any history at all.

import { app, esc, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { LOGO } from './tiles.js';
import { renderLobby } from './lobby.js';
import { renderTable } from './table.js';
import { showEndModal } from './modals.js';
import type { RoomSnapshot, GameView } from '../shared/protocol.js';

export function onRoom(m: RoomSnapshot): void {
  const prev = S.room;
  S.room = m;
  // Lobby and table are different pages; the shell has to be rebuilt between them.
  if (!prev || prev.phase !== m.phase) S.built = false;

  const g = m.game;
  if (g) {
    soundCues(prev, g);
    callLastTile(prev, g);
    if (S.sel !== null && !g.hand.includes(S.sel)) S.sel = null;
  }
  countUnread(prev, m);

  render();
  markEnd(g);
}

export function render(): void {
  if (!S.room) return;
  if (S.room.phase === 'lobby') renderLobby();
  else renderTable();
}

// The table's noises: your turn coming round, a tile landing, a foot filling.
function soundCues(prev: RoomSnapshot | null, g: GameView): void {
  if (g.turn === S.pid && S.lastTurn !== S.pid) Snd.turn();
  S.lastTurn = g.turn;
  tileCue(g);
  footCue(prev, g);
}

function tileCue(g: GameView): void {
  const key = g.lastPlay ? `${g.lastPlay.trainId}:${g.lastPlay.tile}:${g.round}` : null;
  if (!key || key === S.lastPlayKey) return;
  if (S.lastPlayKey !== null) Snd.clack();   // silent on the first snapshot we see
  S.lastPlayKey = key;
}

// A foot just filled — the open-double count dropped without a new one appearing.
function footCue(prev: RoomSnapshot | null, g: GameView): void {
  const feet = g.pending.length;
  const sameRound = prev && prev.game && g.round === prev.game.round;
  if (sameRound && feet < S.lastFeet && g.foot > 1) Snd.foot();
  S.lastFeet = feet;
}

// Digital stand-in for tapping the table: call out anyone down to one tile.
function callLastTile(prev: RoomSnapshot | null, g: GameView): void {
  const onOne = g.players.filter((p) => p.tiles === 1).map((p) => p.id).join(',');
  const sameRound = prev && prev.game && g.round === prev.game.round;
  if (onOne && onOne !== S.lastOnOne && sameRound) announceLastTiles(g);
  S.lastOnOne = onOne;
}

function announceLastTiles(g: GameView): void {
  const already = S.lastOnOne || '';
  for (const p of g.players) {
    if (p.tiles !== 1 || already.includes(p.id)) continue;
    toast(p.id === S.pid ? 'Last tile — call it!' : `${p.name} is down to one tile`);
    Snd.alert();
  }
}

function countUnread(prev: RoomSnapshot | null, m: RoomSnapshot): void {
  const now = m.chat.filter((c) => !c.system).length;
  if (prev && now > prev.chat.filter((c) => !c.system).length && !S.panel) S.unread++;
}

// The end-of-round card belongs to a round, not to a snapshot — otherwise every
// tick after the round ended would put it back on screen after you dismissed it.
function markEnd(g: GameView | null): void {
  if (!g || (g.status !== 'roundOver' && g.status !== 'gameOver')) { S.shownEnd = null; return; }
  const key = `${g.status}:${g.round}`;
  if (S.shownEnd === key) return;
  S.shownEnd = key;
  if (g.roundWinner === S.pid || g.status === 'gameOver') Snd.win();
  showEndModal(g);
}

export function fatal(msg: string): void {
  S.ws = null; S.room = null;
  app.innerHTML = `<div class="center"><div class="card">
    ${LOGO}
    <p class="tagline" style="margin-top:14px">${esc(msg)}</p>
    <div class="stack"><button class="btn primary big" data-go="home">Start a new game</button></div>
  </div></div>`;
}
