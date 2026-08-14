// The two front doors, held against each other.
//
// Node reads an `IncomingMessage` and `process.env`; the Worker reads a
// `Request` and a binding. Nothing in the type system connects the two, and
// they answered these questions in their own words for long enough that the
// only reason they agreed was that somebody had copied one into the other. A
// header quietly weaker on one of two builds is the hardest kind of security
// regression to spot, because nothing fails — so this is the thing that fails.
//
// It exercises the adapters, not shared/http-policy: the shared half agreeing
// with itself proves nothing, and the mistake worth catching is a host that
// stops asking it.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { originAllowed as nodeOrigin, securityHeaders as nodeHeaders } from '../server/security.js';
import { originAllowed as workerOrigin, securityHeaders as workerHeaders } from '../worker/index.js';
import type { Env } from '../worker/env.js';

/** Both adapters read a handful of headers and nothing else, so a header bag is
 *  the whole of the request either of them needs. */
const nodeReq = (headers: Record<string, string | undefined>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

const workerReq = (origin: string | null, host: string): Request =>
  new Request(`https://${host}/api/health`, { headers: origin === null ? {} : { origin } });

const SELF = 'table.example';

/** Every case both hosts have to answer the same way. `allow` is the
 *  ALLOWED_ORIGINS string as a deployment would set it. */
const CASES: { what: string; origin: string | null; allow: string; want: boolean }[] = [
  { what: 'no Origin header at all is allowed — curl, the tests, native clients', origin: null, allow: '', want: true },
  { what: 'an Origin that is not a URL is refused', origin: 'not an origin', allow: '', want: false },
  { what: 'the literal "null" a sandboxed frame sends is refused', origin: 'null', allow: '', want: false },
  { what: 'the page asking about itself is allowed', origin: `https://${SELF}`, allow: '', want: true },
  { what: 'another site driving our table is refused', origin: 'https://evil.example', allow: '', want: false },
  { what: 'our own name on another port is a different origin', origin: `https://${SELF}:8443`, allow: '', want: false },
  { what: 'a host on the allow-list is allowed', origin: 'https://train.example', allow: 'train.example,other.example', want: true },
  { what: 'a host that is not on it is refused', origin: 'https://evil.example', allow: 'train.example', want: false },
  // The allow-list replaces the same-origin default rather than adding to it: a
  // deployment that lists its hosts has said which they are.
  { what: 'an allow-list that omits us refuses even us', origin: `https://${SELF}`, allow: 'train.example', want: false },
  { what: 'the list is read the same way, spaces and all', origin: 'https://other.example', allow: ' train.example , other.example ', want: true },
];

describe('one origin policy, two front doors', () => {
  after(() => { delete process.env.ALLOWED_ORIGINS; });

  for (const c of CASES) {
    test(c.what, () => {
      process.env.ALLOWED_ORIGINS = c.allow;
      const env = { ALLOWED_ORIGINS: c.allow } as unknown as Env;
      assert.equal(nodeOrigin(nodeReq({ origin: c.origin ?? undefined, host: SELF })), c.want, 'the Node host');
      assert.equal(workerOrigin(workerReq(c.origin, SELF), env), c.want, 'the Worker');
    });
  }
});

describe('one security policy, two front doors', () => {
  // Both are behind TLS here, which is the only state in which the two are
  // meant to agree completely — see the last test in this block.
  const node = (isHtml: boolean, proto = 'https') => nodeHeaders(nodeReq({ 'x-forwarded-proto': proto }), isHtml);

  test('the page is served the same headers by either host', () => {
    assert.deepEqual(workerHeaders(true), node(true));
  });

  test('and so is a JSON answer', () => {
    assert.deepEqual(workerHeaders(false), node(false));
  });

  // Named separately from the deepEqual above so a drift in the one directive
  // that matters most reads as itself rather than as a diff of ten headers.
  test('the content security policy is one string, not two', () => {
    assert.equal(workerHeaders(true)['content-security-policy'], node(true)['content-security-policy']);
    assert.equal(workerHeaders(true)['permissions-policy'], node(true)['permissions-policy']);
  });

  // The policy the app actually needs, rather than merely a policy: each of
  // these was a deliberate concession or a deliberate refusal, and losing one
  // either breaks the board or opens the door.
  test('the policy still says what the app depends on', () => {
    const csp = node(true)['content-security-policy'];
    assert.match(csp, /style-src 'self' 'unsafe-inline'/, 'tile colours ride on inline style attributes');
    assert.match(csp, /img-src 'self' data:/, 'the favicon is an inline SVG data URI');
    assert.match(csp, /connect-src 'self' ws: wss:/, 'the game is a websocket');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(node(true)['x-frame-options'], 'DENY');
  });

  // The one line the hosts are meant to differ on. A Worker is only ever
  // reached over Cloudflare's TLS; a Node process can be talked to directly,
  // and a year-long promise made over plain http locks the browser out of it.
  test('only the host that terminated TLS promises a year of it', () => {
    assert.ok(workerHeaders(false)['strict-transport-security'], 'the Worker is always on TLS');
    assert.equal(node(false, 'http')['strict-transport-security'], undefined);
    assert.equal(node(false)['strict-transport-security'], workerHeaders(false)['strict-transport-security']);
  });
});
