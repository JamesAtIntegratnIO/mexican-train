// What the game is being used for, read back from Analytics Engine.
//
//   npm run usage                     the last 30 days
//   npm run usage -- --days 7
//   npm run usage -- --html usage.html
//
// This runs on your machine and nowhere else. The alternative — a dashboard
// route on the Worker — would mean keeping a token that can read the whole
// account's analytics inside a game that deliberately has no accounts, and
// exposing an admin surface on it. A script you run when you want the numbers
// costs nothing and risks nothing.
//
// It needs an API token with **Account | Account Analytics | Read**, which is
// not a permission a deploy token carries — so this is usually a second token.
// Put it in .env.local, which is gitignored and loaded by direnv:
//
//   export ANALYTICS_TOKEN="..."
//   export CLOUDFLARE_ACCOUNT_ID="..."     # or leave it in terraform.tfvars
//
// Nothing here is ever written back. The SQL API is read-only and so is this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = (account: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;

/** One row of the funnel: a step, and how many times it happened. */
export interface Step { step: string; n: number }
/** One day of tables, already weighted for sampling. */
export interface Day {
  day_utc: string;
  n_tables: number; n_people: number; n_games: number;
  n_finished: number; n_bots: number; table_minutes: number; n_moves: number;
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

// Interpolated into SQL, so it is checked rather than trusted. Nothing here is
// reachable by a stranger, but a number that is only ever a number is one less
// thing to think about. Ninety days is the outside edge of what Analytics
// Engine keeps, so asking for more is a question with no answer.
function days(): number {
  const n = Number(flag('--days') ?? 30);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('--days must be a whole number of days, 1 to 90.');
  return n;
}

// Terraform already knows the account id and its tfvars file is gitignored, so
// there is no reason to make anyone keep a second copy in their environment.
function fromTfvars(key: string): string | undefined {
  const file = path.join(ROOT, 'terraform', 'terraform.tfvars');
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
}

function credentials(): { account: string; token: string } {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || fromTfvars('account_id');
  const token = process.env.ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!account) throw new Error('No account id. Set CLOUDFLARE_ACCOUNT_ID, or leave it in terraform/terraform.tfvars.');
  if (!token) throw new Error('No token. Set ANALYTICS_TOKEN in .env.local — it needs Account | Account Analytics | Read.');
  return { account, token };
}

// A dataset that has never been written to does not exist yet, and the API says
// so rather than returning nothing. That is the ordinary state of mt_tables
// until the first table is swept, so it reads as empty rather than as a fault.
const MISSING = /unknown table|doesn'?t exist|does not exist|UNKNOWN_TABLE/i;

async function sql<T>(query: string): Promise<T[]> {
  const { account, token } = credentials();
  const res = await fetch(ENDPOINT(account), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: query,
  });
  const text = await res.text();
  if (!res.ok) {
    if (MISSING.test(text)) return [];
    throw new Error(explain(res.status, text));
  }
  const body = JSON.parse(text) as { data?: T[] };
  if (!Array.isArray(body.data)) throw new Error(`Unexpected response from the SQL API: ${text.slice(0, 200)}`);
  return body.data;
}

const explain = (status: number, text: string): string => {
  if (status === 401 || status === 403) {
    return `The API refused the token (${status}). It needs Account | Account Analytics | Read, which a deploy token does not have.\n${text.slice(0, 200)}`;
  }
  if (status === 404) return `No such account (404). Check CLOUDFLARE_ACCOUNT_ID.\n${text.slice(0, 200)}`;
  return `The SQL API answered ${status}.\n${text.slice(0, 400)}`;
};

// Counts are sum(_sample_interval), never count(): past a certain rate one
// stored row stands for several real ones and that column says how many.
//
// GROUP BY takes column names and nothing else — "in the GROUP BY clause you
// may only provide column names" is a 422, not a warning. So anything computed
// has to be aliased in the SELECT list and grouped by that alias; grouping by
// toDate(timestamp) directly is rejected outright.
const funnelQuery = (d: number): string => `
SELECT index1 AS step, sum(_sample_interval) AS n
FROM mt_funnel
WHERE timestamp > NOW() - INTERVAL '${d}' DAY
GROUP BY index1`;

const tablesQuery = (d: number): string => `
SELECT toDate(timestamp) AS day_utc,
       sum(_sample_interval) AS n_tables,
       sum(_sample_interval * double3) AS n_people,
       sum(_sample_interval * double4) AS n_bots,
       sumIf(_sample_interval, double6 > 0) AS n_games,
       sumIf(_sample_interval, double7 = 1) AS n_finished,
       sum(_sample_interval * double1) AS table_minutes,
       sum(_sample_interval * double8) AS n_moves
FROM mt_tables
WHERE timestamp > NOW() - INTERVAL '${d}' DAY
GROUP BY day_utc
ORDER BY day_utc`;

// ---------------------------------------------------------------- the report

const num = (rows: Step[], step: string): number => Number(rows.find((r) => r.step === step)?.n ?? 0);
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const sum = (rows: Day[], key: keyof Day): number => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

/** The funnel as questions rather than counts: of everyone who arrived, how
 *  many got as far as a table. */
export function funnel(rows: Step[]) {
  const home = num(rows, 'home'), link = num(rows, 'link');
  const made = num(rows, 'made'), code = num(rows, 'code');
  const seat = num(rows, 'seat'), watch = num(rows, 'watch');
  return {
    home, link, made, code, seat, watch, returned: num(rows, 'returned'),
    /** Landed on the front page and started or joined something. */
    startedOfHome: pct(made + code, home),
    /** Left the front page without playing — the number worth moving. */
    leftHome: pct(home - made - code, home),
    /** Opened a shared link and ended up at the table, playing or watching. */
    enteredOfLink: pct(seat + watch, link),
  };
}

export function totals(rows: Day[]) {
  const tables = sum(rows, 'n_tables');
  return {
    tables,
    people: sum(rows, 'n_people'),
    bots: sum(rows, 'n_bots'),
    games: sum(rows, 'n_games'),
    finished: sum(rows, 'n_finished'),
    moves: sum(rows, 'n_moves'),
    /** Averages have to weight both halves, so they are computed from the
     *  weighted totals rather than averaged out of already-averaged days. */
    avgMinutes: tables ? Math.round(sum(rows, 'table_minutes') / tables) : 0,
    avgPeople: tables ? (sum(rows, 'n_people') / tables).toFixed(1) : '0',
    dealtOfTables: pct(sum(rows, 'n_games'), tables),
    finishedOfGames: pct(sum(rows, 'n_finished'), sum(rows, 'n_games')),
  };
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);

function printFunnel(f: ReturnType<typeof funnel>): void {
  console.log('\nThe front door');
  console.log(`  arrived        ${pad(f.home, 7)}`);
  console.log(`  started a table${pad(f.made, 7)}   ${pct(f.made, f.home)}`);
  console.log(`  joined by code ${pad(f.code, 7)}   ${pct(f.code, f.home)}`);
  console.log(`  left           ${pad(Math.max(0, f.home - f.made - f.code), 7)}   ${f.leftHome}`);
  console.log('\nShared links');
  console.log(`  opened         ${pad(f.link, 7)}`);
  console.log(`  took a seat    ${pad(f.seat, 7)}   ${pct(f.seat, f.link)}`);
  console.log(`  watched        ${pad(f.watch, 7)}   ${pct(f.watch, f.link)}`);
  console.log(`  came back      ${pad(f.returned, 7)}   (reopened a link they already knew)`);
}

function printTables(t: ReturnType<typeof totals>, empty: boolean): void {
  console.log('\nTables');
  if (empty) {
    console.log('  Nothing yet. A table is only counted when it is cleared, and one with a');
    console.log('  game in it is held for 12 hours after the last player leaves — so an');
    console.log("  evening's play lands in tomorrow's data.");
    return;
  }
  console.log(`  cleared        ${pad(t.tables, 7)}`);
  console.log(`  dealt a round  ${pad(t.games, 7)}   ${t.dealtOfTables} of tables`);
  console.log(`  finished       ${pad(t.finished, 7)}   ${t.finishedOfGames} of games`);
  console.log(`  people seated  ${pad(t.people, 7)}   ${t.avgPeople} per table, plus ${t.bots} bots`);
  console.log(`  average life   ${pad(t.avgMinutes, 7)} min`);
  console.log(`  moves played   ${pad(t.moves, 7)}`);
}

// ---------------------------------------------------------------- a local page

const bar = (n: number, max: number, w = 260): string =>
  `<rect x="0" y="0" width="${max ? Math.max(2, Math.round((n / max) * w)) : 2}" height="18" rx="3" fill="var(--bar)"/>`;

const rows = (items: Array<[string, number]>): string => {
  const max = Math.max(1, ...items.map(([, n]) => n));
  return items.map(([label, n]) => `<tr><th>${label}</th><td class="n">${n}</td>
    <td><svg width="260" height="18" role="img" aria-label="${n}">${bar(n, max)}</svg></td></tr>`).join('\n');
};

export function page(f: ReturnType<typeof funnel>, t: ReturnType<typeof totals>, d: number): string {
  return `<!doctype html><meta charset="utf-8"><title>Mexican Train — usage</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --bg:#fff; --fg:#161616; --dim:#666; --line:#e5e5e5; --bar:#c9a227; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --fg:#e9e9e9; --dim:#9aa0a6; --line:#2a2e35; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,sans-serif; margin:0; padding:32px; }
  main { max-width:720px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:32px 0 8px; }
  p.sub { color:var(--dim); margin:0 0 8px; }
  table { border-collapse:collapse; width:100%; } th { text-align:left; font-weight:500; padding:6px 12px 6px 0; }
  td { padding:6px 12px 6px 0; border-bottom:1px solid var(--line); } th { border-bottom:1px solid var(--line); }
  td.n { font-variant-numeric:tabular-nums; text-align:right; width:72px; }
</style>
<main>
  <h1>Mexican Train — usage</h1>
  <p class="sub">The last ${d} days, read from Analytics Engine. Counts are weighted for sampling.</p>
  <h2>The front door</h2>
  <table>${rows([['arrived', f.home], ['started a table', f.made], ['joined by code', f.code], ['left without playing', Math.max(0, f.home - f.made - f.code)]])}</table>
  <h2>Shared links</h2>
  <table>${rows([['opened', f.link], ['took a seat', f.seat], ['watched', f.watch], ['came back', f.returned]])}</table>
  <h2>Tables</h2>
  <table>${rows([['cleared', t.tables], ['dealt a round', t.games], ['finished a game', t.finished], ['people seated', t.people], ['bots', t.bots]])}</table>
  <p class="sub">Average table life ${t.avgMinutes} min, ${t.avgPeople} people per table, ${t.moves} moves played.</p>
</main>`;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const d = days();
  const [steps, table] = await Promise.all([sql<Step>(funnelQuery(d)), sql<Day>(tablesQuery(d))]);
  const f = funnel(steps), t = totals(table);

  const out = flag('--html');
  if (out !== undefined) {
    const file = path.resolve(out || 'usage.html');
    fs.writeFileSync(file, page(f, t, d));
    console.log(`Wrote ${file}`);
    return;
  }

  console.log(`\nMexican Train — usage, last ${d} days`);
  if (!steps.length && !table.length) console.log('\nNo data yet. Nothing has been written to either dataset.');
  printFunnel(f);
  printTables(t, !table.length);
  console.log('');
}

// Only when run, so the report functions can be tested without firing a query.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
