// One branch of a train, drawn and kept up to date.
//
// Both boards are built out of these. Mexican Train stacks them into a lane per
// train; Chicken Foot groups them into a card per fork family. Everything the
// two do identically lives here, which is all of the fiddly part — and the two
// places they differ are words, passed in.
//
// Painting is incremental on purpose. Tiles are appended rather than rebuilt,
// because throwing a branch away and redrawing it restarts its scroll position
// and loses the entry animation on the tile that was just laid — which is the
// one thing on screen the player is actually watching for.

import { S } from './state.js';
import { laidHTML } from './tiles.js';
import { owedPhrase } from '../shared/phrasing.js';
import type { SegView, FootView } from '../shared/protocol.js';

/** A branch with its depth in the fork tree, so a rail can be indented. */
export type PlacedSeg = SegView & { depth: number };

/** What a freeze holds up, as it reads mid-sentence: one game has a train per
 *  player, the other has a single board. */
export type Whole = string;

// Branches are a tree; lay them out depth-first so children sit under their parent.
export function orderSegs(segs: SegView[]): PlacedSeg[] {
  const kids = new Map<number | 'root', SegView[]>();
  for (const s of segs) {
    const k = s.parent === null ? 'root' : s.parent;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(s);
  }
  const out: PlacedSeg[] = [];
  (function walk(k: number | 'root', depth: number): void {
    for (const s of kids.get(k) || []) { out.push({ ...s, depth }); walk(s.id, depth + 1); }
  })('root', 0);
  return out;
}

export function railShell(s: PlacedSeg, engine: number, hint: string): string {
  const cap = s.parent === null
    ? `<div class="hub-cap" title="engine">${engine}</div>`
    : `<div class="branch-cap" title="branches off the double ${s.from}">${s.from}</div>`;
  return `<div class="rail" data-seg="${s.id}" style="--depth:${s.depth}">
    ${cap}
    <div class="tiles"></div>
    <span class="empty-hint">${hint}</span>
    <div class="slot"></div>
  </div>`;
}

export function paintRail(rail: HTMLElement, s: PlacedSeg, key: string, isLive: boolean,
                          frozen: FootView | null, whole: Whole): void {
  const tiles = rail.querySelector('.tiles')!;
  appendTiles(tiles, rail, s, key);
  rail.dataset.end = String(s.end);   // what a tile carried over this branch turns to face

  const hint = rail.querySelector('.empty-hint') as HTMLElement | null;
  if (hint) hint.style.display = s.tiles.length ? 'none' : '';

  // the uncovered double itself
  tiles.querySelectorAll('.tile.pend').forEach((n) => n.classList.remove('pend'));
  if (s.foot && tiles.lastElementChild) tiles.lastElementChild.classList.add('pend');

  rail.classList.toggle('live', isLive);
  rail.classList.toggle('closed', !!s.closed);
  // A forked branch can never be played on again — shrink it to a numeral-only
  // trail so live ends get the space. Click it to open it back up.
  rail.classList.toggle('trail', !!s.closed && !S.expanded.has(key));
  rail.classList.toggle('frozen', !!frozen && !s.foot && !s.closed);

  paintSlot(rail.querySelector('.slot') as HTMLElement, s, frozen, whole);
  if (isLive) requestAnimationFrame(() => rail.scrollIntoView({ block: 'nearest' }));
}

// Only the tiles that aren't drawn yet get drawn. A branch that somehow got
// shorter — a round reset, a snapshot arriving out of order — is the one case
// worth starting over for.
function appendTiles(tiles: Element, rail: HTMLElement, s: PlacedSeg, key: string): void {
  const had = S.laneN[key] || 0;
  if (s.tiles.length < had) { tiles.innerHTML = ''; S.laneN[key] = 0; }
  for (let i = S.laneN[key] || 0; i < s.tiles.length; i++) tiles.insertAdjacentHTML('beforeend', laidHTML(s.tiles[i]));
  if (s.tiles.length !== had) {
    S.laneN[key] = s.tiles.length;
    requestAnimationFrame(() => { rail.scrollLeft = rail.scrollWidth; });
  }
}

// The open end of a branch, and what it is waiting for.
function paintSlot(slot: HTMLElement, s: PlacedSeg, frozen: FootView | null, whole: Whole): void {
  slot.hidden = !!s.closed;
  if (s.closed) return;
  slot.classList.toggle('foot', !!s.foot);
  slot.innerHTML = `${s.end}${s.foot ? `<span class="need">${s.foot.placed}/${s.foot.need}</span>` : ''}`;
  // A foot holds up everything it is attached to, so the branches that aren't
  // owed anything say why they are shut instead of posing as ordinary open ends.
  slot.title = s.foot ? `${owedPhrase(s.foot)} to fill this foot — nothing else on ${whole} moves until then`
    : frozen ? `Frozen — ${whole} owes ${owedPhrase(frozen)} before any branch grows`
    : `Open end — needs a ${s.end}`;
}
