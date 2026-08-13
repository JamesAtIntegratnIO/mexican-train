// Your hand: how it is drawn, how you rearrange it, and what a tap means.
//
// Rearranging is a display preference — your own order, which way round each
// tile faces, where the dividers sit, and which of the sets between them you
// have stacked up — so it works on anybody's turn and never leaves this browser.

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML } from './tiles.js';
import { send } from './net.js';
import { paintLanes } from './lanes.js';
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

export function paintHand(g: GameView): void {
  const el = $<HTMLElement>('#hand');
  if (S.room!.spectating) {
    if (el.dataset.sig === 'watching') return;
    el.dataset.sig = 'watching';
    el.innerHTML = '<div class="hand-empty">You\'re watching this table — hands stay hidden.</div>';
    return;
  }
  if (S.dragging) return;                       // don't yank tiles out from under a drag

  const hand = orderedHand(g);
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
  initLift(() => { repaint(); paintLanes(S.room!.game!); });

  $('#arrange').onclick = (e: Event) => {
    S.arrange = !S.arrange;
    (e.currentTarget as HTMLElement).classList.toggle('on', S.arrange);
    $('#arrangehint').hidden = !S.arrange;
    $('#divider').hidden = !S.arrange;
    S.sel = null; Snd.tap();
    repaint(); paintLanes(S.room!.game!);
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

// An explicit arrange mode keeps dragging from fighting the hand's own
// scrolling on touch.
function initHandDrag(): void {
  const hand = $<HTMLElement>('#hand');
  let drag: { el: HTMLElement; x: number; moved: boolean } | null = null;

  hand.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!S.arrange) return;
    const el = (e.target as Element).closest<HTMLElement>('.item'); if (!el) return;
    e.preventDefault();
    drag = { el, x: e.clientX, moved: false };
    S.dragging = true;
    hand.setPointerCapture(e.pointerId);        // survives the tiles being re-ordered
  });

  hand.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    // A short press is a tap (turn the tile around); past the threshold it's a drag.
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x) < 6) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      hand.classList.add('moving');   // the fold handles belong to positions that are about to change
    }
    slideInto(hand, drag.el, e.clientX);
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
function slideInto(hand: HTMLElement, el: HTMLElement, x: number): void {
  for (const t of topItems(hand)) {
    if (t === el) continue;
    const r = t.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    // A tile taken over a stacked set goes into the run rather than beside it:
    // a set can be added to without opening it up first.
    if (t.dataset.pile && el.dataset.tile) return slideIntoPile(t, el, x);
    hand.insertBefore(el, x < r.left + r.width / 2 ? t : t.nextSibling);
    return;
  }
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
  paintHand(g); paintLanes(g); paintTurnbar(g);
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
