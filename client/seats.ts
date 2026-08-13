// What this browser remembers about a table: the seat it holds there, and the
// way it had the hand laid out.
//
// A table now outlives the tab it was opened in — an abandoned game is held
// long enough to sleep on — so the codes have to be findable again the next
// morning, when the link is three days up a group chat. That makes this the one
// place that knows how any of it is stored, rather than the several that would
// each build the key out of a string literal, and the one place `forget()` has
// to look to leave nothing behind.
//
// All of it is per-browser and never sent anywhere. The server has no idea
// these exist and no way to ask.

const PID = 'mt.pid.', ROLE = 'mt.role.', SEEN = 'mt.seen.', HAND = 'mt.hand.';

export interface RememberedSeat {
  code: string;
  /** When we were last at this table, or 0 for a seat saved before this browser
   *  started keeping track. Sorts those last, which is the right place for them. */
  seen: number;
}

export const seatAt = (code: string): string | null => localStorage.getItem(PID + code);
export const watchingAt = (code: string): boolean => localStorage.getItem(ROLE + code) === 'watch';

export function remember(code: string, pid: string): void {
  localStorage.setItem(PID + code, pid);
  localStorage.setItem(SEEN + code, String(Date.now()));
}

export function rememberRole(code: string, spectate: boolean): void {
  localStorage.setItem(ROLE + code, spectate ? 'watch' : 'play');
}

export function forget(code: string): void {
  for (const prefix of [PID, ROLE, SEEN, HAND]) localStorage.removeItem(prefix + code);
}

/** How you had your hand laid out — your own order, which tiles you turned
 *  around, and the sets you folded up. Held against the round it was made in,
 *  because an order naming last round's tiles means nothing this one. */
export interface HandMemory {
  round: number;
  order: string[];
  stacked: string[][];
  flipped: string[];
}

// Arranging a hand is real work, and until now the only thing that survived a
// reload was the seat — so a stray back swipe on a phone, which is a thumb's
// width from every other gesture, cost you all of it. It is a display
// preference like the tile size, so it is kept the same way and goes no further
// than this browser.
export function keepHand(code: string, m: HandMemory): void {
  try { localStorage.setItem(HAND + code, JSON.stringify(m)); } catch {}   // a full or locked-down store is not worth a crash
}

export function savedHand(code: string): HandMemory | null {
  try {
    const m = JSON.parse(localStorage.getItem(HAND + code) || 'null');
    return m && Array.isArray(m.order) && Array.isArray(m.stacked) && Array.isArray(m.flipped) ? m : null;
  } catch { return null; }
}

/** Every table this browser still holds a seat at, most recent first. Some will
 *  have expired since — only the server knows which, so the caller has to ask. */
export function remembered(): RememberedSeat[] {
  const out: RememberedSeat[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PID)) continue;
    const code = key.slice(PID.length);
    out.push({ code, seen: Number(localStorage.getItem(SEEN + code)) || 0 });
  }
  return out.sort((a, b) => b.seen - a.seen);
}
