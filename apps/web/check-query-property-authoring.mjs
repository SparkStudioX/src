import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`export {Children,cloneElement,isValidElement} from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)};
export const createContext=initial=>{const context={value:initial};context.Provider=({value,children})=>{context.value=value;return children;};return context;};
export const useContext=context=>context.value;
let scopes=new Map(),current='',index=0,alive=new Set(),pending=[];
export const beginRender=()=>{alive=new Set();pending=[];};
export const begin=scope=>{current=scope;index=0;alive.add(scope);if(!scopes.has(scope))scopes.set(scope,[]);};
export const clear=()=>{for(const values of scopes.values())for(const value of values)value?.cleanup?.();scopes=new Map();pending=[];};
export const finish=()=>{for(const [scope,values]of scopes)if(!alive.has(scope)){for(const value of values)value?.cleanup?.();scopes.delete(scope);}for(const work of pending)work();pending=[];};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};
export const useId=()=>'query-authoring';export const useEffect=(callback,deps)=>{const values=scopes.get(current),at=index++,old=values[at];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){const next={deps};values[at]=next;pending.push(()=>{old?.cleanup?.();next.cleanup=callback();});}};`);
const apiUrl = asModule('let nextId=0; export const id=prefix=>prefix+ ++nextId; export const api=(...args)=>globalThis.__queryRequest(...args); export const resolvePath=(value,parameters)=>value.replace(/\\{([^{}]+)\\}/g,(all,key)=>Object.hasOwn(parameters,key)?String(parameters[key]):all); export const tagByPath=(tags,path)=>tags.find(tag=>tag.path===path); export const displayValue=value=>String(value ?? "");');
const portalUrl = asModule('export const createPortal=children=>children;'), modules = new Map();
function url(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === './api' ? apiUrl : dependency === 'react' ? hookUrl : dependency === 'react-dom' ? portalUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl);
const { PropertyBindingsEditor } = await import(url('PropertyBindingsEditor'));
const { DocumentProperties, ProjectProperties, stateDefinitionReferences } = await import(url('DocumentProperties'));
const { checkpoint, restoreHistory } = await import(url('canvasEditing'));
const noOp = () => {}, binding = (kind, key) => ({ expression: 'value', references: { value: { kind, key } } });
const c = (id, type, props = {}) => ({ id, type, x: 0, y: 0, width: 200, height: 80, props });
const label = c('label', 'label', { text: 'Saved', customProperties: { limit: { type: 'number', value: 3 } } });
const query = { id: 'summary', name: 'Summary', kind: 'query', connectionId: 'sample', sql: 'SELECT total', parameters: [{ name: 'amount', type: 'number', defaultValue: 2 }] };
const state = { session: { amount: 3 }, screen: { amount: 4 }, instance: { amount: 5 } };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(content).join('');
function drive(Component, props) {
  hooks.clear(); let tree;
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { hooks.beginRender(); tree = expand(React.createElement(Component, props)); hooks.finish(); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected query authoring control'); return node; };
  const field = label => find(node => node.props?.['aria-label'] === label), button = label => find(node => node.type === 'button' && content(node) === label);
  const click = label => { button(label).props.onClick(); refresh(); }, change = (label, value) => { field(label).props.onChange({ target: { value } }); refresh(); };
  refresh(); return { refresh, find, field, button, click, change, all: () => nodes(tree), content: () => content(tree) };
}
globalThis.document = { body: {} }; globalThis.__queryRequest = async () => { throw Error('Unexpected query execution'); };
function editor(component = label, extra = {}) {
  const patches = [], props = { component, components: [component, c('amount', 'numberInput', { fieldKey: 'amount', defaultValue: 6 }), c('secret', 'passwordInput', { fieldKey: 'secret' })], tags: [], inputs: { amount: 6, secret: 'excluded' }, parameters: { amount: 7 }, state, queries: [query, { ...query, id: 'update', name: 'Update', kind: 'update' }], onChange: patch => patches.push(patch), onGeometryChange: noOp, ...extra };
  const ui = drive(PropertyBindingsEditor, props);
  const open = (target = 'Text') => { ui.field(`${component.props.queryBindings?.[target.toLowerCase()] || component.props.bindings?.[target.toLowerCase()] ? 'Edit' : 'Add'} ${target} binding`).props.onClick(); ui.refresh(); if (!ui.all().some(node => node.props?.['aria-label'] === 'Property named query')) ui.change('Property binding source', 'query'); };
  const choose = () => { ui.change('Property named query', 'summary'); ui.change('Property query result column', 'total'); };
  return { ...ui, patches, props, open, choose, output: () => content(ui.find(node => node.type === 'output')) };
}
const saved = (extra = {}) => ({ ...label, props: { ...label.props, queryBindings: { text: { queryId: 'summary', column: 'total', ...extra } } } });
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await check('query mode offers saved read queries, exactly-one-row columns and no automatic execution', () => {
  const ui = editor(); ui.open(); ui.choose();
  assert.deepEqual(nodes(ui.field('Property named query')).filter(node => node.type === 'option').map(node => node.props.value), ['', 'summary']);
  assert.match(ui.content(), /exactly one row/); assert.ok(!ui.all().some(node => /row (number|index)/i.test(node.props?.['aria-label'] || ''))); assert.equal(ui.patches.length, 0);
});
await check('switching modes commits once, clears the opposite binding and supports Undo/Redo', () => {
  const original = { id: 'p', revision: 1, screens: [{ id: 's', components: [{ ...label, props: { ...label.props, bindings: { text: { expression: "'Old'", references: {} }, visible: { expression: 'true', references: {} } } } }] }] };
  let project = structuredClone(original), history = { past: [], future: [] }, calls = 0;
  const ui = editor(project.screens[0].components[0], { onChange: patch => { calls++; history = checkpoint(history, project); const item = project.screens[0].components[0]; project = { ...project, screens: [{ ...project.screens[0], components: [{ ...item, props: { ...item.props, ...patch } }] }] }; } });
  ui.open(); ui.choose(); ui.click('Apply'); assert.equal(calls, 1); assert.equal(project.screens[0].components[0].props.bindings.text, undefined); assert.ok(project.screens[0].components[0].props.bindings.visible);
  const undo = restoreHistory(history, project, 'undo'); assert.deepEqual(undo.project, original); assert.deepEqual(restoreHistory(undo.history, undo.project, 'redo').project, project);
  const inverse = editor(saved()); inverse.open(); inverse.change('Property binding source', 'binding'); inverse.click('Apply'); assert.deepEqual(inverse.patches[0].queryBindings, {}); assert.equal(inverse.patches[0].bindings.text.expression, '"Saved"');
});
await check('Cancel discards draft changes and Remove preserves static values and unrelated bindings', () => {
  const component = saved(), ui = editor(component); ui.open(); ui.change('Property query result column', 'other'); ui.click('Cancel'); assert.deepEqual(ui.patches, []); ui.open(); assert.equal(ui.field('Property query result column').props.value, 'total'); ui.click('Remove binding'); assert.deepEqual(ui.patches, [{ queryBindings: {} }]); assert.equal(component.props.text, 'Saved');
});
await check('polling requires an integer bounded interval and result transforms use only value', () => {
  const ui = editor(); ui.open(); ui.choose(); ui.change('Property query refresh', 'poll');
  for (const value of ['999', '1000.5', '3600001', '']) { ui.change('Property query polling interval', value); ui.click('Apply'); assert.deepEqual(ui.patches, []); }
  ui.change('Property query polling interval', '1000'); ui.change('Property query result expression', 'other + 1'); ui.click('Apply'); assert.deepEqual(ui.patches, []);
  ui.change('Property query result expression', 'value * 0.02'); ui.click('Apply'); assert.equal(ui.patches[0].queryBindings.text.refresh.intervalMs, 1000); assert.equal(ui.patches[0].queryBindings.text.transform, 'value * 0.02');
});
await check('all declared mappings can use containing typed sources but never tags or password inputs', () => {
  for (const kind of ['parameter', 'custom', 'input', 'sessionState', 'screenState', 'instanceState']) {
    const ui = editor(); ui.open(); ui.choose(); ui.change('Query parameter amount value source', 'expression'); ui.change('Query parameter amount expression', 'value'); ui.click('Add reference'); ui.change('Query parameter amount Reference 1 source', kind);
    const choices = nodes(ui.field('Query parameter amount Reference 1 source')).filter(node => node.type === 'option').map(node => node.props.value); assert.ok(!choices.includes('tag'));
    if (kind === 'input') { ui.change('Query parameter amount Reference 1 input key', 'amount'); assert.ok(!ui.all().some(node => node.type === 'option' && node.props.value === 'secret')); }
    if (kind === 'parameter') ui.change('Query parameter amount Reference 1 parameter name', 'amount');
    if (kind === 'custom') ui.change('Query parameter amount Reference 1 custom property', 'limit');
    if (kind.endsWith('State')) ui.change('Query parameter amount Reference 1 state property', 'amount');
    ui.click('Apply'); assert.equal(ui.patches.length, 1, kind); assert.equal(ui.patches[0].queryBindings.text.parameters.amount.references.value.kind, kind);
  }
});
await check('duplicate mapping aliases and removed declarations remain visible and cannot Apply', () => {
  const ui = editor(saved({ parameters: { removed: { expression: '1', references: {} } } })); ui.open(); assert.match(ui.content(), /Not declared by this query/); ui.click('Apply'); assert.deepEqual(ui.patches, []); ui.change('Query parameter removed value source', 'default'); ui.change('Query parameter amount value source', 'expression'); ui.click('Add reference'); ui.click('Add reference'); ui.change('Query parameter amount Reference 2 name', 'value'); ui.click('Apply'); assert.match(ui.output(), /unique/); assert.deepEqual(ui.patches, []);
});
await check('default parameters are omitted and a missing/update query is not silently replaced', () => {
  const ui = editor(); ui.open(); ui.choose(); ui.click('Apply'); assert.equal(ui.patches[0].queryBindings.text.parameters, undefined);
  for (const queryId of ['missing', 'update']) { const unavailable = editor(saved({ queryId })); unavailable.open(); assert.equal(unavailable.field('Property named query').props.value, queryId); unavailable.click('Apply'); assert.deepEqual(unavailable.patches, []); }
});
await check('shared-template unresolved screen mappings defer preview; missing private state still blocks Apply', () => {
  const mapping = { amount: binding('screenState', 'caller') }, ui = editor(saved({ parameters: mapping }), { state: { session: {}, screen: {}, instance: {} }, allowUnresolvedScreenState: true }); ui.open(); assert.match(ui.output(), /containing screen/); assert.equal(ui.button('Run preview').props.disabled, true); ui.click('Apply'); assert.equal(ui.patches.length, 1);
  const root = editor(saved({ parameters: mapping }), { state: { session: {}, screen: {} } }); root.open(); root.click('Apply'); assert.deepEqual(root.patches, []);
  const privateMissing = editor(saved({ parameters: { amount: binding('instanceState', 'childOnly') } })); privateMissing.open(); privateMissing.click('Apply'); assert.deepEqual(privateMissing.patches, []);
});
const flush = async ui => { await new Promise(resolve => setTimeout(resolve, 0)); ui.refresh(); };
await check('explicit preview validates typed transformed output and sends only mapped query parameters', async () => {
  const requests = []; globalThis.__queryRequest = async (path, method, body, signal) => { requests.push({ path, method, body, signal }); return path === '/queries' ? [query] : { columns: ['total'], rows: [{ total: 250 }], durationMs: 1 }; };
  const ui = editor(saved({ transform: 'value * 0.02', parameters: { amount: binding('screenState', 'amount') } })); ui.open(); assert.equal(requests.length, 0); ui.click('Run preview'); await flush(ui); assert.match(ui.output(), /string · "5"/); assert.deepEqual(requests[1].body.parameters, { amount: 4 }); assert.ok(requests[1].signal instanceof AbortSignal); assert.equal(ui.patches.length, 0);
});
await check('preview reports zero/multiple/null/wrong-target results without committing or inventing a value', async () => {
  for (const rows of [[], [{ total: 1 }, { total: 2 }], [{ total: null }], [{ total: { nested: 1 } }]]) {
    globalThis.__queryRequest = async path => path === '/queries' ? [query] : { columns: ['total'], rows }; const ui = editor(saved()); ui.open(); ui.click('Run preview'); await flush(ui); assert.match(ui.output(), /exactly one row|non-null/); assert.deepEqual(ui.patches, []);
  }
  globalThis.__queryRequest = async path => path === '/queries' ? [query] : { columns: ['total'], rows: [{ total: 1 }] };
  const ui = editor({ ...label, props: { ...label.props, queryBindings: { enabled: { queryId: 'summary', column: 'total' } } } }); ui.open('Enabled'); ui.click('Run preview'); await flush(ui); assert.match(ui.output(), /Boolean|true or false/i); assert.deepEqual(ui.patches, []);
  ui.change('Property query result expression', 'value > 0'); ui.click('Run preview'); await flush(ui); assert.equal(ui.output(), 'boolean · true');
});
await check('changed draft and containing context abort requests and ignore late success/error; closing aborts too', async () => {
  for (const change of ['draft', 'context', 'close']) for (const failure of [false, true]) {
    let complete, signal; globalThis.__queryRequest = async (path, method, body, incoming) => path === '/queries' ? [query] : (signal = incoming, await new Promise((resolve, reject) => { complete = () => failure ? reject(Error('old result failed')) : resolve({ columns: ['total'], rows: [{ total: 'obsolete' }] }); }));
    const ui = editor(saved({ parameters: { amount: binding('screenState', 'amount') } })); ui.open(); ui.click('Run preview'); await flush(ui); assert.ok(complete);
    if (change === 'draft') ui.change('Property query result column', 'newColumn');
    if (change === 'context') { ui.props.state = { ...state, screen: { amount: 22 } }; ui.refresh(); }
    if (change === 'close') ui.click('Cancel');
    assert.equal(signal.aborted, true); complete(); await flush(ui); assert.doesNotMatch(ui.content(), /obsolete|old result failed/); assert.deepEqual(ui.patches, []);
  }
});
await check('live tag ticks and unrelated form edits preserve pending and completed explicit previews', async () => {
  let complete, signal; const requests = [];
  globalThis.__queryRequest = async (path, method, body, incoming) => { requests.push(path); return path === '/queries' ? [query] : (signal = incoming, await new Promise(resolve => { complete = () => resolve({ columns: ['total'], rows: [{ total: 123 }] }); })); };
  const ui = editor(saved({ parameters: { amount: binding('screenState', 'amount') } }), { tags: [{ path: '[default]Unrelated', value: 1, timestamp: 'before' }] });
  ui.open(); ui.click('Run preview'); await flush(ui); assert.ok(complete); assert.match(ui.output(), /Running query/);
  ui.props.tags = [{ path: '[default]Unrelated', value: 2, timestamp: 'during' }]; ui.props.inputs = { ...ui.props.inputs, amount: 99, other: 'changed' }; ui.props.state = { ...state, session: { amount: 99 }, screen: { ...state.screen, unrelated: 12 } }; ui.refresh();
  assert.equal(signal.aborted, false); assert.match(ui.output(), /Running query/); assert.equal(requests.length, 2);
  complete(); await flush(ui); assert.equal(ui.output(), 'string · "123"');
  ui.props.tags = [{ path: '[default]Unrelated', value: 3, timestamp: 'after' }]; ui.props.state = { ...ui.props.state, instance: { amount: 99 } }; ui.refresh();
  assert.equal(ui.output(), 'string · "123"'); assert.equal(signal.aborted, false); assert.equal(requests.length, 2); assert.deepEqual(ui.patches, []);
});
await check('query mappings protect nested screen/session/private declarations and custom key/type removal', () => {
  const inner = { id: 'inner', name: 'Inner', width: 300, height: 100, parameters: {}, components: [saved({ parameters: { amount: binding('screenState', 'amount') } })] };
  const document = { id: 'screen', name: 'Main', width: 600, height: 400, state: { amount: { type: 'number', value: 1 } }, components: [c('nested', 'template', { templateId: inner.id })] };
  assert.match(stateDefinitionReferences([document], 'screen', [inner]).amount[0], /query text \/ amount/);
  const patches = [], sheet = drive(DocumentProperties, { document, templates: [inner], isTemplate: false, onChange: patch => patches.push(patch), notify: noOp }); sheet.click('Edit screen state (1)'); sheet.change('Screen state property 1 name', 'changed'); sheet.click('Apply screen state'); assert.deepEqual(patches, []);
  for (const scope of ['session', 'instance']) assert.ok(stateDefinitionReferences([{ ...inner, components: [saved({ parameters: { amount: binding(`${scope}State`, 'amount') } })] }], scope).amount);
  const custom = editor(saved({ parameters: { amount: binding('custom', 'limit') } })); assert.equal(custom.field('Remove custom property limit').props.disabled, true); custom.field('Edit custom property limit').props.onClick(); custom.refresh(); assert.equal(custom.field('Custom property name').props.disabled, true); custom.change('Custom property type', 'string'); custom.click('Apply'); assert.deepEqual(custom.patches, []); assert.match(custom.content(), /before changing its type/);
});
await check('Designer supplies the named-query catalog and template parameter fx remains expression-only', () => {
  const ast = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let catalog;
  function visit(node) { if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'PropertyBindingsEditor') catalog = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === 'queries')?.initializer.expression.getText(ast); ts.forEachChild(node, visit); } visit(ast); assert.equal(catalog, 'queries');
  const template = { id: 't', name: 'T', width: 100, height: 100, parameters: { text: '' }, components: [] }, ui = editor(c('wrapper', 'template', { templateId: 't' }), { parameterTemplate: template }); ui.field('Add parameter text binding').props.onClick(); ui.refresh(); assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Property binding source'));
});
await check('dataset fx opens the styled binding dialog and isolates title-bar shortcuts while native cancel discards drafts', () => {
  globalThis.__queryRequest = async () => { throw Error('Opening dataset authoring must not execute a query.'); };
  const ui = editor(c('plot', 'chart'));
  const open = () => { ui.field('Edit dataset binding').props.onClick(); ui.refresh(); };
  open(); const dialog = ui.find(node => node.type === 'dialog'); assert.equal(dialog.props.className, 'property-binding-dialog');
  assert.ok(nodes(dialog).some(node => node.props?.className === 'binding-dialog-heading'));
  assert.ok(nodes(dialog).some(node => node.props?.className === 'binding-dialog-body'));
  assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Property query result column'));
  ui.change('Property named query', 'summary'); assert.deepEqual(ui.patches, []);
  for (const key of ['z', 'y', 's']) { let stopped = false, prevented = false; dialog.props.onKeyDown({ key, ctrlKey: true, target: ui.field('Close dataset binding'), stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } }); assert.equal(stopped, true); assert.equal(prevented, false); }
  let canceled = false; dialog.props.onCancel({ preventDefault() { canceled = true; } }); ui.refresh(); assert.equal(canceled, true); assert.deepEqual(ui.patches, []); assert.ok(!ui.all().some(node => node.type === 'dialog'));
  open(); assert.equal(ui.field('Property named query').props.value, ''); ui.change('Property named query', 'summary'); ui.click('Apply');
  assert.deepEqual(ui.patches, [{ dataSource: { queryId: 'summary' } }]); assert.ok(!ui.all().some(node => node.type === 'dialog'));
});
await check('closing the dataset title bar aborts its explicit preview and late completion cannot revive the dialog', async () => {
  let complete, signal;
  globalThis.__queryRequest = async (path, method, body, incoming) => path === '/queries' ? [query] : (signal = incoming, await new Promise(resolve => { complete = () => resolve({ columns: ['total'], rows: [{ total: 999 }] }); }));
  const ui = editor(c('plot', 'chart', { dataSource: { queryId: 'summary' } })); ui.field('Edit dataset binding').props.onClick(); ui.refresh(); ui.click('Run preview'); await flush(ui); assert.ok(complete);
  ui.field('Close dataset binding').props.onClick(); ui.refresh(); assert.equal(signal.aborted, true); complete(); await flush(ui);
  assert.deepEqual(ui.patches, []); assert.ok(!ui.all().some(node => node.type === 'dialog')); assert.doesNotMatch(ui.content(), /999/);
  ui.field('Edit dataset binding').props.onClick(); ui.refresh(); ui.click('Remove binding'); assert.deepEqual(ui.patches, [{ dataSource: undefined }]);
});
await check('chart rows open nested targets, seed typed JSON and preserve saved values when binding', () => {
  const chart = c('chart', 'chart', { chart: { kind: 'line', xKey: 'time', series: [{ key: 'value', label: 'Value' }] }, data: { columns: ['time', 'value'], rows: [{ time: 1, value: 2 }] } });
  for (const [label, target] of [['Chart type', 'chart.kind'], ['Series', 'chart.series'], ['Saved dataset', 'data']]) {
    const ui = editor(chart); ui.field('Add ' + label + ' binding').props.onClick(); ui.refresh();
    const expression = ui.find(node => node.type === 'textarea' && node.props.className === 'binding-expression');
    if (target !== 'chart.kind') assert.deepEqual(JSON.parse(JSON.parse(expression.props.value)), target === 'data' ? chart.props.data : chart.props.chart.series);
    ui.click('Apply'); assert.equal(ui.patches.length, 1); assert.ok(ui.patches[0].bindings[target]);
    assert.equal(ui.patches[0].chart, undefined); assert.equal(ui.patches[0].data, undefined);
  }
});
await check('custom property values have real fx editing, query switching and removal', () => {
  const ui = editor(); ui.field('Add limit binding').props.onClick(); ui.refresh(); ui.click('Apply');
  assert.equal(ui.patches[0].bindings['customProperties.limit.value'].expression, '3');
  const queryCustom = editor(); queryCustom.field('Add limit binding').props.onClick(); queryCustom.refresh(); queryCustom.change('Property binding source', 'query'); queryCustom.choose(); queryCustom.click('Apply');
  assert.equal(queryCustom.patches[0].queryBindings['customProperties.limit.value'].queryId, 'summary');
  const bound = { ...label, props: { ...label.props, bindings: { 'customProperties.limit.value': { expression: '7', references: {} } } } };
  const saved = editor(bound), row = saved.find(node => node.props?.['data-property'] === 'customProperties.limit.value');
  assert.equal(nodes(row).find(node => node.type === 'fieldset').props.disabled, true);
  assert.ok(nodes(row).some(node => node.type === 'button' && node.props['aria-label'] === 'Edit limit binding'));
  saved.field('Edit limit binding').props.onClick(); saved.refresh(); saved.click('Remove binding');
  assert.deepEqual(saved.patches, [{ bindings: {} }]); assert.equal(bound.props.customProperties.limit.value, 3);
});
await check('chart static Apply keeps dynamic bindings and nested runtime rule controls share the binding dialog', async () => {
  const { defaultChartProps } = await import(url('chartModel'));
  const original = c('plot', 'chart', { ...defaultChartProps(), bindings: { 'chart.showLegend': { expression: 'false', references: {} } } });
  const ui = editor(original); ui.click('Apply chart'); assert.equal(ui.patches.length, 1);
  assert.ok(original.props.bindings['chart.showLegend']); assert.equal(ui.patches[0].bindings, undefined);
  const { InputValidationEditor } = await import(url('InputValidationEditor'));
  const input = c('text', 'formattedInput', { formatMask: 'AA-####', validation: { required: false } });
  const rules = editor(input, { children: React.createElement(InputValidationEditor, { component: input, onChange: noOp }) });
  rules.click('Edit rules'); rules.field('Add Required binding').props.onClick(); rules.refresh(); rules.click('Apply');
  assert.equal(rules.patches[0].bindings['validation.required'].expression, 'false');
});
await check('query previews invalidate on transitive custom inputs, state, parameters and definition changes', async () => {
  for (const source of ['input', 'screenState', 'sessionState', 'parameter', 'definition']) {
    for (const completed of [false, true]) {
      let complete, signal; globalThis.__queryRequest = async (path, method, body, incoming) => path === '/queries' ? [query] : (signal = incoming, await new Promise(resolve => { complete = () => resolve({ columns: ['total'], rows: [{ total: 123 }] }); }));
      const component = saved({ parameters: { amount: binding('custom', 'limit') } });
      component.props.bindings = { 'customProperties.limit.value': binding(source === 'definition' ? 'input' : source, 'amount') };
      const ui = editor(component); ui.open(); ui.click('Run preview'); await flush(ui); assert.ok(complete);
      if (completed) { complete(); await flush(ui); assert.match(ui.output(), /123/); }
      if (source === 'input') ui.props.inputs = { ...ui.props.inputs, amount: 8 };
      else if (source === 'parameter') ui.props.parameters = { amount: 8 };
      else if (source.endsWith('State')) { const scope = source === 'screenState' ? 'screen' : 'session'; ui.props.state = { ...state, [scope]: { amount: 8 } }; }
      else ui.props.component = { ...component, props: { ...component.props, bindings: { 'customProperties.limit.value': { ...binding('input', 'amount'), expression: 'value + 1' } } } };
      ui.refresh(); assert.equal(signal.aborted, true); assert.match(ui.output(), /Choose Run preview/);
      if (!completed) { complete(); await flush(ui); assert.doesNotMatch(ui.output(), /123/); }
    }
  }
});
await check('query and template previews defer missing screen state behind custom aliases', () => {
  const component = saved({ parameters: { amount: binding('custom', 'limit') } });
  component.props.bindings = { 'customProperties.limit.value': binding('screenState', 'caller') };
  const ui = editor(component, { allowUnresolvedScreenState: true, state: { session: {}, screen: {} } });
  ui.open(); assert.match(ui.output(), /containing screen/); assert.equal(ui.button('Run preview').props.disabled, true); ui.click('Apply'); assert.equal(ui.patches.length, 1);
  const wrapper = c('wrapper', 'template', { templateId: 't', customProperties: component.props.customProperties, bindings: component.props.bindings, parameterBindings: { amount: binding('custom', 'limit') } });
  const form = editor(wrapper, { allowUnresolvedScreenState: true, state: { session: {}, screen: {} }, parameterTemplate: { id: 't', name: 'T', width: 200, height: 100, parameters: { amount: '1' }, parameterTypes: { amount: 'number' }, components: [] } });
  form.field('Edit parameter amount binding').props.onClick(); form.refresh(); assert.match(form.output(), /containing screen.*caller/); form.click('Apply'); assert.equal(form.patches.length, 1);
});
await check('a chained custom query sample change invalidates the explicit downstream preview', async () => {
  const { QueryPropertyBindingEditor } = await import(url('QueryPropertyBindingEditor'));
  const component = saved({ parameters: { amount: binding('custom', 'limit') } });
  component.props.queryBindings['customProperties.limit.value'] = { queryId: 'upstream', column: 'value' };
  const upstream = { ...query, id: 'upstream' }, props = { component, target: 'text', queries: [query, upstream], context: { components: [component], parameters: {}, inputs: {}, tags: [], queryProperties: { label: { 'customProperties.limit.value': { status: 'ready', value: 1 } } } }, onApply: noOp, onCancel: noOp };
  let complete, signal; globalThis.__queryRequest = async (path, method, body, incoming) => path === '/queries' ? [query, upstream] : path.includes('/upstream/') ? { columns: ['value'], rows: [{ value: 1 }] } : (signal = incoming, await new Promise(resolve => { complete = () => resolve({ columns: ['total'], rows: [{ total: 123 }] }); }));
  const ui = drive(QueryPropertyBindingEditor, props); ui.click('Run preview'); await flush(ui); assert.ok(complete);
  props.context = { ...props.context, queryProperties: { label: { 'customProperties.limit.value': { status: 'ready', value: 2 } } } }; ui.refresh(); assert.equal(signal.aborted, true);
  complete(); await flush(ui); assert.doesNotMatch(ui.content(), /123/);
});
await check('explicit preview resolves and deduplicates query-backed custom aliases without persisted runtime samples', async () => {
  const component = saved({ parameters: { amount: { expression: 'value + duplicate', references: { value: { kind: 'custom', key: 'limit' }, duplicate: { kind: 'custom', key: 'limit' } } } } });
  component.props.customProperties = { ...component.props.customProperties, seed: { type: 'number', value: 0 } };
  component.props.queryBindings['customProperties.limit.value'] = { queryId: 'upstream', column: 'total', parameters: { amount: binding('custom', 'seed') } };
  component.props.queryBindings['customProperties.seed.value'] = { queryId: 'seed', column: 'total', parameters: { amount: binding('screenState', 'amount') } };
  const catalog = [query, { ...query, id: 'upstream' }, { ...query, id: 'seed' }], requests = [];
  globalThis.__queryRequest = async (path, method, body, signal) => { requests.push({ path, body, signal }); return path === '/queries' ? catalog : { columns: ['total'], rows: [{ total: body.parameters.amount + 1 }] }; };
  const ui = editor(component, { queries: catalog }); ui.open(); assert.equal(requests.length, 0); ui.click('Run preview'); await flush(ui);
  const executions = requests.filter(request => request.body);
  assert.deepEqual(executions.map(request => request.path), ['/queries/seed/execute', '/queries/upstream/execute', '/queries/summary/execute']);
  assert.deepEqual(executions.map(request => request.body.parameters), [{ amount: 4 }, { amount: 5 }, { amount: 12 }]);
  assert.equal(ui.output(), 'string · "13"'); assert.deepEqual(ui.patches, []); assert.equal(ui.props.queryProperties, undefined);
});
await check('canceling a prerequisite preview prevents the destination query and discards late results', async () => {
  const component = saved({ parameters: { amount: binding('custom', 'limit') } });
  component.props.queryBindings['customProperties.limit.value'] = { queryId: 'upstream', column: 'total' };
  const catalog = [query, { ...query, id: 'upstream' }], requests = []; let complete, signal;
  globalThis.__queryRequest = async (path, method, body, incoming) => { requests.push(path); return path === '/queries' ? catalog : (signal = incoming, await new Promise(resolve => { complete = () => resolve({ columns: ['total'], rows: [{ total: 99 }] }); })); };
  const ui = editor(component, { queries: catalog }); ui.open(); ui.click('Run preview'); await flush(ui); assert.ok(complete);
  ui.click('Cancel'); assert.equal(signal.aborted, true); complete(); await flush(ui);
  assert.ok(!requests.includes('/queries/summary/execute')); assert.deepEqual(ui.patches, []); assert.ok(!ui.all().some(node => node.type === 'dialog'));
});
hooks.clear(); delete globalThis.document; delete globalThis.__queryRequest;
console.log(`${passed}/${passed} query property authoring checks passed.`);
