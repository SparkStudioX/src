import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = asModule(`let scopes=new Map(),current='',index=0;
export const begin=scope=>{current=scope;index=0;if(!scopes.has(scope))scopes.set(scope,[]);};
export const clear=()=>{scopes=new Map();};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};
export const useId=()=>'process-test';export const useEffect=()=>{};`);
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
const modules = loader();
const { PropertyBindingsEditor } = await import(modules('PropertyBindingsEditor'));
const { PropertyBindingsEditor: InteractiveEditor } = await import(loader(true)('PropertyBindingsEditor'));
const { evaluateComponentBindings, validatePropertyBinding } = await import(modules('propertyBindings'));
const { isProcessDisplay, resolveProcessDisplay } = await import(modules('processDisplays'));
const { isChart, defaultChartProps } = await import(modules('chartModel'));
const { isInput } = await import(modules('inputs'));
const { iconNames } = await import(modules('Icon'));
const hooks = await import(hookUrl);
const types = ['ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer'];
const common = ['text', 'enabled', 'visible', 'x', 'y', 'width', 'height', 'fontSize', 'color', 'foregroundColor', 'backgroundColor', 'borderColor', 'borderWidth'];
const expected = { ledDisplay: ['value', 'decimals', 'unit'], progressBar: ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent', 'orientation'], cylindricalTank: ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent'], levelIndicator: ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent', 'orientation'], thermometer: ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent'] };
const make = (type = 'progressBar', props = {}) => ({ id: 'display', type, x: 20, y: 30, width: 300, height: 100, props: { text: 'Measurement', ...props } });
const noOp = () => {};
const context = component => ({ component, components: [component], tags: [], parameters: {}, inputs: {}, onChange: noOp, onGeometryChange: noOp });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(component) {
  hooks.clear(); let tree;
  const patches = [], props = { ...context(component), onChange: patch => { patches.push(patch); props.component = { ...props.component, props: { ...props.component.props, ...patch } }; props.components = [props.component]; } };
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}:${index}`));
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(InteractiveEditor, props)); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected process property control'); return node; };
  const input = target => find(node => node.props?.id?.endsWith(`-property-${target}`));
  const label = text => find(node => node.props?.['aria-label'] === text);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  refresh(); return { props, patches, refresh, find, input, label, button, all: () => nodes(tree) };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('each display exposes only its supported process properties, with one fx button per property', () => {
  for (const type of types) {
    const html = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(make(type))));
    const rows = [...html.matchAll(/data-property="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(rows, [...common, ...expected[type]], type);
    assert.equal((html.match(/class="property-bind-button"/g) || []).length, rows.length);
    assert.doesNotMatch(html, /data-property="(?:tagPath|stateValue)"/);
  }
});

check('legacy and empty definitions show real defaults with vertical level and horizontal progress orientation', () => {
  const progress = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(make())));
  const level = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(make('levelIndicator'))));
  assert.match(progress, /property-value"[^>]*value="0"/); assert.match(progress, /property-decimals"[^>]*value="1"/);
  assert.match(progress, /property-max"[^>]*value="100"/);
  assert.match(progress, /value="horizontal" selected=""/); assert.match(level, /value="vertical" selected=""/);
  assert.match(progress, /property-showValue"[^>]*checked=""/); assert.doesNotMatch(progress, /property-showPercent"[^>]*checked=""/);
});

check('unsafe numeric and fractional decimal drafts never save rounded or clamped values', () => {
  const ui = drive(make());
  ui.input('value').props.onChange({ target: { value: '9007199254740993' } }); ui.refresh(); ui.input('value').props.onBlur(); ui.refresh();
  assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
  ui.input('decimals').props.onChange({ target: { value: '2.5' } }); ui.refresh(); ui.input('decimals').props.onBlur(); ui.refresh();
  assert.deepEqual(ui.patches, []);
  ui.input('value').props.onChange({ target: { value: '-12.75' } }); ui.refresh(); ui.input('value').props.onBlur(); ui.refresh();
  assert.deepEqual(ui.patches, [{ value: -12.75 }]);
});

check('an intermediate inverted range keeps the authored edit and shows a diagnostic', () => {
  const ui = drive(make());
  ui.input('min').props.onChange({ target: { value: '150' } }); ui.refresh(); ui.input('min').props.onBlur(); ui.refresh();
  assert.deepEqual(ui.patches, [{ min: 150 }]);
  assert.ok(ui.all().some(node => node.props?.role === 'alert' && React.Children.toArray(node.props.children).join('').includes('Minimum must be less than maximum')));
  assert.equal(resolveProcessDisplay(ui.props.component).available, false);
});

check('tag failures clear process values and prevent static fallback displays', () => {
  for (const type of types) {
    const component = make(type, { value: 88, bindings: { value: { expression: 'reading', references: { reading: { kind: 'tag', path: '[default]Missing' } } } } });
    const evaluated = evaluateComponentBindings(component, context(component));
    assert.equal(evaluated.component.props.value, undefined); assert.match(evaluated.errors.value, /not found/);
    assert.deepEqual(resolveProcessDisplay(evaluated.component), { available: false, diagnostic: 'Value binding is unavailable.' });
  }
});

let appFactory;
check('actual palette factories create supported defaults, dimensions and distinct valid icons', () => {
  const source = fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX), declarations = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer.getText(ast));
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'tagBindingPatch') declarations.set('tagBindingPatch', node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const script = ts.transpileModule(`const processDimensions=${declarations.get('processDimensions')}; const palettes=${declarations.get('palettes')}; const typeIcon=${declarations.get('typeIcon')}; const acceptsInitialTag=${declarations.get('acceptsInitialTag')}; ${declarations.get('tagBindingPatch')} const addComponent=${declarations.get('addComponent')}; return {palettes,typeIcon,addComponent,tagBindingPatch,acceptsInitialTag};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let screen = { id: 'screen', width: 1000, height: 700, components: [] };
  appFactory = new Function('screen', 'project', 'editingTemplate', 'availableTemplates', 'notify', 'id', 'assets', 'queries', 'isInput', 'isTemplateInstance', 'updateScreen', 'setSelectedId', 'isProcessDisplay', 'isChart', 'defaultChartProps', script)(screen, { screens: [screen], templates: [] }, undefined, [], noOp, type => type, [], [], isInput, type => type === 'template' || type === 'repeater', update => { screen = update(screen); }, noOp, isProcessDisplay, isChart, defaultChartProps);
  for (const type of types) {
    assert.ok(appFactory.palettes.some(item => item.type === type)); appFactory.addComponent(type);
    assert.ok(iconNames.includes(appFactory.typeIcon[type]));
  }
  assert.equal(new Set(types.map(type => appFactory.typeIcon[type])).size, 5);
  for (const component of screen.components) {
    assert.equal(resolveProcessDisplay(component).available, true, component.type);
    assert.equal(component.props.value, 0); assert.equal(component.props.decimals, 1); assert.equal(component.props.unit, '');
    assert.ok(!component.props.tagPath); assert.ok(!component.props.fieldKey); assert.ok(!component.props.events); assert.ok(!isInput(component.type));
    assert.ok(component.width >= 100 && component.height >= 100);
    if (component.type === 'ledDisplay' || component.type === 'progressBar') assert.ok(component.width > component.height);
    else assert.ok(component.height > component.width);
    if (component.type !== 'ledDisplay') assert.equal(component.props.max, 100);
  }
});

check('tag assignment uses exact reference data, keeps existing bindings and never writes a direct process tag path', () => {
  const path = "[default]Tank/' + surprise + '/Level";
  for (const type of types) {
    const component = make(type, { bindings: { text: { expression: "'Tank'", references: {} } } });
    const patch = appFactory.tagBindingPatch(component, path);
    assert.deepEqual(patch.bindings.value, { expression: 'tagValue', references: { tagValue: { kind: 'tag', path } } });
    assert.deepEqual(patch.bindings.text, component.props.bindings.text); assert.ok(!Object.hasOwn(patch, 'tagPath'));
    const bound = { ...component, props: { ...component.props, ...patch } };
    const result = evaluateComponentBindings(bound, { ...context(bound), tags: [{ path, value: 12.5, quality: 'Good' }] });
    assert.deepEqual(result.errors, {}); assert.equal(result.component.props.value, 12.5);
  }
  for (const type of ['value', 'gauge', 'select']) assert.deepEqual(appFactory.tagBindingPatch(make(type), path), { tagPath: path });
  assert.equal(appFactory.acceptsInitialTag('passwordInput'), false); assert.equal(appFactory.acceptsInitialTag('multiStateIndicator'), false);
});

const previousDocument = globalThis.document; globalThis.document = { body: {} };
try {
  check('binding drafts reject strings for numeric values and invalid constant ranges before Apply', () => {
    const ui = drive(make());
    ui.label('Add Value binding').props.onClick(); ui.refresh();
    const expression = () => ui.find(node => node.type === 'textarea' && node.props.id?.endsWith('-expression'));
    expression().props.onChange({ target: { value: "'12'" } }); ui.refresh(); ui.button('Apply').props.onClick(); ui.refresh(); assert.deepEqual(ui.patches, []);
    expression().props.onChange({ target: { value: '12' } }); ui.refresh(); ui.button('Apply').props.onClick(); ui.refresh(); assert.equal(ui.patches[0].bindings.value.expression, '12');
    ui.label('Add Minimum binding').props.onClick(); ui.refresh(); expression().props.onChange({ target: { value: '100' } }); ui.refresh(); ui.button('Apply').props.onClick(); ui.refresh();
    assert.equal(ui.patches.length, 1); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
    assert.match(validatePropertyBinding({ expression: '100', references: {} }, 'min', make()), /less than/);
  });
} finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }

console.log(`${passed}/${passed} process display authoring checks passed.`);
