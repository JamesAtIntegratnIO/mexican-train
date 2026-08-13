// Structured logs — one JSON object per line.
//
// Both hosts capture stdout and nothing else: Fly ships it to its log stream,
// Workers to the tail enabled by [observability] in wrangler.toml. So a log
// line is the only forensic trail either build leaves behind, which is why
// every one of them carries the table code — without it you get a stack trace
// and no way to tell which game it came from.
//
// Workers Logs bills per line, so volume is a cost and the budget is spent
// deliberately:
//
//   error  something is broken and someone should look. Never fires in a
//          healthy run, so it is never a volume question.
//   warn   someone is being turned away — throttled, see below.
//   info   lifecycle only: the process starting and stopping, and a table
//          opening and closing. Two lines per table is the entire usage
//          signal for the Workers build, which has no room registry to count.
//   debug  per-connection detail. Off unless LOG_LEVEL says otherwise, and
//          not something to leave on in production.
//
// Deliberately not logged: hands, chat bodies, player names. Ids are enough to
// follow a bug across lines and none of the rest would help.

export type Level = 'error' | 'warn' | 'info' | 'debug';

/** Anything worth attaching to a line. `err` is pulled out and unpacked by
 *  errFields(); everything else is copied through as-is. */
export type Fields = Record<string, unknown> | undefined;

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS.info;

// Node reads LOG_LEVEL from the environment, the Worker from its vars; both
// call this at boot. An unknown name leaves the default alone rather than
// silently muting the logs.
export function setLevel(name?: string): string {
  if (name && Object.hasOwn(LEVELS, name)) threshold = LEVELS[name as Level];
  return Object.keys(LEVELS)[threshold]!;
}

// Errors don't survive JSON.stringify — keep the parts worth having. The stack
// is trimmed because the frames past the throw site are the same every time.
const errFields = (e: unknown): Record<string, string> =>
  e instanceof Error
    ? { err: e.message, stack: (e.stack || '').split('\n').slice(1, 5).map((s) => s.trim()).join(' | ') }
    : { err: String(e) };

function emit(level: Level, evt: string, fields?: Fields): void {
  if (LEVELS[level] > threshold) return;
  const { err, ...rest } = fields || {};
  const line = { ts: new Date().toISOString(), level, evt, ...rest, ...(err === undefined ? {} : errFields(err)) };
  // Logging must never be the thing that breaks a request, so a value that
  // won't serialise costs us that one field, not the line.
  let text: string;
  try { text = JSON.stringify(line); } catch { text = JSON.stringify({ ts: line.ts, level, evt, unserialisable: true }); }
  (LEVELS[level] <= LEVELS.warn ? console.error : console.log)(text);
}

// Events driven by whoever is hammering the server — a rejected origin, a
// flood-closed socket, a 429 — matter as "this is happening", not as one line
// each. Left unthrottled, the cheapest way to run up a logging bill would be to
// attack us, which is a poor arrangement. So the first one goes out
// immediately and the rest collapse into a count carried by the next line to
// escape the window.
//
// No timers: a Durable Object between messages isn't running, and a pending
// flush would be a reason to keep it awake.
const WINDOW_MS = 60_000;
const windows = new Map<string, { since: number; held: number; last: Fields }>();

function throttle(level: Level, evt: string, fields?: Fields, key: string = evt): void {
  const now = Date.now();
  const w = windows.get(key);
  if (w && now - w.since < WINDOW_MS) { w.held++; w.last = fields; return; }
  if (w?.held) emit(level, evt, { ...w.last, alsoSeen: w.held, overMs: now - w.since });
  // Distinct keys are bounded by event names, except where a caller keys by
  // error text; drop the lot rather than grow without limit.
  if (windows.size > 200) windows.clear();
  windows.set(key, { since: now, held: 0, last: fields });
  emit(level, evt, fields);
}

export const log = {
  error: (evt: string, fields?: Fields) => emit('error', evt, fields),
  warn: (evt: string, fields?: Fields) => emit('warn', evt, fields),
  info: (evt: string, fields?: Fields) => emit('info', evt, fields),
  debug: (evt: string, fields?: Fields) => emit('debug', evt, fields),
  // Same levels, but at most one line a minute per `key`. Use for anything a
  // stranger can trigger on repeat, and for faults that recur every turn.
  throttle,
};
