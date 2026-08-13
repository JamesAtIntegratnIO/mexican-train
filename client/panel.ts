// The side panel: scores, the activity log, and chat.

import { $, esc } from './dom.js';
import { S } from './state.js';
import { avatar } from './tiles.js';
import { showScoreboard } from './modals.js';
import type { RoomSnapshot, GameView, PlayerView, ChatLine } from '../shared/protocol.js';

export function paintPanel(): void {
  const r = S.room!, g = r.game!;
  document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#chatForm').hidden = S.tab !== 'chat';
  const body = $<HTMLElement>('#pbody');

  if (S.tab === 'scores') {
    body.innerHTML = scoresHTML(r, g);
    const sb = $<HTMLButtonElement>('#fullsb', body);
    if (sb) sb.onclick = () => showScoreboard(g);
    return;
  }
  if (S.tab === 'log') {
    body.innerHTML = `<div class="log">${[...g.log].reverse().map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('')}</div>`;
    return;
  }
  body.innerHTML = `<div class="chat-list">${r.chat.map(chatLine).join('')}</div>`;
  body.scrollTop = body.scrollHeight;
}

const chatLine = (c: ChatLine): string => (c.system
  ? `<div class="sys">${esc(c.text)}</div>`
  : `<div class="msg"><b>${esc(c.from)}</b>${esc(c.text)}</div>`);

function scoresHTML(r: RoomSnapshot, g: GameView): string {
  const ranked = [...g.players].sort((a, b) => a.score - b.score);
  const blanks = g.scoring === 'house' ? ', and 50 for the double blank'
    : g.scoring === 'official' ? ', with blanks at 25 and the 0|0 at 50' : '';
  return ranked.map((p) => scoreRow(p, g)).join('')
    + watchersHTML(r)
    + '<button class="btn sm" id="fullsb" style="width:100%;margin-top:14px">Full scoreboard</button>'
    + `<p class="foot-note" style="text-align:left">Lowest total wins. You score the pips left in your hand at the end of each round${blanks}.</p>`;
}

// `connected` rides on the player itself — the room stitches it in — so this
// no longer has to find the matching seat to know whether someone is here.
function scoreRow(p: PlayerView, g: GameView): string {
  const i = g.players.findIndex((x) => x.id === p.id);
  return `<div class="score-row">
    ${avatar(p.name, i)}
    <div style="flex:1;min-width:0">
      <div class="nm">${esc(p.name)}${p.id === S.pid ? ' (you)' : ''} ${p.bot ? '<span class="chip">bot</span>' : ''}</div>
      <div class="sub">${p.tiles === 1 ? '<span class="lastcall">last tile!</span>' : `${p.tiles} tiles in hand`}</div>
    </div>
    <span class="dotstat ${p.connected ? 'on' : ''}" title="${p.connected ? 'connected' : 'away'}"></span>
    <span class="sc">${p.score}</span>
  </div>`;
}

const watchersHTML = (r: RoomSnapshot): string => (r.watchers.length
  ? `<div class="label" style="margin-top:16px">Watching · ${r.watchers.length}</div>
     <div class="watchers">${r.watchers.map((w) => `<span class="chip ${w.id === S.pid ? 'gold' : ''}">${esc(w.name)}${w.id === S.pid ? ' (you)' : ''}</span>`).join('')}</div>`
  : '');
