// The four things that take over the screen: the rules card, the scoreboard,
// the end-of-round card, and the one that asks whether you meant to walk out.

import { $, esc, modalEl, openModal, closeModal } from './dom.js';
import { S } from './state.js';
import { avatar } from './tiles.js';
import { send } from './net.js';
import { GAME_TITLE, SCORING_BLANKS, footRule, hubRule, temperName } from '../shared/phrasing.js';
import type { Foot, GameView, Hub, PlayerView, PlayerId } from '../shared/protocol.js';

/** What the card should describe. A table that has dealt knows for itself; one
 *  still in the lobby has only the host's settings; a client with neither gets
 *  the defaults rather than an empty card. */
function tableRules(): Pick<GameView, 'game' | 'foot' | 'hub' | 'scoring'> {
  const r = S.room;
  if (r?.game) return r.game;
  return { game: 'mexicanTrain', foot: 1, hub: 6, scoring: 'house', ...(r?.settings ?? {}) };
}

export function showRules(): void {
  const { game, foot, hub, scoring } = tableRules();
  const blanks = SCORING_BLANKS[scoring];
  const body = game === 'chickenFoot' ? chickenFootRules(foot, hub) : mexicanTrainRules(foot);
  openModal(`<div class="card">
    <h2>How this table plays</h2>
    <p class="sub">${GAME_TITLE[game]} · set by the host before the deal.</p>
    <div class="rules-list">
      <div><b>The goal</b>Shed all your tiles each round. You score the pips left in your hand — ${blanks} — and the <em>lowest</em> total after every round wins.</div>
      <div><b>Starting a round</b>Everything is dealt, engine included. Whoever holds the round's double lays it and leads. If nobody was dealt it, <em>everybody</em> draws one tile at the same time — keeping what they draw — over and over until it turns up, so no seat gets more chances at it than another and the table starts level. The boneyard won't sit on it for longer than three to six times round the table: buried deeper than that, the double is floated up into that window, so a round never opens with a long stretch of everyone flipping a tile over. It's a ceiling, not a target — one near the top stays where the shuffle put it.</div>
      ${body}
      <div><b>If you can't play</b>You only draw when you have no legal play anywhere at all. If the drawn tile plays, you must play it. Otherwise your turn ends${game === 'chickenFoot' ? '' : ' — and your marker goes up so the table knows'}.</div>
      <div><b>Ending a round</b>Someone plays their last tile, or everyone is blocked with an empty boneyard. Going out on an uncovered double is allowed here.</div>
    </div>
    <div class="stack" style="margin-top:22px"><button class="btn primary" data-close>Got it</button></div>
  </div>`);
}

const mexicanTrainRules = (foot: Foot): string => `
  <div><b>Your first turn</b>You must start your own train with a tile matching the engine. Can't? Draw one; if it still won't go, put your marker up and play moves on.</div>
  <div><b>After that</b>One tile per turn, on your own train, the Mexican Train, or anyone's train whose marker is up.</div>
  <div><b>Markers</b>Your marker goes up when you can't play, and it comes down again only once you <em>have</em> played — being stuck costs you a lap of the table at your train, which is the whole point of it. <em>When</em> it comes down is yours: any point in the round, your turn or not, since playing a tile ends your turn before you'd have had the chance. While it's up, <em>every branch</em> of your train is fair game for opponents.</div>
  <div><b>Doubles</b>Never an obligation. A double is just the open end of its branch — match it to carry that branch on, or leave it and play somewhere else entirely. Doubles are laid crosswise.</div>${
    foot > 1 ? `<div><b>Pigeon foot</b>${footRule(foot, 'mexicanTrain')} While it is frozen nothing else on that train grows — not the toes already laid, and not branches that forked off an earlier double. Every other train carries on as normal, and you are never forced to feed a foot instead of playing elsewhere.</div>` : ''}
  <div><b>The Mexican Train</b>Communal, always open, started by whoever first plays a matching tile on it.</div>`;

const chickenFootRules = (foot: Foot, hub: Hub): string => `
  <div><b>The hub</b>${hubRule(hub)}</div>
  <div><b>After that</b>One tile per turn, on any open end. There are no trains of your own and no markers: the board belongs to everybody, all the time.</div>
  <div><b>Chicken foot</b>${footRule(foot, 'chickenFoot')} While it is owed, <em>nothing</em> on the board grows — not the toes already laid, and not branches that forked off an earlier double. You are still never obliged to feed it rather than draw.</div>
  <div><b>Doubles</b>Never an obligation, but think before you lay one: it holds the whole table up, and if you can't cover it yourself you're waiting on somebody who can. Doubles are laid crosswise.</div>`;

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

// The back gesture, caught before it spends the table. On a phone it is a
// thumb's width from every other gesture, and walking out mid-game leaves a
// table waiting on a turn that isn't coming — so it asks once.
//
// It says what is held rather than what is lost, because nothing is lost: the
// seat keeps the hand, and the arrangement is remembered too. The card is a
// check, not a warning, and the way out of it that costs nothing is the one
// under your thumb.
export function confirmLeave(leave: () => void): void {
  openModal(`<div class="card">
    <h2>Leave the table?</h2>
    <p class="sub">The table waits on your turn rather than playing round you, so an empty seat holds everyone up.</p>
    <div class="stack">
      <button class="btn primary big" data-close>Stay at the table</button>
      <button class="btn ghost" id="leaveTable">Leave</button>
    </div>
    <p class="foot-note">Your seat is held either way, along with the way you've arranged your hand. The front page lists this table so you can pick it straight back up.</p>
  </div>`, () => { $<HTMLElement>('#leaveTable', modalEl).onclick = leave; });
}

/** Whether that card is the one currently on screen. Asked by the back gesture
 *  itself: having asked once, a second swipe is an answer rather than a
 *  question, and being unable to leave by the gesture you left with would be
 *  its own kind of trap. */
export const askingToLeave = (): boolean => !modalEl.hidden && !!$('#leaveTable', modalEl);

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
