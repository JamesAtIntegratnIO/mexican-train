// The Mexican Train board: one lane per train, and inside each lane one rail
// per branch. The rail itself — how a branch is drawn and kept up to date — is
// rails.ts, which the Chicken Foot board is built out of too.

import { $, cssEsc, esc } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { SEATC, markerHTML, avatar } from './tiles.js';
import { playTile } from './actions.js';
import { orderSegs, paintRail, railShell } from './rails.js';
import type { PlacedSeg } from './rails.js';
import type { GameView, TrainView } from '../shared/protocol.js';

/** Every train here belongs to somebody, so this is what a freeze holds up. */
const WHOLE = 'this train';

// Yours first, then the communal train, then everyone else in seat order.
function laneOrder(g: GameView): TrainView[] {
  const mine = g.trains.find((t) => t.owner === S.pid);
  const mex = g.trains.find((t) => t.owner === null);
  const rest = g.trains.filter((t) => t !== mine && t !== mex);
  return [mine, mex, ...rest].filter((t): t is TrainView => Boolean(t));
}

export function paintLanes(g: GameView): void {
  const wrap = $<HTMLElement>('#lanes');
  const order = laneOrder(g);
  const sig = order.map((t) => t.id).join('|') + '#' + g.round;
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.innerHTML = order.map((t) => laneShell(t, g)).join('');
    S.laneN = {};
  }

  // Live targets are per-branch, not per-train.
  const live = new Set<string>();
  if (S.sel) for (const m of g.moves) if (m.tile === S.sel) live.add(m.train + ':' + m.seg);

  for (const train of order) {
    const el = wrap.querySelector(`[data-train="${cssEsc(train.id)}"]`);
    if (el) paintLane(el, train, g, live);
  }
}

function paintLane(el: Element, train: TrainView, g: GameView, live: Set<string>): void {
  const owner = train.owner ? g.players.find((p) => p.id === train.owner) ?? null : null;
  // Brightness follows access: what you can play on is bright, what's shut to
  // you recedes. Independent of whose turn it is, so it doesn't flicker.
  const mine = train.owner === S.pid;
  el.classList.toggle('turn', !!owner && g.turn === owner.id);
  el.classList.toggle('openTrain', !!train.open && !mine);
  el.classList.toggle('locked', !mine && !train.open);
  el.classList.toggle('lastone', !!owner && owner.tiles === 1);

  const head = el.querySelector('.lane-head')!;
  head.querySelector('.ct')!.textContent = owner ? `${owner.tiles}` : '';
  paintMarker(head, train, owner, g);

  paintBranches(el, train, g, live);
}

// The little locomotive goes up and comes down; everything else about the head
// is already in place from the shell.
function paintMarker(head: Element, train: TrainView, owner: GameView['players'][number] | null, g: GameView): void {
  const hasMarker = !!head.querySelector('.marker');
  if (train.open && !hasMarker) {
    const idx = owner ? g.players.findIndex((p) => p.id === owner.id) : 0;
    head.insertAdjacentHTML('beforeend', owner
      ? markerHTML(SEATC[idx % SEATC.length], `${owner.name}'s marker is up — anyone may play here`) + '<span class="chip open">open</span>'
      : markerHTML('#34d399', 'The black train — always open to everyone'));
  }
  if (!train.open && hasMarker) {
    head.querySelector('.marker')!.remove();
    head.querySelector('.chip.open')?.remove();
  }
}

function paintBranches(el: Element, train: TrainView, g: GameView, live: Set<string>): void {
  const box = el.querySelector('.branches') as HTMLElement;
  const segs = orderSegs(train.segs);
  const structSig = segs.map((s) => s.id + '@' + s.depth).join(',');
  if (box.dataset.sig !== structSig) {
    box.dataset.sig = structSig;
    box.innerHTML = segs.map((s) => laneRail(s, train, g)).join('');
    for (const s of segs) delete S.laneN[train.id + ':' + s.id];
  }

  // An unfilled foot freezes the whole train, so every branch but the one owing
  // toes is shut — the rails say so rather than looking like ordinary open ends.
  const frozen = segs.find((s) => s.foot)?.foot ?? null;

  for (const s of segs) {
    const rail = box.querySelector<HTMLElement>(`[data-seg="${s.id}"]`);
    const key = train.id + ':' + s.id;
    if (rail) paintRail(rail, s, key, live.has(key), frozen, WHOLE);
  }
}

function laneShell(train: TrainView, g: GameView): string {
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

function laneRail(s: PlacedSeg, train: TrainView, g: GameView): string {
  const hint = train.owner === null ? 'not started — anyone may open it'
    : train.owner === S.pid ? 'start your train here' : 'not started';
  return railShell(s, g.engine, hint);
}

export function onLaneClick(e: Event): void {
  const rail = (e.target as Element).closest('.rail'); if (!rail) return;
  if (rail.classList.contains('closed')) {           // spent branch — expand/collapse it
    const key = (rail.closest('.lane') as HTMLElement).dataset.train + ':' + (rail as HTMLElement).dataset.seg;
    S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key);
    Snd.tap();
    return paintLanes(S.room!.game!);
  }
  if (!rail.classList.contains('live')) return;
  playTile(S.sel!, (rail.closest('.lane') as HTMLElement).dataset.train!, Number((rail as HTMLElement).dataset.seg));
}
