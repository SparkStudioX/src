import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`let scopes=new Map(),current='',index=0;
export const begin=scope=>{current=scope;index=0;if(!scopes.has(scope))scopes.set(scope,[]);};export const clear=()=>{scopes=new Map();};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};
export const useId=()=>'parameter-state-authoring';export const useEffect=()=>{};`);
const portalUrl = asModule('export const createPortal=children=>children;'), modules = new Map();
function url(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' ? hookUrl : dependency === 'react-dom' ? portalUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl);
const { PropertyBindingsEditor } = await import(url('PropertyBindingsEditor'));
const { DocumentProperties, ProjectProperties, stateDefinitionReferences } = await import(url('DocumentProperties'));
const { checkpoint, restoreHistory } = await import(url('canvasEditing'));
const noOp = () => {}, binding = (kind, key, expression = 'value') => ({ expression, references: { value: { kind, key } } });
const c = (id, type, props = {}) => ({ id, type, x: 0, y: 0, width: 200, height: 80, props });
const child = { id: 'child', name: 'Child', width: 200, height: 100, parameters: { quantity: '0', title: '', enabled: 'false' }, parameterTypes: { quantity: 'number', enabled: 'boolean' }, instanceState: { childOnly: { type: 'number', value: 99 } }, components: [] };
const host = c('child-card', 'template', { templateId: child.id, parameters: { quantity: '5' } });
const state = { session: { amount: 3, caption: '{literal}', allowed: false }, screen: { amount: 4 }, instance: { amount: 8 } };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(content).join('');
function drive(Component, props) {
  hooks.clear(); let tree;
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Component, props)); }, all = () => nodes(tree);
  const find = predicate => { const node = all().find(predicate); assert.ok(node, 'Expected parameter state authoring control'); return node; };
  const field = label => find(node => node.props?.['aria-label'] === label);
  const button = label => find(node => node.type === 'button' && content(node) === label);
  const click = label => { button(label).props.onClick(); refresh(); };
  const change = (label, value) => { field(label).props.onChange({ target: { value } }); refresh(); };
  refresh(); return { refresh, all, find, field, button, click, change, content: () => content(tree) };
}
globalThis.document = { body: {} };
function editor(component = host, extra = {}) {
  const patches = [], props = { component, components: [component], tags: [], inputs: {}, parameters: {}, state, parameterTemplate: child, onChange: patch => patches.push(patch), onGeometryChange: noOp, ...extra };
  const ui = drive(PropertyBindingsEditor, props);
  const open = (name = 'quantity', bound = false) => { ui.field(`${bound ? 'Edit' : 'Add'} parameter ${name} binding`).props.onClick(); ui.refresh(); };
  const expression = value => { ui.find(node => node.type === 'textarea' && node.props.className === 'binding-expression').props.onChange({ target: { value } }); ui.refresh(); };
  const reference = (kind, key, name = 'quantity') => { open(name); ui.click('Add reference'); ui.change('Reference 1 source', kind); ui.change('Reference 1 state property', key); expression('value'); };
  return { ...ui, patches, props, open, expression, reference, output: () => content(ui.find(node => node.type === 'output')) };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('state source picker exposes only containing scopes and never offers tags for parameters', () => {
  for (const local of [false, true]) {
    const ui = editor(host, { state: local ? state : { session: state.session, screen: state.screen } }); ui.open(); ui.click('Add reference');
    assert.deepEqual(nodes(ui.field('Reference 1 source')).filter(node => node.type === 'option').map(node => node.props.value), ['custom', 'input', 'parameter', 'sessionState', 'screenState', ...(local ? ['instanceState'] : [])]);
    assert.ok(!ui.all().some(node => node.type === 'option' && node.props.value === 'childOnly'));
  }
});
check('session, screen and containing-instance state yield typed live previews and one staged Apply', () => {
  for (const [kind, amount] of [['sessionState', 3], ['screenState', 4], ['instanceState', 8]]) {
    const ui = editor(); ui.reference(kind, 'amount'); ui.expression('value * 2'); assert.equal(ui.output(), String(amount * 2)); assert.deepEqual(ui.patches, []);
    ui.click('Apply'); assert.deepEqual(ui.patches, [{ parameterBindings: { quantity: binding(kind, 'amount', 'value * 2') } }]);
  }
});
check('Boolean false and literal brace text are preserved in state parameter previews', () => {
  const bool = editor(); bool.reference('sessionState', 'allowed', 'enabled'); assert.equal(bool.output(), 'false'); bool.click('Apply'); assert.equal(bool.patches.length, 1);
  const text = editor(); text.reference('sessionState', 'caption', 'title'); assert.equal(text.output(), '"{literal}"'); text.click('Apply'); assert.equal(text.patches.length, 1);
});
check('missing session/private keys, child-private names and malformed state values cannot Apply', () => {
  for (const [kind, key, extra] of [['sessionState', 'missing', {}], ['instanceState', 'childOnly', {}], ['instanceState', 'amount', { state: { session: {}, screen: {} } }], ['sessionState', 'amount', { state: { session: { amount: {} }, screen: {} } }]]) {
    const ui = editor(host, { allowUnresolvedScreenState: true, ...extra }); ui.reference(kind, key); ui.click('Apply'); assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
  }
});
check('unresolved screen state is saveable only while authoring a shared template with explicit unavailable preview', () => {
  const deferred = editor(host, { state: { session: {}, screen: {}, instance: {} }, allowUnresolvedScreenState: true }); deferred.reference('screenState', 'callerAmount');
  assert.match(deferred.output(), /Preview unavailable.*containing screen or popup/); assert.match(deferred.content(), /Apply saves this binding/); deferred.click('Apply'); assert.equal(deferred.patches[0].parameterBindings.quantity.references.value.key, 'callerAmount');
  const root = editor(host, { state: { session: {}, screen: {} } }); root.reference('screenState', 'callerAmount'); root.click('Apply'); assert.deepEqual(root.patches, []);
});
check('deferred screen references do not excuse another invalid state source or unsupported tag', () => {
  const ui = editor(host, { state: { session: {}, screen: {}, instance: {} }, allowUnresolvedScreenState: true }); ui.reference('screenState', 'later'); ui.click('Add reference'); ui.change('Reference 2 source', 'sessionState'); ui.change('Reference 2 state property', 'missing'); ui.expression('value + value2'); ui.click('Apply'); assert.deepEqual(ui.patches, []); assert.match(ui.output(), /session.*missing/);
  const bad = { ...host, props: { ...host.props, parameterBindings: { quantity: { expression: 'value', references: { value: { kind: 'tag', path: '[default]Value' } } } } } };
  const tag = editor(bad); tag.open('quantity', true); assert.equal(nodes(tag.field('Reference 1 source')).find(node => node.type === 'option' && node.props.value === 'tag').props.disabled, true); tag.click('Apply'); assert.deepEqual(tag.patches, []);
});
check('state fx Cancel and Remove preserve authored literals and other bindings', () => {
  const original = { quantity: binding('screenState', 'amount'), title: binding('sessionState', 'caption') }, component = { ...host, props: { ...host.props, parameterBindings: original } };
  const ui = editor(component); ui.open('quantity', true); ui.expression('value + 10'); ui.click('Cancel'); assert.deepEqual(ui.patches, []); ui.open('quantity', true); assert.equal(ui.output(), '4'); ui.click('Remove binding');
  assert.deepEqual(ui.patches, [{ parameterBindings: { title: original.title } }]); assert.equal(component.props.parameters.quantity, '5');
});
check('state parameter binding changes and removal use normal project Undo and Redo', () => {
  const original = { id: 'p', name: 'P', revision: 1, parameters: {}, screens: [{ id: 'main', components: [structuredClone(host)] }] };
  let project = structuredClone(original), history = { past: [], future: [] }, changes = 0;
  const applyPatch = patch => { changes++; history = checkpoint(history, project); const component = project.screens[0].components[0]; project = { ...project, screens: [{ ...project.screens[0], components: [{ ...component, props: { ...component.props, ...patch } }] }] }; };
  const ui = editor(project.screens[0].components[0], { onChange: applyPatch });
  ui.reference('instanceState', 'amount'); assert.equal(changes, 0); ui.click('Apply'); assert.equal(changes, 1); const undone = restoreHistory(history, project, 'undo'); assert.deepEqual(undone.project, original); assert.deepEqual(restoreHistory(undone.history, undone.project, 'redo').project, project);
  const bound = structuredClone(project), remove = editor(project.screens[0].components[0], { onChange: applyPatch }); remove.open('quantity', true); remove.click('Remove binding'); assert.equal(changes, 2); assert.deepEqual(project.screens[0].components[0].props.parameterBindings, {});
  const undoRemove = restoreHistory(history, project, 'undo'); assert.deepEqual(undoRemove.project, bound); assert.deepEqual(restoreHistory(undoRemove.history, undoRemove.project, 'redo').project, project);
});

const declarations = { amount: { type: 'number', value: 2 } };
const stateHost = kind => ({ ...host, props: { ...host.props, parameterBindings: { quantity: binding(kind, 'amount') } } });
const screen = components => ({ id: 'main', name: 'Main', width: 600, height: 400, parameters: {}, state: declarations, components });
const project = (screens, templates = []) => ({ id: 'project', name: 'Project', revision: 1, parameters: {}, sessionState: declarations, screens, templates });
check('all declaration sheets reject referenced state-key rename, removal and type changes', () => {
  for (const scope of ['session', 'screen', 'instance']) for (const action of ['rename', 'remove', 'type']) {
    const current = scope === 'instance' ? { ...child, id: 'parent', instanceState: declarations, components: [stateHost('instanceState')] } : screen([stateHost(`${scope}State`)]);
    const patches = [], ui = drive(scope === 'session' ? ProjectProperties : DocumentProperties, { project: project([current]), document: current, isTemplate: scope === 'instance', templates: [child], onChange: patch => patches.push(patch), notify: noOp });
    ui.click(`Edit ${scope} state (1)`); const title = scope === 'instance' ? 'Private instance state' : `${scope[0].toUpperCase()}${scope.slice(1)} state`;
    assert.match(ui.content(), /Used by .*parameter quantity/);
    if (action === 'rename') ui.change(`${title} property 1 name`, 'renamed');
    if (action === 'remove') { ui.field(`Remove ${scope} state property 1`).props.onClick(); ui.refresh(); }
    if (action === 'type') ui.change(`${title} property 1 type`, 'string');
    ui.click(`Apply ${scope} state`); assert.deepEqual(patches, []); assert.match(content(ui.find(node => node.props?.role === 'alert')), /Update bindings/);
  }
});
check('screen dependency checks follow nested placements, handle cycles and ignore unrelated screens/templates', () => {
  const inner = { ...child, id: 'inner', name: 'Inner', components: [stateHost('screenState'), c('cycle', 'template', { templateId: 'outer' })] };
  const outer = { ...child, id: 'outer', name: 'Outer', components: [c('nested', 'repeater', { templateId: 'inner' })] };
  const unrelated = { ...child, id: 'unrelated', components: [{ ...stateHost('screenState'), props: { parameterBindings: { quantity: binding('screenState', 'other') } } }] };
  const current = screen([c('outer-card', 'template', { templateId: 'outer' })]), templates = [outer, inner, unrelated];
  const refs = stateDefinitionReferences([current], 'screen', templates); assert.equal(refs.amount.length, 1); assert.match(refs.amount[0], /Inner.*parameter quantity/); assert.equal(refs.other, undefined);
  const patches = [], ui = drive(DocumentProperties, { document: current, isTemplate: false, templates, onChange: patch => patches.push(patch), notify: noOp }); ui.click('Edit screen state (1)'); ui.change('Screen state property 1 name', 'renamed'); ui.click('Apply screen state'); assert.deepEqual(patches, []);
});
check('session dependencies include shared templates while private dependencies stop at the child boundary', () => {
  const nested = { ...child, components: [stateHost('sessionState'), { ...stateHost('instanceState'), id: 'child-private' }] };
  const parent = { ...child, id: 'parent', components: [c('nested', 'template', { templateId: nested.id })], instanceState: declarations };
  const patches = [], ui = drive(ProjectProperties, { project: project([screen([])], [nested, parent]), onChange: patch => patches.push(patch), notify: noOp }); ui.click('Edit session state (1)'); ui.change('Session state property 1 name', 'renamed'); ui.click('Apply session state'); assert.deepEqual(patches, []);
  assert.deepEqual(Object.keys(stateDefinitionReferences([parent], 'instance', [nested])), []);
  const privatePatches = [], local = drive(DocumentProperties, { document: parent, isTemplate: true, templates: [nested], onChange: patch => privatePatches.push(patch), notify: noOp }); local.click('Edit instance state (1)'); local.change('Private instance state property 1 name', 'renamed'); local.click('Apply instance state'); assert.equal(privatePatches[0].instanceState.renamed.value, 2);
});
check('valid defaults remain editable and scalar/input state dependencies remain protected', () => {
  const current = screen([stateHost('screenState'), c('label', 'label', { bindings: { text: binding('screenState', 'amount') } }), c('input', 'numberInput', { fieldKey: 'amount', stateBinding: { scope: 'screen', key: 'amount' } })]);
  assert.equal(stateDefinitionReferences([current], 'screen').amount.length, 3);
  const patches = [], ui = drive(DocumentProperties, { document: current, isTemplate: false, onChange: patch => patches.push(patch), notify: noOp }); ui.click('Edit screen state (1)'); ui.change('Screen state property 1 default value', '12'); ui.click('Apply screen state'); assert.equal(patches[0].state.amount.value, 12);
});
check('Designer passes the project template graph into document property dependency checks', () => {
  const ast = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let graph;
  function visit(node) { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'DocumentProperties') graph = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === 'templates')?.initializer.expression.getText(ast); ts.forEachChild(node, visit); } visit(ast); assert.equal(graph, 'project.templates');
});
delete globalThis.document;
console.log(`${passed}/${passed} template parameter state authoring checks passed.`);
