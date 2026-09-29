#!/usr/bin/env node
// Authenticated isolated gateway only. All writes use a disposable synthetic SQLite database.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091'); assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Run with the authenticated test-session preload.');
const run = randomUUID().slice(0, 8), created = [], signal = `[default]TableEditTests/${run}/Started`;
const connection = { id: `table-edit-${run}`, name: 'Synthetic table editing', type: 'sqlite', database: `table-edit-${run}.db` };
let projectId, draft, publishedAt, passed = 0, rejected = 0, viewerUser, signalCreated = false, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 500, height: 200 });
const columns = [
  { key: 'quantity', type: 'number', min: 0, max: 1000, integer: true },
  { key: 'status', type: 'string', required: true, maxLength: 100 },
  { key: 'active', type: 'boolean' }, { key: 'nullable_status', type: 'string', maxLength: 100 },
  { key: 'work_order', type: 'string', maxLength: 256 },
];
const sourceSql = "SELECT id, version, machine, work_order, quantity, status, quantity>0 AS active, CASE WHEN id=3 THEN NULL ELSE status END AS nullable_status FROM production_records WHERE @machine='' OR machine=@machine ORDER BY id";
const repeaterSql = "SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, machine, '{filter}' AS literal, 12 AS scale FROM production_records WHERE @machine='' OR machine=@machine ORDER BY id";
const queryParameters = [{ name: 'machine', type: 'string', defaultValue: '' }];
const writeSql = field => `UPDATE production_records SET ${field}=@value, version=version+1 WHERE id=@id AND version=@expectedVersion`;
const writeParameters = type => [{ name: 'id', type: 'int' }, { name: 'expectedVersion', type: 'int' }, { name: 'value', type }];
const echo = "result = {'inputs': inputs, 'parameters': parameters, 'marker': 'published'}";
const guardedScript = [
  "names = {'quantity':'update-quantity','status':'update-status','active':'update-active','nullable_status':'update-status','work_order':'update-work-order'}",
  "affected = system.db.runNamedQuery(names[inputs['column']], {'id':inputs['rowKey'],'expectedVersion':inputs['version'],'value':inputs['value']})",
  "if affected != 1: raise ValueError('Stale row: reload before editing again.')",
  echo,
].join('\n');
const slowScript = `import time\nsystem.tag.writeBlocking([${JSON.stringify(signal)}], [True])\ntime.sleep(1.5)\n${guardedScript}`;
const tableProps = (script = guardedScript) => ({ queryId: 'rows', rowKey: 'id', pageSize: 10,
  tableColumns: [{ key: 'machine' }, { key: 'quantity', format: 'number' }, { key: 'status' }],
  tableEdit: { versionColumn: 'version', columns: structuredClone(columns), script } });
const props = (project, id = 'table', screen = 'main') => project.screens.find(item => item.id === screen).components.find(item => item.id === id).props;

async function api(url, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(url, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (url.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${url}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
async function rawApi(url, { method = 'GET', body, cookie, csrf, status = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(url, base), { method, headers: { 'X-SPARK-AUDIENCE': 'operator', 'X-SPARK-PROJECT': projectId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-SPARK-CSRF': csrf } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        try { const bytes = Buffer.concat(chunks), data = bytes.length ? JSON.parse(bytes) : null;
          assert.equal(response.statusCode, status, `${method} ${url}: ${JSON.stringify(data).slice(0, 500)}`);
          resolve({ data, cookie: (response.headers['set-cookie'] ?? []).map(item => item.split(';')[0]).join('; ') });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.setTimeout(30_000, () => request.destroy(new Error('Request timed out.')));
    if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
const query = (id, sql, parameters = [], kind = 'query') => ({ id, name: id, connectionId: connection.id, sql, parameters, kind });
const saveQuery = (id, sql, parameters = [], kind = 'query') => api(route(`/queries/${id}`), { method: 'PUT', body: query(id, sql, parameters, kind) });
const saveRows = (sql = sourceSql) => saveQuery('rows', sql, queryParameters);
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish(status = 200) { const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status }); if (status === 200) publishedAt = result.publishedAt; return result; }
const rows = async (machine = '') => (await api(route('/queries/rows/execute'), { method: 'POST', body: { parameters: { machine } } })).rows;
const current = async id => (await rows()).find(row => row.id === id);
const edit = ({ screen = 'main', componentId = 'table', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${componentId}/table-edit`), { method: 'POST', status, body: { publishedAt, key: 1, version: 1, column: 'quantity', value: 10, ...body } });
const editCurrent = async (id, column, value, scope = {}) => { const row = await current(id); return edit({ key: id, version: row.version, column, value, ...scope }); };
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function reject(mutate) { const invalid = structuredClone(draft); mutate(invalid); await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++; assert.deepEqual(await api(route('/project')), draft); }
async function resetSignal() { await api('/api/scripts/run', { method: 'POST', body: { code: `system.tag.writeBlocking([${JSON.stringify(signal)}], [False])\nresult = True` } }); }
async function waitSignal() {
  for (let count = 0; count < 100; count++) { if ((await api('/api/tags/read', { method: 'POST', body: { paths: [signal] } }))[0].value === true) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('The in-flight table script did not reach its snapshot signal.');
}
function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42), method = bytes.readUInt16LE(offset + 10);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
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
  projectId = (await api('/api/projects', { method: 'POST', body: { name: `Inline table editing ${run}` } })).id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  await api('/api/tags', { method: 'POST', body: { path: signal, kind: 'memory', dataType: 'Boolean', value: false, enabled: true } }); signalCreated = true;
  await saveRows(); await saveQuery('repeater-rows', repeaterSql, queryParameters);
  for (const [id, field, type] of [['quantity', 'quantity', 'number'], ['status', 'status', 'string'], ['work-order', 'work_order', 'string']])
    await saveQuery(`update-${id}`, writeSql(field), writeParameters(type), 'update');
  await saveQuery('update-active', 'UPDATE production_records SET quantity=CASE WHEN @value THEN 1 ELSE 0 END,version=version+1 WHERE id=@id AND version=@expectedVersion', writeParameters('boolean'), 'update');
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { filter: '', token: '{filter}' };
  const gridSource = { queryId: 'repeater-rows', rowKey: 'row_key', parameterMap: { machine: 'machine', marker: 'literal', scale: 'scale' } };
  const openerSource = { queryId: 'repeater-rows', rowKey: 'row_key', parameterMap: { machine: 'machine', marker: 'literal' } };
  draft.templates = [
    { id: 'grid', name: 'Editable grid', width: 800, height: 600, parameters: { machine: '{machine}', marker: 'Template {marker}', scale: '5' }, parameterTypes: { scale: 'number' },
      components: [component('grid-table', 'table', tableProps())] },
    { id: 'opener', name: 'Grid opener', width: 300, height: 180, parameters: { machine: '{machine}', marker: '{marker}' },
      components: [component('open', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { machine: '{machine}', marker: '{marker}' } })] },
  ];
  draft.screens = [
    { id: 'main', name: 'Tables', width: 1600, height: 1000, parameters: { machine: '{filter}', marker: 'Screen {filter}' }, components: [
      component('table', 'table', tableProps()), component('echo', 'table', tableProps(echo)), component('race', 'table', tableProps(slowScript)),
      component('readonly', 'table', { queryId: 'rows' }), component('label', 'label', { text: 'No implicit writes' }),
      component('instance', 'template', { templateId: 'grid', parameters: { machine: 'Press01', marker: 'Instance {marker}', scale: '8' } }),
      component('saved-rows', 'repeater', { templateId: 'grid', rows: [{ id: 'saved', parameters: { machine: 'Press02', marker: 'Saved {marker}', scale: '9' } }], columns: 1, gap: 0 }),
      component('query-rows', 'repeater', { templateId: 'grid', columns: 1, gap: 0, rowsSource: gridSource }),
      component('query-openers', 'repeater', { templateId: 'opener', columns: 1, gap: 0, rowsSource: openerSource }),
      component('direct', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { machine: 'Press03', marker: '{token}' } }),
      component('ordinary', 'button', { action: 'script', script: echo }),
    ] },
    { id: 'detail', name: 'Table popup', kind: 'popup', width: 1000, height: 800, parameters: { machine: '', marker: 'Popup {filter}' }, components: [
      component('table', 'table', tableProps()), component('popup-instance', 'template', { templateId: 'grid' }),
      component('popup-rows', 'repeater', { templateId: 'grid', columns: 1, gap: 0, rowsSource: gridSource }),
    ] },
  ];
  await test('editable metadata saves in screens/templates and runtime publication never exposes its Python', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.deepEqual(props(runtime).tableEdit.columns, columns); assert.equal(props(runtime).tableEdit.script, undefined);
    assert.equal(runtime.templates[0].components[0].props.tableEdit.script, undefined);
    assert.equal(props(runtime, 'table', 'detail').tableEdit.script, undefined); assert.equal(props(runtime, 'ordinary').script, undefined);
    assert.deepEqual(props(await api(route('/project'))).tableEdit.script, guardedScript);
    assert.deepEqual((await api(route('/runtime/queries'))).map(item => item.id).sort(), ['repeater-rows', 'rows']);
  });
  await test('malformed edit schemas, structural keys and typed constraints are rejected before saving', async () => {
    for (const tableEdit of [null, {}, [], true, { ...tableProps().tableEdit, extra: true }, { ...tableProps().tableEdit, script: null },
      { ...tableProps().tableEdit, script: '' }, { ...tableProps().tableEdit, script: ' '.repeat(20) }, { ...tableProps().tableEdit, script: 'x'.repeat(64001) },
      { ...tableProps().tableEdit, columns: null }, { ...tableProps().tableEdit, columns: [] }, { ...tableProps().tableEdit, columns: Array.from({ length: 65 }, (_, i) => ({ key: `c${i}`, type: 'string' })) }])
      await reject(project => { props(project).tableEdit = tableEdit; });
    for (const key of [null, '', ' ', ' before', 'after ', 'a\nkey', 'a\u009fkey', 'x'.repeat(129)])
      for (const property of ['rowKey', 'queryId', 'versionColumn']) await reject(project => { (property === 'versionColumn' ? props(project).tableEdit : props(project))[property] = key; });
    await reject(project => { props(project).tableEdit.versionColumn = 'id'; });
    const invalid = [null, {}, true, { key: 'id', type: 'string' }, { key: 'version', type: 'number' }, { key: 'q', type: 'date' },
      { key: 'q', type: 'string', extra: true }, { key: 'q', type: 'string', min: 0 }, { key: 'q', type: 'string', max: 1 },
      { key: 'q', type: 'string', integer: true }, { key: 'q', type: 'number', required: true }, { key: 'q', type: 'boolean', required: false },
      { key: 'q', type: 'boolean', maxLength: 10 }, { key: 'q', type: 'number', maxLength: 10 }, { key: 'q', type: 'boolean', min: 0 }];
    for (const value of [null, true, '1', 0, 4097, 1.5]) invalid.push({ key: 'q', type: 'string', maxLength: value });
    for (const value of [null, 0, 'false', {}]) { invalid.push({ key: 'q', type: 'string', required: value }); invalid.push({ key: 'q', type: 'number', integer: value }); }
    for (const value of [null, true, '1', 9007199254740992, -9007199254740992]) { invalid.push({ key: 'q', type: 'number', min: value }); invalid.push({ key: 'q', type: 'number', max: value }); }
    invalid.push({ key: 'q', type: 'number', min: 2, max: 1 });
    for (const definition of invalid) await reject(project => { props(project).tableEdit.columns = [definition]; });
    await reject(project => { props(project).tableEdit.columns = [columns[0], columns[0]]; });
    await reject(project => { props(project, 'label').tableEdit = tableProps().tableEdit; });
    await reject(project => { project.templates[0].components[0].props.tableEdit.columns[0].key = 'version'; });
    await reject(project => { props(project).bindings = { tableEdit: { expression: 'true', references: {} } }; });
  });
  await test('inclusive schema limits are preserved without interpreting unknown source columns at save time', async () => {
    const original = structuredClone(props(draft, 'echo').tableEdit);
    const definition = { versionColumn: 'version', script: '#' + 'x'.repeat(63999), columns: [
      { key: 's'.repeat(128), type: 'string', required: false, maxLength: 1 },
      { key: 'longtext', type: 'string', maxLength: 4096 },
      { key: 'number', type: 'number', min: -9007199254740991, max: 9007199254740991, integer: false },
      { key: 'zero', type: 'number', min: 0, max: 0, integer: true },
      ...Array.from({ length: 60 }, (_, index) => ({ key: `flag${index}`, type: 'boolean' })),
    ] };
    props(draft, 'echo').tableEdit = definition; await save(); await publish();
    assert.deepEqual(props(await api(route('/runtime/project')), 'echo').tableEdit.columns, definition.columns);
    props(draft, 'echo').tableEdit = original; await save(); await publish();
  });
  await test('accepted string, Boolean and numeric edits receive fixed server inputs and update exactly one version', async () => {
    for (const [id, column, value] of [[1, 'quantity', 50], [1, 'status', 'running'], [2, 'active', false], [2, 'active', true], [3, 'nullable_status', 'queued'], [3, 'work_order', '']]) {
      const before = await current(id), response = await editCurrent(id, column, value); assert.equal(response.success, true, response.stderr);
      assert.deepEqual(Object.keys(response.result.inputs).sort(), ['column', 'oldValue', 'row', 'rowKey', 'value', 'version']);
      assert.equal(response.result.inputs.oldValue, before[column]); assert.equal(response.result.inputs.rowKey, id); assert.equal(response.result.inputs.version, before.version);
      assert.deepEqual(response.result.inputs.row, before); assert.equal(response.result.inputs.value, value); assert.equal((await current(id)).version, before.version + 1);
    }
    const before = await current(1), rejected = await editCurrent(1, 'status', 'outside-database-enum');
    assert.equal(rejected.success, false); assert.deepEqual(await current(1), before, 'A rejected database constraint must return script failure without changing the row.');
  });
  await test('invalid values, forged payload fields and undeclared context never execute a write', async () => {
    const before = await current(1);
    for (const [column, values] of [['quantity', [null, '', '2', false, {}, [], -1, 1001, 1.5, 9007199254740992]],
      ['status', [null, false, 12, {}, [], '', '  ', 'x'.repeat(101)]], ['active', [null, 0, 1, 'true', {}, []]]])
      for (const value of values) await edit({ key: 1, version: before.version, column, value, status: 400 });
    for (const extra of [{ code: 'result=True' }, { script: 'result=True' }, { sql: 'UPDATE production_records SET version=0' }, { inputs: {} }, { oldValue: 'forged' }, { row: {} }, { parameters: { undeclared: 'value' } }, { parameters: { filter: false } }])
      await edit({ key: 1, version: before.version, ...extra, status: 400 });
    for (const key of [null, false, {}, [], '', ' ', 'x'.repeat(4097), 1.5, 9007199254740992, '1'])
      await edit({ key, version: before.version, status: 400 });
    for (const version of [null, false, '1', -1, 1.5, 9007199254740992]) await edit({ version, status: 400 });
    for (const column of ['id', 'version', 'missing']) await edit({ version: before.version, column, status: 400 });
    await edit({ version: before.version, publishedAt: undefined, status: 400 });
    await edit({ version: before.version, componentId: 'readonly', status: 404 });
    await edit({ version: before.version, componentId: 'ordinary', status: 404 });
    assert.deepEqual(await current(1), before);
  });
  await test('current read-query membership and complete row identity/version validity guard every edit', async () => {
    const before = await current(1);
    await edit({ version: before.version, parameters: { filter: 'Press02' }, status: 400 });
    await edit({ version: before.version - 1, status: 400 }); await edit({ key: 999, version: 1, status: 400 });
    const deleted = await current(3);
    await saveQuery('fixture-delete', 'DELETE FROM production_records WHERE id=@id', [{ name: 'id', type: 'int' }], 'update');
    await saveQuery('fixture-restore', 'INSERT INTO production_records(id,version,machine,work_order,quantity,status,recorded_at) VALUES (@id,@version,@machine,@work_order,@quantity,@status,@recorded_at)',
      ['id', 'version', 'machine', 'work_order', 'quantity', 'status', 'recorded_at'].map(name => ({ name, type: ['id', 'version', 'quantity'].includes(name) ? 'number' : 'string' })), 'update');
    await api(route('/queries/fixture-delete/execute'), { method: 'POST', body: { parameters: { id: 3 } } });
    await edit({ key: 3, version: deleted.version, status: 400 });
    await api(route('/queries/fixture-restore/execute'), { method: 'POST', body: { parameters: { id: deleted.id, version: deleted.version, machine: deleted.machine,
      work_order: deleted.work_order, quantity: deleted.quantity, status: deleted.status, recorded_at: '2026-01-01T08:30:00Z' } } });
    const row = (key = '1', version = '1', status = "'original'") => `SELECT ${key} AS id,${version} AS version,'Press01' AS machine,'WO' AS work_order,1 AS quantity,${status} AS status,1 AS active,NULL AS nullable_status`;
    for (const sql of [row('NULL'), row('1.5'), row('9007199254740992'), row("'   '"), row('1', "'1'"), row('1', '-1'), row('1', '1.5'), row('1', '9007199254740992'),
      `${row()} UNION ALL ${row()}`, `${row()} UNION ALL ${row('2', '-1')}`, 'SELECT 1 AS id,1 AS version']) {
      await saveRows(sql); await publish(); await edit({ componentId: 'echo', key: 1, version: 1, status: 400 });
    }
    await saveRows(`${row('1', '1', "'number'")} UNION ALL ${row("'1'", '1', "'string'")}`); await publish();
    const typed = await edit({ componentId: 'echo', key: '1', version: 1, column: 'status', value: 'new' }); assert.equal(typed.success, true); assert.equal(typed.result.inputs.oldValue, 'string');
    const many = count => `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<${count}) SELECT n AS id,1 AS version,'Press01' AS machine,'WO' AS work_order,1 AS quantity,'queued' AS status,1 AS active,NULL AS nullable_status FROM numbers`;
    await saveRows(many(1000)); await publish(); const last = await edit({ componentId: 'echo', key: 1000, version: 1 }); assert.equal(last.success, true); assert.equal(last.result.inputs.rowKey, 1000);
    await saveRows(many(1001)); await publish(); await edit({ componentId: 'echo', key: 1, version: 1, status: 409 });
    await saveRows(); await publish(); assert.deepEqual(await current(1), before);
  });
  await test('static templates, saved repeater rows and typed dynamic rows reconstruct their own query context', async () => {
    let response = await editCurrent(1, 'quantity', 70, { componentId: 'grid-table', instanceId: 'instance' });
    assert.equal(response.success, true, response.stderr); assert.equal(response.result.parameters.machine, 'Press01'); assert.equal(response.result.parameters.scale, 8);
    response = await editCurrent(2, 'quantity', 71, { componentId: 'grid-table', instanceId: 'saved-rows', rowId: 'saved' });
    assert.equal(response.success, true, response.stderr); assert.equal(response.result.parameters.machine, 'Press02'); assert.equal(response.result.parameters.scale, 9);
    const before = await current(1), rowId = `${before.id}:${before.version}`;
    response = await edit({ componentId: 'grid-table', instanceId: 'query-rows', rowId, key: 1, version: before.version, column: 'quantity', value: 72 });
    assert.equal(response.success, true, response.stderr); assert.equal(response.result.parameters.marker, '{filter}'); assert.equal(response.result.parameters.scale, 12);
    await edit({ componentId: 'grid-table', instanceId: 'query-rows', rowId, key: 1, version: before.version + 1, status: 400 });
    const second = await current(2); await edit({ componentId: 'grid-table', instanceId: 'instance', key: 2, version: second.version, status: 400 });
    await edit({ componentId: 'grid-table', instanceId: 'saved-rows', rowId: 'forged', status: 404 });
    await edit({ rowId: 'unscoped', status: 400 });
  });
  await test('popup edits validate their opener before resolving nested query repeater context and literal braces', async () => {
    const direct = { screenId: 'main', componentId: 'direct' };
    let response = await editCurrent(3, 'quantity', 73, { screen: 'detail', popupOrigin: direct });
    assert.equal(response.success, true, response.stderr); assert.equal(response.result.parameters.marker, '{filter}');
    const before = await current(1), rowId = `${before.id}:${before.version}`;
    const popupOrigin = { screenId: 'main', componentId: 'open', instanceId: 'query-openers', rowId };
    response = await edit({ screen: 'detail', componentId: 'grid-table', instanceId: 'popup-rows', rowId, popupOrigin, key: 1, version: before.version, column: 'quantity', value: 74 });
    assert.equal(response.success, true, response.stderr); assert.equal(response.result.parameters.machine, 'Press01'); assert.equal(response.result.parameters.marker, '{filter}');
    await edit({ screen: 'detail', key: 1, version: before.version + 1, popupOrigin, status: 400 });
    await edit({ screen: 'detail', popupOrigin: { screenId: 'main', componentId: 'ordinary' }, status: 400 });
    await edit({ screen: 'detail', status: 400 }); await edit({ popupOrigin: direct, status: 400 });
    await editCurrent(3, 'quantity', 75, { screen: 'detail', componentId: 'grid-table', instanceId: 'popup-instance', popupOrigin: direct });
  });
  await test('draft code, edit constraints and update query changes remain isolated until explicitly published', async () => {
    const oldCode = props(draft).tableEdit.script;
    props(draft).tableEdit.script = "raise ValueError('draft-only')"; props(draft).tableEdit.columns[0].max = 5; await save();
    await saveQuery('update-quantity', 'UPDATE production_records SET quantity=999,version=version+1 WHERE id=@id AND version=@expectedVersion', writeParameters('number'), 'update');
    const response = await editCurrent(1, 'quantity', 123); assert.equal(response.success, true, response.stderr); assert.equal((await current(1)).quantity, 123);
    const previous = publishedAt; await publish(); const row = await current(1);
    await edit({ key: 1, version: row.version, value: 124, publishedAt: previous, status: 409 });
    await edit({ key: 1, version: row.version, value: 124, status: 400 });
    const failed = await edit({ key: 1, version: row.version, value: 4 }); assert.equal(failed.success, false); assert.match(failed.stderr, /draft-only/); assert.equal((await current(1)).quantity, 123);
    props(draft).tableEdit.script = oldCode; props(draft).tableEdit.columns[0].max = 1000;
    await saveQuery('update-quantity', writeSql('quantity'), writeParameters('number'), 'update'); await save(); await publish();
  });
  await test('competing edits pass preflight but the authored SQLite version guard commits only one', async () => {
    await resetSignal(); const row = await current(1);
    const first = edit({ componentId: 'race', key: 1, version: row.version, value: 201 }); first.catch(() => {}); await waitSignal();
    const second = edit({ componentId: 'race', key: 1, version: row.version, value: 202 });
    const responses = await Promise.all([first, second]); assert.equal(responses.filter(item => item.success).length, 1);
    assert.match(responses.find(item => !item.success).stderr, /Stale row/); const after = await current(1);
    assert.equal(after.version, row.version + 1); assert.ok([201, 202].includes(after.quantity));
  });
  await test('a new publication cannot replace in-flight table code or captured update query definitions', async () => {
    await resetSignal(); const row = await current(1), previous = publishedAt;
    const pending = edit({ componentId: 'race', key: 1, version: row.version, value: 303 }); pending.catch(() => {}); await waitSignal();
    props(draft, 'race').tableEdit.script = "raise ValueError('new-publication')";
    await saveQuery('update-quantity', 'UPDATE production_records SET quantity=999,version=version+1 WHERE id=@id AND version=@expectedVersion', writeParameters('number'), 'update');
    await save(); await publish(); const response = await pending; assert.equal(response.success, true, response.stderr);
    assert.equal(response.result.marker, 'published'); assert.equal((await current(1)).quantity, 303);
    await edit({ componentId: 'race', key: 1, version: row.version + 1, publishedAt: previous, status: 409 });
    props(draft, 'race').tableEdit.script = slowScript;
    await saveQuery('update-quantity', writeSql('quantity'), writeParameters('number'), 'update'); await save(); await publish();
  });
  await test('viewer permissions, CSRF and engineering-cookie separation protect the new endpoint', async () => {
    const identity = { username: `table-edit-${run}`, password: randomBytes(24).toString('base64url') };
    viewerUser = await api('/api/security/users', { method: 'POST', status: 201, body: { ...identity, projectGrants: { [projectId]: { view: true, operate: false, design: false, publish: false } } } });
    let signed = await rawApi('/api/auth/login', { method: 'POST', body: { ...identity, audience: 'operator', projectId } });
    let session = { cookie: signed.cookie, csrf: signed.data.csrfToken }, row = await current(1), body = { publishedAt, key: 1, version: row.version, column: 'quantity', value: 304 };
    const runtime = await rawApi(route('/runtime/project'), session); assert.equal(props(runtime.data).tableEdit.script, undefined);
    await rawApi(route('/runtime/screens/main/components/table/table-edit'), { ...session, method: 'POST', body, status: 403 });
    await rawApi(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', body, status: 401 });
    viewerUser = await api(`/api/security/users/${viewerUser.id}`, { method: 'PUT', body: { ...viewerUser, projectGrants: { [projectId]: { view: true, operate: true, design: true, publish: false } } } });
    signed = await rawApi('/api/auth/login', { method: 'POST', body: { ...identity, audience: 'operator', projectId } }); session = { cookie: signed.cookie, csrf: signed.data.csrfToken };
    await rawApi(route('/runtime/screens/main/components/table/table-edit'), { cookie: signed.cookie, method: 'POST', body, status: 403 });
    const accepted = await rawApi(route('/runtime/screens/main/components/table/table-edit'), { ...session, method: 'POST', body }); assert.equal(accepted.data.success, true, accepted.data.stderr);
    const engineering = await rawApi('/api/auth/login', { method: 'POST', body: { ...identity, audience: 'engineering', projectId } });
    row = await current(1); body = { ...body, version: row.version };
    await rawApi(route('/runtime/screens/main/components/table/table-edit'), { cookie: engineering.cookie, csrf: engineering.data.csrfToken, method: 'POST', body, status: 401 });
    const audit = await api('/api/security/audit?limit=500'); assert.ok(audit.entries.some(item => item.actor === identity.username && item.resource?.endsWith('/table-edit')));
  });
  await test('portable drafts preserve edit scripts and reject invalid imported editing metadata atomically', async () => {
    const bytes = await api(route('/export'), { binary: true }), entries = unzip(bytes);
    const exported = JSON.parse(entries.find(entry => entry.name === 'project.json').data); assert.equal(props(exported).tableEdit.script, guardedScript);
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes }); const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(props(restored).tableEdit, props(draft).tableEdit); assert.deepEqual(restored.templates[0].components[0].props.tableEdit, draft.templates[0].components[0].props.tableEdit);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project).tableEdit.columns[0].key = 'version'; }, project => { props(project).tableEdit.script = null; },
      project => { project.templates[0].components[0].props.tableEdit.columns[0].integer = 'true'; }]) {
      const invalid = entries.map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(invalid), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally {
  if (viewerUser) try { await api(`/api/security/users/${viewerUser.id}`, { method: 'PUT', body: { ...viewerUser, disabled: true, projectGrants: {} } }); } catch (error) { failure ??= error; }
  if (signalCreated) try { await api(`/api/tag-definitions?path=${encodeURIComponent(signal)}`, { method: 'DELETE', status: 204 }); } catch (error) { failure ??= error; }
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} table-editing integration groups passed; ${rejected} malformed saved definitions rejected.`);
