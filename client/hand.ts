// Your hand: how it is drawn, how you rearrange it, and what a tap means.
//
// Rearranging is a display preference — your own order, and which way round
// each tile faces — so it works on anybody's turn and never leaves this browser.

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML } from './tiles.js';
import { send } from './net.js';
import { paintLanes } from './lanes.js';
import { paintTurnbar } from './turnbar.js';
import { playTile } from './actions.js';
import type { GameView, TileId } from '../shared/protocol.js';

// Your own arrangement, kept client-side. New tiles land on the end; tiles
// you've played drop out; everything else keeps the order you set.
function orderedHand(g: GameView): TileId[] {
  const inHand = new Set(g.hand);
  const order = S.handOrder.filter((t) => inHand.has(t));
  const have = new Set(order);
  for (const t of g.hand) if (!have.has(t)) order.push(t);
  S.handOrder = order;
  return order;
}

export function paintHand(g: GameView): void {
  const el = $<HTMLElement>('#hand');
  if (S.room!.spectating) {
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

  const prev = new Set([...el.querySelectorAll<HTMLElement>('.tile')].map((n) => n.dataset.tile));
  el.dataset.sig = sig;
  el.classList.toggle('arranging', S.arrange);
  el.innerHTML = hand.length
    ? hand.map((t) => tileHTML(t, 'p', tileClasses(t, { mustLay, yours, playable, prev }), S.flipped.has(t))).join('')
    : '<div class="hand-empty">Your hand is empty.</div>';
}

interface PaintFlags {
  mustLay: TileId | null;
  yours: boolean;
  playable: Set<TileId>;
  prev: Set<string | undefined>;
}

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
  $('#hand').onclick = onHandClick;
  initHandDrag();

  const repaint = () => {
    $<HTMLElement>('#hand').dataset.sig = '';
    paintHand(S.room!.game!);
    paintTurnbar(S.room!.game!);
  };
  $('#arrange').onclick = (e: Event) => {
    S.arrange = !S.arrange;
    (e.currentTarget as HTMLElement).classList.toggle('on', S.arrange);
    $('#arrangehint').hidden = !S.arrange;
    S.sel = null; Snd.tap();
    repaint(); paintLanes(S.room!.game!);
  };
  $('#resort').onclick = () => { S.handOrder = []; S.flipped.clear(); Snd.tap(); repaint(); };
}

// An explicit arrange mode keeps dragging from fighting the hand's own
// scrolling on touch.
function initHandDrag(): void {
  const hand = $<HTMLElement>('#hand');
  let drag: { el: HTMLElement; x: number; moved: boolean } | null = null;

  hand.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!S.arrange) return;
    const el = (e.target as Element).closest<HTMLElement>('.tile'); if (!el) return;
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
    }
    slideInto(hand, drag.el, e.clientX);
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    try { hand.releasePointerCapture(e.pointerId); } catch {}
    const { el, moved } = drag;
    drag = null; S.dragging = false;

    if (moved) {
      el.classList.remove('dragging');
      S.handOrder = [...hand.querySelectorAll<HTMLElement>('.tile')].map((t) => t.dataset.tile!);
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

// Move the node itself rather than repainting — smoother, and it keeps the
// element reference alive for the rest of the gesture.
function slideInto(hand: HTMLElement, el: HTMLElement, x: number): void {
  for (const t of hand.querySelectorAll<HTMLElement>('.tile')) {
    if (t === el) continue;
    const r = t.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    hand.insertBefore(el, x < r.left + r.width / 2 ? t : t.nextSibling);
    return;
  }
}

// ---------------------------------------------------------------- interaction

function onHandClick(e: Event): void {
  const el = (e.target as Element).closest<HTMLElement>('.tile'); if (!el) return;
  if (S.arrange) return;      // arrange mode is driven by pointer events, not clicks
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
