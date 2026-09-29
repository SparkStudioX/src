#!/usr/bin/env node
// Uses only a disposable local gateway on port 5091. Restores and republishes
// the saved script draft; removes only uniquely named memory-tag fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'Script-resource tests require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, { method = 'GET', body, status = 200, timeout = 20000 } = {}) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${description}.`);
}
const original = await api('/api/scripts/resources');
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const libraryName = `workorders_${suffix}`;
const helperName = `helpers_${suffix}`;
const paths = ['Startup', 'Timer', 'LateWrite'].map(name => `[default]Scripts_${suffix}/${name}`);
const created = [];
let draft = original;
let changed = false;
let failure;
const resources = () => [
  { id: 'helpers', name: helperName, type: 'library', code: 'def decorate(value):\n    return "v1:" + value' },
  { id: 'workorders', name: libraryName, type: 'library', code: `from project import ${helperName}\ndef describe(value):\n    return ${helperName}.decorate(value)` },
  { id: 'manual', name: 'Manual library test', type: 'gateway', event: 'startup', code: `from project import ${libraryName}\nresult = ${libraryName}.describe(parameters["name"])`, parameters: { name: 'default', enabled: false, nullable: null } },
  { id: 'startup', name: 'Startup counter', type: 'gateway', event: 'startup', code: 'path = parameters["path"]\nvalue = system.tag.readBlocking([path])[0].value\nsystem.tag.writeBlocking([path], [value + 1])\nresult = value + 1', parameters: { path: paths[0] } },
  { id: 'timer', name: 'Fixed delay counter', type: 'gateway', event: 'timer', intervalMs: 100, code: 'import time\npath = parameters["path"]\nvalue = system.tag.readBlocking([path])[0].value\ntime.sleep(0.18)\nsystem.tag.writeBlocking([path], [value + 1])\nresult = value + 1', parameters: { path: paths[1] } },
  { id: 'client', name: 'Browser startup', type: 'client', event: 'startup', enabled: true, code: 'console.info("browser-only-resource");', parameters: { label: 'Browser' } },
  { id: 'client-screen', name: 'Browser screen open', type: 'client', event: 'screenOpen', enabled: false, code: 'console.info("disabled-browser-resource");' },
];
const save = async next => { draft = await api('/api/scripts/resources', { method: 'PUT', body: next }); changed = true; return draft; };
const publish = revision => api('/api/scripts/publish', { method: 'POST', body: { revision } });
const run = (id, { source = 'draft', revision = draft.revision, parameters, status = 200 } = {}) => api(`/api/scripts/resources/${id}/run`, { method: 'POST', body: { revision, source, parameters }, status });
const counts = async () => (await api('/api/tags/read', { method: 'POST', body: { paths } })).map(tag => tag.value);
const edit = (id, change) => { const next = structuredClone(draft); change(next.resources.find(resource => resource.id === id)); return next; };
const logs = async id => (await api('/api/scripts/events/logs')).filter(entry => entry.resourceId === id);

try {
  for (const path of paths) { await api('/api/tags', { method: 'POST', body: { path, kind: 'memory', dataType: 'Int32', value: 0 } }); created.push(path); }
  await test('saved resource drafts normalize defaults without activating events', async () => {
    await save({ revision: original.revision, resources: resources() });
    assert.equal(draft.resources.find(resource => resource.id === 'workorders').enabled, true);
    assert.equal(draft.resources.find(resource => resource.id === 'timer').enabled, false);
    assert.equal(draft.resources.find(resource => resource.id === 'manual').parameters.enabled, false);
    await delay(250);
    assert.deepEqual(await counts(), [0, 0, 0]);
  });
  await test('optimistic save and publish reject stale revisions without changing the draft', async () => {
    await api('/api/scripts/resources', { method: 'PUT', body: { ...draft, revision: draft.revision - 1 }, status: 409 });
    await api('/api/scripts/publish', { method: 'POST', body: { revision: draft.revision - 1 }, status: 409 });
    assert.deepEqual(await api('/api/scripts/resources'), draft);
  });
  await test('published library imports work through imports and implicit project access', async () => {
    await publish(draft.revision);
    const saved = await run('manual', { parameters: { name: 'Order 7', enabled: true, nullable: 7 } });
    assert.equal(saved.success, true, saved.stderr);
    assert.equal(saved.result, 'v1:Order 7');
    const consoleRun = await api('/api/scripts/run', { method: 'POST', body: { code: `result = project.${libraryName}.describe("console")` } });
    assert.equal(consoleRun.result, 'v1:console');
    const moduleRun = await run('workorders');
    assert.equal(moduleRun.success, true, moduleRun.stderr);
  });
  await test('runtime browser endpoint contains only enabled published JavaScript', async () => {
    const client = await api('/api/runtime/scripts');
    assert.equal(client.revision, draft.revision);
    assert.equal(client.resources.length, 1);
    assert.equal(client.resources[0].type, 'client');
    assert.equal(client.resources[0].code, 'console.info("browser-only-resource");');
    assert.ok(!JSON.stringify(client).includes(libraryName));
    await run('client', { status: 400 });
  });
  await test('manual resource runs reject stale identity and undeclared or mistyped parameters', async () => {
    await run('manual', { revision: draft.revision - 1, status: 409 });
    await run('missing', { status: 404 });
    await run('manual', { parameters: { unexpected: 1 }, status: 400 });
    await run('manual', { parameters: { name: 1 }, status: 400 });
    await run('manual', { parameters: { enabled: 'false' }, status: 400 });
    await run('manual', { parameters: { nullable: [] }, status: 400 });
    await run('manual', { source: 'other', status: 400 });
  });
  await test('library draft edits remain isolated until explicit script publication', async () => {
    const priorRevision = draft.revision;
    await save(edit('helpers', resource => resource.code = 'def decorate(value):\n    return "v2:" + value'));
    const before = await run('manual');
    assert.equal(before.result, 'v1:default');
    assert.equal((await run('manual', { source: 'published', revision: priorRevision })).result, 'v1:default');
    await publish(draft.revision);
    assert.equal((await run('manual')).result, 'v2:default');
  });
  await test('enabled startup executes once and same-revision publication is idempotent', async () => {
    await save(edit('startup', resource => resource.enabled = true));
    const metadata = await publish(draft.revision);
    await until(async () => (await counts())[0] === 1, 'startup event');
    const repeated = await publish(draft.revision);
    assert.equal(repeated.publishedAt, metadata.publishedAt);
    await delay(300);
    assert.equal((await counts())[0], 1);
    const state = await api('/api/scripts/events/status');
    assert.equal(state.activeRevision, draft.revision);
    assert.equal(state.resources.find(item => item.id === 'startup').lastSuccess, true);
  });
  await test('fixed-delay timers complete before scheduling their next invocation', async () => {
    const next = edit('timer', resource => resource.enabled = true);
    next.resources.find(resource => resource.id === 'startup').enabled = false;
    await save(next);
    await publish(draft.revision);
    await until(async () => (await logs('timer')).filter(entry => entry.status === 'succeeded').length >= 3, 'three timer runs');
    const finished = (await logs('timer')).filter(entry => entry.status === 'succeeded').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let i = 1; i < finished.length; i++) {
      assert.ok(Date.parse(finished[i].startedAt) - Date.parse(finished[i - 1].finishedAt) >= 85, 'Timer used fixed delay after completion.');
    }
  });
  await test('publishing cancels in-flight old events and disabling stops future runs', async () => {
    await save(edit('timer', resource => { resource.code = 'import time\ntime.sleep(5)\nsystem.tag.writeBlocking([parameters["path"]], [999])'; resource.parameters.path = paths[2]; }));
    await publish(draft.revision);
    const revision = draft.revision;
    await until(async () => (await logs('timer')).some(entry => entry.revision === revision && entry.status === 'running'), 'old timer running');
    await save(edit('timer', resource => resource.enabled = false));
    await publish(draft.revision);
    await until(async () => (await logs('timer')).some(entry => entry.revision === revision && entry.status === 'cancelled'), 'old timer cancellation');
    assert.equal((await counts())[2], 0);
    const count = (await logs('timer')).length;
    await delay(350);
    assert.equal((await logs('timer')).length, count);
  });
  await test('one resource cannot overlap manual invocations', async () => {
    await save(edit('manual', resource => resource.code = 'import time\ntime.sleep(0.7)\nresult = "done"'));
    const pending = run('manual');
    await until(async () => (await logs('manual')).some(entry => entry.revision === draft.revision && entry.status === 'running'), 'manual resource lease');
    await run('manual', { status: 409 });
    assert.equal((await pending).result, 'done');
  });
  await test('run logs capture bounded stdout and tracebacks without leaking source to runtime', async () => {
    await save(edit('manual', resource => resource.code = 'print("x" * 20000)\nraise ValueError("test-failure")'));
    const result = await run('manual');
    assert.equal(result.success, false);
    const latest = (await logs('manual'))[0];
    assert.equal(latest.status, 'failed');
    assert.ok(latest.stdout.length < 8300);
    assert.match(latest.stderr, /test-failure/);
    assert.ok((await api('/api/scripts/events/logs')).length <= 100);
  });
  await test('worker execution ends at its ten-second limit', async () => {
    await save(edit('manual', resource => resource.code = 'import time\ntime.sleep(30)\nresult = "too late"'));
    const started = Date.now();
    const result = await run('manual');
    assert.equal(result.success, false);
    assert.match(result.stderr, /10 second/);
    assert.ok(Date.now() - started < 16000);
  });
  await test('malformed resource definitions are rejected atomically', async () => {
    const variants = [
      next => next.resources.push(structuredClone(next.resources[0])),
      next => next.resources[0].name = 'nested.module',
      next => next.resources[0].name = 'class',
      next => next.resources[0].enabled = 'true',
      next => next.resources[0].code = 'a'.repeat(65537),
      next => next.resources[0].parameters = { value: [] },
      next => next.resources[0].parameters = { value: 9007199254740992 },
      next => next.resources[0].parameters = { value: 'a'.repeat(4097) },
      next => next.resources[0].parameters = null,
      next => next.resources[0].type = 'shell',
      next => next.resources.find(resource => resource.id === 'timer').intervalMs = 0,
      next => next.resources.find(resource => resource.id === 'timer').intervalMs = 100.5,
      next => next.resources.find(resource => resource.id === 'timer').intervalMs = null,
      next => next.resources.find(resource => resource.id === 'timer').event = 'screenOpen',
      next => next.resources.find(resource => resource.id === 'client').event = 'timer',
    ];
    for (const change of variants) {
      const next = structuredClone(draft); change(next);
      await api('/api/scripts/resources', { method: 'PUT', body: next, status: 400 });
    }
    assert.deepEqual(await api('/api/scripts/resources'), draft);
  });
  await test('named read queries remain Dataset values inside published-library scripts', async () => {
    await save(edit('manual', resource => resource.code = 'dataset = system.db.runNamedQuery("production-summary", {"line": "Line1"})\nresult = {"rows": dataset.getRowCount(), "line": dataset.getValueAt(0, "Line")}'));
    const result = await run('manual');
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result, { rows: 1, line: 'Line1' });
  });
} catch (error) { failure = error; }
finally {
  try {
    if (changed) {
      const latest = await api('/api/scripts/resources');
      const restored = await api('/api/scripts/resources', { method: 'PUT', body: { ...original, revision: latest.revision } });
      await publish(restored.revision);
      await until(async () => (await api('/api/scripts/events/status')).activeRevision === restored.revision, 'restored resource activation');
    }
    for (const path of created) await api(`/api/tag-definitions?path=${encodeURIComponent(path)}`, { method: 'DELETE', status: 204 });
  } catch (cleanupError) { failure = failure ?? cleanupError; console.error('Script-resource fixture cleanup failed:', cleanupError.message); }
}
if (failure) throw failure;
console.log(`${passed}/${passed} script-resource checks passed.`);
