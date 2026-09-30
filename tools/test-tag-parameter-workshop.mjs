#!/usr/bin/env node
// Authored setup workshop on an owned loopback fixture. Every tag/project/account is unique.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readZip } from './workshop-packages.mjs';

const authPath = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? 'missing');
assert.ok(authPath.startsWith(path.resolve('.data/test-evidence') + path.sep), 'Use disposable fixture credentials.');
const auth = JSON.parse(await fs.readFile(authPath, 'utf8')), base = new URL(auth.baseUrl);
assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && ['5091', '5093'].includes(base.port));
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const suffix = randomUUID().slice(0, 8), prefix = `[default]TagParameterApi${suffix}`, created = [], tags = [];
let admin, user, projectId, publication, checks = 0, failure;
async function login(account, audience) {
  const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
  assert.equal(response.status, 200);
  return { audience, csrf: (await response.json()).csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function api(route, { method = 'GET', body, session = admin, status = 200, binary = false, raw = false } = {}) {
  const headers = new Headers({ Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience, 'X-SPARK-CSRF': session.csrf });
  if (body !== undefined) headers.set('Content-Type', raw ? 'application/zip' : 'application/json');
  const response = await fetch(new URL('/api' + route, base), { method, headers, redirect: 'error', body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${route}: ${bytes.toString().slice(0, 600)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const scoped = route => `/projects/${projectId}${route}`;
const pass = name => { checks++; console.log(`PASS ${name}`); };
async function action(row, session, options = {}) {
  return api(scoped('/runtime/screens/tag-template-parameters/components/preview/action'), { method: 'POST', session,
    body: { publishedAt: publication.publishedAt, instancePath: [{ instanceId: 'machines', rowId: row }, { instanceId: 'form' }], inputs: { note: `Only ${row}` } }, ...options });
}
function successful(response) { assert.equal(response.success, true, response.stderr); return response.result; }
try {
  admin = await login(auth.admin, 'engineering');
  const operator = await login(auth.admin, 'operator');
  const example = JSON.parse((await fs.readFile('examples/tag-template-parameters.json', 'utf8')).replaceAll('[default]BindingWorkshop', prefix));
  for (const definition of example.tags) { await api('/tags', { method: 'POST', body: definition }); tags.push(definition.path); }
  projectId = (await api('/projects', { method: 'POST', body: { name: `Tag parameter fixture ${suffix}` } })).id; created.push(projectId);
  let project = await api(scoped('/project'));
  project = await api(scoped('/project'), { method: 'PUT', body: { ...project, parameters: {}, screens: example.screens, templates: example.templates, navigation: { mode: 'none', startupScreenId: example.screens[0].id, items: [] } } });
  publication = await api(scoped('/project/publish'), { method: 'POST', body: await api(scoped('/project/publication-review')) });
  assert.deepEqual(successful(await action('a', operator)), { parameters: { machine: 'A', count: 12 }, inputs: { note: 'Only a' } });
  assert.deepEqual(successful(await action('b', operator)), { parameters: { machine: 'B', count: 27 }, inputs: { note: 'Only b' } });
  pass('published workshop resolves typed tag parameters separately for saved nested rows');
  await action('missing', operator, { status: 404 });
  await action('a', operator, { status: 400, body: { publishedAt: publication.publishedAt, parameters: { count: 999 }, instancePath: [{ instanceId: 'machines', rowId: 'a' }, { instanceId: 'form' }] } });
  await api('/tags', { method: 'POST', body: { ...example.tags[0], value: 31 } });
  assert.equal(successful(await action('a', operator)).parameters.count, 31);
  assert.equal(successful(await action('b', operator)).parameters.count, 27);
  await api('/tags', { method: 'POST', body: { ...example.tags[0], enabled: false } });
  await action('a', operator, { status: 400 });
  await api('/tags', { method: 'POST', body: example.tags[0] });
  pass('actions reconstruct current gateway samples and reject forged parameters, missing rows and unavailable quality');
  const account = { username: `tag-parameter-${suffix}`, password: randomUUID() + randomUUID() };
  user = await api('/security/users', { method: 'POST', status: 201, body: { ...account, projectGrants: { [projectId]: { view: true, operate: true } } } });
  const restricted = await login(account, 'operator');
  await action('a', restricted, { status: 400 });
  const settings = await api('/security/settings'); settings.projectTagPrefixes[projectId] = [example.tags[0].path];
  await api('/security/settings', { method: 'PUT', body: settings });
  assert.equal(successful(await action('a', restricted)).parameters.count, 12);
  await action('b', restricted, { status: 400 });
  pass('operator tag-read permission is enforced inside server parameter reconstruction at every addressed row');
  const exported = await api(scoped('/export'), { binary: true }), entries = readZip(exported);
  assert.deepEqual(JSON.parse(entries.get('project.json')), project);
  assert.ok(![...entries.keys()].some(name => /tags|security|connections/.test(name)));
  const imported = await api('/projects/import?name=Tag%20parameter%20reimport', { method: 'POST', raw: true, body: exported }); created.push(imported.id);
  assert.equal(imported.published, false);
  assert.deepEqual((await api(`/projects/${imported.id}/project`)).templates, example.templates);
  pass('setup workshop re-export/re-import preserves authored bindings without gateway tags or a publication');
} catch (reason) { failure = reason; }
finally {
  if (admin) {
    if (user) try { await api(`/security/users/${user.id}`, { method: 'PUT', body: { ...user, disabled: true } }); } catch (reason) { failure ??= reason; }
    if (projectId) try { const settings = await api('/security/settings'); delete settings.projectTagPrefixes[projectId]; await api('/security/settings', { method: 'PUT', body: settings }); } catch (reason) { failure ??= reason; }
    for (const id of created) try { await api(`/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (reason) { failure ??= reason; }
    for (const tag of tags) try { await api(`/tag-definitions?path=${encodeURIComponent(tag)}`, { method: 'DELETE', status: 204 }); } catch (reason) { failure ??= reason; }
  }
}
if (failure) throw failure;
console.log(`PASS ${checks} tag parameter HTTP groups; own projects archived, tags removed and test account disabled.`);
