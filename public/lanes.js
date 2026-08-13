// The board: one lane per train, and inside each lane one rail per branch.
//
// Painting is incremental on purpose. Tiles are appended rather than rebuilt,
// because throwing a branch away and redrawing it restarts its scroll position
// and loses the entry animation on the tile that was just laid — which is the
// one thing on screen the player is actually watching for.

import { $, cssEsc, esc } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { SEATC, laidHTML, markerHTML, avatar } from './tiles.js';
import { playTile } from './actions.js';

// Yours first, then the communal train, then everyone else in seat order.
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

export function paintLanes(g) {
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
    if (el) paintLane(el, train, g, live);
  }
}

function paintLane(el, train, g, live) {
  const owner = train.owner ? g.players.find((p) => p.id === train.owner) : null;
  // Brightness follows access: what you can play on is bright, what's shut to
  // you recedes. Independent of whose turn it is, so it doesn't flicker.
  const mine = train.owner === S.pid;
  el.classList.toggle('turn', !!owner && g.turn === owner.id);
  el.classList.toggle('openTrain', !!train.open && !mine);
  el.classList.toggle('locked', !mine && !train.open);
  el.classList.toggle('lastone', !!owner && owner.tiles === 1);

  const head = el.querySelector('.lane-head');
  head.querySelector('.ct').textContent = owner ? `${owner.tiles}` : '';
  paintMarker(head, train, owner, g);

  paintBranches(el, train, g, live);
}

// The little locomotive goes up and comes down; everything else about the head
// is already in place from the shell.
function paintMarker(head, train, owner, g) {
  const hasMarker = !!head.querySelector('.marker');
  if (train.open && !hasMarker) {
    const idx = owner ? g.players.findIndex((p) => p.id === owner.id) : 0;
    head.insertAdjacentHTML('beforeend', owner
      ? markerHTML(SEATC[idx % SEATC.length], `${owner.name}'s marker is up — anyone may play here`) + '<span class="chip open">open</span>'
      : markerHTML('#34d399', 'The black train — always open to everyone'));
  }
  if (!train.open && hasMarker) {
    head.querySelector('.marker').remove();
    head.querySelector('.chip.open')?.remove();
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

  for (const s of segs) {
    const rail = box.querySelector(`[data-seg="${s.id}"]`);
    const key = train.id + ':' + s.id;
    if (rail) paintRail(rail, s, key, live.has(key));
  }
}

function paintRail(rail, s, key, isLive) {
  const tiles = rail.querySelector('.tiles');
  appendTiles(tiles, rail, s, key);

  const hint = rail.querySelector('.empty-hint');
  if (hint) hint.style.display = s.tiles.length ? 'none' : '';

  // the uncovered double itself
  tiles.querySelectorAll('.tile.pend').forEach((n) => n.classList.remove('pend'));
  if (s.foot && tiles.lastElementChild) tiles.lastElementChild.classList.add('pend');

  rail.classList.toggle('live', isLive);
  rail.classList.toggle('closed', !!s.closed);
  // A forked branch can never be played on again — shrink it to a numeral-only
  // trail so live ends get the space. Click it to open it back up.
  rail.classList.toggle('trail', !!s.closed && !S.expanded.has(key));

  paintSlot(rail.querySelector('.slot'), s);
  if (isLive) requestAnimationFrame(() => rail.scrollIntoView({ block: 'nearest' }));
}

// Only the tiles that aren't drawn yet get drawn. A branch that somehow got
// shorter — a round reset, a snapshot arriving out of order — is the one case
// worth starting over for.
function appendTiles(tiles, rail, s, key) {
  const had = S.laneN[key] || 0;
  if (s.tiles.length < had) { tiles.innerHTML = ''; S.laneN[key] = 0; }
  for (let i = S.laneN[key] || 0; i < s.tiles.length; i++) tiles.insertAdjacentHTML('beforeend', laidHTML(s.tiles[i]));
  if (s.tiles.length !== had) {
    S.laneN[key] = s.tiles.length;
    requestAnimationFrame(() => { rail.scrollLeft = rail.scrollWidth; });
  }
}

// The open end of a branch, and what it is waiting for.
function paintSlot(slot, s) {
  slot.hidden = !!s.closed;
  if (s.closed) return;
  const owed = s.foot ? s.foot.need - s.foot.placed : 0;
  slot.classList.toggle('foot', !!s.foot);
  slot.innerHTML = `${s.end}${s.foot ? `<span class="need">${s.foot.placed}/${s.foot.need}</span>` : ''}`;
  // A foot binds its own branch and nothing else, so the other branches of this
  // train describe themselves as the ordinary open ends they are.
  slot.title = s.foot
    ? `${owed} more ${s.foot.value}${owed === 1 ? '' : 's'} to fill this foot — this branch takes nothing else until then`
    : `Open end — needs a ${s.end}`;
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

export function onLaneClick(e) {
  const rail = e.target.closest('.rail'); if (!rail) return;
  if (rail.classList.contains('closed')) {           // spent branch — expand/collapse it
    const key = rail.closest('.lane').dataset.train + ':' + rail.dataset.seg;
    S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key);
    Snd.tap();
    return paintLanes(S.room.game);
  }
  if (!rail.classList.contains('live')) return;
  playTile(S.sel, rail.closest('.lane').dataset.train, Number(rail.dataset.seg));
}
