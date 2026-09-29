import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = name => fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const modules = new Map();
const moduleUrl = name => {
  if (modules.has(name)) return modules.get(name);
  const result = asModule(compile(source(name)).replace(/from "\.\/([^"\n]+)"/g, (_, dependency) => `from ${JSON.stringify(moduleUrl(dependency))}`));
  modules.set(name, result); return result;
};
const load = name => import(moduleUrl(name));
const { createPopup, screenParameters, popupQuerySource, popupSourceStatus } = await load('popupModel');
const { templateParameters, queryTemplateParameters, instanceInputKey, projectInputContext } = await load('templateModel');
const { resolveInputs } = await load('inputs');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const root = { machine: 'RootMachine', title: 'Root title', literal: '{title}' };
const host = { id: 'host', name: 'Host', width: 1200, height: 760, parameters: { machine: 'HostMachine' }, components: [] };
const target = { id: 'detail', name: '{title}', kind: 'popup', width: 600, height: 400, parameters: { machine: '{machine}', title: 'Default title', note: '' }, components: [{ id: 'input', type: 'numberInput', props: { fieldKey: 'setpoint', defaultValue: 5 } }] };
const project = { id: 'p', name: 'Project', revision: 1, parameters: root, screens: [host, target], templates: [] };
const button = { id: 'open', type: 'button', props: { action: 'openPopup', targetScreenId: 'detail', parameters: { machine: '{machine}', title: '{title}', note: '{literal}' } } };
const rowTemplate = { id: 'row', name: 'Row', width: 300, height: 100, parameters: { machine: 'TemplateMachine', title: 'Template title' }, components: [button] };
const rowContext = templateParameters(rowTemplate, screenParameters(host, root), {}, { machine: 'RowMachine', title: 'Row title' });
const instance = { instanceId: 'orders', rowId: 'order2', template: rowTemplate, parameters: rowContext, inputs: {} };
check('regular screen defaults shadow root without changing root', () => { assert.equal(screenParameters(host, root).machine, 'HostMachine'); assert.equal(root.machine, 'RootMachine'); });
check('popup defaults resolve once against root', () => { const popup = createPopup(project, host, { ...button, props: { ...button.props, parameters: {} } }, root, screenParameters(host, root)); assert.equal(popup.parameters.machine, 'RootMachine'); assert.equal(popup.parameters.title, 'Default title'); });
check('row caller overrides popup defaults', () => { const popup = createPopup(project, host, button, root, rowContext, instance); assert.equal(popup.parameters.machine, 'RowMachine'); assert.equal(popup.parameters.title, 'Row title'); });
check('placeholder-bearing caller values do not recursively expand', () => { const popup = createPopup(project, host, button, root, rowContext, instance); assert.equal(popup.parameters.note, '{title}'); });
check('popup origin preserves published screen, leaf and row identity', () => assert.deepEqual(createPopup(project, host, button, root, rowContext, instance).origin, { screenId: 'host', componentId: 'open', instanceId: 'orders', rowId: 'order2' }));
check('root request context remains separate from popup overrides', () => { const popup = createPopup(project, host, button, root, rowContext, instance); assert.deepEqual(popup.rootParameters, root); assert.notEqual(popup.parameters.machine, popup.rootParameters.machine); });
check('opening captures a snapshot rather than retaining mutable root reference', () => { const context = { ...root }; const popup = createPopup(project, host, button, context, rowContext, instance); context.machine = 'Changed'; assert.equal(popup.rootParameters.machine, 'RootMachine'); });
check('each open has a fresh session ID for local form state', () => assert.notEqual(createPopup(project, host, button, root, rowContext).id, createPopup(project, host, button, root, rowContext).id));
check('nested popup opens are rejected', () => assert.throws(() => createPopup(project, target, button, root, rowContext), /cannot open another popup/));
check('regular screen cannot be opened as popup', () => assert.throws(() => createPopup(project, host, { ...button, props: { ...button.props, targetScreenId: 'host' } }, root, rowContext), /Choose a popup screen/));
check('undeclared popup overrides are rejected', () => assert.throws(() => createPopup(project, host, { ...button, props: { ...button.props, parameters: { unexpected: 'value' } } }, root, rowContext), /does not declare/));
check('popup local edits do not mutate retained parent form edits', () => { const parent = { [instanceInputKey('host','orders','order2')]: { setpoint: 72 } }; const before = structuredClone(parent); const popupEdits = { setpoint: 19 }; assert.equal(resolveInputs(target, [], {}, popupEdits).setpoint, 19); assert.deepEqual(parent, before); assert.equal(resolveInputs(target, [], {}, {}).setpoint, 5); });
check('screen parameter authoring changes invalidate preview context', () => { const changed = structuredClone(project); changed.screens[0].parameters.machine = 'Other'; assert.notEqual(projectInputContext(project), projectInputContext(changed)); });
const queryHost = { ...host, components: [{ id: 'orders', type: 'repeater', props: { templateId: rowTemplate.id, rowsSource: { queryId: 'records', rowKey: 'row_key', parameterMap: { machine: 'machine', title: 'title' } } } }] };
const queryProject = { ...project, screens: [queryHost, target], templates: [rowTemplate] };
const queryRow = { id: 'order2:v1', parameters: { machine: 'DatabaseMachine', title: '{title}' } };
const queryCaller = queryTemplateParameters(rowTemplate, screenParameters(queryHost, root), {}, queryRow.parameters);
const queryInstance = { ...instance, rowId: queryRow.id, parameters: queryCaller };
const dynamicPopup = () => createPopup(queryProject, queryHost, button, root, queryCaller, queryInstance);
check('query popup records exact opener identity and captures literal caller values separately from root', () => {
  const popup = dynamicPopup();
  assert.deepEqual(popup.origin, { screenId: 'host', componentId: 'open', instanceId: 'orders', rowId: 'order2:v1' });
  assert.equal(popup.parameters.title, '{title}'); assert.equal(popup.querySourceParameters.title, '{title}');
  assert.deepEqual(popup.rootParameters, root); assert.notEqual(popup.querySourceParameters, queryCaller);
});
check('popup source resolves queries against root and opener-screen context, never row overrides', () => {
  const popup = dynamicPopup(), definition = popupQuerySource(queryProject, popup);
  assert.equal(definition.source.queryId, 'records'); assert.equal(definition.parameters.machine, 'HostMachine');
  assert.notEqual(definition.parameters.machine, popup.querySourceParameters.machine);
});
check('unchanged verified query rows stay usable during a background refresh', () => {
  const popup = dynamicPopup(), definition = popupQuerySource(queryProject, popup);
  for (const loading of [false, true]) assert.deepEqual(popupSourceStatus(popup, definition, { rows: [queryRow], loading, error: '' }), { ready: true, stale: false, message: '' });
});
check('unverified, failed and removed source records cannot enable popup actions', () => {
  const popup = dynamicPopup(), definition = popupQuerySource(queryProject, popup);
  assert.deepEqual(popupSourceStatus(popup, definition, { rows: [], loading: true, error: '' }), { ready: false, stale: false, message: 'Checking the source record…' });
  const missing = popupSourceStatus(popup, definition, { rows: [], loading: false, error: '' });
  assert.equal(missing.ready, false); assert.equal(missing.stale, true);
  const failed = popupSourceStatus(popup, definition, { rows: [], loading: false, error: 'Old publication' });
  assert.equal(failed.ready, false); assert.equal(failed.stale, false); assert.match(failed.message, /Old publication/);
});
check('same row ID with changed mapped parameters invalidates the captured form', () => {
  const popup = dynamicPopup(), definition = popupQuerySource(queryProject, popup);
  const changed = popupSourceStatus(popup, definition, { rows: [{ ...queryRow, parameters: { ...queryRow.parameters, machine: 'OtherMachine' } }], loading: false, error: '' });
  assert.equal(changed.ready, false); assert.equal(changed.stale, true);
});
check('missing source definition and changed opener context invalidate a query popup', () => {
  const popup = dynamicPopup(), removed = { ...queryProject, screens: [target] };
  assert.ok(popupQuerySource(removed, popup).error);
  const changed = structuredClone(queryProject); changed.screens[0].parameters.extra = 'new';
  const status = popupSourceStatus(popup, popupQuerySource(changed, popup), { rows: [queryRow], loading: false, error: '' });
  assert.equal(status.stale, true);
});
check('static popups require no dynamic row verification', () => {
  const staticHost = { ...host, components: [{ id: 'orders', type: 'repeater', props: { templateId: rowTemplate.id, rows: [{ id: instance.rowId, parameters: {} }] } }] };
  const staticProject = { ...project, templates: [rowTemplate], screens: [staticHost, target] };
  const popup = createPopup(staticProject, staticHost, button, root, rowContext, instance);
  assert.equal(popup.querySourceParameters, undefined);
  assert.deepEqual(popupSourceStatus(popup, popupQuerySource(staticProject, popup), { rows: [], loading: false, error: 'Unused query error' }), { ready: true, stale: false, message: '' });
  const changed = structuredClone(staticProject); changed.templates[0].parameterTypes = { title: 'string' };
  assert.equal(popupSourceStatus(popup, popupQuerySource(changed, popup), { rows: [], loading: false, error: '' }).stale, true);
});
check('popup interpolation stringifies typed values while query snapshots retain scalar types', () => {
  const typed = { ...rowTemplate, parameters: { machine: '12', title: 'false' }, parameterTypes: { machine: 'number', title: 'boolean' } };
  const typedProject = { ...queryProject, templates: [typed] }, typedRow = { id: queryRow.id, parameters: { machine: 12, title: false } };
  const caller = queryTemplateParameters(typed, screenParameters(queryHost, root), {}, typedRow.parameters);
  const popup = createPopup(typedProject, queryHost, button, root, caller, { ...queryInstance, template: typed, parameters: caller });
  assert.equal(popup.parameters.machine, '12'); assert.equal(popup.parameters.title, 'false');
  assert.equal(popup.querySourceParameters.machine, 12); assert.equal(popup.querySourceParameters.title, false);
  assert.equal(popupSourceStatus(popup, popupQuerySource(typedProject, popup), { rows: [typedRow], loading: false, error: '' }).ready, true);
  const changed = structuredClone(typedProject); changed.templates[0].parameterTypes.title = 'string';
  assert.equal(popupSourceStatus(popup, popupQuerySource(changed, popup), { rows: [typedRow], loading: false, error: '' }).stale, true);
  const invalid = popupSourceStatus(popup, popupQuerySource(typedProject, popup), { rows: [{ ...typedRow, parameters: { machine: 'bad', title: false } }], loading: false, error: '' });
  assert.equal(invalid.stale, true); assert.match(invalid.message, /machine/);
});
console.log(`${checks}/${checks} popup model checks passed.`);
