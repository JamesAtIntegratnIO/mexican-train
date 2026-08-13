// Starts the real entrypoint as a child process, the way a host runs it, and
// waits for it to say which port it got. Testing the module in-process would be
// quicker, but it would also mean the thing under test is never the thing that
// ships — and half of what these tests check (signal handling, the fault floor)
// only exists at the process level.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/protocol.js';

/** ws sockets, plus the few conveniences these tests hang off them. */
type TestSocket = WebSocket & {
  seen: ServerMessage[];
  say(obj: unknown): void;
  expect(t: string, ms?: number): Promise<any>;
  opened: Promise<any>;
  closedWith: Promise<number | string>;
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startServer(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // PORT=0 lets the OS hand out a free one, so tests never collide with a
    // dev server or with each other when the runner goes parallel.
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: Array<Record<string, any>> = [];
  let buffered = '';
  const collect = (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop() as string;
    for (const line of parts) {
      if (line.startsWith('{"ts"')) { try { lines.push(JSON.parse(line)); } catch {} }
    }
  };
  child.stdout!.on('data', (d: unknown) => collect(String(d)));
  child.stderr!.on('data', (d: unknown) => collect(String(d)));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never reported a port')), 10_000);
    const poll = setInterval(() => {
      const up = lines.find((l) => l.evt === 'listening');
      if (up) { clearInterval(poll); clearTimeout(timer); resolve(up.port); }
    }, 25);
    child.once('exit', (code: number | null) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
  });

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    logs: lines,                                   // every structured line, in order
    events: () => lines.map((l) => l.evt),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export function openSocket(port: number, code: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${code}`) as TestSocket;
  const seen: ServerMessage[] = [];
  ws.on('message', (raw: unknown) => { try { seen.push(JSON.parse(String(raw))); } catch {} });
  ws.seen = seen;
  ws.say = (obj: unknown) => ws.send(JSON.stringify(obj));
  // Resolves with the first message of type `t`, or null if it never comes.
  ws.expect = (t: string, ms = 3000) => new Promise<any>((resolve) => {
    const found = seen.find((m) => m.t === t);
    if (found) return resolve(found);
    const started = seen.length;
    const timer = setTimeout(() => { clearInterval(poll); resolve(null); }, ms);
    const poll = setInterval(() => {
      const hit = seen.slice(started).find((m) => m.t === t);
      if (hit) { clearInterval(poll); clearTimeout(timer); resolve(hit); }
    }, 20);
  });
  ws.opened = new Promise<any>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  ws.closedWith = new Promise<number | string>((resolve) => ws.once('close', (c: number) => resolve(c)));
  return ws;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
