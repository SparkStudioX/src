#!/usr/bin/env node
// Isolated gateway only: creates its own project, SQLite fixture and signal tag.
// Projects are archived and the signal removed; disposable fixture data is retained.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Template parameter tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const signal = `[default]TemplateParameterTests/${run}/Captured`;
const connection = { id: `typed-templates-${run}`, name: 'Typed template fixture', type: 'sqlite', database: `typed-templates-${run}.db` };
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 80 });
const echo = "result = {'parameters':parameters,'types':{key:type(value).__name__ for key,value in parameters.items()}}";
const source = { queryId: 'rows', rowKey: 'row_key', parameterMap: { count: 'count', ready: 'ready', legacy: 'legacy', caption: 'caption' } };
const rowSql = "SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, id+0.25 AS count, 'false' AS ready, id AS legacy, '{count}' AS caption FROM production_records WHERE @filter='' OR machine=@filter ORDER BY id";
let projectId, draft, publishedAt, passed = 0, signalCreated = false, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const card = project => project.templates.find(item => item.id === 'card');
const wrapper = (project, id = 'single') => project.screens[0].components.find(item => item.id === id);
const query = (id, sql, parameters = []) => ({ id, name: `Typed template ${id}`, connectionId: connection.id, sql, parameters });
const saveQuery = (id, sql, parameters = []) => api(route(`/queries/${id}`), { method: 'PUT', body: query(id, sql, parameters) });
const saveRows = (sql = rowSql) => saveQuery('rows', sql, [{ name: 'filter', type: 'string', defaultValue: '' }]);
async function save(value = draft) { draft = await api(route('/project'), { method: 'PUT', body: value }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 });
  assert.deepEqual(await api(route('/project')), draft, 'Invalid save must preserve the draft and revision.');
}
const action = ({ screen = 'main', button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${button}/action`), {
  method: 'POST', status, body: { publishedAt, instanceId: 'single', ...body },
});
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
  const project = await api('/api/projects', { method: 'POST', body: { name: `Template parameters ${run}` } }); projectId = project.id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  await api('/api/tags', { method: 'POST', body: { path: signal, kind: 'memory', dataType: 'Boolean', value: false, enabled: true } }); signalCreated = true;
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { numeric: '2.5', flag: 'true', token: '{numeric}', filter: '' };
  draft.templates = [{ id: 'card', name: 'Typed card', width: 280, height: 240,
    parameters: { count: '{numeric}', ready: '{flag}', legacy: '012', caption: '{token}' }, parameterTypes: { count: 'number', ready: 'boolean', caption: 'string' }, components: [
      component('apply', 'button', { action: 'script', script: echo }),
      component('read', 'button', { action: 'script', script: "data=system.db.runNamedQuery('typed-values', {'count':parameters['count'],'ready':parameters['ready']})\nresult={'count':data.getValueAt(0,'amount'),'ready':data.getValueAt(0,'flag'),'pythonNumber':isinstance(parameters['count'],(int,float)),'pythonBoolean':type(parameters['ready']) is bool}" }),
      component('open', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: { count: '{count}', ready: '{ready}', caption: '{caption}' } }),
      component('label', 'label', { text: 'Typed binding', bindings: { text: { expression: 'count + 1', references: { count: { kind: 'parameter', key: 'count' } } }, visible: { expression: 'ready', references: { ready: { kind: 'parameter', key: 'ready' } } } } }),
    ] }, { id: 'child', name: 'Popup child', width: 200, height: 160, parameters: { count: '{count}', ready: '{ready}', caption: '{caption}' }, parameterTypes: { count: 'number', ready: 'boolean' }, components: [component('apply', 'button', { action: 'script', script: echo })] }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 800, parameters: { local: 'Main' }, components: [
    component('single', 'template', { templateId: 'card', parameters: { count: '3.25' } }),
    component('defaults', 'template', { templateId: 'card' }),
    component('static', 'repeater', { templateId: 'card', parameters: { count: '6' }, columns: 1, gap: 0, rows: [{ id: 'saved', parameters: { count: '7', ready: 'false', caption: 'Row {token}' } }] }),
    component('query', 'repeater', { templateId: 'card', rowsSource: source, columns: 1, gap: 0 }),
  ] }, { id: 'popup', name: 'Popup', kind: 'popup', width: 500, height: 400, parameters: { count: '0', ready: 'false', caption: '' }, components: [
    component('apply', 'button', { action: 'script', script: echo }), component('child', 'template', { templateId: 'child' }),
    component('children', 'repeater', { templateId: 'child', rowsSource: { queryId: 'children', rowKey: 'row_key', parameterMap: { count: 'count', ready: 'ready', caption: 'caption' } }, columns: 1, gap: 0 }),
  ] }];
  await saveRows(); await saveQuery('typed-values', 'SELECT @count AS amount, @ready AS flag', [{ name: 'count', type: 'number' }, { name: 'ready', type: 'boolean' }]);
  await saveQuery('children', "SELECT 'child' AS row_key, @count+1 AS count, @ready AS ready, @caption AS caption", [{ name: 'count', type: 'number' }, { name: 'ready', type: 'string' }, { name: 'caption', type: 'string' }]);
  await test('saved text definitions publish type metadata and resolve native Python parameters', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.deepEqual(card(runtime).parameterTypes, card(draft).parameterTypes); assert.equal(card(runtime).parameters.count, '{numeric}');
    assert.deepEqual(card(runtime).components.find(item => item.id === 'label').props.bindings, card(draft).components.find(item => item.id === 'label').props.bindings);
    const result = await action(); assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.count, 3.25); assert.equal(result.result.parameters.ready, true); assert.equal(result.result.types.ready, 'bool');
    assert.equal(result.result.parameters.legacy, '012'); assert.equal(result.result.parameters.caption, '{numeric}');
    const defaults = await action({ instanceId: 'defaults' }); assert.equal(defaults.result.parameters.count, 2.5);
    const row = await action({ instanceId: 'static', rowId: 'saved' }); assert.equal(row.result.parameters.count, 7); assert.equal(row.result.parameters.ready, false); assert.equal(row.result.parameters.caption, 'Row {numeric}');
  });
  await test('typed parameters reach captured SQL queries without browser coercion', async () => {
    const result = await action({ button: 'read' }); assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result, { count: 3.25, ready: 1, pythonNumber: true, pythonBoolean: true });
  });
  await test('type metadata, constant values and unknown overrides reject atomically on save', async () => {
    for (const types of [null, [], { missing: 'number' }, { count: 'integer' }, { count: 1 }, { count: null }]) await reject(project => { card(project).parameterTypes = types; });
    await reject(project => { for (let index = 0; index < 65; index++) { card(project).parameters[`p${index}`] = ''; card(project).parameterTypes[`p${index}`] = 'string'; } });
    for (const value of ['', ' ', ' 1', '1 ', '1\n', '01', '+1', '.5', '1.', '0x10', 'NaN', 'Infinity', '1e400', '9007199254740992', '-9007199254740992']) {
      await reject(project => { card(project).parameters.count = value; });
      await reject(project => { wrapper(project).props.parameters.count = value; });
    }
    for (const value of ['True', 'FALSE', '0', '1', '', ' true', 'false\n']) await reject(project => { wrapper(project, 'static').props.rows[0].parameters.ready = value; });
    await reject(project => { wrapper(project).props.parameters.unknown = 'x'; });
    await reject(project => { wrapper(project, 'static').props.rows[0].parameters.unknown = 'x'; });
    for (const select of [project => project, project => project.screens[0], project => wrapper(project), project => wrapper(project).props, project => card(project).components[0]])
      await reject(project => { select(project).parameterTypes = {}; });
    await reject(project => { card(project).parameters.count = 2; });
  });
  await test('dynamic invalid context fails explicitly before Python and forged template values are refused', async () => {
    for (const numeric of ['', ' ', '0x10', '1e999', '9007199254740992']) await action({ instanceId: 'defaults', parameters: { numeric }, status: 400 });
    for (const flag of ['1', '0', 'TRUE', 'false ']) await action({ parameters: { flag }, status: 400 });
    await action({ parameters: { count: '100' }, status: 400 }); await action({ parameters: { numeric: 4 }, status: 400 });
    for (const numeric of ['-0', '-1.25', '2e-7', '1e-6', '9007199254740991']) {
      const result = await action({ instanceId: 'defaults', parameters: { numeric } }); assert.equal(result.result.parameters.count, Number(numeric) || 0);
    }
  });
  await test('query mappings are typed, literal, authoritative and override dynamic defaults', async () => {
    const result = await action({ instanceId: 'query', rowId: '1:1', parameters: { numeric: 'not a number', flag: 'not boolean' } });
    assert.equal(result.success, true, result.stderr); assert.equal(result.result.parameters.count, 1.25); assert.equal(result.result.parameters.ready, false);
    assert.equal(result.result.parameters.legacy, '1'); assert.equal(result.result.parameters.caption, '{count}');
    await action({ instanceId: 'query', rowId: '1:2', status: 400 }); await action({ instanceId: 'query', rowId: '1:1', parameters: { filter: 'Press02' }, status: 400 });
    await action({ instanceId: 'query', rowId: '1:1', parameters: { count: '8' }, status: 400 });
  });
  await test('every query row is validated, including unselected invalid typed values', async () => {
    for (const expression of ["CASE WHEN id=2 THEN 'invalid' ELSE '1.25' END AS count", "CASE WHEN id=2 THEN '9007199254740992' ELSE '1.25' END AS count", 'NULL AS count']) {
      await saveRows(rowSql.replace('id+0.25 AS count', expression)); await publish(); await action({ instanceId: 'query', rowId: '1:1', status: 400 });
    }
    for (const expression of ["CASE WHEN id=2 THEN 'TRUE' ELSE 'false' END AS ready", '0 AS ready', '1 AS ready']) {
      await saveRows(rowSql.replace("'false' AS ready", expression)); await publish(); await action({ instanceId: 'query', rowId: '1:1', status: 400 });
    }
    await saveRows(); await publish();
  });
  await test('typed popup openers stringify canonically and target templates coerce after reconstruction', async () => {
    const popupOrigin = { screenId: 'main', componentId: 'open', instanceId: 'query', rowId: '1:1' };
    const result = await action({ screen: 'popup', instanceId: undefined, popupOrigin, popupParameters: { count: '999' } });
    assert.equal(result.result.parameters.count, '1.25'); assert.equal(result.result.parameters.ready, 'false'); assert.equal(result.result.parameters.caption, '{count}');
    const child = await action({ screen: 'popup', instanceId: 'child', popupOrigin }); assert.equal(child.result.parameters.count, 1.25); assert.equal(child.result.parameters.ready, false);
    const rows = await action({ screen: 'popup', instanceId: 'children', rowId: 'child', popupOrigin }); assert.equal(rows.result.parameters.count, 2.25); assert.equal(rows.result.parameters.caption, '{count}');
    await action({ screen: 'popup', instanceId: 'children', rowId: 'child', popupOrigin: { ...popupOrigin, rowId: '1:2' }, status: 400 });
    for (const numeric of ['-0', '0.0000001', '0.000001', '1.2300']) {
      const canonical = await action({ screen: 'popup', instanceId: undefined, popupOrigin: { screenId: 'main', componentId: 'open', instanceId: 'defaults' }, parameters: { numeric } });
      assert.equal(canonical.result.parameters.count, String(Number(numeric))); assert.equal(canonical.result.parameters.ready, 'true');
    }
  });
  await test('draft types and queries are isolated until publication, including popup opener types', async () => {
    card(draft).parameterTypes.count = 'string'; await saveRows(rowSql.replace('id+0.25 AS count', 'id+2.5 AS count')); await save();
    assert.equal((await action()).result.parameters.count, 3.25); assert.equal((await action({ instanceId: 'query', rowId: '1:1' })).result.parameters.count, 1.25);
    const old = publishedAt; await publish(); await action({ publishedAt: old, status: 409 });
    assert.equal((await action()).result.parameters.count, '3.25'); assert.equal((await action({ instanceId: 'query', rowId: '1:1' })).result.parameters.count, '3.5');
    card(draft).parameterTypes.count = 'number'; await saveRows(); await save(); await publish();
  });
  await test('legacy templates without type metadata continue emitting only string parameters', async () => {
    const types = card(draft).parameterTypes; delete card(draft).parameterTypes; await save(); await publish();
    const result = await action({ instanceId: 'query', rowId: '1:1' }); assert.equal(result.result.parameters.count, '1.25'); assert.equal(result.result.parameters.ready, 'false');
    card(draft).parameterTypes = types; await save(); await publish();
  });
  await test('in-flight actions keep captured parameter types across concurrent publication', async () => {
    card(draft).components.push(component('race', 'button', { action: 'script', script: `import time\nsystem.tag.writeBlocking([${JSON.stringify(signal)}],[True])\ntime.sleep(0.5)\n${echo}` }));
    await save(); await publish(); const pending = action({ button: 'race' }); pending.catch(() => {});
    let signaled = false;
    for (let attempt = 0; attempt < 100 && !signaled; attempt++) {
      signaled = (await api('/api/tags/read', { method: 'POST', body: { paths: [signal] } }))[0].value === true;
      if (!signaled) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(signaled, true); card(draft).parameterTypes.count = 'string'; await save(); await publish();
    const result = await pending; assert.equal(result.result.parameters.count, 3.25); assert.equal((await action()).result.parameters.count, '3.25');
    card(draft).parameterTypes.count = 'number'; await save(); await publish();
  });
  await test('project packages preserve types and atomically reject invalid metadata and constant overrides', async () => {
    const bytes = await api(route('/export'), { binary: true }); const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`); assert.deepEqual(card(restored).parameterTypes, card(draft).parameterTypes);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { card(project).parameterTypes.count = 'date'; }, project => { wrapper(project).props.parameters.count = '01'; }, project => { project.screens[0].parameterTypes = {}; }, project => { wrapper(project, 'static').props.rows[0].parameters.bad = ''; }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally {
  if (signalCreated) try { await api(`/api/tag-definitions?path=${encodeURIComponent(signal)}`, { method: 'DELETE', status: 204 }); } catch (error) { failure ??= error; }
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} template-parameter integration groups passed.`);
