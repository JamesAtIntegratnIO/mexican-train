// Mexican Train — client. Vanilla ES modules, no build step: the browser loads
// these files directly, so what you debug is what shipped.
//
// The imports run strictly one way, top to bottom, and there are no cycles:
//
//   dom · state · sound        leaves — no imports of ours at all
//   tiles                      how a domino and a player are drawn
//   net · actions              the socket, and the one thing a click sends
//   lanes · modals             the board, and the cards that cover it
//   lobby · table              the two screens a table can be showing
//   session                    what a fresh snapshot means
//   entry                      how you get to a table in the first place
//   app                        this file: page-level wiring, then go
//
// net.js is the one that would have made a cycle — it needs the table redrawn
// when a snapshot lands — so it takes that as a hook from entry.js instead of
// importing a view.

import { $, toast } from './dom.js';
import { Snd } from './sound.js';
import { applyPipMode, applyZoom } from './tiles.js';
import { route, go } from './entry.js';

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b && b.dataset.go === 'home') go('/');
}, true);

// Registered once, not per rebuild — the table shell is built many times a session.
document.addEventListener('click', () => {
  const pop = $('#displayPop');
  if (pop && !pop.hidden) pop.hidden = true;
});

// Browsers keep audio suspended until a real gesture — unlock on the first one.
addEventListener('pointerdown', () => Snd.ready(), { once: true });

// Most of this client builds the table by writing HTML strings, so a throw part
// way through leaves a board on screen that looks live and isn't. There is
// nowhere to report that to, so the least we owe the player is to stop them
// trusting it. Rate-limited, because one bad render usually means the next one
// fails too and a stack of identical toasts helps nobody.
let lastGrumble = 0;
function surfaceCrash(detail) {
  console.error(detail);
  if (Date.now() - lastGrumble < 10_000) return;
  lastGrumble = Date.now();
  toast('Something went wrong drawing the table — reload if it looks stuck.', 'err');
}
addEventListener('error', (e) => surfaceCrash(e.error || e.message));
addEventListener('unhandledrejection', (e) => surfaceCrash(e.reason));

applyPipMode();
applyZoom();
route();
