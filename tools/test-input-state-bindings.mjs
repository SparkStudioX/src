#!/usr/bin/env node
// Authenticated isolated gateway only. Test state remains browser-local; no live project is changed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Input state tests require the isolated gateway on port 5091.');
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
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 80 });
const input = (id, type, key, props = {}, scope = 'screen') => component(id, type, { fieldKey: id, ...props, stateBinding: { scope, key } });
const state = (count = 2) => ({ count: scalar('number', count), text: scalar('string', 'Screen'), choice: scalar('string', 'A'),
  date: scalar('string', '2026-09-29T09:15'), flag: scalar('boolean', true) });
const options = [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
const script = 'result = {"parameters": parameters, "inputs": inputs, "state_names": [name for name in ("sessionState", "screenState", "state") if name in globals()]}';
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected bindings must preserve the saved draft and revision.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
const mainInput = (project, id = 'numberInput') => project.screens[0].components.find(item => item.id === id).props;
const action = (screenId, componentId, body = {}, status = 200) => api(route(`/runtime/screens/${screenId}/components/${componentId}/action`), {
  method: 'POST', status, body: { publishedAt, ...body },
});
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
  const project = await api('/api/projects', { method: 'POST', body: { name: `Input state bindings ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { area: 'Demo' };
  draft.sessionState = { globalText: scalar('string', 'Session'), globalCount: scalar('number', 4), globalFlag: scalar('boolean', false) };
  draft.templates = [
    { id: 'form', name: 'Bound form', width: 400, height: 240, parameters: {}, components: [
      input('localCount', 'spinner', 'count', { defaultValue: 1, min: 0, max: 10 }),
      input('localText', 'textInput', 'globalText', { defaultValue: 'Unbound default' }, 'session'),
      component('apply', 'button', { action: 'script', script }),
    ] },
    { id: 'outer', name: 'Outer form', width: 500, height: 300, parameters: {}, components: [component('inner', 'template', { templateId: 'form', parameters: {} })] },
  ];
  const controls = [
    ...['textInput', 'textArea'].map(type => input(type, type, 'text', { defaultValue: 'Unbound default' })),
    ...['numberInput', 'spinner', 'slider'].map(type => input(type, type, 'count', { defaultValue: 1, min: 0, max: 10 })),
    ...['checkbox', 'toggle'].map(type => input(type, type, 'flag', { defaultValue: false })),
    ...['select', 'list', 'treeView', 'radioGroup', 'multiStateButton'].map(type => input(type, type, 'choice', { defaultValue: 'B', options })),
    input('dateTimeInput', 'dateTimeInput', 'date', { defaultValue: '' }),
    input('sessionInput', 'textInput', 'globalText', { defaultValue: 'Unbound default' }, 'session'),
    input('sessionNumber', 'numberInput', 'globalCount', { defaultValue: 1, min: 0, max: 10 }, 'session'),
    input('sessionToggle', 'toggle', 'globalFlag', { defaultValue: true }, 'session'),
    component('legacy', 'numberInput', { fieldKey: 'legacy', defaultValue: 7 }),
  ];
  draft.screens = [
    { id: 'main', name: 'Main', width: 1200, height: 800, parameters: {}, state: state(), components: [...controls,
      component('apply', 'button', { action: 'script', script }), component('outer', 'template', { templateId: 'outer', parameters: {} }),
      component('open', 'button', { action: 'openPopup', targetScreenId: 'detail' }),
    ] },
    { id: 'other', name: 'Other', width: 800, height: 600, parameters: {}, state: state(6), components: [component('outer', 'template', { templateId: 'outer', parameters: {} })] },
    { id: 'detail', name: 'Details', kind: 'popup', width: 600, height: 400, parameters: {}, state: state(8), components: [
      component('rows', 'repeater', { templateId: 'outer', columns: 1, gap: 8, rows: [{ id: 'one', parameters: {} }, { id: 'two', parameters: {} }] }),
      component('close', 'button', { action: 'closePopup' }),
    ] },
  ];
  await test('all 13 non-password input types retain typed bindings in published runtime props', async () => {
    await save(); await publish();
    const runtime = await api(route('/runtime/project'));
    assert.deepEqual(runtime.sessionState, draft.sessionState); assert.deepEqual(runtime.templates[0].components.slice(0, 2), draft.templates[0].components.slice(0, 2));
    assert.deepEqual(runtime.screens[0].components.slice(0, controls.length), controls);
    assert.equal('script' in runtime.screens[0].components.find(item => item.id === 'apply').props, false);
  });
  await test('binding schema rejects null, extra fields, invalid scopes and invalid state keys atomically', async () => {
    for (const binding of [null, false, 1, [], '', {}, { scope: 'screen' }, { key: 'count' },
      { scope: 'Screen', key: 'count' }, { scope: 'sessionState', key: 'count' }, { scope: 'instance', key: 'count' },
      { scope: null, key: 'count' }, { scope: 'screen', key: 1 }, { scope: 'screen', key: null },
      ...['', '1key', 'two words', 'a.b', '__proto__', 'constructor', 'prototype', 'a'.repeat(65)].map(key => ({ scope: 'screen', key })),
      ...['value', 'type', 'screenId', 'componentId', 'expression', 'twoWay'].map(key => ({ scope: 'screen', key: 'count', [key]: 'unexpected' }))])
      await reject(project => { mainInput(project).stateBinding = binding; });
  });
  await test('unsupported components and conflicting data sources cannot silently acquire a binding', async () => {
    for (const type of ['label', 'button', 'value', 'template', 'repeater', 'table', 'passwordInput'])
      await reject(project => { project.screens[0].components.push(component(`invalid-${type}`, type, { fieldKey: 'invalid', defaultValue: '', stateBinding: { scope: 'screen', key: 'text' } })); });
    for (const tagPath of ['[default]Pump', ' ', null, 1]) await reject(project => { mainInput(project).tagPath = tagPath; });
    for (const optionsSource of [null, {}, { queryId: 'choices', valueColumn: 'value', labelColumn: 'label' }])
      await reject(project => { mainInput(project, 'select').optionsSource = optionsSource; });
    for (const selectionFields of [null, {}, { textInput: 'description' }]) await reject(project => { mainInput(project).selectionFields = selectionFields; });
    mainInput(draft).tagPath = ''; await save(); await publish();
  });
  await test('declared scope and exact primitive type are required without coercion', async () => {
    await reject(project => { delete project.sessionState; });
    await reject(project => { delete project.screens[0].state; });
    await reject(project => { mainInput(project).stateBinding.key = 'missing'; });
    await reject(project => { mainInput(project, 'sessionInput').stateBinding.key = 'missing'; });
    await reject(project => { project.templates[0].components[1].props.stateBinding.key = 'missing'; });
    await reject(project => { mainInput(project).stateBinding.scope = 'session'; });
    for (const [id, incompatible] of [['numberInput', ['text', 'flag']], ['textInput', ['count', 'flag']], ['checkbox', ['count', 'text']], ['select', ['count', 'flag']], ['dateTimeInput', ['count', 'flag']]])
      for (const key of incompatible) await reject(project => { mainInput(project, id).stateBinding.key = key; });
    await reject(project => { project.sessionState.globalText = scalar('boolean', true); });
    await reject(project => { project.sessionState.globalCount = scalar('string', '4'); });
    await reject(project => { project.sessionState.globalFlag = scalar('number', 0); });
  });
  await test('state defaults obey number bounds, selection membership and local date validation', async () => {
    for (const value of [-1, 11]) await reject(project => { project.screens[0].state.count.value = value; });
    for (const value of [-1, 11]) await reject(project => { project.sessionState.globalCount.value = value; });
    for (const value of ['', 'C']) await reject(project => { project.screens[0].state.choice.value = value; });
    for (const value of ['not-a-date', '2026-02-30T09:15', '2026-09-29T09:15Z']) await reject(project => { project.screens[0].state.date.value = value; });
    await reject(project => { project.screens[0].state.text.value = 'a'.repeat(4097); });
    await reject(project => { project.screens[0].state.count.value = 9007199254740992; });
    await reject(project => { mainInput(project).defaultValue = '1'; });
    draft.screens[0].state.date.value = ''; await save(); await publish();
    draft.screens[0].state.date.value = '2026-09-29T09:15'; await save(); await publish();
  });
  await test('every nested placement checks its own screen and popup declaration and constraints', async () => {
    const original = structuredClone(draft);
    for (const screenIndex of [1, 2]) for (const invalid of [undefined, scalar('string', '6'), scalar('number', 11)]) {
      if (invalid === undefined) delete draft.screens[screenIndex].state.count; else draft.screens[screenIndex].state.count = invalid;
      await save(); await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
      assert.equal((await api(route('/project/publication'))).publishedAt, publishedAt);
      draft = { ...structuredClone(original), revision: draft.revision }; await save();
    }
    await publish();
  });
  await test('unplaced screen-state templates remain draftable while session-state references are always checked', async () => {
    draft.templates.push({ id: 'future', name: 'Future state', width: 320, height: 200, parameters: {}, components: [input('future', 'checkbox', 'future', { defaultValue: false })] });
    await save(); await publish();
    await reject(project => { project.templates.at(-1).components[0].props.stateBinding.scope = 'session'; });
    draft.screens[1].components.push(component('future', 'template', { templateId: 'future', parameters: {} })); await save();
    await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
    draft.screens[1].state.future = scalar('boolean', true); await save(); await publish();
  });
  const submitted = Object.fromEntries(controls.filter(item => item.id !== 'legacy').map(item => [item.id,
    item.id === 'sessionInput' ? 'Submitted session text' :
      (item.props.stateBinding.scope === 'session' ? draft.sessionState : draft.screens[0].state)[item.props.stateBinding.key].value]));
  await test('actions require explicit bound input values and preserve legacy default fallback', async () => {
    const result = await action('main', 'apply', { inputs: submitted });
    assert.deepEqual(result.result, { parameters: { area: 'Demo' }, inputs: { ...submitted, legacy: 7 }, state_names: [] });
    await action('main', 'apply', {}, 400);
    for (const key of Object.keys(submitted)) { const inputs = { ...submitted }; delete inputs[key]; await action('main', 'apply', { inputs }, 400); }
    await action('main', 'apply', { inputs: { ...submitted, numberInput: '2' } }, 400);
    await action('main', 'apply', { inputs: { ...submitted, checkbox: 'true' } }, 400);
    await action('main', 'apply', { inputs: { ...submitted, slider: 11 } }, 400);
    await action('main', 'apply', { inputs: { ...submitted, select: 'C' } }, 400);
    await action('main', 'apply', { inputs: { ...submitted, dateTimeInput: 'bad-date' } }, 400);
    await action('main', 'apply', { inputs: { ...submitted, foreign: true } }, 400);
  });
  await test('forged state never supplies omitted inputs or becomes gateway-authoritative data', async () => {
    const forged = { sessionState: { globalText: 'Forged' }, screenState: { count: 999 }, state: { count: 999 } };
    await action('main', 'apply', forged, 400);
    assert.deepEqual((await action('main', 'apply', { ...forged, inputs: submitted })).result.inputs, { ...submitted, legacy: 7 });
    assert.deepEqual(await api(route('/project')), draft, 'Actions must not write browser state into project defaults.');
    const runtime = await api(route('/runtime/project')); assert.deepEqual(runtime.sessionState, draft.sessionState);
    assert.deepEqual(runtime.screens[0].state, draft.screens[0].state);
  });
  await test('nested and repeated popup actions accept only their scoped explicit inputs', async () => {
    const inputs = { localCount: 5, localText: 'Nested operator value' };
    const instancePath = [{ instanceId: 'outer' }, { instanceId: 'inner' }];
    assert.deepEqual((await action('main', 'apply', { instancePath, inputs })).result.inputs, inputs);
    await action('main', 'apply', { instancePath, inputs: { localCount: 5 } }, 400);
    await action('main', 'apply', { instancePath, inputs: { ...inputs, textInput: 'Sibling' } }, 400);
    const popupPath = [{ instanceId: 'rows', rowId: 'two' }, { instanceId: 'inner' }];
    const popupOrigin = { screenId: 'main', componentId: 'open' };
    assert.deepEqual((await action('detail', 'apply', { instancePath: popupPath, popupOrigin, inputs })).result.inputs, inputs);
    await action('detail', 'apply', { instancePath: popupPath, popupOrigin, inputs: {} }, 400);
  });
  await test('draft binding changes do not mutate the published action until republished', async () => {
    const before = await api(route('/runtime/project'));
    delete mainInput(draft).stateBinding; await save();
    assert.deepEqual((await api(route('/runtime/project'))).screens, before.screens);
    const missing = { ...submitted }; delete missing.numberInput; await action('main', 'apply', { inputs: missing }, 400);
    const previous = publishedAt; await publish();
    assert.equal((await action('main', 'apply', { inputs: missing })).result.inputs.numberInput, 1);
    await action('main', 'apply', { publishedAt: previous, inputs: submitted }, 409);
    mainInput(draft).stateBinding = { scope: 'screen', key: 'count' }; await save(); await publish();
  });
  await test('portable packages preserve binding definitions and reject invalid imported bindings atomically', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.templates, draft.templates); assert.deepEqual(restored.sessionState, draft.sessionState);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { mainInput(project).stateBinding = null; }, project => { mainInput(project).stateBinding.key = 'missing'; },
      project => { mainInput(project).stateBinding = { scope: 'session', key: 'globalText' }; }, project => { project.screens[0].state.count.value = 11; },
      project => { mainInput(project).stateBinding.value = 3; }, project => { mainInput(project, 'sessionInput').tagPath = '[default]secret'; }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('legacy input projects remain valid without state declarations or binding properties', async () => {
    delete draft.sessionState; draft.templates = [];
    draft.screens = [{ id: 'main', name: 'Legacy', width: 800, height: 600, parameters: {}, components: [
      component('legacy', 'numberInput', { fieldKey: 'legacy', defaultValue: 7 }), component('apply', 'button', { action: 'script', script }),
    ] }];
    await save(); await publish();
    assert.deepEqual((await action('main', 'apply')).result.inputs, { legacy: 7 });
    assert.equal('sessionState' in await api(route('/runtime/project')), false);
    await api(route('/export'), { binary: true });
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} input state binding integration groups passed; ${rejected} malformed save variants rejected.`);
