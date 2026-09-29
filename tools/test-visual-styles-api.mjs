#!/usr/bin/env node
// Disposable loopback-only projects. No device writes, connection edits or script execution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readZip, writeZip } from './workshop-packages.mjs';
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.equal(base.protocol, 'http:'); assert.equal(base.port, '5091'); assert.equal(base.pathname, '/');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash);
const suffix = randomUUID().slice(0, 8), created = [];
async function api(path, { method = 'GET', body, raw, binary = false, status = 200 } = {}) {
  const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 400)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const scoped = (id, path) => `/projects/${id}${path}`;
const fixture = JSON.parse(await readFile(new URL('../examples/visual-styles.json', import.meta.url), 'utf8'));
let passed = 0, saved, original;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const mutations = [
  p => p.styles = null, p => p.styles = {}, p => p.styles = [null], p => p.styles.push(structuredClone(p.styles[0])),
  p => p.styles[0].id = 'bad id', p => p.styles[0].id = 'bad\n', p => p.styles[0].name = ' leading', p => p.styles[0].name = 'x'.repeat(81),
  p => p.styles[0].name = 'bad\u0085name', p => p.styles[0].properties = {}, p => p.styles[0].properties = null,
  p => p.styles[0].permissions = 'admin', p => p.styles[0].properties.enabled = true, p => p.styles[0].properties.visible = false,
  p => p.styles[0].properties.text = 'Hidden authority', p => p.styles[0].properties.fontSize = 0, p => p.styles[0].properties.fontSize = 257,
  p => p.styles[0].properties.borderWidth = -1, p => p.styles[0].properties.borderWidth = 33, p => p.styles[0].properties.color = '#fff\n',
  p => p.styles[0].properties.color = 'var(--accent)', p => p.styles[0].properties.color = false,
  p => p.screens[0].components[0].props.styleId = 'missing', p => p.templates[0].components[0].props.styleId = null,
  p => p.styles = [], p => p.styles = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, name: 'Style', properties: { color: '#abc' } })),
];
try {
  original = await api('/projects', { method: 'POST', body: { name: `Visual styles ${suffix}` } }); created.push(original.id);
  const baseline = await api(scoped(original.id, '/project'));
  await check('styles and assignments save exactly across screens/templates without rewriting authored values', async () => {
    saved = await api(scoped(original.id, '/project'), { method: 'PUT', body: { ...baseline, ...fixture, id: original.id } });
    assert.deepEqual(saved.styles, fixture.styles); assert.deepEqual(saved.screens, fixture.screens); assert.deepEqual(saved.templates, fixture.templates);
  });
  await check('explicit publication retains reusable appearance and exact authored input defaults', async () => {
    await api(scoped(original.id, '/project/publish'), { method: 'POST', body: { revision: saved.revision } });
    const runtime = await api(scoped(original.id, '/runtime/project'));
    assert.deepEqual(runtime.styles, fixture.styles); assert.deepEqual(runtime.templates, fixture.templates); assert.deepEqual(runtime.screens, fixture.screens);
  });
  await check('saved style edits remain draft-only until the next explicit publication', async () => {
    const changed = structuredClone(saved); changed.styles[0].properties.backgroundColor = '#cceeff';
    saved = await api(scoped(original.id, '/project'), { method: 'PUT', body: changed });
    assert.deepEqual((await api(scoped(original.id, '/runtime/project'))).styles, fixture.styles);
    await api(scoped(original.id, '/project/publish'), { method: 'POST', body: { revision: saved.revision } });
    assert.deepEqual((await api(scoped(original.id, '/runtime/project'))).styles, saved.styles);
  });
  await check(`${mutations.length} malformed catalogs, values and assignments reject without changing the draft`, async () => {
    for (const mutate of mutations) { const invalid = structuredClone(saved); mutate(invalid); await api(scoped(original.id, '/project'), { method: 'PUT', body: invalid, status: 400 }); }
    assert.deepEqual(await api(scoped(original.id, '/project')), saved);
  });
  let entries;
  await check('package export includes exact style resources and assignments; import stays unpublished', async () => {
    const bytes = await api(scoped(original.id, '/export'), { binary: true }); entries = readZip(bytes);
    assert.deepEqual(JSON.parse(entries.get('project.json')).styles, saved.styles);
    const imported = await api(`/projects/import?name=${encodeURIComponent(`Style import ${suffix}`)}`, { method: 'POST', raw: bytes }); created.push(imported.id);
    assert.equal((await api(scoped(imported.id, '/project/publication'))).published, false);
    const draft = await api(scoped(imported.id, '/project')); assert.deepEqual(draft.styles, saved.styles); assert.deepEqual(draft.screens, saved.screens); assert.deepEqual(draft.templates, saved.templates);
  });
  await check(`${mutations.length} malformed imported style catalogs are rejected before creating projects`, async () => {
    const before = (await api('/projects')).projects.map(item => item.id).sort();
    for (const mutate of mutations) {
      const invalidEntries = new Map(entries); const invalid = JSON.parse(invalidEntries.get('project.json')); mutate(invalid); invalidEntries.set('project.json', Buffer.from(JSON.stringify(invalid)));
      await api(`/projects/import?name=${encodeURIComponent(`Invalid style ${suffix}`)}`, { method: 'POST', raw: writeZip(invalidEntries), status: 400 });
    }
    assert.deepEqual((await api('/projects')).projects.map(item => item.id).sort(), before);
  });
  await check('unreferenced style deletion succeeds once all screen/template assignments are removed', async () => {
    const next = structuredClone(saved); next.styles = [];
    for (const document of [...next.screens, ...next.templates]) for (const component of document.components) delete component.props.styleId;
    saved = await api(scoped(original.id, '/project'), { method: 'PUT', body: next }); assert.deepEqual(saved.styles, []);
  });
} finally {
  for (const id of created) await api(`/projects/${id}/archive`, { method: 'POST', body: { archived: true } });
}
console.log(`${passed} visual-style API groups passed; disposable fixtures archived.`);
