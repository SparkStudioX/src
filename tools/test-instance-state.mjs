#!/usr/bin/env node
// Authenticated isolated gateway only. Independently authored synthetic projects
// are archived after verification; no live project or runtime state is edited.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Instance state tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the authenticated test-session preload.');
const created = [], run = randomUUID().slice(0, 12);
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path === '/api/projects/import' && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 900)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const scalar = (type, value) => ({ type, value });
const component = (id, type, props = {}) => ({ id, type, props, x: 0, y: 0, width: 240, height: 80 });
const input = (id, type, key, props = {}) => component(id, type, { fieldKey: id, ...props, stateBinding: { scope: 'instance', key } });
const reference = key => ({ expression: 'local', references: { local: { kind: 'instanceState', key } } });
const instance = (id, templateId = 'form') => component(id, 'template', { templateId, parameters: {} });
const options = [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
const state = (count = 2) => ({ count: scalar('number', count), text: scalar('string', 'Local text'), choice: scalar('string', 'A'),
  date: scalar('string', '2026-09-29T09:15'), flag: scalar('boolean', true), privateOnly: scalar('number', 7) });
const script = 'result = {"parameters": parameters, "inputs": inputs, "state_names": [name for name in ("instanceState", "sessionState", "screenState", "state") if name in globals()]}';
const form = project => project.templates.find(item => item.id === 'form');
const control = (project, id = 'numberInput') => form(project).components.find(item => item.id === id).props;
const label = project => form(project).components.find(item => item.id === 'label').props.bindings.text.references.local;
const action = ({ screen = 'main', button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${button}/action`), {
  method: 'POST', status, body: { publishedAt, instanceId: 'first', ...body },
});
const success = result => { assert.equal(result.success, true, result.stderr); return result.result; };
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected state must preserve saved defaults and revision.');
}
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

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
  const project = await api('/api/projects', { method: 'POST', body: { name: `Private instance state ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { equipment: 'Press01' };
  draft.sessionState = { count: scalar('number', 77) };
  const controls = [
    ...['textInput', 'textArea'].map(type => input(type, type, 'text', { defaultValue: 'Unbound text' })),
    ...['numberInput', 'spinner', 'slider'].map(type => input(type, type, 'count', { defaultValue: 1, min: 0, max: 10 })),
    ...['checkbox', 'toggle'].map(type => input(type, type, 'flag', { defaultValue: false })),
    ...['select', 'list', 'treeView', 'radioGroup', 'multiStateButton'].map(type => input(type, type, 'choice', { defaultValue: 'B', options })),
    input('dateTimeInput', 'dateTimeInput', 'date', { defaultValue: '' }),
  ];
  draft.templates = [{ id: 'form', name: 'Private form', width: 600, height: 480, parameters: { count: '100' }, parameterTypes: { count: 'number' },
    instanceState: state(), components: [...controls, component('legacy', 'numberInput', { fieldKey: 'legacy', defaultValue: 8 }),
      component('label', 'label', { text: 'Local state', bindings: { text: reference('text'), visible: reference('flag'), x: reference('count') } }),
      component('apply', 'button', { action: 'script', script }),
      { ...instance('child', 'summary'), props: { templateId: 'summary', parameterBindings: { count: { expression: 'parent', references: { parent: { kind: 'input', key: 'numberInput' } } } } } },
  ] }, { id: 'summary', name: 'Child summary', width: 300, height: 200, parameters: { count: '0' }, parameterTypes: { count: 'number' }, instanceState: { count: scalar('number', 22) }, components: [
    component('label', 'label', { text: 'Own count', bindings: { text: reference('count') } }), component('apply', 'button', { action: 'script', script }),
  ] }, { id: 'outer', name: 'Outer template', width: 700, height: 500, parameters: {}, instanceState: { count: scalar('number', 42) }, components: [
    component('label', 'label', { text: 'Outer count', bindings: { text: reference('count') } }), instance('inner'),
  ] }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, parameters: {}, state: { count: scalar('number', 99) }, components: [
    instance('first'), instance('second'), instance('outer', 'outer'),
    component('rows', 'repeater', { templateId: 'form', columns: 1, gap: 8, rows: [{ id: 'one', parameters: {} }, { id: 'two', parameters: {} }] }),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'popup' }),
  ] }, { id: 'other', name: 'Other', width: 800, height: 600, parameters: {}, components: [instance('first')] },
  { id: 'popup', name: 'Popup', kind: 'popup', width: 700, height: 500, parameters: {}, components: [instance('first'), component('close', 'button', { action: 'closePopup' })] }];
  const submitted = Object.fromEntries(controls.map(item => [item.id, form(draft).instanceState[item.props.stateBinding.key].value]));
  await test('private typed defaults and all 13 input bindings save and publish unchanged', async () => {
    await save(); await publish();
    const runtime = await api(route('/runtime/project'));
    assert.deepEqual(form(runtime).instanceState, state());
    for (const item of controls) assert.deepEqual(control(runtime, item.id), item.props);
    assert.deepEqual(form(runtime).parameters, { count: '100' });
    assert.equal(form(runtime).components.find(item => item.id === 'apply').props.script, undefined);
  });
  await test('instance declarations are template-only and template screen-state declarations remain invalid', async () => {
    for (const value of [{}, null, state()]) {
      await reject(project => { project.instanceState = value; });
      await reject(project => { project.screens[0].instanceState = value; });
      await reject(project => { project.screens[2].instanceState = value; });
      await reject(project => { form(project).state = value; });
      await reject(project => { project.screens[0].components[0].instanceState = value; });
      await reject(project => { project.screens[0].components[0].props.instanceState = value; });
      await reject(project => { project.screens[0].components.find(item => item.id === 'rows').props.rows[0].instanceState = value; });
    }
  });
  await test('malformed declarations reject atomically with 64 keys as the exact supported boundary', async () => {
    for (const value of [null, [], true, 7, 'state', Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, scalar('number', index)]))])
      await reject(project => { form(project).instanceState = value; });
    for (const key of ['', '1key', 'two words', 'a.b', '__proto__', 'constructor', 'prototype', 'a'.repeat(65), 'é'])
      await reject(project => { form(project).instanceState = Object.fromEntries([...Object.entries(state()), [key, scalar('number', 1)]]); });
    for (const value of [null, {}, [], { type: 'number' }, { value: 1 }, scalar('integer', 1), scalar('string', 4), scalar('number', '2'), scalar('boolean', 'true'),
      scalar('string', 'x'.repeat(4097)), scalar('number', 9007199254740992), { ...scalar('number', 2), extra: true }])
      await reject(project => { form(project).instanceState.privateOnly = value; });
    const original = structuredClone(draft);
    for (let index = Object.keys(form(draft).instanceState).length; index < 64; index++) form(draft).instanceState[`p${index}`] = scalar('number', index);
    await save(); await publish(); assert.equal(Object.keys(form(await api(route('/runtime/project'))).instanceState).length, 64);
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('bindings resolve only the immediately containing template declaration', async () => {
    await reject(project => { delete form(project).instanceState; });
    await reject(project => { label(project).key = 'unknown'; });
    await reject(project => { control(project).stateBinding.key = 'unknown'; });
    for (const extra of ['templateId', 'instanceId', 'componentId', 'parent', 'screenId']) {
      await reject(project => { label(project)[extra] = 'outer'; });
      await reject(project => { control(project).stateBinding[extra] = 'outer'; });
    }
    await reject(project => { delete project.templates.find(item => item.id === 'summary').instanceState; });
    await reject(project => { project.screens[0].components.push(component('bad', 'label', { bindings: { text: reference('count') } })); });
    await reject(project => { project.screens[2].components.push(input('bad', 'numberInput', 'count')); });
    await reject(project => { project.screens[0].components[0].props.bindings = { text: reference('count') }; });
    await reject(project => { form(project).components.find(item => item.id === 'child').props.parameterBindings.count.references.parent = { kind: 'instanceState', key: 'count' }; });
  });
  await test('bound input types and state defaults obey range, option and date constraints', async () => {
    for (const [key, value] of [['count', scalar('string', '2')], ['text', scalar('number', 2)], ['flag', scalar('number', 1)], ['choice', scalar('boolean', true)],
      ['count', scalar('number', -1)], ['count', scalar('number', 11)], ['choice', scalar('string', 'C')], ['date', scalar('string', '2026-02-30T09:15')]])
      await reject(project => { form(project).instanceState[key] = value; });
    await reject(project => { form(project).components.push(input('secret', 'passwordInput', 'text')); });
    await reject(project => { control(project).tagPath = '[default]Disallowed'; });
    await reject(project => { control(project, 'select').optionsSource = { queryId: 'q', valueColumn: 'v', labelColumn: 'l' }; });
    await reject(project => { control(project, 'select').selectionFields = {}; });
    await reject(project => { control(project).stateBinding.scope = 'parentInstance'; });
  });
  await test('unplaced template definitions validate private state without relying on future placements', async () => {
    draft.templates.push({ id: 'unused', name: 'Unused', width: 300, height: 180, parameters: {}, instanceState: {}, components: [] });
    await save(); await publish();
    await reject(project => { project.templates.at(-1).components.push(component('bad', 'label', { bindings: { text: reference('count') } })); });
    await reject(project => { project.templates.at(-1).components.push(input('bad', 'numberInput', 'count')); });
  });
  await test('actions require explicit validated inputs and never expose private defaults as state', async () => {
    const result = success(await action({ inputs: submitted }));
    assert.deepEqual(result, { parameters: { equipment: 'Press01', count: 100 }, inputs: { ...submitted, legacy: 8 }, state_names: [] });
    await action({ status: 400 });
    for (const key of Object.keys(submitted)) { const inputs = { ...submitted }; delete inputs[key]; await action({ inputs, status: 400 }); }
    await action({ inputs: { ...submitted, numberInput: 11 }, status: 400 });
    await action({ inputs: { ...submitted, privateOnly: 88 }, status: 400 });
    for (const stateKey of ['instanceState', 'state', 'screenState', 'sessionState']) await action({ inputs: submitted, [stateKey]: { count: 9 }, status: 400 });
    assert.deepEqual(await api(route('/project')), draft);
    assert.deepEqual(form(await api(route('/runtime/project'))).instanceState, state());
  });
  await test('repeated, nested and popup forms keep separate request inputs without state persistence', async () => {
    const first = { ...submitted, numberInput: 3 }, second = { ...submitted, numberInput: 9 };
    assert.equal(success(await action({ inputs: first })).inputs.numberInput, 3);
    assert.equal(success(await action({ instanceId: 'second', inputs: second })).inputs.numberInput, 9);
    assert.equal(success(await action({ instanceId: 'rows', rowId: 'two', inputs: first })).inputs.numberInput, 3);
    assert.equal(success(await action({ instanceId: undefined, instancePath: [{ instanceId: 'outer' }, { instanceId: 'inner' }], inputs: second })).inputs.numberInput, 9);
    assert.equal(success(await action({ screen: 'popup', popupOrigin: { screenId: 'main', componentId: 'open' }, inputs: first })).inputs.numberInput, 3);
    await action({ screen: 'popup', popupOrigin: { screenId: 'main', componentId: 'open', instanceState: { count: 3 } }, inputs: first, status: 400 });
    await action({ instanceId: 'second', status: 400 });
    assert.deepEqual(form(await api(route('/runtime/project'))).instanceState, state());
  });
  await test('an instance-state-bound parent input feeds child fx only as explicit validated user data', async () => {
    const instancePath = [{ instanceId: 'first' }, { instanceId: 'child' }];
    const result = success(await action({ instanceId: undefined, instancePath, bindingInputs: [{}, { numberInput: 6 }] }));
    assert.deepEqual(result, { parameters: { equipment: 'Press01', count: 6 }, inputs: {}, state_names: [] });
    await action({ instanceId: undefined, instancePath, status: 400 });
    await action({ instanceId: undefined, instancePath, bindingInputs: [{}, { numberInput: 11 }], status: 400 });
    await action({ instanceId: undefined, instancePath, bindingInputs: [{}, { numberInput: 6, instanceState: { count: 6 } }], status: 400 });
  });
  await test('draft defaults remain isolated until publication and removing bindings restores legacy defaults', async () => {
    const before = await api(route('/runtime/project'));
    form(draft).instanceState.count.value = 4; await save();
    assert.deepEqual(form(await api(route('/runtime/project'))).instanceState, form(before).instanceState);
    delete control(draft).stateBinding; await save();
    const missing = { ...submitted }; delete missing.numberInput;
    await action({ inputs: missing, status: 400 });
    const previous = publishedAt; await publish();
    assert.equal(success(await action({ inputs: missing })).inputs.numberInput, 1);
    assert.equal(form(await api(route('/runtime/project'))).instanceState.count.value, 4);
    await action({ inputs: submitted, publishedAt: previous, status: 409 });
    control(draft).stateBinding = { scope: 'instance', key: 'count' }; await save(); await publish();
  });
  await test('sparkproj preserves defaults and references and rejects malformed imports atomically', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.templates, draft.templates); assert.deepEqual(restored.screens, draft.screens);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { form(project).instanceState = null; }, project => { delete form(project).instanceState.count; },
      project => { label(project).key = 'missing'; }, project => { project.screens[0].instanceState = {}; },
      project => { control(project).stateBinding.parent = 'outer'; }]) {
      const malformed = unzip(bytes).map(entry => {
        if (entry.name !== 'project.json') return entry;
        const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) };
      });
      await api('/api/projects/import', { method: 'POST', raw: zip(malformed), status: 400 });
      assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('legacy templates continue to publish without private state metadata', async () => {
    draft.templates = [{ id: 'legacy', name: 'Legacy', width: 300, height: 180, parameters: {}, components: [component('apply', 'button', { action: 'script', script })] }];
    draft.screens = [{ id: 'main', name: 'Main', width: 800, height: 600, components: [instance('first', 'legacy')] }];
    await save(); await publish();
    assert.equal(Object.hasOwn((await api(route('/runtime/project'))).templates[0], 'instanceState'), false);
    assert.deepEqual(success(await action()), { parameters: { equipment: 'Press01' }, inputs: {}, state_names: [] });
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} private instance state integration groups passed; ${rejected} malformed save variants rejected.`);
