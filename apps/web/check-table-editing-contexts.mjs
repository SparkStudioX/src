import { createTestModuleFiles } from "./test-module-files.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

// Exercise the actual component wiring with deterministic hooks. Network/effects
// are the boundary; template resolution, bindings and edit callbacks stay real.
const require = createRequire(import.meta.url);
const moduleSource = createTestModuleFiles();
const hooksUrl = moduleSource(`
export * from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
let scopes=new Map(),values=[],index=0;
export function begin(key){if(!scopes.has(key))scopes.set(key,[]);values=scopes.get(key);index=0}
export function clear(){scopes.clear();values=[];index=0}
export function useState(initial){const at=index++,state=values;if(!(at in state))state[at]=typeof initial==='function'?initial():initial;return[state[at],next=>{state[at]=typeof next==='function'?next(state[at]):next}]}
export function useRef(initial){const at=index++;return values[at]??={current:initial}}
// These table tests have no application-state provider. Preserve each context's
// declared default; state propagation itself is covered by application-state checks.
export const createContext=value=>({defaultValue:value,Provider:({children})=>children});
export const useContext=context=>context.defaultValue;
export const useEffect=()=>{}; export const useMemo=fn=>fn(); export const memo=component=>component;
export const useId=()=>':test-control:';
`);
const queryHookUrl = moduleSource(`
let state={key:'query',rows:[],loading:false,error:''};
export const setRows=value=>{state=value};
export const useQueryRepeater=source=>source?state:{key:'none',rows:[],loading:false,error:''};
`);
const modules = new Map();
// These fixtures exercise table edit scope, not authentication or native tag
// confirmation. Unexpected native activation must fail rather than make a request.
modules.set('Auth', moduleSource('export const useAuth=()=>({permissions:{commands:false}});'));
modules.set('useTagValueAction', moduleSource('export const useTagValueAction=()=>({confirmation:null,run:async()=>{throw new Error("Unexpected native tag activation in table context checks");}});'));
function moduleUrl(name) {
  if (name.endsWith('.json')) return moduleSource('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8'));
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) =>
      `${prefix}${JSON.stringify(dependency === 'react' ? hooksUrl : dependency === './RenderBoundary' ? moduleSource('export default ({children})=>children;') : dependency === './useQueryRepeater' ? queryHookUrl
        : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const url = moduleSource(code); modules.set(name, url); return url;
}
const hooks = await import(hooksUrl), queryHook = await import(queryHookUrl);
const { default: BoundComponent } = await import(moduleUrl('BoundComponent'));
const { ComponentView } = await import(moduleUrl('Components'));
const { ProjectComponentView, instanceInputKey, actionKey, instanceRequestScope } = await import(moduleUrl('templates'));
const { queryRepeaterRows } = await import(moduleUrl('queryRepeater'));
const { default: Popup } = await import(moduleUrl('Popup'));
const { ApiError } = await import(moduleUrl('api'));
const nodeList = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodeList)];
const ofType = (tree, name) => nodeList(tree).filter(node => typeof node.type === 'function' && node.type.name === name);
const call = (fn, props, scope = fn.name) => { hooks.begin(scope); return fn(props); };
const component = (id, type = 'table', props = {}) => ({ id, type, x: 0, y: 0, width: 500, height: 300, props });
const table = component('orders', 'table', { queryId: 'orders-read', rowKey: 'id', tableEdit: {
  versionColumn: 'revision', columns: [{ key: 'quantity', type: 'number', min: 0 }],
} });
const edit = { key: 'order-7', version: 2, column: 'quantity', value: 12 };
const result = { success: true, result: { message: 'Updated' }, stdout: '', stderr: '' };
const binding = (expression, references = {}) => ({ expression, references });
const common = { tags: [], parameters: {}, preview: true, queryScope: 'runtime', onNavigate() {} };
function tableView(props, scope = 'leaf') {
  const frame = call(BoundComponent, { ...common, component: table, ...props }, `${scope}:bound`);
  const leaf = ofType(frame, 'ComponentView')[0];
  return leaf ? call(ComponentView, leaf.props, `${scope}:component`) : undefined;
}
function wrapperTables(wrapper, overrides = {}) {
  const props = { ...common, screenId: 'main', templates: [template], component: wrapper, ...overrides };
  let wrapperElement = call(ProjectComponentView, props, `wrapper-entry:${wrapper.id}`);
  for (let depth = 0; wrapperElement.type.name !== 'BoundTemplateInstance' && depth < 5; depth++) wrapperElement = call(wrapperElement.type, wrapperElement.props, `wrapper-shell:${wrapper.id}:${depth}`);
  const frame = call(wrapperElement.type, wrapperElement.props, `wrapper:${wrapper.id}`);
  const host = ofType(frame, 'TemplateInstances')[0];
  const cells = ofType(call(host.type, host.props, `host:${wrapper.id}`), 'TemplateInstanceCell');
  return cells.flatMap((cell, index) => ofType(call(cell.type, cell.props, `cell:${wrapper.id}:${index}`), 'BoundComponent')
    .filter(leaf => leaf.props.component.type === 'table')
    .map(leaf => ({ leaf, table: tableView(leaf.props, `${wrapper.id}:${index}`), cell })));
}
const template = { id: 'form', name: 'Order form', width: 600, height: 400,
  parameters: { line: '1' }, parameterTypes: { line: 'number' }, components: [
    component('note', 'textInput', { fieldKey: 'note', defaultValue: 'unchanged' }), table,
  ] };
let checks = 0;
async function check(name, run) { hooks.clear(); queryHook.setRows({ key: 'query', rows: [], loading: false, error: '' }); await run(); console.log(`PASS ${name}`); checks++; }

await check('table editing is exposed only in operator Preview, never Design, designer Preview or viewer sessions', async () => {
  const calls = [], handler = async value => { calls.push(value); return result; };
  const active = tableView({ onTableEdit: handler });
  assert.equal(active.type.name, 'QueryTable'); assert.equal(active.props.onTableEdit, handler);
  assert.deepEqual(calls, []); assert.equal(await active.props.onTableEdit(edit), result); assert.deepEqual(calls, [edit]);
  for (const gate of [{ preview: false }, { queryScope: 'designer' }, { readOnly: true }, { interactionLocked: true }, { actionBusy: true }])
    assert.equal(tableView({ onTableEdit: handler, ...gate }).props.onTableEdit, undefined, JSON.stringify(gate));
});
await check('disabled, hidden and failed-binding tables cannot forward edits', () => {
  for (const props of [{ enabled: false }, { visible: false }, { bindings: { enabled: binding('false') } },
    { bindings: { text: binding('missing', { missing: { kind: 'input', key: 'absent' } }) } },
    { bindings: { enabled: binding('permit', { permit: { kind: 'tag', path: '[default]Permit' } }) } }]) {
    const view = tableView({ component: { ...table, props: { ...table.props, ...props } }, onTableEdit: async () => result });
    assert.equal(view?.props.onTableEdit, undefined);
  }
  const tagged = { ...table, props: { ...table.props, bindings: { enabled: binding('permit', { permit: { kind: 'tag', path: '[default]Permit' } }) } } };
  const tags = [{ path: '[default]Permit', quality: 'Good', value: true }];
  assert.equal(typeof tableView({ component: tagged, tags, onTableEdit: async () => result }).props.onTableEdit, 'function');
  assert.equal(tableView({ component: tagged, tags, communicationLost: true, onTableEdit: async () => result }).props.onTableEdit, undefined);
});
await check('a direct table forwards its authored identity and the cell request unchanged after binding evaluation', async () => {
  const authored = { ...table, props: { ...table.props, text: 'Saved caption', bindings: { text: binding('"Live caption"') } } };
  const calls = []; let wrapped = call(ProjectComponentView, { ...common, component: authored, screenId: 'main', onTableEdit: async (...args) => { calls.push(args); return result; } }, 'direct-root');
  for (let depth = 0; wrapped.type.name !== 'BoundComponent' && depth < 5; depth++) wrapped = call(wrapped.type, wrapped.props, `direct-shell:${depth}`);
  const view = tableView(wrapped.props); assert.equal(view.props.title, 'Live caption');
  await view.props.onTableEdit(edit); assert.equal(calls[0][0], authored); assert.equal(calls[0][1], edit); assert.equal(calls[0].length, 2);
  assert.equal(authored.props.text, 'Saved caption');
});
await check('independent template tables forward typed parameters and their own local form values', async () => {
  const calls = [], scopedInputs = { [instanceInputKey('main', 'first')]: { note: 'First draft' }, [instanceInputKey('main', 'second')]: { note: 'Second draft' } };
  for (const [id, line] of [['first', '4'], ['second', '8']]) {
    const [view] = wrapperTables(component(id, 'template', { templateId: 'form', parameters: { line } }), { scopedInputs, onTableEdit: async (...args) => { calls.push(args); return result; } });
    assert.equal(view.table.props.parameters.line, Number(line)); await view.table.props.onTableEdit(edit);
  }
  assert.deepEqual(calls.map(args => [args[2].instanceId, args[2].rowId, args[2].parameters.line, args[2].inputs.note]),
    [['first', undefined, 4, 'First draft'], ['second', undefined, 8, 'Second draft']]);
  for (const [leaf, sent, instance] of calls) { assert.equal(leaf, table); assert.equal(sent, edit); assert.equal(instance.template, template); }
});
await check('saved repeater rows retain exact row IDs and do not share edit provenance', async () => {
  const calls = [], wrapper = component('saved-lines', 'repeater', { templateId: 'form', rows: [
    { id: 'line-a', parameters: { line: '10' } }, { id: 'line-b', parameters: { line: '20' } },
  ] });
  const views = wrapperTables(wrapper, { onTableEdit: async (...args) => { calls.push(args); return result; } });
  for (const view of views) await view.table.props.onTableEdit(edit);
  assert.deepEqual(calls.map(args => [args[2].instanceId, args[2].rowId, args[2].parameters.line]), [['saved-lines', 'line-a', 10], ['saved-lines', 'line-b', 20]]);
});
await check('query repeater provenance uses validated row keys and typed mapped values; unavailable rows expose no editors', async () => {
  const source = { queryId: 'lines-read', rowKey: 'record', parameterMap: { line: 'lineNumber' } };
  const rows = queryRepeaterRows({ columns: ['record', 'lineNumber'], rows: [{ record: 'line/7', lineNumber: 7 }, { record: 'line/8', lineNumber: 8 }] }, source, template);
  const wrapper = component('live-lines', 'repeater', { templateId: 'form', rowsSource: source }), calls = [];
  queryHook.setRows({ key: 'live', rows, loading: false, error: '' });
  for (const view of wrapperTables(wrapper, { onTableEdit: async (...args) => { calls.push(args); return result; } })) await view.table.props.onTableEdit(edit);
  assert.deepEqual(calls.map(args => [args[2].rowId, args[2].parameters.line]), [['line/7', 7], ['line/8', 8]]);
  queryHook.setRows({ key: 'live', rows: [], loading: false, error: 'Source unavailable' });
  assert.deepEqual(wrapperTables(wrapper, { onTableEdit: async () => result }), []);
});
await check('wrapper permissions and parent binding failures block every repeated table', () => {
  for (const gate of [{ enabled: false }, { visible: false }, { bindings: { enabled: binding('false') } },
    { bindings: { text: binding('missing', { missing: { kind: 'parameter', key: 'absent' } }) } }]) {
    const views = wrapperTables(component('locked', 'repeater', { templateId: 'form', rows: [{ id: 'a', parameters: {} }, { id: 'b', parameters: {} }], ...gate }), { onTableEdit: async () => result });
    assert.equal(views.length, 2); for (const view of views) assert.equal(view.table.props.onTableEdit, undefined);
  }
  for (const gate of [{ readOnly: true }, { interactionLocked: true }, { preview: false }, { queryScope: 'designer' }]) {
    const [view] = wrapperTables(component('locked', 'template', { templateId: 'form' }), { ...gate, onTableEdit: async () => result });
    assert.equal(view.table.props.onTableEdit, undefined);
  }
});

// Read the actual asynchronous closure rather than a copied request builder.
// Its surrounding UI state is injected so stale and pending requests are testable.
function extractClosure(fileName, variable, dependencies) {
  const source = fs.readFileSync(new URL(`src/${fileName}.tsx`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(`${fileName}.tsx`, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX); let expression;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === variable) expression = node.initializer; ts.forEachChild(node, visit); }
  visit(ast); assert.ok(expression, `${fileName}.${variable}`);
  const compiled = ts.transpileModule(`const callback=${expression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn callback;`)(...Object.values(dependencies));
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function operator(overrides = {}) {
  const project = { publishedAt: '2026-09-28T12:00:00Z' }, requests = [], busy = [], stale = [], events = [];
  const environment = { canOperate: true, project, screen: { id: 'main' }, actionBusyId: '',
    parameters: { plant: 'root-plant' }, currentProject: { current: project }, actionKey, instanceRequestScope, ApiError,
    api: async (...args) => { requests.push(args); return result; }, setActionBusyId: value => busy.push(value), setNextPublication: value => stale.push(value),
    window: { dispatchEvent: event => events.push(event.type) }, ...overrides };
  return { run: extractClosure('OperatorRuntime', 'editTable', environment), environment, requests, busy, stale, events };
}
await check('operator requests contain only cell intent, root parameters and published identity, including popup/template provenance', async () => {
  const run = operator(), instance = { instanceId: 'lines', rowId: 'line/7', template, parameters: { line: 7 }, inputs: { note: 'Never sent' } };
  await run.run(table, edit, instance);
  assert.deepEqual(run.requests[0], ['/runtime/screens/main/components/orders/table-edit', 'POST', { ...edit, parameters: { plant: 'root-plant' }, publishedAt: run.environment.project.publishedAt, instanceId: 'lines', rowId: 'line/7' }]);
  assert.deepEqual(run.busy, [actionKey(table.id, instance), '']);
  const popup = { screenId: 'detail/record', rootParameters: { plant: 'captured-root' }, parameters: { plant: 'resolved-popup-value' }, origin: { screenId: 'main', componentId: 'open', instanceId: 'source-lines', rowId: 'source-7' } };
  await run.run(table, edit, instance, popup);
  assert.deepEqual(run.requests[1], ['/runtime/screens/detail%2Frecord/components/orders/table-edit', 'POST', { ...edit, parameters: popup.rootParameters, publishedAt: run.environment.project.publishedAt, popupOrigin: popup.origin, instanceId: 'lines', rowId: 'line/7' }]);
  assert.equal(run.busy.length, 2, 'Popup owns its own busy state');
  assert.deepEqual(run.events, ['sparkstudio:refresh-data', 'sparkstudio:refresh-data']);
});
await check('operator denial, conflict and project replacement do not accept stale completion', async () => {
  for (const state of [{ canOperate: false }, { project: null }, { screen: undefined }, { actionBusyId: 'other' }]) {
    const run = operator(state); await assert.rejects(run.run(table, edit), /unavailable/); assert.deepEqual(run.requests, []);
  }
  const conflict = new ApiError('Changed publication', 409), failed = operator({ api: async () => { throw conflict; } });
  await assert.rejects(failed.run(table, edit), reason => reason === conflict); assert.deepEqual(failed.stale, [{ published: true }]); assert.equal(failed.busy.at(-1), '');
  const pending = deferred(), changed = operator({ api: () => pending.promise }), completion = changed.run(table, edit);
  changed.environment.currentProject.current = { publishedAt: 'new' }; pending.resolve(result);
  await assert.rejects(completion, /application changed/); assert.equal(changed.busy.length, 1); assert.deepEqual(changed.stale, []); assert.deepEqual(changed.events, []);
});
await check('row validation and unsuccessful scripts preserve their result without claiming a new publication or refreshing', async () => {
  const staleRow = new ApiError('This table row is stale. Reload the table.', 400);
  const rejected = operator({ api: async () => { throw staleRow; } });
  await assert.rejects(rejected.run(table, edit), reason => reason === staleRow);
  assert.deepEqual(rejected.stale, []); assert.deepEqual(rejected.events, []); assert.equal(rejected.busy.at(-1), '');
  const failedResult = { ...result, success: false, result: undefined, stderr: 'Update affected zero rows.' };
  const failedScript = operator({ api: async () => failedResult });
  assert.equal(await failedScript.run(table, edit), failedResult);
  assert.deepEqual(failedScript.stale, []); assert.deepEqual(failedScript.events, []); assert.equal(failedScript.busy.at(-1), '');
});

const popupScreen = { id: 'details', kind: 'popup', name: 'Details', width: 800, height: 600, components: [table] };
const popupState = { id: 'popup', screenId: 'details', rootParameters: { plant: 'root' }, parameters: { plant: 'popup-context' }, origin: { screenId: 'main', componentId: 'open' } };
const popupProject = { id: 'plant', name: 'Plant', parameters: {}, revision: 1, screens: [popupScreen], templates: [template], publishedAt: 'publication' };
function popupView(overrides = {}) {
  return call(Popup, { project: popupProject, popup: popupState, tags: [], communicationLost: false, queryScope: 'runtime',
    onClose() {}, onNavigate() {}, onExecute: async () => result, onBusyChange() {}, ...overrides }, 'popup');
}
await check('popup children retain popup display context and respect viewer, source and designer gates', async () => {
  const calls = [], child = ofType(popupView({ onTableEdit: async (...args) => { calls.push(args); return result; } }), 'ProjectComponentView')[0];
  assert.equal(child.props.parameters, popupState.parameters); assert.equal(child.props.publishedAt, popupProject.publishedAt);
  assert.equal(await child.props.onTableEdit(table, edit), result); assert.equal(calls[0][0], table); assert.equal(calls[0][1], edit);
  assert.equal(ofType(popupView({ readOnly: true, onTableEdit: async () => result }), 'ProjectComponentView')[0].props.onTableEdit, undefined);
  const invalid = { ...popupState, origin: { ...popupState.origin, instanceId: 'missing-instance' } };
  assert.equal(ofType(popupView({ popup: invalid, onTableEdit: async () => result }), 'ProjectComponentView')[0].props.onTableEdit, undefined);
  const preview = ofType(popupView({ queryScope: 'designer', onTableEdit: async () => result }), 'ProjectComponentView')[0];
  await assert.rejects(preview.props.onTableEdit(table, edit), /unavailable/);
});
await check('popup edit failures release busy state and stale/unmounted completions cannot update the popup', async () => {
  const busy = [], stale = [], pending = deferred(), conflict = new ApiError('Changed', 409);
  let forward = () => pending.promise;
  const props = { onBusyChange: value => busy.push(value), onStale: () => stale.push(true), onTableEdit: (...args) => forward(...args) };
  const child = ofType(popupView(props), 'ProjectComponentView')[0], completion = child.props.onTableEdit(table, edit);
  const whileBusy = ofType(popupView(props), 'ProjectComponentView')[0]; assert.equal(whileBusy.props.interactionLocked, true);
  await assert.rejects(whileBusy.props.onTableEdit(table, edit), /unavailable/);
  pending.reject(conflict); await assert.rejects(completion, reason => reason === conflict); assert.deepEqual(busy, [true, false]); assert.deepEqual(stale, [true]);
  const effects = [], active = { current: true }, delayed = deferred();
  const callback = extractClosure('Popup', 'editTable', { busy: '', sourceLocked: false, readOnly: false, queryScope: 'runtime',
    onTableEdit: () => delayed.promise, setBusy: value => effects.push(['busy', value]), onBusyChange: value => effects.push(['parent', value]),
    onStale: () => effects.push(['stale']), active, actionKey, ApiError });
  const late = callback(table, edit); active.current = false; delayed.reject(conflict); await assert.rejects(late, reason => reason === conflict);
  assert.deepEqual(effects, [['busy', table.id], ['parent', true]]);
});
await check('atomic batch intent travels unchanged through repeated tables, popup forwarding and operator request provenance',async()=>{
  const batch={edits:[{key:1,version:3,column:'quantity',value:0},{key:'1',version:4,column:'quantity',value:12}]};
  const calls=[],wrapper=component('batch-rows','repeater',{templateId:'form',rows:[{id:'a',parameters:{line:'1'}},{id:'b',parameters:{line:'2'}}]});
  for(const view of wrapperTables(wrapper,{onTableEdit:async(...args)=>{calls.push(args);return result;}}))await view.table.props.onTableEdit(batch);
  assert.equal(calls.length,2);assert.ok(calls.every(args=>args[1]===batch));assert.deepEqual(calls.map(args=>args[2].rowId),['a','b']);
  const forwarded=[],child=ofType(popupView({onTableEdit:async(...args)=>{forwarded.push(args);return result;}}),'ProjectComponentView')[0];await child.props.onTableEdit(table,batch,calls[1][2]);assert.equal(forwarded[0][1],batch);assert.equal(forwarded[0][2].rowId,'b');
  const run=operator();await run.run(table,batch,calls[1][2],popupState);const payload=run.requests[0][2];assert.deepEqual(payload.edits,batch.edits);assert.equal(payload.rowId,'b');assert.deepEqual(payload.popupOrigin,popupState.origin);assert.equal(Object.hasOwn(payload,'inputs'),false);assert.equal(Object.hasOwn(payload,'key'),false);
});
console.log(`${checks} table editing context checks passed.`);
