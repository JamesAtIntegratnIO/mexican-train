// Every table lives in this process's memory. There is no database behind it,
// so a crash doesn't lose a request — it loses every game in progress, mid-turn,
// for everyone. That asymmetry is why the server absorbs faults it did not
// expect, and why the absorbing has a limit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface FaultRun {
  code: number;
  /** The RESULT lines the fixture printed, keyed by name. */
  results: Record<string, string>;
  stdout: string;
  stderr: string;
}

function runFault(mode: string): Promise<FaultRun> {
  return new Promise<FaultRun>((resolve) => {
    execFile(process.execPath, ['test/fixtures/fault.js', mode], { cwd: ROOT, timeout: 30_000 },
      (err: any, stdout: string, stderr: string) => {
        const results: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const m = line.match(/^RESULT (\w+)=(.*)$/);
          if (m) results[m[1]!] = m[2]!;
        }
        resolve({ code: err?.code ?? 0, results, stdout, stderr });
      });
  });
}

describe('the fault floor', () => {
  test('an unhandled rejection is logged, not fatal', async () => {
    const { results, code } = await runFault('rejection');
    assert.equal(results.alive, 'true', 'the server died on an unhandled rejection');
    assert.equal(code, 0);
  });

  test('an uncaught exception is logged, not fatal', async () => {
    const { results } = await runFault('exception');
    assert.equal(results.alive, 'true', 'the server died on an uncaught exception');
  });

  test('a bug in a handler costs that message, nothing more', async () => {
    const { results } = await runFault('bug');
    assert.equal(results.message, 'Something went wrong on the server.',
      'the player should get an apology, not a stack trace or silence');
    assert.equal(results.socketOpen, 'true', 'the socket should survive the fault');
    assert.equal(results.tableKept, 'true', 'the table should survive the fault');
    assert.equal(results.alive, 'true');
  });

  // Absorbing faults forever would turn a broken deploy into a server that
  // looks up and works for nobody. Ten in a minute is broken, not unlucky.
  test('a run of faults trips the breaker and exits for a restart', async () => {
    const { code, results } = await runFault('loop');
    assert.equal(code, 1, `expected a clean exit(1) for the platform to restart; got ${code} ${JSON.stringify(results)}`);
    assert.equal(results.exited, undefined, 'the breaker never fired');
  });
});

describe('shutdown', () => {
  test('SIGTERM closes sockets and exits cleanly', async () => {
    const { startServer, openSocket } = await import('./helpers/server.js');
    const srv = await startServer();
    const ws = openSocket(srv.port, 'ZZZZZZ');
    await ws.opened;

    await srv.stop();
    // 1001 is "going away" — a deploy should tell players, not drop them.
    const closed = await Promise.race([ws.closedWith, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
    assert.notEqual(closed, 'timeout', 'the socket was never closed');
    assert.ok(srv.events().includes('shutting_down'), 'the shutdown was not logged');
  });
});
