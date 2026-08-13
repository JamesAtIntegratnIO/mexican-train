// The table shell: the chrome around the board, and the wiring that outlives a
// repaint. The board is lanes.ts, your hand is hand.ts, the bar above it is
// turnbar.ts and the side panel is panel.ts.
//
// The shell is built once per phase change and then painted in place, so every
// paint function is written to be safe to call on every snapshot.

import { $, app } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML, applyZoom, applyPipMode, currentTw, PIP_FLOOR } from './tiles.js';
import { send } from './net.js';
import { paintLanes, onLaneClick } from './lanes.js';
import { showRules } from './modals.js';
import { paintHand, wireHandTools } from './hand.js';
import { paintTurnbar } from './turnbar.js';
import { paintPanel } from './panel.js';

export function renderTable(): void {
  if (!S.built) buildTable();
  const g = S.room!.game!;

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

function buildTable(): void {
  app.innerHTML = shellHTML();
  wireDisplayPop();
  wireControls();
  wireHandTools();
  S.laneN = {};
  S.built = true;
}

function shellHTML(): string {
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
function wireDisplayPop(): void {
  const pop = $<HTMLElement>('#displayPop'), zoomEl = $<HTMLInputElement>('#zoom');
  const sync = () => {
    zoomEl.value = String(S.zoom || Math.round(currentTw()));
    document.querySelectorAll<HTMLElement>('#markpick button').forEach((b) => b.classList.toggle('on', (b.dataset.pips === '1') === S.pipMode));
    $('#pipnote').textContent = currentTw() < PIP_FLOOR
      ? 'Tiles are too small for pips right now, so numbers are being used.'
      : `Pips switch to numbers automatically below ${PIP_FLOOR}px.`;
  };
  const setZoom = (v: number) => {
    S.zoom = Math.min(76, Math.max(24, v));
    localStorage.setItem('mt.zoom', String(S.zoom));
    applyZoom(); sync();
  };

  $('#display').onclick = (e: Event) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) sync(); };
  pop.onclick = (e: Event) => {
    e.stopPropagation();
    const z = (e.target as Element).closest<HTMLElement>('[data-zoom]');
    if (z) { setZoom((S.zoom || Math.round(currentTw())) + Number(z.dataset.zoom) * 4); Snd.tap(); }
    const m = (e.target as Element).closest<HTMLElement>('[data-pips]');
    if (m) {
      S.pipMode = m.dataset.pips === '1';
      localStorage.setItem('mt.pips', S.pipMode ? '1' : '0');
      applyPipMode(); sync(); Snd.tap();
    }
  };
  zoomEl.oninput = (e: Event) => setZoom(Number((e.target as HTMLInputElement).value));
  sync();
}

function wireControls(): void {
  $('#mute').onclick = (e: Event) => {
    const on = Snd.toggle();
    (e.currentTarget as HTMLElement).textContent = on ? '🔊' : '🔇';
    if (on) Snd.turn();
  };
  $('#rules').onclick = showRules;
  $('#togglePanel').onclick = () => setPanel(!S.panel);
  $('#closePanel').onclick = () => setPanel(false);
  $('#tabs').onclick = (e: Event) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-tab]');
    if (b) { S.tab = b.dataset.tab as typeof S.tab; paintPanel(); }
  };
  $<HTMLFormElement>('#chatForm').onsubmit = (e: Event) => {
    e.preventDefault();
    const i = $<HTMLInputElement>('#chatInput');
    if (i.value.trim()) send({ t: 'chat', text: i.value });
    i.value = '';
  };
  $('#lanes').onclick = onLaneClick;
}

export function setPanel(open: boolean): void {
  S.panel = open;
  const p = $<HTMLElement>('#panel'); if (!p) return;
  p.classList.toggle('open', open);
  let scrim = $<HTMLElement>('.scrim');
  if (open) {
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.onclick = () => setPanel(false);
      document.body.appendChild(scrim);
    }
    S.unread = 0; paintPanel();
  } else if (scrim) scrim.remove();
  const t = $<HTMLElement>('#togglePanel'); if (t) t.textContent = S.unread ? '☰•' : '☰';
}
