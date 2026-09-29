import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`let scopes=new Map(),current='',index=0;
export const begin=scope=>{current=scope;index=0;if(!scopes.has(scope))scopes.set(scope,[]);};export const clear=()=>{scopes=new Map();};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};export const useId=()=>'state-test';export const useEffect=()=>{};`);
const portalUrl = asModule('export const createPortal=children=>children;');
function loader(interactive = false) {
  const modules = new Map();
  return function url(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(interactive && dependency === 'react' ? hookUrl : interactive && dependency === 'react-dom' ? portalUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = asModule(code); modules.set(name, result); return result;
  };
}
const real = loader(), interactive = loader(true), hooks = await import(hookUrl);
const { StateDefinitionsEditor } = await import(interactive('StateDefinitionsEditor'));
const { DocumentProperties, ProjectProperties } = await import(real('DocumentProperties'));
const { PropertyBindingsEditor } = await import(interactive('PropertyBindingsEditor'));
const { checkpoint, restoreHistory } = await import(real('canvasEditing'));
const noOp = () => {}, definitions = { area: { type: 'string', value: 'A' }, quantity: { type: 'number', value: 1.25 }, permitted: { type: 'boolean', value: false } };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component, props) {
  hooks.clear(); let tree;
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Component, props)); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected state authoring control'); return node; };
  const field = label => find(node => node.props?.['aria-label'] === label);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (label, value) => { field(label).props.onChange({ target: { value } }); refresh(); };
  const click = text => { button(text).props.onClick(); refresh(); };
  refresh(); return { refresh, find, field, button, change, click, all: () => nodes(tree) };
}
let checks = 0; function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('project, screen and template property sheets expose their separate state scopes', () => {
  const screen = { id: 'main', name: 'Main', width: 1000, height: 700, components: [], state: definitions };
  const project = { id: 'p', name: 'P', revision: 1, parameters: {}, screens: [screen], sessionState: definitions };
  const screenHtml = renderToStaticMarkup(React.createElement(DocumentProperties, { document: screen, isTemplate: false, onChange: noOp, notify: noOp }));
  const projectHtml = renderToStaticMarkup(React.createElement(ProjectProperties, { project, onChange: noOp, notify: noOp }));
  const templateHtml = renderToStaticMarkup(React.createElement(DocumentProperties, { document: { ...screen, parameters: {} }, isTemplate: true, onChange: noOp, notify: noOp }));
  assert.match(screenHtml, /Screen state defaults/); assert.match(screenHtml, /Edit screen state \(3\)/);
  assert.match(projectHtml, /Session state defaults/); assert.match(projectHtml, /Edit session state \(3\)/);
  assert.match(templateHtml, /Private instance state defaults/); assert.match(templateHtml, /Edit instance state \(0\)/); assert.doesNotMatch(templateHtml, /Screen state defaults/); assert.match(screenHtml + projectHtml, /Number/); assert.match(screenHtml, /false/);
});

check('multiple typed default changes Apply as one undoable patch without mutating the original', () => {
  const original = { id: 'p', name: 'P', revision: 1, parameters: {}, screens: [], sessionState: structuredClone(definitions) };
  let project = structuredClone(original), history = { past: [], future: [] }, writes = 0;
  const ui = drive(StateDefinitionsEditor, { scope: 'session', definitions: original.sessionState, onChange: sessionState => { writes++; history = checkpoint(history, project); project = { ...project, sessionState }; } });
  ui.click('Edit session state (3)'); ui.change('Session state property 1 default value', 'Area B'); ui.change('Session state property 2 default value', '12.125'); ui.change('Session state property 3 default value', 'true');
  assert.equal(writes, 0); ui.click('Apply session state'); assert.equal(writes, 1); assert.equal(history.past.length, 1);
  assert.deepEqual(project.sessionState, { area: { type: 'string', value: 'Area B' }, quantity: { type: 'number', value: 12.125 }, permitted: { type: 'boolean', value: true } });
  assert.deepEqual(original.sessionState, definitions);
  const undone = restoreHistory(history, project, 'undo'); assert.deepEqual(undone.project, original); assert.deepEqual(restoreHistory(undone.history, undone.project, 'redo').project, project);
});

check('Cancel, Escape and unchanged Apply discard drafts; Ctrl+S applies one staged edit', () => {
  const patches = [], ui = drive(StateDefinitionsEditor, { scope: 'screen', definitions, onChange: value => patches.push(value) });
  ui.click('Edit screen state (3)'); ui.change('Screen state property 1 default value', 'discard'); ui.click('Cancel');
  ui.click('Edit screen state (3)'); assert.equal(ui.field('Screen state property 1 default value').props.value, 'A');
  ui.change('Screen state property 1 default value', 'discard twice'); ui.field('Edit screen state').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); ui.refresh();
  ui.click('Edit screen state (3)'); ui.click('Apply screen state'); assert.deepEqual(patches, []);
  ui.click('Edit screen state (3)'); ui.change('Screen state property 2 default value', '7.75'); let stopped = 0, prevented = 0;
  ui.field('Edit screen state').props.onKeyDown({ key: 's', ctrlKey: true, preventDefault() { prevented++; }, stopPropagation() { stopped++; } }); ui.refresh();
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(patches.length, 1); assert.equal(patches[0].quantity.value, 7.75);
});

check('invalid names, duplicate names, unsafe numbers, blank numbers and oversize text cannot Apply', () => {
  const patches = [], ui = drive(StateDefinitionsEditor, { scope: 'session', definitions, onChange: value => patches.push(value) });
  ui.click('Edit session state (3)');
  for (const value of ['', '1bad', 'has space', '__proto__', 'constructor', 'prototype', 'quantity', 'x'.repeat(65)]) { ui.change('Session state property 1 name', value); ui.click('Apply session state'); }
  ui.change('Session state property 1 name', 'area');
  for (const value of ['', '1e999', 'NaN', '9007199254740992']) { ui.change('Session state property 2 default value', value); ui.click('Apply session state'); }
  ui.change('Session state property 2 default value', '1.25'); ui.change('Session state property 1 default value', 'x'.repeat(4097)); ui.click('Apply session state');
  assert.deepEqual(patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
  ui.change('Session state property 1 default value', 'x'.repeat(4096)); ui.click('Apply session state'); assert.equal(patches.length, 1); assert.equal(patches[0].area.value.length, 4096);
});

check('changing a type preserves its draft and requires a valid default instead of silently coercing', () => {
  const patches = [], ui = drive(StateDefinitionsEditor, { scope: 'screen', definitions: { item: { type: 'string', value: 'abc' } }, onChange: value => patches.push(value) });
  ui.click('Edit screen state (1)'); ui.change('Screen state property 1 type', 'number'); ui.click('Apply screen state'); assert.deepEqual(patches, []);
  assert.equal(ui.field('Screen state property 1 default value').props.value, 'abc');
  ui.change('Screen state property 1 type', 'boolean'); ui.click('Apply screen state'); assert.deepEqual(patches, []);
  ui.change('Screen state property 1 default value', 'false'); ui.click('Apply screen state'); assert.deepEqual(patches, [{ item: { type: 'boolean', value: false } }]);
});

check('Add and Remove remain staged and respect the 64-property limit', () => {
  const patches = [], ui = drive(StateDefinitionsEditor, { scope: 'screen', definitions: {}, onChange: value => patches.push(value) });
  ui.click('Edit screen state (0)'); ui.click('Add property'); ui.change('Screen state property 1 name', 'draft'); ui.change('Screen state property 1 default value', 'value');
  ui.field('Remove screen state property 1').props.onClick(); ui.refresh(); ui.click('Apply screen state'); assert.deepEqual(patches, []);
  const many = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`item${index}`, { type: 'number', value: index }]));
  const limited = drive(StateDefinitionsEditor, { scope: 'session', definitions: many, onChange: value => patches.push(value) });
  limited.click('Edit session state (64)'); assert.equal(limited.button('Add property').props.disabled, true); limited.click('Add property');
  assert.equal(limited.all().filter(node => /^Session state property \d+ name$/.test(node.props?.['aria-label'] || '')).length, 64);
  limited.field('Remove session state property 2').props.onClick(); limited.refresh(); limited.click('Apply session state'); assert.equal(Object.keys(patches[0]).length, 63); assert.equal(Object.hasOwn(patches[0], 'item1'), false);
});

const component = { id: 'title', type: 'label', x: 0, y: 0, width: 200, height: 40, props: { text: 'Title' } };
function bindings(props = {}) {
  const patches = []; globalThis.document = { body: {} };
  const ui = drive(PropertyBindingsEditor, { component, components: [component], tags: [], parameters: {}, inputs: {}, state: { session: { area: 'Line A' }, screen: { quantity: 3 } }, onChange: value => patches.push(value), onGeometryChange: noOp, ...props });
  ui.field('Add Text binding').props.onClick(); ui.refresh(); ui.click('Add reference');
  return { ...ui, patches };
}

check('fx authoring chooses typed session and screen sources and previews their values', () => {
  for (const [kind, key, value] of [['sessionState', 'area', '"Line A"'], ['screenState', 'quantity', '"3"']]) {
    const ui = bindings(); ui.change('Reference 1 source', kind); assert.equal(ui.field('Reference 1 state property').props.value, key);
    ui.find(node => node.type === 'textarea' && node.props?.className === 'binding-expression').props.onChange({ target: { value: 'value' } }); ui.refresh();
    assert.ok(ui.all().some(node => node.type === 'output' && String(node.props.children) === value), `${kind}: ${ui.all().filter(node => node.type === 'output').map(node => String(node.props.children)).join(', ')}`);
    ui.click('Apply'); assert.deepEqual(ui.patches, [{ bindings: { text: { expression: 'value', references: { value: { kind, key } } } } }]);
  }
});

check('regular-screen bindings reject undeclared state; template bindings can name a containing-screen property', () => {
  const regular = bindings(); regular.change('Reference 1 source', 'sessionState'); regular.change('Reference 1 state property', 'missing'); regular.click('Apply'); assert.deepEqual(regular.patches, []);
  regular.change('Reference 1 source', 'screenState'); regular.change('Reference 1 state property', 'missing'); regular.click('Apply'); assert.deepEqual(regular.patches, []);
  const template = bindings({ state: { session: {}, screen: {} }, allowUnresolvedScreenState: true });
  template.change('Reference 1 source', 'screenState'); template.change('Reference 1 state property', 'selectedArea'); template.click('Apply');
  assert.equal(template.patches[0].bindings.text.references.value.kind, 'screenState'); assert.equal(template.patches[0].bindings.text.references.value.key, 'selectedArea');
  assert.ok(template.patches[0].bindings.text.expression);
});

console.log(`${checks} state authoring checks passed.`);
