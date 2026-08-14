// The Chicken Foot board: one hub and the branches that grew out of it.
//
// There is a single train and nobody owns it, so the lane head that Mexican
// Train uses to say whose train this is has nothing to say — what it was
// carrying, who is on turn and who is down to one tile, moves to the seat strip
// along the top, which is now the only place that information lives.
//
// A card is a fork family: a branch off the hub, plus every toe that grew off
// a double along it. Grouping them is the point — a foot and the toes filling
// it are one thing happening, and in a flat list of rails they are only ever
// adjacent by accident of tree order.

import { $, esc } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { avatar } from './tiles.js';
import { playTile } from './actions.js';
import { orderSegs, paintRail, railShell } from './rails.js';
import type { PlacedSeg } from './rails.js';
import type { GameView, PlayerView, FootView } from '../shared/protocol.js';

/** Nobody owns anything, so a freeze holds up everything. */
const WHOLE = 'the board';

/** A branch off the hub and everything that forked off it. */
interface Family {
  root: PlacedSeg;
  rest: PlacedSeg[];
}

// While the hub is still being ringed it is the only thing anyone can play on,
// so it gets a card of its own; once it is full it is spent, and the header
// carries it from then on.
function families(segs: PlacedSeg[]): Family[] {
  const hub = segs.find((s) => s.parent === null);
  if (!hub) return [];
  const fams = segs.filter((s) => s.parent === hub.id)
    .map((root) => ({ root, rest: descendants(segs, root.id) }));
  return hub.closed ? fams : [{ root: hub, rest: [] }, ...fams];
}

function descendants(segs: PlacedSeg[], id: number): PlacedSeg[] {
  const out: PlacedSeg[] = [];
  const walk = (parent: number): void => {
    for (const s of segs) if (s.parent === parent) { out.push(s); walk(s.id); }
  };
  walk(id);
  return out;
}

export function paintBoard(g: GameView): void {
  const wrap = $<HTMLElement>('#lanes');
  const board = g.trains[0];
  if (!board) return;
  const fams = families(orderSegs(board.segs));

  // Which branches a carried tile could land on, so a card can light up.
  const live = new Set<number>();
  if (S.sel) for (const m of g.moves) if (m.tile === S.sel) live.add(m.seg);

  const sig = 'cf#' + g.round + '#' + fams.map((f) => f.root.id).join('|');
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.innerHTML = `<div class="seatstrip"></div>
      <div class="cards">${fams.map((f) => cardShell(f, board.id)).join('')}</div>`;
    S.laneN = {};
  }

  paintSeats(wrap.querySelector('.seatstrip')!, g);
  // No hub header: the table's own top bar already shows the engine tile and
  // the round, and a second one under it said the same thing twice. What the
  // hub is *waiting for* belongs to its card, which is where it already is.
  //
  // An unfilled foot anywhere shuts every branch but the one owing toes, and
  // with a single train that is the whole board.
  const frozen = board.segs.find((s) => s.foot)?.foot ?? null;
  for (const f of fams) paintFamily(wrap, f, g, live, frozen);
}

// ---------------------------------------------------------------- the strip

function paintSeats(strip: Element, g: GameView): void {
  strip.innerHTML = g.players.map((p, i) => seatHTML(p, i, g)).join('');
}

function seatHTML(p: PlayerView, i: number, g: GameView): string {
  const cls = ['seat', g.turn === p.id ? 'onturn' : '', p.tiles === 1 ? 'lastone' : '',
    p.id === S.pid ? 'me' : '', p.connected ? '' : 'away'].join(' ');
  return `<div class="${cls}" title="${esc(p.name)} — ${p.tiles} in hand">
    ${avatar(p.name, i)}
    <span class="nm">${esc(p.id === S.pid ? 'You' : p.name)}</span>
    <span class="ct">${p.tiles}</span>
  </div>`;
}

// ---------------------------------------------------------------- the cards

// `data-train` is how a dropped tile finds the train it landed on — the same
// attribute a lane carries, so lift.ts needs to know about neither board.
const cardShell = (f: Family, trainId: string): string =>
  `<div class="card-b" data-fam="${f.root.id}" data-train="${esc(trainId)}">
    <div class="card-lbl"></div><div class="fam"></div>
  </div>`;

function paintFamily(wrap: Element, f: Family, g: GameView, live: Set<number>, frozen: FootView | null): void {
  const card = wrap.querySelector<HTMLElement>(`[data-fam="${f.root.id}"]`);
  if (!card) return;
  const segs = [f.root, ...f.rest];

  const box = card.querySelector('.fam') as HTMLElement;
  const structSig = segs.map((s) => s.id + '@' + s.depth).join(',');
  if (box.dataset.sig !== structSig) {
    box.dataset.sig = structSig;
    box.innerHTML = segs.map((s) => railShell(s, g.engine, hintFor(s, f))).join('');
    for (const s of segs) delete S.laneN['board:' + s.id];
  }

  const isLive = segs.some((s) => live.has(s.id));
  card.classList.toggle('livecard', isLive);
  card.classList.toggle('spent', segs.every((s) => s.closed));
  card.querySelector('.card-lbl')!.textContent = labelFor(f, frozen);

  for (const s of segs) {
    const rail = box.querySelector<HTMLElement>(`[data-seg="${s.id}"]`);
    if (rail) paintRail(rail, s, 'board:' + s.id, live.has(s.id), frozen, WHOLE);
  }
}

// The card says what its branch is waiting for, because a slot on its own is a
// number and this is the thing a player is actually scanning the board for.
function labelFor(f: Family, frozen: FootView | null): string {
  const owing = [f.root, ...f.rest].find((s) => s.foot);
  if (owing && owing.foot) {
    const owed = owing.foot.need - owing.foot.placed;
    return `wants ${owed} more ${owing.foot.value}${owed === 1 ? '' : 's'}`;
  }
  if (frozen) return 'frozen';
  const open = [f.root, ...f.rest].filter((s) => !s.closed);
  if (!open.length) return 'spent';
  if (f.root.parent === null) return 'the hub';
  return open.length === 1 && !open[0].tiles.length
    ? 'not started'
    : `open on ${open.map((s) => s.end).join(' and ')}`;
}

const hintFor = (s: PlacedSeg, f: Family): string =>
  (s.parent === null ? 'ring the hub to open the board' : s === f.root ? 'not started' : 'a toe of the foot');

// ---------------------------------------------------------------- clicks

export function onBoardClick(e: Event): void {
  const rail = (e.target as Element).closest('.rail'); if (!rail) return;
  if (rail.classList.contains('closed')) {           // spent branch — expand/collapse it
    const key = 'board:' + (rail as HTMLElement).dataset.seg;
    S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key);
    Snd.tap();
    return paintBoard(S.room!.game!);
  }
  if (!rail.classList.contains('live')) return;
  playTile(S.sel!, S.room!.game!.trains[0].id, Number((rail as HTMLElement).dataset.seg));
}
