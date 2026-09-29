#!/usr/bin/env node
// Isolated gateway only. Creates and archives its own projects; its unique test
// database/connection remain in the disposable data directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Query repeater tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 700)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 60 });
const source = { queryId: 'rows', rowKey: 'row_key', parameterMap: { id: 'record_id', version: 'row_version', title: 'label', literal: 'literal', filter: 'query_context', number: 'numeric' } };
const connection = { id: `repeater-${run}`, name: 'Query repeater fixture', type: 'sqlite', database: `repeater-${run}.db` };
const originalSql = `SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, id AS record_id, version AS row_version,
machine AS label, '{rootValue}' AS literal, @filter AS query_context, 0.0000001 AS numeric
FROM production_records WHERE @filter='' OR machine=@filter ORDER BY id`;
const columns = (key = "'one'", value = "'Value'") => `SELECT ${key} AS row_key, 1 AS record_id, 1 AS row_version, ${value} AS label, '{rootValue}' AS literal, '' AS query_context, 0.000001 AS numeric`;
const query = (sql = originalSql, parameters = [{ name: 'filter', type: 'string', defaultValue: '' }]) => ({ id: 'rows', name: 'Reusable card rows', connectionId: connection.id, sql, parameters });
let projectId, draft, publishedAt, passed = 0;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function save(value = draft) { draft = await api(route('/project'), { method: 'PUT', body: value }); }
async function publish(status = 200) {
  const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status });
  if (status === 200) publishedAt = result.publishedAt;
}
const saveQuery = (definition = query()) => api(route('/queries/rows'), { method: 'PUT', body: definition });
const action = (rowId, extra = {}, status = 200) => api(route('/runtime/screens/main/components/apply/action'), { method: 'POST', status,
  body: { publishedAt, instanceId: 'cards', rowId, ...extra } });
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }

// Modify a genuine export to verify import validation before catalog mutation.
function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const method = bytes.readUInt16LE(offset + 10); assert.ok(method === 0 || method === 8);
    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) }); offset += 46 + length + extra + comment;
  }
  return entries;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let failure;
try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Query repeaters ${run}` } }); projectId = project.id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { rootFilter: 'Press01', rootValue: 'ROOT', token: '{rootValue}' };
  draft.templates = [{ id: 'card', name: 'Reusable card', width: 320, height: 200,
    parameters: { id: 'default', version: '0', title: 'Template {rootValue}', literal: '{token}', filter: 'Template filter', number: '0', retained: 'Default {rootValue}' },
    components: [component('title', 'label', { text: '{title}' }), component('filter', 'textInput', { fieldKey: 'filter', defaultValue: 'Mutable form value' }),
      component('apply', 'button', { action: 'script', script: "result = {'parameters': parameters, 'inputs': inputs}" })] }];
  draft.screens = [{ id: 'main', name: 'Reusable cards', width: 1200, height: 800, parameters: { filter: '{rootFilter}' }, components: [
    component('cards', 'repeater', { templateId: 'card', columns: 2, gap: 12, parameters: { retained: 'Instance {rootValue}', title: 'Instance title' }, rowsSource: structuredClone(source) }),
    component('static', 'repeater', { templateId: 'card', columns: 1, gap: 0, rows: [{ id: 'saved', parameters: { title: 'Saved {rootValue}' } }] }),
    component('instance', 'template', { templateId: 'card', parameters: { title: 'Single {rootValue}' } }),
  ] }];
  await saveQuery(); await save();
  await test('source schema and template-parameter mappings validate atomically on save', async () => {
    const mutations = [
      props => { props.rowsSource = null; }, props => { props.rowsSource.queryId = ''; }, props => { props.rowsSource.queryId = 'x'.repeat(129); },
      props => { props.rowsSource.rowKey = 1; }, props => { props.rowsSource.extra = true; }, props => { delete props.rowsSource.rowKey; },
      props => { props.rowsSource.parameterMap = []; }, props => { props.rowsSource.parameterMap = { missing: 'label' }; },
      props => { props.rowsSource.parameterMap.title = ''; }, props => { props.rowsSource.parameterMap.title = null; },
      props => { props.rows = [{ id: 'mixed', parameters: {} }]; }, props => { props.rows = null; }, props => { props.templateId = 'missing'; },
    ];
    for (const mutate of mutations) { const invalid = structuredClone(draft); mutate(invalid.screens[0].components[0].props); await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); }
    const wrongType = structuredClone(draft); wrongType.screens[0].components[0].type = 'template'; await api(route('/project'), { method: 'PUT', body: wrongType, status: 400 });
    assert.equal((await api(route('/project'))).revision, draft.revision);
    draft.screens[0].components[0].props.rows = []; await save();
  });
  await test('publication includes repeater read query and hides action source', async () => {
    await publish();
    assert.deepEqual((await api(route('/runtime/queries'))).map(q => q.id), ['rows']);
    const runtime = await api(route('/runtime/project')); assert.deepEqual(runtime.screens[0].components[0].props.rowsSource, source);
    assert.equal(runtime.templates[0].components[2].props.script, undefined);
  });
  await test('server resolves row parameters in screen context, preserves literal braces and ignores form values for membership', async () => {
    const response = await action('1:1', { inputs: { filter: 'Press02' } }); assert.equal(response.success, true, response.stderr);
    assert.equal(response.result.parameters.id, '1'); assert.equal(response.result.parameters.version, '1');
    assert.equal(response.result.parameters.title, 'Press01'); assert.equal(response.result.parameters.filter, 'Press01');
    assert.equal(response.result.parameters.retained, 'Instance ROOT'); assert.equal(response.result.parameters.literal, '{rootValue}');
    assert.equal(response.result.parameters.number, '1e-7'); assert.equal(response.result.inputs.filter, 'Press02');
    await action('2:1', { inputs: { filter: 'Press02' } }, 400);
    const second = await action('2:1', { parameters: { rootFilter: 'Press02' } }); assert.equal(second.result.parameters.title, 'Press02');
  });
  await test('forged row identities and client template parameters never execute', async () => {
    for (const rowId of ['', ' ', '\ufeff', 'missing', '1:2', 'x'.repeat(201), 1, null]) await action(rowId, {}, 400);
    await action('1:1', { parameters: { id: '2' } }, 400);
    await action('1:1', { instanceId: undefined }, 400);
    await action('1:1', { instanceId: 'missing' }, 404);
    await action('1:1', { popupOrigin: { screenId: 'main', componentId: 'apply', instanceId: 'cards', rowId: '1:1' } }, 400);
  });
  await test('static rows and single-template actions keep their prior parameter semantics', async () => {
    const saved = await action('saved', { instanceId: 'static' }); assert.equal(saved.result.parameters.title, 'Saved ROOT'); assert.equal(saved.result.parameters.literal, '{rootValue}');
    const single = await action(undefined, { instanceId: 'instance' }); assert.equal(single.result.parameters.title, 'Single ROOT');
    await action('missing', { instanceId: 'static' }, 404);
  });
  await test('versioned row keys reject stale actions using fresh database rows', async () => {
    await api(route('/queries/change-version'), { method: 'PUT', body: { id: 'change-version', name: 'Version fixture row', connectionId: connection.id,
      kind: 'update', parameters: [], sql: 'UPDATE production_records SET version=version+1 WHERE id=1' } });
    await api(route('/queries/change-version/execute'), { method: 'POST', body: { parameters: {} } });
    await action('1:1', {}, 400); assert.equal((await action('1:2')).result.parameters.version, '2');
  });
  await test('draft queries stay isolated, then new publication rejects the old token', async () => {
    await saveQuery(query(columns("'draft'", "'Draft only'"), []));
    assert.equal((await action('1:2')).result.parameters.title, 'Press01'); await action('draft', {}, 400);
    const old = publishedAt; await publish(); await action('draft', { publishedAt: old }, 409);
    assert.equal((await action('draft')).result.parameters.title, 'Draft only'); await action('1:2', {}, 400);
  });
  await test('captured query defaults apply when the calling context has no matching declaration', async () => {
    draft.screens[0].parameters = {}; await save(); await saveQuery(query(originalSql, [{ name: 'filter', type: 'string', defaultValue: 'Press02' }])); await publish();
    assert.equal((await action('2:1')).result.parameters.filter, 'Press02'); await action('1:2', {}, 400);
    draft.screens[0].parameters = { filter: '{rootFilter}' }; await save();
  });
  await test('malformed complete result sets reject duplicates, bad keys, nulls, unsafe numbers and missing columns', async () => {
    for (const sql of [
      `${columns()} UNION ALL ${columns()}`, columns('1'), columns('NULL'), columns("''"), columns("char(65279)"), columns(`'${'x'.repeat(201)}'`),
      columns("'one'", 'NULL'), columns("'one'", '9007199254740992'), columns("'one'", `'${'x'.repeat(4097)}'`),
      "SELECT 'one' AS row_key", `${columns()} UNION ALL ${columns("'bad'", 'NULL')}`,
    ]) { await saveQuery(query(sql, [])); await publish(); await action('one', {}, 400); }
  });
  await test('exactly 100 rows succeeds while empty or oversized results cannot authorize an action', async () => {
    const sql = "SELECT CAST(row_number() OVER () AS TEXT) AS row_key, 1 AS record_id, 1 AS row_version, 'Row' AS label, '' AS literal, '' AS query_context, 1 AS numeric FROM production_records a CROSS JOIN production_records b CROSS JOIN production_records c CROSS JOIN production_records d CROSS JOIN production_records e";
    await saveQuery(query(`${sql} LIMIT 100`, [])); await publish(); assert.equal((await action('100')).success, true);
    await saveQuery(query(`${sql} LIMIT 101`, [])); await publish(); await action('1', {}, 400);
    await saveQuery(query(`${sql} LIMIT 0`, [])); await publish(); await action('1', {}, 400);
  });
  await test('publication rejects missing/update queries and excessive worst-case expansion', async () => {
    const before = publishedAt;
    draft.screens[0].components[0].props.rowsSource.queryId = 'missing'; await save(); await publish(400);
    draft.screens[0].components[0].props.rowsSource.queryId = 'rows'; await save();
    await saveQuery({ ...query('UPDATE production_records SET quantity=0', []), kind: 'update' }); await publish(400);
    await saveQuery();
    const previous = structuredClone(draft.templates[0].components);
    draft.templates[0].components.push(...Array.from({ length: 100 }, (_, index) => component(`extra-${index}`, 'label', { text: 'Additional content' }))); await save(); await publish(400);
    assert.equal((await api(route('/runtime/project'))).publishedAt, before);
    draft.templates[0].components = previous; await save(); await publish();
  });
  await test('project packages round-trip query sources and reject malformed mappings before import', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    assert.deepEqual((await api(`/api/projects/${imported.id}/project`)).screens[0].components[0].props.rowsSource, source);
    const catalog = await api('/api/projects');
    const entries = unzip(bytes).map(entry => {
      if (entry.name !== 'project.json') return entry;
      const project = JSON.parse(entry.data); project.screens[0].components[0].props.rowsSource.parameterMap = { undeclared: 'label' };
      return { ...entry, data: Buffer.from(JSON.stringify(project)) };
    });
    await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) {
    try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); }
    catch (error) { failure ??= error; }
  }
}
if (failure) throw failure;
console.log(`${passed} query-repeater integration groups passed.`);
