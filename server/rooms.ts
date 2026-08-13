// Node transport for Room: an in-memory registry, real sockets, and setTimeout.
// All the table logic lives in room-core.js, shared with the Cloudflare build.

import type { WebSocket } from 'ws';
import { Room, Err, newCode } from './room-core.js';
import type { Adapter, Conn } from './room-core.js';
import { log } from './log.js';

export { Err };
// Same trap as PORT: `Number(x) || default` would read MAX_ROOMS=0 as 500.
export const MAX_ROOMS = process.env.MAX_ROOMS ? Number(process.env.MAX_ROOMS) : 500;

// A game of 13 rounds takes hours, so nothing expires while it is being played.
const EMPTY_GRACE_MS = Number(process.env.EMPTY_GRACE_MIN || 15) * 60 * 1000;
const IDLE_MS = Number(process.env.IDLE_MIN || 30) * 60 * 1000;

export const rooms = new Map<string, Room>();

// Connections are the WebSocket objects themselves here — the core only ever
// hands them back to us, so they can be anything.
function nodeAdapter(getRoom: () => Room): Adapter {
  let timer: NodeJS.Timeout | null = null;
  return {
    // The core hands back whatever it was given, so this is the one place that
    // knows a connection is really a ws socket.
    send(conn: Conn, obj: unknown) {
      const ws = conn as WebSocket;
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch {}
    },
    close(conn: Conn, code: number, reason: string) { try { (conn as WebSocket).close(code, reason); } catch {} },
    cancelBot() { if (timer) clearTimeout(timer); timer = null; },
    scheduleBot(delay: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; getRoom().runBot(); }, delay);
    },
  };
}

export function createRoom(): Room {
  if (rooms.size >= MAX_ROOMS) {
    // Being full means every further attempt lands here, so throttle it.
    log.throttle('warn', 'at_capacity', { rooms: rooms.size, max: MAX_ROOMS });
    throw new Err('The server is at capacity — try again shortly.');
  }
  let code;
  do { code = newCode(); } while (rooms.has(code));
  let room: Room;
  room = new Room(code, nodeAdapter(() => room));
  rooms.set(code, room);
  // Debug, not info: room_disposed tells the same story and more — how long the
  // table lived and whether anyone actually played — so paying for a line at
  // both ends of every table buys nothing.
  log.debug('room_created', { code, rooms: rooms.size });
  return room;
}

// Sweep abandoned rooms so memory stays flat. A table in active play is never
// touched, however long the game runs.
export function sweep(now = Date.now()): number {
  let removed = 0;
  for (const [code, room] of rooms) {
    const reason = room.expiry(EMPTY_GRACE_MS, IDLE_MS, now);
    if (!reason) continue;
    room.dispose(reason);
    rooms.delete(code);
    removed++;
  }
  // No summary line: dispose() already logged each room it took, and saying so
  // twice is a line per sweep that carries nothing new.
  return removed;
}
setInterval(() => sweep(), 60_000).unref();
