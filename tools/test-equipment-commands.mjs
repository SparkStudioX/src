#!/usr/bin/env node
// Authenticated command API checks against the owned 5093 browser fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readZip } from './workshop-packages.mjs';

const authPath = path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? 'missing');
assert.ok(authPath.startsWith(path.resolve('.data/test-evidence') + path.sep), 'Use disposable fixture credentials.');
const auth = JSON.parse(await fs.readFile(authPath, 'utf8')), base = new URL(auth.baseUrl);
assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port === '5093');
let admin; let checks = 0;
const suffix = randomUUID().slice(0, 8), prefix = `[default]CommandApi${suffix}`;
async function login(account, audience = 'engineering') {
  const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, audience }) });
  assert.equal(response.status, 200); return { audience, csrf: (await response.json()).csrfToken, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function api(route, { method = 'GET', body, session = admin, status = 200, csrf = true, binary = false, raw = false } = {}) {
  const headers = new Headers({ Cookie: session.cookie, 'X-SPARK-AUDIENCE': session.audience });
  if (csrf) headers.set('X-SPARK-CSRF', session.csrf);
  if (body !== undefined) headers.set('Content-Type', raw ? 'application/zip' : 'application/json');
  const response = await fetch(new URL('/api' + route, base), { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, status, `${method} ${route}: ${bytes.toString().slice(0, 600)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const pass = text => { checks++; console.log(`PASS ${text}`); };
admin = await login(auth.admin);
const example = JSON.parse((await fs.readFile('examples/equipment-commands.json', 'utf8')).replaceAll('[default]CommandWorkshop', prefix));
for (const tag of example.tags) await api('/tags', { method: 'POST', body: tag });
const created = await api('/projects', { method: 'POST', body: { name: `Command API fixture ${suffix}` } }), scoped = route => `/projects/${created.id}${route}`;
let draft = await api(scoped('/project'));
draft = await api(scoped('/project'), { method: 'PUT', body: { ...draft, screens: example.screens, templates: [], parameters: {}, commands: example.commands } });
async function publish() { const review = await api(scoped('/project/publication-review')); return api(scoped('/project/publish'), { method: 'POST', body: review }); }
let publication = await publish();
const account = { username: `command-${suffix}`, password: randomUUID() + randomUUID() }, onlyOperate = { username: `operate-${suffix}`, password: randomUUID() + randomUUID() };
await api('/security/users', { method: 'POST', status: 201, body: { ...account, projectGrants: { [created.id]: { view: true, operate: true, commands: true } } } });
await api('/security/users', { method: 'POST', status: 201, body: { ...onlyOperate, projectGrants: { [created.id]: { view: true, operate: true } } } });
const operator = await login(account, 'operator'), denied = await login(onlyOperate, 'operator');
const review = (id, value, options = {}) => api(scoped(`/runtime/commands/${id}/review`), { method: 'POST', session: operator, body: { publishedAt: publication.publishedAt, value }, ...options });
const execute = (id, ticket, options = {}) => api(scoped(`/runtime/commands/${id}/execute`), { method: 'POST', session: operator, body: { token: ticket.token, confirmed: true }, ...options });
await review('speed', 40, { session: denied, status: 403 });
await review('speed', 40, { status: 403 });
let settings = await api('/security/settings'); settings.projectTagPrefixes[created.id] = [prefix + '/']; await api('/security/settings', { method: 'PUT', body: settings });
await review('speed', 40, { csrf: false, status: 403 });
await review('speed', 101, { status: 400 });
await review('run', 'true', { status: 400 });
await review('note', 'x'.repeat(101), { status: 400 });
pass('Commands, readable tag scope, CSRF and typed range/length guards precede dispatch');
for (const [id, value] of [['speed', 40.5], ['run', true], ['note', 'Reviewed synthetic note']]) {
  const ticket = await review(id, value); assert.deepEqual(ticket.requestedValue, value);
  const result = await execute(id, ticket); assert.equal(result.status, 'confirmed'); assert.deepEqual(result.observedValue, value); assert.equal(result.correlationId, ticket.token);
  await execute(id, ticket, { status: 409 });
}
pass('numeric, Boolean and text workshop controls each dispatch once and confirm matching readback');
let ticket = await review('speed', 50);
await execute('speed', ticket, { body: { token: ticket.token, confirmed: false }, status: 409 });
await execute('speed', ticket, { session: denied, status: 403 });
await api('/tags', { method: 'POST', body: { ...example.tags[0], value: 42 } });
assert.equal((await execute('speed', ticket)).status, 'rejected'); await execute('speed', ticket, { status: 409 });
ticket = await review('speed', 50); publication = await publish();
assert.equal((await execute('speed', ticket)).status, 'rejected');
ticket = await review('speed', 50); await api('/tags', { method: 'POST', body: { ...example.tags[0], value: 42, enabled: false } });
assert.equal((await execute('speed', ticket)).status, 'rejected'); await api('/tags', { method: 'POST', body: { ...example.tags[0], value: 42 } });
pass('unconfirmed, denied, stale-value, stale-publication and changed-configuration intents cannot dispatch or replay');
const exported = await api(scoped('/export'), { binary: true }), entries = readZip(exported);
assert.deepEqual(JSON.parse(entries.get('project.json')).commands, example.commands);
const imported = await api('/projects/import?name=Reimported%20command%20fixture', { method: 'POST', raw: true, body: exported });
assert.equal(imported.published, false);
assert.deepEqual((await api(`/projects/${imported.id}/project`)).commands, example.commands);
assert.equal((await api(`/projects/${imported.id}/project/publication`)).published, false);
pass('authored workshop declaration/control schema survives export and unpublished re-import without gateway configuration');
const audits = (await api('/security/audit?limit=500')).entries.filter(item => item.projectId === created.id && item.action.startsWith('equipment.'));
assert.ok(audits.some(item => item.action === 'equipment.review') && audits.some(item => item.outcome === 'confirmed') && audits.some(item => item.outcome === 'rejected'));
assert.ok(!JSON.stringify(audits).includes('Reviewed synthetic note'));
pass('audit correlates reviewed and executed commands without retaining submitted values');
console.log(`PASS ${checks} equipment command HTTP groups; canonical browser workshop remains unchanged.`);
