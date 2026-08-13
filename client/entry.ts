// Getting to a table.
//
// Two ways in, and each asks for exactly what it needs and nothing more:
//
//   /          name, then start a table or join one by code
//   /g/CODE    name, and whether you're playing or watching
//
// Nobody is asked their name twice. Making a table, or joining a lobby by code,
// already establishes both answers, so those go straight in; only a bare link
// reaches the gate, because only then is there a question left to ask.

import { $, app, esc, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { LOGO } from './tiles.js';
import { connect } from './net.js';
import { onRoom, fatal } from './session.js';
import { track } from './track.js';
import type { Hooks } from './net.js';

/** What /api/room/CODE says about a table, or why it could not be reached. */
interface Lookup {
  info?: { code: string; phase: 'lobby' | 'game'; players: number };
  why?: string;
}

const hooks: Hooks = { room: onRoom, fatal };

export function route(): void {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{3,8})$/);
  if (!m) { S.code = null; S.spectate = false; S.direct = null; renderHome(); return; }
  S.code = m[1].toUpperCase();
  const known = localStorage.getItem('mt.pid.' + S.code);
  if (known || S.direct === S.code) {
    S.spectate = localStorage.getItem('mt.role.' + S.code) === 'watch';
    // Straight in, with no gate to pass: a reload, a reconnect, or the hop that
    // follows making a table. The last of those has already said `made`, so
    // only the ones arriving cold are worth a name of their own.
    if (S.direct !== S.code) track('returned');
    connect(S.code, hooks); renderConnecting();
  } else {
    renderGate(S.code);
  }
}

export function go(path: string): void { history.pushState({}, '', path); route(); }
window.addEventListener('popstate', route);

// Is there a table on the other end of this code, and is it under way?
async function lookupTable(code: string): Promise<Lookup> {
  try {
    const r = await fetch('/api/room/' + code);
    const body: any = await r.json().catch(() => null);
    if (r.ok && body && !body.error) return { info: body };
    // A 404 really is a dead table; a 429 or a 500 is not, and saying so beats
    // telling someone their game vanished when the server was only busy.
    if (r.status === 404) return { why: 'No table with that code — it may have expired.' };
    return { why: `${body?.error || 'The server had a problem.'} Try again in a moment.` };
  } catch {
    return { why: 'Could not reach the server. Check your connection and try again.' };
  }
}

// Remember who we are at this table and open the socket.
function enterTable(code: string, name: string, spectate: boolean): void {
  S.name = name; localStorage.setItem('mt.name', name);
  S.spectate = spectate;
  S.direct = code;
  localStorage.setItem('mt.role.' + code, spectate ? 'watch' : 'play');
  Snd.ready();
}

export function renderConnecting(what?: string): void {
  app.innerHTML = `<div class="center"><div class="card" style="text-align:center">
    ${LOGO}
    <p class="tagline" style="margin-top:14px"><span class="spinner" style="display:inline-block;vertical-align:-2px"></span> ${
      esc(what || `Joining ${S.code}…`)}</p>
  </div></div>`;
}

// ---------------------------------------------------------------- the front door

function renderHome(): void {
  S.built = false;
  // A page view, not a person: coming back here from a table counts again. It
  // is the denominator for "landed and never started", and that question is
  // asked of visits.
  track('home');
  app.innerHTML = `<div class="center"><div class="card">
    ${LOGO}
    <p class="tagline">Start a table, share the link, play. Nothing to install, nothing saved.</p>
    <div class="stack">
      <div><div class="label">Your name</div><input id="name" maxlength="18" placeholder="Who's playing?" value="${esc(S.name)}"></div>
      <button class="btn primary big" id="new">Start a new game</button>
    </div>
    <div class="divider">or join one</div>
    <div class="row">
      <input id="code" maxlength="6" placeholder="CODE" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;text-align:center">
      <button class="btn" id="join">Join</button>
    </div>
    <p class="foot-note">Sessions live in memory only and disappear when everyone leaves.<br>Play with 2–8 people, or fill the seats with bots.</p>
  </div></div>`;

  const nameEl = $<HTMLInputElement>('#name'), codeEl = $<HTMLInputElement>('#code');
  const keepName = () => { S.name = nameEl.value.trim(); localStorage.setItem('mt.name', S.name); };
  const requireName = () => {
    keepName();
    if (S.name) return true;
    nameEl.focus(); toast('Enter a name first.', 'err');
    return false;
  };

  nameEl.oninput = keepName;
  $('#new').onclick = () => { if (requireName()) startTable(); };
  $('#join').onclick = () => { if (requireName()) joinByCode(codeEl.value); };
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') $('#join').click(); };
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') $('#new').click(); };
}

async function startTable(): Promise<void> {
  const btn = $<HTMLButtonElement>('#new'); btn.disabled = true; btn.textContent = 'Setting the table…';
  // The server has a real reason for every refusal here — too many tables too
  // fast, or at capacity. Checking the status is what lets the player see it;
  // parsing the body blind gives an undefined code and a silent dead button.
  let msg = 'Could not reach the server.';
  try {
    const r = await fetch('/api/new', { method: 'POST' });
    const body: any = await r.json().catch(() => null);
    if (r.ok && body?.code) {
      // You named yourself and you're plainly playing — there is nothing left
      // to ask, so skip the gate and open the lobby.
      track('made');
      enterTable(body.code, S.name, false);
      return go('/g/' + body.code);          // go() repaints, so the button goes with it
    }
    msg = body?.error || 'Could not start a table — try again.';
  } catch {}
  btn.disabled = false; btn.textContent = 'Start a new game';
  toast(msg, 'err');
}

async function joinByCode(raw: string): Promise<void> {
  const c = raw.trim().toUpperCase();
  if (c.length !== 6) return toast('Table codes are 6 characters.', 'err');
  const btn = $<HTMLButtonElement>('#join'); btn.disabled = true;
  // Checking here means a bad code is a message on this page, rather than a
  // dead end on a screen the player has to navigate back out of.
  const { info, why } = await lookupTable(c);
  btn.disabled = false;
  if (!info) return toast(why!, 'err');
  // A game already running is the one case with a question left in it: there
  // may be no seat to take. Let the gate put that choice properly.
  if (info.phase === 'game') return go('/g/' + c);
  track('code');
  enterTable(c, S.name, false);
  go('/g/' + c);
}

// ---------------------------------------------------------------- the shared link

// Arriving on a shared link: who are you, and are you playing or watching?
async function renderGate(code: string): Promise<void> {
  renderConnecting(`Looking up ${code}…`);
  const { info, why } = await lookupTable(code);
  if (!info) return fatal(why!);
  // A shared link that found its table. The denominator for the gate: how many
  // of these turn into someone at the table, and how many read it and leave.
  track('link');

  const started = info!.phase === 'game';
  let spectate = started;                      // no seats left to take mid-game

  app.innerHTML = gateHTML(code, info!, started, spectate);

  const nameEl = $<HTMLInputElement>('#gname'), note = $('#rolenote');
  const paintRole = () => {
    for (const b of Array.from($('#rolepick').children) as HTMLElement[]) b.classList.toggle('on', (b.dataset.role === 'watch') === spectate);
    note.textContent = roleNote(started, spectate);
  };
  paintRole();

  $('#rolepick').onclick = (e: Event) => {
    const b = (e.target as Element).closest('button');
    if (!b || b.disabled) return;
    spectate = b.dataset.role === 'watch';
    Snd.tap(); paintRole();
  };
  const enter = () => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); return toast('Enter a name first.', 'err'); }
    track(spectate ? 'watch' : 'seat');
    enterTable(code, nm, spectate);
    connect(code, hooks); renderConnecting();
  };
  $('#genter').onclick = enter;
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') enter(); };
  nameEl.focus();
}

function gateHTML(code: string, info: NonNullable<Lookup['info']>, started: boolean, spectate: boolean): string {
  return `<div class="center"><div class="card">
    ${LOGO}
    <p class="tagline">Joining table <b style="color:var(--gold);letter-spacing:.14em">${esc(code)}</b>${
      started ? '' : ` · ${info.players} ${info.players === 1 ? 'person' : 'people'} here`}</p>
    <div class="stack">
      <div><div class="label">Your name</div><input id="gname" maxlength="18" placeholder="Who are you?" value="${esc(S.name)}"></div>
      <div>
        <div class="label">At this table</div>
        <div class="seg" id="rolepick">
          <button data-role="play" class="${spectate ? '' : 'on'}" ${started ? 'disabled' : ''}>Take a seat</button>
          <button data-role="watch" class="${spectate ? 'on' : ''}">Just watch</button>
        </div>
        <p class="foot-note" id="rolenote" style="margin-top:8px;text-align:left"></p>
      </div>
      <button class="btn primary big" id="genter">Join table</button>
    </div>
  </div></div>`;
}

const roleNote = (started: boolean, spectate: boolean): string => {
  if (started) return 'This game is already under way, so there is no seat to take — but you can watch it.';
  return spectate
    ? "You'll see the table and the chat, but nobody's hand."
    : "You'll be dealt a hand and take your turns.";
};
