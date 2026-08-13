// The three things that take over the screen: the rules card, the scoreboard,
// and the end-of-round card.

import { $, esc, modalEl, openModal, closeModal } from './dom.js';
import { S } from './state.js';
import { avatar } from './tiles.js';
import { send } from './net.js';
import type { GameView, PlayerView, PlayerId } from '../shared/protocol.js';

export function showRules(): void {
  const g = S.room && S.room.game;
  const foot = g ? g.foot : 1;
  openModal(`<div class="card">
    <h2>How this table plays</h2>
    <p class="sub">Set by the host before the deal.</p>
    <div class="rules-list">
      <div><b>The goal</b>Shed all your tiles each round. You score the pips left in your hand${g && g.scoring !== 'pips' ? `, ${g.scoring === 'official' ? 'with blanks at 25 and the double blank at 50' : 'with the double blank costing 50'}` : ''}, and the <em>lowest</em> total after every round wins.</div>
      <div><b>Starting a round</b>Everything is dealt, engine included. Whoever holds the round's double lays it and leads. If nobody was dealt it, players draw one tile each — keeping what they draw — until it turns up. The boneyard won't sit on it for longer than three to six times round the table: buried deeper than that, the double is floated up into that window, so a round never opens with a long stretch of everyone flipping a tile over. It's a ceiling, not a target — one near the top stays where the shuffle put it.</div>
      <div><b>Your first turn</b>You must start your own train with a tile matching the engine. Can't? Draw one; if it still won't go, put your marker up and play moves on.</div>
      <div><b>After that</b>One tile per turn, on your own train, the Mexican Train, or anyone's train whose marker is up.</div>
      <div><b>Markers</b>Yours is entirely your call — raise or lower it at any point in the round, your turn or not, since playing a tile ends your turn before you could take it down. While it's up, <em>every branch</em> of your train is fair game for opponents.</div>
      <div><b>Doubles</b>Never an obligation. A double is just the open end of its branch — match it to carry that branch on, or leave it and play somewhere else entirely. Doubles are laid crosswise.</div>${
        foot > 1 ? `<div><b>Pigeon foot</b>A double takes <b>${foot} tiles</b>, and until all ${foot} are down <em>that whole train is frozen</em> — no branch of it grows, not the toes already laid and not branches that forked off earlier. Every other train carries on as normal, and you are never forced to feed a foot instead of playing elsewhere. Once it's full the branch forks into <b>${foot} live ends</b>.</div>` : ''}
      <div><b>If you can't play</b>You only draw when you have no legal play anywhere at all. If the drawn tile plays, you must play it. Otherwise end your turn — and put your marker up so the table knows.</div>
      <div><b>The Mexican Train</b>Communal, always open, started by whoever first plays a matching tile on it.</div>
      <div><b>Ending a round</b>Someone plays their last tile, or everyone is blocked with an empty boneyard. Going out on an uncovered double is allowed here.</div>
    </div>
    <div class="stack" style="margin-top:22px"><button class="btn primary" data-close>Got it</button></div>
  </div>`);
}

// What the host does with a seat nobody is sitting in. A bot is the reversible
// answer — it stands in and gives the seat straight back — and a spectator is
// the one that isn't, so the card says which is which rather than leaving the
// host to find out.
export function handOver(seatId: PlayerId, seatName: string): void {
  const watching = S.room!.watchers.filter((w) => w.connected);
  // Nobody watching is no decision to make: a bot is the only thing the seat
  // can go to, so asking would be a dialog with one button in it.
  if (!watching.length) return send({ t: 'fillSeat', id: seatId });

  openModal(`<div class="card">
    <h2>${esc(seatName)}'s seat</h2>
    <p class="sub">The hand, the train and the score stay with the seat — only who plays it changes.</p>
    <div class="stack">
      ${watching.map((w) => `<button class="btn" data-give="${esc(w.id)}">Give it to ${esc(w.name)}</button>`).join('')}
      <button class="btn" data-fill>Hand it to a bot</button>
    </div>
    <p class="foot-note" style="text-align:left">A bot only stands in: ${esc(seatName)} takes the seat back the moment they return. Somebody who is watching takes it over for good.</p>
    <div class="stack" style="margin-top:14px"><button class="btn ghost" data-close>Keep waiting</button></div>
  </div>`, () => {
    modalEl.querySelectorAll<HTMLElement>('[data-give]').forEach((b) => {
      b.onclick = () => { send({ t: 'giveSeat', id: seatId, to: b.dataset.give! }); closeModal(); };
    });
    const bot = $<HTMLElement>('[data-fill]', modalEl);
    if (bot) bot.onclick = () => { send({ t: 'fillSeat', id: seatId }); closeModal(); };
  });
}

// Bots roll a hidden temperament; it's only ever revealed once the game is done.
const temperName = (t: number): string => t < 0.2 ? 'obliging' : t < 0.4 ? 'good-natured' : t < 0.6 ? 'even-handed'
  : t < 0.8 ? 'competitive' : 'ruthless';

// Full card: a row per round played, a column per player, totals underneath.
export function scoreboardHTML(g: GameView): string {
  const played = Math.max(...g.players.map((p) => p.roundScores.length), 0);
  const best = Math.min(...g.players.map((p) => p.score));
  if (!played) return '<p class="foot-note" style="text-align:left">No rounds finished yet.</p>';
  return `<div class="sb-wrap"><table class="scoreboard">
    <thead><tr><th class="rd">Round</th>${g.players.map((p) =>
      `<th class="${p.id === S.pid ? 'me' : ''}" title="${esc(p.name)}">${esc(p.name)}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: played }, (_, i) => roundRow(g, i)).join('')}</tbody>
    <tfoot><tr><th class="rd">Total</th>${g.players.map((p) =>
      `<td class="${p.score === best ? 'lead' : ''}">${p.score}</td>`).join('')}</tr></tfoot>
  </table></div>`;
}

function roundRow(g: GameView, i: number): string {
  const low = Math.min(...g.players.map((p) => p.roundScores[i] ?? Infinity));
  return `<tr><th class="rd">${i + 1}<small>d${g.max - i}</small></th>${g.players.map((p) => {
    const v = p.roundScores[i];
    return `<td class="${v === 0 ? 'out' : v === low ? 'good' : ''}">${v ?? '—'}</td>`;
  }).join('')}</tr>`;
}

export function showScoreboard(g: GameView): void {
  openModal(`<div class="card wide"><h2>Scoreboard</h2>
    <p class="sub">Round ${g.round} of ${g.totalRounds} · lowest total wins.</p>
    ${scoreboardHTML(g)}
    <div class="stack" style="margin-top:22px"><button class="btn" data-close>Close</button></div></div>`);
}

export function showEndModal(g: GameView): void {
  const done = g.status === 'gameOver';
  const ranked = [...g.players].sort((a, b) => a.score - b.score);
  const isHost = S.room!.hostId === S.pid;
  const winner = done ? ranked[0] : g.players.find((p) => p.id === g.roundWinner);

  openModal(`<div class="card wide">
    <h2>${done ? `${esc(winner!.name)} wins` : winner ? `${esc(winner.name)} went out` : 'Everyone blocked'}</h2>
    <p class="sub">${done ? `Final standings after ${g.totalRounds} rounds.` : `Round ${g.round} of ${g.totalRounds} · engine was the double ${g.engine}.`}</p>

    <div class="label">${done ? 'Final' : 'This round'}</div>
    <div class="stack" style="gap:0;margin-bottom:22px">
      ${ranked.map((p, i) => standingRow(g, p, i, done)).join('')}
    </div>

    <div class="label">Scoreboard</div>
    ${scoreboardHTML(g)}

    <div class="stack" style="margin-top:22px">
      ${isHost
        ? `<button class="btn primary big" id="advance">${done ? 'Play again' : `Deal round ${g.round + 1}`}</button>`
        : `<p class="foot-note" style="margin:0">Waiting for the host to ${done ? 'start a new game' : 'deal the next round'}…</p>`}
      <button class="btn ghost" data-close>Look at the table</button>
    </div>
  </div>`, () => {
    const b = $<HTMLButtonElement>('#advance', modalEl);
    if (b) b.onclick = () => { send({ t: done ? 'playAgain' : 'nextRound' }); closeModal(); };
  });
}

function standingRow(g: GameView, p: PlayerView, i: number, done: boolean): string {
  const last = p.roundScores[p.roundScores.length - 1] ?? 0;
  return `<div class="score-row">
    <span class="rank">${i + 1}</span>
    ${avatar(p.name, g.players.findIndex((x) => x.id === p.id))}
    <span class="nm">${esc(p.name)}${p.id === S.pid ? ' (you)' : ''}${
      p.temper != null ? ` <span class="chip">${temperName(p.temper)}</span>` : ''}</span>
    ${!done ? `<span class="delta ${last === 0 ? 'zero' : ''}">+${last}</span>` : ''}
    <span class="sc">${p.score}</span>
  </div>`;
}
