// Your hand: how it is drawn, how you rearrange it, and what a tap means.
//
// Rearranging is a display preference — your own order, which way round each
// tile faces, where the dividers sit, and which of the sets between them you
// have stacked up — so it works on anybody's turn and never leaves this
// browser. It does outlive the page, though: see restoreArrangement().

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML } from './tiles.js';
import { send } from './net.js';
import { savedHand, keepHand } from './seats.js';
import { paintTable } from './boards.js';
import { paintTurnbar } from './turnbar.js';
import { playTile } from './actions.js';
import { initLift } from './lift.js';
import type { GameView, TileId } from '../shared/protocol.js';
import type { HandItem } from './state.js';

/** Dividers are `|1`, `|2`, … and tiles are `3-9`, so the first character tells
 *  them apart. The counter only has to outlast the arrangement it belongs to. */
const isDivider = (h: HandItem): boolean => h.startsWith('|');
let nextDivider = 1;

/** A set: the run of tiles between two dividers, and the divider that opens it.
 *  Sets are what the fold handles act on — a stack, once made, is remembered as
 *  its own tiles rather than as a position, so it survives being dragged
 *  somewhere else and the dividers moving around it. */
interface HandSet { sep: HandItem | null; tiles: TileId[] }

function handSets(order: HandItem[]): HandSet[] {
  const out: HandSet[] = [{ sep: null, tiles: [] }];
  for (const h of order) {
    if (isDivider(h)) out.push({ sep: h, tiles: [] });
    else out[out.length - 1]!.tiles.push(h);
  }
  return out;
}

/** The stacked run starting at `items[i]`, if one does. A pile is drawn wherever
 *  its own tiles have got to, which is what lets it be dragged about. */
const stackAt = (items: HandItem[], i: number): TileId[] | null =>
  S.stacked.find((run) => run[0] === items[i] && run.every((t, k) => items[i + k] === t)) ?? null;

const isStacked = (t: TileId): boolean => S.stacked.some((run) => run.includes(t));

// Your own arrangement, kept client-side. New tiles land on the end; tiles
// you've played drop out; everything else keeps the order you set. A divider
// with nothing left on its left — the run before it has been played off, or a
// stacked set has been dragged out from in front of it — is separating nothing,
// and goes. One at the far end is left alone: that is where a new one is parked.
function orderedHand(g: GameView): HandItem[] {
  if (!g.hand.length) { S.handOrder = []; S.stacked = []; return []; }   // between rounds, the arrangement goes too
  const inHand = new Set(g.hand);
  const kept = S.handOrder.filter((h) => isDivider(h) || inHand.has(h));
  const trimmed = kept.filter((h, i) => !isDivider(h) || (i > 0 && !isDivider(kept[i - 1]!)));
  const have = new Set(trimmed);
  for (const t of g.hand) if (!have.has(t)) trimmed.push(t);
  // Tiles played out of a pile leave it; a pile played down to its last tile is
  // not a pile any more. Both fall out of the same pass.
  const inOrder = new Set(trimmed);
  S.stacked = S.stacked.map((run) => run.filter((t) => inOrder.has(t))).filter((run) => run.length > 1);
  const order = fencePiles(trimmed);
  S.handOrder = order;
  return order;
}

// A stacked set is still a set, so it keeps a divider on each side of it
// wherever you drag it to — drop one into the middle of another run and that run
// is cut in two rather than quietly swallowing it. The hand's own ends count as
// dividers, and a fence once put up stays in the order, so this settles.
function fencePiles(order: HandItem[]): HandItem[] {
  const out: HandItem[] = [];
  for (let i = 0; i < order.length;) {
    const run = stackAt(order, i);
    if (!run) { out.push(order[i]!); i++; continue; }
    if (out.length && !isDivider(out[out.length - 1]!)) out.push(`|${nextDivider++}`);
    out.push(...run);
    i += run.length;
    if (i < order.length && !isDivider(order[i]!)) out.push(`|${nextDivider++}`);
  }
  return out;
}

// ---------------------------------------------------------------- remembering it

/** The round an arrangement we have just read back belongs to, until the first
 *  snapshot says which round we are actually in. Null the rest of the time. */
let restoredFor: number | null = null;

/** Put the hand back the way it was left at this table. Arranging is real work,
 *  and on a phone the back swipe that throws the page away is a thumb's width
 *  from every other gesture — so losing the lot to one is a poor trade for a
 *  layout that only ever lived in a variable. */
export function restoreArrangement(code: string): void {
  const m = savedHand(code);
  restoredFor = m ? m.round : null;
  S.handOrder = m ? m.order : [];
  S.stacked = m ? m.stacked : [];
  S.flipped = new Set(m ? m.flipped : []);
  // The counter has to clear the dividers just restored, or the next one added
  // is dropped in under a name that is already taken and the two move as one.
  for (const h of S.handOrder) if (isDivider(h)) nextDivider = Math.max(nextDivider, Number(h.slice(1)) + 1);
}

/** An arrangement belongs to the round it was made in. Meeting a different one
 *  means the tiles it names are gone anyway — but the dividers and the flips
 *  aren't, so it goes as a whole rather than leaving its furniture behind. */
function matchRound(round: number): void {
  if (restoredFor === null) return;
  const stale = restoredFor !== round;
  restoredFor = null;
  if (stale) { S.handOrder = []; S.stacked = []; S.flipped.clear(); }
}

const keepArrangement = (round: number): void => {
  if (!S.code) return;
  keepHand(S.code, { round, order: S.handOrder, stacked: S.stacked, flipped: [...S.flipped] });
};

// ---------------------------------------------------------------- painting

export function paintHand(g: GameView): void {
  const el = $<HTMLElement>('#hand');
  if (S.room!.spectating) {
    if (el.dataset.sig === 'watching') return;
    el.dataset.sig = 'watching';
    el.innerHTML = '<div class="hand-empty">You\'re watching this table — hands stay hidden.</div>';
    return;
  }
  if (S.dragging) return;                       // don't yank tiles out from under a drag

  matchRound(g.round);
  const hand = orderedHand(g);
  // Every way of changing the arrangement ends in a repaint, so this is the one
  // place that has to write it down.
  keepArrangement(g.round);
  const playable = new Set(g.moves.map((m) => m.tile));
  const yours = g.turn === S.pid && g.phase === 'play'; // don't grey the hand out while hunting the engine
  const mustLay = g.prompt === 'engine' ? `${g.engine}-${g.engine}` : null;
  const flips = hand.filter((t) => S.flipped.has(t)).join(',');
  const sig = hand.join(',') + '|' + (yours ? [...playable].sort().join(',') : '-') + '|' + S.sel + '|' + S.arrange
    + '|' + flips + '|' + mustLay + '|' + S.stacked.map((run) => run.join(',')).join(';');
  if (el.dataset.sig === sig) return;

  const prev = new Set([...el.querySelectorAll<HTMLElement>('.tile')].map((n) => n.dataset.tile));
  el.dataset.sig = sig;
  el.classList.toggle('arranging', S.arrange);
  el.innerHTML = hand.length
    ? handSets(hand).map((s) => setHTML(s, { mustLay, yours, playable, prev })).join('')
    : '<div class="hand-empty">Your hand is empty.</div>';
}

// The divider that opens the set, its tiles, and — while you are arranging, and
// while there is anything left to fold — the handle that folds the lot.
function setHTML(s: HandSet, f: PaintFlags): string {
  const sep = s.sep ? dividerHTML(s.sep) : '';
  const foldable = S.arrange && s.tiles.length > 1 && !s.tiles.every(isStacked);
  return sep + runsHTML(s.tiles, f) + (foldable ? foldHTML(s.tiles[0]!, '⊟', 'Stack this set') : '');
}

// The tiles of one set, with any run you have stacked drawn as a pile in the
// place its own tiles have reached.
function runsHTML(tiles: TileId[], f: PaintFlags): string {
  const out: string[] = [];
  for (let i = 0; i < tiles.length;) {
    const run = stackAt(tiles, i);
    if (run) { out.push(stackHTML(run, f)); i += run.length; continue; }
    out.push(tileHTML(tiles[i]!, 'p', 'item ' + tileClasses(tiles[i]!, f), S.flipped.has(tiles[i]!)));
    i++;
  }
  return out.join('');
}

// The pile. A run is built in the order it will be played, so the tile that goes
// down first lies on top and the rest fan out to its right underneath it — each
// keeping the right-hand sliver the CSS moves its numbers onto. Reading left to
// right still gives the order you arranged.
//
// The tiles go out back to front because paint order is what puts the leftmost
// one on top; `row-reverse` in the CSS turns them the right way round again. The
// whole pile is one `.item`, which is what makes it drag as a single set. Named
// `pile` rather than `stack` because that class is already the vertical run of
// controls on the front door.
function stackHTML(run: TileId[], f: PaintFlags): string {
  const tiles = run.map((t, i) => tileHTML(t, 'p', (i ? '' : 'top ') + tileClasses(t, f), S.flipped.has(t)));
  return `<div class="pile item" data-pile="${run[0]}"
    ${S.arrange ? 'title="Drag to move it · drop a tile on it to add one · tap to unstack"' : ''}
    >${foldHTML(run[0]!, '⊞', `Unstack these ${run.length}`, run.length)}${tiles.reverse().join('')}</div>`;
}

// A stacked set keeps this handle whatever mode you are in, so a set can be
// opened again mid-turn without going back into arrange mode first. Both handles
// answer to the tile the run starts with. Glyph over count, in a column no wider
// than it has to be: it is standing where the tiles it folded away used to be,
// so it should not spend that space itself.
const foldHTML = (first: TileId, glyph: string, title: string, count = 0): string =>
  `<button class="fold" data-fold="${first}" title="${title}">${glyph}${count ? `<b>${count}</b>` : ''}</button>`;

// Half a tile wide: enough for the break to read as deliberate, not so much
// that a hand with three of them stops fitting on a phone.
const dividerHTML = (id: HandItem): string =>
  `<div class="sep item" data-sep="${id}" role="separator" aria-label="Divider"
    ${S.arrange ? 'title="Drag to move it · tap to take it out"' : ''}></div>`;

interface PaintFlags {
  mustLay: TileId | null;
  yours: boolean;
  playable: Set<TileId>;
  prev: Set<string | undefined>;
}

// The `item` class — what the drag code picks up — is added by the caller, not
// here: a tile inside a stack is part of one bigger item rather than its own.
function tileClasses(t: TileId, { mustLay, yours, playable, prev }: PaintFlags): string {
  return [
    (mustLay ? t !== mustLay : yours && !playable.has(t)) && !S.arrange ? 'dead' : '',
    mustLay && t === mustLay ? 'sel' : '',
    S.sel === t ? 'sel' : '',
    prev.size && !prev.has(t) ? 'fresh' : '',
  ].join(' ');
}

// ---------------------------------------------------------------- wiring

export function wireHandTools(): void {
  const repaint = () => {
    $<HTMLElement>('#hand').dataset.sig = '';
    paintHand(S.room!.game!);
    paintTurnbar(S.room!.game!);
  };

  $('#hand').onclick = onHandClick;
  initHandDrag();
  // Lifting a tile onto the board moves the selection, so it repaints the board
  // as well as the hand — it can't reach paintHand itself without a cycle.
  initLift(() => { repaint(); paintTable(S.room!.game!); });

  $('#arrange').onclick = (e: Event) => {
    S.arrange = !S.arrange;
    (e.currentTarget as HTMLElement).classList.toggle('on', S.arrange);
    $('#arrangehint').hidden = !S.arrange;
    $('#divider').hidden = !S.arrange;
    S.sel = null; Snd.tap();
    repaint(); paintTable(S.room!.game!);
  };
  // A new divider goes on the end, where it is out of the way until you drag it
  // between the two runs you want kept apart.
  $('#divider').onclick = () => {
    S.handOrder = [...orderedHand(S.room!.game!), `|${nextDivider++}`];
    Snd.tap(); repaint();
  };
  $('#resort').onclick = () => { S.handOrder = []; S.flipped.clear(); S.stacked = []; Snd.tap(); repaint(); };
}

// Stacking is a fold, like a divider is a gap: it changes nothing about the hand
// itself, only how much of the dock a run you have finished with takes up, so
// the hand is all that has to be repainted.
function toggleStack(first: TileId): void {
  S.stacked.some((run) => run[0] === first) ? unfold(first) : foldSet(first);
  $<HTMLElement>('#hand').dataset.sig = '';
  paintHand(S.room!.game!);
  Snd.tap();
}

const unfold = (first: TileId): void => { S.stacked = S.stacked.filter((run) => run[0] !== first); };

// Folding a whole set takes in any smaller pile already sitting inside it —
// tiles belong to one pile or none, never to two overlapping claims.
function foldSet(first: TileId): void {
  const set = handSets(S.handOrder).find((s) => s.tiles[0] === first);
  if (!set) return;
  const inSet = new Set(set.tiles);
  S.stacked = S.stacked.filter((run) => !run.some((t) => inSet.has(t)));
  S.stacked.push(set.tiles);
}

/** What one drag is: where it went down, for the tap threshold, and where the
 *  pointer is now, which the edge-scroll needs between moves. */
interface Drag { el: HTMLElement; ox: number; oy: number; x: number; y: number; moved: boolean }

/** How near the top or bottom of a hand that has outgrown the dock a held tile
 *  starts winding it along, and by how much a frame. */
const EDGE = 34, SCROLL = 9;

// A hand grows: draw enough tiles and it has more rows than the dock will show.
// A tile held near an edge winds it along, which is both how you drag one to a
// row you can't see and how you get to that row at all — under a finger the
// tiles are grab handles, so they are no longer something to scroll by.
//
// Its own clock, because holding still at an edge is precisely the case
// pointermove stops reporting. The drag is read through a function so this
// follows the one in flight rather than a copy of it made when it started.
function wind(hand: HTMLElement, held: () => Drag | null): void {
  const d = held();
  if (!d || !d.moved) return;
  const r = hand.getBoundingClientRect();
  const dir = d.y < r.top + EDGE ? -1 : d.y > r.bottom - EDGE ? 1 : 0;
  if (dir) { hand.scrollTop += dir * SCROLL; slideInto(hand, d.el, d.x, d.y); }
  requestAnimationFrame(() => wind(hand, held));
}

// An explicit arrange mode keeps dragging from fighting the hand's own
// scrolling on touch.
function initHandDrag(): void {
  const hand = $<HTMLElement>('#hand');
  let drag: Drag | null = null;

  hand.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!S.arrange) return;
    const el = (e.target as Element).closest<HTMLElement>('.item'); if (!el) return;
    e.preventDefault();
    drag = { el, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    S.dragging = true;
    hand.setPointerCapture(e.pointerId);        // survives the tiles being re-ordered
  });

  hand.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    // A short press is a tap (turn the tile around); past the threshold it's a
    // drag. In any direction, now that a hand being arranged has rows: moving a
    // tile up one is as ordinary a thing to want as moving it along.
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.ox, e.clientY - drag.oy) < 6) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      hand.classList.add('moving');   // the fold handles belong to positions that are about to change
      wind(hand, () => drag);
    }
    slideInto(hand, drag.el, e.clientX, e.clientY);
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    try { hand.releasePointerCapture(e.pointerId); } catch {}
    const { el, moved } = drag;
    drag = null; S.dragging = false;
    hand.classList.remove('moving');

    if (moved) {
      // Both the order and the piles are read back off the board, so a tile
      // dropped into a stacked set joins that run without any special case here.
      el.classList.remove('dragging');
      S.stacked = topItems(hand).filter((t) => t.dataset.pile).map(pileIds).filter((run) => run.length > 1);
      S.handOrder = topItems(hand).flatMap(itemIds);
    } else if (el.dataset.pile) {
      // A stacked set has nothing to turn around either, so a tap opens it up.
      unfold(el.dataset.pile);
    } else if (el.dataset.sep) {
      // A divider has nothing to turn around, so a tap takes it back out.
      S.handOrder = S.handOrder.filter((h) => h !== el.dataset.sep);
    } else {
      // A tap turns the tile around: 7|9 becomes 9|7 so a planned run reads
      // left to right. Handled here rather than on `click`, because the
      // preventDefault() above suppresses the compatibility click event.
      const tile = el.dataset.tile!;
      S.flipped.has(tile) ? S.flipped.delete(tile) : S.flipped.add(tile);
    }
    hand.dataset.sig = '';                      // let the next paint through
    paintHand(S.room!.game!);
    Snd.tap();
  };
  hand.addEventListener('pointerup', endDrag);
  hand.addEventListener('pointercancel', endDrag);
}

/** The things the hand itself arranges. A tile that has been dropped into a pile
 *  is one of that pile's tiles now, not a hand item, so only the top level
 *  counts — otherwise it would be put back into the order twice. */
const topItems = (hand: HTMLElement): HTMLElement[] =>
  [...hand.children].filter((n): n is HTMLElement => n.classList.contains('item'));

/** A pile's run, left to right — its tiles are laid out back to front. */
const pileIds = (pile: HTMLElement): TileId[] =>
  [...pile.querySelectorAll<HTMLElement>('.tile')].map((t) => t.dataset.tile!).reverse();

/** What one draggable thing puts back into the order: a stacked set stands in
 *  for the whole run it holds, and everything else for itself. */
const itemIds = (t: HTMLElement): HandItem[] =>
  t.dataset.pile ? pileIds(t) : [t.dataset.tile ?? t.dataset.sep!];

// Move the node itself rather than repainting — smoother, and it keeps the
// element reference alive for the rest of the gesture.
//
// Once the hand wraps, the pointer is very often over nothing at all: past the
// end of a short row, in the gap between two of them. Asking which item is
// nearest rather than which one is underneath answers all of those, and makes
// dropping a tile on the end of a row a matter of aiming at the space after it.
function slideInto(hand: HTMLElement, el: HTMLElement, x: number, y: number): void {
  const t = nearestItem(topItems(hand).filter((n) => n !== el), x, y);
  if (!t) return;
  const r = t.getBoundingClientRect();
  const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  // A tile taken over a stacked set goes into the run rather than beside it: a
  // set can be added to without opening it up first. Only when genuinely over
  // it, though — a pile that merely happened to be the closest thing is a
  // neighbour to drop beside, not a set to join.
  if (inside && t.dataset.pile && el.dataset.tile) return slideIntoPile(t, el, x);
  hand.insertBefore(el, x < r.left + r.width / 2 ? t : t.nextSibling);
}

/** Which item the drag is asking to be put next to. Distance to the box rather
 *  than to its middle, so a wide pile isn't beaten by the narrow divider beside
 *  it; and a row weighs more than a column, so a pointer that has drifted off
 *  the end of a row still belongs to the row it is on rather than to whatever
 *  sits below it. */
function nearestItem(items: HTMLElement[], x: number, y: number): HTMLElement | null {
  let best: HTMLElement | null = null, near = Infinity;
  for (const t of items) {
    const r = t.getBoundingClientRect();
    const d = Math.max(r.left - x, 0, x - r.right) + Math.max(r.top - y, 0, y - r.bottom) * 4;
    if (d < near) { near = d; best = t; }
  }
  return best;
}

// Which gap in the pile the tile is over. The tiles overlap, so their boxes
// answer to several gaps at once; what settles it is the halfway point of the
// sliver each one shows. A pile is written back to front, so the tile that ends
// up on el's left is the one el goes before in the DOM.
function slideIntoPile(pile: HTMLElement, el: HTMLElement, x: number): void {
  const vis = [...pile.querySelectorAll<HTMLElement>('.tile')].reverse().filter((t) => t !== el);
  let n = 0;
  for (const t of vis) {
    const r = t.getBoundingClientRect();
    const right = vis[n + 1] ? vis[n + 1]!.getBoundingClientRect().left : r.right;
    if (x < r.left + (right - r.left) / 2) break;
    n++;
  }
  pile.insertBefore(el, n > 0 ? vis[n - 1]! : null);
}

// ---------------------------------------------------------------- interaction

function onHandClick(e: Event): void {
  // A tile carried onto the board and back again would otherwise be un-picked
  // by the click its own gesture leaves behind.
  if (S.suppressClick) return;
  // The fold handles answer in either mode — a set you stacked while arranging
  // still has to be openable in the middle of your turn.
  const fold = (e.target as Element).closest<HTMLElement>('[data-fold]');
  if (fold) return toggleStack(fold.dataset.fold!);
  if (S.arrange) return;      // otherwise arrange mode is driven by pointer events, not clicks
  const el = (e.target as Element).closest<HTMLElement>('.tile'); if (!el) return;
  onTileClick(el);
}

// Tiles under a stack keep their sliver, so playing straight out of a stacked
// set works without opening it first.
function onTileClick(el: HTMLElement): void {
  const g = S.room!.game!;
  if (g.turn !== S.pid) return toast("It isn't your turn yet.");
  if (g.phase === 'seeking') return engineClick(g, el);

  const tile = el.dataset.tile!;
  const targets = g.moves.filter((m) => m.tile === tile);
  if (!targets.length) return toast('That tile has nowhere to go.');
  // Tapping an already-selected tile with one legal home just plays it.
  if (S.sel === tile && targets.length === 1) return playTile(tile, targets[0]!.train, targets[0]!.seg);
  S.sel = S.sel === tile ? null : tile;
  paintHand(g); paintTable(g); paintTurnbar(g);
}

// While the engine is still being hunted, the only tile that does anything is
// the engine itself.
function engineClick(g: GameView, el: HTMLElement): void {
  if (g.prompt === 'engine' && el.dataset.tile === `${g.engine}-${g.engine}`) {
    Snd.clack();
    return send({ t: 'engine' });
  }
  return toast(`The double ${g.engine} has to come out first.`);
}
