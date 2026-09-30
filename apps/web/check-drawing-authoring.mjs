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
export const useRef=initial=>{const values=scopes.get(current),at=index++;return values[at]??={current:initial};};export const useId=()=>'drawing-test';export const useEffect=()=>{};export const useMemo=run=>run();`);
const portalUrl = asModule('export const createPortal=children=>children;');
const scriptUrl = asModule('export default function ScriptEditor(){return null;}');
function loader(interactive = false) {
  const modules = new Map();
  return function url(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(interactive && dependency === 'react' ? hookUrl : interactive && dependency === 'react-dom' ? portalUrl : interactive && dependency === './ScriptEditor' ? scriptUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = asModule(code); modules.set(name, result); return result;
  };
}
const real = loader(), interactive = loader(true), hooks = await import(hookUrl);
const { DrawingEditor } = await import(real('DrawingEditor'));
const { DrawingEditor: Editor } = await import(interactive('DrawingEditor'));
const { PropertyBindingsEditor } = await import(real('PropertyBindingsEditor'));
const { PropertyBindingsEditor: Bindings } = await import(interactive('PropertyBindingsEditor'));
const { default: ActionsEditor } = await import(interactive('ComponentActionsEditor'));
const { drawingTypes, drawingDefaults, validateDrawingProps, supportsDrawingProperty } = await import(real('drawingComponents'));
const { checkpoint, restoreHistory } = await import(real('canvasEditing'));
const { isChart, defaultChartProps } = await import(real('chartModel'));
const { isInput } = await import(real('inputs'));
const { isProcessDisplay } = await import(real('processDisplays'));
const { iconNames } = await import(real('Icon'));
const noOp = () => {}, make = (type = 'polyline', props = {}) => ({ id: 'drawing', type, x: 20, y: 30, width: 260, height: 180, props: { ...drawingDefaults(type), text: 'Equipment route', ...props } });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(component, Component = Editor, commit = noOp, extra = {}) {
  hooks.clear(); let tree;
  const patches = [], errors = [], props = { component, components: [component], tags: [], parameters: {}, inputs: {}, onGeometryChange: noOp,
    onChange: patch => { patches.push(patch); commit(patch); }, onApply: patch => patches.push(patch), onClose: noOp,
    notify: message => errors.push(message), ...extra };
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Component, props)); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected drawing authoring control'); return node; };
  const field = label => find(node => node.props?.['aria-label'] === label);
  const input = key => find(node => node.props?.id?.endsWith(`-property-${key}`));
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (label, value) => { find(node => node.props?.['aria-label'] === label && typeof node.props.onChange === 'function').props.onChange({ target: { value, checked: value } }); refresh(); };
  const click = text => { button(text).props.onClick(); refresh(); };
  refresh(); return { refresh, find, field, input, button, change, click, patches, errors, all: () => nodes(tree) };
}
const source = fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8'), ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const declarations = new Map(), expressions = [], inspectorEditors = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer.getText(ast));
  if (ts.isJsxExpression(node) && node.expression) expressions.push(node.expression.getText(ast));
  if (ts.isJsxSelfClosingElement(node) && ['PropertyBindingsEditor', 'DrawingEditor'].includes(node.tagName.getText(ast))) inspectorEditors.set(node.tagName.getText(ast), node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
let checks = 0; function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('drawing collection rows open an accessible dialog and native Escape discards staged geometry', () => {
  for (const [type, property, trigger, field] of [['polyline', 'points', 'Edit points', 'Point 1 X'], ['rectangle', 'cornerRadius', 'Edit corners', 'Rectangle corner radius'], ['equipmentSymbol', 'symbol', 'Choose symbol', 'Equipment symbol']]) {
    const ui = drive(make(type));
    const row = ui.find(node => node.props?.['data-property'] === property); assert.match(row.props.className, /property-sheet-row/);
    assert.equal(React.Children.toArray(row.props.children).length, 3); assert.ok(!ui.all().some(node => node.type === 'dialog'));
    ui.click(trigger); ui.change(field, type === 'equipmentSymbol' ? 'motor' : '12');
    const dialog = ui.find(node => node.type === 'dialog'); assert.ok(dialog.props['aria-label']); let prevented = false, stopped = false;
    dialog.props.onKeyDown({ key: 'z', ctrlKey: true, stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
    dialog.props.onCancel({ preventDefault() { prevented = true; } }); ui.refresh();
    assert.equal(prevented, true); assert.deepEqual(ui.patches, []); assert.ok(!ui.all().some(node => node.type === 'dialog'));
  }
});

check('actual sibling inspector editors have distinct stable identities through Apply, Undo and reselection', () => {
  assert.equal(inspectorEditors.size, 2);
  const code = ts.transpileModule(`return [${inspectorEditors.get('PropertyBindingsEditor')}, ${inspectorEditors.get('DrawingEditor')}];`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  const render = new Function('React', 'PropertyBindingsEditor', 'DrawingEditor', 'selected', 'screen', 'tags', 'editorParameters', 'currentPreviewInputs', 'connected', 'updateProps', 'updateComponent', 'notify', 'applicationState', 'editingTemplate', 'project', 'queries', code);
  const keys = component => render(React, 'bindings-editor', 'drawing-editor', component, { components: [component] }, [], {}, {}, true, noOp, noOp, noOp, { values: { session: {}, screen: {} } }, false, { templates: [] }, []).map(editor => editor.key);
  const original = make(), selectedKeys = keys(original);
  assert.equal(new Set(selectedKeys).size, 2, 'Sibling editors must not share a React key');
  const applied = { ...original, props: { ...original.props, points: [{ x: 0, y: 25 }, { x: 100, y: 75 }] } };
  assert.deepEqual(keys(applied), selectedKeys); assert.deepEqual(keys(structuredClone(original)), selectedKeys);
  const otherKeys = keys({ ...original, id: 'another-drawing' }); assert.equal(new Set(otherKeys).size, 2);
  assert.ok(otherKeys.every(key => !selectedKeys.includes(key)), 'Changing selection resets each editor independently');
  assert.deepEqual(keys(original), selectedKeys, 'Reselecting the drawing preserves its two independent key identities');
});

check('actual palette factories create all six drawings with bounded dimensions, canonical defaults and distinct icons', () => {
  const code = ts.transpileModule(`const processDimensions=${declarations.get('processDimensions')};const palettes=${declarations.get('palettes')};const typeIcon=${declarations.get('typeIcon')};const addComponent=${declarations.get('addComponent')};return {palettes,typeIcon,addComponent};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let screen = { id: 'main', width: 1000, height: 700, components: [] };
  const factory = new Function('screen', 'project', 'editingTemplate', 'availableTemplates', 'notify', 'id', 'assets', 'queries', 'isInput', 'isTemplateInstance', 'updateScreen', 'setSelectedId', 'isProcessDisplay', 'isChart', 'defaultChartProps', code)(screen, { screens: [screen], templates: [] }, false, [], noOp, type => type, [], [], isInput, () => false, update => { screen = update(screen); }, noOp, isProcessDisplay, isChart, defaultChartProps);
  for (const type of drawingTypes) {
    assert.ok(factory.palettes.some(item => item.type === type)); assert.ok(iconNames.includes(factory.typeIcon[type])); factory.addComponent(type);
    const component = screen.components.at(-1); assert.equal(validateDrawingProps(type, component.props), null);
    const { text, ...props } = component.props; assert.ok(text); assert.deepEqual(props, drawingDefaults(type));
    assert.ok(component.width >= 100 && component.height >= 60 && component.width <= screen.width && component.height <= screen.height);
    assert.equal(isInput(type), false); assert.ok(!component.props.action && !component.props.tagPath && !component.props.fieldKey && !component.props.events);
  }
  assert.equal(new Set(drawingTypes.map(type => factory.typeIcon[type])).size, 6);
});

check('every supported drawing scalar appears once with an fx control and correct inert defaults', () => {
  const fields = ['strokeColor', 'fillColor', 'strokeWidth', 'rotation', 'flowing', 'flowReverse', 'active'];
  for (const type of drawingTypes) {
    const component = make(type), html = renderToStaticMarkup(React.createElement(PropertyBindingsEditor, { component, components: [component], tags: [], parameters: {}, inputs: {}, onChange: noOp, onGeometryChange: noOp }));
    const rows = [...html.matchAll(/data-property="([^"]+)"/g)].map(match => match[1]);
    for (const field of fields) assert.equal(rows.filter(value => value === field).length, Number(supportsDrawingProperty(type, field)), `${type}.${field}`);
    assert.equal((html.match(/class="property-bind-button"/g) || []).length, rows.length); assert.match(html, /Accessible label/);
    for (const field of ['flowing', 'flowReverse', 'active']) assert.doesNotMatch(html, new RegExp(`property-${field}"[^>]*checked=""`));
    if (type === 'rectangle' || type === 'ellipse') { assert.match(html, /property-fillColor"[^>]*value="none"/); assert.doesNotMatch(html, /role="alert"/); }
    assert.ok(!rows.includes('tagPath') && !rows.includes('stateValue') && !rows.includes('value'));
  }
});

check('moving, inserting and reordering points saves exact fractions as one undoable patch', () => {
  const component = make(), before = structuredClone(component), original = { id: 'p', name: 'P', revision: 7, parameters: {}, screens: [{ id: 's', name: 'S', width: 1000, height: 700, components: [component] }] };
  let project = structuredClone(original), history = { past: [], future: [] };
  const ui = drive(component, Editor, patch => { history = checkpoint(history, project); project = { ...project, screens: [{ ...project.screens[0], components: [{ ...component, props: { ...component.props, ...patch } }] }] }; });
  ui.click('Edit points'); ui.change('Point 1 X', '12.125'); ui.change('Point 1 Y', '90.75');
  ui.field('Insert point after 1').props.onClick(); ui.refresh(); assert.equal(ui.field('Point 2 X').props.value, '31.0625');
  ui.field('Move point 2 later').props.onClick(); ui.refresh(); ui.field('Remove point 5').props.onClick(); ui.refresh();
  assert.deepEqual(ui.patches, []); ui.click('Apply points');
  assert.deepEqual(ui.patches, [{ points: [{ x: 12.125, y: 90.75 }, { x: 50, y: 100 }, { x: 31.0625, y: 95.375 }, { x: 50, y: 0 }] }]);
  assert.deepEqual(component, before); assert.equal(history.past.length, 1);
  const undone = restoreHistory(history, project, 'undo'); assert.deepEqual(undone.project, original); assert.deepEqual(restoreHistory(undone.history, undone.project, 'redo').project, project);
});

check('Cancel and Escape discard local point edits; Ctrl+S applies the validated draft once', () => {
  const component = make('pipe'), before = structuredClone(component), ui = drive(component);
  ui.click('Edit points'); ui.change('Point 1 X', '12'); ui.click('Cancel'); ui.click('Edit points'); assert.equal(ui.field('Point 1 X').props.value, '0');
  ui.change('Point 2 Y', '25'); ui.field('Edit drawing points').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); ui.refresh(); assert.deepEqual(ui.patches, []);
  ui.click('Edit points'); ui.change('Point 2 Y', '75'); let stopped = 0, prevented = 0;
  ui.field('Edit drawing points').props.onKeyDown({ key: 's', ctrlKey: true, preventDefault() { prevented++; }, stopPropagation() { stopped++; } }); ui.refresh();
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.deepEqual(ui.patches, [{ points: [{ x: 0, y: 50 }, { x: 100, y: 75 }] }]); assert.deepEqual(component, before);
});

check('blank, out-of-range, nonfinite and duplicate point drafts cannot overwrite a valid route', () => {
  const ui = drive(make('line')); ui.click('Edit points');
  for (const value of ['', '-1', '100.001', '1e999', 'NaN']) { ui.change('Point 2 X', value); assert.equal(ui.button('Apply points').props.disabled, true); ui.click('Apply points'); }
  ui.change('Point 2 X', '0'); ui.click('Apply points'); assert.match(ui.errors.at(-1), /different/); assert.deepEqual(ui.patches, []);
  ui.change('Point 2 X', '0.00001'); ui.click('Apply points'); assert.equal(ui.patches[0].points[1].x, 0.00001);
  assert.equal(ui.errors.length, 6);
});

check('lines keep two endpoints and route editors enforce the two-to-sixty-four point bounds', () => {
  const line = drive(make('line')); line.click('Edit points'); assert.equal(line.all().filter(node => /^Point \d+ X$/.test(node.props?.['aria-label'] || '')).length, 2); assert.ok(!line.all().some(node => node.type === 'button' && /Add point|Remove|Insert/.test(String(node.props.children))));
  const pipe = drive(make('pipe')); pipe.click('Edit points'); assert.equal(pipe.field('Remove point 1').props.disabled, true); pipe.click('Add point'); assert.equal(pipe.field('Point 3 X').props.value, '90'); assert.equal(pipe.field('Remove point 1').props.disabled, false);
  const points = Array.from({ length: 64 }, (_, index) => ({ x: index, y: index % 2 ? 100 : 0 })), limited = drive(make('polyline', { points })); limited.click('Edit points');
  assert.equal(limited.button('Add point').props.disabled, true); limited.click('Add point'); assert.equal(limited.all().filter(node => /^Point \d+ X$/.test(node.props?.['aria-label'] || '')).length, 64); assert.equal(limited.field('Insert point after 1').props.disabled, true);
});

check('rectangle radius and built-in symbol choices apply only their structural field', () => {
  const rectangle = drive(make('rectangle')); rectangle.click('Edit corners');
  for (const radius of ['', '-0.1', '50.1', '1e999']) { rectangle.change('Rectangle corner radius', radius); rectangle.click('Apply corners'); }
  assert.deepEqual(rectangle.patches, []); rectangle.change('Rectangle corner radius', '12.125'); rectangle.click('Apply corners'); assert.deepEqual(rectangle.patches, [{ cornerRadius: 12.125 }]);
  const symbol = drive(make('equipmentSymbol')); symbol.click('Choose symbol'); assert.deepEqual(symbol.all().filter(node => node.type === 'option').map(node => node.props.value), ['pump', 'valve', 'motor']);
  symbol.change('Equipment symbol', 'motor'); symbol.click('Apply symbol'); assert.deepEqual(symbol.patches, [{ symbol: 'motor' }]);
  const html = renderToStaticMarkup(React.createElement(DrawingEditor, { component: make(), onChange: noOp, notify: noOp })); assert.doesNotMatch(html, /<textarea|JSON|markup/); assert.match(html, /0 to 100%/);
});

check('stroke-width and rotation number inputs reject invalid drafts without rounding or clamping', () => {
  const ui = drive(make('rectangle'), Bindings);
  for (const [key, values] of [['strokeWidth', ['0', '32.1', '1e999']], ['rotation', ['-1', '360.1', 'NaN']]]) {
    for (const value of values) { ui.input(key).props.onChange({ target: { value } }); ui.refresh(); ui.input(key).props.onBlur(); ui.refresh(); }
    assert.deepEqual(ui.patches, []);
  }
  ui.input('strokeWidth').props.onChange({ target: { value: '2.125' } }); ui.refresh(); ui.input('strokeWidth').props.onBlur(); ui.refresh();
  ui.input('rotation').props.onChange({ target: { value: '180.5' } }); ui.refresh(); ui.input('rotation').props.onBlur(); ui.refresh();
  assert.deepEqual(ui.patches, [{ strokeWidth: 2.125 }, { rotation: 180.5 }]);
});

check('static pipe flow fields and symbol active values preserve Boolean types', () => {
  const pipe = drive(make('pipe'), Bindings); assert.equal(pipe.input('flowing').props.checked, false); assert.equal(pipe.input('flowReverse').props.checked, false);
  pipe.input('flowing').props.onChange({ target: { checked: true } }); pipe.input('flowReverse').props.onChange({ target: { checked: true } }); assert.deepEqual(pipe.patches, [{ flowing: true }, { flowReverse: true }]);
  const symbol = drive(make('equipmentSymbol'), Bindings); assert.equal(symbol.input('active').props.checked, false); symbol.input('active').props.onChange({ target: { checked: true } }); assert.deepEqual(symbol.patches, [{ active: true }]);
});

const previousDocument = globalThis.document; globalThis.document = { body: {} };
try {
  check('binding dialogs enforce drawing scalar types, allow unfilled shapes and default state bindings to false', () => {
    const ui = drive(make('rectangle'), Bindings); ui.field('Add Stroke width binding').props.onClick(); ui.refresh();
    const expression = () => ui.find(node => node.type === 'textarea' && node.props.id?.endsWith('-expression'));
    for (const value of ["'12'", '0', '33']) { expression().props.onChange({ target: { value } }); ui.refresh(); ui.click('Apply'); }
    assert.deepEqual(ui.patches, []); expression().props.onChange({ target: { value: '12.25' } }); ui.refresh(); ui.click('Apply'); assert.equal(ui.patches[0].bindings.strokeWidth.expression, '12.25');
    ui.field('Add Fill color binding').props.onClick(); ui.refresh(); expression().props.onChange({ target: { value: "'none'" } }); ui.refresh(); ui.click('Apply'); assert.equal(ui.patches[1].bindings.fillColor.expression, "'none'");
    const symbol = drive(make('equipmentSymbol'), Bindings); symbol.field('Add Active binding').props.onClick(); symbol.refresh(); assert.equal(symbol.find(node => node.type === 'textarea').props.value, 'false'); symbol.click('Apply'); assert.equal(symbol.patches[0].bindings.active.expression, 'false');
  });
} finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }

check('unified equipment action controls offer None, navigation and popup, validate overrides and clear old targets on Apply', () => {
  const screens = [{ id: 'main', name: 'Main' }, { id: 'detail', name: 'Detail', kind: 'popup', parameters: { machine: '' } }];
  const ui = drive(make('equipmentSymbol'), ActionsEditor, noOp, { screens });
  const select = ui.field('Click action');
  assert.equal(select.props.value, ''); assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => node.props.value), ['', 'navigate', 'openPopup']);
  assert.ok(!ui.all().some(node => node.props?.['aria-label'] === 'Action destination'));
  for (const [action, expected] of [['navigate', 'main'], ['openPopup', 'detail']]) {
    ui.change('Click action', action);
    assert.deepEqual(nodes(ui.field('Action destination')).filter(node => node.type === 'option').map(node => node.props.value), ['', expected]);
  }
  ui.change('Action destination', 'detail'); ui.change('Popup parameter overrides', '{"unknown":"x"}'); ui.click('Apply actions & events');
  assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert' && /declared/.test(node.props.children)));
  ui.change('Popup parameter overrides', '{"machine":"P-1"}'); ui.click('Apply actions & events');
  assert.equal(ui.patches[0].action, 'openPopup'); assert.equal(ui.patches[0].targetScreenId, 'detail'); assert.deepEqual(ui.patches[0].parameters, { machine: 'P-1' });
  const cleared = drive(make('equipmentSymbol', ui.patches[0]), ActionsEditor, noOp, { screens });
  cleared.change('Click action', ''); cleared.click('Apply actions & events');
  assert.equal(cleared.patches[0].action, undefined); assert.equal(cleared.patches[0].targetScreenId, undefined); assert.equal(cleared.patches[0].parameters, undefined);
});

console.log(`${checks} drawing authoring checks passed.`);
