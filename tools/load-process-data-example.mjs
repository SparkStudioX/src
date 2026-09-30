#!/usr/bin/env node
// Authored synthetic setup only. Credentials and all generated data remain local.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2), publish = args.includes('--publish'), positional = args.filter(arg => !arg.startsWith('--'));
assert.ok(args.every(arg => !arg.startsWith('--') || arg === '--publish') && positional.length <= 1, 'Use one optional local URL and --publish.');
const base = new URL(positional[0] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && ['5090', '5091', '5093', '6090'].includes(base.port) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Choose a local development gateway.');
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to a protected local administrator credential file.');
const stored = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'utf8')), account = stored.admin ?? stored;
assert.ok(typeof account.username === 'string' && typeof account.password === 'string');
const example = JSON.parse(await readFile(new URL('../examples/process-data-workshop.json', import.meta.url), 'utf8'));
const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'engineering', username: account.username, password: account.password }), redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200, 'Administrator login failed.');
const login = await response.json(), cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function api(route, method = 'GET', body) {
  const reply = await fetch(new URL('/api' + route, base), { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-SPARK-AUDIENCE': 'engineering', 'X-SPARK-CSRF': login.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const raw = await reply.text(); assert.ok(reply.ok, `${method} ${route}: HTTP ${reply.status} ${raw.slice(0, 300)}`); return raw ? JSON.parse(raw) : null;
}
try {
  const [catalog, tags, config] = await Promise.all([api('/projects'), api('/tag-definitions'), api('/gateway/process-data')]);
  assert.ok(!catalog.projects.some(project => project.name === example.name), 'Workshop project already exists; no changes made.');
  assert.ok(!tags.some(tag => tag.path.startsWith('[default]ProcessWorkshop/')), 'Workshop tags already exist; no changes made.');
  assert.ok(!config.alarms.some(alarm => alarm.id.startsWith('process-workshop-')) && !config.history.some(item => item.tagPath.startsWith('[default]ProcessWorkshop/')), 'Workshop recording rules already exist; no changes made.');
  const package_ = { format: 'sparkstudio.tags', version: 1, tags: example.tags };
  const preview = await api('/tag-engineering/preview', 'POST', package_);
  assert.ok(preview.canApply !== false && preview.changes.every(item => item.action === 'add'), 'Tag preview must only add the workshop tag.');
  await api('/tag-engineering/apply', 'POST', { package: package_, revision: preview.revision, previewToken: preview.previewToken });
  await api('/gateway/process-data', 'PUT', { ...config, alarms: [...config.alarms, ...example.processData.alarms], history: [...config.history, ...example.processData.history] });
  const project = await api('/projects', 'POST', { name: example.name }), route = `/projects/${project.id}`;
  const draft = await api(route + '/project');
  const saved = await api(route + '/project', 'PUT', { ...draft, screens: example.screens, navigation: example.navigation, parameters: example.parameters, commands: example.commands, templates: [] });
  if (publish) {
    const review = await api(route + '/project/publication-review');
    assert.equal(review.revision, saved.revision, 'Project changed before publication review.');
    await api(route + '/project/publish', 'POST', { revision: review.revision, scriptsRevision: review.scriptsRevision, reviewToken: review.reviewToken });
  }
  console.log(`Created ${example.name}: one synthetic memory tag, two alarms and one retained history source. ${publish ? 'Published.' : 'Review in Designer and explicitly publish.'}`);
  console.log(new URL(`${publish ? '/runtime/' : '/designer/'}${project.id}`, base).href);
} finally { await api('/auth/logout', 'POST', { audience: 'engineering' }); }
