#!/usr/bin/env node
// This suite creates disposable projects and memory tags only on the isolated 5091 gateway.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] || 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
assert.equal(base.port, '5091');
assert.equal(base.pathname, '/');
assert.equal(base.protocol, 'http:');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const suffix = randomUUID().slice(0, 8);
const created = [];
const tagPath = `[default]ProjectTests/${suffix}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(new URL('/api' + path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}
const projectApi = (id, path, ...args) => api(`/projects/${id}${path}`, ...args);
async function create(name) {
  const result = await api('/projects', 'POST', { name: `${name} ${suffix}` });
  created.push(result.id); return result;
}
let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for project events.');
}
let tagCreated = false;
try {
  const listing = await api('/projects');
  const defaultId = listing.defaultProjectId;
  await test('default API aliases refer to the stable catalog project', async () => {
    const alias = await api('/project');
    assert.deepEqual(alias, await projectApi(defaultId, '/project'));
    assert.equal(alias.id, defaultId);
    assert.ok(listing.projects.some(item => item.id === defaultId && item.isDefault));
    await api(`/projects/${defaultId}/archive`, 'POST', { archived: true }, 409);
  });
  const a = await create('Application A'), b = await create('Application B');
  await test('new projects have independent blank drafts and no publication', async () => {
    for (const item of [a, b]) {
      const draft = await projectApi(item.id, '/project');
      assert.equal(draft.id, item.id); assert.equal(draft.screens.length, 1);
      assert.equal(draft.screens[0].components.length, 0);
      assert.deepEqual(await projectApi(item.id, '/queries'), []);
      assert.equal((await projectApi(item.id, '/project/publication')).published, false);
      await projectApi(item.id, '/runtime/project', 'GET', undefined, 404);
    }
  });
  await test('rename checks revisions and never changes a project URL identity', async () => {
    const renamed = await api(`/projects/${a.id}`, 'PATCH', { name: `Renamed ${suffix}`, revision: a.revision });
    assert.equal(renamed.id, a.id); assert.equal(renamed.name, `Renamed ${suffix}`);
    await api(`/projects/${a.id}`, 'PATCH', { name: 'stale', revision: a.revision }, 409);
    assert.equal((await projectApi(b.id, '/project')).name, b.name);
  });
  await test('save and publication snapshots stay inside the requested project', async () => {
    let draft = await projectApi(a.id, '/project');
    draft.screens[0].components.push({ id: 'heading', type: 'label', x: 20, y: 20, width: 300, height: 50, props: { text: 'Only in A' } });
    draft = await projectApi(a.id, '/project', 'PUT', draft);
    await projectApi(a.id, '/project/publish', 'POST', { revision: draft.revision });
    draft.screens[0].components[0].props.text = 'Unpublished A';
    await projectApi(a.id, '/project', 'PUT', draft);
    assert.equal((await projectApi(a.id, '/runtime/project')).screens[0].components[0].props.text, 'Only in A');
    assert.equal((await projectApi(b.id, '/project')).screens[0].components.length, 0);
    await projectApi(b.id, '/runtime/project', 'GET', undefined, 404);
  });
  await test('identical query IDs can have independent definitions', async () => {
    for (const item of [a, b]) await projectApi(item.id, '/queries/shared-id', 'PUT', {
      name: item.id, connectionId: 'sample', kind: 'query', sql: `SELECT '${item.id}'`, parameters: [],
    });
    assert.equal((await projectApi(a.id, '/queries'))[0].name, a.id);
    assert.equal((await projectApi(b.id, '/queries'))[0].name, b.id);
  });
  await test('Python libraries and client events use their own project namespace', async () => {
    for (const item of [a, b]) {
      let scripts = await projectApi(item.id, '/scripts/resources');
      scripts.resources = [
        { id: 'identity', name: 'identity', type: 'library', code: `def value():\n    return '${item.id}'` },
        { id: 'browser', name: 'Browser', type: 'client', event: 'startup', enabled: true, code: `console.info('${item.id}');` },
      ];
      scripts = await projectApi(item.id, '/scripts/resources', 'PUT', scripts);
      await projectApi(item.id, '/scripts/publish', 'POST', { revision: scripts.revision });
      const run = await projectApi(item.id, '/scripts/run', 'POST', { code: 'result = project.identity.value()' });
      assert.equal(run.success, true, run.stderr); assert.equal(run.result, item.id);
      assert.equal((await projectApi(item.id, '/runtime/scripts')).resources[0].code, `console.info('${item.id}');`);
    }
  });
  await test('duplicate includes draft queries and scripts without activating publications', async () => {
    const duplicate = await api(`/projects/${a.id}/duplicate`, 'POST', { name: `Copy ${suffix}` }); created.push(duplicate.id);
    const copied = await projectApi(duplicate.id, '/project');
    assert.equal(copied.id, duplicate.id);
    assert.equal(copied.screens[0].components[0].props.text, 'Unpublished A');
    assert.deepEqual(await projectApi(duplicate.id, '/queries'), await projectApi(a.id, '/queries'));
    assert.deepEqual((await projectApi(duplicate.id, '/scripts/resources')).resources, (await projectApi(a.id, '/scripts/resources')).resources);
    assert.equal((await projectApi(duplicate.id, '/scripts/publication')).published, false);
    assert.equal((await projectApi(duplicate.id, '/project/publication')).published, false);
  });
  await test('gateway tags are shared while archive stops project timer execution', async () => {
    await api('/tags', 'POST', { path: tagPath, kind: 'memory', dataType: 'Int32', value: 0 }); tagCreated = true;
    const count = async () => (await api('/tags/read', 'POST', { paths: [tagPath] }))[0].value;
    let scripts = await projectApi(a.id, '/scripts/resources');
    scripts.resources.push({ id: 'timer', name: 'Counter', type: 'gateway', event: 'timer', intervalMs: 100, enabled: true,
      code: 'path = parameters["path"]\nv = system.tag.readBlocking([path])[0].value\nsystem.tag.writeBlocking([path], [v + 1])', parameters: { path: tagPath } });
    scripts = await projectApi(a.id, '/scripts/resources', 'PUT', scripts);
    await projectApi(a.id, '/scripts/publish', 'POST', { revision: scripts.revision });
    await until(async () => await count() >= 2);
    assert.ok((await projectApi(b.id, '/tag-definitions')).some(item => item.path === tagPath));
    await api(`/projects/${a.id}/archive`, 'POST', { archived: true });
    const stopped = await count(); await delay(600); assert.equal(await count(), stopped);
    await projectApi(a.id, '/project', 'GET', undefined, 404);
    await projectApi(a.id, '/runtime/project', 'GET', undefined, 404);
    await projectApi(a.id, '/tags', 'GET', undefined, 404);
    assert.equal((await api('/projects')).projects.find(item => item.id === a.id).archived, true);
    await api(`/projects/${a.id}/archive`, 'POST', { archived: false });
    await until(async () => await count() > stopped);
    assert.equal((await projectApi(a.id, '/runtime/project')).screens[0].components[0].props.text, 'Only in A');
  });
  await test('project input validation rejects invalid names and unknown projects', async () => {
    for (const name of ['', ' ', 'x'.repeat(121), 'bad\nname']) await api('/projects', 'POST', { name }, 400);
    await projectApi('missing-project', '/project', 'GET', undefined, 404);
    await projectApi('missing-project', '/tags', 'GET', undefined, 404);
    assert.deepEqual(await projectApi(a.id, '/connections'), await projectApi(b.id, '/connections'));
  });
} finally {
  for (const id of created) await api(`/projects/${id}/archive`, 'POST', { archived: true });
  if (tagCreated) await api(`/tag-definitions?path=${encodeURIComponent(tagPath)}`, 'DELETE', undefined, 204);
}
console.log(`Passed ${passed} project-management integration groups.`);
