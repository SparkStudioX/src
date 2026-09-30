#!/usr/bin/env node
// Independently authored, synthetic memory/expression workshop. No device endpoints or operations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2), publish = args.includes('--publish'), positional = args.filter(item => !item.startsWith('--'));
assert.ok(args.every(item => !item.startsWith('--') || item === '--publish') && positional.length <= 1, 'Use an optional local URL and --publish.');
const base = new URL(positional[0] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && ['5090', '5091', '5093'].includes(base.port) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Use a plain local development URL on port 5090, 5091 or 5093.');
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to a protected local administrator JSON file.');
const credentials = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'utf8')), account = credentials.admin ?? credentials;
assert.ok(typeof account.username === 'string' && typeof account.password === 'string', 'Administrator credentials are required.');
const example = JSON.parse(await readFile(new URL('../examples/unit-model-workshop.json', import.meta.url), 'utf8'));
const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account.username, password: account.password, audience: 'engineering' }), redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200, 'Administrator sign-in failed.');
const login = await response.json(), cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function api(route, method = 'GET', body) {
  const reply = await fetch(new URL('/api' + route, base), { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-SPARK-AUDIENCE': 'engineering', 'X-SPARK-CSRF': login.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const text = await reply.text(); if (!reply.ok) throw new Error(`${method} ${route}: HTTP ${reply.status}: ${text.slice(0, 300)}`); return text ? JSON.parse(text) : null;
}
try {
  const catalog = await api('/projects'), model = await api('/tag-engineering/export'), definitions = await api('/tag-definitions');
  assert.ok(!catalog.projects.some(project => project.name === example.name), 'The workshop project already exists. No changes made.');
  assert.ok(model.provider.enabled, 'Enable the default provider before loading this workshop.');
  assert.ok(!definitions.some(tag => tag.path.startsWith('[default]UnitModelWorkshop/')) && !model.udtDefinitions.some(item => item.id === 'WorkshopCounter') && !model.scanGroups.some(item => item.name === 'WorkshopRefresh'), 'Workshop tag resources already exist. No changes made.');
  const package_ = example.tagPackage, preview = await api('/tag-engineering/preview', 'POST', package_);
  assert.ok(preview.canApply && preview.changes.every(item => item.action === 'add' || item.action === 'unchanged'), 'Workshop tag model conflicts with gateway configuration.');
  await api('/tag-engineering/apply', 'POST', { package: package_, revision: preview.revision, previewToken: preview.previewToken });
  const project = await api('/projects', 'POST', { name: example.name }), route = `/projects/${project.id}`;
  const draft = await api(route + '/project');
  const saved = await api(route + '/project', 'PUT', { ...draft, screens: example.screens, navigation: example.navigation, templates: [] });
  if (publish) await api(route + '/project/publish', 'POST', { revision: saved.revision });
  console.log(`Created ${example.name}: two UDT instances, six synthetic tags, one scan group. ${publish ? 'Published explicitly.' : 'Open Designer and publish when ready.'}`);
  console.log(new URL(`${publish ? '/runtime/' : '/designer/'}${project.id}`, base).href);
} finally { await api('/auth/logout', 'POST', { audience: 'engineering' }); }
