#!/usr/bin/env node
// Loads an independently authored draft. Device connections and commands require separate user setup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const arguments_ = process.argv.slice(2);
assert.ok(arguments_.length <= 1 && arguments_.every(value => !value.startsWith('--')), 'Supply only a local gateway URL; publication is performed separately in Designer.');
const gateway = new URL(arguments_[0] ?? 'http://127.0.0.1:5091');
assert.ok(gateway.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(gateway.hostname)
  && ['5090', '5091', '5093', '6090'].includes(gateway.port) && gateway.pathname === '/'
  && !gateway.username && !gateway.password && !gateway.search && !gateway.hash, 'Use an isolated local gateway.');
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to your local administrator credential file.');
const credentials = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'utf8'));
const account = credentials.admin ?? credentials;
const authored = JSON.parse(await readFile(new URL('../examples/industrial-devices-workshop.json', import.meta.url), 'utf8'));
const authenticated = await fetch(new URL('/api/auth/login', gateway), {
  method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ audience: 'engineering', username: account.username, password: account.password }), signal: AbortSignal.timeout(20000),
});
assert.equal(authenticated.status, 200, 'Administrator sign-in failed.');
const session = await authenticated.json();
const cookie = authenticated.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function request(route, method = 'GET', body) {
  const response = await fetch(new URL('/api' + route, gateway), {
    method, redirect: 'error', headers: { 'content-type': 'application/json', Cookie: cookie, 'X-SPARK-AUDIENCE': 'engineering', 'X-SPARK-CSRF': session.csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  assert.ok(response.ok, `Workshop ${method} request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}
try {
  const projects = await request('/projects');
  assert.ok(!projects.projects.some(project => project.name === authored.name), 'Industrial devices workshop already exists; no changes made.');
  const created = await request('/projects', 'POST', { name: authored.name });
  const route = '/projects/' + encodeURIComponent(created.id);
  const draft = await request(route + '/project');
  await request(route + '/project', 'PUT', { ...draft, screens: authored.screens, commands: authored.commands, navigation: authored.navigation, templates: [], parameters: {} });
  console.log(`Created unpublished workshop: ${new URL('/designer/' + encodeURIComponent(created.id), gateway)}`);
  console.log('Follow INDUSTRIAL_DEVICE_CONNECTIONS.md to configure isolated synthetic points. No connections, tags, publication or equipment writes were created.');
} finally { await request('/auth/logout', 'POST', { audience: 'engineering' }); }
