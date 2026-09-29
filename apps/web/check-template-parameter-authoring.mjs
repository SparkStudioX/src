import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = asModule(`let scopes = new Map(), current = '', index = 0;
export const begin = scope => {current=scope; index=0; if(!scopes.has(scope)) scopes.set(scope,[]);};
export const clear = () => {scopes=new Map();};
export const useState = initial => {const values=scopes.get(current), at=index++; if(!(at in values)) values[at]=typeof initial==='function'?initial():initial; return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef = initial => {const values=scopes.get(current), at=index++; return values[at]??={current:initial};};
export const useId = () => 'parameter-test'; export const useEffect = () => {};`);
function loader(interactive = false) {
  const modules = new Map();
  return function moduleUrl(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
    assert.ok(file, name);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(interactive && dependency === 'react' ? hookUrl : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const url = asModule(output); modules.set(name, url); return url;
  };
}
const staticModules = loader();
const { DocumentProperties, ProjectProperties } = await import(staticModules('DocumentProperties'));
const { TemplateParameterOverrides } = await import(staticModules('TemplateParametersEditor'));
const { TemplateParametersEditor: InteractiveDefinitions, TemplateParameterOverrides: InteractiveOverrides } = await import(loader(true)('TemplateParametersEditor'));
const hooks = await import(hookUrl);
const template = { id: 'motor', name: 'Motor', width: 400, height: 200, parameters: { caption: 'Motor {line}', threshold: '10', permitted: 'false' }, parameterTypes: { threshold: 'number', permitted: 'boolean' }, components: [] };
const parentParameters = { line: 'A', limit: '25', permission: 'true' };
const noOp = () => {};
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component, props) {
  hooks.clear();
  let tree;
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}:${index}`));
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Component, props)); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected parameter control'); return node; };
  const label = text => find(node => node.props?.['aria-label'] === text);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (text, value) => { label(text).props.onChange({ target: { value } }); refresh(); };
  refresh(); return { refresh, find, label, button, change, all: () => nodes(tree) };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('typed authoring belongs to template documents; screen and project defaults remain text', () => {
  const html = renderToStaticMarkup(React.createElement(DocumentProperties, { document: template, isTemplate: true, parentParameters, onChange: noOp, notify: noOp }));
  assert.match(html, /Number · 10/); assert.match(html, /Boolean · False/); assert.match(html, /Motor A/);
  assert.match(html, /Edit template parameter threshold/);
  const screen = { ...template, parameterTypes: undefined };
  const screenHtml = renderToStaticMarkup(React.createElement(DocumentProperties, { document: screen, isTemplate: false, parentParameters, onChange: noOp, notify: noOp }));
  const projectHtml = renderToStaticMarkup(React.createElement(ProjectProperties, { project: { id: 'app', name: 'App', revision: 1, parameters: { flag: 'false' }, screens: [screen] }, onChange: noOp, notify: noOp }));
  assert.match(screenHtml, /Saved text defaults/); assert.match(projectHtml, /Saved text defaults/);
  assert.doesNotMatch(screenHtml + projectHtml, /Edit template parameter|Template parameter type/);
});

check('type conversion with an invalid default requires an explicit valid replacement before one atomic Apply', () => {
  const patches = [], errors = [];
  const original = { ...structuredClone(template), parameters: { caption: 'abc' }, parameterTypes: undefined };
  const ui = drive(InteractiveDefinitions, { template: original, parentParameters, onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.label('Edit template parameter caption').props.onClick(); ui.refresh();
  ui.change('Template parameter type', 'number');
  ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.deepEqual(patches, []); assert.equal(errors.length, 1); assert.equal(original.parameters.caption, 'abc');
  ui.change('Template parameter default value', '3.5'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.deepEqual(patches, [{ parameters: { caption: '3.5' }, parameterTypes: { caption: 'number' } }]);
});

check('declared parameter edits preserve valid defaults, parent references and unrelated type declarations', () => {
  const patches = [];
  const ui = drive(InteractiveDefinitions, { template, parentParameters, onChange: patch => patches.push(patch), notify: noOp });
  ui.label('Edit template parameter threshold').props.onClick(); ui.refresh();
  ui.change('Template parameter default value', '{limit}'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(patches[0].parameters.threshold, '{limit}'); assert.deepEqual(patches[0].parameterTypes, template.parameterTypes);
  assert.equal(template.parameters.threshold, '10');
});

check('rename and deletion keep parameter type metadata aligned; cancel emits no changes', () => {
  const patches = [];
  const ui = drive(InteractiveDefinitions, { template, parentParameters, onChange: patch => patches.push(patch), notify: noOp });
  ui.label('Edit template parameter threshold').props.onClick(); ui.refresh();
  ui.change('Template parameter name', 'limit'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(patches[0].parameters.limit, '10'); assert.equal(patches[0].parameterTypes.limit, 'number');
  assert.ok(!Object.hasOwn(patches[0].parameters, 'threshold')); assert.ok(!Object.hasOwn(patches[0].parameterTypes, 'threshold'));
  ui.label('Edit template parameter permitted').props.onClick(); ui.refresh(); ui.button('Delete parameter').props.onClick(); ui.refresh();
  assert.ok(!Object.hasOwn(patches[1].parameters, 'permitted')); assert.ok(!Object.hasOwn(patches[1].parameterTypes, 'permitted'));
  ui.label('Edit template parameter caption').props.onClick(); ui.refresh(); ui.change('Template parameter default value', 'Changed'); ui.button('Cancel').props.onClick(); ui.refresh();
  assert.equal(patches.length, 2);
});

check('new defaults reject duplicate/reserved names, Boolean coercion and unsafe numeric text', () => {
  const patches = [], errors = [];
  const ui = drive(InteractiveDefinitions, { template, parentParameters, onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.button('Add parameter').props.onClick(); ui.refresh();
  for (const name of ['threshold', '__proto__']) { ui.change('Template parameter name', name); ui.button('Apply parameter').props.onClick(); ui.refresh(); }
  ui.change('Template parameter name', 'quantity'); ui.change('Template parameter type', 'number');
  for (const value of ['', ' 1', '01', '9007199254740992']) { ui.change('Template parameter default value', value); ui.button('Apply parameter').props.onClick(); ui.refresh(); }
  ui.change('Template parameter type', 'boolean'); ui.change('Template parameter default value', '1'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.deepEqual(patches, []); assert.equal(errors.length, 7);
  ui.change('Template parameter default value', 'true'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(patches[0].parameters.quantity, 'true'); assert.equal(patches[0].parameterTypes.quantity, 'boolean');
});

check('instance sheet displays declared types and defaults and exposes stale override removal', () => {
  const html = renderToStaticMarkup(React.createElement(TemplateParameterOverrides, { template, parameters: { stale: 'value' }, parentParameters, onChange: noOp, notify: noOp }));
  assert.match(html, /Parameter threshold value source/); assert.match(html, /Boolean · False/); assert.match(html, /Use default/);
  assert.match(html, /Remove undeclared parameter stale/); assert.doesNotMatch(html, /JSON/);
});

check('invalid override drafts cannot mutate saved values; valid references remain text and reset removes only that override', () => {
  const changes = [], errors = [];
  const ui = drive(InteractiveOverrides, { template, parameters: { caption: 'Custom', threshold: '20' }, parentParameters, onChange: value => changes.push(value), notify: (...args) => errors.push(args) });
  ui.change('Parameter threshold override value', ' 25'); ui.button('Apply override').props.onClick(); ui.refresh();
  assert.deepEqual(changes, []); assert.equal(errors.length, 1);
  ui.change('Parameter threshold override value', '{limit}'); ui.button('Apply override').props.onClick(); ui.refresh();
  assert.deepEqual(changes, [{ caption: 'Custom', threshold: '{limit}' }]);
  ui.change('Parameter threshold value source', 'default'); assert.deepEqual(changes[1], { caption: 'Custom' });
});

check('explicit false and zero overrides remain distinct from inherited defaults', () => {
  const html = renderToStaticMarkup(React.createElement(TemplateParameterOverrides, { template, parameters: { threshold: '0', permitted: 'false' }, parentParameters, onChange: noOp, notify: noOp }));
  assert.match(html, /Parameter threshold override value[^>]*value="0"/);
  assert.match(html, /Boolean · False/); assert.match(html, /value="override" selected=""/);
});

check('text defaults keep multiline content without implicit numeric or Boolean conversion', () => {
  const patches = [];
  const ui = drive(InteractiveDefinitions, { template, parentParameters, onChange: patch => patches.push(patch), notify: noOp });
  ui.label('Edit template parameter caption').props.onClick(); ui.refresh();
  assert.equal(ui.label('Template parameter default value').type, 'textarea');
  ui.change('Template parameter default value', 'false\n003'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(patches[0].parameters.caption, 'false\n003'); assert.ok(!Object.hasOwn(patches[0].parameterTypes, 'caption'));
});

console.log(`${passed}/${passed} template parameter authoring checks passed.`);
