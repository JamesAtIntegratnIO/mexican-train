// Node transport for Room: an in-memory registry, real sockets, and setTimeout.
// All the table logic lives in room-core.js, shared with the Cloudflare build.

import type { WebSocket } from 'ws';
import { Room, Err, newCode } from './room-core.js';
import type { Adapter, Conn, Limits, Seat, Watcher } from './room-core.js';
import type { PlayerId } from '../shared/protocol.js';
import { flagOn, num } from '../shared/flags.js';
import { log } from './log.js';

export { Err };
// Same trap as PORT: `Number(x) || default` would read MAX_ROOMS=0 as 500.
export const MAX_ROOMS = process.env.MAX_ROOMS ? Number(process.env.MAX_ROOMS) : 500;

// An abandoned lobby is a click to recreate; an abandoned game is somebody's
// evening. On this host both are held in process memory, so the long one is
// only affordable because createRoom() can make space — see evictEmptyLobby().
const LIMITS: Limits = {
  emptyLobbyMs: num(process.env.EMPTY_GRACE_MIN, 15) * 60_000,
  emptyGameMs: num(process.env.EMPTY_GRACE_GAME_MIN, 720) * 60_000,
  maxLifeMs: num(process.env.MAX_LIFETIME_HOURS, 24) * 3_600_000,
};

// Off unless a deployment asks for it. A table nobody can talk in is a table
// nobody can use to talk about anything.
const CHAT = flagOn(process.env.CHAT_ENABLED);

export const rooms = new Map<string, Room>();

/** Who a socket is, is a closure variable over in sockets.ts — which is exactly
 *  where the room can't reach it, and a watcher handed a seat has to stop being
 *  a watcher on the very socket they were watching from. This is the way back
 *  in: sockets.ts files its session here, and `identify` below rewrites it.
 *  Weak, so a closed socket takes its session with it. */
export const sessionOf = new WeakMap<object, { me: Seat | Watcher | null }>();

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
    identify(conn: Conn, id: PlayerId) {
      const session = sessionOf.get(conn as object);
      if (session) session.me = getRoom().member(id) ?? null;
    },
    cancelBot() { if (timer) clearTimeout(timer); timer = null; },
    scheduleBot(delay: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; getRoom().runBot(); }, delay);
    },
  };
}

// The cheapest thing in the process to lose: nobody is in it, and no hand is at
// stake. Abandoned *games* are deliberately never taken — turning someone away
// is better than deleting the evening they were coming back to — so a process
// full of held games still refuses, which is the honest answer.
function evictEmptyLobby(): boolean {
  let oldest: Room | null = null;
  for (const room of rooms.values()) {
    if (room.game || room.emptySince === null) continue;
    if (!oldest || room.emptySince < oldest.emptySince!) oldest = room;
  }
  if (!oldest) return false;
  oldest.dispose('evicted');
  rooms.delete(oldest.code);
  return true;
}

export function createRoom(): Room {
  if (rooms.size >= MAX_ROOMS) evictEmptyLobby();
  if (rooms.size >= MAX_ROOMS) {
    // Being full means every further attempt lands here, so throttle it.
    log.throttle('warn', 'at_capacity', { rooms: rooms.size, max: MAX_ROOMS });
    throw new Err('The server is at capacity — try again shortly.');
  }
  let code;
  do { code = newCode(); } while (rooms.has(code));
  let room: Room;
  room = new Room(code, nodeAdapter(() => room), { chat: CHAT });
  rooms.set(code, room);
  // Debug, not info: room_disposed tells the same story and more — how long the
  // table lived and whether anyone actually played — so paying for a line at
  // both ends of every table buys nothing.
  log.debug('room_created', { code, rooms: rooms.size });
  return room;
}

// Sweep abandoned rooms so memory stays flat. A table with anyone still on it
// is never touched short of the ceiling, however long they sit there thinking.
export function sweep(now = Date.now()): number {
  let removed = 0;
  for (const [code, room] of rooms) {
    const why = room.expiry(LIMITS, now);
    if (!why) continue;
    room.dispose(why);
    rooms.delete(code);
    removed++;
  }
  // No summary line: dispose() already logged each room it took, and saying so
  // twice is a line per sweep that carries nothing new.
  return removed;
}
setInterval(() => sweep(), 60_000).unref();
