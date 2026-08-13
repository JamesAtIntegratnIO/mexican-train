# Mexican Train

Real-time online Mexican Train dominoes. Start a table, share the link, play. No
accounts, no database — sessions live in memory and vanish when everyone leaves.

```bash
nix develop      # or: direnv allow
npm install && npm start
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
| `EMPTY_GRACE_MIN` | `15` | Minutes with nobody connected before a table is cleared |
| `IDLE_MIN` | `30` | Minutes with no activity at all before a table is cleared |
| `MAX_ROOMS` | `500` | Hard cap on concurrent tables |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

### Logs

One JSON object per line on stdout, which is what both hosts collect — Fly into
its log stream, Workers into the tail that `[observability]` enables. Workers
Logs bills per line, so the volume is kept deliberately low: **a table costs one
line**, written when it is cleared, carrying how long it lived and whether a game
was ever played. Everything else at `info` is the process starting and stopping.

Errors are never silent, but anything a stranger can trigger on repeat — a
rejected origin, a 429, a flood-closed socket — is collapsed to at most one line
a minute, with the suppressed count attached to the next one. Otherwise the
cheapest way to run up a logging bill would be to attack the server. The same
applies to a fault that recurs, keyed on the error itself so a *different* fault
still reports immediately.

`LOG_LEVEL=debug` adds a line per join and per table created. Useful locally,
expensive in production. Hands, chat text and player names are never logged.

### Session lifetime

A game in progress never expires, however long it runs — a full 13 rounds takes
hours and that's fine. A table is only cleared when **everyone has been gone for
15 minutes** (the grace covers a locked phone or a wifi blip) or when **nothing at
all has happened for 30 minutes**. Anyone still connected is told why.

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
can grow, not even ones that already forked. Once the foot fills, the branch forks
into that many live ends.

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
- **Spectators** see the table, the activity log and the chat, but never anyone's
  hand — the server sends them the public view and rejects every game action.
  They have to give a name, and the table lists who's watching.
- **Rejoining.** Your seat is remembered in `localStorage`, so a refresh or a
  dropped phone puts you back in the same game. While the socket is down a banner
  says so, because everything on screen is stale until it comes back.
- **Bots** fill empty seats, and quietly cover for anyone who disconnects after
  15 seconds so a game never stalls. They hand the seat back when you return.
- **Bot temperament.** Every bot rolls a hidden disposition from obliging to
  ruthless. A ruthless one will drop a double on your open train to freeze it —
  especially when you're close to going out — while an obliging one will feed
  your foot to set you free again. It's random, nobody can set it, and it's only
  revealed on the final scoreboard.
- **Per-player display.** Tile size (a zoom slider — pips fall back to numerals
  once tiles get too small to read), numerals vs. pips, and sound on/off. All
  local preferences, so everyone at the table sets their own.
- Rooms are swept 30 minutes after the last person leaves.

## Layout

```
server/
  game.js       rules engine — pure state and transitions, no I/O
  bots.js       bot move selection and temperament
  room-core.js  the table: lobby, membership, bot driver — knows nothing about
                sockets or timers, and is shared by both deployment targets
  rooms.js      Node transport: in-memory registry, real sockets, setTimeout
  index.js      Node HTTP + WebSocket server, static files
  security.js   rate limiting, origin checks, security headers
worker/
  index.js      Cloudflare Worker: assets, /api, socket routing
  room.js       the Durable Object — one per table, alarms + hibernation
public/
  index.html app shell
  app.js     client — vanilla, no build step
  styles.css
```

`game.js` has no dependencies and no side effects, so it can be driven headlessly
to soak-test rule changes:

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
