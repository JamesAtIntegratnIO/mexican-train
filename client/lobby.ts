// The pre-game table: the share link, who is sitting down, and — for the host —
// the three settings that decide how the game plays.

import { $, app, esc, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { LOGO, avatar } from './tiles.js';
import { send } from './net.js';
import { GAME_NOTE, GAME_TITLE, SCORING_BLANKS, footRule, hubNote, sentence } from '../shared/phrasing.js';
import type { RoomSnapshot, SeatView, Settings } from '../shared/protocol.js';

/** A picker's choices: the value sent to the server, and its label. */
type Choice = [string | number, string];

const GAMES: Choice[] = [['mexicanTrain', GAME_TITLE.mexicanTrain], ['chickenFoot', GAME_TITLE.chickenFoot]];
const SETS: Choice[] = [[12, 'Double-12'], [9, 'Double-9'], [6, 'Double-6']];
const RINGS: Choice[] = [[4, 'Four'], [6, 'Six']];
const FEET: Choice[] = [[1, 'Cover once'], [2, '2 + fork'], [3, '3 + fork']];
const SCORINGS: Choice[] = [['house', 'House'], ['official', 'Official'], ['pips', 'Just pips']];

export function renderLobby(): void {
  const r = S.room!, isHost = r.hostId === S.pid;
  const url = `${location.origin}/g/${r.code}`;
  const me = r.seats.find((s) => s.id === S.pid);

  app.innerHTML = `<div class="center"><div class="card wide">
    ${LOGO}
    <p class="tagline">Send this link to your friends.</p>

    <div class="share">
      <div class="code-big">${esc(r.code)}</div>
      <div class="share-url">
        <input id="url" readonly value="${esc(url)}">
        <button class="btn sm" id="copy">Copy</button>
        ${'share' in navigator ? '<button class="btn sm" id="share">Share</button>' : ''}
      </div>
    </div>

    ${r.spectating ? '<p class="foot-note" style="margin:0 0 16px"><span class="chip">watching</span> You\'ll see the table but not anyone\'s hand.</p>' : ''}
    <div class="label">At the table · ${r.seats.length}/8</div>
    <div class="seats">${r.seats.map((s, i) => seatHTML(s, i, r, isHost)).join('')}</div>

    <div class="stack">
      <div><div class="label">Your name</div><input id="lname" maxlength="18" value="${esc(me ? me.name : S.name)}"></div>
      ${isHost ? hostControlsHTML(r) : waitingHTML(r)}
    </div>
    ${watchersHTML(r)}
  </div></div>`;

  wireLobby(url);
}

function seatHTML(s: SeatView, i: number, r: RoomSnapshot, isHost: boolean): string {
  return `<div class="seat">
    ${avatar(s.name, i)}
    <span class="nm">${esc(s.name)}${s.id === S.pid ? ' <span style="color:var(--dimmer);font-weight:400">(you)</span>' : ''}</span>
    ${s.bot ? '<span class="chip">bot</span>' : ''}
    ${s.id === r.hostId ? '<span class="chip gold">host</span>' : ''}
    ${isHost && s.id !== S.pid ? `<button class="icon-btn" data-remove="${s.id}" title="Remove">✕</button>` : ''}
  </div>`;
}

// Every host setting is the same control: a row of choices and a note saying
// what the chosen one means. `key` is the settings field, which is also how the
// single click handler below knows what it was just asked to change.
function picker(key: keyof Settings, label: string, options: Choice[], current: string | number, note: string): string {
  return `<div><div class="label">${label}</div>
    <div class="seg" data-key="${key}">
      ${options.map(([v, t]) => `<button data-set="${v}" class="${current === v ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    <p class="foot-note" style="margin-top:8px;text-align:left">${note}</p>
  </div>`;
}

function hostControlsHTML(r: RoomSnapshot): string {
  const tooMany = r.seats.length > r.settings.seats;
  const setNote = `${r.settings.max + 1} rounds · ${r.settings.deal} tiles each · seats up to ${r.settings.seats}${
    tooMany ? ' <b style="color:var(--red)">— too many players for this set</b>' : ''}`;
  // Chicken Foot fixes what a double demands, so offering the choice would be
  // offering something the server is going to overrule.
  const footPicker = r.settings.game === 'chickenFoot'
    ? `<div><div class="label">Doubles</div><p class="foot-note" style="margin-top:0;text-align:left">${footRule(r.settings.foot, r.settings.game)}</p></div>`
    : picker('foot', 'Doubles / pigeon foot', FEET, r.settings.foot, footRule(r.settings.foot, r.settings.game));

  // Only Chicken Foot rings its opening double, so only Chicken Foot is asked.
  const hubPicker = r.settings.game === 'chickenFoot'
    ? picker('hub', 'Tiles round the opening double', RINGS, r.settings.hub, hubNote(r.settings.hub))
    : '';

  return `<div id="hostsettings">
      ${picker('game', 'Game', GAMES, r.settings.game, GAME_NOTE[r.settings.game])}
      ${picker('max', 'Domino set', SETS, r.settings.max, setNote)}
      ${hubPicker}
      ${footPicker}
      ${picker('scoring', 'Scoring', SCORINGS, r.settings.scoring, sentence(SCORING_BLANKS[r.settings.scoring]))}
    </div>
    <div class="row">
      <button class="btn" id="addbot" style="flex:1" ${r.seats.length >= 8 ? 'disabled' : ''}>+ Add bot</button>
      <button class="btn primary" id="start" style="flex:2" ${r.seats.length < 2 || tooMany ? 'disabled' : ''}>
        ${r.seats.length < 2 ? 'Waiting for players…' : tooMany ? 'Too many for this set' : `Start game (${r.seats.length})`}</button>
    </div>`;
}

const waitingHTML = (r: RoomSnapshot): string =>
  `<p class="foot-note">Waiting for ${esc((r.seats.find((s) => s.id === r.hostId) || {}).name || 'the host')} to start…</p>`;

const watchersHTML = (r: RoomSnapshot): string => (r.watchers.length
  ? `<div class="label" style="margin-top:20px">Watching · ${r.watchers.length}</div>
     <div class="watchers">${r.watchers.map((w) => `<span class="chip ${w.id === S.pid ? 'gold' : ''}">${esc(w.name)}${w.id === S.pid ? ' (you)' : ''}</span>`).join('')}</div>`
  : '');

function wireLobby(url: string): void {
  $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); } catch { $<HTMLInputElement>('#url').select(); document.execCommand('copy'); }
    toast('Link copied — go paste it');
  };
  if ($('#share')) $('#share').onclick = () => navigator.share({ title: 'Mexican Train', text: 'Join my game', url }).catch(() => {});
  $<HTMLInputElement>('#lname').onchange = (e) => { S.name = (e.target as HTMLInputElement).value.trim(); localStorage.setItem('mt.name', S.name); send({ t: 'name', name: S.name }); };
  if ($('#addbot')) $('#addbot').onclick = () => send({ t: 'addBot' });
  if ($('#start')) $('#start').onclick = () => { Snd.ready(); send({ t: 'start' }); };
  if ($('#hostsettings')) $('#hostsettings').onclick = onSettingClick;
  app.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) => { b.onclick = () => send({ t: 'remove', id: b.dataset.remove! }); });
}

function onSettingClick(e: Event): void {
  const b = (e.target as Element).closest<HTMLElement>('[data-set]');
  if (!b) return;
  const key = (b.parentElement as HTMLElement).dataset.key as keyof Settings;
  // The set size and the foot are numbers on the wire; the game and the scoring
  // style are names. Sending the wrong one is ignored by the server's whitelist.
  const named = key === 'scoring' || key === 'game';
  const value = named ? b.dataset.set! : Number(b.dataset.set);
  send({ t: 'settings', settings: { [key]: value } as Partial<Settings> });
}
