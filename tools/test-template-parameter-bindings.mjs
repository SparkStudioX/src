#!/usr/bin/env node
// Real authenticated isolated gateway only. Uses independently authored projects
// and synthetic SQLite records; archives every project created by this suite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Use the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the authenticated test-session preload.');
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const connection = { id: `parameter-fx-${run}`, name: 'Parameter fx fixture', type: 'sqlite', database: `parameter-fx-${run}.db` };
let projectId, draft, publishedAt, passed = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'content-type': 'application/zip' } : body === undefined ? {} : { 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path === '/api/projects/import' && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 1000)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const component = (id, type, props = {}) => ({ id, type, props, x: 0, y: 0, width: 200, height: 80 });
const binding = (expression, references = {}) => ({ expression, references });
const reference = (kind, key, componentId) => ({ kind, key, ...(componentId ? { componentId } : {}) });
const fx = {
  count: binding('amount + offset', { amount: reference('input', 'amount'), offset: reference('custom', 'offset') }),
  caption: binding('caption', { caption: reference('input', 'caption') }),
  ready: binding('ready', { ready: reference('input', 'ready') }),
};
const types = { count: 'number', ready: 'boolean' };
const params = { count: '1', caption: 'Default', ready: 'false' };
const echo = "result = {'parameters':parameters,'inputs':inputs,'numberType':type(parameters['count']).__name__,'booleanType':type(parameters['ready']).__name__}";
const template = (id, components, parameters = params) => ({ id, name: id, width: 600, height: 400, parameters: structuredClone(parameters), parameterTypes: structuredClone(types), components });
const instance = (id, templateId = 'card', parameterBindings = fx) => component(id, 'template', {
  templateId, parameters: { count: '3' }, parameterBindings: structuredClone(parameterBindings), customProperties: { offset: { type: 'number', value: 2 } },
});
const inputValues = (amount = 4, caption = '{base}', ready = true) => ({ amount, caption, ready });
const main = project => project.screens[0];
const outer = (project, id = 'single') => main(project).components.find(item => item.id === id);
const card = project => project.templates.find(item => item.id === 'card');
const query = (id, sql, parameters = []) => api(route(`/queries/${id}`), { method: 'PUT', body: { id, name: id, connectionId: connection.id, sql, parameters } });
async function save(value = draft) { draft = await api(route('/project'), { method: 'PUT', body: value }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
const action = ({ screen = 'main', button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${button}/action`), {
  method: 'POST', status, body: { publishedAt, instanceId: 'single', bindingInputs: [inputValues()], ...body },
});
const success = result => { assert.equal(result.success, true, result.stderr); return result.result; };
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 });
  assert.deepEqual(await api(route('/project')), draft, 'Rejected definitions must preserve the previous draft.');
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
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const createdProject = await api('/api/projects', { method: 'POST', body: { name: `Parameter fx ${run}` } }); projectId = createdProject.id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } });
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { base: 'Parent', machine: 'Press01' };
  draft.sessionState = { amount: { type: 'number', value: 4 } };
  draft.templates = [template('card', [component('apply', 'button', { action: 'script', script: echo }),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: { fromCaller: '{count}', literal: '{caption}' } }),
    component('table', 'table', { queryId: 'records', rowKey: 'id', tableEdit: { versionColumn: 'version', columns: [{ key: 'quantity', type: 'number', min: 0, max: 100 }], script: echo } }),
  ]), template('nested', [component('delta', 'numberInput', { fieldKey: 'delta', defaultValue: 1, min: 0, max: 20 }),
    instance('inner', 'card', { count: binding('parent + delta', { parent: reference('parameter', 'count'), delta: reference('input', 'delta') }),
      caption: binding('caption', { caption: reference('parameter', 'caption') }) }),
  ])];
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, parameters: {}, components: [
    component('amount', 'numberInput', { fieldKey: 'amount', defaultValue: 4, min: 0, max: 20, stateBinding: { scope: 'session', key: 'amount' } }),
    component('caption', 'textInput', { fieldKey: 'caption', defaultValue: 'Initial' }), component('ready', 'checkbox', { fieldKey: 'ready', defaultValue: true }),
    component('secret', 'passwordInput', { fieldKey: 'secret' }), component('choice', 'select', { fieldKey: 'choice', optionsSource: { queryId: 'choices', valueColumn: 'value', labelColumn: 'label' } }),
    component('settings', 'label', { text: 'Settings', customProperties: { limit: { type: 'number', value: 8 } } }),
    instance('single'), instance('nested', 'nested'), instance('defaults', 'card', {}),
    instance('parameter', 'card', { caption: binding('value', { value: reference('parameter', 'base') }), count: binding('limit', { limit: reference('custom', 'limit', 'settings') }) }),
    { ...instance('saved'), type: 'repeater', props: { ...instance('saved').props, rows: [{ id: 'one', parameters: { count: '15', caption: 'Row {base}', ready: 'false' } }], columns: 1, gap: 0 } },
    { ...instance('query'), type: 'repeater', props: { ...instance('query').props, rowsSource: { queryId: 'rows', rowKey: 'row_key', parameterMap: { count: 'count', caption: 'caption' } }, columns: 1, gap: 0 } },
    instance('choice-instance', 'card', { caption: binding('choice', { choice: reference('input', 'choice') }) }),
  ] }, { id: 'popup', name: 'Popup', kind: 'popup', width: 600, height: 400, parameters: { fromCaller: '0', literal: '' }, components: [
    component('popupAmount', 'numberInput', { fieldKey: 'popupAmount', defaultValue: 2, min: 0, max: 20 }),
    instance('popup-instance', 'card', { count: binding('amount', { amount: reference('input', 'popupAmount') }), caption: binding('literal', { literal: reference('parameter', 'literal') }) }),
  ] }];
  // A closePopup opener must not occur inside another popup; use a plain card for its target.
  draft.templates.push(template('popup-card', [component('apply', 'button', { action: 'script', script: echo })]));
  draft.screens[1].components[1].props.templateId = 'popup-card';
  await query('records', 'SELECT id, version, quantity FROM production_records WHERE id=1');
  await query('choices', 'SELECT machine AS value, machine AS label FROM production_records WHERE machine=@machine', [{ name: 'machine', type: 'string', defaultValue: 'Press01' }]);
  await query('rows', "SELECT 'row-one' AS row_key, 17 AS count, '{base}' AS caption");
  await save(); await publish();
  await test('published fx resolves validated parent inputs and authored custom values to native types', async () => {
    const result = success(await action());
    assert.equal(result.parameters.count, 6); assert.equal(result.parameters.caption, '{base}'); assert.equal(result.parameters.ready, true);
    assert.equal(result.booleanType, 'bool'); assert.ok(['float', 'int'].includes(result.numberType)); assert.deepEqual(result.inputs, {});
    assert.deepEqual(outer(await api(route('/runtime/project'))).props.parameterBindings, fx);
  });
  await test('parent parameters and cross-component custom properties need no submitted inputs', async () => {
    const result = success(await action({ instanceId: 'parameter', bindingInputs: null, parameters: { base: '{machine}' } }));
    assert.equal(result.parameters.count, 8); assert.equal(result.parameters.caption, '{machine}');
    assert.equal(success(await action({ instanceId: 'defaults', bindingInputs: undefined })).parameters.count, 3);
    assert.equal(success(await action({ instanceId: 'defaults', bindingInputs: [{}] })).parameters.count, 3);
    await action({ instanceId: 'defaults', bindingInputs: [{ amount: 4 }], status: 400 });
  });
  await test('missing, extra, malformed and out-of-range parent maps reject without default fallback', async () => {
    for (const bindingInputs of [undefined, null, [], {}, 'bad', [null], [inputValues(), {}], [{}], [{ amount: 4, caption: 'x' }], [{ ...inputValues(), secret: 'must-not-leave-parent' }],
      [inputValues(-1)], [inputValues(21)], [inputValues('4')], [inputValues(4, true)], [inputValues(4, 'x', 'true')]]) await action({ bindingInputs, status: 400 });
    for (const body of [{ templateParameters: { count: 999 } }, { popupParameters: {} }, { bindingContext: {} }, { parameters: { count: '999' } }]) await action({ ...body, status: 400 });
  });
  await test('nested input maps align outer-to-inner and resolve typed parent parameters', async () => {
    const result = success(await action({ instanceId: undefined, instancePath: [{ instanceId: 'nested' }, { instanceId: 'inner' }], bindingInputs: [inputValues(5), { delta: 3 }] }));
    assert.equal(result.parameters.count, 10); assert.equal(result.parameters.caption, '{base}');
    await action({ instanceId: undefined, instancePath: [{ instanceId: 'nested' }, { instanceId: 'inner' }], bindingInputs: [{ delta: 3 }, inputValues(5)], status: 400 });
  });
  await test('saved and query rows override resolved fx once while unknown rows remain rejected', async () => {
    const saved = success(await action({ instanceId: 'saved', rowId: 'one' }));
    assert.equal(saved.parameters.count, 15); assert.equal(saved.parameters.caption, 'Row Parent'); assert.equal(saved.parameters.ready, false);
    const queried = success(await action({ instanceId: 'query', rowId: 'row-one' }));
    assert.equal(queried.parameters.count, 17); assert.equal(queried.parameters.caption, '{base}');
    await action({ instanceId: 'query', rowId: 'missing', status: 400 });
    await action({ instanceId: 'saved', rowId: 'one', bindingInputs: [inputValues(99)], status: 400 });
  });
  await test('popup caller and target binding inputs reconstruct independently', async () => {
    const popupOrigin = { screenId: 'main', componentId: 'open', instanceId: 'single', bindingInputs: [inputValues(7, '{base}')] };
    const result = success(await action({ screen: 'popup', instanceId: 'popup-instance', popupOrigin, bindingInputs: [{ popupAmount: 11 }] }));
    assert.equal(result.parameters.count, 11); assert.equal(result.parameters.fromCaller, '9'); assert.equal(result.parameters.caption, '{base}');
    await action({ screen: 'popup', instanceId: 'popup-instance', popupOrigin: { ...popupOrigin, bindingInputs: undefined }, bindingInputs: [{ popupAmount: 11 }], status: 400 });
    await action({ screen: 'popup', instanceId: 'popup-instance', popupOrigin, bindingInputs: [inputValues()], status: 400 });
  });
  await test('table actions reconstruct fx before fixed row-edit inputs', async () => {
    const row = (await api(route('/queries/records/execute'), { method: 'POST', body: {} })).rows[0];
    const result = success(await api(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', body: {
      publishedAt, instanceId: 'single', bindingInputs: [inputValues(8)], key: row.id, version: row.version, column: 'quantity', value: 9,
    } }));
    assert.equal(result.parameters.count, 10); assert.equal(result.inputs.value, 9); assert.equal(result.inputs.oldValue, row.quantity);
  });
  await test('query-selected parent inputs use captured read query and calling parameters', async () => {
    const result = success(await action({ instanceId: 'choice-instance', bindingInputs: [{ choice: 'Press01' }] }));
    assert.equal(result.parameters.caption, 'Press01');
    await action({ instanceId: 'choice-instance', bindingInputs: [{ choice: 'Press02' }], status: 400 });
    assert.equal(success(await action({ instanceId: 'choice-instance', parameters: { machine: 'Press02' }, bindingInputs: [{ choice: 'Press02' }] })).parameters.caption, 'Press02');
    await query('choices', "SELECT 'FORGED' AS value, 'FORGED' AS label");
    assert.equal(success(await action({ instanceId: 'choice-instance', bindingInputs: [{ choice: 'Press01' }] })).parameters.caption, 'Press01');
  });
  await test('invalid schema, source scopes, password sources and bounded constant types reject on save', async () => {
    for (const value of [null, [], { unknown: binding('1') }, { count: null }, { count: binding('1 / 0') }, { count: binding("'not a number'") }, { ready: binding('1') },
      { count: binding('1', { bad: reference('tag', 'anything') }) }, { count: binding('1', { bad: reference('sessionState', 'amount') }) }, { count: binding('1', { bad: reference('screenState', 'amount') }) },
      { count: binding('bad', { bad: reference('input', 'secret') }) }, { count: binding('bad', { bad: reference('input', 'delta') }) },
      { count: binding('bad', { bad: reference('parameter', 'count') }) }, { count: binding('bad', { bad: reference('custom', 'limit', 'absent') }) },
      { count: binding('bad.x', { bad: reference('input', 'amount') }) }, { count: binding('bad()', { bad: reference('input', 'amount') }) },
      { count: binding('1'.repeat(2049)) }, { caption: binding(`'${'x'.repeat(2040)}' + '${'y'.repeat(2040)}'`) }])
      await reject(project => { outer(project).props.parameterBindings = value; });
    await reject(project => { main(project).components[0].props.parameterBindings = {}; });
    await reject(project => { outer(project, 'saved').props.rows[0].parameterBindings = {}; });
    await reject(project => { project.parameterBindings = {}; });
  });
  await test('invalid runtime expression fails every row despite overriding saved values', async () => {
    const original = structuredClone(draft);
    outer(draft, 'saved').props.parameterBindings.count = binding('1 / divisor', { divisor: reference('input', 'amount') });
    await save(); await publish();
    await action({ instanceId: 'saved', rowId: 'one', bindingInputs: [inputValues(0)], status: 400 });
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('publications retain captured bindings and stale publication actions reject', async () => {
    const previous = publishedAt;
    outer(draft).props.customProperties.offset.value = 12; await save();
    assert.equal(success(await action()).parameters.count, 6);
    await publish(); assert.equal(success(await action()).parameters.count, 16);
    await action({ publishedAt: previous, status: 409 });
  });
  await test('sparkproj round trip preserves fx and malformed imported bindings reject atomically', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    assert.deepEqual(outer(await api(`/api/projects/${imported.id}/project`)).props.parameterBindings, fx);
    const before = await api('/api/projects');
    const malformed = unzip(bytes).map(entry => {
      if (entry.name !== 'project.json') return entry;
      const project = JSON.parse(entry.data); outer(project).props.parameterBindings.count.references.amount.key = 'secret';
      return { ...entry, data: Buffer.from(JSON.stringify(project)) };
    });
    await api('/api/projects/import', { method: 'POST', raw: zip(malformed), status: 400 });
    assert.deepEqual(await api('/api/projects'), before);
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} template parameter binding integration groups passed.`);
