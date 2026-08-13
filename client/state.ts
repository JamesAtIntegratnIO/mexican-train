// Everything the client remembers between renders, in one object so there is
// exactly one answer to "what is on screen right now".
//
// The server is the authority on the game; `room` is the last snapshot it sent
// and is replaced wholesale. Everything else here is local to this browser —
// what you have selected, how you have arranged your hand, how big you like the
// tiles — and never leaves it.

import type { RoomSnapshot, TileId, PlayerId } from '../shared/protocol.js';

/** One slot in your hand's layout: a tile you hold, or a divider you dropped in
 *  to keep planned runs apart. Divider ids are `|1`, `|2`, … — never a tile id,
 *  which is always two numbers joined by a hyphen. Dividers are yours alone and
 *  never go anywhere near the server. */
export type HandItem = string;

export interface ClientState {
  code: string | null;
  pid: PlayerId | null;
  name: string;
  ws: WebSocket | null;
  room: RoomSnapshot | null;
  connected: boolean;
  retry: number;
  direct: string | null;

  sel: TileId | null;
  tab: 'scores' | 'log' | 'chat';
  panel: boolean;
  unread: number;
  pipMode: boolean;
  expanded: Set<string>;
  spectate: boolean;
  handOrder: HandItem[];
  /** The sets you have folded up, each held as the run of tiles it folded rather
   *  than as a position, so a stack survives being dragged elsewhere. */
  stacked: TileId[][];
  flipped: Set<TileId>;
  arrange: boolean;
  dragging: boolean;
  suppressClick: boolean;
  zoom: number;

  lastTurn: PlayerId | null;
  lastPlayKey: string | null;
  shownEnd: string | null;
  lastFeet: number;
  lastOnOne: string;

  built: boolean;
  /** How many tiles are already drawn on each branch, keyed `trainId:segId`. */
  laneN: Record<string, number>;
}

export const S: ClientState = {
  code: null, pid: null, name: localStorage.getItem('mt.name') || '',
  ws: null, room: null, connected: false, retry: 0,
  direct: null,             // a table we may enter without asking anything more

  sel: null, tab: 'scores', panel: false, unread: 0,
  pipMode: localStorage.getItem('mt.pips') === '1',
  expanded: new Set(), spectate: false,
  handOrder: [], stacked: [], flipped: new Set(), arrange: false, dragging: false, suppressClick: false,
  zoom: (() => { const z = Number(localStorage.getItem('mt.zoom')); return z >= 24 && z <= 76 ? z : 0; })(),

  // What the last snapshot looked like, so the next one can be compared against
  // it — which noise to make, whose last tile to call, whether the end-of-round
  // card has already been shown for this round.
  lastTurn: null, lastPlayKey: null, shownEnd: null, lastFeet: 0, lastOnOne: '',

  // Painting state: whether the current shell is built, and how many tiles are
  // already drawn on each branch so a repaint only appends the new ones.
  built: false, laneN: {},
};
