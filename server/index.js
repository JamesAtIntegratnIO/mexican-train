// The Node host. Wires the HTTP and WebSocket halves onto one port and takes
// care of the process itself — signals, faults, and the noisy ways a listen can
// fail. What the two halves actually do lives in http.js and sockets.js.

import http from 'node:http';
import { rooms, MAX_ROOMS } from './rooms.js';
import { handleRequest } from './http.js';
import { attachSockets } from './sockets.js';
import { log, setLevel } from './log.js';

setLevel(process.env.LOG_LEVEL);

// `Number(x) || default` would swallow PORT=0, which is the one way to ask the
// OS for a free port — and it fails by quietly binding 3000 instead.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(handleRequest);
const wss = attachSockets(server);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutting_down', { sig, rooms: rooms.size, sockets: wss.clients.size });
    for (const ws of wss.clients) { try { ws.close(1001, 'Server restarting'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Every table lives in this process's memory, so exiting throws away every game
// in progress. A fault in one socket's handler is not worth that, and Node's
// default for an unhandled rejection is to exit — so absorb both, log them
// loudly, and keep the other tables running.
//
// The exception is a fault that repeats: if the process is broken rather than
// merely unlucky, staying up serves nobody, so a burst trips a real exit and
// lets the platform restart us clean.
let faults = 0;
const survive = (evt) => (err) => {
  log.error(evt, { err, rooms: rooms.size });
  faults++;
  setTimeout(() => { faults--; }, 60_000).unref();
  if (faults >= 10) {
    log.error('fault_loop', { faults, note: 'exiting so the platform restarts us' });
    process.exit(1);
  }
};
process.on('uncaughtException', survive('uncaught_exception'));
process.on('unhandledRejection', survive('unhandled_rejection'));

// Without this, a port already in use exits on a raw stack trace.
server.on('error', (err) => {
  log.error('server_error', { err, port: PORT, host: HOST });
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') process.exit(1);
});

server.listen(PORT, HOST, () => {
  // The bound port, not the requested one: PORT=0 asks the OS to pick, which is
  // how the tests get a free port, and the log has to say which one it got.
  const { port } = server.address();
  log.info('listening', { port, host: HOST, maxRooms: MAX_ROOMS });
  console.log(`\n  Mexican Train on http://localhost:${port}  (max ${MAX_ROOMS} tables)\n`);
});
