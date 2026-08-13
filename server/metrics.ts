// Usage telemetry: how much the game is actually being played.
//
// Deliberately not the logs. Logs answer "what broke, and where"; this answers
// "is anyone playing", and the two bill differently — Workers Logs charges per
// line, so counting things there would mean paying per count. Nothing in this
// file ever writes a log line for an ordinary sample.
//
// A sample goes two places at once:
//
//   counters  a fixed set of running totals in this process. Free, bounded,
//             and on the Node host they are the whole answer — /api/stats reads
//             them back. In a Worker they are per-isolate and therefore
//             meaningless, which is why nothing there reports them.
//   sink      whatever the host installed. The Worker points this at Analytics
//             Engine, which is written to rather than logged and so is not
//             billed by the line. Node leaves it unset.
//
// Two rules hold everywhere: recording a sample is never awaited, and it can
// never throw. Telemetry that can break a request costs more than it is worth,
// so a sink that fails is dropped — reported once a minute at most, because a
// binding that has stopped accepting writes is worth knowing about and worth
// exactly one line to say so.

import { log } from './log.js';
import type { FunnelEvent, Foot, Scoring } from '../shared/protocol.js';

/** Why a table was cleared. Short and closed, so it groups — the sentence the
 *  players are shown is a different thing and lives with them. */
export type ClearedWhy = 'empty' | 'idle' | 'other';

/** Everything a finished table was worth knowing, gathered at the one moment
 *  all of it is finally true. Exactly one of these per table, ever. */
export interface TableSample {
  why: ClearedWhy;
  scoring: Scoring;
  /** The double-N set and the foot rule the table settled on — which variants
   *  people actually choose, as opposed to which ones we offer. */
  max: number;
  foot: Foot;
  ageMin: number;
  /** The most people ever seated at once, not the number left at the end. A
   *  lobby seat is spliced out when its player leaves, so by the time a table
   *  is cleared the count is almost always zero and says nothing. */
  peakPlayers: number;
  peakWatchers: number;
  /** Distinct human seats ever taken, and bots ever added. */
  humans: number;
  bots: number;
  /** Rounds reached and whether one of them was the last — a game finished, as
   *  opposed to a table where people dealt once and drifted off. */
  rounds: number;
  finished: boolean;
  moves: number;
}

/** What a host has to provide to receive samples. Structural on purpose: this
 *  file is shared with the Node build, which has no idea what a Cloudflare
 *  binding is. Either method may be absent — a host that can record tables but
 *  not funnel events is a normal state, not a broken one. */
export interface Sink {
  table?(s: TableSample): void;
  funnel?(e: FunnelEvent): void;
}

let sink: Sink | null = null;

/** Install the host's sink, or pass null to go back to counters alone. Called
 *  at boot, the way setLevel() is. */
export const setSink = (s: Sink | null): void => { sink = s; };

// A fixed key set — every key below is a literal, so this cannot grow with
// traffic the way a map keyed by anything a stranger picks would.
const counts = new Map<string, number>();
const bump = (key: string, by = 1): void => { counts.set(key, (counts.get(key) ?? 0) + by); };

// The sink is the one part of this that talks to the outside world, so it is
// the one part that can fail. Keyed on the fault so a newly broken binding
// still reports immediately rather than hiding behind an old one.
function toSink(fn: (s: Sink) => void): void {
  if (!sink) return;
  try { fn(sink); }
  catch (e) { log.throttle('warn', 'metric_dropped', { err: e }, `metric:${e instanceof Error ? e.message : String(e)}`); }
}

export const metrics = {
  /** One table, finished with. */
  table(s: TableSample): void {
    bump('tables');
    bump(`cleared.${s.why}`);
    if (s.rounds) bump('games');
    if (s.finished) bump('games.finished');
    bump('players', s.humans);
    bump('bots', s.bots);
    bump('watchers', s.peakWatchers);
    bump('moves', s.moves);
    bump('rounds', s.rounds);
    bump('tableMinutes', s.ageMin);
    toSink((k) => k.table?.(s));
  },

  /** One step on the way to a table, reported by a browser. */
  funnel(e: FunnelEvent): void {
    bump(`funnel.${e}`);
    toSink((k) => k.funnel?.(e));
  },

  /** A funnel event that was refused — throttled, or a name we don't know.
   *  Counted rather than logged: the endpoint exists to be cheap, and a line
   *  per refusal would hand a stranger the logging bill. */
  refused(): void { bump('funnel.refused'); },

  /** Everything counted since this process started. */
  snapshot(): Record<string, number> { return Object.fromEntries([...counts].sort()); },

  /** Tests share one process, so they need a way back to zero. */
  reset(): void { counts.clear(); },
};

// The names the funnel accepts, as a runtime list. A Record over the union is
// what makes this exhaustive: adding an event to FunnelEvent and forgetting it
// here fails the type check rather than the endpoint.
const KNOWN: Record<FunnelEvent, true> = {
  home: true, link: true, returned: true, made: true, code: true, seat: true, watch: true,
};

export const isFunnelEvent = (s: string): s is FunnelEvent => Object.hasOwn(KNOWN, s);
