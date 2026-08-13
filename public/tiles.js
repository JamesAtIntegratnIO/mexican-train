// The drawing vocabulary: what a domino looks like, what a player looks like,
// and the one locomotive that serves as both a marker and the brand mark.
// Nothing here knows about the game — it takes values and returns HTML.

import { esc } from './dom.js';
import { S } from './state.js';

// Number colours, mirroring a colour-coded double-12 set. All ≥4.5:1 on ivory.
export const NUMC = ['#475569', '#1d4ed8', '#047857', '#be185d', '#6d28d9', '#b45309', '#0e7490',
                     '#b91c1c', '#4d7c0f', '#a21caf', '#c2410c', '#4338ca', '#0f766e'];
export const SEATC = ['#f0b429', '#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#facc15'];

// `flip` swaps which half shows first — purely cosmetic, for lining a hand up
// into the shape of the train you're planning. The tile's identity is unchanged.
export function tileHTML(id, cls = 'p', extra = '', flip = false) {
  let [a, b] = id.split('-').map(Number);
  if (flip) [a, b] = [b, a];
  return `<div class="tile ${cls}${a === b ? ' dbl' : ''} ${extra}" data-tile="${id}" aria-label="${a} ${b}"
    style="--c1:${NUMC[a]};--c2:${NUMC[b]}">${halfHTML(a)}${halfHTML(b)}</div>`;
}

// A laid tile knows its orientation: `a` is the end that connects, `b` is the new open end.
export function laidHTML(t, extra = '') {
  const cls = t.a === t.b ? 'l dbl' : 'l';
  return `<div class="tile ${cls} ${extra}" data-tile="${t.tile}" aria-label="${t.a} ${t.b}"
    style="--c1:${NUMC[t.a]};--c2:${NUMC[t.b]}">${halfHTML(t.a)}${halfHTML(t.b)}</div>`;
}

// Pip layouts on a unit square, spotted the way real double-12 sets are.
const CC = [0.26, 0.5, 0.74];
const R4 = [0.17, 0.39, 0.61, 0.83], R5 = [0.13, 0.31, 0.5, 0.69, 0.87], R3 = [0.22, 0.5, 0.78];
const col = (x, ys) => ys.map((y) => [x, y]);
const PIPS = [
  [],
  [[0.5, 0.5]],
  [[0.28, 0.24], [0.72, 0.76]],
  [[0.25, 0.22], [0.5, 0.5], [0.75, 0.78]],
  [[CC[0], 0.26], [CC[2], 0.26], [CC[0], 0.74], [CC[2], 0.74]],
  [[CC[0], 0.26], [CC[2], 0.26], [0.5, 0.5], [CC[0], 0.74], [CC[2], 0.74]],
  [...col(CC[0], R3), ...col(CC[2], R3)],
  [...col(CC[0], R3), [0.5, 0.5], ...col(CC[2], R3)],
  [...col(CC[0], R4), ...col(CC[2], R4)],
  [...col(CC[0], R3), ...col(CC[1], R3), ...col(CC[2], R3)],
  [...col(CC[0], R5), ...col(CC[2], R5)],
  [...col(CC[0], R4), ...col(CC[1], R3), ...col(CC[2], R4)],
  [...col(CC[0], R4), ...col(CC[1], R4), ...col(CC[2], R4)],
];

// Both spellings ship in the markup; CSS picks one, so the toggle is instant.
function halfHTML(n) {
  const pts = PIPS[n] || [];
  const r = n >= 10 ? 7.2 : n >= 7 ? 8.4 : 10;
  return `<div class="half"><span class="num">${n}</span><svg class="pips" viewBox="0 0 100 100" aria-hidden="true">${
    pts.map(([x, y]) => `<circle cx="${(x * 100).toFixed(1)}" cy="${(y * 100).toFixed(1)}" r="${r}"/>`).join('')
  }</svg></div>`;
}

export function applyPipMode() { document.body.classList.toggle('pipmode', S.pipMode); }

// --tw is the single sizing token for every domino, so zoom is one variable.
export const PIP_FLOOR = 34;   // below this, pips stop being readable and numerals take over
export const currentTw = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tw')) || 46;

export function applyZoom() {
  // Only pin the size once the player has actually chosen one — otherwise leave
  // the responsive defaults in charge.
  if (S.zoom) document.documentElement.style.setProperty('--tw', S.zoom + 'px');
  document.body.classList.toggle('smalltiles', currentTw() < PIP_FLOOR);
}
addEventListener('resize', applyZoom);

export const avatar = (name, i) => `<div class="avatar" style="background:${SEATC[i % SEATC.length]}">${esc((name || '?')[0].toUpperCase())}</div>`;

// The little locomotive that marks an open train — and, blown up, the brand
// mark. One drawing has to work at 27px and at 170px, so the silhouette carries
// it (funnel, boiler, cab, three wheels on one rail) and the detail is cut
// *through* the shape with fill-rule="evenodd" rather than painted on in the
// background colour. Real holes mean the cab window and wheel hubs read against
// any backdrop, at any opacity, instead of only against the one page colour
// they were once hard-coded to match.
const TRAIN_ICON = `<svg viewBox="0 0 72 48" aria-hidden="true">
  <rect x="3" y="32" width="66" height="5" rx="2.5"/>
  <rect x="7" y="16" width="36" height="16" rx="8"/>
  <rect x="27" y="11.5" width="8" height="6.5" rx="3.2"/>
  <rect x="14" y="9" width="6.6" height="8" rx="1"/>
  <rect x="11.6" y="4.6" width="11.4" height="4.6" rx="1.7"/>
  <rect x="37.5" y="7.4" width="29" height="5" rx="2.2"/>
  <path fill-rule="evenodd" d="M43 8h18a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H43a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Zm4 7h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H47a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"/>
  <rect x="28.5" y="42.2" width="23" height="2.2" rx="1.1"/>
  <path fill-rule="evenodd" d="M29.5 34A6 6 0 1 1 29.5 46 6 6 0 1 1 29.5 34Zm0 4.2A1.8 1.8 0 1 1 29.5 41.8 1.8 1.8 0 1 1 29.5 38.2Z"/>
  <path fill-rule="evenodd" d="M51 34A6 6 0 1 1 51 46 6 6 0 1 1 51 34Zm0 4.2A1.8 1.8 0 1 1 51 41.8 1.8 1.8 0 1 1 51 38.2Z"/>
  <path fill-rule="evenodd" d="M13 37.2A4.4 4.4 0 1 1 13 46 4.4 4.4 0 1 1 13 37.2Zm0 3A1.4 1.4 0 1 1 13 43.2 1.4 1.4 0 1 1 13 40.2Z"/>
</svg>`;

export const markerHTML = (color, label) => `<span class="marker" style="--mk:${color}" title="${esc(label)}">${TRAIN_ICON}</span>`;

// The same locomotive, blown up as the brand mark and set behind the words.
// Identical artwork, identical treatment — solid gold with its glow — because
// the crisp little train is the good-looking one; a faint wash of it just reads
// as a smudge.
export const LOGO = `<div class="logo">
  <span class="logo-mark">${TRAIN_ICON}</span>
  <h1>Mexican Train</h1>
</div>`;
