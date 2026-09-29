#!/usr/bin/env node
// Authenticated isolated gateway only; browser state is never written into live project data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Application state tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const created = [], run = randomUUID().slice(0, 12);
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const route = suffix => `/api/projects/${projectId}${suffix}`;
const scalar = (type, value) => ({ type, value });
const reference = (kind, key) => ({ expression: 'v', references: { v: { kind, key } } });
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 80 });
const label = (id, kind, key) => component(id, 'label', { text: 'Bound state', bindings: { text: reference(kind, key) } });
const state = () => ({ count: scalar('number', 0), selected: scalar('string', 'Pump A'), running: scalar('boolean', false) });
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected state must preserve the saved draft and revision.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), method = bytes.readUInt16LE(offset + 10);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)); assert.ok(method === 0 || method === 8);
    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) }); offset += 46 + length + extra + comment;
  }
  return entries;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Application state ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { area: 'Demo' }; draft.sessionState = state();
  draft.templates = [{ id: 'shared', name: 'Shared state faceplate', width: 400, height: 240, parameters: {}, components: [label('session', 'sessionState', 'selected'), label('screen', 'screenState', 'count')] }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, parameters: {}, state: state(), components: [
    label('session', 'sessionState', 'selected'), label('screen', 'screenState', 'count'),
    component('input', 'numberInput', { fieldKey: 'reading', defaultValue: 37 }),
    component('apply', 'button', { action: 'script', script: 'result = {"parameters": parameters, "inputs": inputs, "state_names": [name for name in ("sessionState", "screenState", "state") if name in globals()]}' }),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'detail' }),
    component('shared', 'template', { templateId: 'shared', parameters: {} }),
    component('rows', 'repeater', { templateId: 'shared', columns: 1, gap: 8, rows: [{ id: 'one', parameters: {} }] }),
  ] }, { id: 'other', name: 'Other', width: 800, height: 600, parameters: {}, state: { count: scalar('number', 20) }, components: [
    component('shared-other', 'template', { templateId: 'shared', parameters: {} }),
  ] }, { id: 'detail', kind: 'popup', name: 'Details', width: 480, height: 320, parameters: {}, state: { count: scalar('number', 100) }, components: [
    component('shared-popup', 'template', { templateId: 'shared', parameters: {} }),
    component('close', 'button', { action: 'closePopup' }),
  ] }];
  await test('typed defaults and bindings save and publish across screens, popups and repeated templates', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.deepEqual(runtime.sessionState, draft.sessionState);
    for (let index = 0; index < draft.screens.length; index++) assert.deepEqual(runtime.screens[index].state, draft.screens[index].state);
    assert.deepEqual(runtime.templates, draft.templates);
  });
  await test('state maps reject null, arrays, scalar values and excessive declarations atomically', async () => {
    for (const invalid of [null, [], 'state', 1, true, Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, scalar('number', index)]))]) {
      await reject(project => { project.sessionState = invalid; });
      await reject(project => { project.screens[0].state = invalid; });
    }
    for (const invalid of [null, {}, state()]) await reject(project => { project.templates[0].state = invalid; });
  });
  await test('state names are bounded ASCII identifiers and cannot modify object prototypes', async () => {
    for (const key of ['', '1key', 'two words', 'a.b', 'a-b', 'é', 'line\n', 'a'.repeat(65), '__proto__', 'constructor', 'prototype']) {
      await reject(project => { project.sessionState = Object.fromEntries([[key, scalar('string', 'value')]]); });
      await reject(project => { project.screens[0].state = Object.fromEntries([[key, scalar('string', 'value')]]); });
    }
  });
  await test('definition values match their declared type and use exact bounded scalar data', async () => {
    const invalid = [null, [], {}, { value: 1 }, { type: 'number' }, { type: 'Number', value: 1 }, { type: 'object', value: {} },
      { type: 'number', value: 1, extra: true }, scalar('number', '1'), scalar('number', true), scalar('number', null), scalar('number', 9007199254740992),
      scalar('number', -9007199254740992), scalar('string', false), scalar('string', null), scalar('string', 'a'.repeat(4097)), scalar('boolean', 'false'), scalar('boolean', 0), scalar('boolean', null)];
    for (const definition of invalid) {
      await reject(project => { project.sessionState.invalid = definition; });
      await reject(project => { project.screens[0].state.invalid = definition; });
    }
    draft.sessionState.boundary = scalar('number', 9007199254740991); draft.sessionState.negative = scalar('number', -9007199254740991);
    draft.sessionState.fraction = scalar('number', 0.125); draft.sessionState.textLimit = scalar('string', 'a'.repeat(4096));
    draft.sessionState['a'.repeat(64)] = scalar('boolean', true); draft.sessionState.true = scalar('boolean', true);
    await save(); await publish(); assert.deepEqual((await api(route('/runtime/project'))).sessionState, draft.sessionState);
  });
  await test('each state scope accepts exactly 64 declarations independently', async () => {
    const originalSession = structuredClone(draft.sessionState), originalScreen = structuredClone(draft.screens[0].state);
    for (const definitions of [draft.sessionState, draft.screens[0].state]) {
      for (let index = Object.keys(definitions).length; index < 64; index++) definitions[`extra${index}`] = scalar('number', index);
    }
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.equal(Object.keys(runtime.sessionState).length, 64); assert.equal(Object.keys(runtime.screens[0].state).length, 64);
    await reject(project => { project.sessionState.tooMany = scalar('number', 65); });
    await reject(project => { project.screens[0].state.tooMany = scalar('number', 65); });
    draft.sessionState = originalSession; draft.screens[0].state = originalScreen; await save(); await publish();
  });
  await test('bindings require explicit declared scopes and forbid foreign reference fields', async () => {
    await reject(project => { project.screens[0].components[0].props.bindings.text = reference('sessionState', 'missing'); });
    await reject(project => { project.templates[0].components[0].props.bindings.text = reference('sessionState', 'missing'); });
    await reject(project => { project.screens[0].components[1].props.bindings.text = reference('screenState', 'missing'); });
    for (const kind of ['sessionState', 'screenState']) {
      for (const key of ['', 'a.b', 'two words', '__proto__', 'constructor', 'prototype', 'a'.repeat(65)])
        await reject(project => { project.templates[0].components[0].props.bindings.text = reference(kind, key); });
      for (const field of ['componentId', 'screenId', 'path', 'value', 'type'])
        await reject(project => { project.screens[0].components[0].props.bindings.text = reference(kind, 'selected'); project.screens[0].components[0].props.bindings.text.references.v[field] = 'other'; });
    }
    await reject(project => { project.screens[0].components[0].props.bindings.text = reference('state', 'selected'); });
    await reject(project => { delete project.sessionState; });
    await reject(project => { delete project.screens[0].state; });
  });
  await test('each template placement checks its containing screen state at publication', async () => {
    const original = structuredClone(draft);
    for (const screenIndex of [1, 2]) {
      delete draft.screens[screenIndex].state; await save();
      await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
      assert.equal((await api(route('/project/publication'))).publishedAt, publishedAt);
      draft = { ...structuredClone(original), revision: draft.revision }; await save();
    }
    draft.screens[0].components = draft.screens[0].components.filter(item => item.id !== 'screen');
    delete draft.screens[0].state; await save();
    await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('unplaced draft templates may reference future screen state until placed', async () => {
    const template = { id: 'future', name: 'Future template', width: 300, height: 200, parameters: {}, components: [label('future', 'screenState', 'future')] };
    draft.templates.push(template); await save(); await publish();
    draft.screens[1].components.push(component('future-instance', 'template', { templateId: 'future', parameters: {} })); await save();
    await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
    draft.screens[1].state.future = scalar('string', 'Ready'); await save(); await publish();
  });
  await test('state defaults remain draft-only until the next project publication', async () => {
    const before = await api(route('/runtime/project'));
    draft.sessionState.selected.value = 'Pump B'; draft.screens[0].state.count.value = 3; await save();
    const unchanged = await api(route('/runtime/project')); assert.deepEqual(unchanged.sessionState, before.sessionState); assert.deepEqual(unchanged.screens[0].state, before.screens[0].state);
    await publish(); const after = await api(route('/runtime/project')); assert.equal(after.sessionState.selected.value, 'Pump B'); assert.equal(after.screens[0].state.count.value, 3);
  });
  await test('gateway actions receive declared inputs and parameters without browser state', async () => {
    const action = (body = {}, status = 200) => api(route('/runtime/screens/main/components/apply/action'), { method: 'POST', status, body: { publishedAt, ...body } });
    const expected = { parameters: { area: 'Demo' }, inputs: { reading: 37 }, state_names: [] };
    assert.deepEqual((await action()).result, expected);
    assert.deepEqual((await action({ sessionState: { selected: 'forged' }, screenState: { count: 99 } })).result, expected);
    await action({ parameters: { area: 'Demo', selected: 'forged' } }, 400);
    await action({ inputs: { reading: 37, count: 99 } }, 400);
    assert.deepEqual(await api(route('/project')), draft, 'Runtime actions must not persist browser state into the project defaults.');
  });
  await test('portable packages retain defaults and reject invalid declarations and references atomically', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.sessionState, draft.sessionState); assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.templates, draft.templates);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { project.sessionState = null; }, project => { project.screens[0].state.count.value = '3'; },
      project => { project.templates[0].state = {}; }, project => { project.sessionState.constructor = scalar('string', 'bad'); },
      project => { project.screens[0].components[0].props.bindings.text = reference('sessionState', 'missing'); }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('legacy projects omit state and continue to save, publish and export', async () => {
    delete draft.sessionState; draft.templates = [];
    draft.screens = [{ id: 'main', name: 'Legacy', width: 800, height: 600, parameters: {}, components: [component('label', 'label', { text: 'Legacy project' })] }];
    await save(); await publish(); const runtime = await api(route('/runtime/project')); assert.equal('sessionState' in runtime, false); assert.equal('state' in runtime.screens[0], false);
    await api(route('/export'), { binary: true });
    draft.sessionState = {}; draft.screens[0].state = {}; await save(); await publish();
    const empty = await api(route('/runtime/project')); assert.deepEqual(empty.sessionState, {}); assert.deepEqual(empty.screens[0].state, {});
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} application state integration groups passed; ${rejected} malformed save variants rejected.`);
