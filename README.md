# Mexican Train

Real-time online Mexican Train dominoes. Start a table, share the link, play. No
accounts, no database — sessions live in memory and vanish when everyone leaves.

```bash
nix develop      # or: direnv allow
npm install && npm run build && npm start
```

The flake pins Node 24, Terraform and jq; wrangler and esbuild come from
`package-lock.json`. Without Nix, Node 24+ and `npm install` are enough to run
the game locally.

Then open http://localhost:3000, hit **Start a new game**, and send the link to
your friends. They open it on their own phones or laptops and play in real time.

## Deploying

A table is a single piece of live state that several people mutate at once, so
it needs one owner. There are two supported ways to give it one.

### Cloudflare Workers + Durable Objects (recommended)

One Durable Object per table: a DO is a single addressable instance with its own
storage, which is exactly the guarantee a room needs. Sockets use WebSocket
Hibernation, so an idle table costs nothing and the bot clock runs on DO alarms
rather than timers. It fits inside the Workers **free** plan.

Infrastructure is Terraform, with state in R2 — see [terraform/README.md](terraform/README.md)
for the one-time setup.

**Analytics Engine has to be switched on for the account first**, at
[dash.cloudflare.com → Workers → Analytics Engine](https://dash.cloudflare.com/?to=/:account/workers/analytics-engine).
It is included on the free plan but off until enabled, and a deploy that binds a
dataset without it fails outright — `wrangler` stops with *"You need to enable
Analytics Engine"* (code 10089) and publishes nothing. `--dry-run` will not warn
you: it never calls the API. If you would rather not enable it, delete the two
`[[analytics_engine_datasets]]` blocks from `wrangler.toml` and everything else
deploys and runs unchanged, counting nothing on this build.

```bash
npm run tf:plan     # bundle the worker, then plan
npm run tf:apply    # bundle, then deploy script + DO + hostname
```

`npm run cf:dev` runs the whole thing locally, Durable Objects included.

### A single Node host

`Dockerfile` and `fly.toml` are included; Render, Railway and Koyeb build the
same image unchanged.

```bash
fly launch --copy-config --now
```

> **Run exactly one instance.** On this path tables live in process memory, so a
> second machine would hold different games and players could land on the wrong
> one. `fly.toml` pins a single machine that suspends when the last player
> disconnects. (The Cloudflare path has no such limit — each table is its own
> object.)

Just want friends on it for one evening? `npx localtunnel --port 3000`.

### Serverless functions won't work

Netlify and Vercel functions can't host this — not because of WebSockets alone,
but because they're stateless and short-lived. A table created in one invocation
wouldn't exist in the next. Durable Objects are the exception: they're serverless
*with* identity and storage.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `ALLOWED_ORIGINS` | *(same-origin only)* | Comma-separated hosts allowed to call the API and open sockets. Only needed if the front end is served from a different host. |
| `EMPTY_GRACE_MIN` | `15` | Minutes with nobody connected before an unstarted lobby is cleared |
| `EMPTY_GRACE_GAME_MIN` | `720` | The same, for a table with a game in it |
| `MAX_LIFETIME_HOURS` | `24` | Hours from creation before a table is cleared no matter what |
| `MAX_ROOMS` | `500` | Hard cap on concurrent tables |
| `CHAT_ENABLED` | `0` | Player-to-player chat. See [Chat](#chat) before turning it on. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

### Logs

One JSON object per line on stdout, which is what both hosts collect — Fly into
its log stream, Workers into the tail that `[observability]` enables. Workers
Logs bills per line, so the volume is kept deliberately low: **a table costs one
line**, written when it is cleared, carrying how long it lived, how many people
were ever at it, and whether a game was played and finished. Everything else at
`info` is the process starting and stopping.

```json
{"ts":"…","level":"info","evt":"room_disposed","code":"B2UEJF","why":"empty",
 "scoring":"house","max":12,"foot":1,"ageMin":47,"peakPlayers":4,
 "peakWatchers":1,"humans":3,"bots":1,"rounds":6,"finished":false,"moves":812}
```

`why` is a code (`empty`, `ceiling`, `evicted`), not the sentence the players are shown — a
sentence is the right thing to put on someone's screen and the wrong thing to
group a metric by. The counts are **peaks, not survivors**: a table is cleared
because everyone left, and a lobby seat is removed the moment its player goes,
so anything counted at the end reports an empty room and an abandoned lobby of
six looks identical to a table nobody ever opened.

Errors are never silent, but anything a stranger can trigger on repeat — a
rejected origin, a 429, a flood-closed socket — is collapsed to at most one line
a minute, with the suppressed count attached to the next one. Otherwise the
cheapest way to run up a logging bill would be to attack the server. The same
applies to a fault that recurs, keyed on the error itself so a *different* fault
still reports immediately.

`LOG_LEVEL=debug` adds a line per join and per table created. Useful locally,
expensive in production. Hands, chat text and player names are never logged.

### Usage

The same numbers, somewhere you can add them up without parsing a log. Nothing
here identifies anyone: it is a tally of moments, with no id, no cookie and
nothing that could follow one person between two of them.

Some of it the server cannot see at all. Everyone who lands on the front page
and leaves, or opens a shared link and never says who they are, creates no table
and produces no line anywhere — so the browser reports those few steps itself,
by name, to `POST /api/event?e=NAME`:

| | |
| --- | --- |
| `home` / `link` | the front door was shown / a shared link found its table |
| `made` / `code` | a table was started / joined by typing its code |
| `seat` / `watch` | a shared link was entered, to play or to watch |
| `returned` | a shared link was reopened by someone already known there |

The first two are the denominators; the rest are what people did next. The names
are a closed set — anything else is a 400 — and the route is throttled per IP,
answers 204, stores nothing about the caller and **never writes a log line**,
since otherwise the cheapest way to run up a logging bill would be to click.
Refusals are counted rather than logged. It is same-origin, so the app's own
`connect-src 'self'` already allows it and no CSP is loosened to let telemetry
out. There is no third-party analytics here and adding one would mean opening
that policy up.

**On a single Node host**, everything counted since boot is at `GET /api/stats`
— tables cleared and why, people who sat down, bots, games started and finished,
rounds, moves, table-minutes, and the funnel above. In memory like everything
else, so a restart is a reset.

```json
{"ok":true,"uptime":88400,"rooms":3,
 "counts":{"tables":112,"games":74,"games.finished":31,"players":389,
           "cleared.empty":95,"funnel.home":1204,"funnel.made":118}}
```

**On Cloudflare** there is nowhere to keep a counter — a Worker has no memory
that outlives a request, and each table is its own Durable Object with no
registry above it — so samples go to **Analytics Engine**, which is written to
rather than logged and so is not billed by the line. It is on the free plan too:
[100,000 data points a day](https://developers.cloudflare.com/analytics/analytics-engine/pricing/),
10,000 read queries, kept for three months — but it has to be
[enabled for the account](https://dash.cloudflare.com/?to=/:account/workers/analytics-engine)
before a deploy that binds a dataset will succeed at all. A table costs one point and a whole
session's funnel costs a handful, so ordinary play is nowhere near that ceiling
— a flood of funnel events is the only realistic way to approach it, which is
why the event route is throttled harder here than it needs to be for its own
sake. Three months is also the horizon of every question you can ask: this is a
"how is it going" store, not an archive.

Two datasets, `mt_tables` (one row per table) and `mt_funnel` — separate partly
so the noisy half can be dropped on its own, by deleting the `FUNNEL` binding,
without losing the table rows. The column layout is in
[worker/analytics.ts](worker/analytics.ts) and is the query contract, since
Analytics Engine has columns by position and not by name. Query it over the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/):

These go in the **Query** tab, not the filter box on a dataset's own tab — that
one takes a bare condition like `index1 = 'home'`, and a full statement pasted
into it fails on the first keyword it cannot use in an expression.

```sql
SELECT index1, sum(_sample_interval)
FROM mt_funnel
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY index1
```

That is the whole funnel in one result: how many landed, how many started a
table, how many opened a shared link and how many of those sat down. The
drop-off is the arithmetic between them.

```sql
SELECT toDate(timestamp),
       sum(_sample_interval),
       sum(_sample_interval * double3),
       sumIf(_sample_interval, double6 > 0),
       sumIf(_sample_interval, double7 = 1)
FROM mt_tables
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY toDate(timestamp)
ORDER BY toDate(timestamp)
```

Tables cleared, people seated, how many dealt a round, how many finished —
though **`mt_tables` lags, by design**. A table's row is written when it is
cleared, and a table with a game in it is held for 12 hours after the last
person leaves, so tonight's games arrive in tomorrow's data. An empty result
after an evening of play is the sweeper waiting, not a fault. `mt_funnel` is
the live half: those rows land as they happen. The
expression is repeated in `GROUP BY` rather than named with `AS` and grouped by
the name: aliases are worth avoiding here, both because a short one is easily a
word the parser has reserved, and because the documentation's own examples
disagree about whether `GROUP BY` may refer to one.

`_sample_interval` is not decoration. Past a certain rate Analytics Engine keeps
one stored row to stand for several real ones, and that column says how many —
so a count is `sum(_sample_interval)` rather than `count()`, a total is
`sum(_sample_interval * doubleN)`, and an average has to weight both halves.
Sampling picks on busy index values, so `mt_funnel` will reach it first and
`home` will be the value within it.

Both datasets are optional bindings: delete the two
`[[analytics_engine_datasets]]` blocks from `wrangler.toml` and the app deploys
and runs exactly as before, counting nothing.

### Chat

**Off, and not deployed.** The code is still here, behind `CHAT_ENABLED`, and
both sides of the flag are tested — but the shipped build has no chat in it.

The reasoning isn't about players being rude to each other; a table is eight
people who arrived by invitation, and that problem is small and self-policing.
It's that the properties which make this a nice card game — anyone can mint a
table in one click, no account, nothing logged, gone within the hour, reachable
only by a link — are also the exact properties of a disposable private channel.
Someone can set one up to talk, not to play, and there is nothing on this side
of the wire that would ever know. Moderation tools don't help with that: they
address who says what at a table, not what the table is being used for.

So the feature is gone rather than governed. Turning it back on means accepting
that you are hosting anonymous ephemeral chat rooms with a domino game attached,
which is a different service with different obligations.

The refusal lives in `Room.chatFrom()` — the only door into the table for a
chat line — rather than in the client or the socket layer, so a hand-written
message gets the same answer the missing button does. The flag is read from the
environment on every wake and never persisted, so a table minted while chat was
on goes silent as soon as the deploy that turned it off reaches it.

What remains is the table's own notices — *Ana joined*, *Kit is now played by a
bot* — which the server writes and nobody can put words into. They appear under
the activity tab.

### Session lifetime

People play this around work and dinner and bedtime, so a table has to survive
somebody's evening getting away from them — without turning into something that
sits on a server for days. How long one is held depends on what is in it:

| What's at the table | Held for |
| --- | --- |
| Nobody, no game started | 15 min (`EMPTY_GRACE_MIN`) |
| Nobody, game in progress | 12 hours (`EMPTY_GRACE_GAME_MIN`) |
| Anyone at all | until the ceiling |
| — anything, regardless — | 24 hours from creation (`MAX_LIFETIME_HOURS`) |

An unstarted lobby is a click to recreate. A game five rounds in holds hands
nobody can reconstruct, so it is held long enough to sleep on. The ceiling is
the only bound nothing can extend, and it is what keeps "nothing is kept" true.

**There is no idle rule.** A table with people sitting at it is not idle just
because nobody has moved — that is what waiting for someone looks like — and the
old 30-minute `IDLE_MIN` cleared lobbies out from under people who were still in
them. That variable is retired; the ceiling does the job it was really there for
(stopping a forgotten tab from holding a table open for ever).

**The bot clock stops when the last person leaves.** Every seat reads as absent
once everyone has gone, so bots used to take the table over and play the game
out — holding the table open would have been pointless if you came back to a
finished game. Nothing moves on an empty table.

Somebody who drops mid-turn is waited on for 90 seconds before a bot covers for
them, and the table says who it's waiting for. A host who knows they aren't
coming back can hand the seat to a bot immediately.

Getting back in is a seat token in `localStorage`, so tables you still hold a
seat at are listed on the front page — a game held overnight is no use if the
link is buried in a group chat.

On Cloudflare, holding a game costs essentially nothing: the Durable Object
hibernates, the state is a few KB, and the alarm just fires later. On a single
Node host it is resident memory, so `MAX_ROOMS` becomes the real constraint —
when it's reached, the oldest empty lobby is dropped to make room. Abandoned
*games* are never dropped for this: turning someone away beats deleting the
evening they were coming back to.

## Security

The server is authoritative: it validates every move, and clients only ever
receive their own hand. Spectators get the public view with no hand at all.

What's in place:

- **Room codes** are 6 characters from crypto-random bytes (≈1.07 billion), so
  the code space isn't worth sweeping for live games.
- **Rate limiting** per IP on table creation and lookup, plus a per-socket
  message budget and an 8 KB frame cap.
- **Origin checks** on both the API and the WebSocket upgrade, rejected before
  the handshake.
- **Security headers** including a CSP with no `unsafe-eval` and no external
  origins. `style-src` allows inline attributes because tile colours ride on
  them.
- **A cap on concurrent tables**, so a script can't exhaust memory.

Worth knowing: there are no accounts. Anyone holding a table's link can join it
or watch it, and seat identity is a random token in `localStorage`. That's
deliberate for a game you share by pasting a link, but don't treat a table as
private in any stronger sense. Client IPs come from `x-forwarded-for` and are
used only for throttling, never for authorisation.

## Rules

The engine implements the official rules, plus the house rules this table plays
by. Everything below the line is chosen by the host in the lobby.

**Always on**

- 13 rounds for a double-12 set, counting the engine down from 12 to blank.
- Everything is dealt, engine included. Whoever holds the round's double lays it
  and leads. If nobody was dealt it, players draw one tile each — keeping what
  they draw — until it turns up.
- Your first tile must start your own train off the engine.
- After that: one tile per turn, on your own train, the Mexican Train, or any
  train whose marker is up.
- One tile per turn — laying a double does not earn you a second play.
- You draw only when nothing in your hand plays anywhere. If the drawn tile
  plays, you must play it.
- The Mexican Train is communal and open from the start.
- A round ends when someone plays their last tile, or everyone is blocked with an
  empty boneyard. Lowest total after the final round wins.
- Anyone down to one tile is called out automatically — the digital version of
  tapping the table.

**Host options**

| Setting | Choices |
| --- | --- |
| Set | double-12 (13 rounds, up to 8 players), double-9, double-6 |
| Doubles | cover once · 2 tiles + fork · 3 tiles + fork |
| Scoring | house · official · just pips |

*Doubles are never an obligation.* A double is simply the open end of its branch:
match it if you want to carry that branch on, or ignore it and play somewhere
else entirely. Nobody is ever forced onto a double — yours or anyone's. You draw
only when you have no legal play anywhere on the table.

With a foot of 2 or 3, a double becomes a branch point that takes that many tiles,
and **until every toe is down that whole train is frozen** — none of its branches
can grow, not the toes already laid and not ones that forked off an earlier double.
Once the foot fills, the branch forks into that many live ends.

The freeze is per-train, not table-wide. Every other train carries on as normal,
and you are never forced to feed a foot instead of playing somewhere else. Put your
marker up and opponents get every one of your branches.

*Scoring.* House: blank halves are worth 0, but getting caught with the 0|0 costs
50. Official: every blank half is 25, the 0|0 is 50. Just pips: straight dot
count.

*Markers are entirely manual* — raise or lower yours at any point in your turn.

## Notes

- **Joining.** Opening a table's link asks who you are, then offers a seat or a
  spectator slot. Once a game is under way the seat option disappears and only
  watching is left.
- **Spectators** see the table and the activity log, but never anyone's hand —
  the server sends them the public view and rejects every game action. They have
  to give a name, and the table lists who's watching.
- **Rejoining.** Your seat is remembered in `localStorage`, so a refresh or a
  dropped phone puts you back in the same game — and so does coming back
  tomorrow, since the front page lists the tables you still hold a seat at.
  While the socket is down a banner says so, because everything on screen is
  stale until it comes back.
- **Bots** fill empty seats, and cover for anyone who disconnects mid-turn after
  90 seconds so a live game never stalls — the table says who it's waiting for
  meanwhile, and the host can hand the seat over sooner. They give it back when
  you return. On an empty table nothing moves at all: see
  [Session lifetime](#session-lifetime).
- **Bot temperament.** Every bot rolls a hidden disposition from obliging to
  ruthless. A ruthless one will drop a double on your open train to freeze it —
  especially when you're close to going out — while an obliging one will feed
  your foot to set you free again. It's random, nobody can set it, and it's only
  revealed on the final scoreboard.
- **Arranging your hand.** *Arrange* turns the hand into grab handles: drag a
  tile to reorder it, tap one to turn it around so a planned run reads left to
  right, and drop in *dividers* — half a tile wide — to keep the runs you are
  planning for each branch apart. Tap a divider to take it out; *Reset* puts
  everything back to the dealt order. It's a view of your own hand, so it works
  on anybody's turn and never leaves your browser.
- **Per-player display.** Tile size (a zoom slider — pips fall back to numerals
  once tiles get too small to read), numerals vs. pips, and sound on/off. All
  local preferences, so everyone at the table sets their own.
- Rooms are swept once everyone has been gone a while — 15 minutes for a lobby
  that never started, 12 hours for a table with a game in it. See
  [Session lifetime](#session-lifetime).

## Layout

```
shared/
  protocol.ts   the wire contract — every shape that crosses the socket,
                checked against all three build targets
  flags.ts      deployment flags, parsed the same way on both hosts
server/
  game.ts       rules engine — pure state and transitions, no I/O
  bots.ts       bot move selection and temperament
  room-core.ts  the table: lobby, membership, bot driver — knows nothing about
                sockets or timers, and is shared by both deployment targets
  dispatch.ts   what a client message means — shared, so the two can't drift
  log.ts        structured logs, shared by both targets
  metrics.ts    usage counters and the sink each host plugs into
  rooms.ts      Node transport: in-memory registry, real sockets, setTimeout
  index.ts      Node host: composes the two halves, owns the process
  http.ts         the JSON API and the static files
  sockets.ts      the upgrade gate and a socket's lifetime
  security.ts   rate limiting, origin checks, security headers
worker/
  index.ts      Cloudflare Worker: assets, /api, socket routing
  room.ts       the Durable Object — one per table, alarms + hibernation
  env.ts        the bindings, as declared in wrangler.toml
  analytics.ts  the Analytics Engine sink, and the column layout it writes
client/                                    bundled to public/app.js
  app.ts       entry — page-level wiring, then go
  dom.ts         escaping, $, toasts, the modal        ─┐ leaves: import
  state.ts       everything the client remembers        │ nothing of ours
  sound.ts       the table noises                      ─┘
  tiles.ts       how a domino and a player are drawn
  net.ts         the socket and the reconnect ladder
  seats.ts       the tables this browser still holds a seat at
  actions.ts     committing a tile
  lanes.ts       the board — one lane per train, one rail per branch
  modals.ts      rules, scoreboard, end of round
  lobby.ts       the pre-game table and its settings
  hand.ts        your hand: drawing, arranging, tapping
  turnbar.ts     what the table is waiting for
  panel.ts       scores and activity
  table.ts       the shell around all of it
  session.ts     what a fresh snapshot means
  entry.ts       the front door and the shared-link gate
  track.ts       the funnel: the few steps that never reach a socket
public/
  index.html app shell
  styles.css
  app.js     built from client/ — not checked in, never edit it
test/
  server.test.ts          the Node transport, over real HTTP and sockets
  durable-object.test.ts  the Cloudflare transport, against a fake runtime
  resilience.test.ts      what a crash costs, in real processes
  lifetime.test.ts        how long a table is held, and who the clock runs for
  log.test.ts             log levels, throttling, the table lifecycle line
  metrics.test.ts         that the usage numbers are true, peaks especially
scripts/
  soak.ts    plays thousands of games and asserts the rules hold
```

## Tests

```bash
npm run dev       # tsx runs the sources, reloads on save — no build
npm run dev:client # rebuild the client bundle on save, in a second terminal
npm run build     # tsc -> dist/, esbuild -> public/app.js
npm test          # builds, then the suites above, then the soak
npm run types     # all three projects, no emit
npm run lint      # the complexity gate
npm run soak -- 5 # more games per rule combination
npm run check     # everything, plus a wrangler dry run over the Worker config
```

The suites run against `dist/`, not the sources — the thing under test should be
the thing that ships.

## TypeScript

Three projects, because this repo targets three runtimes and they do not share
globals:

| project | runtime | emits |
|---|---|---|
| `tsconfig.json` | Node | `dist/` — what the container runs |
| `client/tsconfig.json` | the browser | nothing; esbuild bundles it |
| `worker/tsconfig.json` | Workers | nothing; wrangler bundles it |

Splitting them is what stops `process.env` reaching browser code and `document`
reaching the server. The Worker project re-checks the files `worker/` imports
from `server/` under Workers globals, which mechanically enforces the claim
`room-core.ts` makes about knowing nothing of its host.

Everything is compiled rather than run from source. Node can execute `.ts`
directly now by stripping types, but stripping only handles erasable syntax — an
`enum` added a year from now would be a runtime failure in production rather
than a compile error — and the browser needed a build step regardless.

`shared/protocol.ts` is the contract the two ends previously only implied. It
compiles to nothing and ships nothing.

Locally, `npm run dev` skips the build entirely — tsx runs the TypeScript
sources on Node and reloads on save. It does not type-check, so `npm run types`
is still the thing that says whether the code is sound.

Deliberately still Node rather than bun: the suites assert on signal handling
and the fault breaker, and the socket upgrade writes raw HTTP bytes before the
handshake. Those are exactly the places runtimes differ, and a bug that only
appears in production is the one thing this layout is arranged to avoid.

## The complexity gate

`npm run lint` is not a style checker and not a bug finder — there is no
formatter here and no `recommended` rule set. It asks one question, in four
ways, because no single metric catches everything: cyclomatic complexity ≤ 10,
nesting ≤ 4, statements per function ≤ 25, and lines per function ≤ 60. A flat
90-line function scores fine on complexity; a tight 6-line one can still be
nested five deep.

The numbers were picked against a census of this codebase rather than out of the
air — the median function scores 2 and the 90th percentile scores 7 — so passing
is the normal state and a failure means something actually grew. Complexity uses
ESLint's `modified` variant, which scores a `switch` as one branch: a flat
dispatch switch is the most readable form of multi-way dispatch, and the only
way to satisfy the classic count is to turn it into a lookup table, which serves
the metric rather than the reader. Tests keep the complexity and nesting limits
but not the length ones — a long list of assertions is a legitimate shape for a
test. It runs in CI ahead of the suites, and again before a deploy.

No test framework and no test dependencies — `node --test` and the one runtime
dependency the app already has. The suites run the real entrypoint as a child
process rather than importing it, because half of what they check (signal
handling, the fault floor, the bound port) only exists at the process level.

The Cloudflare build gets the same scrutiny as the Node one against a stand-in
for the Durable Object runtime — storage that persists, sockets that carry an
attachment across hibernation, and a counter on writes, so "a heartbeat must not
cost a storage write" is a test rather than a hope. It is the build that serves
players and the one no local tool otherwise exercises.

`scripts/soak.mjs` is the rules engine's own harness: it plays every combination
of set size, foot rule, scoring mode and table size, asserting after every turn
that nothing illegal was offered, that no tile exists twice, and that the pigeon
foot binds its own branch and no other. It fails if a run never exercises that
last case, so a green run can't be vacuous.

### CI

`ci.yml` runs on every pull request: tests, the soak, a `wrangler --dry-run` that
validates the Worker bundle and its bindings without deploying, and a Docker
build that boots the image and waits for `/api/health`. `deploy.yml` repeats the
tests before shipping, because `main` can be pushed to directly.

### If a deploy goes wrong

The health check in `deploy.yml` fails the job but does not revert — Workers keeps
serving the last good version until told otherwise. To go back:

```bash
npx wrangler deployments list   # find the previous version id
npx wrangler rollback [<version-id>]
```

`/api/health` reports the deployed version id, so you can confirm which build is
answering. On the Node host, redeploy the previous image — sessions are in memory
and a restart clears every table either way.

---

`game.js` has no dependencies and no side effects, so it can be driven headlessly
to explore rule changes by hand:

```bash
node -e "import('./server/game.js').then(async ({Game}) => {
  const {chooseMove} = await import('./server/bots.js');
  const g = new Game({players:[{id:'a',name:'A'},{id:'b',name:'B'}], max:12, foot:3});
  while (g.status !== 'gameOver') {
    if (g.status === 'roundOver') { g.startRound(); continue; }
    const id = g.current.id, mv = chooseMove(g, id);
    if (mv.type === 'play') g.play(id, mv.tile, mv.train, mv.seg);
    else if (mv.type === 'draw') g.draw(id); else { g.marker(id, true); g.pass(id); }
  }
  console.log(g.players.map(p => p.name + ': ' + p.score).join('  '));
})"
```

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE) — Copyright (c) 2026 James D.

Play it, self-host it, fork it, change it: all fine for any **noncommercial**
purpose, which explicitly covers private entertainment, hobby projects and
study. Charities, schools and public institutions are covered too.

What it does not permit is commercial use. You may not run it as a paid or
revenue-generating service, or fold it into a commercial product, without
written permission. If you want to do something commercial with it, ask.

If you redistribute any part of it, you must pass on this licence and the
`Required Notice` line at the top of it.
