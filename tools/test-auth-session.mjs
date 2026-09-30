// Preload integration suites with real authenticated sessions on isolated ports 5091/5093.
// Usage: set SPARKSTUDIO_TEST_AUTH_FILE to the ignored file from test-security.mjs,
// then node --import ./tools/test-auth-session.mjs tools/test-input-controls.mjs <gateway URL>.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const filename = process.env.SPARKSTUDIO_TEST_AUTH_FILE;
assert.ok(filename, 'Set SPARKSTUDIO_TEST_AUTH_FILE to the local test account file.');
const dataRoot = path.resolve('.data');
const resolved = path.resolve(filename);
assert.ok(resolved.startsWith(dataRoot + path.sep), 'Test credentials must stay under the local .data directory.');
const credentials = JSON.parse(await readFile(resolved, 'utf8'));
const base = new URL(credentials.baseUrl);
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname) && ['5091', '5093'].includes(base.port), 'Only isolated loopback test gateways on 5091 or 5093 are allowed.');
assert.equal(base.pathname, '/');
const originalFetch = globalThis.fetch;
const sessions = {};

async function signIn(audience) {
  const response = await originalFetch(new URL('/api/auth/login', base), {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience, username: credentials.admin.username, password: credentials.admin.password }),
  });
  assert.equal(response.status, 200, `Test ${audience} sign-in failed (${response.status}).`);
  const state = await response.json();
  sessions[audience] = { csrf: state.csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  assert.ok(sessions[audience].csrf && sessions[audience].cookie);
}
await signIn('engineering');
await signIn('operator');

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== base.origin) throw new Error('Authenticated test requests must stay on the isolated gateway.');
  if (!url.pathname.startsWith('/api')) return originalFetch(input, init);
  const suppliedHeaders = input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init.headers ?? suppliedHeaders);
  const audience = /\/runtime(?:\/|$)/.test(url.pathname) ? 'operator' : 'engineering';
  headers.set('Cookie', sessions[audience].cookie);
  headers.set('X-SPARK-AUDIENCE', audience);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-SPARK-CSRF', sessions[audience].csrf);
  return originalFetch(input, { ...init, headers, redirect: init.redirect ?? 'error' });
};
