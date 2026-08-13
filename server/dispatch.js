// The one place a client message becomes a change at the table.
//
// Node holds the Room in memory; the Worker rebuilds it from storage on every
// wake. They differ in how a socket is found and how state is persisted, but
// not in what a message *means* — so the switch lives here, where the two
// builds can't quietly drift apart.
//
// `join` is the exception and stays with each host: it is the message that
// establishes identity, and identity is where the two genuinely differ (a
// closure variable on Node, a socket attachment in the Durable Object).

import { Err } from './room-core.js';

// Spectators are present and named, but they only get to talk.
export const SPECTATOR_OK = ['chat', 'ping', 'name'];

/**
 * Apply `msg` to `room` on behalf of `me`.
 * Returns { reply, mutated }:
 *   reply   — a message for this one socket, or null (broadcasts go via tick())
 *   mutated — whether the table changed. The Worker persists on true, and
 *             skips a storage write on false; pings are the case that matters,
 *             since a heartbeat must not cost a write per beat.
 * Throws Err for anything the player did wrong; the caller turns that into a
 * message they can read.
 */
export function dispatch(room, me, msg) {
  if (me.spectator && !SPECTATOR_OK.includes(msg.t)) throw new Err("You're watching this game.");

  switch (msg.t) {
    case 'ping': return { reply: { t: 'pong' }, mutated: false };

    case 'name': room.rename(me.id, msg.name); break;
    case 'settings': room.setSettings(me.id, msg.settings || {}); break;
    case 'addBot': room.addBot(me.id); break;
    case 'remove': room.removePlayer(me.id, msg.id); break;
    case 'fillSeat': room.fillSeat(me.id, msg.id); break;
    case 'start': room.start(me.id); break;
    case 'nextRound': room.nextRound(me.id); break;
    case 'playAgain': room.playAgain(me.id); break;
    case 'chat': room.chatFrom(me.id, msg.text); break;

    case 'play': case 'draw': case 'pass': case 'marker': case 'engine': {
      const r = room.act(me.id, msg);
      // Only the drawer learns what came off the boneyard; everyone else just
      // sees the count drop in the next snapshot.
      if (msg.t === 'draw' && r) {
        return { reply: { t: 'drew', tile: r.tile, playable: r.playable, engine: r.engine, seeking: 'engine' in r }, mutated: true };
      }
      break;
    }

    // An unknown verb is an old client or a probe. Ignore it — and don't let it
    // provoke a storage write.
    default: return { reply: null, mutated: false };
  }

  return { reply: null, mutated: true };
}
