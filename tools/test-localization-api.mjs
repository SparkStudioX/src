#!/usr/bin/env node
// Authenticated isolated gateway only. New synthetic projects are archived; no equipment or script calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readZip, writeZip } from './workshop-packages.mjs';
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.equal(base.protocol, 'http:'); assert.equal(base.port, '5091'); assert.equal(base.pathname, '/');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash);
const suffix = randomUUID().slice(0, 8), created = [];
async function api(path, { method = 'GET', body, raw, binary = false, status = 200 } = {}) {
  const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 400)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const scoped = (id, path) => `/projects/${id}${path}`;
const source = JSON.parse(await readFile(new URL('../examples/localization.json', import.meta.url), 'utf8'));
const mutations = [
  p => p.localization = null, p => p.localization = [], p => p.localization.extra = true, p => p.localization.locales = [],
  p => p.localization.locales = ['en', 'en'], p => p.localization.locales = ['en', 'es', 'ar'], p => p.localization.locales = ['en\n'],
  p => p.localization.locales = ['en', 'EN'], p => p.localization.defaultLocale = 'de', p => p.localization.messages = [],
  p => p.localization.messages.bad = {}, p => p.localization.messages.bad = { es: 'Nota' }, p => p.localization.messages.bad = { en: '' },
  p => p.localization.messages.bad = { en: null }, p => p.localization.messages.bad = { en: 10 }, p => p.localization.messages.bad = { en: 'x'.repeat(2049) },
  p => p.localization.messages.bad = { en: 'bad\u0085text' }, p => p.localization.messages.bad = { en: 'Note', de: 'Notiz' },
  p => p.localization.messages['bad key'] = { en: 'Caption' }, p => p.localization.messages['station.title'].es = 'Wrong {other}',
  p => p.localization.messages['station.title'].es = 'No parameter', p => p.localization.messages['station.title'].es = '{station} {station}',
  p => p.localization.messages['station.title'].es = 'Broken {station', p => delete p.localization.messages['desk.title'],
  p => p.screens[0].components[0].props.textKey = null, p => p.templates[0].components[0].props.textKey = 'missing',
  p => p.templates[0].components[0].props.text = 'Wrong {machine}', p => p.templates[0].components[1].type = 'passwordInput',
  p => p.localization.messages = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`key${i}`, { en: 'Caption' }])),
  p => p.localization.messages = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, { en: 'x'.repeat(2048) }])),
];
let passed = 0, saved;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  const original = await api('/projects', { method: 'POST', body: { name: `Localization ${suffix}` } }); created.push(original.id);
  const baseline = await api(scoped(original.id, '/project'));
  await check('catalog and assignments save exactly without changing parameter or input defaults', async () => {
    saved = await api(scoped(original.id, '/project'), { method: 'PUT', body: { ...baseline, ...source, id: original.id } });
    assert.deepEqual(saved.localization, source.localization); assert.deepEqual(saved.screens, source.screens); assert.deepEqual(saved.templates, source.templates);
  });
  await check('publication preserves catalog and exact authored controls', async () => {
    await api(scoped(original.id, '/project/publish'), { method: 'POST', body: { revision: saved.revision } });
    const runtime = await api(scoped(original.id, '/runtime/project')); assert.deepEqual(runtime.localization, saved.localization); assert.deepEqual(runtime.screens, saved.screens); assert.deepEqual(runtime.templates, saved.templates);
  });
  await check('translation draft remains separate until explicit publication', async () => {
    const changed = structuredClone(saved); changed.localization.messages['desk.title'].es = 'Nueva entrega'; saved = await api(scoped(original.id, '/project'), { method: 'PUT', body: changed });
    assert.deepEqual((await api(scoped(original.id, '/runtime/project'))).localization, source.localization);
    await api(scoped(original.id, '/project/publish'), { method: 'POST', body: { revision: saved.revision } });
    assert.deepEqual((await api(scoped(original.id, '/runtime/project'))).localization, saved.localization);
  });
  await check(`${mutations.length} malformed catalogs, tokens and assignments reject atomically`, async () => {
    for (const mutate of mutations) { const invalid = structuredClone(saved); mutate(invalid); await api(scoped(original.id, '/project'), { method: 'PUT', body: invalid, status: 400 }); }
    assert.deepEqual(await api(scoped(original.id, '/project')), saved);
  });
  let entries;
  await check('package export/import retains all translations and assignments as an unpublished draft', async () => {
    const bytes = await api(scoped(original.id, '/export'), { binary: true }); entries = readZip(bytes); assert.deepEqual(JSON.parse(entries.get('project.json')).localization, saved.localization);
    const imported = await api(`/projects/import?name=${encodeURIComponent(`Locale import ${suffix}`)}`, { method: 'POST', raw: bytes }); created.push(imported.id);
    const project = await api(scoped(imported.id, '/project')); assert.deepEqual(project.localization, saved.localization); assert.deepEqual(project.templates, saved.templates); assert.deepEqual(project.screens, saved.screens);
    assert.equal((await api(scoped(imported.id, '/project/publication'))).published, false);
  });
  await check(`${mutations.length} malformed package catalogs reject without creating projects`, async () => {
    const before = (await api('/projects')).projects.map(item => item.id).sort();
    for (const mutate of mutations) { const invalidEntries = new Map(entries), invalid = JSON.parse(invalidEntries.get('project.json')); mutate(invalid); invalidEntries.set('project.json', Buffer.from(JSON.stringify(invalid))); await api(`/projects/import?name=${encodeURIComponent(`Invalid locale ${suffix}`)}`, { method: 'POST', raw: writeZip(invalidEntries), status: 400 }); }
    assert.deepEqual((await api('/projects')).projects.map(item => item.id).sort(), before);
  });
} finally { for (const id of created) await api(`/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); }
console.log(`${passed} localization API groups passed; disposable fixtures archived.`);
