# Working in this repo

Real-time Mexican Train dominoes. One rules engine, two hosts, no database.
[README.md](README.md) is the long form — the game rules, the deployment story,
the reasoning behind the layout. This file is the short form: what to run, where
to change things, and the handful of invariants that break quietly.

## Commands

```bash
npm run dev        # tsx runs the sources, reloads on save. Does NOT type-check.
npm run types      # all three projects, no emit — this is what says the code is sound
npm run lint       # the complexity gate (see below), not a style checker
npm test           # builds, runs the suites against dist/, then the soak
npm run check      # lint + types + test + a wrangler dry run. The full gate.
npm run soak -- 5  # more games per rule combination
```

`npm run check` is what CI runs, near enough. Run it before saying a change is
done. If you only touched the client, `npm run types` and a look in the browser
is a fair trade — the suites don't cover the browser at all.

To see it running, start the dev server through the preview tooling
(`.claude/launch.json` defines `mexican-train` on port 3000), not through Bash.

## One engine, two hosts

This is the fact that decides where a change goes.

```
shared/protocol.ts   the wire contract — types only, checked by all three targets
server/game.ts       the rules. Pure, no I/O, no dependencies.
server/bots.ts       move selection and temperament
server/room-core.ts  the table: lobby, membership, bot driver. Knows nothing
                     about sockets or timers.
server/dispatch.ts   what a client message means
server/log.ts        structured logging
        ── everything above is shared by both hosts ──
server/rooms.ts      Node: in-memory registry, ws sockets, setTimeout
server/index.ts + http.ts + sockets.ts + security.ts   the Node process
worker/room.ts       Cloudflare: one Durable Object per table, alarms, hibernation
worker/index.ts      the Worker: assets, /api, socket routing
client/              bundled to public/app.js — see the import order in app.ts
```

**A change to how the table behaves belongs in the shared half.** If you find
yourself editing `rooms.ts` and `worker/room.ts` to say the same thing twice,
the change is in the wrong place — that duplication is exactly what the split
exists to prevent. The two hosts differ only in how a socket is found, how state
is persisted, and how the bot clock ticks.

`join` is the one message each host handles itself, because identity is a
closure variable on Node and a socket attachment in the Durable Object.
Everything else goes through `dispatch()`.

`worker/tsconfig.json` re-checks the shared files under Workers globals, so a
stray `process.env` or `setTimeout` return type in `room-core.ts` fails
`npm run types` rather than production.

## Where to change what

| To change | Touch |
| --- | --- |
| A rule | `server/game.ts`, then the soak, then **both** rules texts (below) |
| A new client message | `shared/protocol.ts` → `server/dispatch.ts` → `room-core.ts` → the client |
| Bot behaviour | `server/bots.ts` |
| Lobby, seats, chat, membership | `server/room-core.ts` |
| The board on screen | `client/lanes.ts` (a lane per train, a rail per branch) |
| Node-only transport | `server/rooms.ts`, `sockets.ts`, `http.ts` |
| Cloudflare-only transport | `worker/room.ts`, `worker/index.ts`, `wrangler.toml` |

## Invariants that break quietly

- **Imports keep the `.js` extension** even though the file on disk is `.ts`.
  One convention, three bundlers.
- **The suites run against `dist/`, not the sources.** `node --test
  dist/test/*.test.js` after a build. Editing a `.ts` and rerunning the tests
  without building tests the old code.
- **`public/app.js` is generated and gitignored.** Never edit it. `npm run dev`
  rebuilds it once at startup; `npm run dev:client` watches.
- **A heartbeat must not cost a storage write.** `dispatch()` returns `mutated`,
  and the Durable Object persists only on `true`. A new message type that
  doesn't change the table must return `mutated: false`. There is a test that
  counts storage writes.
- **The server is authoritative and hands are private.** `Game.view()` fills
  `hand` and `moves` for one player only; spectators get neither and every game
  action from them is rejected. Don't widen a view shape without checking who
  receives it.
- **A rule change has two more homes than you think:** the rules card in
  [client/modals.ts](client/modals.ts) and the Rules section of
  [README.md](README.md). The in-app panel has described the game wrongly before.
  The soak (`scripts/soak.ts`) is where a rule gets pinned so it can't regress —
  it fails if a run never exercises the pigeon-foot sibling case, so a green run
  can't be vacuous.
- **Log lines cost money on Workers.** A healthy table is one line, written when
  it is cleared. Before adding a line at `info`, ask whether a stranger can
  trigger it on repeat; if so it needs the throttle in `server/log.ts`. Hands,
  chat text and names are never logged.
- **`WRANGLER_VERSION` is pinned in both `ci.yml` and `deploy.yml`** and has a
  floor tied to the `@cloudflare/workers-types` major. Bump both together, and
  bump them when those types change major — an older pin is an `ERESOLVE` that
  only shows up in the deploy.

## The complexity gate

`npm run lint` enables nothing but four size rules: cyclomatic complexity ≤ 10
(`modified` variant, so a flat switch is one branch), nesting ≤ 4, ≤ 25
statements per function, ≤ 60 lines per function. Tests keep the first two and
drop the length ones. Passing is the normal state; a failure means a function
genuinely grew, so split it rather than reaching for a disable comment.

## Dependencies

`ws` is the only runtime dependency, and the rules engine has none at all. There
is no test framework and no assertion library — `node --test` and
`node:assert`. There is no formatter. Adding a dependency is a decision worth
raising rather than making in passing.

## Style

Comments explain **why**, not what, and every module opens with a paragraph
saying what it is for and what it deliberately doesn't know. Match that. The
prose in this repo is written for a reader, not a linter — full sentences,
British-ish spelling in places, no bullet lists where a sentence will do.

Commit subjects describe the change as a behaviour, in a sentence, capitalised
and without a trailing full stop:

```
A whistle when somebody's marker goes up
A shared link opens the table it names
A pigeon foot freezes its whole train again
```

Infrastructure commits take a `ci:`/`docker:` prefix. The PR template asks what
changed and *how it was checked* — an unverified assumption stated plainly is
worth more than a green tick that didn't cover it.
