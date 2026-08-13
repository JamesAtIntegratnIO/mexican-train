// The socket, the reconnect ladder, and the messages the network layer can
// answer on its own. Anything that needs the table redrawn is handed back out
// through the hooks given to connect(), so this module never imports a view and
// the import graph stays one-way.

import { $, toast } from './dom.js';
import { S } from './state.js';
import { Snd } from './sound.js';
import type { ClientMessage, ServerMessage, RoomSnapshot, DrewMessage } from '../shared/protocol.js';

/** What the socket hands outward when a message needs the table redrawn. Passed
 *  in rather than imported, so this module never depends on a view. */
export interface Hooks {
  room(m: RoomSnapshot): void;
  fatal(msg: string): void;
}

let hooks: Hooks = { room: () => {}, fatal: () => {} };

export function connect(code: string, newHooks?: Hooks): void {
  if (newHooks) hooks = newHooks;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?code=${encodeURIComponent(code)}`);
  S.ws = ws;

  ws.onopen = () => {
    S.connected = true; S.retry = 0; paintConn();
    send({ t: 'join', pid: localStorage.getItem('mt.pid.' + code) || null, name: S.name, spectate: S.spectate });
  };
  ws.onmessage = (e: MessageEvent) => {
    let m: ServerMessage;
    try { m = JSON.parse(e.data); } catch { return; }   // not ours to make sense of
    onMessage(m, code, ws);
  };
  ws.onclose = () => {
    S.connected = false;
    if (!S.ws) return;                       // deliberate teardown
    if (S.retry > 8) return hooks.fatal('Lost connection to the table. Reload to rejoin.');
    const delay = Math.min(1000 * 2 ** S.retry++, 8000);
    paintConn();                             // stale state is worse unlabelled than labelled
    setTimeout(() => connect(code), delay);
  };
  ws.onerror = () => {};
}

export const send = (o: ClientMessage): void => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };

function onMessage(m: ServerMessage, code: string, ws: WebSocket): void {
  if (m.t === 'you') { S.pid = m.pid; localStorage.setItem('mt.pid.' + code, m.pid); return; }
  if (m.t === 'room') return hooks.room(m);
  if (m.t === 'error') return toast(m.msg, 'err');
  if (m.t === 'drew') return announceDraw(m);
  // The server only says this when the table is gone or it turned us away, so
  // the saved seat is worthless — drop it, or every return trip to this URL
  // reconnects straight back into the same refusal instead of the join gate.
  if (m.t === 'fatal') {
    localStorage.removeItem('mt.pid.' + code);
    S.ws = null; ws.close();
    return hooks.fatal(m.msg);
  }
}

// Only the drawer is told what came off the boneyard, so this is the one place
// that tile is ever named.
function announceDraw(m: DrewMessage): void {
  const t = m.tile.replace('-', ' | ');
  if (m.engine) { Snd.win(); return toast(`Drew ${t} — the engine! Lay it to start.`); }
  Snd.draw();
  toast(m.seeking ? `Drew ${t} — not the engine`
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
