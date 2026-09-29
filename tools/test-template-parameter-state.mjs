#!/usr/bin/env node
// Real authenticated isolated gateway only. Uses independently authored projects
// and its own synthetic SQLite database; archives every project after testing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Use the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the authenticated test-session preload.');
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const connection = { id: `parameter-state-${run}`, name: 'Parameter state fixture', type: 'sqlite', database: `parameter-state-${run}.db` };
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path === '/api/projects/import' && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 900)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const scalar = (type, value) => ({ type, value });
const component = (id, type, props = {}) => ({ id, type, props, x: 0, y: 0, width: 240, height: 80 });
const reference = (kind, key, componentId) => ({ kind, key, ...(componentId ? { componentId } : {}) });
const binding = (expression, references = {}) => ({ expression, references });
const fx = {
  count: binding('shared + local', { shared: reference('sessionState', 'count'), local: reference('screenState', 'amount') }),
  caption: binding('caption', { caption: reference('sessionState', 'caption') }),
  ready: binding('ready', { ready: reference('sessionState', 'ready') }),
};
const nestedFx = {
  count: binding('parent + privateCount + shared + local', { parent: reference('parameter', 'count'), privateCount: reference('instanceState', 'count'), shared: reference('sessionState', 'count'), local: reference('screenState', 'amount') }),
  caption: binding('note', { note: reference('instanceState', 'note') }),
  ready: binding('ready', { ready: reference('instanceState', 'ready') }),
};
const deepFx = { count: binding('parent + local', { parent: reference('parameter', 'count'), local: reference('instanceState', 'count') }) };
const echo = "result = {'parameters': parameters, 'inputs': inputs, 'leaked': [name for name in ['state', 'sessionState', 'screenState', 'instanceState', 'bindingState'] if name in globals()]}";
const template = (id, components, instanceState) => ({ id, name: id, width: 600, height: 400,
  parameters: { count: '1', caption: 'Default', ready: 'false' }, parameterTypes: { count: 'number', ready: 'boolean' }, components,
  ...(instanceState ? { instanceState } : {}) });
const instance = (id, templateId = 'card', parameterBindings = fx) => component(id, 'template', { templateId, parameters: {}, parameterBindings: structuredClone(parameterBindings) });
const state = (count = 3, amount = 7, caption = '{token}', ready = true) => ({ session: { count, caption, ready }, screen: { amount } });
const nestedState = (count = 5, note = '{count}', ready = false) => ({ session: { count: 3 }, screen: { amount: 7 }, instance: { count, note, ready } });
const outer = (project = draft, id = 'single') => project.screens[0].components.find(item => item.id === id);
const table = () => component('table', 'table', { queryId: 'records', rowKey: 'id', tableEdit: { versionColumn: 'version', columns: [{ key: 'quantity', type: 'number', min: 0, max: 100 }], script: echo } });
const query = (id, sql, parameters = [], kind = 'query') => api(route(`/queries/${id}`), { method: 'PUT', body: { id, name: id, connectionId: connection.id, sql, parameters, kind } });
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish(status = 200) {
  const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status });
  if (status === 200) publishedAt = result.publishedAt;
}
const action = ({ screen = 'main', button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${button}/action`), {
  method: 'POST', status, body: { publishedAt, instanceId: 'single', bindingState: [state()], ...body },
});
const success = result => { assert.equal(result.success, true, result.stderr); return result.result; };
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft);
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)), method = bytes.readUInt16LE(offset + 10);
    assert.ok(method === 0 || method === 8); entries.push({ name, data: method === 0 ? data : inflateRawSync(data) }); offset += 46 + length + extra + comment;
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
  projectId = (await api('/api/projects', { method: 'POST', body: { name: `Parameter state ${run}` } })).id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } });
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { token: 'ROOT', machine: 'Press01' };
  draft.sessionState = { count: scalar('number', 2), caption: scalar('string', 'Authored default'), ready: scalar('boolean', false), unused: scalar('number', 99) };
  const privateState = { count: scalar('number', 5), note: scalar('string', 'Private default'), ready: scalar('boolean', false), unused: scalar('string', 'private') };
  draft.templates = [template('card', [component('apply', 'button', { action: 'script', script: echo }), table(),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: { fromCaller: '{count}', callerText: '{caption}' } })]),
    template('popup-card', [component('apply', 'button', { action: 'script', script: echo }), table()]),
    template('outer', [instance('inner', 'card', nestedFx), instance('middle', 'middle', deepFx)], privateState),
    template('middle', [instance('inner', 'card', deepFx)], { count: scalar('number', 8) }),
    template('unused', [], { count: scalar('number', 12) })];
  const mixed = instance('mixed');
  mixed.props.customProperties = { offset: scalar('number', 2) };
  mixed.props.parameterBindings.count = binding('shared + local + delta + offset', { shared: reference('sessionState', 'count'), local: reference('screenState', 'amount'), delta: reference('input', 'delta'), offset: reference('custom', 'offset') });
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, state: { amount: scalar('number', 4), unused: scalar('string', 'screen') }, components: [
    component('delta', 'numberInput', { fieldKey: 'delta', defaultValue: 1, min: 0, max: 20 }),
    instance('single'), instance('nested', 'outer'), instance('defaults', 'card', {}), mixed,
    { ...instance('saved'), type: 'repeater', props: { ...instance('saved').props, rows: [{ id: 'one', parameters: { count: '15', caption: 'Saved {token}', ready: 'false' } }], columns: 1, gap: 0 } },
    { ...instance('query'), type: 'repeater', props: { ...instance('query').props, rowsSource: { queryId: 'rows', rowKey: 'row_key', parameterMap: { count: 'count', caption: 'caption' } }, columns: 1, gap: 0 } },
    component('plain', 'button', { action: 'script', script: echo }),
  ] }, { id: 'popup', name: 'Popup', kind: 'popup', width: 700, height: 500, parameters: { fromCaller: '0', callerText: '' },
    state: { amount: scalar('number', 11) }, components: [instance('popup-instance', 'popup-card')] }];
  await query('records', 'SELECT id, quantity, version FROM production_records WHERE machine=@machine ORDER BY id', [{ name: 'machine', type: 'string', defaultValue: 'Press01' }]);
  await query('rows', "SELECT 'row-one' AS row_key, 17 AS count, '{token}' AS caption FROM production_records WHERE id=1");
  await query('delete-row', 'DELETE FROM production_records WHERE id=@id', [{ name: 'id', type: 'int' }], 'update');
  await test('published direct state bindings reconstruct typed literal parameters without raw state globals', async () => {
    await save(); await publish(); const result = success(await action());
    assert.equal(result.parameters.count, 10); assert.equal(result.parameters.caption, '{token}'); assert.equal(result.parameters.ready, true);
    assert.deepEqual(result.inputs, {}); assert.deepEqual(result.leaked, []);
    const runtime = await api(route('/runtime/project')); assert.deepEqual(outer(runtime).props.parameterBindings, fx);
    assert.deepEqual(runtime.sessionState, draft.sessionState); assert.equal(runtime.templates[0].components[0].props.script, undefined);
  });
  await test('direct state coexists with validated input, static custom and inherited parameter references', async () => {
    assert.equal(success(await action({ instanceId: 'mixed', bindingInputs: [{ delta: 4 }] })).parameters.count, 16);
    await action({ instanceId: 'mixed', bindingInputs: [{ delta: 21 }], status: 400 });
    await action({ instanceId: 'mixed', status: 400 });
    assert.equal(success(await action({ instanceId: 'defaults', bindingState: undefined })).parameters.count, 1);
    assert.equal(success(await action({ instanceId: 'defaults', bindingState: null })).parameters.count, 1);
    assert.equal(success(await action({ instanceId: 'defaults', bindingState: [{}] })).parameters.count, 1);
    await action({ instanceId: 'defaults', bindingState: [{ session: {} }], status: 400 });
    await action({ instanceId: 'defaults', bindingState: [state()], status: 400 });
    assert.deepEqual(success(await action({ button: 'plain', instanceId: undefined, bindingState: [] })).leaked, []);
    await action({ button: 'plain', instanceId: undefined, bindingState: [{}], status: 400 });
  });
  await test('state transports reject missing, extra, malformed and full-store values without default fallback', async () => {
    for (const bindingState of [undefined, null, [], {}, 'bad', true, [null], [[]], ['bad'], [state(), {}], Array.from({ length: 5 }, () => ({})), [{}],
      [{ session: state().session }], [{ screen: state().screen }], [{ session: null, screen: { amount: 7 } }], [{ session: [], screen: { amount: 7 } }],
      [{ session: 'bad', screen: { amount: 7 } }], [{ ...state(), instance: {} }], [{ ...state(), Session: {} }], [{ ...state(), tag: {} }],
      [{ ...state(), session: { ...state().session, unused: 99 } }], [{ ...state(), screen: { amount: 7, unused: 'all screen state' } }],
      [{ ...state(), session: { count: 3, ready: true } }], [{ ...state(), session: { count: scalar('number', 3), caption: 'x', ready: true } }],
      [{ sessionState: state().session, screenState: state().screen }], [{ session: draft.sessionState, screen: draft.screens[0].state }],
      [state('3')], [state(null)], [state(true)], [state(3, '7')], [state(3, 7, false)], [state(3, 7, 'x', 'true')],
      [state(9007199254740992)], [state(1e100)], [state(3, 7, 'x'.repeat(4097))]]) await action({ bindingState, status: 400 });
    for (const extra of [{ state: {} }, { sessionState: {} }, { instanceState: {} }, { bindingStates: [] }, { templateParameters: { count: 9 } }, { parameters: { count: '9' } }])
      await action({ ...extra, status: 400 });
    assert.deepEqual(await api(route('/project')), draft);
  });
  await test('bounded values accept exact limits and reject invalid declared references even when expressions mask them', async () => {
    assert.equal(success(await action({ bindingState: [state(9007199254740991, 0, 'x'.repeat(4096), false)] })).parameters.count, 9007199254740991);
    assert.equal(success(await action({ bindingState: [state(-0.5, 0.25, '', false)] })).parameters.count, -0.25);
    const original = structuredClone(draft);
    outer().props.parameterBindings.count.expression = '1';
    await save(); await publish(); assert.equal(success(await action()).parameters.count, 1);
    await action({ bindingState: [state('masked')], status: 400 });
    await action({ bindingState: [{ session: { caption: 'x', ready: true }, screen: { amount: 7 } }], status: 400 });
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('nested parents use independent private state and one consistent shared-state snapshot per path', async () => {
    const path = [{ instanceId: 'nested' }, { instanceId: 'inner' }];
    const result = success(await action({ instanceId: undefined, instancePath: path, bindingState: [state(), nestedState()] }));
    assert.equal(result.parameters.count, 25); assert.equal(result.parameters.caption, '{count}'); assert.equal(result.parameters.ready, false);
    for (const second of [{ ...nestedState(), session: { count: 4 } }, { ...nestedState(), screen: { amount: 8 } },
      { ...nestedState(), instance: { ...nestedState().instance, count: '5' } }, { ...nestedState(), instance: { ...nestedState().instance, unused: 'extra' } }])
      await action({ instanceId: undefined, instancePath: path, bindingState: [state(), second], status: 400 });
    await action({ instanceId: undefined, instancePath: path, bindingState: [nestedState(), state()], status: 400 });
    const deep = success(await action({ instanceId: undefined, instancePath: [{ instanceId: 'nested' }, { instanceId: 'middle' }, { instanceId: 'inner' }],
      bindingState: [state(), { instance: { count: 5 } }, { instance: { count: 8 } }] }));
    assert.equal(deep.parameters.count, 23, 'Equal private keys on different parent instances must not be forced equal.');
  });
  await test('saved and query rows retain final literal precedence while every state source still validates', async () => {
    const saved = success(await action({ instanceId: 'saved', rowId: 'one' }));
    assert.equal(saved.parameters.count, 15); assert.equal(saved.parameters.caption, 'Saved ROOT'); assert.equal(saved.parameters.ready, false);
    const queried = success(await action({ instanceId: 'query', rowId: 'row-one' }));
    assert.equal(queried.parameters.count, 17); assert.equal(queried.parameters.caption, '{token}');
    await action({ instanceId: 'query', rowId: 'unknown', status: 400 });
    for (const instanceId of ['saved', 'query']) await action({ instanceId, rowId: instanceId === 'saved' ? 'one' : 'row-one', bindingState: [state('masked by row')], status: 400 });
  });
  await test('popup opener snapshots remain independent of later popup-local and session source snapshots', async () => {
    const popupOrigin = { screenId: 'main', componentId: 'open', instanceId: 'single', bindingState: [state()] };
    const body = { screen: 'popup', instanceId: 'popup-instance', popupOrigin, bindingState: [state(4, 11, 'Current popup', false)] };
    const result = success(await action(body));
    assert.equal(result.parameters.fromCaller, '10'); assert.equal(result.parameters.callerText, '{token}');
    assert.equal(result.parameters.count, 15); assert.equal(result.parameters.caption, 'Current popup'); assert.equal(result.parameters.ready, false);
    await action({ ...body, popupOrigin: { ...popupOrigin, bindingState: undefined }, status: 400 });
    await action({ ...body, bindingState: undefined, status: 400 });
    await action({ ...body, popupOrigin: { ...popupOrigin, bindingState: [state('bad')] }, status: 400 });
    await action({ ...body, popupOrigin: { ...popupOrigin, state: {} }, status: 400 });
    const nestedOrigin = { screenId: 'main', componentId: 'open', instancePath: [{ instanceId: 'nested' }, { instanceId: 'inner' }], bindingState: [state(), nestedState()] };
    assert.equal(success(await action({ ...body, popupOrigin: nestedOrigin })).parameters.fromCaller, '25');
    await action({ ...body, popupOrigin: { ...nestedOrigin, bindingState: [state(), { ...nestedState(), session: { count: 4 } }] }, status: 400 });
  });
  await test('table edits use the same reconstructed state sources and still require published row preflight', async () => {
    const row = (await api(route('/queries/records/execute'), { method: 'POST', body: {} })).rows[0];
    const edit = { publishedAt, instanceId: 'single', bindingState: [state()], key: row.id, version: row.version, column: 'quantity', value: 9 };
    const result = success(await api(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', body: edit }));
    assert.equal(result.parameters.count, 10); assert.equal(result.inputs.value, 9); assert.equal(result.inputs.oldValue, row.quantity); assert.deepEqual(result.leaked, []);
    for (const extra of [{ bindingState: null }, { bindingState: [state('bad')] }, { state: {} }, { templateParameters: {} }])
      await api(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', body: { ...edit, ...extra }, status: 400 });
    const popupOrigin = { screenId: 'main', componentId: 'open', instanceId: 'single', bindingState: [state()] };
    const popupEdit = { ...edit, instanceId: 'popup-instance', popupOrigin, bindingState: [state(5, 20)] };
    const popupResult = success(await api(route('/runtime/screens/popup/components/table/table-edit'), { method: 'POST', body: popupEdit }));
    assert.equal(popupResult.parameters.fromCaller, '10'); assert.equal(popupResult.parameters.count, 25);
    await api(route('/runtime/screens/popup/components/table/table-edit'), { method: 'POST', body: { ...popupEdit, popupOrigin: { ...popupOrigin, bindingState: [state('bad')] } }, status: 400 });
  });
  await test('definition validation rejects missing, child-private, peer-private and malformed state sources', async () => {
    for (const referenceValue of [reference('sessionState', 'missing'), reference('screenState', 'missing'), reference('instanceState', 'count'), reference('instanceState', 'missing'),
      reference('sessionState', '__proto__'), reference('sessionState', 'constructor'), reference('sessionState', ' count'),
      { ...reference('sessionState', 'count'), componentId: 'single' }, { ...reference('screenState', 'amount'), path: 'elsewhere' }, reference('tag', 'anything'), reference('state', 'count')])
      await reject(project => { outer(project).props.parameterBindings.count = binding('source', { source: referenceValue }); });
    await reject(project => { project.templates.find(item => item.id === 'outer').components[0].props.parameterBindings.count.references.privateCount.key = 'missing'; });
    await reject(project => { project.templates.find(item => item.id === 'middle').components[0].props.parameterBindings.count.references.local.key = 'note'; });
    await reject(project => { project.templates.find(item => item.id === 'unused').components = [instance('unused-instance', 'card', { count: binding('source', { source: reference('instanceState', 'childOnly') }) })]; });
  });
  await test('reusable-template screen references validate every screen and popup placement including empty repeaters', async () => {
    const original = structuredClone(draft), previous = publishedAt;
    draft.screens.push({ id: 'other', name: 'Other', width: 500, height: 400, state: {}, components: [
      { ...instance('empty', 'outer', {}), type: 'repeater', props: { ...instance('empty', 'outer', {}).props, rows: [], columns: 1, gap: 0 } },
    ] });
    await save(); await publish(400); assert.equal((await api(route('/project/publication'))).publishedAt, previous);
    draft.screens.at(-1).state.amount = scalar('number', 1); await save(); await publish();
    draft.screens.at(-1).kind = 'popup'; delete draft.screens.at(-1).state.amount; await save(); await publish(400);
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('state declaration types come from the immutable publication and old revisions reject after republish', async () => {
    const original = structuredClone(draft), previous = publishedAt;
    draft.sessionState.caption = scalar('number', 42); await save();
    assert.equal(success(await action()).parameters.caption, '{token}');
    await publish(); await action({ status: 400 });
    assert.equal(success(await action({ bindingState: [state(3, 7, 42)] })).parameters.caption, '42');
    await action({ publishedAt: previous, status: 409 });
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('sparkproj preserves declared state sources and rejects malformed imports before catalog mutation', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.templates, draft.templates); assert.deepEqual(restored.sessionState, draft.sessionState);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { outer(project).props.parameterBindings.count.references.shared.key = 'missing'; },
      project => { outer(project).props.parameterBindings.count.references.shared.kind = 'instanceState'; },
      project => { outer(project).props.parameterBindings.count.references.shared.state = {}; },
      project => { project.templates.find(item => item.id === 'outer').components[0].props.parameterBindings.count.references.privateCount.key = 'notDeclared'; },
      project => { project.sessionState.count = { type: 'number', value: '3' }; }]) {
      const malformed = unzip(bytes).map(entry => {
        if (entry.name !== 'project.json') return entry;
        const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) };
      });
      await api('/api/projects/import', { method: 'POST', raw: zip(malformed), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('a formerly valid query row must still exist; submitted state never restores removed membership', async () => {
    assert.equal(success(await action({ instanceId: 'query', rowId: 'row-one' })).parameters.count, 17);
    await api(route('/queries/delete-row/execute'), { method: 'POST', body: { parameters: { id: 1 } } });
    await action({ instanceId: 'query', rowId: 'row-one', bindingState: [state(17, 0)], status: 400 });
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} template parameter state integration groups passed; ${rejected} malformed save variants rejected.`);
