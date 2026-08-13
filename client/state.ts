// Everything the client remembers between renders, in one object so there is
// exactly one answer to "what is on screen right now".
//
// The server is the authority on the game; `room` is the last snapshot it sent
// and is replaced wholesale. Everything else here is local to this browser —
// what you have selected, how you have arranged your hand, how big you like the
// tiles — and never leaves it.

export const S = {
  code: null, pid: null, name: localStorage.getItem('mt.name') || '',
  ws: null, room: null, connected: false, retry: 0,
  direct: null,             // a table we may enter without asking anything more

  sel: null, tab: 'scores', panel: false, unread: 0,
  pipMode: localStorage.getItem('mt.pips') === '1',
  expanded: new Set(), spectate: false,
  handOrder: [], flipped: new Set(), arrange: false, dragging: false, suppressClick: false,
  zoom: (() => { const z = Number(localStorage.getItem('mt.zoom')); return z >= 24 && z <= 76 ? z : 0; })(),

  // What the last snapshot looked like, so the next one can be compared against
  // it — which noise to make, whose last tile to call, whether the end-of-round
  // card has already been shown for this round.
  lastTurn: null, lastPlayKey: null, shownEnd: null, lastFeet: 0, lastOnOne: '',

  // Painting state: whether the current shell is built, and how many tiles are
  // already drawn on each branch so a repaint only appends the new ones.
  built: false, laneN: {},
};
