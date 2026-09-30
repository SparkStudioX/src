import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = asModule(`let scopes = new Map(), current = '', index = 0, effects = [];
export const begin = scope => {current=scope; index=0; if(!scopes.has(scope)) scopes.set(scope,[]);};
export const clear = () => {scopes=new Map(); effects=[];};
export const useState = initial => {const values=scopes.get(current), at=index++; if(!(at in values)) values[at]=typeof initial==='function'?initial():initial; return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef = initial => {const values=scopes.get(current), at=index++; return values[at]??={current:initial};};
export const useId = () => 'parameter-test';
export const useEffect = (effect,deps) => {const values=scopes.get(current), at=index++, old=values[at]; if(!old || !deps || deps.some((value,i)=>!Object.is(value,old[i]))){values[at]=deps;effects.push(effect);}};
export const flushEffects = () => {const pending=effects.splice(0);pending.forEach(effect=>effect());return pending.length;};`);
const portalUrl = asModule('export const createPortal = children => children;');
function loader(interactive = false) {
  const modules = new Map();
  return function moduleUrl(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
    assert.ok(file, name);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(interactive && dependency === 'react' ? hookUrl : interactive && dependency === 'react-dom' ? portalUrl : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const url = asModule(output); modules.set(name, url); return url;
  };
}
const staticModules = loader();
const { DocumentProperties, ProjectProperties } = await import(staticModules('DocumentProperties'));
const { DocumentProperties: InteractiveDocument, ProjectProperties: InteractiveProject } = await import(loader(true)('DocumentProperties'));
const { TemplateParameterOverrides } = await import(staticModules('TemplateParametersEditor'));
const { TemplateParametersEditor: InteractiveDefinitions, TemplateParameterOverrides: InteractiveOverrides } = await import(loader(true)('TemplateParametersEditor'));
const { PropertyBindingsEditor: InteractiveBindings } = await import(loader(true)('PropertyBindingsEditor'));
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
  const refresh = () => { let renders=0; do { assert.ok(renders++ < 10, 'Effects settle'); tree = expand(React.createElement(Component, props)); } while (hooks.flushEffects()); };
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

check('parameter bindings keep fx in the third grid cell and definition collections expand from value cells', () => {
  const edited = [], overrides = drive(InteractiveOverrides, { template, parameters: {}, parentParameters, onChange: noOp, notify: noOp, onEditBinding: name => edited.push(name) });
  const row = overrides.find(node => node.props?.['data-property'] === 'parameters.threshold');
  assert.match(row.props.className, /property-sheet-row/);
  const cells = React.Children.toArray(row.props.children); assert.equal(cells.length, 3); assert.equal(cells[0].type, 'label'); assert.equal(cells[1].props.className, 'property-sheet-value');
  assert.equal(cells[2].type, 'button'); assert.equal(cells[2].props.className, 'property-bind-button'); cells[2].props.onClick(); assert.deepEqual(edited, ['threshold']);
  const screen = { ...template, kind: 'screen', parameterTypes: undefined }, project = { id: 'app', name: 'App', revision: 1, parameters: { flag: 'false' }, screens: [screen], navigation: { mode: 'menu', startupScreenId: screen.id, items: [{ screenId: screen.id, label: 'Motor' }] } };
  for (const [Component, props, summary] of [[InteractiveDefinitions, { template, parentParameters }, 'Edit parameters (3)'], [InteractiveDocument, { document: screen, isTemplate: false }, 'Edit parameters (3)'], [InteractiveProject, { project }, 'Edit destinations (1)']]) {
    const ui = drive(Component, { ...props, onChange: noOp, notify: noOp });
    const gridRow = ui.all().find(node => node.props?.className === 'property-sheet-row' && React.Children.toArray(node.props.children).some(cell => cell.props?.className === 'property-sheet-value' && React.Children.toArray(cell.props.children).some(details => details.type === 'details' && nodes(details).some(item => item.type === 'summary' && React.Children.toArray(item.props.children).join('') === summary))));
    assert.ok(gridRow, `${summary} must expand inside a property value cell`);
  }
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

check('adding and removing a binding discards any uncommitted literal override draft', () => {
  const changes = [];
  const props = { template, parameters: { threshold: '20' }, parentParameters, onChange: value => changes.push(value), notify: noOp, bindings: {} };
  const ui = drive(InteractiveOverrides, props);
  ui.change('Parameter threshold override value', '75');
  assert.ok(ui.button('Apply override'));
  props.bindings = { threshold: { expression: '25', references: {} } }; ui.refresh();
  assert.equal(ui.label('Parameter threshold value source').props.disabled, true);
  props.bindings = {}; ui.refresh();
  assert.equal(ui.label('Parameter threshold override value').props.value, '20');
  assert.ok(!ui.all().some(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === 'Apply override'));
  assert.deepEqual(changes, []);
});

check('text defaults keep multiline content without implicit numeric or Boolean conversion', () => {
  const patches = [];
  const ui = drive(InteractiveDefinitions, { template, parentParameters, onChange: patch => patches.push(patch), notify: noOp });
  ui.label('Edit template parameter caption').props.onClick(); ui.refresh();
  assert.equal(ui.label('Template parameter default value').type, 'textarea');
  ui.change('Template parameter default value', 'false\n003'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(patches[0].parameters.caption, 'false\n003'); assert.ok(!Object.hasOwn(patches[0].parameterTypes, 'caption'));
});

globalThis.document = { body: {} };
const makeInstance = (type = 'template') => ({ id: 'instance', type, x: 0, y: 0, width: 400, height: 200, props: { templateId: template.id, parameters: { threshold: '5' } } });
const parentInputs = [
  { id: 'quantity', type: 'numberInput', x: 0, y: 0, width: 100, height: 30, props: { fieldKey: 'quantity', defaultValue: 6 } },
  { id: 'secret', type: 'passwordInput', x: 0, y: 0, width: 100, height: 30, props: { fieldKey: 'secret' } },
];
function bindUi(component = makeInstance(), extra = {}) {
  const changes = [];
  const ui = drive(InteractiveBindings, { component, components: [component, ...parentInputs], parameterTemplate: template,
    parameters: parentParameters, tags: [], inputs: { quantity: 6, secret: 'never-bind' }, onChange: patch => changes.push(patch), onGeometryChange: noOp, ...extra });
  const expression = value => { ui.find(node => node.type === 'textarea' && node.props.className === 'binding-expression').props.onChange({ target: { value } }); ui.refresh(); };
  return { ...ui, changes, expression, output: () => ui.find(node => node.type === 'output').props.children.join('') };
}

check('imported prototype-like names render literal defaults without inherited bindings, errors or type metadata', () => {
  const imported = { ...template, parameters: JSON.parse('{"__proto__":"Prototype default","constructor":"Constructor default"}'), parameterTypes: {} };
  const html = renderToStaticMarkup(React.createElement(TemplateParameterOverrides, { template: imported, parameters: {}, parentParameters: {}, onChange: noOp, notify: noOp, onEditBinding: noOp }));
  assert.match(html, /Text · Prototype default/); assert.match(html, /Text · Constructor default/); assert.doesNotMatch(html, /is-bound|role="alert"|value="binding"/);
  const definition = drive(InteractiveDefinitions, { template: imported, parentParameters: {}, onChange: noOp, notify: noOp });
  definition.label('Edit template parameter constructor').props.onClick(); definition.refresh(); assert.equal(definition.label('Template parameter type').props.value, 'string');
});

check('fx adds, previews and removes own bindings for imported prototype-like parameter keys', () => {
  for (const name of ['__proto__', 'constructor']) {
    const imported = { ...template, parameters: Object.fromEntries([[name, 'Literal default']]), parameterTypes: {} };
    const component = { ...makeInstance(), props: { templateId: imported.id, parameters: {} } };
    const ui = bindUi(component, { parameterTemplate: imported });
    assert.equal(ui.label(`Parameter ${name} value source`).props.disabled, false);
    ui.label(`Add parameter ${name} binding`).props.onClick(); ui.refresh();
    assert.equal(ui.output(), '"Literal default"'); assert.ok(!ui.all().some(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === 'Remove binding'));
    ui.expression('"Bound value"'); ui.button('Apply').props.onClick(); ui.refresh();
    const bindings = ui.changes[0].parameterBindings; assert.equal(Object.hasOwn(bindings, name), true); assert.equal(bindings[name].expression, '"Bound value"'); assert.equal(Object.getPrototypeOf(bindings), Object.prototype);
    const bound = bindUi({ ...component, props: { ...component.props, parameterBindings: bindings } }, { parameterTemplate: imported });
    assert.equal(bound.label(`Parameter ${name} value source`).props.disabled, true); bound.label(`Edit parameter ${name} binding`).props.onClick(); bound.refresh(); assert.equal(bound.output(), '"Bound value"');
    bound.button('Remove binding').props.onClick(); bound.refresh(); assert.deepEqual(bound.changes, [{ parameterBindings: {} }]);
  }
  const patches = [], imported = { ...template, parameters: JSON.parse('{"__proto__":"2"}'), parameterTypes: {} };
  const ui = drive(InteractiveDefinitions, { template: imported, parentParameters: {}, onChange: patch => patches.push(patch), notify: noOp });
  ui.label('Edit template parameter __proto__').props.onClick(); ui.refresh(); ui.change('Template parameter type', 'number'); ui.button('Apply parameter').props.onClick(); ui.refresh();
  assert.equal(Object.hasOwn(patches[0].parameterTypes, '__proto__'), true); assert.equal(patches[0].parameterTypes.__proto__, 'number'); assert.equal(Object.getPrototypeOf(patches[0].parameterTypes), Object.prototype);
});

check('template and repeater parameters reuse the fx dialog with parent sources and typed live preview', () => {
  for (const type of ['template', 'repeater']) {
    const ui = bindUi(makeInstance(type));
    ui.label('Add parameter threshold binding').props.onClick(); ui.refresh();
    ui.button('Add reference').props.onClick(); ui.refresh();
    assert.deepEqual(nodes(ui.label('Reference 1 source')).filter(node => node.type === 'option').map(node => node.props.value), ['custom', 'input', 'parameter', 'sessionState', 'screenState', 'tag']);
    assert.equal(ui.label('Reference 1 input key').props.value, 'quantity');
    assert.ok(!ui.all().some(node => node.type === 'option' && node.props.value === 'secret'));
    ui.expression('value * 2'); assert.equal(ui.output(), '12');
    ui.button('Apply').props.onClick(); ui.refresh();
    assert.deepEqual(ui.changes, [{ parameterBindings: { threshold: { expression: 'value * 2', references: { value: { kind: 'input', key: 'quantity' } } } } }]);
  }
});

check('binding drafts cancel without mutations and bound values cannot overwrite literals accidentally', () => {
  const component = makeInstance();
  component.props.parameterBindings = { threshold: { expression: 'qty', references: { qty: { kind: 'input', key: 'quantity' } } } };
  const ui = bindUi(component);
  assert.equal(ui.label('Parameter threshold value source').props.disabled, true);
  assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Parameter threshold override value'));
  ui.label('Edit parameter threshold binding').props.onClick(); ui.refresh(); ui.expression('qty + 10');
  ui.button('Cancel').props.onClick(); ui.refresh(); assert.deepEqual(ui.changes, []);
  ui.label('Edit parameter threshold binding').props.onClick(); ui.refresh();
  ui.button('Remove binding').props.onClick(); ui.refresh();
  assert.deepEqual(ui.changes, [{ parameterBindings: {} }]); assert.deepEqual(component.props.parameters, { threshold: '5' });
});

check('password, child-only parameters, invalid constants and duplicate reference aliases cannot be applied', () => {
  const ui = bindUi();
  ui.label('Add parameter threshold binding').props.onClick(); ui.refresh(); ui.expression('true');
  ui.button('Apply').props.onClick(); ui.refresh(); assert.equal(ui.changes.length, 0);
  ui.button('Add reference').props.onClick(); ui.refresh(); ui.expression('value');
  ui.change('Reference 1 input key', 'secret'); ui.button('Apply').props.onClick(); ui.refresh();
  assert.match(ui.output(), /non-password input/); assert.equal(ui.changes.length, 0);
  ui.change('Reference 1 source', 'parameter'); ui.change('Reference 1 parameter name', 'threshold');
  ui.button('Apply').props.onClick(); ui.refresh(); assert.match(ui.output(), /not declared/); assert.equal(ui.changes.length, 0);
  ui.change('Reference 1 parameter name', 'limit'); ui.button('Add reference').props.onClick(); ui.refresh();
  ui.change('Reference 2 name', 'value'); ui.button('Apply').props.onClick(); ui.refresh(); assert.match(ui.output(), /unique/); assert.equal(ui.changes.length, 0);
});

check('invalid parent input previews a blocking error while valid text remains literal', () => {
  const component = makeInstance();
  component.props.parameterBindings = { threshold: { expression: 'qty', references: { qty: { kind: 'input', key: 'quantity' } } } };
  const ui = bindUi(component, { inputs: { quantity: null } });
  ui.label('Edit parameter threshold binding').props.onClick(); ui.refresh(); assert.match(ui.output(), /unavailable/);
  const text = bindUi(); text.label('Add parameter caption binding').props.onClick(); text.refresh(); text.expression("'{line}'");
  assert.equal(text.output(), '"{line}"'); text.button('Apply').props.onClick(); text.refresh();
  assert.equal(text.changes[0].parameterBindings.caption.expression, "'{line}'");
});

check('custom properties referenced by parameter bindings cannot be renamed or removed', () => {
  const component = makeInstance(); component.props.customProperties = { factor: { type: 'number', value: 2 } };
  component.props.parameterBindings = { threshold: { expression: 'factor', references: { factor: { kind: 'custom', key: 'factor' } } } };
  const ui = bindUi(component); assert.equal(ui.label('Remove custom property factor').props.disabled, true);
  ui.label('Edit custom property factor').props.onClick(); ui.refresh(); assert.equal(ui.label('Custom property name').props.disabled, true);
});

delete globalThis.document;
const appAst = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let previewActionSource, popupExecuteSource;
function visitApp(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'runPreviewAction') previewActionSource = node.initializer.getText(appAst);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(appAst) === 'Popup') {
    const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(appAst) === 'onExecute');
    popupExecuteSource = attribute.initializer.expression.getText(appAst);
  }
  ts.forEachChild(node, visitApp);
}
visitApp(appAst);
assert.ok(previewActionSource && popupExecuteSource, 'Designer action callbacks exist');
const uiHelpers = await import(staticModules('pythonUiModel'));
const compileCallback = source => ts.transpileModule(`const {pythonUiRequest, pythonUiPreviewContext, applyPythonUiResult} = uiHelpers; const previewCommunication = { busy: false, session: { mode: "live-actions" } }; return (${source});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const makePreviewAction = new Function('uiHelpers', 'gatewayAdmin', 'screen', 'project', 'previewActionBusy', 'editorParameterError', 'editorParameters', 'currentPreviewInputs', 'validateInputs', 'setPreviewActionBusy', 'actionKey', 'api', 'notify', 'window', compileCallback(previewActionSource)).bind(null, uiHelpers);
const makePopupExecute = new Function('uiHelpers', 'gatewayAdmin', 'api', compileCallback(popupExecuteSource)).bind(null, uiHelpers);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
for (const failure of [false, true]) {
  const request = deferred(), notifications = [], busy = [], refreshes = []; let current = true, calls = 0;
  const run = makePreviewAction(true, { id: 'main' }, {}, '', undefined, {}, {}, () => undefined, value => busy.push(value), () => 'action',
    () => { calls++; return request.promise; }, (...args) => notifications.push(args), { dispatchEvent: event => refreshes.push(event.type) });
  const pending = run({ id: 'submit', props: { script: 'pass' } }, { parameters: {}, inputs: {}, isCurrent: () => current });
  current = false;
  if (failure) request.reject(new Error('Old action failed')); else request.resolve({ success: true, result: { message: 'Old action succeeded' } });
  await pending;
  assert.equal(calls, 1); assert.deepEqual(notifications, []); assert.deepEqual(refreshes, failure ? [] : ['sparkstudio:refresh-data']); assert.deepEqual(busy, ['action', '']);
}
passed++; console.log('PASS Designer suppresses stale action success and error notifications but releases its busy flag');
{
  const notifications = [], refreshes = []; let calls = 0;
  const run = makePreviewAction(true, { id: 'main' }, {}, '', undefined, {}, {}, () => undefined, noOp, () => 'action',
    async () => { calls++; return { success: true, result: { message: 'Current result' } }; }, (...args) => notifications.push(args), { dispatchEvent: event => refreshes.push(event.type) });
  await run({ props: {} }, { isCurrent: () => false }); assert.equal(calls, 0);
  await run({ props: {} }, { isCurrent: () => true }); assert.equal(calls, 1);
  assert.deepEqual(notifications, [['Current result', false]]); assert.deepEqual(refreshes, ['sparkstudio:refresh-data']);
}
passed++; console.log('PASS Designer refuses stale dispatch while current template actions still notify and refresh');
{
  const request = deferred(); let current = true, calls = 0;
  const run = makePopupExecute(true, () => { calls++; return request.promise; });
  await assert.rejects(run({ instance: { isCurrent: () => false } }), /changed before/); assert.equal(calls, 0);
  const pending = run({ component: { props: {} }, inputs: {}, instance: { parameters: {}, isCurrent: () => current } });
  current = false; request.resolve({ success: true }); await assert.rejects(pending, /changed while/); assert.equal(calls, 1);
}
passed++; console.log('PASS Designer popup execution refuses stale dispatch and invalidates late completion');
console.log(`${passed}/${passed} template parameter authoring checks passed.`);
