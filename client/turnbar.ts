// The bar above your hand: what the table is waiting for, and the button for it.
//
// The server decides what you owe it — `game.prompt` — so this module only
// chooses the words. That keeps the client from having a second, drifting
// opinion about whose turn it is and what is legal.

import { $, esc } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { send } from './net.js';
import { showEndModal, handOver } from './modals.js';
import type { GameView, TrainView } from '../shared/protocol.js';

/** How the bar should look: a modifier class, the message, and any buttons. */
interface BarState {
  cls: string;
  msg: string;
  actions: string;
}

export function paintTurnbar(g: GameView): void {
  const bar = $<HTMLElement>('#turnbar');
  const yours = g.turn === S.pid;
  const myTrain = g.trains.find((t) => t.owner === S.pid);
  const { cls, msg, actions } = turnState(g, yours);

  // Markers are fully manual, and not only on your turn — playing a tile ends
  // your turn, so a marker you meant to take down afterwards would otherwise
  // have to stay up until the table had been all the way round.
  const marker = g.status === 'playing' && g.phase === 'play' && myTrain ? markerButton(myTrain) : '';

  bar.className = `turnbar ${cls}`;
  bar.innerHTML = `<div class="msg">${msg}</div>${S.arrange ? '' : marker + actions}`;
  bar.onclick = (e: Event) => onTurnbarClick(e, g);
}

function turnState(g: GameView, yours: boolean): BarState {
  // Arrange mode changes what a tap does, so it has to own the message —
  // otherwise "tap a tile" is a lie while tapping turns tiles around.
  if (S.arrange && !S.room!.spectating) {
    return {
      cls: 'arranging', actions: '',
      msg: yours ? '<span>Arranging — done? tap <b>⇄ Arrange</b> to play</span>' : '<span>Arranging your hand</span>',
    };
  }
  if (g.status !== 'playing') {
    return {
      cls: '',
      msg: g.status === 'gameOver' ? 'Game over' : 'Round over',
      actions: '<button class="btn sm" data-act="scores">See scores</button>',
    };
  }
  if (yours) return { cls: 'you', ...yourPrompt(g) };
  return { cls: '', ...waitingOn(g) };
}

// Nobody's hand is played for them, so a table waiting on someone who has
// dropped waits as long as it takes. The host is the way out of that, and the
// button only appears where the wait actually is — on the turn that is stuck.
// With nobody watching there is only one thing it can do, so it does it; with
// somebody watching there is a choice to make, and the card makes it.
function waitingOn(g: GameView): Omit<BarState, 'cls'> {
  const who = g.players.find((p) => p.id === g.turn);
  const stuck = !!who && !who.bot && !who.connected && S.room!.hostId === S.pid;
  const anyoneWatching = S.room!.watchers.some((w) => w.connected);
  return {
    msg: waitingFor(g),
    actions: stuck
      ? `<button class="btn sm" data-act="seat" data-id="${esc(who!.id)}" data-nm="${esc(who!.name)}"
           title="${esc(who!.name)} takes the seat back off a bot when they return">${
             anyoneWatching ? 'Hand over the seat' : 'Hand to a bot'}</button>`
      : '',
  };
}

// What the server says you owe the table, and the button for it.
function yourPrompt(g: GameView): Omit<BarState, 'cls'> {
  if (g.prompt === 'engine') {
    return {
      msg: `<span>You have the double ${g.engine} — lay it to start the round</span>`,
      actions: `<button class="btn primary sm" data-act="engine">Lay the double ${g.engine}</button>`,
    };
  }
  if (g.prompt === 'seek') {
    return {
      msg: `<span>No double ${g.engine} in your hand — draw until it turns up</span>`,
      actions: '<button class="btn primary sm" data-act="draw">Draw a tile</button>',
    };
  }
  if (g.prompt === 'play') {
    // Mid-lift the branch is already under the tile, so it is a drop rather than
    // a second tap — and with nothing picked yet, say that carrying one works.
    const msg = S.dragging ? 'Drop it on a glowing branch'
      : S.sel ? 'Now tap a glowing branch'
      : 'Your turn — tap a tile, or drag it over';
    return { msg: `<span>${msg}</span>`, actions: '' };
  }
  if (g.prompt === 'draw') {
    return {
      msg: '<span>No play — draw from the boneyard</span>',
      actions: '<button class="btn primary sm" data-act="draw">Draw a tile</button>',
    };
  }
  return {
    msg: '<span>Nothing playable and the boneyard is empty</span>',
    actions: '<button class="btn primary sm" data-act="pass">End turn &amp; mark</button>',
  };
}

function waitingFor(g: GameView): string {
  const who = g.players.find((p) => p.id === g.turn);
  const lead = S.room!.spectating ? '<span class="chip">watching</span>' : '<span class="spinner"></span>';
  // Someone whose turn it is and who isn't here is a different kind of wait
  // from someone thinking, and it lasts a lot longer — so say which it is
  // rather than leaving the table staring at a spinner wondering.
  if (who && !who.bot && !who.connected) {
    return `${lead}<span>Waiting for ${esc(who.name)} to come back…</span>`;
  }
  const what = g.phase === 'seeking' ? `is drawing for the double ${g.engine}…` : 'is thinking…';
  return `${lead}<span>${esc(who ? who.name : '…')} ${what}</span>`;
}

const markerButton = (t: TrainView): string =>
  `<button class="btn sm marker-btn ${t.open ? 'up' : ''}" data-act="marker" data-up="${t.open ? 0 : 1}"
     title="${t.open ? 'Close your train again' : 'Open your train to everyone'}"><span class="pip"></span>${t.open ? 'Marker down' : 'Marker up'}</button>`;

function onTurnbarClick(e: Event, g: GameView): void {
  const b = (e.target as Element).closest<HTMLElement>('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'draw') send({ t: 'draw' });
  if (act === 'engine') { Snd.clack(); send({ t: 'engine' }); }
  if (act === 'pass') send({ t: 'pass' });
  if (act === 'marker') { Snd.tap(); send({ t: 'marker', up: b.dataset.up === '1' }); }
  if (act === 'seat') handOver(b.dataset.id!, b.dataset.nm!);
  if (act === 'scores') showEndModal(g);
}
