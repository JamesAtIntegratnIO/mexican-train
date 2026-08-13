// The Workers sink for server/metrics.js: Analytics Engine.
//
// Not the logs, because the logs are billed per line and that budget is spent
// on faults — counting a table there would mean paying per count. Analytics
// Engine is written to rather than logged, queried afterwards over the SQL API,
// and keeps no state between requests. That last part is what makes it the only
// thing that fits: a Worker has no memory that outlives a request, and unlike
// the Node build there is no room registry anywhere to count.
//
// Both datasets are optional bindings, handled the way the rate limiter is — a
// deploy without them has no usage telemetry, which is a choice someone may
// have made, not a fault to refuse to start over.
//
// Analytics Engine has no column names, only positions, so the layout below IS
// the query contract. Adding a column at the end is free; reordering one
// silently rewrites the meaning of every row already stored. There is room to
// grow: a point may carry 20 blobs, 20 doubles and one index of up to 96 bytes,
// and these use 2, 10, and five characters.
//
//   mt_tables  index1  why
//              blob1   why            blob2   scoring
//              double1 ageMin         double2 peakPlayers   double3 humans
//              double4 bots           double5 peakWatchers  double6 rounds
//              double7 finished 1|0   double8 moves         double9 max
//              double10 foot
//
//   mt_funnel  index1  event
//              blob1   event          — the same string, so a query can select
//                                       it without depending on the index
//              double1 1              — one row, one step
//
// The index is what Analytics Engine samples and groups by under load, so it
// holds the one low-cardinality dimension each dataset is most often sliced on.
//
// Sampling is why a count here is never COUNT(). Above a certain rate a stored
// row starts standing for several real ones, and `_sample_interval` says how
// many — so the count is SUM(_sample_interval), a total is
// SUM(_sample_interval * doubleN), and an average has to weight both halves.
// mt_funnel is the one most likely to reach that rate: it is the highest-volume
// thing we write, and sampling picks on busy index values, which is exactly
// what `home` would become.

import { setSink } from '../server/metrics.js';
import type { TableSample } from '../server/metrics.js';
import type { FunnelEvent } from '../shared/protocol.js';
import type { Env } from './env.js';

const point = (s: TableSample): AnalyticsEngineDataPoint => ({
  indexes: [s.why],
  blobs: [s.why, s.scoring],
  doubles: [s.ageMin, s.peakPlayers, s.humans, s.bots, s.peakWatchers, s.rounds, s.finished ? 1 : 0, s.moves, s.max, s.foot],
});

/** Point the shared metrics module at this Worker's bindings. Called wherever
 *  setLevel() is — once per isolate would do, but both are cheap and doing them
 *  together is what stops one being forgotten on a new entry point. */
export function useAnalytics(env: Env): void {
  const tables = env.TABLES, funnel = env.FUNNEL;
  if (!tables && !funnel) return setSink(null);
  setSink({
    table: tables && ((s: TableSample) => tables.writeDataPoint(point(s))),
    funnel: funnel && ((e: FunnelEvent) => funnel.writeDataPoint({ indexes: [e], blobs: [e], doubles: [1] })),
  });
}
