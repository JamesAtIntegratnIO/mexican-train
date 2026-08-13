// Runs the real server in-process and then breaks it on purpose, so the fault
// handlers under test are the ones server/index.js actually registers.
//
// A child process rather than a test case: these faults are process-level, and
// the last mode deliberately ends in exit(1) — inside the test runner that
// would take the runner down with it.
//
//   node test/fixtures/fault.mjs <rejection|exception|bug|loop>
//
// Prints one RESULT line per finding for the parent to assert on.

const mode = process.argv[2];
process.env.PORT = '0';
process.env.LOG_LEVEL = 'info';         // the startup line is how we learn the port

const say = (key, value) => process.stdout.write(`RESULT ${key}=${value}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// server/index.js logs the port it bound; catch it on the way past.
let port = null;
const realLog = console.log;
console.log = (s) => {
  if (typeof s === 'string' && s.startsWith('{"ts"')) {
    try { const l = JSON.parse(s); if (l.evt === 'listening') port = l.port; } catch {}
  }
  realLog(s);
};

await import('../../server/index.js');
const { rooms } = await import('../../server/rooms.js');
for (let i = 0; i < 100 && port === null; i++) await sleep(20);
if (port === null) { say('startup', 'failed'); process.exit(2); }

const alive = async () => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json())).ok === true; }
  catch { return false; }
};

if (mode === 'rejection') {
  Promise.reject(new Error('synthetic unhandled rejection'));
  await sleep(300);
  say('alive', await alive());

} else if (mode === 'exception') {
  setTimeout(() => { throw new Error('synthetic uncaught exception'); }, 0);
  await sleep(300);
  say('alive', await alive());

} else if (mode === 'bug') {
  // A fault inside a message handler: the player gets a generic apology, the
  // socket stays up, and the table is not lost.
  const { WebSocket } = await import('ws');
  const { code } = await fetch(`http://127.0.0.1:${port}/api/new`, { method: 'POST' }).then((r) => r.json());
  rooms.get(code).chatFrom = () => { throw new TypeError('synthetic bug: not a function'); };

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${code}`);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw)));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'Tester' }));
  await sleep(200);
  ws.send(JSON.stringify({ t: 'chat', text: 'hello' }));
  await sleep(300);

  say('message', seen.find((m) => m.t === 'error')?.msg);
  say('socketOpen', ws.readyState === 1);
  say('tableKept', rooms.has(code));
  say('alive', await alive());
  ws.close();

} else if (mode === 'loop') {
  // A process failing over and over is not merely unlucky; the breaker should
  // give up and let the platform restart it clean.
  for (let i = 0; i < 12; i++) Promise.reject(new Error(`fault ${i}`));
  await sleep(1500);
  say('exited', false);                 // reaching this line means it never tripped
  process.exit(9);

} else {
  say('mode', 'unknown');
  process.exit(2);
}

process.exit(0);
