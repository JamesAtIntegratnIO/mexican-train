// The three things that take over the screen: the rules card, the scoreboard,
// and the end-of-round card.

import { $, esc, modalEl, openModal, closeModal } from './dom.js';
import { S } from './state.js';
import { avatar } from './tiles.js';
import { send } from './net.js';

export function showRules() {
  const g = S.room && S.room.game;
  const foot = g ? g.foot : 1;
  openModal(`<div class="card">
    <h2>How this table plays</h2>
    <p class="sub">Set by the host before the deal.</p>
    <div class="rules-list">
      <div><b>The goal</b>Shed all your tiles each round. You score the pips left in your hand${g && g.scoring !== 'pips' ? `, ${g.scoring === 'official' ? 'with blanks at 25 and the double blank at 50' : 'with the double blank costing 50'}` : ''}, and the <em>lowest</em> total after every round wins.</div>
      <div><b>Starting a round</b>Everything is dealt, engine included. Whoever holds the round's double lays it and leads. If nobody was dealt it, players draw one tile each — keeping what they draw — until it turns up.</div>
      <div><b>Your first turn</b>You must start your own train with a tile matching the engine. Can't? Draw one; if it still won't go, put your marker up and play moves on.</div>
      <div><b>After that</b>One tile per turn, on your own train, the Mexican Train, or anyone's train whose marker is up.</div>
      <div><b>Markers</b>Yours is entirely your call — raise or lower it whenever it's your turn. While it's up, <em>every branch</em> of your train is fair game for opponents.</div>
      <div><b>Doubles</b>Never an obligation. A double is just the open end of its branch — match it to carry that branch on, or leave it and play somewhere else entirely. Doubles are laid crosswise.</div>${
        foot > 1 ? `<div><b>Pigeon foot</b>A double takes <b>${foot} tiles</b>, and until all ${foot} are down <em>that branch takes nothing else</em>. Only that branch — the train's other branches, and every other train, carry on as normal, and you are never forced to feed a foot instead of playing elsewhere. Once it's full the branch forks into <b>${foot} live ends</b>.</div>` : ''}
      <div><b>If you can't play</b>You only draw when you have no legal play anywhere at all. If the drawn tile plays, you must play it. Otherwise end your turn — and put your marker up so the table knows.</div>
      <div><b>The Mexican Train</b>Communal, always open, started by whoever first plays a matching tile on it.</div>
      <div><b>Ending a round</b>Someone plays their last tile, or everyone is blocked with an empty boneyard. Going out on an uncovered double is allowed here.</div>
    </div>
    <div class="stack" style="margin-top:22px"><button class="btn primary" data-close>Got it</button></div>
  </div>`);
}

// Bots roll a hidden temperament; it's only ever revealed once the game is done.
const temperName = (t) => t < 0.2 ? 'obliging' : t < 0.4 ? 'good-natured' : t < 0.6 ? 'even-handed'
  : t < 0.8 ? 'competitive' : 'ruthless';

// Full card: a row per round played, a column per player, totals underneath.
export function scoreboardHTML(g) {
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

function roundRow(g, i) {
  const low = Math.min(...g.players.map((p) => p.roundScores[i] ?? Infinity));
  return `<tr><th class="rd">${i + 1}<small>d${g.max - i}</small></th>${g.players.map((p) => {
    const v = p.roundScores[i];
    return `<td class="${v === 0 ? 'out' : v === low ? 'good' : ''}">${v ?? '—'}</td>`;
  }).join('')}</tr>`;
}

export function showScoreboard(g) {
  openModal(`<div class="card wide"><h2>Scoreboard</h2>
    <p class="sub">Round ${g.round} of ${g.totalRounds} · lowest total wins.</p>
    ${scoreboardHTML(g)}
    <div class="stack" style="margin-top:22px"><button class="btn" data-close>Close</button></div></div>`);
}

export function showEndModal(g) {
  const done = g.status === 'gameOver';
  const ranked = [...g.players].sort((a, b) => a.score - b.score);
  const isHost = S.room.hostId === S.pid;
  const winner = done ? ranked[0] : g.players.find((p) => p.id === g.roundWinner);

  openModal(`<div class="card wide">
    <h2>${done ? `${esc(winner.name)} wins` : winner ? `${esc(winner.name)} went out` : 'Everyone blocked'}</h2>
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
    const b = $('#advance', modalEl);
    if (b) b.onclick = () => { send({ t: done ? 'playAgain' : 'nextRound' }); closeModal(); };
  });
}

function standingRow(g, p, i, done) {
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
