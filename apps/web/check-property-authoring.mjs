import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// The interaction harness keeps hook state across explicit renders. It invokes
// authored controls without mounting a browser or changing application files.
const hookUrl = asModule(`let values = [], index = 0;
export const begin = () => { index = 0; };
export const clear = () => { values = []; index = 0; };
export const useState = initial => { const at = index++; if (!(at in values)) values[at] = initial; return [values[at], next => { values[at] = typeof next === 'function' ? next(values[at]) : next; }]; };
export const useRef = initial => { const at = index++; return values[at] ??= {current:initial}; };
export const useId = () => 'property-test';
export const useEffect = () => {};`);
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
const { PropertyBindingsEditor } = await import(loader()('PropertyBindingsEditor'));
const { PropertyBindingsEditor: InteractiveEditor } = await import(loader(true)('PropertyBindingsEditor'));
const hooks = await import(hookUrl);
const make = (type = 'template') => ({ id: 'wrapper', type, x: 20, y: 30, width: 600, height: 300, props: {
  templateId: 'shared-form', text: 'Production form', parameters: { title: 'Child title', quantity: '0' },
  rows: [{ id: 'row-a', parameters: { quantity: '0' } }], columns: 2, gap: 12,
  customProperties: { minimum: { type: 'number', value: 2 } },
  bindings: {
    text: { expression: 'caption', references: { caption: { kind: 'parameter', key: 'title' } } },
    enabled: { expression: 'count > threshold', references: { count: { kind: 'input', key: 'quantity' }, threshold: { kind: 'custom', key: 'minimum' } } },
    width: { expression: 'available', references: { available: { kind: 'custom', key: 'available', componentId: 'parent-layout' } } },
  },
} });
const context = component => ({ component, components: [component, { id: 'quantity-input', type: 'numberInput', x: 0, y: 0, width: 100, height: 50, props: { fieldKey: 'quantity', defaultValue: 3 } }, { id: 'parent-layout', type: 'label', x: 0, y: 0, width: 100, height: 30, props: { customProperties: { available: { type: 'number', value: 480 } } } }], tags: [], parameters: { title: 'Parent caption' }, inputs: { quantity: 3 }, onChange() {}, onGeometryChange() {} });
const render = component => renderToStaticMarkup(React.createElement(PropertyBindingsEditor, context(component)));
const common = ['text', 'enabled', 'visible', 'x', 'y', 'width', 'height', 'fontSize', 'color', 'foregroundColor', 'backgroundColor', 'borderColor', 'borderWidth'];
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('template and repeater wrappers expose all thirteen common property rows and fx buttons', () => {
  for (const type of ['template', 'repeater']) {
    const html = render(make(type));
    assert.deepEqual([...html.matchAll(/data-property="([^"]+)"/g)].map(match => match[1]), common);
    assert.equal((html.match(/class="property-bind-button"/g) || []).length, 13);
    assert.match(html, /Accessible label/); assert.match(html, /Typed values belong to this wrapper/);
    assert.doesNotMatch(html, /data-property="(?:tagPath|templateId|parameters|rows|rowsSource|columns|gap)"/);
  }
});
check('wrapper property previews resolve parent inputs, parameters and sibling custom properties', () => {
  const html = render(make());
  assert.match(html, /id="[^"]*-property-text"[^>]*value="Parent caption"/);
  assert.match(html, /id="[^"]*-property-enabled"[^>]*checked=""/);
  assert.match(html, /id="[^"]*-property-width"[^>]*value="480"/);
  assert.doesNotMatch(html, /value="Child title"/);
});
check('wrapper-only labels do not change leaf text editing or numeric-display tag path bindings', () => {
  const label = make(); label.type = 'label'; const html = render(label);
  assert.match(html, />Text<\/label>/); assert.doesNotMatch(html, /Accessible label/);
  const value = make(); value.type = 'value'; assert.match(render(value), /data-property="tagPath"/);
});

function drive(component) {
  hooks.clear();
  const patches = [], geometry = [];
  const props = { ...context(component), onChange: patch => patches.push(patch), onGeometryChange: patch => geometry.push(patch) };
  let tree;
  const refresh = () => { hooks.begin(); const outer = InteractiveEditor(props); tree = outer.type(outer.props); const expand = node => !node || typeof node !== "object" ? node : typeof node.type === "function" && node.type.name === "BindingReferencesEditor" ? expand(node.type(node.props)) : ({ ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map(expand) } }); tree = expand(tree); return tree; };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected authoring control'); return node; };
  const byLabel = label => find(node => node.props?.['aria-label'] === label);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  refresh(); return { patches, geometry, refresh, find, byLabel, button, all: () => nodes(tree) };
}
const previousDocument = globalThis.document;
globalThis.document = { body: {} };
try {
  check('static wrapper layout uses geometry changes without patching template structure', () => {
    const wrapper = make(); const before = structuredClone(wrapper); const ui = drive(wrapper);
    ui.find(node => node.type === 'input' && node.props.id?.endsWith('-property-x')).props.onChange({ target: { value: '125' } });
    assert.deepEqual(ui.geometry, [{ x: 125 }]); assert.deepEqual(ui.patches, []); assert.deepEqual(wrapper, before);
  });
  check('wrapper binding drafts preserve parent-only source choices and block child-only references', () => {
    const wrapper = make('repeater'); const ui = drive(wrapper);
    ui.byLabel('Edit Enabled binding').props.onClick(); ui.refresh();
    const input = ui.byLabel('Reference 1 input key'); assert.equal(input.props.value, 'quantity');
    input.props.onChange({ target: { value: 'childOnlyInput' } }); ui.refresh();
    ui.button('Apply').props.onClick(); ui.refresh();
    assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert' && String(node.props.children).includes('form input')));
    assert.ok(ui.all().some(node => node.type === 'dialog'));
    ui.button('Cancel').props.onClick(); ui.refresh(); assert.ok(!ui.all().some(node => node.type === 'dialog'));
  });
  check('applying a wrapper expression changes only bindings and preserves parameter/row definitions', () => {
    const wrapper = make('repeater'); const before = structuredClone(wrapper); const ui = drive(wrapper);
    ui.byLabel('Edit Enabled binding').props.onClick(); ui.refresh();
    ui.find(node => node.type === 'textarea' && node.props.id?.endsWith('-expression')).props.onChange({ target: { value: 'count >= threshold' } }); ui.refresh();
    ui.button('Apply').props.onClick(); ui.refresh();
    assert.deepEqual(Object.keys(ui.patches[0]), ['bindings']); assert.equal(ui.patches[0].bindings.enabled.expression, 'count >= threshold'); assert.deepEqual(wrapper, before);
  });
  check('typed custom property authoring is available on wrappers and leaves child overrides unchanged', () => {
    const wrapper = make(); const before = structuredClone(wrapper); const ui = drive(wrapper);
    ui.button('Add property').props.onClick(); ui.refresh();
    ui.byLabel('Custom property name').props.onChange({ target: { value: 'instanceLimit' } }); ui.refresh();
    ui.byLabel('Custom property value').props.onChange({ target: { value: '7' } }); ui.refresh();
    ui.button('Apply').props.onClick(); ui.refresh();
    assert.deepEqual(ui.patches, [{ customProperties: { minimum: { type: 'number', value: 2 }, instanceLimit: { type: 'number', value: 7 } } }]); assert.deepEqual(wrapper, before);
  });
} finally {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
}
console.log(`${passed}/${passed} property authoring checks passed.`);
