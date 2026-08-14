// The socket, the reconnect ladder, and the messages the network layer can
// answer on its own. Anything that needs the table redrawn is handed back out
// through the hooks given to connect(), so this module never imports a view and
// the import graph stays one-way.

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import { seatAt, remember, forget } from './seats.js';
import type { ClientMessage, ServerMessage, RoomSnapshot, DrewMessage } from '../shared/protocol.js';

/** What the socket hands outward when a message needs the table redrawn. Passed
 *  in rather than imported, so this module never depends on a view. */
export interface Hooks {
  room(m: RoomSnapshot): void;
  fatal(msg: string): void;
}

let hooks: Hooks = { room: () => {}, fatal: () => {} };

/** The table we mean to have a socket to, or null once we have let go of one on
 *  purpose. Only a socket answering to this is worth chasing when it closes.
 *
 *  This is what a back swipe broke. Leaving the table and coming straight back
 *  used to open a second socket beside the first and leave the first running;
 *  its close then arrived against the live one, and the reconnect ladder it set
 *  off replaced the good socket with another, and another. The bar said
 *  "Reconnecting" and meant it, and only a reload ever got out of it. */
let want: string | null = null;

export function connect(code: string, newHooks?: Hooks): void {
  if (newHooks) hooks = newHooks;
  want = code;
  // Never two sockets to one table. The one being replaced is let go here, and
  // its close is ignored below because S.ws has already moved past it.
  const stale = S.ws; S.ws = null;
  if (stale) stale.close();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?code=${encodeURIComponent(code)}`);
  S.ws = ws;

  ws.onopen = () => {
    S.connected = true; S.retry = 0; paintConn();
    send({ t: 'join', pid: seatAt(code), name: S.name, spectate: S.spectate });
  };
  ws.onmessage = (e: MessageEvent) => {
    if (S.ws !== ws) return;                 // a socket this tab has moved past
    settle();                                // anything at all proves it still alive
    let m: ServerMessage;
    try { m = JSON.parse(e.data); } catch { return; }   // not ours to make sense of
    onMessage(m, code, ws);
  };
  ws.onclose = () => { if (S.ws === ws) lost(code, ws); };
  ws.onerror = () => {};
}

// The socket we are actually using has gone. Climb the ladder — unless we have
// let this table go, in which case its closing is the point rather than a fault.
function lost(code: string, ws: WebSocket): void {
  S.connected = false;
  if (want !== code) return;
  if (S.retry > 8) return hooks.fatal('Lost connection to the table. Reload to rejoin.');
  const delay = Math.min(1000 * 2 ** S.retry++, 8000);
  paintConn();                               // stale state is worse unlabelled than labelled
  setTimeout(() => { if (S.ws === ws) connect(code); }, delay);
}

/** Let go of a table on purpose — walking away from it, rather than dropping
 *  out of it. Nothing is left behind to reconnect or to report. */
export function disconnect(): void {
  want = null; settle();
  const ws = S.ws;
  S.ws = null; S.connected = false;
  if (ws) ws.close();
  const bar = $<HTMLElement>('#connbar'); if (bar) bar.remove();
}

export const send = (o: ClientMessage): void => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };

function onMessage(m: ServerMessage, code: string, ws: WebSocket): void {
  if (m.t === 'you') { S.pid = m.pid; remember(code, m.pid); return; }
  if (m.t === 'room') return hooks.room(m);
  if (m.t === 'error') return toast(m.msg, 'err');
  if (m.t === 'drew') return announceDraw(m);
  // The server only says this when the table is gone or it turned us away, so
  // the saved seat is worthless — drop it, or every return trip to this URL
  // reconnects straight back into the same refusal instead of the join gate.
  if (m.t === 'fatal') {
    forget(code);
    want = null; S.ws = null; ws.close();
    return hooks.fatal(m.msg);
  }
}

// ---------------------------------------------------------------- coming back

/** How long a socket that claims to be open has to prove it, once we are back
 *  in front of it. */
const PROBE = 3000;
let probe: ReturnType<typeof setTimeout> | null = null;
const settle = (): void => { if (probe) { clearTimeout(probe); probe = null; } };

// Back on screen: the tab was hidden, or the page has been pulled out of the
// back/forward cache after a swipe. Both freeze the socket, and freeze the
// backoff timer that would have noticed — so a table that dropped while we were
// away sits there looking live, or spinning at a ladder that has stopped
// climbing. Ask again now rather than at the end of a wait that never ticked.
//
// A restored socket is worse than a closed one: it still reads as open. So one
// that claims to be gets asked to say something, and is replaced if it can't.
export function revive(): void {
  if (!want || probe) return;
  if (!S.ws || S.ws.readyState > 1) { S.retry = 0; return connect(want); }
  if (S.ws.readyState === 0) return;          // still opening — its own close will chase it
  send({ t: 'ping' });
  probe = setTimeout(() => { probe = null; if (want) { S.retry = 0; connect(want); } }, PROBE);
}

addEventListener('pageshow', (e: PageTransitionEvent) => { if (e.persisted) revive(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) revive(); });

// Only the drawer is told what came off the boneyard, so this is the one place
// that tile is ever named.
function announceDraw(m: DrewMessage): void {
  const t = m.tile.replace('-', ' | ');
  if (m.engine) { Snd.win(); return toast(`Drew ${t} — the engine! Lay it to start.`); }
  Snd.draw();
  toast(m.seeking ? `Everyone drew — you got ${t}`
    : m.playable ? `Drew ${t} — you can play it`
      : `Drew ${t} — no play, marker up, turn over`);
}

// Anything on screen while the socket is down is stale — say so, and keep saying it.
export function paintConn(): void {
  let el = $<HTMLElement>('#connbar');
  if (S.connected) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'connbar'; el.className = 'connbar';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="spinner"></span><span>Reconnecting — what you see may be out of date</span>`;
}
