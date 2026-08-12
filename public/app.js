// Mexican Train — client. Vanilla, no build step.

// Number colours, mirroring a colour-coded double-12 set. All ≥4.5:1 on ivory.
const NUMC = ['#475569', '#1d4ed8', '#047857', '#be185d', '#6d28d9', '#b45309', '#0e7490',
              '#b91c1c', '#4d7c0f', '#a21caf', '#c2410c', '#4338ca', '#0f766e'];
const SEATC = ['#f0b429', '#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#facc15'];

const app = document.getElementById('app');
const modalEl = document.getElementById('modal');
const toastEl = document.getElementById('toasts');

const S = {
  code: null, pid: null, name: localStorage.getItem('mt.name') || '',
  ws: null, room: null, connected: false, retry: 0,
  sel: null, tab: 'scores', panel: false, unread: 0,
  pipMode: localStorage.getItem('mt.pips') === '1',
  expanded: new Set(), spectate: false,
  handOrder: [], flipped: new Set(), arrange: false, dragging: false, suppressClick: false,
  zoom: (() => { const z = Number(localStorage.getItem('mt.zoom')); return z >= 24 && z <= 76 ? z : 0; })(),
  lastTurn: null, lastPlayKey: null, shownEnd: null,
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);

// ============================================================ sound
const Snd = {
  on: localStorage.getItem('mt.mute') !== '1', ctx: null,
  ready() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; },
  tone(freq, dur, type = 'sine', vol = 0.09, delay = 0) {
    if (!this.on) return;
    try {
      const c = this.ready(), t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch {}
  },
  clack() { this.tone(190, 0.07, 'triangle', 0.13); this.tone(95, 0.11, 'sine', 0.09, 0.01); },
  draw()  { this.tone(140, 0.13, 'sine', 0.1); },
  tap()   { this.tone(420, 0.05, 'square', 0.05); },
  turn()  { this.tone(660, 0.15, 'sine', 0.07); this.tone(880, 0.22, 'sine', 0.06, 0.09); },
  foot()  { [392, 523, 659].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.07, i * 0.06)); },
  alert() { this.tone(880, 0.1, 'square', 0.05); this.tone(1174, 0.14, 'square', 0.045, 0.1); },
  win()   { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.08, i * 0.09)); },
  toggle() { this.on = !this.on; localStorage.setItem('mt.mute', this.on ? '0' : '1'); return this.on; },
};

// ============================================================ toasts
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  toastEl.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2600);
}

// ============================================================ pieces
// `flip` swaps which half shows first — purely cosmetic, for lining a hand up
// into the shape of the train you're planning. The tile's identity is unchanged.
function tileHTML(id, cls = 'p', extra = '', flip = false) {
  let [a, b] = id.split('-').map(Number);
  if (flip) [a, b] = [b, a];
  return `<div class="tile ${cls}${a === b ? ' dbl' : ''} ${extra}" data-tile="${id}" aria-label="${a} ${b}"
    style="--c1:${NUMC[a]};--c2:${NUMC[b]}">${halfHTML(a)}${halfHTML(b)}</div>`;
}
// A laid tile knows its orientation: `a` is the end that connects, `b` is the new open end.
function laidHTML(t, extra = '') {
  const cls = t.a === t.b ? 'l dbl' : 'l';
  return `<div class="tile ${cls} ${extra}" data-tile="${t.tile}" aria-label="${t.a} ${t.b}"
    style="--c1:${NUMC[t.a]};--c2:${NUMC[t.b]}">${halfHTML(t.a)}${halfHTML(t.b)}</div>`;
}

// Pip layouts on a unit square, spotted the way real double-12 sets are.
const CC = [0.26, 0.5, 0.74];
const R4 = [0.17, 0.39, 0.61, 0.83], R5 = [0.13, 0.31, 0.5, 0.69, 0.87], R3 = [0.22, 0.5, 0.78];
const col = (x, ys) => ys.map((y) => [x, y]);
const PIPS = [
  [],
  [[0.5, 0.5]],
  [[0.28, 0.24], [0.72, 0.76]],
  [[0.25, 0.22], [0.5, 0.5], [0.75, 0.78]],
  [[CC[0], 0.26], [CC[2], 0.26], [CC[0], 0.74], [CC[2], 0.74]],
  [[CC[0], 0.26], [CC[2], 0.26], [0.5, 0.5], [CC[0], 0.74], [CC[2], 0.74]],
  [...col(CC[0], R3), ...col(CC[2], R3)],
  [...col(CC[0], R3), [0.5, 0.5], ...col(CC[2], R3)],
  [...col(CC[0], R4), ...col(CC[2], R4)],
  [...col(CC[0], R3), ...col(CC[1], R3), ...col(CC[2], R3)],
  [...col(CC[0], R5), ...col(CC[2], R5)],
  [...col(CC[0], R4), ...col(CC[1], R3), ...col(CC[2], R4)],
  [...col(CC[0], R4), ...col(CC[1], R4), ...col(CC[2], R4)],
];

// Both spellings ship in the markup; CSS picks one, so the toggle is instant.
function halfHTML(n) {
  const pts = PIPS[n] || [];
  const r = n >= 10 ? 7.2 : n >= 7 ? 8.4 : 10;
  return `<div class="half"><span class="num">${n}</span><svg class="pips" viewBox="0 0 100 100" aria-hidden="true">${
    pts.map(([x, y]) => `<circle cx="${(x * 100).toFixed(1)}" cy="${(y * 100).toFixed(1)}" r="${r}"/>`).join('')
  }</svg></div>`;
}
function applyPipMode() { document.body.classList.toggle('pipmode', S.pipMode); }

// --tw is the single sizing token for every domino, so zoom is one variable.
const PIP_FLOOR = 34;   // below this, pips stop being readable and numerals take over
const currentTw = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tw')) || 46;
function applyZoom() {
  // Only pin the size once the player has actually chosen one — otherwise leave
  // the responsive defaults in charge.
  if (S.zoom) document.documentElement.style.setProperty('--tw', S.zoom + 'px');
  document.body.classList.toggle('smalltiles', currentTw() < PIP_FLOOR);
}
addEventListener('resize', applyZoom);
const avatar = (name, i) => `<div class="avatar" style="background:${SEATC[i % SEATC.length]}">${esc((name || '?')[0].toUpperCase())}</div>`;

// The little mini train that gets set on an open train, same as on the table.
const TRAIN_ICON = `<svg viewBox="0 0 26 17" aria-hidden="true">
  <rect x="5.1" y="1" width="3.4" height="3.4" rx=".7"/>
  <rect x="3.4" y="4.2" width="8.6" height="7" rx="1.4"/>
  <rect x="12" y="1.8" width="7.6" height="9.4" rx="1.4"/>
  <rect x="14" y="3.6" width="3.6" height="3.4" rx=".6" fill="#0b0e14"/>
  <rect x="1.4" y="11.4" width="23.2" height="2.4" rx="1.2"/>
  <circle cx="6.6" cy="15" r="1.9"/><circle cx="13" cy="15" r="1.9"/><circle cx="19.4" cy="15" r="1.9"/>
</svg>`;
const markerHTML = (color, label) => `<span class="marker" style="--mk:${color}" title="${esc(label)}">${TRAIN_ICON}</span>`;

// ============================================================ networking
function connect(code) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?code=${encodeURIComponent(code)}`);
  S.ws = ws;

  ws.onopen = () => {
    S.connected = true; S.retry = 0; paintConn();
    send({ t: 'join', pid: localStorage.getItem('mt.pid.' + code) || null, name: S.name, spectate: S.spectate });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'you') { S.pid = m.pid; localStorage.setItem('mt.pid.' + code, m.pid); return; }
    if (m.t === 'room') return onRoom(m);
    if (m.t === 'error') return toast(m.msg, 'err');
    if (m.t === 'drew') {
      const t = m.tile.replace('-', ' | ');
      if (m.engine) { Snd.win(); toast(`Drew ${t} — the engine! Lay it to start.`); }
      else { Snd.draw(); toast(m.seeking ? `Drew ${t} — not the engine` : m.playable ? `Drew ${t} — you can play it` : `Drew ${t} — no play, marker up, turn over`); }
      return;
    }
    if (m.t === 'fatal') { S.ws = null; ws.close(); return fatal(m.msg); }
  };
  ws.onclose = () => {
    S.connected = false;
    if (!S.ws) return;                       // deliberate teardown
    if (S.retry > 8) return fatal('Lost connection to the table. Reload to rejoin.');
    const delay = Math.min(1000 * 2 ** S.retry++, 8000);
    paintConn();                             // stale state is worse unlabelled than labelled
    setTimeout(() => connect(code), delay);
  };
  ws.onerror = () => {};
}
const send = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };

function onRoom(m) {
  const prev = S.room;
  S.room = m;
  if (!prev || prev.phase !== m.phase) { S.built = false; }

  const g = m.game;
  if (g) {
    if (g.turn === S.pid && S.lastTurn !== S.pid) Snd.turn();
    S.lastTurn = g.turn;
    const key = g.lastPlay ? `${g.lastPlay.trainId}:${g.lastPlay.tile}:${g.round}` : null;
    if (key && key !== S.lastPlayKey) { if (S.lastPlayKey !== null) Snd.clack(); S.lastPlayKey = key; }
    // a foot just got filled — the open-double count dropped without a new one appearing
    const feet = g.pending.length;
    if (prev && prev.game && feet < S.lastFeet && g.round === prev.game.round && g.foot > 1) Snd.foot();
    S.lastFeet = feet;

    // Digital stand-in for tapping the table: call out anyone down to one tile.
    const onOne = g.players.filter((p) => p.tiles === 1).map((p) => p.id).join(',');
    if (onOne && onOne !== S.lastOnOne && prev && prev.game && g.round === prev.game.round) {
      for (const p of g.players) {
        if (p.tiles === 1 && !(S.lastOnOne || '').includes(p.id)) {
          toast(p.id === S.pid ? 'Last tile — call it!' : `${p.name} is down to one tile`);
          Snd.alert();
        }
      }
    }
    S.lastOnOne = onOne;
    if (!g.hand.includes(S.sel)) S.sel = null;
  }
  const unreadNow = m.chat.filter((c) => !c.system).length;
  if (prev && unreadNow > (prev.chat.filter((c) => !c.system).length) && !S.panel) S.unread++;

  render();
  if (g && (g.status === 'roundOver' || g.status === 'gameOver')) {
    const key = `${g.status}:${g.round}`;
    if (S.shownEnd !== key) { S.shownEnd = key; if (g.roundWinner === S.pid || g.status === 'gameOver') Snd.win(); showEndModal(g); }
  } else S.shownEnd = null;
}

function fatal(msg) {
  S.ws = null; S.room = null;
  app.innerHTML = `<div class="center"><div class="card">
    <div class="logo">${tileHTML('6-6', 'p mini')}<h1>Mexican Train</h1></div>
    <p class="tagline" style="margin-top:14px">${esc(msg)}</p>
    <div class="stack"><button class="btn primary big" data-go="home">Start a new game</button></div>
  </div></div>`;
}

// ============================================================ routing
function route() {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{3,8})$/);
  if (!m) { S.code = null; S.spectate = false; renderHome(); return; }
  S.code = m[1].toUpperCase();
  // Already known at this table? Slot straight back into whatever you were.
  if (localStorage.getItem('mt.pid.' + S.code)) {
    S.spectate = localStorage.getItem('mt.role.' + S.code) === 'watch';
    connect(S.code); renderConnecting();
  } else {
    renderGate(S.code);
  }
}

// Newcomers choose: take a seat, or watch. Either way they have to say who they are.
async function renderGate(code) {
  renderConnecting();
  let info = null;
  try { info = await fetch('/api/room/' + code).then((r) => r.json()); } catch {}
  if (!info || info.error) return fatal('That session has expired or never existed. Start a new one.');
  const started = info.phase === 'game';

  app.innerHTML = `<div class="center"><div class="card">
    <div class="logo">${tileHTML('6-6', 'p mini')}<h1>Mexican Train</h1></div>
    <p class="tagline">Joining table <b style="color:var(--gold);letter-spacing:.14em">${esc(code)}</b>${
      started ? ' — the game is already under way, so you can watch it.' : `. ${info.players} ${info.players === 1 ? 'person is' : 'people are'} here.`}</p>
    <div class="stack">
      <div><div class="label">Your name</div><input id="gname" maxlength="18" placeholder="Who are you?" value="${esc(S.name)}"></div>
      ${started ? '' : '<button class="btn primary big" id="gplay">Take a seat</button>'}
      <button class="btn ${started ? 'primary big' : ''}" id="gwatch">Just watch</button>
    </div>
    <p class="foot-note">Spectators see the table and the chat, but no one's hand${started ? '' : ', and they can\'t play'}.</p>
  </div></div>`;

  const nameEl = $('#gname');
  const enter = (spectate) => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); return toast('Enter a name first.', 'err'); }
    S.name = nm; localStorage.setItem('mt.name', nm);
    S.spectate = spectate;
    localStorage.setItem('mt.role.' + code, spectate ? 'watch' : 'play');
    Snd.ready(); connect(code); renderConnecting();
  };
  if ($('#gplay')) $('#gplay').onclick = () => enter(false);
  $('#gwatch').onclick = () => enter(true);
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') ($('#gplay') || $('#gwatch')).click(); };
  nameEl.focus();
}
function go(path) { history.pushState({}, '', path); route(); }
window.addEventListener('popstate', route);

// ============================================================ views
function render() {
  if (!S.room) return;
  if (S.room.phase === 'lobby') renderLobby();
  else renderTable();
}

function renderConnecting() {
  app.innerHTML = `<div class="center"><div class="card" style="text-align:center">
    <div class="logo">${tileHTML('6-6', 'p mini')}<h1>Mexican Train</h1></div>
    <p class="tagline" style="margin-top:14px"><span class="spinner" style="display:inline-block;vertical-align:-2px"></span> Joining ${esc(S.code)}…</p>
  </div></div>`;
}

function renderHome() {
  S.built = false;
  app.innerHTML = `<div class="center"><div class="card">
    <div class="logo">${tileHTML('6-6', 'p mini')}<h1>Mexican Train</h1></div>
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

  const nameEl = $('#name'), codeEl = $('#code');
  const keepName = () => { S.name = nameEl.value.trim(); localStorage.setItem('mt.name', S.name); };
  nameEl.oninput = keepName;
  $('#new').onclick = async () => {
    keepName(); Snd.ready();
    const btn = $('#new'); btn.disabled = true; btn.textContent = 'Setting the table…';
    try {
      const r = await fetch('/api/new', { method: 'POST' });
      const { code } = await r.json();
      go('/g/' + code);
    } catch { btn.disabled = false; btn.textContent = 'Start a new game'; toast('Could not reach the server.', 'err'); }
  };
  const doJoin = () => {
    keepName();
    const c = codeEl.value.trim().toUpperCase();
    if (c.length < 3) return toast('Enter the 4-letter code.', 'err');
    Snd.ready(); go('/g/' + c);
  };
  $('#join').onclick = doJoin;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') doJoin(); };
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') $('#new').click(); };
}

// ---------------------------------------------------------------- lobby
function renderLobby() {
  const r = S.room, isHost = r.hostId === S.pid;
  const url = `${location.origin}/g/${r.code}`;
  const me = r.seats.find((s) => s.id === S.pid);

  app.innerHTML = `<div class="center"><div class="card wide">
    <div class="logo">${tileHTML('6-6', 'p mini')}<h1>Mexican Train</h1></div>
    <p class="tagline">Send this link to your friends.</p>

    <div class="share">
      <div class="code-big">${esc(r.code)}</div>
      <div class="share-url">
        <input id="url" readonly value="${esc(url)}">
        <button class="btn sm" id="copy">Copy</button>
        ${navigator.share ? '<button class="btn sm" id="share">Share</button>' : ''}
      </div>
    </div>

    ${r.spectating ? '<p class="foot-note" style="margin:0 0 16px"><span class="chip">watching</span> You\'ll see the table but not anyone\'s hand.</p>' : ''}
    <div class="label">At the table · ${r.seats.length}/8</div>
    <div class="seats">
      ${r.seats.map((s, i) => `
        <div class="seat">
          ${avatar(s.name, i)}
          <span class="nm">${esc(s.name)}${s.id === S.pid ? ' <span style="color:var(--dimmer);font-weight:400">(you)</span>' : ''}</span>
          ${s.bot ? '<span class="chip">bot</span>' : ''}
          ${s.id === r.hostId ? '<span class="chip gold">host</span>' : ''}
          ${isHost && s.id !== S.pid ? `<button class="icon-btn" data-remove="${s.id}" title="Remove">✕</button>` : ''}
        </div>`).join('')}
    </div>

    <div class="stack">
      <div><div class="label">Your name</div><input id="lname" maxlength="18" value="${esc(me ? me.name : S.name)}"></div>
      ${isHost ? `
        <div><div class="label">Domino set</div>
          <div class="seg" id="setpick">
            ${[[12, 'Double-12'], [9, 'Double-9'], [6, 'Double-6']].map(([v, t]) =>
              `<button data-max="${v}" class="${r.settings.max === v ? 'on' : ''}">${t}</button>`).join('')}
          </div>
          <p class="foot-note" style="margin-top:8px;text-align:left">${r.settings.max + 1} rounds · ${r.settings.deal} tiles each · seats up to ${r.settings.seats}${
            r.seats.length > r.settings.seats ? ` <b style="color:var(--red)">— too many players for this set</b>` : ''}</p>
        </div>
        <div><div class="label">Doubles / pigeon foot</div>
          <div class="seg" id="footpick">
            ${[[1, 'Cover once'], [2, '2 + fork'], [3, '3 + fork']].map(([v, t]) =>
              `<button data-foot="${v}" class="${r.settings.foot === v ? 'on' : ''}">${t}</button>`).join('')}
          </div>
          <p class="foot-note" style="margin-top:8px;text-align:left">${r.settings.foot === 1
            ? 'A double just has to be covered by one tile before play carries on.'
            : `A double takes ${r.settings.foot} tiles, then the train forks into ${r.settings.foot} live ends. Put your marker up and opponents get all of them.`}</p>
        </div>
        <div><div class="label">Scoring</div>
          <div class="seg" id="scorepick">
            ${[['house', 'House'], ['official', 'Official'], ['pips', 'Just pips']].map(([v, t]) =>
              `<button data-scoring="${v}" class="${r.settings.scoring === v ? 'on' : ''}">${t}</button>`).join('')}
          </div>
          <p class="foot-note" style="margin-top:8px;text-align:left">${{
            house: 'Blank halves score 0, but getting caught with the 0|0 costs 50.',
            official: 'Every blank half is 25, and the 0|0 is 50.',
            pips: 'Straight dot count — blanks are worth nothing at all.',
          }[r.settings.scoring]}</p>
        </div>
        <div class="row">
          <button class="btn" id="addbot" style="flex:1" ${r.seats.length >= 8 ? 'disabled' : ''}>+ Add bot</button>
          <button class="btn primary" id="start" style="flex:2" ${r.seats.length < 2 || r.seats.length > r.settings.seats ? 'disabled' : ''}>
            ${r.seats.length < 2 ? 'Waiting for players…' : r.seats.length > r.settings.seats ? 'Too many for this set' : `Start game (${r.seats.length})`}</button>
        </div>` : `<p class="foot-note">Waiting for ${esc((r.seats.find((s) => s.id === r.hostId) || {}).name || 'the host')} to start…</p>`}
    </div>
    ${r.watchers.length ? `<div class="label" style="margin-top:20px">Watching · ${r.watchers.length}</div>
      <div class="watchers">${r.watchers.map((w) => `<span class="chip ${w.id === S.pid ? 'gold' : ''}">${esc(w.name)}${w.id === S.pid ? ' (you)' : ''}</span>`).join('')}</div>` : ''}
  </div></div>`;

  $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); } catch { $('#url').select(); document.execCommand('copy'); }
    toast('Link copied — go paste it');
  };
  if ($('#share')) $('#share').onclick = () => navigator.share({ title: 'Mexican Train', text: 'Join my game', url }).catch(() => {});
  $('#lname').onchange = (e) => { S.name = e.target.value.trim(); localStorage.setItem('mt.name', S.name); send({ t: 'name', name: S.name }); };
  if ($('#addbot')) $('#addbot').onclick = () => send({ t: 'addBot' });
  if ($('#start')) $('#start').onclick = () => { Snd.ready(); send({ t: 'start' }); };
  if ($('#setpick')) $('#setpick').onclick = (e) => { const b = e.target.closest('[data-max]'); if (b) send({ t: 'settings', settings: { max: +b.dataset.max } }); };
  if ($('#footpick')) $('#footpick').onclick = (e) => { const b = e.target.closest('[data-foot]'); if (b) send({ t: 'settings', settings: { foot: +b.dataset.foot } }); };
  if ($('#scorepick')) $('#scorepick').onclick = (e) => { const b = e.target.closest('[data-scoring]'); if (b) send({ t: 'settings', settings: { scoring: b.dataset.scoring } }); };
  app.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => send({ t: 'remove', id: b.dataset.remove }); });
}

// ---------------------------------------------------------------- table
function buildTable() {
  app.innerHTML = `<div class="table-view">
    <header class="topbar">
      <div class="engine-badge" id="engine"></div>
      <div class="grow"></div>
      <div class="pill" id="bone"></div>
      <button class="icon-btn" id="display" title="Tile size &amp; markings">⛭</button>
      <button class="icon-btn" id="mute" title="Sound">${Snd.on ? '🔊' : '🔇'}</button>
      <button class="icon-btn" id="rules" title="Rules">?</button>
      <button class="icon-btn" id="togglePanel" title="Players &amp; chat">☰</button>
      <div class="pop" id="displayPop" hidden>
        <div class="label">Tile size</div>
        <div class="zoomrow">
          <button class="icon-btn" data-zoom="-1" title="Smaller">−</button>
          <input type="range" id="zoom" min="24" max="76" step="2">
          <button class="icon-btn" data-zoom="1" title="Bigger">+</button>
        </div>
        <div class="label" style="margin-top:14px">Markings</div>
        <div class="seg" id="markpick">
          <button data-pips="0">Numbers</button><button data-pips="1">Pips</button>
        </div>
        <p class="foot-note" id="pipnote" style="text-align:left;margin-top:8px"></p>
      </div>
    </header>
    <main class="board"><div class="lanes" id="lanes"></div></main>
    <footer class="dock">
      <div class="turnbar" id="turnbar"></div>
      <div class="hand" id="hand"></div>
      <div class="handtools" id="handtools">
        <button class="btn sm" id="arrange" title="Drag tiles to reorder, tap one to turn it around">⇄ Arrange</button>
        <span class="hint" id="arrangehint" hidden>drag to move · tap to turn a tile around</span>
        <button class="btn sm ghost" id="resort" title="Back to the dealt order, facing the usual way">Reset</button>
      </div>
    </footer>
    <aside class="panel" id="panel">
      <div class="panel-head"><h3 id="ptitle">Table</h3><button class="icon-btn" id="closePanel">✕</button></div>
      <div class="tabs" id="tabs">
        <button data-tab="scores">Scores</button><button data-tab="log">Activity</button><button data-tab="chat">Chat</button>
      </div>
      <div class="panel-body" id="pbody"></div>
      <form class="chat-form" id="chatForm" hidden>
        <input id="chatInput" maxlength="240" placeholder="Say something…" autocomplete="off">
        <button class="btn sm" type="submit">Send</button>
      </form>
    </aside>
  </div>`;

  const pop = $('#displayPop'), zoomEl = $('#zoom');
  const syncDisplay = () => {
    zoomEl.value = S.zoom || Math.round(currentTw());
    document.querySelectorAll('#markpick button').forEach((b) => b.classList.toggle('on', (b.dataset.pips === '1') === S.pipMode));
    $('#pipnote').textContent = currentTw() < PIP_FLOOR
      ? 'Tiles are too small for pips right now, so numbers are being used.'
      : `Pips switch to numbers automatically below ${PIP_FLOOR}px.`;
  };
  const setZoom = (v) => {
    S.zoom = Math.min(76, Math.max(24, v));
    localStorage.setItem('mt.zoom', String(S.zoom));
    applyZoom(); syncDisplay();
  };
  $('#display').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) syncDisplay(); };
  pop.onclick = (e) => {
    e.stopPropagation();
    const z = e.target.closest('[data-zoom]');
    if (z) { setZoom((S.zoom || Math.round(currentTw())) + Number(z.dataset.zoom) * 4); Snd.tap(); }
    const m = e.target.closest('[data-pips]');
    if (m) {
      S.pipMode = m.dataset.pips === '1';
      localStorage.setItem('mt.pips', S.pipMode ? '1' : '0');
      applyPipMode(); syncDisplay(); Snd.tap();
    }
  };
  zoomEl.oninput = (e) => setZoom(Number(e.target.value));
  syncDisplay();
  $('#mute').onclick = (e) => { const on = Snd.toggle(); e.currentTarget.textContent = on ? '🔊' : '🔇'; if (on) Snd.turn(); };
  $('#rules').onclick = showRules;
  $('#togglePanel').onclick = () => setPanel(!S.panel);
  $('#closePanel').onclick = () => setPanel(false);
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; paintPanel(); } };
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const i = $('#chatInput');
    if (i.value.trim()) send({ t: 'chat', text: i.value });
    i.value = '';
  };
  $('#lanes').onclick = onLaneClick;
  $('#hand').onclick = onHandClick;
  initHandTools();
  const repaintHand = () => { $('#hand').dataset.sig = ''; paintHand(S.room.game); paintTurnbar(S.room.game); };
  $('#arrange').onclick = (e) => {
    S.arrange = !S.arrange;
    e.currentTarget.classList.toggle('on', S.arrange);
    $('#arrangehint').hidden = !S.arrange;
    S.sel = null; Snd.tap();
    repaintHand(); paintLanes(S.room.game); paintTurnbar(S.room.game);
  };
  $('#resort').onclick = () => { S.handOrder = []; S.flipped.clear(); Snd.tap(); repaintHand(); };
  S.laneN = {};
  S.built = true;
}

function setPanel(open) {
  S.panel = open;
  const p = $('#panel'); if (!p) return;
  p.classList.toggle('open', open);
  let scrim = $('.scrim');
  if (open) {
    if (!scrim) { scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.onclick = () => setPanel(false); document.body.appendChild(scrim); }
    S.unread = 0; paintPanel();
  } else if (scrim) scrim.remove();
  const t = $('#togglePanel'); if (t) t.textContent = S.unread ? '☰•' : '☰';
}

function renderTable() {
  if (!S.built) buildTable();
  const g = S.room.game;

  $('#engine').innerHTML = `${g.engineDown ? tileHTML(`${g.engine}-${g.engine}`, 'p mini') : '<div class="tile p mini facedown">?</div>'}
    <div class="meta"><b>Round ${g.round} / ${g.totalRounds}</b>${g.engineDown ? `engine · double ${g.engine}` : `hunting the double ${g.engine}`}</div>`;
  $('#bone').innerHTML = `Boneyard <b>${g.boneyard}</b>`;
  const t = $('#togglePanel'); t.textContent = S.unread ? '☰•' : '☰';
  if (window.matchMedia('(min-width:900px)').matches) { S.panel = true; }

  paintLanes(g);
  paintHand(g);
  paintTurnbar(g);
  paintPanel();
}

function laneOrder(g) {
  const mine = g.trains.find((t) => t.owner === S.pid);
  const mex = g.trains.find((t) => t.owner === null);
  const rest = g.trains.filter((t) => t !== mine && t !== mex);
  return [mine, mex, ...rest].filter(Boolean);
}

// Branches are a tree; lay them out depth-first so children sit under their parent.
function orderSegs(segs) {
  const kids = new Map();
  for (const s of segs) {
    const k = s.parent === null ? 'root' : s.parent;
    (kids.get(k) || kids.set(k, []).get(k)).push(s);
  }
  const out = [];
  (function walk(k, depth) {
    for (const s of kids.get(k) || []) { out.push({ ...s, depth }); walk(s.id, depth + 1); }
  })('root', 0);
  return out;
}

function paintLanes(g) {
  const wrap = $('#lanes');
  const order = laneOrder(g);
  const sig = order.map((t) => t.id).join('|') + '#' + g.round;
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.innerHTML = order.map((t) => laneShell(t, g)).join('');
    S.laneN = {};
  }

  // Live targets are per-branch, not per-train.
  const live = new Set();
  if (S.sel) for (const m of g.moves) if (m.tile === S.sel) live.add(m.train + ':' + m.seg);

  for (const train of order) {
    const el = wrap.querySelector(`[data-train="${cssEsc(train.id)}"]`);
    if (!el) continue;
    const owner = train.owner ? g.players.find((p) => p.id === train.owner) : null;
    // Brightness follows access: what you can play on is bright, what's shut to
    // you recedes. Independent of whose turn it is, so it doesn't flicker.
    const mine = train.owner === S.pid;
    el.classList.toggle('turn', !!owner && g.turn === owner.id);
    el.classList.toggle('openTrain', !!train.open && !mine);
    el.classList.toggle('locked', !mine && !train.open);

    const head = el.querySelector('.lane-head');
    head.querySelector('.ct').textContent = owner ? `${owner.tiles}` : '';
    el.classList.toggle('lastone', !!owner && owner.tiles === 1);
    const hasMarker = !!head.querySelector('.marker');
    if (train.open && !hasMarker) {
      const idx = owner ? g.players.findIndex((p) => p.id === owner.id) : 0;
      head.insertAdjacentHTML('beforeend', owner
        ? markerHTML(SEATC[idx % SEATC.length], `${owner.name}'s marker is up — anyone may play here`) + '<span class="chip open">open</span>'
        : markerHTML('#34d399', 'The black train — always open to everyone'));
    }
    if (!train.open && hasMarker) { head.querySelector('.marker').remove(); head.querySelector('.chip.open')?.remove(); }

    paintBranches(el, train, g, live);
  }
}

function paintBranches(el, train, g, live) {
  const box = el.querySelector('.branches');
  const segs = orderSegs(train.segs);
  const structSig = segs.map((s) => s.id + '@' + s.depth).join(',');
  if (box.dataset.sig !== structSig) {
    box.dataset.sig = structSig;
    box.innerHTML = segs.map((s) => railShell(s, train, g)).join('');
    for (const s of segs) delete S.laneN[train.id + ':' + s.id];
  }

  // While any foot on this train is unfilled, none of its other branches may grow.
  const hasFoot = segs.some((s) => s.foot);

  for (const s of segs) {
    const rail = box.querySelector(`[data-seg="${s.id}"]`);
    if (!rail) continue;
    rail.classList.toggle('frozen', hasFoot && !s.foot && !s.closed);
    const key = train.id + ':' + s.id;
    const tiles = rail.querySelector('.tiles');
    const had = S.laneN[key] || 0;
    if (s.tiles.length < had) { tiles.innerHTML = ''; S.laneN[key] = 0; }
    for (let i = S.laneN[key] || 0; i < s.tiles.length; i++) tiles.insertAdjacentHTML('beforeend', laidHTML(s.tiles[i]));
    if (s.tiles.length !== had) {
      S.laneN[key] = s.tiles.length;
      requestAnimationFrame(() => { rail.scrollLeft = rail.scrollWidth; });
    }

    const hint = rail.querySelector('.empty-hint');
    if (hint) hint.style.display = s.tiles.length ? 'none' : '';

    // the uncovered double itself
    tiles.querySelectorAll('.tile.pend').forEach((n) => n.classList.remove('pend'));
    if (s.foot && tiles.lastElementChild) tiles.lastElementChild.classList.add('pend');

    const isLive = live.has(key);
    rail.classList.toggle('live', isLive);
    rail.classList.toggle('closed', !!s.closed);
    // A forked branch can never be played on again — shrink it to a numeral-only
    // trail so live ends get the space. Click it to open it back up.
    rail.classList.toggle('trail', !!s.closed && !S.expanded.has(key));

    const slot = rail.querySelector('.slot');
    slot.hidden = !!s.closed;
    if (!s.closed) {
      slot.classList.toggle('foot', !!s.foot);
      slot.innerHTML = `${s.end}${s.foot ? `<span class="need">${s.foot.placed}/${s.foot.need}</span>` : ''}`;
      slot.title = s.foot
        ? `${s.foot.need - s.foot.placed} more ${s.foot.value}${s.foot.need - s.foot.placed === 1 ? '' : 's'} to fill this foot — the rest of this train is frozen until then`
        : rail.classList.contains('frozen') ? 'Frozen until this train\'s foot is filled' : `Open end — needs a ${s.end}`;
    }
    if (isLive) requestAnimationFrame(() => rail.scrollIntoView({ block: 'nearest' }));
  }
}

function laneShell(train, g) {
  const owner = train.owner ? g.players.find((p) => p.id === train.owner) : null;
  const idx = owner ? g.players.findIndex((p) => p.id === owner.id) : 0;
  const mine = train.owner === S.pid;
  const name = owner ? (mine ? 'Your train' : owner.name) : 'Mexican Train';
  return `<div class="lane ${mine ? 'mine' : ''} ${train.owner === null ? 'mexican' : ''}" data-train="${esc(train.id)}">
    <div class="lane-head">
      ${owner ? avatar(owner.name, idx) : '<div class="avatar" style="background:#34d399">M</div>'}
      <span class="nm">${esc(name)}</span><span class="ct"></span>
    </div>
    <div class="branches"></div>
  </div>`;
}

function railShell(s, train, g) {
  const mine = train.owner === S.pid;
  const cap = s.parent === null
    ? `<div class="hub-cap" title="engine">${g.engine}</div>`
    : `<div class="branch-cap" title="branches off the double ${s.from}">${s.from}</div>`;
  const hint = train.owner === null ? 'not started — anyone may open it' : mine ? 'start your train here' : 'not started';
  return `<div class="rail" data-seg="${s.id}" style="--depth:${s.depth}">
    ${cap}
    <div class="tiles"></div>
    <span class="empty-hint">${hint}</span>
    <div class="slot"></div>
  </div>`;
}

// Your own arrangement of your hand, kept client-side. New tiles land on the
// end; tiles you've played drop out; everything else keeps the order you set.
function orderedHand(g) {
  const inHand = new Set(g.hand);
  const order = S.handOrder.filter((t) => inHand.has(t));
  const have = new Set(order);
  for (const t of g.hand) if (!have.has(t)) order.push(t);
  S.handOrder = order;
  return order;
}

function paintHand(g) {
  const el = $('#hand');
  if (S.room.spectating) {
    if (el.dataset.sig === 'watching') return;
    el.dataset.sig = 'watching';
    el.innerHTML = `<div class="hand-empty">You're watching this table — hands stay hidden. Say hello in the chat.</div>`;
    return;
  }
  if (S.dragging) return;                       // don't yank tiles out from under a drag
  const hand = orderedHand(g);
  const playable = new Set(g.moves.map((m) => m.tile));
  const yours = g.turn === S.pid && g.phase === 'play'; // don't grey the hand out while hunting the engine
  const mustLay = g.prompt === 'engine' ? `${g.engine}-${g.engine}` : null;
  const flips = hand.filter((t) => S.flipped.has(t)).join(',');
  const sig = hand.join(',') + '|' + (yours ? [...playable].sort().join(',') : '-') + '|' + S.sel + '|' + S.arrange + '|' + flips + '|' + mustLay;
  if (el.dataset.sig === sig) return;
  const prev = new Set([...el.querySelectorAll('.tile')].map((n) => n.dataset.tile));
  el.dataset.sig = sig;
  el.classList.toggle('arranging', S.arrange);
  el.innerHTML = hand.length
    ? hand.map((t) => tileHTML(t, 'p', [
        (mustLay ? t !== mustLay : yours && !playable.has(t)) && !S.arrange ? 'dead' : '',
        mustLay && t === mustLay ? 'sel' : '',
        S.sel === t ? 'sel' : '',
        prev.size && !prev.has(t) ? 'fresh' : '',
      ].join(' '), S.flipped.has(t))).join('')
    : '<div class="hand-empty">Your hand is empty.</div>';
}

// Reordering is a display preference, so it works on anyone's turn. An explicit
// arrange mode keeps dragging from fighting the hand's own scrolling on touch.
function initHandTools() {
  const hand = $('#hand');
  let drag = null;

  hand.addEventListener('pointerdown', (e) => {
    if (!S.arrange) return;
    const el = e.target.closest('.tile'); if (!el) return;
    e.preventDefault();
    drag = { el, x: e.clientX, moved: false };
    S.dragging = true;
    hand.setPointerCapture(e.pointerId);        // survives the tiles being re-ordered
  });

  hand.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // A short press is a tap (turn the tile around); past the threshold it's a drag.
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x) < 6) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
    }
    // Move the node itself rather than repainting — smoother, and it keeps the
    // element reference alive for the rest of the gesture.
    for (const t of hand.querySelectorAll('.tile')) {
      if (t === drag.el) continue;
      const r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) continue;
      const before = e.clientX < r.left + r.width / 2;
      hand.insertBefore(drag.el, before ? t : t.nextSibling);
      break;
    }
  });

  const endDrag = (e) => {
    if (!drag) return;
    try { hand.releasePointerCapture(e.pointerId); } catch {}
    const { el, moved } = drag;
    drag = null; S.dragging = false;

    if (moved) {
      el.classList.remove('dragging');
      S.handOrder = [...hand.querySelectorAll('.tile')].map((t) => t.dataset.tile);
    } else {
      // A tap turns the tile around: 7|9 becomes 9|7 so a planned run reads
      // left to right. Handled here rather than on `click`, because the
      // preventDefault() above suppresses the compatibility click event.
      const tile = el.dataset.tile;
      S.flipped.has(tile) ? S.flipped.delete(tile) : S.flipped.add(tile);
    }
    hand.dataset.sig = '';                      // let the next paint through
    paintHand(S.room.game);
    Snd.tap();
  };
  hand.addEventListener('pointerup', endDrag);
  hand.addEventListener('pointercancel', endDrag);
}

function paintTurnbar(g) {
  const bar = $('#turnbar');
  const yours = g.turn === S.pid;
  const who = g.players.find((p) => p.id === g.turn);
  const myTrain = g.trains.find((t) => t.owner === S.pid);
  let cls = '', msg = '', actions = '';

  if (g.status !== 'playing') {
    msg = g.status === 'gameOver' ? 'Game over' : 'Round over';
    actions = `<button class="btn sm" data-act="scores">See scores</button>`;
  } else if (yours) {
    cls = 'you';
    if (g.prompt === 'engine') {
      msg = `<span>You have the double ${g.engine} — lay it to start the round</span>`;
      actions = `<button class="btn primary sm" data-act="engine">Lay the double ${g.engine}</button>`;
    } else if (g.prompt === 'seek') {
      msg = `<span>No double ${g.engine} in your hand — draw until it turns up</span>`;
      actions = `<button class="btn primary sm" data-act="draw">Draw a tile</button>`;
    } else if (g.prompt === 'play') {
      msg = S.sel ? '<span>Now tap a glowing branch</span>' : '<span>Your turn — tap a tile</span>';
    } else if (g.prompt === 'draw') {
      msg = '<span>No play — draw from the boneyard</span>';
      actions = `<button class="btn primary sm" data-act="draw">Draw a tile</button>`;
    } else {
      msg = '<span>Nothing playable and the boneyard is empty</span>';
      actions = `<button class="btn primary sm" data-act="pass">End turn &amp; mark</button>`;
    }
  } else {
    const what = g.phase === 'seeking' ? `is drawing for the double ${g.engine}…` : 'is thinking…';
    msg = `${S.room.spectating ? '<span class="chip">watching</span>' : '<span class="spinner"></span>'}<span>${esc(who ? who.name : '…')} ${what}</span>`;
  }

  // Markers are fully manual: raise or lower yours at any point in your turn.
  const marker = yours && g.status === 'playing' && g.phase === 'play' && myTrain
    ? `<button class="btn sm marker-btn ${myTrain.open ? 'up' : ''}" data-act="marker" data-up="${myTrain.open ? 0 : 1}"
         title="${myTrain.open ? 'Close your train again' : 'Open your train to everyone'}"><span class="pip"></span>${myTrain.open ? 'Marker down' : 'Marker up'}</button>`
    : '';

  // Arrange mode changes what a tap does, so it has to own the message —
  // otherwise "tap a tile" is a lie while tapping turns tiles around.
  if (S.arrange && !S.room.spectating) {
    cls = 'arranging';
    msg = yours
      ? '<span>Arranging — done? tap <b>⇄ Arrange</b> to play</span>'
      : '<span>Arranging your hand</span>';
  }

  bar.className = `turnbar ${cls}`;
  bar.innerHTML = `<div class="msg">${msg}</div>${S.arrange ? '' : marker + actions}`;
  bar.onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'draw') send({ t: 'draw' });
    if (b.dataset.act === 'engine') { Snd.clack(); send({ t: 'engine' }); }
    if (b.dataset.act === 'pass') send({ t: 'pass' });
    if (b.dataset.act === 'marker') { Snd.tap(); send({ t: 'marker', up: b.dataset.up === '1' }); }
    if (b.dataset.act === 'scores') showEndModal(g);
  };
}

function paintPanel() {
  const r = S.room, g = r.game;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#chatForm').hidden = S.tab !== 'chat';
  const body = $('#pbody');

  if (S.tab === 'scores') {
    const ranked = [...g.players].sort((a, b) => a.score - b.score);
    body.innerHTML = ranked.map((p) => {
      const i = g.players.findIndex((x) => x.id === p.id);
      const seat = r.seats.find((s) => s.id === p.id);
      return `<div class="score-row">
        ${avatar(p.name, i)}
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(p.name)}${p.id === S.pid ? ' (you)' : ''} ${p.bot ? '<span class="chip">bot</span>' : ''}</div>
          <div class="sub">${p.tiles === 1 ? '<span class="lastcall">last tile!</span>' : `${p.tiles} tiles in hand`}</div>
        </div>
        <span class="dotstat ${seat && seat.connected ? 'on' : ''}" title="${seat && seat.connected ? 'connected' : 'away'}"></span>
        <span class="sc">${p.score}</span>
      </div>`;
    }).join('')
      + (r.watchers.length ? `<div class="label" style="margin-top:16px">Watching · ${r.watchers.length}</div>
        <div class="watchers">${r.watchers.map((w) => `<span class="chip ${w.id === S.pid ? 'gold' : ''}">${esc(w.name)}${w.id === S.pid ? ' (you)' : ''}</span>`).join('')}</div>` : '')
      + `<button class="btn sm" id="fullsb" style="width:100%;margin-top:14px">Full scoreboard</button>`
      + `<p class="foot-note" style="text-align:left">Lowest total wins. You score the pips left in your hand at the end of each round${g.scoring === 'house' ? ', and 50 for the double blank' : g.scoring === 'official' ? ', with blanks at 25 and the 0|0 at 50' : ''}.</p>`;
    const sb = $('#fullsb', body);
    if (sb) sb.onclick = () => openModal(`<div class="card wide"><h2>Scoreboard</h2>
      <p class="sub">Round ${g.round} of ${g.totalRounds} · lowest total wins.</p>
      ${scoreboardHTML(g)}
      <div class="stack" style="margin-top:22px"><button class="btn" data-close>Close</button></div></div>`);
  } else if (S.tab === 'log') {
    body.innerHTML = `<div class="log">${[...g.log].reverse().map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('')}</div>`;
  } else {
    body.innerHTML = `<div class="chat-list">${r.chat.map((c) => c.system
      ? `<div class="sys">${esc(c.text)}</div>`
      : `<div class="msg"><b>${esc(c.from)}</b>${esc(c.text)}</div>`).join('')}</div>`;
    body.scrollTop = body.scrollHeight;
  }
}

// ---------------------------------------------------------------- interaction
function onHandClick(e) {
  const el = e.target.closest('.tile'); if (!el) return;
  if (S.arrange) return;      // arrange mode is driven by pointer events, not clicks
  const g = S.room.game;
  if (g.turn !== S.pid) return toast("It isn't your turn yet.");
  if (g.phase === 'seeking') {
    if (g.prompt === 'engine' && el.dataset.tile === `${g.engine}-${g.engine}`) {
      Snd.clack();
      return send({ t: 'engine' });
    }
    return toast(`The double ${g.engine} has to come out first.`);
  }
  const tile = el.dataset.tile;
  const targets = g.moves.filter((m) => m.tile === tile);
  if (!targets.length) return toast('That tile has nowhere to go.');
  // Tapping an already-selected tile with one legal home just plays it.
  if (S.sel === tile && targets.length === 1) return play(tile, targets[0].train, targets[0].seg);
  S.sel = S.sel === tile ? null : tile;
  paintHand(g); paintLanes(g); paintTurnbar(g);
}

function onLaneClick(e) {
  const rail = e.target.closest('.rail'); if (!rail) return;
  if (rail.classList.contains('closed')) {           // spent branch — expand/collapse it
    const key = rail.closest('.lane').dataset.train + ':' + rail.dataset.seg;
    S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key);
    Snd.tap();
    return paintLanes(S.room.game);
  }
  if (!rail.classList.contains('live')) return;
  play(S.sel, rail.closest('.lane').dataset.train, Number(rail.dataset.seg));
}

function play(tile, train, seg) {
  Snd.clack();
  send({ t: 'play', tile, train, seg });
  S.sel = null;
}

// ---------------------------------------------------------------- modals
function closeModal() { modalEl.hidden = true; modalEl.innerHTML = ''; }
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openModal(html, wire) {
  modalEl.innerHTML = html; modalEl.hidden = false;
  modalEl.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
  if (wire) wire();
}

function showRules() {
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
        foot > 1 ? `<div><b>Pigeon foot</b>A double takes <b>${foot} tiles</b>, and until all ${foot} are down <em>that train is frozen</em> — none of its branches can grow, not even ones that already forked. Every other train carries on as normal, and you are never forced to feed a foot instead of playing elsewhere. Once it's full the branch forks into <b>${foot} live ends</b>.</div>` : ''}
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
function scoreboardHTML(g) {
  const played = Math.max(...g.players.map((p) => p.roundScores.length), 0);
  const best = Math.min(...g.players.map((p) => p.score));
  if (!played) return '<p class="foot-note" style="text-align:left">No rounds finished yet.</p>';
  return `<div class="sb-wrap"><table class="scoreboard">
    <thead><tr><th class="rd">Round</th>${g.players.map((p) =>
      `<th class="${p.id === S.pid ? 'me' : ''}" title="${esc(p.name)}">${esc(p.name)}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: played }, (_, i) => {
      const low = Math.min(...g.players.map((p) => p.roundScores[i] ?? Infinity));
      return `<tr><th class="rd">${i + 1}<small>d${g.max - i}</small></th>${g.players.map((p) => {
        const v = p.roundScores[i];
        return `<td class="${v === 0 ? 'out' : v === low ? 'good' : ''}">${v ?? '—'}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody>
    <tfoot><tr><th class="rd">Total</th>${g.players.map((p) =>
      `<td class="${p.score === best ? 'lead' : ''}">${p.score}</td>`).join('')}</tr></tfoot>
  </table></div>`;
}

function showEndModal(g) {
  const done = g.status === 'gameOver';
  const ranked = [...g.players].sort((a, b) => a.score - b.score);
  const isHost = S.room.hostId === S.pid;
  const winner = done ? ranked[0] : g.players.find((p) => p.id === g.roundWinner);
  const last = (p) => p.roundScores[p.roundScores.length - 1] ?? 0;
  openModal(`<div class="card wide">
    <h2>${done ? `${esc(winner.name)} wins` : winner ? `${esc(winner.name)} went out` : 'Everyone blocked'}</h2>
    <p class="sub">${done ? `Final standings after ${g.totalRounds} rounds.` : `Round ${g.round} of ${g.totalRounds} · engine was the double ${g.engine}.`}</p>

    <div class="label">${done ? 'Final' : 'This round'}</div>
    <div class="stack" style="gap:0;margin-bottom:22px">
      ${ranked.map((p, i) => `<div class="score-row">
        <span class="rank">${i + 1}</span>
        ${avatar(p.name, g.players.findIndex((x) => x.id === p.id))}
        <span class="nm">${esc(p.name)}${p.id === S.pid ? ' (you)' : ''}${
          p.temper != null ? ` <span class="chip">${temperName(p.temper)}</span>` : ''}</span>
        ${!done ? `<span class="delta ${last(p) === 0 ? 'zero' : ''}">+${last(p)}</span>` : ''}
        <span class="sc">${p.score}</span>
      </div>`).join('')}
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

// ---------------------------------------------------------------- misc
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));
// Anything on screen while the socket is down is stale — say so, and keep saying it.
function paintConn() {
  let el = $('#connbar');
  if (S.connected) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'connbar'; el.className = 'connbar';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="spinner"></span><span>Reconnecting — what you see may be out of date</span>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b && b.dataset.go === 'home') go('/');
}, true);

// Registered once, not per rebuild — buildTable() runs many times a session.
document.addEventListener('click', () => {
  const pop = $('#displayPop');
  if (pop && !pop.hidden) pop.hidden = true;
});

// Browsers keep audio suspended until a real gesture — unlock on the first one.
addEventListener('pointerdown', () => Snd.ready(), { once: true });

applyPipMode();
applyZoom();
route();
