import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = asModule(`let values=[],index=0;
export const begin=()=>{index=0;}; export const clear=()=>{values=[];index=0;};
export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};
export const useId=()=>'state-test'; export const useEffect=()=>{};`);
const portalUrl = asModule('export const createPortal=children=>children;');
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
const staticModules = loader(), interactiveModules = loader(true);
const { StateControlEditor } = await import(staticModules('StateControlEditor'));
const { PropertyBindingsEditor } = await import(staticModules('PropertyBindingsEditor'));
const { StateControlEditor: InteractiveEditor } = await import(interactiveModules('StateControlEditor'));
const { PropertyBindingsEditor: InteractiveBindings } = await import(interactiveModules('PropertyBindingsEditor'));
const { isInput, resolveInputs, validateInputs } = await import(staticModules('inputs'));
const { resolveIndicatorState } = await import(staticModules('stateControls'));
const { isChart, defaultChartProps } = await import(staticModules('chartModel'));
const { isProcessDisplay } = await import(staticModules('processDisplays'));
const hooks = await import(hookUrl);
const make = (type = 'multiStateIndicator') => ({ id: 'state-control', type, x: 20, y: 30, width: 300, height: 90, props: type === 'multiStateIndicator'
  ? { text: 'Equipment', stateValue: 'stopped', states: [{ value: 'stopped', label: 'Stopped', color: '#64748b' }, { value: 'running', label: 'Running', color: '#2563eb' }] }
  : { text: 'Mode', fieldKey: 'mode', defaultValue: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }] } });
const noOp = () => {};
const context = component => ({ component, components: [component], tags: [], parameters: {}, inputs: {}, onChange: noOp, onGeometryChange: noOp });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component, props, unwrap = false) {
  hooks.clear(); let tree;
  const refresh = () => { hooks.begin(); const outer = Component(props); tree = unwrap ? outer.type(outer.props) : outer; };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected state authoring control'); return node; };
  const label = text => find(node => node.props?.['aria-label'] === text);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (text, value) => { label(text).props.onChange({ target: { value } }); refresh(); };
  refresh(); return { refresh, find, label, button, change, all: () => nodes(tree) };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('only indicators expose stateValue fx and no new control exposes direct tagPath fx', () => {
  for (const type of ['multiStateIndicator', 'multiStateButton', 'passwordInput']) {
    const html = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(make(type))));
    assert.equal(html.includes('data-property="stateValue"'), type === 'multiStateIndicator');
    assert.ok(!html.includes('data-property="tagPath"'));
    if (type === 'multiStateIndicator') assert.match(html, /Add State value binding/);
  }
  const numeric = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(make('value'))));
  assert.match(numeric, /data-property="tagPath"/); assert.doesNotMatch(numeric, /data-property="stateValue"/);
});

check('indicator edits apply exact values, labels and colors atomically without replacing other props', () => {
  const component = make(), before = structuredClone(component), patches = [];
  const ui = drive(InteractiveEditor, { component, onChange: patch => patches.push(patch), notify: noOp });
  ui.button('Edit states').props.onClick(); ui.refresh();
  ui.change('State 1 value', 'idle'); ui.change('State 1 label', 'Idle'); ui.change('State 1 color', '#0f08');
  assert.deepEqual(patches, []);
  ui.button('Apply states').props.onClick(); ui.refresh();
  assert.deepEqual(patches, [{ states: [{ value: 'idle', label: 'Idle', color: '#0f08' }, before.props.states[1]] }]);
  assert.deepEqual(component, before);
});

check('state collections occupy grid rows and dismiss their staged dialog without mutating saved values', () => {
  for (const type of ['multiStateIndicator', 'multiStateButton']) {
    const component = make(type), patches = [], ui = drive(InteractiveEditor, { component, onChange: patch => patches.push(patch), notify: noOp });
    const property = type === 'multiStateIndicator' ? 'states' : 'options', trigger = type === 'multiStateIndicator' ? 'Edit states' : 'Edit options';
    const row = ui.find(node => node.props?.['data-property'] === property);
    assert.match(row.props.className, /property-sheet-row/); assert.equal(React.Children.toArray(row.props.children).length, 3);
    assert.ok(!ui.all().some(node => ['ul', 'ol', 'dialog'].includes(node.type)));
    ui.button(trigger).props.onClick(); ui.refresh();
    ui.change(type === 'multiStateIndicator' ? 'State 1 label' : 'Option 1 label', 'Unsaved');
    ui.find(node => node.type?.name === 'PropertyCollectionDialog').props.onClose(); ui.refresh();
    assert.deepEqual(patches, []); assert.ok(!ui.all().some(node => node.type?.name === 'PropertyCollectionDialog'));
    ui.button(trigger).props.onClick(); ui.refresh(); assert.notEqual(ui.label(type === 'multiStateIndicator' ? 'State 1 label' : 'Option 1 label').props.value, 'Unsaved');
  }
});

check('invalid duplicate states, empty labels and non-hex colors stay in the editor without saving', () => {
  const patches = [], errors = [], ui = drive(InteractiveEditor, { component: make(), onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.button('Edit states').props.onClick(); ui.refresh();
  ui.change('State 1 value', 'running'); ui.button('Apply states').props.onClick(); ui.refresh();
  ui.change('State 1 value', 'stopped'); ui.change('State 1 label', ''); ui.button('Apply states').props.onClick(); ui.refresh();
  ui.change('State 1 label', 'Stopped'); ui.change('State 1 color', 'red'); ui.button('Apply states').props.onClick(); ui.refresh();
  assert.equal(errors.length, 3); assert.deepEqual(patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
  ui.button('Cancel').props.onClick(); ui.refresh(); assert.deepEqual(patches, []);
});

check('state row add/remove respects one-state and thirty-two-state limits', () => {
  const component = make(); component.props.states = [component.props.states[0]];
  const ui = drive(InteractiveEditor, { component, onChange: noOp, notify: noOp });
  ui.button('Edit states').props.onClick(); ui.refresh();
  assert.equal(ui.label('Remove state 1').props.disabled, true);
  for (let i = 1; i < 32; i++) { ui.button('Add state').props.onClick(); ui.refresh(); }
  assert.equal(ui.button('Add state').props.disabled, true); assert.equal(ui.label('Remove state 1').props.disabled, false);
});

check('removing a selected button option requires a deliberate replacement default', () => {
  const component = make('multiStateButton'); component.props.options.push({ value: 'off', label: 'Off' });
  const patches = [], errors = [], ui = drive(InteractiveEditor, { component, onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.button('Edit options').props.onClick(); ui.refresh();
  ui.label('Remove option 1').props.onClick(); ui.refresh();
  ui.button('Apply options').props.onClick(); ui.refresh(); assert.deepEqual(patches, []); assert.equal(errors.length, 1);
  ui.change('Button default selection', 'manual'); ui.button('Apply options').props.onClick(); ui.refresh();
  assert.deepEqual(patches, [{ options: [{ value: 'manual', label: 'Manual' }, { value: 'off', label: 'Off' }], defaultValue: 'manual' }]);
});

check('button options use exact unique string values and preserve literal parameter-looking text', () => {
  const component = make('multiStateButton'), patches = [];
  const ui = drive(InteractiveEditor, { component, onChange: patch => patches.push(patch), notify: noOp });
  ui.button('Edit options').props.onClick(); ui.refresh();
  assert.equal(ui.label('Remove option 1').props.disabled, true);
  ui.change('Option 2 value', '{mode}'); ui.change('Button default selection', '{mode}'); ui.button('Apply options').props.onClick(); ui.refresh();
  assert.equal(patches[0].defaultValue, '{mode}'); assert.equal(patches[0].options[1].value, '{mode}');
  assert.deepEqual(Object.keys(patches[0]).sort(), ['defaultValue', 'options']);
  const html = renderToStaticMarkup(React.createElement(StateControlEditor, { component, onChange: noOp, notify: noOp }));
  assert.match(html, /does not write to a device/); assert.doesNotMatch(html, /textarea|JSON|query/i);
});

check('palette factories create valid empty passwords, selected segments and known indicator states', () => {
  const source = fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  function visit(node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer.getText(ast)); ts.forEachChild(node, visit); }
  visit(ast);
  const script = ts.transpileModule(`const processDimensions=${declarations.get('processDimensions')}; const palettes=${declarations.get('palettes')}; const addComponent=${declarations.get('addComponent')}; return {palettes,addComponent};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let screen = { id: 'screen', width: 1000, height: 700, components: [] };
  const factory = new Function('screen', 'project', 'editingTemplate', 'availableTemplates', 'notify', 'id', 'assets', 'queries', 'isInput', 'isTemplateInstance', 'updateScreen', 'setSelectedId', 'isProcessDisplay', 'isChart', 'defaultChartProps', script)(
    screen, { screens: [screen], templates: [] }, undefined, [], noOp, value => `new-${value}`, [], [], isInput, type => type === 'template' || type === 'repeater', update => { screen = update(screen); }, noOp, isProcessDisplay, isChart, defaultChartProps);
  for (const type of ['passwordInput', 'multiStateButton', 'multiStateIndicator']) { assert.ok(factory.palettes.some(item => item.type === type)); factory.addComponent(type); }
  const [password, button, indicator] = screen.components;
  assert.equal(password.props.defaultValue, ''); assert.ok(!password.props.tagPath); assert.ok(!password.props.optionsSource);
  assert.equal(button.props.options.length, 2); assert.ok(button.props.options.some(item => item.value === button.props.defaultValue)); assert.ok(!button.props.optionsSource);
  assert.equal(resolveIndicatorState(indicator.props).state.value, 'idle'); assert.ok(!indicator.props.tagPath);
  const inputs = resolveInputs(screen, [], {}); assert.equal(inputs[password.props.fieldKey], ''); assert.equal(inputs[button.props.fieldKey], 'option1'); assert.equal(validateInputs(screen, inputs, {}), null);
});

const previousDocument = globalThis.document; globalThis.document = { body: {} };
try {
  check('indicator scalar expression previews string values and Apply preserves state definitions', () => {
    const component = make(), patches = [], before = structuredClone(component);
    const ui = drive(InteractiveBindings, { ...context(component), onChange: patch => patches.push(patch) }, true);
    ui.label('Add State value binding').props.onClick(); ui.refresh();
    ui.find(node => node.type === 'textarea' && node.props.id?.endsWith('-expression')).props.onChange({ target: { value: 'false' } }); ui.refresh();
    assert.ok(ui.all().some(node => node.type === 'output' && node.props.children === '"false"'));
    ui.button('Apply').props.onClick(); ui.refresh();
    assert.deepEqual(patches, [{ bindings: { stateValue: { expression: 'false', references: {} } } }]); assert.deepEqual(component, before);
  });
} finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }

console.log(`${passed}/${passed} state control authoring checks passed.`);
