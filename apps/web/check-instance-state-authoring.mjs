import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hookUrl = asModule(`let scopes=new Map(),current='',index=0;
export const begin=scope=>{current=scope;index=0;if(!scopes.has(scope))scopes.set(scope,[]);};export const clear=()=>{scopes=new Map();};
export const useState=initial=>{const values=scopes.get(current),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};
export const useId=()=>'instance-authoring';export const useEffect=()=>{};export const useMemo=factory=>factory();`);
const portalUrl = asModule('export const createPortal=children=>children;');
const scriptUrl = asModule(`import React from ${JSON.stringify(reactUrl)};export default function ScriptEditor(props){return React.createElement('script-editor',{'data-completions':JSON.stringify(props.completions)});}`);
function loader(interactive = false) {
  const modules = new Map();
  return function url(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === './ScriptEditor' ? scriptUrl : interactive && dependency === 'react' ? hookUrl : interactive && dependency === 'react-dom' ? portalUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = asModule(code); modules.set(name, result); return result;
  };
}
const real = loader(), interactive = loader(true), hooks = await import(hookUrl);
const { DocumentProperties: StaticDocument } = await import(real('DocumentProperties'));
const { DocumentProperties } = await import(interactive('DocumentProperties'));
const { StateDefinitionsEditor } = await import(interactive('StateDefinitionsEditor'));
const { PropertyBindingsEditor } = await import(interactive('PropertyBindingsEditor'));
const { InputStateBindingEditor } = await import(interactive('InputStateBindingEditor'));
const { default: ComponentActionsEditor } = await import(interactive('ComponentActionsEditor'));
const { checkpoint, restoreHistory } = await import(real('canvasEditing'));
const noOp = () => {};
const declarations = { note: { type: 'string', value: 'Ready' }, count: { type: 'number', value: 0 }, armed: { type: 'boolean', value: false } };
const values = { session: { shared: 1 }, screen: { shared: 2 }, instance: { note: 'Ready', count: 0, armed: false } };
const label = { id: 'caption', type: 'label', x: 0, y: 0, width: 200, height: 40, props: { text: 'Caption' } };
const input = { id: 'quantity', type: 'numberInput', x: 0, y: 50, width: 200, height: 40, props: { fieldKey: 'quantity', min: 0, max: 100 } };
const template = { id: 'card', name: 'Card', width: 400, height: 300, parameters: {}, instanceState: declarations, components: [label, input] };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component, props) {
  hooks.clear(); let tree;
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Component, props)); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected instance authoring control'); return node; };
  const field = text => find(node => node.props?.['aria-label'] === text);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (text, value) => { field(text).props.onChange({ target: { value } }); refresh(); };
  const click = text => { button(text).props.onClick(); refresh(); };
  refresh(); return { refresh, find, field, button, change, click, all: () => nodes(tree) };
}
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('template document owns instance declarations while screen and popup expose only screen state', () => {
  const render = (document, isTemplate) => renderToStaticMarkup(React.createElement(StaticDocument, { document, isTemplate, onChange: noOp, notify: noOp }));
  const html = render(template, true); assert.match(html, /Private instance state defaults/); assert.match(html, /Edit instance state \(3\)/); assert.doesNotMatch(html, /Screen state defaults/);
  for (const kind of ['screen', 'popup']) { const html = render({ ...template, kind, state: declarations }, false); assert.match(html, /Screen state defaults/); assert.doesNotMatch(html, /Private instance state defaults/); }
});

check('typed private declaration edits apply once, preserve public parameters and undo atomically', () => {
  const original = { id: 'p', name: 'P', revision: 1, parameters: {}, screens: [], templates: [structuredClone(template)] };
  let project = structuredClone(original), history = { past: [], future: [] }; const patches = [];
  const ui = drive(DocumentProperties, { document: project.templates[0], isTemplate: true, notify: noOp, onChange: patch => {
    patches.push(patch); history = checkpoint(history, project); project = { ...project, templates: [{ ...project.templates[0], ...patch }] };
  } });
  ui.click('Edit instance state (3)'); ui.change('Private instance state property 1 default value', 'Changed'); ui.change('Private instance state property 2 default value', '12.25'); ui.change('Private instance state property 3 default value', 'true');
  assert.equal(patches.length, 0); ui.click('Apply instance state'); assert.equal(patches.length, 1); assert.deepEqual(Object.keys(patches[0]), ['instanceState']);
  assert.deepEqual(project.templates[0].instanceState, { note: { type: 'string', value: 'Changed' }, count: { type: 'number', value: 12.25 }, armed: { type: 'boolean', value: true } });
  assert.deepEqual(project.templates[0].parameters, {}); assert.equal(project.templates[0].state, undefined);
  const undone = restoreHistory(history, project, 'undo'); assert.deepEqual(undone.project, original); assert.deepEqual(restoreHistory(undone.history, undone.project, 'redo').project, project);
});

check('private declaration drafts cancel and cannot overwrite later external declaration changes', () => {
  const patches = [], props = { scope: 'instance', definitions: declarations, onChange: next => patches.push(next) };
  const ui = drive(StateDefinitionsEditor, props);
  ui.click('Edit instance state (3)'); ui.change('Private instance state property 1 default value', 'Discard'); ui.click('Cancel'); assert.deepEqual(patches, []);
  ui.click('Edit instance state (3)'); ui.change('Private instance state property 1 default value', 'Old edit');
  props.definitions = { ...declarations, note: { type: 'string', value: 'New external value' } }; ui.refresh(); ui.click('Apply instance state');
  assert.deepEqual(patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert' && React.Children.toArray(node.props.children).join('').includes('changed while')));
});

check('structured private state dependencies block rename, removal and type changes without blocking valid defaults', () => {
  const referenced = { ...template, components: [
    { ...label, props: { ...label.props, bindings: { text: { expression: 'v', references: { v: { kind: 'instanceState', key: 'note' } } } } } },
    { ...input, props: { ...input.props, stateBinding: { scope: 'instance', key: 'count' } } },
  ] };
  for (const action of ['rename', 'remove', 'type']) {
    const patches = [], ui = drive(DocumentProperties, { document: referenced, isTemplate: true, onChange: patch => patches.push(patch), notify: noOp });
    ui.click('Edit instance state (3)');
    if (action === 'rename') ui.change('Private instance state property 1 name', 'renamed');
    if (action === 'remove') { ui.field('Remove instance state property 2').props.onClick(); ui.refresh(); }
    if (action === 'type') { ui.change('Private instance state property 2 type', 'string'); }
    ui.click('Apply instance state'); assert.deepEqual(patches, []);
    assert.ok(ui.all().some(node => node.props?.role === 'alert' && React.Children.toArray(node.props.children).join('').includes('Update bindings')));
  }
  const patches = [], ui = drive(DocumentProperties, { document: referenced, isTemplate: true, onChange: patch => patches.push(patch), notify: noOp });
  ui.click('Edit instance state (3)'); ui.change('Private instance state property 2 default value', '2'); ui.click('Apply instance state'); assert.equal(patches[0].instanceState.count.value, 2);
});

check('invalid instance declarations are visible and cannot silently replace saved defaults', () => {
  const invalid = { scope: 'instance', definitions: { count: { type: 'number', value: 'not a number' } }, onChange: noOp };
  const ui = drive(StateDefinitionsEditor, invalid); assert.ok(ui.all().some(node => node.props?.role === 'alert')); assert.equal(ui.button('Edit instance state (0)').props.disabled, true);
});

globalThis.document = { body: {} };
function bindingEditor(state = values, component = label, extra = {}) {
  const patches = [], ui = drive(PropertyBindingsEditor, { component, components: [component, input], parameters: {}, tags: [], inputs: { quantity: 0 }, state,
    allowUnresolvedScreenState: true, onChange: patch => patches.push(patch), onGeometryChange: noOp, ...extra });
  const expression = value => { ui.find(node => node.type === 'textarea' && node.props.className === 'binding-expression').props.onChange({ target: { value } }); ui.refresh(); };
  return { ...ui, patches, expression };
}
check('component fx exposes and previews typed instance references only in a shared template context', () => {
  const ui = bindingEditor(); ui.field('Add Text binding').props.onClick(); ui.refresh(); ui.click('Add reference'); ui.change('Reference 1 source', 'instanceState'); ui.change('Reference 1 state property', 'count'); ui.expression('value');
  assert.equal(ui.find(node => node.type === 'output').props.children.join(''), '"0"'); ui.click('Apply');
  assert.equal(ui.patches[0].bindings.text.references.value.kind, 'instanceState');
  const root = bindingEditor({ session: {}, screen: {} }); root.field('Add Text binding').props.onClick(); root.refresh(); root.click('Add reference');
  assert.ok(!nodes(root.field('Reference 1 source')).some(node => node.type === 'option' && node.props.value === 'instanceState'));
  root.change('Reference 1 source', 'instanceState'); root.change('Reference 1 state property', 'count'); root.expression('value'); root.click('Apply'); assert.deepEqual(root.patches, []);
});

check('instance keys must be declared even when containing-screen declarations are deferred', () => {
  const ui = bindingEditor(); ui.field('Add Visible binding').props.onClick(); ui.refresh(); ui.click('Add reference'); ui.change('Reference 1 source', 'instanceState'); ui.change('Reference 1 state property', 'missing'); ui.expression('value'); ui.click('Apply'); assert.deepEqual(ui.patches, []);
  ui.change('Reference 1 state property', 'armed'); assert.equal(ui.find(node => node.type === 'output').props.children.join(''), 'false'); ui.click('Apply'); assert.equal(ui.patches[0].bindings.visible.references.value.key, 'armed');
});

check('input two-way instance binding filters compatible declared keys and is unavailable at screen root', () => {
  const patches = [], ui = drive(InputStateBindingEditor, { component: input, state: values, onChange: patch => patches.push(patch) });
  ui.field('Add Value binding').props.onClick(); ui.refresh(); ui.change('Value binding scope', 'instance');
  assert.equal(ui.field('Value binding state property').props.value, 'count');
  assert.deepEqual(ui.all().filter(node => node.type === 'datalist').flatMap(node => React.Children.toArray(node.props.children).map(child => child.props.value)), ['count']);
  ui.change('Value binding state property', 'armed'); ui.click('Apply'); assert.deepEqual(patches, []);
  ui.change('Value binding state property', 'count'); ui.click('Apply'); assert.deepEqual(patches, [{ stateBinding: { scope: 'instance', key: 'count' } }]);
  const rootPatches = [], root = drive(InputStateBindingEditor, { component: input, state: { session: {}, screen: {} }, allowUnresolvedScreenState: true, onChange: patch => rootPatches.push(patch) });
  root.field('Add Value binding').props.onClick(); root.refresh(); assert.ok(!nodes(root.field('Value binding scope')).some(node => node.type === 'option' && node.props.value === 'instance'));
  root.change('Value binding scope', 'instance'); root.change('Value binding state property', 'count'); root.click('Apply'); assert.deepEqual(rootPatches, []);
});

check('parameter fx reads only containing state and keeps child-private names unavailable', () => {
  const wrapper = { ...label, type: 'template', props: { templateId: 'child' } }, child = { ...template, id: 'child', parameters: { quantity: '0' }, parameterTypes: { quantity: 'number' } };
  const ui = bindingEditor(values, wrapper, { parameterTemplate: child }); ui.field('Add parameter quantity binding').props.onClick(); ui.refresh(); ui.click('Add reference');
  assert.deepEqual(nodes(ui.field('Reference 1 source')).filter(node => node.type === 'option').map(node => node.props.value), ['custom', 'input', 'parameter', 'sessionState', 'screenState', 'instanceState']);
  ui.change('Reference 1 source', 'instanceState'); ui.change('Reference 1 state property', 'childOnly'); ui.expression('value'); ui.click('Apply'); assert.deepEqual(ui.patches, []);
  ui.change('Reference 1 state property', 'count'); ui.click('Apply'); assert.equal(ui.patches[0].parameterBindings.quantity.references.value.kind, 'instanceState');
});

check('input event help describes private state only for template authoring', () => {
  for (const available of [false, true]) {
    const ui = drive(ComponentActionsEditor, { component: input, components: [input], screens: [], inputs: { quantity: 0 }, parameters: {}, instanceStateAvailable: available, onApply: noOp, onClose: noOp });
    ui.change('Event script language', 'javascript');
    const completions = JSON.parse(ui.find(node => node.type === 'script-editor').props['data-completions']);
    assert.equal(completions.find(item => item.label === 'app.state.get').detail.includes('instance'), available);
    assert.equal(ui.all().some(node => node.type === 'p' && React.Children.toArray(node.props.children).includes(", or this template's private instance state")), available);
  }
});
delete globalThis.document;

check('actual Designer wiring supplies a private preview scope only for a shared template', () => {
  const ast = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let argument, eventAttribute;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useApplicationState') argument = node.arguments[3]?.getText(ast);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'ComponentActionsEditor') eventAttribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'instanceStateAvailable')?.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(argument && eventAttribute);
  const value = new Function('editingTemplate', `return (${argument});`);
  assert.equal(value(undefined), undefined); assert.deepEqual(value({}), {}); assert.equal(value(template), declarations);
  const available = new Function('editingTemplate', `return (${eventAttribute});`); assert.equal(available(undefined), false); assert.equal(available(template), true);
});
console.log(`${checks}/${checks} instance-state authoring checks passed.`);
