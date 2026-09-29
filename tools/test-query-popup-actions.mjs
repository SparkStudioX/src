#!/usr/bin/env node
// Isolated gateway only. Own projects are archived and its unique signal tag is
// removed. Test database/connection remain in the disposable data directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Query popup tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const signalPath = `[default]QueryPopupTests/${run}/SnapshotCaptured`;
async function api(path, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${raw.slice(0, 800)}`);
  return raw ? JSON.parse(raw) : null;
}
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 60 });
const connection = { id: `query-popup-${run}`, name: 'Query popup fixture', type: 'sqlite', database: `query-popup-${run}.db` };
const openerSql = `SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, id AS record_id, version AS record_version,
machine AS title, '{filter}' AS literal FROM production_records WHERE @lane='' OR machine=@lane ORDER BY id`;
const childSql = `SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, machine AS child_title, '{recordId}' AS child_literal
FROM production_records WHERE CAST(id AS TEXT)=@recordId`;
const openerSource = { queryId: 'openers', rowKey: 'row_key', parameterMap: { recordId: 'record_id', recordVersion: 'record_version', title: 'title', literal: 'literal' } };
const childSource = { queryId: 'children', rowKey: 'row_key', parameterMap: { childTitle: 'child_title', childLiteral: 'child_literal' } };
const echo = "result = {'parameters':parameters,'inputs':inputs,'code':'original'}";
const popupMappings = { recordId: '{recordId}', recordVersion: '{recordVersion}', title: '{title}', literal: '{literal}', retained: '{retained}' };
let projectId, draft, publishedAt, passed = 0, signalCreated = false;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const query = (id, sql, parameters = []) => ({ id, name: `Popup fixture ${id}`, connectionId: connection.id, sql, parameters });
const saveQuery = (id, sql, parameters = []) => api(route(`/queries/${id}`), { method: 'PUT', body: query(id, sql, parameters) });
const saveOpeners = (sql = openerSql) => saveQuery('openers', sql, [{ name: 'lane', type: 'string', defaultValue: '' }]);
const saveChildren = (sql = childSql) => saveQuery('children', sql, [{ name: 'recordId', type: 'string' }]);
async function save(value = draft) { draft = await api(route('/project'), { method: 'PUT', body: value }); }
async function publish(status = 200) {
  const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status });
  if (status === 200) publishedAt = result.publishedAt;
}
const origin = (rowId = '1:1', instanceId = 'cards') => ({ screenId: 'main', componentId: 'open', instanceId, rowId });
const action = ({ target = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/detail/components/${target}/action`), {
  method: 'POST', status, body: { publishedAt, popupOrigin: origin(), ...body } });
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
let failure;
try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Query popup actions ${run}` } }); projectId = project.id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  await api('/api/tags', { method: 'POST', body: { path: signalPath, kind: 'memory', dataType: 'Boolean', value: false, enabled: true } }); signalCreated = true;
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { filter: 'Press01', token: '{filter}' };
  draft.templates = [
    { id: 'opener', name: 'Record card', width: 280, height: 200, parameters: {
      recordId: '0', recordVersion: '0', title: 'Default {lane}', literal: '{token}', retained: 'Default {lane}',
    }, components: [component('open', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: popupMappings })] },
    { id: 'child', name: 'Related card', width: 280, height: 200, parameters: { childTitle: 'Default {title}', childLiteral: '{literal}', localContext: 'Parent {recordId}' },
      components: [component('apply', 'button', { action: 'script', script: echo })] },
  ];
  draft.screens = [
    { id: 'main', name: 'Main', width: 1200, height: 800, parameters: { lane: '{filter}' }, components: [
      component('cards', 'repeater', { templateId: 'opener', columns: 2, gap: 12, parameters: { retained: 'Instance {lane}' }, rowsSource: openerSource }),
      component('static', 'repeater', { templateId: 'opener', rows: [{ id: 'saved', parameters: { recordId: '2', recordVersion: '1', title: 'Static {lane}', retained: 'Saved {lane}' } }], columns: 1, gap: 0 }),
      component('single', 'template', { templateId: 'opener', parameters: { recordId: '3', recordVersion: '1', title: 'Single {lane}' } }),
      component('direct', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { recordId: '3', recordVersion: '1', title: 'Direct', literal: '{token}' } }),
      component('wrong-target', 'button', { action: 'openPopup', targetScreenId: 'other' }),
    ] },
    { id: 'detail', name: 'Record details', kind: 'popup', width: 800, height: 600,
      parameters: { recordId: '0', recordVersion: '0', title: 'Popup {filter}', literal: 'Popup literal', retained: 'Popup retained' }, components: [
        component('record-id-input', 'textInput', { fieldKey: 'recordId', defaultValue: 'Mutable form value' }),
        component('apply', 'button', { action: 'script', script: echo }),
        component('children', 'repeater', { templateId: 'child', columns: 1, gap: 0, rowsSource: childSource }),
        component('single-child', 'template', { templateId: 'child' }),
      ] },
    { id: 'other', name: 'Other popup', kind: 'popup', width: 300, height: 200, parameters: {}, components: [] },
  ];
  await saveOpeners(); await saveChildren(); await save(); await publish();
  await test('publication supports dynamic popup openers and captures both source queries', async () => {
    assert.deepEqual((await api(route('/runtime/queries'))).map(item => item.id).sort(), ['children', 'openers']);
    const runtime = await api(route('/runtime/project')); assert.equal(runtime.templates[0].components[0].props.action, 'openPopup');
  });
  await test('popup action derives current opener row, saved instance defaults and literal braces', async () => {
    const result = await action({ inputs: { recordId: '2' }, popupParameters: { recordId: '2', title: 'FORGED' } });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.recordId, '1'); assert.equal(result.result.parameters.recordVersion, '1');
    assert.equal(result.result.parameters.title, 'Press01'); assert.equal(result.result.parameters.literal, '{filter}');
    assert.equal(result.result.parameters.retained, 'Instance Press01'); assert.equal(result.result.inputs.recordId, '2');
    const targetTemplate = await action({ instanceId: 'single-child' });
    assert.equal(targetTemplate.result.parameters.childTitle, 'Default Press01'); assert.equal(targetTemplate.result.parameters.childLiteral, '{filter}');
  });
  await test('target popup repeater resolves only after authoritative opener context', async () => {
    const result = await action({ instanceId: 'children', rowId: '1:1' });
    assert.equal(result.success, true, result.stderr); assert.equal(result.result.parameters.recordId, '1');
    assert.equal(result.result.parameters.childTitle, 'Press01'); assert.equal(result.result.parameters.childLiteral, '{recordId}');
    assert.equal(result.result.parameters.localContext, 'Parent 1');
    await action({ instanceId: 'children', rowId: '2:1', status: 400 });
    const second = await action({ parameters: { filter: 'Press02' }, popupOrigin: origin('2:1'), instanceId: 'children', rowId: '2:1' });
    assert.equal(second.result.parameters.recordId, '2'); assert.equal(second.result.parameters.childTitle, 'Press02');
  });
  await test('forged opener context, identities and popup parameters cannot choose another record', async () => {
    for (const rowId of ['', ' ', '\ufeff', 'missing', '1:2', '2:1', 'x'.repeat(201), null, 1]) await action({ popupOrigin: origin(rowId), status: 400 });
    await action({ popupOrigin: { screenId: 'main', componentId: 'open', instanceId: 'cards' }, status: 400 });
    await action({ parameters: { recordId: '2' }, status: 400 });
    await action({ popupOrigin: { screenId: 'main', componentId: 'wrong-target' }, status: 400 });
    await action({ popupOrigin: { screenId: 'detail', componentId: 'apply' }, status: 400 });
    await action({ popupOrigin: null, status: 400 });
  });
  await test('source row changes stale both direct and nested popup actions without switching publication', async () => {
    const token = publishedAt;
    await api(route('/queries/bump'), { method: 'PUT', body: { ...query('bump', 'UPDATE production_records SET version=version+1 WHERE id=1'), kind: 'update' } });
    await api(route('/queries/bump/execute'), { method: 'POST', body: { parameters: {} } });
    await action({ status: 400 }); await action({ instanceId: 'children', rowId: '1:2', status: 400 });
    assert.equal((await api(route('/runtime/project'))).publishedAt, token);
    const result = await action({ popupOrigin: origin('1:2'), instanceId: 'children', rowId: '1:2' });
    assert.equal(result.result.parameters.recordVersion, '2');
    await action({ popupOrigin: origin('1:2'), instanceId: 'children', rowId: '1:1', status: 400 });
  });
  await test('direct, static repeater and single-template popup origins preserve existing behavior', async () => {
    const direct = await action({ popupOrigin: { screenId: 'main', componentId: 'direct' } }); assert.equal(direct.result.parameters.recordId, '3');
    const saved = await action({ popupOrigin: origin('saved', 'static') }); assert.equal(saved.result.parameters.recordId, '2'); assert.equal(saved.result.parameters.title, 'Static Press01');
    const single = await action({ popupOrigin: { screenId: 'main', componentId: 'open', instanceId: 'single' } }); assert.equal(single.result.parameters.title, 'Single Press01');
    assert.equal(single.result.parameters.literal, '{filter}');
  });
  await test('draft opener queries and mappings stay isolated until publication', async () => {
    await saveOpeners(openerSql.replace('machine AS title', "'Draft title' AS title"));
    draft.templates[0].components[0].props.parameters.title = 'Draft override'; await save();
    assert.equal((await action({ popupOrigin: origin('1:2') })).result.parameters.title, 'Press01');
    const old = publishedAt; await publish();
    await action({ publishedAt: old, popupOrigin: origin('1:2'), status: 409 });
    assert.equal((await action({ popupOrigin: origin('1:2') })).result.parameters.title, 'Draft override');
    draft.templates[0].components[0].props.parameters.title = '{title}'; await saveOpeners(); await save(); await publish();
  });
  await test('malformed entire opener row sets reject before any popup action', async () => {
    for (const sql of [
      `${openerSql.replace(' ORDER BY id', '')} UNION ALL ${openerSql.replace(' ORDER BY id', '')}`,
      openerSql.replace("'{filter}' AS literal", 'NULL AS literal'),
      openerSql.replace("CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key", 'id AS row_key'),
      "SELECT '1:2' AS row_key",
    ]) { await saveOpeners(sql); await publish(); await action({ popupOrigin: origin('1:2'), status: 400 }); }
    await saveOpeners(); await publish();
  });
  await test('a concurrent publication cannot mix popup parameters, action code or script query definitions', async () => {
    const raceScript = `import time\nsystem.tag.writeBlocking([${JSON.stringify(signalPath)}], [True])\ntime.sleep(0.5)\nmarker = system.db.runNamedQuery('snapshot-marker').getValueAt(0, 'marker')\nresult = {'parameters':parameters,'marker':marker,'code':'old'}`;
    draft.screens[1].components.push(component('race', 'button', { action: 'script', script: raceScript }));
    await saveQuery('snapshot-marker', "SELECT 'old-query' AS marker"); await save(); await publish();
    const old = publishedAt;
    const pending = action({ target: 'race', popupOrigin: origin('1:2') });
    pending.catch(() => {}); // Preserve finally cleanup if an early request fails.
    // The test signal proves GetAction and opener resolution have completed; the
    // worker then remains in flight while a new publication replaces them.
    let signaled = false;
    for (let attempt = 0; attempt < 100 && !signaled; attempt++) {
      signaled = (await api('/api/tags/read', { method: 'POST', body: { paths: [signalPath] } }))[0].value === true;
      if (!signaled) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(signaled, true, 'The in-flight action must reach its snapshot signal.');
    draft.templates[0].components[0].props.parameters.title = 'New popup title';
    draft.screens[1].components.find(item => item.id === 'race').props.script = "result = {'code':'new'}";
    await saveQuery('snapshot-marker', "SELECT 'new-query' AS marker"); await save(); await publish();
    const result = await pending; assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.code, 'old'); assert.equal(result.result.marker, 'old-query'); assert.equal(result.result.parameters.title, 'Press01');
    await action({ target: 'race', popupOrigin: origin('1:2'), publishedAt: old, status: 409 });
    assert.equal((await action({ target: 'race', popupOrigin: origin('1:2') })).result.code, 'new');
  });
  await test('popup-within-popup remains invalid even through query-backed templates', async () => {
    const old = publishedAt;
    draft.templates[1].components.push(component('nested', 'button', { action: 'openPopup', targetScreenId: 'other' })); await save(); await publish(400);
    assert.equal((await api(route('/runtime/project'))).publishedAt, old);
    draft.templates[1].components.pop(); await save(); await publish();
  });
} catch (error) { failure = error; }
finally {
  if (signalCreated) {
    try { await api(`/api/tag-definitions?path=${encodeURIComponent(signalPath)}`, { method: 'DELETE', status: 204 }); }
    catch (error) { failure ??= error; }
  }
  for (const id of created.reverse()) {
    try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); }
    catch (error) { failure ??= error; }
  }
}
if (failure) throw failure;
console.log(`${passed} query-popup integration groups passed.`);
