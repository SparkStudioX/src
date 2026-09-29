#!/usr/bin/env node
// Authenticated isolated gateway only; independently authored SQLite fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync, inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Use the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the authenticated test-session preload.');
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const connection = { id: `query-property-${run}`, name: 'Query property fixture', type: 'sqlite', database: `query-property-${run}.db` };
let projectId, draft, publishedAt, failure, passed = 0, rejected = 0;
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
const fx = (expression, references = {}) => ({ expression, references });
const ref = (kind, key, componentId) => ({ kind, key, ...(componentId ? { componentId } : {}) });
const qb = (queryId = 'scalar', column = 'amount', extra = {}) => ({ queryId, column, ...extra });
const component = (id, type, props = {}) => ({ id, type, props, x: 10, y: 10, width: 240, height: 80 });
const scalar = (type, value) => ({ type, value });
const control = (project = draft, id = 'label') => project.screens[0].components.find(item => item.id === id);
const query = (id, sql, parameters = [], kind = 'query', status = 200) => api(route(`/queries/${id}`), { method: 'PUT', status,
  body: { id, name: id, connectionId: connection.id, sql, parameters, kind } });
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish(status = 200) {
  const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status });
  if (status === 200) publishedAt = result.publishedAt;
}
const execute = (id, parameters, status = 200, version = publishedAt) => api(route(`/runtime/queries/${id}/execute`), {
  method: 'POST', status, body: { publishedAt: version, parameters },
});
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected bindings must not mutate the draft.');
}
async function test(name, body) { await body(); passed++; console.log(`PASS ${name}`); }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function png() {
  const chunk = (type, data) => { const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 24, 85, 140, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
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
  projectId = (await api('/api/projects', { method: 'POST', body: { name: `Query property ${run}` } })).id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } });
  await query('scalar', "SELECT @amount AS amount, @caption AS caption, 0 AS off, '' AS empty", [
    { name: 'amount', type: 'int', defaultValue: '12' }, { name: 'caption', type: 'string', defaultValue: 'Saved caption' },
  ]);
  await query('table-data', 'SELECT id, machine, quantity FROM production_records ORDER BY id');
  await query('template-only', 'SELECT @delta AS amount', [{ name: 'delta', type: 'number' }]);
  await query('hidden', 'SELECT 999 AS amount');
  await query('write', 'UPDATE production_records SET quantity=0', [], 'update');
  const asset = await api(route('/assets'), { method: 'POST', body: { name: 'Query pixel.png', contentType: 'image/png', dataBase64: png().toString('base64') } });
  const types = ['label', 'value', 'gauge', 'button', 'table', 'textInput', 'numberInput', 'checkbox', 'select', 'list', 'treeView', 'template', 'repeater', 'image', 'icon',
    'textArea', 'spinner', 'slider', 'radioGroup', 'dateTimeInput', 'toggle', 'passwordInput', 'multiStateButton', 'multiStateIndicator', 'ledDisplay', 'progressBar',
    'cylindricalTank', 'levelIndicator', 'thermometer', 'line', 'rectangle', 'ellipse', 'polyline', 'pipe', 'equipmentSymbol'];
  const inputs = ['textInput', 'textArea', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'list', 'treeView', 'radioGroup', 'dateTimeInput', 'passwordInput', 'multiStateButton'];
  const components = types.map(type => {
    const props = { text: type, queryBindings: { text: qb('scalar', 'caption'), width: qb('scalar', 'amount', { transform: 'value * 2', refresh: { mode: 'poll', intervalMs: 1000 } }) } };
    if (inputs.includes(type)) {
      props.fieldKey = type;
      props.defaultValue = ['numberInput', 'spinner', 'slider'].includes(type) ? 1 : ['checkbox', 'toggle'].includes(type) ? false : type === 'passwordInput' ? '' : type === 'dateTimeInput' ? '2026-09-29T09:15' : 'A';
    }
    if (['select', 'list', 'treeView', 'radioGroup', 'multiStateButton'].includes(type)) props.options = [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }];
    if (type === 'slider') Object.assign(props, { min: 0, max: 10, step: 1 });
    if (type === 'multiStateIndicator') props.states = [{ value: 'A', label: 'Active', color: '#123456' }];
    if (type === 'table') props.queryId = 'table-data';
    if (type === 'template' || type === 'repeater') Object.assign(props, { templateId: 'card', parameters: {} });
    if (type === 'repeater') Object.assign(props, { rows: [{ id: 'first', parameters: {} }], columns: 1, gap: 0 });
    if (type === 'image') props.assetId = asset.id;
    if (type === 'icon') props.icon = 'spark';
    if (type === 'button') Object.assign(props, { action: 'script', script: "result = {'keys': sorted(inputs), 'leaked': [key for key in ['queryBindings', 'queryResults', 'value'] if key in globals()]}" });
    if (type === 'equipmentSymbol') props.symbol = 'pump';
    if (['line', 'polyline', 'pipe'].includes(type)) props.points = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
    return component(type, type, props);
  });
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { machine: 'Press01' };
  draft.sessionState = { factor: scalar('number', 2) };
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, state: { offset: scalar('number', 4) }, components }];
  draft.templates = [{ id: 'card', name: 'Card', width: 300, height: 200, parameters: { amount: '2' }, parameterTypes: { amount: 'number' },
    instanceState: { privateValue: scalar('number', 3) }, components: [component('readout', 'label', { customProperties: { offset: scalar('number', 1) }, queryBindings: {
      text: qb('template-only', 'amount', { parameters: { delta: fx('a + b + c + d + e', { a: ref('parameter', 'amount'), b: ref('custom', 'offset'), c: ref('sessionState', 'factor'), d: ref('screenState', 'offset'), e: ref('instanceState', 'privateValue') }) } }),
    } })] }];
  control().props.customProperties = { prefix: scalar('string', 'Line ') };
  control().props.queryBindings.text.parameters = { caption: fx('prefix + selected', { prefix: ref('custom', 'prefix'), selected: ref('input', 'textInput') }) };
  control().props.queryBindings.enabled = qb('scalar', 'off', { transform: 'value > 0', refresh: { mode: 'onChange' } });
  await test('all component and wrapper presentations save and publish query bindings with immutable metadata', async () => {
    await save(); await publish();
    const runtime = await api(route('/runtime/project'));
    assert.deepEqual(runtime.screens[0].components[0].props.queryBindings, control().props.queryBindings);
    assert.equal(runtime.screens[0].components.find(item => item.id === 'button').props.script, undefined);
    const metadata = await api(route(`/runtime/queries?publishedAt=${encodeURIComponent(publishedAt)}`));
    assert.deepEqual(metadata.map(item => item.id).sort(), ['scalar', 'table-data', 'template-only']);
    assert.ok(metadata.every(item => !Object.hasOwn(item, 'sql') && !Object.hasOwn(item, 'connectionId')));
    assert.equal(metadata.find(item => item.id === 'scalar').parameters[0].defaultValue, '12');
    await execute('hidden', {}, 404); await execute('write', {}, 404);
  });
  await test('published SQLite reads preserve defaults, false-like scalars and parameter isolation', async () => {
    assert.deepEqual((await execute('scalar')).rows, [{ amount: 12, caption: 'Saved caption', off: 0, empty: '' }]);
    assert.deepEqual((await execute('scalar', { amount: 8, caption: "'; UPDATE production_records SET quantity=0;--" })).rows[0], {
      amount: 8, caption: "'; UPDATE production_records SET quantity=0;--", off: 0, empty: '',
    });
    assert.equal((await execute('template-only', { delta: 12.5 })).rows[0].amount, 12.5);
    await execute('scalar', { unknown: 1 }, 400); await execute('template-only', {}, 400);
    await execute('scalar', { amount: {} }, 400);
  });
  await test('schema rejects malformed maps, misplaced metadata, unsupported targets and overlapping drivers', async () => {
    for (const value of [null, [], 1, '', true]) await reject(p => { control(p).props.queryBindings = value; });
    for (const mutate of [p => { p.queryBindings = {}; }, p => { p.screens[0].queryBindings = {}; }, p => { control(p).queryBindings = {}; },
      p => { control(p).props.queryBindings.value = qb(); }, p => { control(p, 'passwordInput').props.queryBindings.value = qb(); },
      p => { control(p).props.queryBindings.parameters = qb(); }, p => { control(p).props.bindings = { text: fx("'duplicate'") }; },
      p => { control(p).props.queryBindings.text = { ...qb(), sql: 'SELECT 1' }; }, p => { control(p).props.queryBindings.text = { ...qb(), connectionId: connection.id }; }]) await reject(mutate);
    for (const key of ['queryId', 'column']) for (const value of [undefined, null, [], 1, '', '\uFEFF', 'x'.repeat(key === 'queryId' ? 257 : 129)])
      await reject(p => { control(p).props.queryBindings.text = { ...qb(), [key]: value }; });
    for (const parameters of [null, [], true, 1, { 'bad key': fx('1') }, { amount: null }, { amount: [] }, { amount: { expression: '1', references: {}, code: 'bad' } }])
      await reject(p => { control(p).props.queryBindings.text = qb('scalar', 'caption', { parameters }); });
  });
  await test('refresh policies are exact, bounded and persisted without timer hints in query requests', async () => {
    for (const refresh of [null, [], {}, { mode: 'other' }, { mode: 'onChange', intervalMs: 1000 }, { mode: 'poll' },
      { mode: 'poll', intervalMs: 999 }, { mode: 'poll', intervalMs: 3600001 }, { mode: 'poll', intervalMs: 1000.1 },
      { mode: 'poll', intervalMs: '1000' }, { mode: 'poll', intervalMs: null }, { mode: 'poll', intervalMs: 1000, extra: true }])
      await reject(p => { control(p).props.queryBindings.text.refresh = refresh; });
    const original = structuredClone(control().props.queryBindings.text);
    control().props.queryBindings.text.refresh = { mode: 'poll', intervalMs: 3600000 }; await save();
    assert.equal(control().props.queryBindings.text.refresh.intervalMs, 3600000);
    control().props.queryBindings.text = original; await save();
  });
  await test('query parameter expressions validate every scoped alias and exclude passwords, tags and recursive queries', async () => {
    for (const reference of [ref('input', 'passwordInput'), ref('input', 'missing'), ref('parameter', 'missing'), ref('custom', 'missing'),
      ref('custom', 'prefix', 'not-here'), ref('sessionState', 'missing'), ref('screenState', 'missing'), ref('instanceState', 'privateValue'),
      { kind: 'tag', path: '[default]secret' }, { kind: 'query', queryId: 'scalar', column: 'caption' }, { ...ref('input', 'textInput'), state: {} }]) {
      await reject(p => { control(p).props.queryBindings.text.parameters = { caption: fx("'masked'", { unused: reference }) }; });
    }
    for (const expression of [fx('undeclared'), fx('value +'), fx('1', null), fx('1', []), fx('1', { constructor: ref('input', 'textInput') }), fx('1'.repeat(2049))])
      await reject(p => { control(p).props.queryBindings.text.parameters = { amount: expression }; });
    await reject(p => { p.templates[0].components[0].props.queryBindings.text.parameters.delta.references.e.key = 'missing'; });
    await reject(p => { control(p).props.queryBindings.text.parameters = { caption: fx('value', { value: ref('custom', 'offset', 'readout') }) }; });
  });
  await test('named-query dependencies and mapped native types are checked atomically on save and query edits', async () => {
    for (const value of [qb('missing'), qb('write'), qb('scalar', 'amount', { parameters: { other: fx('1') } }), qb('template-only'),
      qb('scalar', 'amount', { parameters: { amount: fx("'12'") } }), qb('scalar', 'amount', { parameters: { amount: fx('true') } }),
      qb('scalar', 'amount', { parameters: { amount: fx('1.5') } }), qb('scalar', 'amount', { parameters: { amount: fx('2147483648') } }),
      qb('scalar', 'amount', { parameters: { caption: fx('1') } })]) await reject(p => { control(p).props.queryBindings.text = value; });
    const before = await api(route('/queries'));
    await query('scalar', 'SELECT @amount AS amount', [{ name: 'amount', type: 'int' }], 'query', 400);
    await query('scalar', 'UPDATE production_records SET quantity=0', [], 'update', 400);
    await query('scalar', 'SELECT 1 AS amount', [{ name: 'amount', type: 'object', defaultValue: 1 }], 'query', 400);
    assert.deepEqual(await api(route('/queries')), before);
    const aliases = { string: "'x'", nvarchar: "'x'", int: '1', int32: '1', integer: '1', long: '9007199254740991', int64: '1', bigint: '1', number: '1.5',
      double: '1.5', float: '1.5', decimal: '1.5', bool: 'true', boolean: 'true', bit: 'false', date: "'2026-09-29'", datetime: "'2026-09-29T12:00:00'",
      datetime2: "'2026-09-29T12:00:00'", datetimeoffset: "'2026-09-29T12:00:00Z'", guid: "'e8baa446-5a12-4d3e-a2cb-58c5bf1fbe50'", uniqueidentifier: "'e8baa446-5a12-4d3e-a2cb-58c5bf1fbe50'" };
    await query('typed', 'SELECT @int AS amount', Object.keys(aliases).map(name => ({ name, type: name })));
    const original = structuredClone(control().props.queryBindings);
    control().props.queryBindings = { text: qb('typed', 'amount', { parameters: Object.fromEntries(Object.entries(aliases).map(([key, expression]) => [key, fx(expression)])) }) };
    await save();
    for (const [key, expression] of [['string', '1'], ['int', '1.5'], ['long', '1.5'], ['number', "'1'"], ['bool', '1'], ['date', '1'], ['guid', 'false']])
      await reject(p => { control(p).props.queryBindings.text.parameters[key] = fx(expression); });
    control().props.queryBindings = original; await save();
  });
  await test('transforms accept only the raw value alias and enforce constant target constraints', async () => {
    for (const transform of [null, [], 2, '', '\uFEFF', 'input', 'parameters.amount', 'value +', '1 / 0', 'x'.repeat(2049)])
      await reject(p => { control(p).props.queryBindings.text.transform = transform; });
    for (const [target, transform] of [['width', '0'], ['x', '-1'], ['height', '8193'], ['fontSize', '257'], ['borderWidth', '33'],
      ['enabled', '1'], ['visible', "'true'"], ['color', "'red'"], ['backgroundColor', "'#xyz'"]])
      await reject(p => { control(p).props.queryBindings[target] = qb('scalar', 'amount', { transform }); });
    await reject(p => { control(p, 'progressBar').props.queryBindings.value = qb('scalar', 'amount', { transform: "'12'" }); });
    await reject(p => { control(p, 'progressBar').props.queryBindings.min = qb('scalar', 'amount', { transform: '20' }); control(p, 'progressBar').props.queryBindings.max = qb('scalar', 'amount', { transform: '10' }); });
    const original = structuredClone(control(draft, 'progressBar').props);
    control(draft, 'progressBar').props.bindings = { min: fx('200') };
    control(draft, 'progressBar').props.queryBindings.max = qb('scalar', 'amount', { transform: 'value * 100' }); await save();
    control(draft, 'progressBar').props = original; await save();
  });
  await test('template query state references are checked in every placement, including empty repeaters', async () => {
    const original = structuredClone(draft);
    draft.screens.push({ id: 'other', name: 'Other', width: 600, height: 400, components: [component('empty', 'repeater', { templateId: 'card', parameters: {}, rows: [], columns: 1, gap: 0 })] });
    await save(); await publish(400);
    draft.screens[1].state = { offset: scalar('number', 10) }; await save(); await publish();
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('publication pins query SQL and mapping metadata while draft edits remain isolated', async () => {
    const prior = publishedAt;
    await query('scalar', "SELECT @amount + 100 AS amount, @caption AS caption, 0 AS off, '' AS empty", [
      { name: 'amount', type: 'int', defaultValue: '12' }, { name: 'caption', type: 'string', defaultValue: 'Saved caption' },
    ]);
    control().props.queryBindings.width.transform = 'value * 3'; await save();
    assert.equal((await execute('scalar')).rows[0].amount, 12);
    assert.equal((await api(route('/runtime/project'))).screens[0].components[0].props.queryBindings.width.transform, 'value * 2');
    await publish(); assert.equal((await execute('scalar')).rows[0].amount, 112); await execute('scalar', {}, 409, prior);
  });
  await test('zero, multiple, null and missing-column result shapes remain explicit for bounded browser extraction', async () => {
    for (const [id, sql] of [['zero', 'SELECT 1 AS amount WHERE 0'], ['multiple', 'SELECT 1 AS amount UNION ALL SELECT 2'], ['null', 'SELECT @amount AS amount'], ['missing', "SELECT 'other' AS different"]]) {
      await query(`shape-${id}`, sql, id === 'null' ? [{ name: 'amount', type: 'int', defaultValue: null }] : []);
      draft.screens[0].components.push(component(`shape-${id}`, 'label', { queryBindings: { text: qb(`shape-${id}`) } }));
    }
    await save(); await publish();
    assert.equal((await execute('shape-zero')).rows.length, 0);
    assert.equal((await execute('shape-multiple')).rows.length, 2);
    assert.deepEqual((await execute('shape-null')).rows, [{ amount: null }]);
    assert.deepEqual((await execute('shape-missing')).columns, ['different']);
    // The established query API remains a read-data API; component extraction
    // and unavailable presentation are separately exercised by browser models.
  });
  await test('sparkproj round trips queries and property bindings and rejects invalid imports before catalog mutation', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.templates, draft.templates);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const [filename, mutate] of [
      ['project.json', p => { control(p).props.queryBindings.text.refresh = { mode: 'poll', intervalMs: 1 }; }],
      ['project.json', p => { control(p).props.queryBindings.text.queryId = 'hidden-missing'; }],
      ['project.json', p => { control(p).props.queryBindings.text.parameters.caption.references.selected = ref('input', 'passwordInput'); }],
      ['project.json', p => { control(p).props.queryBindings.text.transform = 'other'; }],
      ['queries.json', queries => { queries.find(q => q.id === 'scalar').kind = 'update'; }],
      ['queries.json', queries => { queries.find(q => q.id === 'scalar').parameters.push({ name: 'required', type: 'int' }); }],
    ]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== filename) return entry; const value = JSON.parse(entry.data); mutate(value); return { ...entry, data: Buffer.from(JSON.stringify(value)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('query presentation definitions and resolved values cannot create runtime action authority', async () => {
    for (const extra of [{ queryBindings: {} }, { queryResults: { amount: 999 } }, { value: true }, { sql: 'UPDATE production_records SET quantity=0' }])
      await api(route('/runtime/screens/main/components/button/action'), { method: 'POST', status: 400, body: { publishedAt, ...extra } });
    const result = await api(route('/runtime/screens/main/components/button/action'), { method: 'POST', body: { publishedAt } });
    assert.equal(result.success, true, result.stderr); assert.deepEqual(result.result.leaked, []);
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} query property binding integration groups passed; ${rejected} malformed save variants rejected.`);
