// The seats this browser remembers.
//
// A table now outlives the tab it was opened in — an abandoned game is held
// long enough to sleep on — so the codes have to be findable again the next
// morning, when the link is three days up a group chat. That makes this the one
// place that knows how a remembered seat is stored, rather than the three that
// each built the key out of a string literal.
//
// All of it is per-browser and never sent anywhere. The server has no idea
// these exist and no way to ask.

const PID = 'mt.pid.', ROLE = 'mt.role.', SEEN = 'mt.seen.';

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
  for (const prefix of [PID, ROLE, SEEN]) localStorage.removeItem(prefix + code);
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
