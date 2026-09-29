#!/usr/bin/env node
// Independently authored fixture. Explicit administrator credentials come from a local-only file, never argv or source.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2), publish = args.includes('--publish'), positional = args.filter(item => !item.startsWith('--'));
assert.ok(args.every(item => !item.startsWith('--') || item === '--publish') && positional.length <= 1, 'Use an optional local URL and --publish.');
const base = new URL(positional[0] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && ['5090', '5091'].includes(base.port) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Use a plain local development URL on port 5090 or 5091.');
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to a protected local JSON file containing username and password (or an existing test fixture with an admin entry).');
const credentials = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'utf8')), account = credentials.admin ?? credentials;
assert.ok(typeof account.username === 'string' && typeof account.password === 'string', 'Administrator credentials are required.');
const example = JSON.parse(await readFile(new URL('../examples/tag-engineering.json', import.meta.url), 'utf8'));
const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account.username, password: account.password, audience: 'engineering' }), redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200, 'Administrator sign-in failed.');
const login = await response.json(), cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function api(route, method = 'GET', body) {
  const reply = await fetch(new URL('/api' + route, base), { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-SPARK-AUDIENCE': 'engineering', 'X-SPARK-CSRF': login.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const text = await reply.text(); if (!reply.ok) throw new Error(`${method} ${route}: HTTP ${reply.status}: ${text.slice(0, 300)}`); return text ? JSON.parse(text) : null;
}
try {
  const catalog = await api('/projects'), definitions = await api('/tag-definitions');
  assert.ok(!catalog.projects.some(project => project.name === example.name), 'The workshop project already exists. No changes made.');
  assert.ok(!definitions.some(tag => example.tags.some(item => item.path === tag.path)), 'The reserved [default]TagWorkshop namespace is already configured. No changes made.');
  const package_ = { format: 'sparkstudio.tags', version: 1, tags: example.tags }, preview = await api('/tag-engineering/preview', 'POST', package_);
  assert.ok(preview.changes.every(item => item.action === 'add'), 'The workshop must create new tags only.');
  await api('/tag-engineering/apply', 'POST', { package: package_, revision: preview.revision, previewToken: preview.previewToken });
  const project = await api('/projects', 'POST', { name: example.name }), route = `/projects/${project.id}`;
  const draft = await api(route + '/project');
  const saved = await api(route + '/project', 'PUT', { ...draft, screens: example.screens, navigation: example.navigation, templates: [] });
  if (publish) await api(route + '/project/publish', 'POST', { revision: saved.revision });
  console.log(`Created ${example.name} with four synthetic tags. ${publish ? 'The project is published.' : 'Open Designer and publish when ready.'}`);
  console.log(new URL(`${publish ? '/runtime/' : '/designer/'}${project.id}`, base).href);
} finally { await api('/auth/logout', 'POST', { audience: 'engineering' }); }
