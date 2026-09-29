#!/usr/bin/env node
// Isolated gateway only. Creates and archives its own projects; no device writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Selection control tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const created = [], run = randomUUID().slice(0, 12);
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
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

const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 280, height: 180 });
const connection = { id: `selection-${run}`, name: 'Selection fixture', type: 'sqlite', database: `selection-${run}.db` };
const listSource = { queryId: 'list-options', valueColumn: 'value', labelColumn: 'label' };
const treeSource = { queryId: 'tree-options', valueColumn: 'value', labelColumn: 'label', parentColumn: 'parent' };
const listSql = "SELECT CAST(id AS TEXT) AS value, machine AS label, id AS record_id FROM production_records WHERE @filter='' OR machine=@filter ORDER BY id";
const treeSql = "SELECT 'root' AS value, 'Plant' AS label, NULL AS parent, 0 AS record_id UNION ALL SELECT CAST(id AS TEXT), machine, 'root', id FROM production_records WHERE version=1 AND (@filter='' OR machine=@filter)";
const staticOptions = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
const treeOptions = [{ value: 'plant', label: 'Plant' }, { value: 'a', label: 'A', parentValue: 'plant' }, { value: 'b', label: 'B', parentValue: 'plant' }];
const form = () => [
  component('list', 'list', { fieldKey: 'list', defaultValue: 'a', options: structuredClone(staticOptions) }),
  component('tree', 'treeView', { fieldKey: 'tree', defaultValue: 'a', options: structuredClone(treeOptions) }),
  component('query-list', 'list', { fieldKey: 'queryList', defaultValue: '1', optionsSource: structuredClone(listSource), selectionFields: { record: 'record_id' } }),
  component('query-tree', 'treeView', { fieldKey: 'queryTree', defaultValue: '1', optionsSource: structuredClone(treeSource), selectionFields: { record: 'record_id' } }),
  component('record', 'numberInput', { fieldKey: 'record', defaultValue: 0 }),
  component('apply', 'button', { action: 'script', script: "result = {'inputs':inputs,'parameters':parameters}" }),
];
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const props = (project, id) => project.screens[0].components.find(item => item.id === id).props;
const query = (id, sql, parameters = []) => ({ id, name: `Selection ${id}`, connectionId: connection.id, sql, parameters });
const saveQuery = (id, sql, parameters = []) => api(route(`/queries/${id}`), { method: 'PUT', body: query(id, sql, parameters) });
const saveTree = (sql = treeSql) => saveQuery('tree-options', sql, [{ name: 'filter', type: 'string', defaultValue: '' }]);
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish(status = 200) { const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status }); if (status === 200) publishedAt = result.publishedAt; }
async function reject(mutate) { const invalid = structuredClone(draft); mutate(invalid); await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++; assert.deepEqual(await api(route('/project')), draft); }
const action = ({ screen = 'main', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/apply/action`), { method: 'POST', status, body: { publishedAt, ...body } });
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Selection controls ${run}` } }); projectId = project.id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { filter: '' };
  draft.templates = [{ id: 'form', name: 'Selection form', width: 800, height: 600, parameters: {}, components: form() }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1400, height: 900, parameters: {}, components: [
    ...form(), component('legacy-select', 'select', { fieldKey: 'legacy', defaultValue: 'a', options: structuredClone(staticOptions) }),
    component('table', 'table', { queryId: 'list-options', rowKey: 'value', selectionFields: { record: 'record_id' }, pageSize: 25 }),
    component('template', 'template', { templateId: 'form' }),
    component('rows', 'repeater', { templateId: 'form', columns: 1, gap: 0, rows: [{ id: 'one', parameters: {} }] }),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'popup' }),
  ] }, { id: 'popup', name: 'Popup', kind: 'popup', width: 800, height: 600, parameters: {}, components: form() }];
  await saveQuery('list-options', listSql, [{ name: 'filter', type: 'string', defaultValue: '' }]); await saveTree();
  await test('list, flat tree and loaded table paging save and publish alongside dropdowns', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const id of ['list', 'tree', 'query-list', 'query-tree', 'table', 'legacy-select']) assert.deepEqual(props(runtime, id), props(draft, id));
    assert.deepEqual((await api(route('/runtime/queries'))).map(item => item.id).sort(), ['list-options', 'tree-options']);
    assert.equal(runtime.templates[0].components.find(item => item.id === 'apply').props.script, undefined);
  });
  await test('server membership preserves single strings and all nodes are selectable in screen/template/popup scopes', async () => {
    for (const identity of [{}, { instanceId: 'template' }, { instanceId: 'rows', rowId: 'one' }, { screen: 'popup', popupOrigin: { screenId: 'main', componentId: 'open' } }]) {
      const result = await action({ ...identity, inputs: { list: 'b', tree: 'plant', queryList: '2', queryTree: 'root', record: 2 } });
      assert.equal(result.success, true, result.stderr); assert.equal(result.result.inputs.tree, 'plant'); assert.equal(result.result.inputs.queryTree, 'root');
    }
    for (const key of ['list', 'tree', 'queryList', 'queryTree']) for (const value of [null, 1, true, [], '', 'missing', ' a ']) await action({ inputs: { [key]: value }, status: 400 });
    await action({ inputs: { undeclared: 'a' }, status: 400 }); await action({ instanceId: 'rows', rowId: 'missing', status: 404 });
  });
  await test('static options reject duplicate, orphaned, cyclic and over-depth trees atomically', async () => {
    const malformed = [[], [{ value: '', label: 'Bad' }], [{ value: 'x', label: '' }], [{ value: 'x', label: 'x'.repeat(201) }], [{ value: 'x'.repeat(4097), label: 'Long' }],
      [treeOptions[0], treeOptions[0]], [{ value: 'a', label: 'A', parentValue: 'missing' }], [{ value: 'a', label: 'A', parentValue: 'a' }],
      [{ value: 'a', label: 'A', parentValue: 'b' }, { value: 'b', label: 'B', parentValue: 'a' }], [{ value: 'a', label: 'A', parentValue: null }],
      [{ value: 'a', label: 'A', parentValue: 1 }], [{ value: 'a', label: 'A', children: [] }], Array.from({ length: 101 }, (_, i) => ({ value: `n${i}`, label: `N${i}` })),
      Array.from({ length: 17 }, (_, i) => ({ value: `n${i}`, label: `N${i}`, parentValue: i ? `n${i-1}` : '' }))];
    for (const options of malformed) await reject(project => { props(project, 'tree').options = options; });
    await reject(project => { props(project, 'list').options = [{ value: 'a', label: 'A', parentValue: '' }]; });
    await reject(project => { props(project, 'legacy-select').options[0].parentValue = ''; });
    for (const value of [null, 1, true, '', 'unknown']) await reject(project => { props(project, 'tree').defaultValue = value; });
    props(draft, 'tree').options = Array.from({ length: 16 }, (_, i) => ({ value: `n${i}`, label: `N${i}`, parentValue: i ? `n${i-1}` : '' })); props(draft, 'tree').defaultValue = 'n15';
    await save(); await publish(); assert.equal((await action()).result.inputs.tree, 'n15');
    props(draft, 'tree').options = [{ value: ' plant ', label: ' Plant ' }, { value: ' a ', label: ' A ', parentValue: ' plant ' }]; props(draft, 'tree').defaultValue = ' a ';
    await save(); await publish(); assert.equal((await action()).result.inputs.tree, ' a ');
    props(draft, 'tree').options = structuredClone(treeOptions); props(draft, 'tree').defaultValue = 'a'; await save(); await publish();
  });
  await test('query source schema and mapping targets are restricted to the containing form', async () => {
    await reject(project => { delete props(project, 'query-tree').optionsSource.parentColumn; });
    for (const parentColumn of [null, 1, '', '\ufeff', 'x'.repeat(129)]) await reject(project => { props(project, 'query-tree').optionsSource.parentColumn = parentColumn; });
    await reject(project => { props(project, 'query-list').optionsSource.parentColumn = 'parent'; });
    await reject(project => { props(project, 'legacy-select').optionsSource = structuredClone(treeSource); });
    await reject(project => { props(project, 'query-tree').selectionFields.queryTree = 'value'; });
    await reject(project => { props(project, 'query-list').selectionFields.missing = 'record_id'; });
    await reject(project => { props(project, 'tree').selectionFields = { record: 'record_id' }; });
    await reject(project => { project.templates[0].components.find(item => item.id === 'query-list').props.selectionFields.legacy = 'value'; });
    await reject(project => { props(project, 'tree').fieldKey = 'list'; });
  });
  await test('every query tree row is validated before accepting any selected member', async () => {
    const root = "SELECT '1' AS value, 'One' AS label, NULL AS parent";
    for (const sql of [root + " UNION ALL SELECT 'bad','Bad','missing'", root + " UNION ALL SELECT 'bad','Bad','bad'", root + " UNION ALL SELECT 'a','A','b' UNION ALL SELECT 'b','B','a'",
      root + " UNION ALL SELECT '1','Duplicate',NULL", root + " UNION ALL SELECT NULL,'Bad',NULL", root + " UNION ALL SELECT 'bad',NULL,NULL",
      root + " UNION ALL SELECT 9007199254740992,'Unsafe',NULL", "SELECT '1' AS value, 'One' AS label",
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<17) SELECT CAST(x AS TEXT) AS value,'Node' AS label,CASE WHEN x=1 THEN NULL ELSE CAST(x-1 AS TEXT) END AS parent FROM n"]) {
      await saveTree(sql); await publish(); await action({ status: 400 });
    }
    await saveTree("SELECT 0 AS value,'Root' AS label,NULL AS parent UNION ALL SELECT 1,'Child',0"); await publish();
    assert.equal((await action()).result.inputs.queryTree, '1');
    await saveTree("SELECT ' parent ' AS value,'Root' AS label,'' AS parent UNION ALL SELECT ' child ','Child',' parent '"); await publish();
    assert.equal((await action({ inputs: { queryTree: ' child ' } })).result.inputs.queryTree, ' child ');
    await saveTree(); await publish();
  });
  await test('empty and oversized results do not authorize a choice, while the full 500-node limit works', async () => {
    const many = count => `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count}) SELECT CAST(x AS TEXT) AS value,'Node' AS label,NULL AS parent,x AS record_id FROM n`;
    await saveTree(many(500)); await publish(); assert.equal((await action({ inputs: { queryTree: '500' } })).result.inputs.queryTree, '500');
    await saveTree(many(501)); await publish(); await action({ status: 400 });
    await saveTree("SELECT '1' AS value,'One' AS label,NULL AS parent WHERE 0"); await publish(); await action({ status: 400 });
    await saveTree(); await publish();
  });
  await test('fresh server queries reject removed selections while mutable form values cannot change query scope', async () => {
    await api(route('/queries/bump'), { method: 'PUT', body: { ...query('bump', 'UPDATE production_records SET version=2 WHERE id=1'), kind: 'update' } });
    await api(route('/queries/bump/execute'), { method: 'POST', body: { parameters: {} } }); await action({ status: 400 });
    assert.equal((await action({ inputs: { queryTree: '2' } })).success, true);
    await action({ parameters: { filter: 'Press02' }, inputs: { queryList: '1', queryTree: '2', record: 1 }, status: 400 });
    await action({ inputs: { filter: 'Press02' }, status: 400 });
    await api(route('/queries/bump'), { method: 'PUT', body: { ...query('bump', 'UPDATE production_records SET version=1 WHERE id=1'), kind: 'update' } });
    await api(route('/queries/bump/execute'), { method: 'POST', body: { parameters: {} } });
  });
  await test('publication captures selection queries and isolates draft definitions until republished', async () => {
    const token = publishedAt; await saveTree("SELECT 'other' AS value,'Other' AS label,NULL AS parent");
    assert.equal((await action()).result.inputs.queryTree, '1'); await publish(); await action({ publishedAt: token, status: 409 }); await action({ status: 400 });
    assert.equal((await action({ inputs: { queryTree: 'other' } })).result.inputs.queryTree, 'other');
    await saveTree(); await publish();
    props(draft, 'query-tree').optionsSource.queryId = 'missing'; await save(); await publish(400);
    props(draft, 'query-tree').optionsSource.queryId = 'bump'; await save(); await publish(400);
    props(draft, 'query-tree').optionsSource.queryId = 'tree-options'; await save(); await publish();
  });
  await test('table pageSize is bounded presentation metadata and never truncates loaded query results', async () => {
    for (const pageSize of [null, '25', true, 0, 101, 2.5]) await reject(project => { props(project, 'table').pageSize = pageSize; });
    await reject(project => { props(project, 'list').pageSize = 25; });
    await reject(project => { props(project, 'table').bindings = { pageSize: { expression: '25', references: {} } }; });
    for (const pageSize of [1, 100]) {
      props(draft, 'table').pageSize = pageSize; await save(); await publish();
      const all = await api(route('/runtime/queries/list-options/execute'), { method: 'POST', body: { publishedAt, parameters: {} } }); assert.equal(all.rows.length, 3);
    }
    delete props(draft, 'table').pageSize; await save(); await publish(); assert.equal(props(await api(route('/runtime/project')), 'table').pageSize, undefined);
  });
  await test('packages retain hierarchical options and paging and reject invalid imports atomically', async () => {
    const bytes = await api(route('/export'), { binary: true }); const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`); for (const id of ['list', 'tree', 'query-tree', 'table']) assert.deepEqual(props(restored, id), props(draft, id));
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project, 'tree').options[1].parentValue = 'missing'; }, project => { delete props(project, 'query-tree').optionsSource.parentColumn; }, project => { props(project, 'query-tree').selectionFields.queryTree = 'value'; }, project => { props(project, 'table').pageSize = 101; }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} selection-control integration groups passed; ${rejected} malformed save variants rejected.`);
