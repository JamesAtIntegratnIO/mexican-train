// Node transport for Room: an in-memory registry, real sockets, and setTimeout.
// All the table logic lives in room-core.js, shared with the Cloudflare build.

import { Room, Err, newCode } from './room-core.js';

export { Err };
export const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;

// A game of 13 rounds takes hours, so nothing expires while it is being played.
const EMPTY_GRACE_MS = Number(process.env.EMPTY_GRACE_MIN || 15) * 60 * 1000;
const IDLE_MS = Number(process.env.IDLE_MIN || 30) * 60 * 1000;

export const rooms = new Map();

// Connections are the WebSocket objects themselves here — the core only ever
// hands them back to us, so they can be anything.
function nodeAdapter(getRoom) {
  let timer = null;
  return {
    send(ws, obj) {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch {}
    },
    close(ws, code, reason) { try { ws.close(code, reason); } catch {} },
    cancelBot() { clearTimeout(timer); timer = null; },
    scheduleBot(delay) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; getRoom().runBot(); }, delay);
    },
  };
}

export function createRoom() {
  if (rooms.size >= MAX_ROOMS) throw new Err('The server is at capacity — try again shortly.');
  let code;
  do { code = newCode(); } while (rooms.has(code));
  let room;
  room = new Room(code, nodeAdapter(() => room));
  rooms.set(code, room);
  return room;
}

// Sweep abandoned rooms so memory stays flat. A table in active play is never
// touched, however long the game runs.
export function sweep(now = Date.now()) {
  let removed = 0;
  for (const [code, room] of rooms) {
    const reason = room.expiry(EMPTY_GRACE_MS, IDLE_MS, now);
    if (!reason) continue;
    room.dispose(reason);
    rooms.delete(code);
    removed++;
  }
  return removed;
}
setInterval(() => sweep(), 60_000).unref();
