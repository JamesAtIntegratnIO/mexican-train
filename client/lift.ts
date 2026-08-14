// Picking a tile up out of your hand and dropping it on a branch.
//
// The other half of tap-a-tile-then-tap-a-branch, for anyone who would rather
// carry the tile there than aim at it twice. Underneath it is the same gesture:
// a lift *is* a selection, so it lights exactly the branches a tap does, and
// letting go anywhere else leaves the tile picked rather than putting it back —
// a lift that missed can be finished with a tap, and a tap can be finished with
// a lift. Nothing here is a second way to play; it is the same one, moved.
//
// What the lift adds is the tile turning to lie the way it will land the moment
// it is over a branch that will take it: the end that connects goes on the left.
// That is the one thing the board knows and your hand doesn't.
//
// Legality is never decided here. `g.moves` is the server's answer and the
// glowing rails are already drawn from it, so this module only ever asks which
// rail is under the pointer.

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { tileHTML, laidHTML } from './tiles.js';
import { playTile } from './actions.js';
import type { TileId } from '../shared/protocol.js';

/** Far enough that a tap can't wobble into a lift, near enough to feel immediate. */
const GRAB = 8;
/** How near the edge of the board a held tile starts scrolling the lanes, and by
 *  how much a frame — four trains are taller than a phone, and the hand is at
 *  the bottom, so the train you want is often the one off the top. */
const EDGE = 64, SCROLL = 13;

interface Lift {
  tile: TileId;
  x: number; y: number;               // where the pointer is now
  ox: number; oy: number;             // where it went down, for the grab threshold
  carried: HTMLElement | null;          // the tile in flight — null until the threshold is crossed
  over: HTMLElement | null;           // the live rail under it, if any
}

// A lift outlives the shell it started in — a snapshot can rebuild the table
// mid-gesture — so the pointer is followed on the window and what is in flight
// lives here rather than in a closure over an element that may be gone.
let lift: Lift | null = null;
let redraw: () => void = () => {};
let following = false;

export function initLift(repaint: () => void): void {
  redraw = repaint;
  $<HTMLElement>('#hand').addEventListener('pointerdown', onDown);
  if (following) return;              // the rest of the gesture is the window's, and is wired once
  following = true;
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', (e) => onUp(e, false));
  addEventListener('pointercancel', (e) => onUp(e, true));
}

/** Whether a lift means anything at all: your turn, in the play phase. The
 *  engine hunt has one answer and no branch to aim at, and arrange mode has
 *  already claimed the pointer for reordering. */
function yourMove(): boolean {
  const g = S.room?.game;
  return !S.arrange && !!g && !S.room!.spectating
    && g.status === 'playing' && g.phase === 'play' && g.turn === S.pid;
}

function onDown(e: PointerEvent): void {
  if (!yourMove()) return;
  const el = (e.target as Element).closest<HTMLElement>('.tile');
  if (!el || !el.dataset.tile) return;
  lift = { tile: el.dataset.tile, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, carried: null, over: null };
}

function onMove(e: PointerEvent): void {
  if (!lift) return;
  lift.x = e.clientX; lift.y = e.clientY;
  if (!lift.carried) {
    if (Math.hypot(e.clientX - lift.ox, e.clientY - lift.oy) < GRAB) return;
    grab(lift);
    redraw();
  }
  place(lift.carried!, lift.x, lift.y);
}

function onUp(e: PointerEvent, cancelled: boolean): void {
  if (!lift) return;
  const l = lift; lift = null;
  if (!l.carried) return;               // a tap after all — the click flow has it
  drop(l, cancelled ? null : railAt(e.clientX, e.clientY));
  redraw();
}

// The tile leaves the hand. Selecting it here is what lights the branches, so
// the board says the same thing it would have said to a tap — and a tile with
// nowhere to go clears the selection instead, so what glows is never some
// earlier tile's business.
function grab(l: Lift): void {
  const g = S.room!.game!;
  const playable = g.moves.some((m) => m.tile === l.tile);
  S.dragging = true;                  // hold the hand still under the tile that left it
  S.sel = playable ? l.tile : null;
  l.carried = document.body.appendChild(carriedFor(l.tile, playable));
  document.querySelector<HTMLElement>(`#hand .tile[data-tile="${l.tile}"]`)?.classList.add('lifted');
  document.body.classList.add('lifting');
  Snd.tap();
  follow(l);
}

// Where it lands. A live rail under the tile is a play; anywhere else leaves the
// tile picked with its branches still lit, because a lift that missed is a
// selection waiting to be finished rather than a mistake to undo.
function drop(l: Lift, rail: HTMLElement | null): void {
  l.carried!.remove(); l.carried = null;  // and with it the follow loop
  l.over?.classList.remove('over');
  document.body.classList.remove('lifting');
  S.dragging = false;
  // The tile is no longer under the pointer, so the click this gesture is about
  // to produce belongs to whatever has taken its place. Swallow it.
  S.suppressClick = true;
  setTimeout(() => { S.suppressClick = false; });
  if (!rail) {
    if (!S.sel) toast('That tile has nowhere to go.');
    return;
  }
  // Whichever board is on, the group a rail sits in names the train it belongs
  // to — a lane in Mexican Train, a fork-family card in Chicken Foot.
  const group = rail.closest<HTMLElement>('[data-train]');
  if (group) playTile(l.tile, group.dataset.train!, Number(rail.dataset.seg));
}

// A held tile follows the board rather than sampling it: the lanes keep moving
// while it rests near an edge, and what is under it is re-read as they move, so
// the branch that lights up is always the one it is over.
function follow(l: Lift): void {
  if (!l.carried) return;               // dropped: the loop ends with the tile
  edgeScroll(l.y);
  hover(l, railAt(l.x, l.y));
  requestAnimationFrame(() => follow(l));
}

function hover(l: Lift, rail: HTMLElement | null): void {
  if (rail === l.over) return;
  l.over?.classList.remove('over');
  rail?.classList.add('over');
  l.over = rail;
  orient(l.carried!, l.tile, rail ? Number(rail.dataset.end) : null);
}

/** The rail under the pointer — or, when the group it is over has only one
 *  branch that will take the tile, that one. Aiming a fingertip at a strip of
 *  board is not the game. */
function railAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const rail = el.closest<HTMLElement>('.rail.live');
  if (rail) return rail;
  const live = el.closest('[data-train]')?.querySelectorAll<HTMLElement>('.rail.live');
  return live && live.length === 1 ? live[0]! : null;
}

// `carry` and not `ghost`: that class is already the quiet variant of a button,
// and the end-of-round card has one on it.
const carriedFor = (tile: TileId, playable: boolean): HTMLElement => {
  const el = document.createElement('div');
  el.className = `carry${playable ? '' : ' nope'}`;
  el.dataset.end = 'null';
  el.innerHTML = tileHTML(tile, 'p', '', S.flipped.has(tile));
  return el;
};

const place = (carried: HTMLElement, x: number, y: number): void => {
  carried.style.left = `${x}px`;
  carried.style.top = `${y}px`;
};

/** Turn the tile the way it will lie: `a` is the end that connects, so the half
 *  that matches the branch goes first, and the other becomes the new open end.
 *  Off the board it stands back up the way it sits in your hand. A double is
 *  drawn crosswise either way, which is how it will be laid. */
function orient(carried: HTMLElement, tile: TileId, end: number | null): void {
  if (carried.dataset.end === String(end)) return;
  carried.dataset.end = String(end);
  const [a, b] = tile.split('-').map(Number);
  carried.innerHTML = end === null
    ? tileHTML(tile, 'p', '', S.flipped.has(tile))
    : laidHTML({ tile, a: end, b: end === a ? b : a });
}

// Only inside the board, so a tile still sitting down in the hand doesn't wind
// the lanes to the bottom before it has been lifted anywhere near them.
function edgeScroll(y: number): void {
  const board = document.querySelector<HTMLElement>('.board');
  if (!board) return;
  const r = board.getBoundingClientRect();
  if (y < r.top || y > r.bottom) return;
  const d = y < r.top + EDGE ? -1 : y > r.bottom - EDGE ? 1 : 0;
  if (d) board.scrollTop += d * SCROLL;
}
