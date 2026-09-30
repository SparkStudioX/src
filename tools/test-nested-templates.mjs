#!/usr/bin/env node
// Authenticated isolated gateway only. Own projects are archived; the uniquely
// named synthetic SQLite database remains in the disposable data directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Nested template tests require the isolated gateway.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the real authenticated test-session preload.');
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
const connection = { id: `nested-forms-${run}`, name: 'Nested form test records', type: 'sqlite', database: `nested-forms-${run}.db` };
let projectId, draft, publishedAt, passed = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const component = (id, type, props = {}) => ({ id, type, props, x: 0, y: 0, width: 280, height: 80 });
const template = (id, components, parameters = {}) => ({ id, name: id, width: 600, height: 400, parameters, components });
const instance = (id, templateId, parameters = {}) => component(id, 'template', { templateId, parameters });
const repeater = (id, templateId, rows) => component(id, 'repeater', { templateId, rows, columns: 1, gap: 0 });
const row = (id, parameters = {}) => ({ id, parameters });
const step = (instanceId, rowId) => rowId === undefined ? { instanceId } : { instanceId, rowId };
const path = (outer = 'first', inner = 'inner') => [step(outer), step(inner)];
const localInputs = (quantity = 7, acknowledged = true) => ({ quantity, acknowledged });
const types = { limit: 'number', permit: 'boolean' };
const childParameters = { machine: '{machine}', limit: '{limit}', permit: '{permit}', literal: '{literal}' };
const echo = "result = {'parameters':parameters,'inputs':inputs,'limitType':type(parameters['limit']).__name__,'permitType':type(parameters['permit']).__name__,'marker':'published'}";
const tableScript = "affected=system.db.runNamedQuery('update-quantity', {'id':inputs['rowKey'],'expectedVersion':inputs['version'],'value':inputs['value']})\nif affected != 1: raise ValueError('Stale record.')\n" + echo;
const tableProps = { queryId: 'records', rowKey: 'id', tableEdit: { versionColumn: 'version', columns: [{ key: 'quantity', type: 'number', min: 0, max: 1000, integer: true }], script: tableScript } };
const querySource = { queryId: 'machines', rowKey: 'row_key', parameterMap: { machine: 'machine', limit: 'limit_value', permit: 'permit_value', literal: 'literal' } };
const querySql = "SELECT CAST(id AS TEXT)||':'||CAST(version AS TEXT) AS row_key, machine, id+10.5 AS limit_value, 'false' AS permit_value, '{defaultLimit}' AS literal FROM production_records ORDER BY id";

async function api(url, { method = 'GET', body, raw, binary = false, status = 200 } = {}) {
  const response = await fetch(new URL(url, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (url === '/api/projects/import' && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${url}: ${response.status} ${bytes.toString('utf8').slice(0, 900)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const saveQuery = (id, sql, parameters = [], kind = 'query') => api(route(`/queries/${id}`), {
  method: 'PUT', body: { id, name: id, connectionId: connection.id, sql, parameters, kind },
});
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish(status = 200) {
  const result = await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status });
  if (status === 200) publishedAt = result.publishedAt;
  return result;
}
const action = ({ screen = 'main', button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${button}/action`), {
  method: 'POST', status, body: { publishedAt, instancePath: path(), ...body },
});
const edit = ({ screen = 'main', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/table/table-edit`), {
  method: 'POST', status, body: { publishedAt, instancePath: path(), key: 1, version: 1, column: 'quantity', value: 33, ...body },
});
const origin = (instancePath = path()) => ({ screenId: 'main', componentId: 'open', instancePath });
const popupAction = (body = {}) => action({ screen: 'popup', instancePath: path('popup-card', 'popup-inner'), popupOrigin: origin(), ...body });
const findTemplate = (project, id) => project.templates.find(item => item.id === id);
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function successful(response) { assert.equal(response.success, true, response.stderr); return response.result; }
async function rejectPublication(mutate, pattern) {
  const original = structuredClone(draft), token = publishedAt;
  mutate(draft); await save();
  const result = await publish(400); assert.match(JSON.stringify(result), pattern);
  assert.equal((await api(route('/runtime/project'))).publishedAt, token, 'A rejected graph must preserve its previous publication.');
  draft = { ...original, revision: draft.revision }; await save();
}

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  projectId = (await api('/api/projects', { method: 'POST', body: { name: `Nested forms ${run}` } })).id; created.push(projectId);
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: true } })).success, true);
  await saveQuery('machines', querySql);
  await saveQuery('records', "SELECT id, version, machine, quantity FROM production_records WHERE @machine='' OR machine=@machine ORDER BY id", [{ name: 'machine', type: 'string', defaultValue: '' }]);
  await saveQuery('update-quantity', 'UPDATE production_records SET quantity=@value, version=version+1 WHERE id=@id AND version=@expectedVersion', [{ name: 'id', type: 'int' }, { name: 'expectedVersion', type: 'int' }, { name: 'value', type: 'number' }], 'update');
  await saveQuery('delete-first', 'DELETE FROM production_records WHERE id=1', [], 'update');
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { baseMachine: 'Press01', defaultLimit: '100', flag: 'true', token: '{defaultLimit}' };
  draft.sessionState = { selected: { type: 'string', value: 'original' } };
  const form = template('form', [
    component('quantity', 'spinner', { fieldKey: 'quantity', defaultValue: 5, min: 0, max: 1000, step: 1 }),
    component('acknowledged', 'checkbox', { fieldKey: 'acknowledged', defaultValue: true }),
    component('apply', 'button', { action: 'script', script: echo }),
    component('open', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: childParameters }),
    component('table', 'table', structuredClone(tableProps)),
    component('state', 'label', { text: 'State', bindings: { text: { expression: 'count', references: { count: { kind: 'screenState', key: 'count' } } } } }),
  ], childParameters); form.parameterTypes = structuredClone(types);
  const outer = template('outer', [
    component('parent-note', 'textInput', { fieldKey: 'parentNote', defaultValue: 'parent only' }),
    instance('inner', 'form', childParameters),
    instance('inner-two', 'form', { ...childParameters, machine: 'Press03', limit: '66' }),
    repeater('children', 'form', [row('child-a', { limit: '25' }), row('child-b', { limit: '35', permit: 'false' })]),
  ], { machine: '{baseMachine}', limit: '{defaultLimit}', permit: '{flag}', literal: '{token}' }); outer.parameterTypes = structuredClone(types);
  const popupForm = template('popup-form', [
    component('popup-note', 'textInput', { fieldKey: 'popupNote', defaultValue: 'fresh' }),
    component('apply', 'button', { action: 'script', script: echo }),
    component('table', 'table', structuredClone(tableProps)),
    component('close', 'button', { action: 'closePopup' }),
  ], childParameters); popupForm.parameterTypes = structuredClone(types);
  const popupOuter = template('popup-outer', [component('parent-note', 'textInput', { fieldKey: 'popupParentNote', defaultValue: 'outer popup only' }), instance('popup-inner', 'popup-form', childParameters)], childParameters);
  popupOuter.parameterTypes = structuredClone(types);
  draft.templates = [form, outer, popupForm, popupOuter,
    template('bridge-b', [instance('b', 'outer')]), template('bridge-a', [instance('a', 'bridge-b')])];
  draft.screens = [
    { id: 'main', name: 'Main', width: 1200, height: 800, parameters: { machine: '{baseMachine}', limit: '{defaultLimit}', permit: '{flag}', literal: '{token}' }, state: { count: { type: 'number', value: 0 } }, components: [
      component('root-note', 'textInput', { fieldKey: 'rootNote', defaultValue: 'screen only' }),
      instance('first', 'outer', { machine: 'Press01', limit: '11', permit: 'true' }),
      instance('second', 'outer', { machine: 'Press02', limit: '22', permit: 'false' }),
      repeater('saved', 'outer', [row('saved-a', { machine: 'Press02', limit: '41' }), row('saved-b', { machine: 'Press03', limit: '51' })]),
      component('query', 'repeater', { templateId: 'outer', rowsSource: querySource, columns: 1, gap: 0 }),
      instance('legacy', 'form', childParameters), instance('four', 'bridge-a'),
      component('wrong-popup', 'button', { action: 'openPopup', targetScreenId: 'other' }),
    ] },
    { id: 'popup', name: 'Popup', kind: 'popup', width: 800, height: 600, parameters: { machine: '', limit: '0', permit: 'false', literal: '' }, state: { count: { type: 'number', value: 0 } }, components: [instance('popup-card', 'popup-outer', childParameters)] },
    { id: 'other', name: 'Other popup', kind: 'popup', width: 300, height: 200, parameters: {}, components: [] },
  ];
  await test('nested saved composition publishes and strips every Python source', async () => {
    await save(); await publish();
    const runtime = await api(route('/runtime/project'));
    assert.equal(findTemplate(runtime, 'outer').components[1].props.templateId, 'form');
    for (const document of [...runtime.screens, ...runtime.templates]) for (const c of document.components) {
      assert.equal(c.props.script, undefined); assert.equal(c.props.tableEdit?.script, undefined);
    }
    assert.deepEqual((await api(route('/runtime/queries'))).map(q => q.id).sort(), ['machines', 'records']);
  });
  await test('identical inner IDs preserve independent outer parameters and exact input scopes', async () => {
    const first = successful(await action({ inputs: localInputs(7) }));
    const second = successful(await action({ instancePath: path('second'), inputs: localInputs(19, false) }));
    assert.equal(first.parameters.machine, 'Press01'); assert.equal(first.parameters.limit, 11); assert.equal(first.parameters.permit, true);
    assert.equal(second.parameters.machine, 'Press02'); assert.equal(second.parameters.limit, 22); assert.equal(second.parameters.permit, false);
    assert.deepEqual(first.inputs, localInputs(7)); assert.deepEqual(second.inputs, localInputs(19, false));
    assert.equal(first.permitType, 'bool'); assert.ok(['int', 'float'].includes(first.limitType));
    assert.equal(first.parameters.literal, '{defaultLimit}', 'Literal braces must survive every authored boundary.');
    assert.deepEqual(successful(await action()).inputs, localInputs(5), 'A prior action must not persist another request\'s draft.');
    const sibling = successful(await action({ instancePath: path('first', 'inner-two'), inputs: localInputs(31) }));
    assert.equal(sibling.parameters.machine, 'Press03'); assert.equal(sibling.parameters.limit, 66);
    for (const extra of [{ parentNote: 'forged' }, { rootNote: 'forged' }, { popupNote: 'forged' }]) await action({ inputs: { ...localInputs(), ...extra }, status: 400 });
    await action({ parameters: { machine: 'forged' }, status: 400 });
    await action({ sessionState: { selected: 'forged' }, status: 400 });
    await action({ script: "result='forged'", status: 400 });
  });
  await test('saved rows at outer and nested levels form distinct parameter chains', async () => {
    for (const [id, machine, limit] of [['saved-a', 'Press02', 41], ['saved-b', 'Press03', 51]]) {
      const result = successful(await action({ instancePath: [step('saved', id), step('inner')], inputs: localInputs(limit) }));
      assert.equal(result.parameters.machine, machine); assert.equal(result.parameters.limit, limit); assert.equal(result.inputs.quantity, limit);
    }
    const a = successful(await action({ instancePath: [step('first'), step('children', 'child-a')] }));
    const b = successful(await action({ instancePath: [step('first'), step('children', 'child-b')] }));
    assert.equal(a.parameters.limit, 25); assert.equal(a.parameters.permit, true);
    assert.equal(b.parameters.limit, 35); assert.equal(b.parameters.permit, false);
  });
  await test('four template levels and legacy one-level requests both execute', async () => {
    const four = successful(await action({ instancePath: [step('four'), step('a'), step('b'), step('inner')] }));
    assert.equal(four.parameters.limit, 100); assert.equal(four.parameters.permit, true);
    const legacy = successful(await action({ instancePath: undefined, instanceId: 'legacy' }));
    const modern = successful(await action({ instancePath: [step('legacy')] }));
    assert.deepEqual(legacy, modern);
  });
  await test('malformed, mixed and forged paths reject before action execution', async () => {
    for (const instancePath of [[], {}, 'first', [null], [1], [{}], [step('')], [step(' ')], [step('first', '')], [step('first', 'unexpected')],
      [{ instanceId: 'first', parameters: { limit: 999 } }], [step('first'), { instanceId: 'inner', unknown: true }], Array.from({ length: 5 }, () => step('first'))])
      await action({ instancePath, status: 400 });
    await action({ instanceId: 'first', status: 400 }); await action({ rowId: 'saved-a', status: 400 });
    await action({ instancePath: [step('missing'), step('inner')], status: 404 });
    await action({ instancePath: [step('first'), step('missing')], status: 404 });
    await action({ instancePath: [step('saved', 'missing'), step('inner')], status: 404 });
    await action({ instancePath: [step('saved'), step('inner')], status: 400 });
    await action({ instancePath: [step('root-note'), step('inner')], status: 400 });
    await action({ instancePath: [step('first')], status: 404 });
    await action({ instancePath: path().reverse(), status: 404 });
  });
  await test('deep popup origin and nested popup target reconstruct context independently', async () => {
    const result = successful(await popupAction({ inputs: { popupNote: 'inspection A' } }));
    assert.equal(result.parameters.machine, 'Press01'); assert.equal(result.parameters.limit, 11); assert.equal(result.parameters.permit, true);
    assert.deepEqual(result.inputs, { popupNote: 'inspection A' });
    const saved = successful(await popupAction({ popupOrigin: origin([step('saved', 'saved-b'), step('children', 'child-b')]) }));
    assert.equal(saved.parameters.machine, 'Press03'); assert.equal(saved.parameters.limit, 35); assert.equal(saved.parameters.permit, false);
    await popupAction({ inputs: { popupNote: 'x', quantity: 2 }, status: 400 });
    await popupAction({ popupOrigin: null, status: 400 });
    await popupAction({ popupOrigin: { ...origin(), instanceId: 'first' }, status: 400 });
    await popupAction({ popupOrigin: { ...origin(), extra: 'forged' }, status: 400 });
    await popupAction({ popupOrigin: { ...origin(), instancePath: [step('first'), step('missing')] }, status: 404 });
    await popupAction({ popupOrigin: { screenId: 'main', componentId: 'wrong-popup' }, status: 400 });
    await popupAction({ popupParameters: { machine: 'forged' }, status: 400 });
    await action({ popupOrigin: origin(), status: 400 });
  });
  await test('nested table edit uses reconstructed context and fixed server cell inputs', async () => {
    const before = (await api(route('/queries/records/execute'), { method: 'POST', body: { parameters: { machine: 'Press01' } } })).rows[0];
    const result = successful(await edit({ key: before.id, version: before.version, value: 43 }));
    assert.equal(result.parameters.machine, 'Press01'); assert.equal(result.parameters.limit, 11);
    assert.deepEqual(Object.keys(result.inputs).sort(), ['column', 'oldValue', 'row', 'rowKey', 'value', 'version']);
    assert.deepEqual(result.inputs.row, before); assert.equal(result.inputs.value, 43);
    const after = (await api(route('/queries/records/execute'), { method: 'POST', body: { parameters: { machine: 'Press01' } } })).rows[0];
    assert.equal(after.quantity, 43); assert.equal(after.version, before.version + 1);
    await edit({ key: before.id, version: before.version, status: 400 });
    await edit({ version: after.version, inputs: { parentNote: 'forged' }, status: 400 });
    await edit({ version: after.version, instanceId: 'first', status: 400 });
    await edit({ version: after.version, instancePath: [step('missing'), step('inner')], status: 404 });
    const popup = successful(await edit({ screen: 'popup', version: after.version, value: 44, instancePath: path('popup-card', 'popup-inner'), popupOrigin: origin() }));
    assert.equal(popup.parameters.limit, 11); assert.equal(popup.inputs.value, 44);
  });
  await test('root query rows resolve before descendants and deletion invalidates every dependent action', async () => {
    const current = (await api(route('/queries/records/execute'), { method: 'POST', body: { parameters: { machine: 'Press01' } } })).rows[0];
    const instancePath = [step('query', `1:${current.version}`), step('inner')];
    const result = successful(await action({ instancePath }));
    assert.equal(result.parameters.machine, 'Press01'); assert.equal(result.parameters.limit, 11.5); assert.equal(result.parameters.permit, false);
    assert.equal(result.parameters.literal, '{defaultLimit}');
    assert.equal(successful(await popupAction({ popupOrigin: origin(instancePath) })).parameters.limit, 11.5);
    await api(route('/queries/delete-first/execute'), { method: 'POST', body: { parameters: {} } });
    await action({ instancePath, status: 400 });
    await popupAction({ popupOrigin: origin(instancePath), status: 400 });
    await edit({ instancePath, version: current.version, status: 400 });
    assert.equal(successful(await action()).parameters.machine, 'Press01', 'Saved template actions do not depend on query membership.');
  });
  await test('draft graph and scripts remain isolated and old tokens fail after publication', async () => {
    const old = publishedAt;
    const wrapper = draft.screens[0].components.find(c => c.id === 'first'); wrapper.props.parameters.limit = '77';
    findTemplate(draft, 'form').components.find(c => c.id === 'apply').props.script = echo.replace("'published'", "'new-publication'");
    await save(); assert.equal(successful(await action()).parameters.limit, 11); assert.equal(successful(await action()).marker, 'published');
    await publish(); await action({ publishedAt: old, status: 409 }); await popupAction({ publishedAt: old, status: 409 }); await edit({ publishedAt: old, status: 409 });
    assert.equal(successful(await action()).parameters.limit, 77); assert.equal(successful(await action()).marker, 'new-publication');
  });
  await test('cycles and depth limits are checked for unplaced and empty-row graphs', async () => {
    await rejectPublication(project => project.templates.push(template('cycle', [instance('self', 'cycle')])), /cycle/i);
    await rejectPublication(project => project.templates.push(template('cycle-a', [instance('b', 'cycle-b')]), template('cycle-b', [repeater('a', 'cycle-a', [])])), /cycle/i);
    await rejectPublication(project => project.templates.push(template('fifth', [instance('bridge', 'bridge-a')])), /4.*level/i);
    await rejectPublication(project => project.templates.push(template('fifth', [repeater('empty', 'bridge-a', [])])), /4.*level/i);
    await rejectPublication(project => { findTemplate(project, 'outer').components.push(instance('missing', 'not-defined')); }, /reference|existing/i);
  });
  await test('nested popup openers and missing descendant state reject publication', async () => {
    await rejectPublication(project => { findTemplate(project, 'popup-form').components.push(component('open-again', 'button', { action: 'openPopup', targetScreenId: 'other' })); }, /popup.*popup/i);
    await rejectPublication(project => { delete project.screens[0].state; }, /screen state/i);
  });
  await test('multiplicative expansion includes nested row descendants and is global across screens', async () => {
    const original = structuredClone(draft);
    draft.parameters = {}; draft.templates = [template('tiny', [component('label', 'label', { text: 'one' })]),
      template('batch', [repeater('children', 'tiny', Array.from({ length: 99 }, (_, i) => row(`r${i}`)))])];
    // Each outer row contributes one nested repeater + 99 leaves = 100.
    // 99 outer rows + root container + 99 root labels = exactly 10,000.
    draft.screens = [{ id: 'budget', name: 'Budget', width: 1200, height: 800, components: [
      repeater('outer', 'batch', Array.from({ length: 99 }, (_, i) => row(`b${i}`))),
      ...Array.from({ length: 99 }, (_, i) => component(`label-${i}`, 'label', { text: 'padding' })),
    ] }];
    await save(); await publish();
    await rejectPublication(project => project.screens.push({ id: 'extra', name: 'Extra', width: 300, height: 200, components: [component('label', 'label', { text: 'one too many' })] }), /10,000|10000/i);
    // Root query sources reserve 100 rows even when the live result is empty.
    await rejectPublication(project => { project.screens[0].components[0] = component('outer', 'repeater', { templateId: 'batch', rowsSource: { queryId: 'machines', rowKey: 'row_key', parameterMap: {} }, columns: 1, gap: 0 }); }, /10,000|10000/i);
    draft = { ...original, revision: draft.revision }; await save(); await publish();
  });
  await test('portable package roundtrip retains nested definitions, state, typed parameters and scripts', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.templates, draft.templates); assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.sessionState, draft.sessionState);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const publication = await api(`/api/projects/${imported.id}/project/publish`, { method: 'POST', body: { revision: restored.revision } });
    const response = await api(`/api/projects/${imported.id}/runtime/screens/main/components/apply/action`, { method: 'POST', body: { publishedAt: publication.publishedAt, instancePath: path(), inputs: localInputs(18) } });
    assert.equal(successful(response).parameters.limit, 77); assert.deepEqual(response.result.inputs, localInputs(18));
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} nested template integration groups passed.`);
