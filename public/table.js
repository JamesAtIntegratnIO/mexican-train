// The table itself: the chrome around the board, your hand, the turn bar and
// the side panel. The board proper lives in lanes.js.
//
// The shell is built once per phase change and then painted in place, so every
// paint function here is written to be safe to call on every snapshot.

import { $, app, esc, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML, avatar, applyZoom, applyPipMode, currentTw, PIP_FLOOR } from './tiles.js';
import { send } from './net.js';
import { paintLanes, onLaneClick } from './lanes.js';
import { showRules, showEndModal, showScoreboard } from './modals.js';
import { playTile } from './actions.js';

export function renderTable() {
  if (!S.built) buildTable();
  const g = S.room.game;

  $('#engine').innerHTML = `${g.engineDown ? tileHTML(`${g.engine}-${g.engine}`, 'p mini') : '<div class="tile p mini facedown">?</div>'}
    <div class="meta"><b>Round ${g.round} / ${g.totalRounds}</b>${g.engineDown ? `engine · double ${g.engine}` : `hunting the double ${g.engine}`}</div>`;
  $('#bone').innerHTML = `Boneyard <b>${g.boneyard}</b>`;
  $('#togglePanel').textContent = S.unread ? '☰•' : '☰';
  if (window.matchMedia('(min-width:900px)').matches) S.panel = true;

  paintLanes(g);
  paintHand(g);
  paintTurnbar(g);
  paintPanel();
}

// ---------------------------------------------------------------- the shell

function buildTable() {
  app.innerHTML = shellHTML();
  wireDisplayPop();
  wireControls();
  wireHandTools();
  S.laneN = {};
  S.built = true;
}

function shellHTML() {
  return `<div class="table-view">
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
}

// Tile size and pips-vs-numerals. Both are display preferences kept in this
// browser and never sent anywhere.
function wireDisplayPop() {
  const pop = $('#displayPop'), zoomEl = $('#zoom');
  const sync = () => {
    zoomEl.value = S.zoom || Math.round(currentTw());
    document.querySelectorAll('#markpick button').forEach((b) => b.classList.toggle('on', (b.dataset.pips === '1') === S.pipMode));
    $('#pipnote').textContent = currentTw() < PIP_FLOOR
      ? 'Tiles are too small for pips right now, so numbers are being used.'
      : `Pips switch to numbers automatically below ${PIP_FLOOR}px.`;
  };
  const setZoom = (v) => {
    S.zoom = Math.min(76, Math.max(24, v));
    localStorage.setItem('mt.zoom', String(S.zoom));
    applyZoom(); sync();
  };

  $('#display').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) sync(); };
  pop.onclick = (e) => {
    e.stopPropagation();
    const z = e.target.closest('[data-zoom]');
    if (z) { setZoom((S.zoom || Math.round(currentTw())) + Number(z.dataset.zoom) * 4); Snd.tap(); }
    const m = e.target.closest('[data-pips]');
    if (m) {
      S.pipMode = m.dataset.pips === '1';
      localStorage.setItem('mt.pips', S.pipMode ? '1' : '0');
      applyPipMode(); sync(); Snd.tap();
    }
  };
  zoomEl.oninput = (e) => setZoom(Number(e.target.value));
  sync();
}

function wireControls() {
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
}

function wireHandTools() {
  initHandDrag();
  const repaint = () => { $('#hand').dataset.sig = ''; paintHand(S.room.game); paintTurnbar(S.room.game); };
  $('#arrange').onclick = (e) => {
    S.arrange = !S.arrange;
    e.currentTarget.classList.toggle('on', S.arrange);
    $('#arrangehint').hidden = !S.arrange;
    S.sel = null; Snd.tap();
    repaint(); paintLanes(S.room.game);
  };
  $('#resort').onclick = () => { S.handOrder = []; S.flipped.clear(); Snd.tap(); repaint(); };
}

export function setPanel(open) {
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

// ---------------------------------------------------------------- your hand

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

export function paintHand(g) {
  const el = $('#hand');
  if (S.room.spectating) {
    if (el.dataset.sig === 'watching') return;
    el.dataset.sig = 'watching';
    el.innerHTML = '<div class="hand-empty">You\'re watching this table — hands stay hidden. Say hello in the chat.</div>';
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
    ? hand.map((t) => tileHTML(t, 'p', handTileClasses(t, { mustLay, yours, playable, prev }), S.flipped.has(t))).join('')
    : '<div class="hand-empty">Your hand is empty.</div>';
}

function handTileClasses(t, { mustLay, yours, playable, prev }) {
  return [
    (mustLay ? t !== mustLay : yours && !playable.has(t)) && !S.arrange ? 'dead' : '',
    mustLay && t === mustLay ? 'sel' : '',
    S.sel === t ? 'sel' : '',
    prev.size && !prev.has(t) ? 'fresh' : '',
  ].join(' ');
}

// Reordering is a display preference, so it works on anyone's turn. An explicit
// arrange mode keeps dragging from fighting the hand's own scrolling on touch.
function initHandDrag() {
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
    slideInto(hand, drag.el, e.clientX);
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

// Move the node itself rather than repainting — smoother, and it keeps the
// element reference alive for the rest of the gesture.
function slideInto(hand, el, x) {
  for (const t of hand.querySelectorAll('.tile')) {
    if (t === el) continue;
    const r = t.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    hand.insertBefore(el, x < r.left + r.width / 2 ? t : t.nextSibling);
    return;
  }
}

// ---------------------------------------------------------------- turn bar

export function paintTurnbar(g) {
  const bar = $('#turnbar');
  const yours = g.turn === S.pid;
  const myTrain = g.trains.find((t) => t.owner === S.pid);
  const { cls, msg, actions } = turnState(g, yours);

  // Markers are fully manual: raise or lower yours at any point in your turn.
  const marker = yours && g.status === 'playing' && g.phase === 'play' && myTrain ? markerButton(myTrain) : '';

  bar.className = `turnbar ${cls}`;
  bar.innerHTML = `<div class="msg">${msg}</div>${S.arrange ? '' : marker + actions}`;
  bar.onclick = (e) => onTurnbarClick(e, g);
}

function turnState(g, yours) {
  // Arrange mode changes what a tap does, so it has to own the message —
  // otherwise "tap a tile" is a lie while tapping turns tiles around.
  if (S.arrange && !S.room.spectating) {
    return {
      cls: 'arranging', actions: '',
      msg: yours ? '<span>Arranging — done? tap <b>⇄ Arrange</b> to play</span>' : '<span>Arranging your hand</span>',
    };
  }
  if (g.status !== 'playing') {
    return {
      cls: '',
      msg: g.status === 'gameOver' ? 'Game over' : 'Round over',
      actions: '<button class="btn sm" data-act="scores">See scores</button>',
    };
  }
  if (yours) return { cls: 'you', ...yourPrompt(g) };
  return { cls: '', actions: '', msg: waitingFor(g) };
}

// What the server says you owe the table, and the button for it.
function yourPrompt(g) {
  if (g.prompt === 'engine') {
    return {
      msg: `<span>You have the double ${g.engine} — lay it to start the round</span>`,
      actions: `<button class="btn primary sm" data-act="engine">Lay the double ${g.engine}</button>`,
    };
  }
  if (g.prompt === 'seek') {
    return {
      msg: `<span>No double ${g.engine} in your hand — draw until it turns up</span>`,
      actions: '<button class="btn primary sm" data-act="draw">Draw a tile</button>',
    };
  }
  if (g.prompt === 'play') {
    return { msg: S.sel ? '<span>Now tap a glowing branch</span>' : '<span>Your turn — tap a tile</span>', actions: '' };
  }
  if (g.prompt === 'draw') {
    return {
      msg: '<span>No play — draw from the boneyard</span>',
      actions: '<button class="btn primary sm" data-act="draw">Draw a tile</button>',
    };
  }
  return {
    msg: '<span>Nothing playable and the boneyard is empty</span>',
    actions: '<button class="btn primary sm" data-act="pass">End turn &amp; mark</button>',
  };
}

function waitingFor(g) {
  const who = g.players.find((p) => p.id === g.turn);
  const what = g.phase === 'seeking' ? `is drawing for the double ${g.engine}…` : 'is thinking…';
  return `${S.room.spectating ? '<span class="chip">watching</span>' : '<span class="spinner"></span>'}<span>${esc(who ? who.name : '…')} ${what}</span>`;
}

const markerButton = (t) => `<button class="btn sm marker-btn ${t.open ? 'up' : ''}" data-act="marker" data-up="${t.open ? 0 : 1}"
     title="${t.open ? 'Close your train again' : 'Open your train to everyone'}"><span class="pip"></span>${t.open ? 'Marker down' : 'Marker up'}</button>`;

function onTurnbarClick(e, g) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'draw') send({ t: 'draw' });
  if (act === 'engine') { Snd.clack(); send({ t: 'engine' }); }
  if (act === 'pass') send({ t: 'pass' });
  if (act === 'marker') { Snd.tap(); send({ t: 'marker', up: b.dataset.up === '1' }); }
  if (act === 'scores') showEndModal(g);
}

// ---------------------------------------------------------------- side panel

export function paintPanel() {
  const r = S.room, g = r.game;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#chatForm').hidden = S.tab !== 'chat';
  const body = $('#pbody');

  if (S.tab === 'scores') {
    body.innerHTML = scoresHTML(r, g);
    const sb = $('#fullsb', body);
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

const chatLine = (c) => (c.system
  ? `<div class="sys">${esc(c.text)}</div>`
  : `<div class="msg"><b>${esc(c.from)}</b>${esc(c.text)}</div>`);

function scoresHTML(r, g) {
  const ranked = [...g.players].sort((a, b) => a.score - b.score);
  const blanks = g.scoring === 'house' ? ', and 50 for the double blank'
    : g.scoring === 'official' ? ', with blanks at 25 and the 0|0 at 50' : '';
  return ranked.map((p) => scoreRow(p, r, g)).join('')
    + watchersHTML(r)
    + '<button class="btn sm" id="fullsb" style="width:100%;margin-top:14px">Full scoreboard</button>'
    + `<p class="foot-note" style="text-align:left">Lowest total wins. You score the pips left in your hand at the end of each round${blanks}.</p>`;
}

function scoreRow(p, r, g) {
  const i = g.players.findIndex((x) => x.id === p.id);
  const seat = r.seats.find((s) => s.id === p.id);
  const here = !!(seat && seat.connected);
  return `<div class="score-row">
    ${avatar(p.name, i)}
    <div style="flex:1;min-width:0">
      <div class="nm">${esc(p.name)}${p.id === S.pid ? ' (you)' : ''} ${p.bot ? '<span class="chip">bot</span>' : ''}</div>
      <div class="sub">${p.tiles === 1 ? '<span class="lastcall">last tile!</span>' : `${p.tiles} tiles in hand`}</div>
    </div>
    <span class="dotstat ${here ? 'on' : ''}" title="${here ? 'connected' : 'away'}"></span>
    <span class="sc">${p.score}</span>
  </div>`;
}

const watchersHTML = (r) => (r.watchers.length
  ? `<div class="label" style="margin-top:16px">Watching · ${r.watchers.length}</div>
     <div class="watchers">${r.watchers.map((w) => `<span class="chip ${w.id === S.pid ? 'gold' : ''}">${esc(w.name)}${w.id === S.pid ? ' (you)' : ''}</span>`).join('')}</div>`
  : '');

// ---------------------------------------------------------------- interaction

function onHandClick(e) {
  const el = e.target.closest('.tile'); if (!el) return;
  if (S.arrange) return;      // arrange mode is driven by pointer events, not clicks
  const g = S.room.game;
  if (g.turn !== S.pid) return toast("It isn't your turn yet.");
  if (g.phase === 'seeking') return engineClick(g, el);

  const tile = el.dataset.tile;
  const targets = g.moves.filter((m) => m.tile === tile);
  if (!targets.length) return toast('That tile has nowhere to go.');
  // Tapping an already-selected tile with one legal home just plays it.
  if (S.sel === tile && targets.length === 1) return playTile(tile, targets[0].train, targets[0].seg);
  S.sel = S.sel === tile ? null : tile;
  paintHand(g); paintLanes(g); paintTurnbar(g);
}

// While the engine is still being hunted, the only tile that does anything is
// the engine itself.
function engineClick(g, el) {
  if (g.prompt === 'engine' && el.dataset.tile === `${g.engine}-${g.engine}`) {
    Snd.clack();
    return send({ t: 'engine' });
  }
  return toast(`The double ${g.engine} has to come out first.`);
}
