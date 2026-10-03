#!/usr/bin/env node
// Creates an independently authored unpublished project. Source setup stays an explicit engineering exercise.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
assert.ok(args.length <= 1, 'Usage: node tools/load-data-sources-example.mjs [local gateway URL]');
const base = new URL(args[0] ?? 'http://127.0.0.1:6090');
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && ['5091', '5093', '6090'].includes(base.port)
  && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Use an isolated loopback gateway.');
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to your local administrator credential file.');
const credentials = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'utf8')), account = credentials.admin ?? credentials;
const authored = JSON.parse(await readFile(new URL('../examples/data-sources.json', import.meta.url), 'utf8'));
const login = await fetch(new URL('/api/auth/login', base), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'engineering', username: account.username, password: account.password }), signal: AbortSignal.timeout(20000) });
assert.equal(login.status, 200, 'Administrator sign-in failed.');
const session = await login.json(), cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function api(route, method = 'GET', body) {
  const reply = await fetch(new URL('/api' + route, base), { method, redirect: 'error', headers: { 'content-type': 'application/json', Cookie: cookie, 'X-SPARK-AUDIENCE': 'engineering', 'X-SPARK-CSRF': session.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.ok(reply.ok, `Workshop ${method} request failed (${reply.status}).`);
  return reply.status === 204 ? null : reply.json();
}
try {
  const catalog = await api('/projects');
  assert.ok(!catalog.projects.some(project => project.name === authored.name), 'Read-only data sources workshop already exists; no changes made.');
  const created = await api('/projects', 'POST', { name: authored.name }), route = '/projects/' + encodeURIComponent(created.id);
  const existing = await api(route + '/project');
  await api(route + '/project', 'PUT', { ...existing, screens: authored.screens, navigation: authored.navigation, templates: [], parameters: {} });
  console.log(`Created unpublished workshop: ${new URL('/designer/' + encodeURIComponent(created.id), base)}`);
  console.log('Follow docs/architecture/DATA_SOURCES.md. No connections, tags, source writes or publication were created.');
} finally { await api('/auth/logout', 'POST', { audience: 'engineering' }); }
