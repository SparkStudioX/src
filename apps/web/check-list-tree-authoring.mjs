import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hookUrl = asModule(`export {Children,cloneElement,isValidElement} from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)};
export const createContext=initial=>{const context={value:initial};context.Provider=({value,children})=>{context.value=value;return children;};return context;};
export const useContext=context=>context.value;
export const useId=()=>"runtime-property-test";
let values=[],index=0;export const begin=()=>{index=0;};export const clear=()=>{values=[];index=0;};export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};export const useEffect=()=>{};`);
function loader(interactive = false) {
  const modules = new Map();
  return function moduleUrl(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url)); assert.ok(file, name);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(interactive && dependency === 'react' ? hookUrl : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const url = asModule(output); modules.set(name, url); return url;
  };
}
const modules = loader(), interactiveModules = loader(true);
const { ListTreeOptionsEditor, TablePageSizeEditor } = await import(modules('ListTreeOptionsEditor'));
const { ListTreeOptionsEditor: InteractiveOptions, TablePageSizeEditor: InteractivePageSize } = await import(interactiveModules('ListTreeOptionsEditor'));
const { validateListTreeOptions } = await import(modules('listTreeModel'));
const { isInput, resolveInputs, validateInputs } = await import(modules('inputs'));
const { isChart, defaultChartProps } = await import(modules('chartModel'));
const { isProcessDisplay } = await import(modules('processDisplays'));
const { iconNames } = await import(modules('Icon'));
const hooks = await import(hookUrl);
const noOp = () => {};
const make = (type = 'treeView') => ({ id: 'choices', type, x: 10, y: 10, width: 260, height: 200, props: { text: 'Equipment', fieldKey: 'equipment', defaultValue: 'child', options: [{ value: 'root', label: 'Plant' }, { value: 'child', label: 'Machine', ...(type === 'treeView' ? { parentValue: 'root' } : {}) }] } });
const nodes = node => !node || typeof node !== 'object' ? [] : node.type?.name === 'RuntimePropertyRow' ? nodes(node.type(node.props)) : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component, props) {
  hooks.clear(); let tree;
  const refresh = () => { hooks.begin(); tree = Component(props); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected list/tree authoring control'); return node; };
  const label = text => find(node => node.props?.['aria-label'] === text);
  const button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const change = (text, value) => { label(text).props.onChange({ target: { value } }); refresh(); };
  refresh(); return { refresh, find, label, button, change, all: () => nodes(tree) };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('list/tree definitions have row editors and plain summaries without raw JSON fields', () => {
  for (const type of ['list', 'treeView']) {
    const html = renderToStaticMarkup(React.createElement(ListTreeOptionsEditor, { component: make(type), onChange: noOp, notify: noOp }));
    assert.match(html, /Edit options/); assert.match(html, /stages its exact value/); assert.doesNotMatch(html, /textarea|JSON|<ul|<ol/);
    assert.match(html, /class="property-sheet-row[^"]*" data-property="options"/); assert.match(html, /data-property="defaultValue"/);
  }
});

check('list and tree collection dialogs discard staged edits when closed from the title bar', () => {
  for (const type of ['list', 'treeView']) {
    const patches = [], ui = drive(InteractiveOptions, { component: make(type), onChange: patch => patches.push(patch), notify: noOp });
    ui.button('Edit options').props.onClick(); ui.refresh(); ui.change('Option 1 label', 'Unsaved');
    ui.find(node => node.type?.name === 'PropertyCollectionDialog').props.onClose(); ui.refresh(); assert.deepEqual(patches, []);
    ui.button('Edit options').props.onClick(); ui.refresh(); assert.equal(ui.label('Option 1 label').props.value, 'Plant');
  }
});

check('renaming tree values preserves exact strings, parent links and the selected default in one Apply', () => {
  const component = make(), before = structuredClone(component), patches = [];
  const ui = drive(InteractiveOptions, { component, onChange: patch => patches.push(patch), notify: noOp });
  ui.button('Edit options').props.onClick(); ui.refresh();
  ui.change('Option 1 value', '  Plant {area}  '); ui.change('Option 2 value', '  Machine {id}  ');
  assert.deepEqual(patches, []); ui.button('Apply options').props.onClick(); ui.refresh();
  assert.deepEqual(patches, [{ options: [{ value: '  Plant {area}  ', label: 'Plant' }, { value: '  Machine {id}  ', label: 'Machine', parentValue: '  Plant {area}  ' }], defaultValue: '  Machine {id}  ' }]);
  assert.deepEqual(component, before);
});

check('cycles, duplicate values and blank labels cannot overwrite saved options', () => {
  const patches = [], errors = [], ui = drive(InteractiveOptions, { component: make(), onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.button('Edit options').props.onClick(); ui.refresh();
  const childId = nodes(ui.label('Option 1 parent')).find(node => node.type === 'option' && node.props.value !== '')?.props.value;
  ui.change('Option 1 parent', String(childId)); ui.button('Apply options').props.onClick(); ui.refresh();
  ui.change('Option 1 parent', ''); ui.change('Option 2 value', 'root'); ui.button('Apply options').props.onClick(); ui.refresh();
  ui.change('Option 2 value', 'child'); ui.change('Option 2 label', ' '); ui.button('Apply options').props.onClick(); ui.refresh();
  assert.equal(errors.length, 3); assert.deepEqual(patches, []);
  ui.button('Cancel').props.onClick(); ui.refresh(); assert.deepEqual(patches, []);
});

check('removing a parent requires explicit reparenting and removing the default requires explicit reselection', () => {
  const patches = [], errors = [], ui = drive(InteractiveOptions, { component: make(), onChange: patch => patches.push(patch), notify: (...args) => errors.push(args) });
  ui.button('Edit options').props.onClick(); ui.refresh(); ui.label('Remove option 1').props.onClick(); ui.refresh();
  ui.button('Apply options').props.onClick(); ui.refresh(); assert.deepEqual(patches, []); assert.match(errors[0][0], /existing parent/);
  ui.change('Option 1 parent', ''); ui.button('Apply options').props.onClick(); ui.refresh(); assert.deepEqual(patches, [{ options: [{ value: 'child', label: 'Machine' }], defaultValue: 'child' }]);
  const secondPatches = [], list = drive(InteractiveOptions, { component: make('list'), onChange: patch => secondPatches.push(patch), notify: noOp });
  list.button('Edit options').props.onClick(); list.refresh(); list.label('Remove option 2').props.onClick(); list.refresh(); list.button('Apply options').props.onClick(); list.refresh(); assert.deepEqual(secondPatches, []);
  const rootId = nodes(list.label('Default option')).find(node => node.type === 'option' && React.Children.toArray(node.props.children).join('').startsWith('Plant')).props.value;
  list.change('Default option', String(rootId)); list.button('Apply options').props.onClick(); assert.equal(secondPatches[0].defaultValue, 'root');
});

check('tree depth and option count limits are enforced without truncation', () => {
  const component = make(); component.props.options = Array.from({ length: 17 }, (_, index) => ({ value: `n${index}`, label: `Node ${index}`, ...(index ? { parentValue: `n${index - 1}` } : {}) })); component.props.defaultValue = 'n0';
  const patches = [], ui = drive(InteractiveOptions, { component, onChange: patch => patches.push(patch), notify: noOp });
  ui.button('Edit options').props.onClick(); ui.refresh(); ui.button('Apply options').props.onClick(); ui.refresh(); assert.deepEqual(patches, []);
  assert.ok(ui.all().some(node => node.props?.role === 'alert' && String(node.props.children).includes('16 levels')));
  ui.label('Remove option 17').props.onClick(); ui.refresh(); ui.button('Apply options').props.onClick(); assert.equal(patches[0].options.length, 16);
  const list = make('list'); list.props.options = [{ value: 'one', label: 'One' }]; list.props.defaultValue = 'one';
  const options = drive(InteractiveOptions, { component: list, onChange: noOp, notify: noOp }); options.button('Edit options').props.onClick(); options.refresh(); assert.equal(options.label('Remove option 1').props.disabled, true);
  for (let index = 1; index < 100; index++) { options.button('Add option').props.onClick(); options.refresh(); }
  assert.equal(options.button('Add option').props.disabled, true);
});

check('table page size defaults to 25 and invalid draft numbers never clamp into project data', () => {
  const html = renderToStaticMarkup(React.createElement(TablePageSizeEditor, { onChange: noOp, notify: noOp })); assert.match(html, /value="25"/);
  const changes = [], errors = [], ui = drive(InteractivePageSize, { onChange: value => changes.push(value), notify: (...args) => errors.push(args) });
  for (const value of ['', '0', '101', '1.5', '9007199254740993']) { ui.change('Table rows per page', value); ui.label('Table rows per page').props.onBlur(); ui.refresh(); }
  assert.deepEqual(changes, []); assert.equal(errors.length, 5);
  ui.change('Table rows per page', '100'); ui.label('Table rows per page').props.onBlur(); assert.deepEqual(changes, [100]);
});

const appSource = fs.readFileSync(new URL('src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX), declarations = new Map(), expressions = [];
function visit(node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer.getText(ast)); if (ts.isJsxExpression(node) && node.expression) expressions.push(node.expression.getText(ast)); ts.forEachChild(node, visit); }
visit(ast);
check('actual palette factories create valid selected list/tree forms and tables with a bounded page size', () => {
  const script = ts.transpileModule(`const processDimensions=${declarations.get('processDimensions')};const palettes=${declarations.get('palettes')};const typeIcon=${declarations.get('typeIcon')};const addComponent=${declarations.get('addComponent')};return {palettes,typeIcon,addComponent};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let screen = { id: 'screen', width: 1000, height: 700, components: [] };
  const factory = new Function('screen', 'project', 'editingTemplate', 'availableTemplates', 'notify', 'id', 'assets', 'queries', 'isInput', 'isTemplateInstance', 'updateScreen', 'setSelectedId', 'isProcessDisplay', 'isChart', 'defaultChartProps', script)(screen, { screens: [screen], templates: [] }, undefined, [], noOp, value => value, [], [], isInput, type => type === 'template' || type === 'repeater', update => { screen = update(screen); }, noOp, isProcessDisplay, isChart, defaultChartProps);
  for (const type of ['list', 'treeView', 'table']) { assert.ok(factory.palettes.some(item => item.type === type)); assert.ok(iconNames.includes(factory.typeIcon[type])); factory.addComponent(type); }
  const [list, tree, table] = screen.components;
  for (const component of [list, tree]) { assert.ok(isInput(component.type)); assert.ok(component.height >= 200); validateListTreeOptions(component.type, component.props.options); assert.ok(component.props.options.some(option => option.value === component.props.defaultValue)); }
  assert.equal(table.props.pageSize, 25); assert.equal(validateInputs(screen, resolveInputs(screen, [], {}), {}), null);
});

function authoredExpression(text, selected, updateProps, screen = { components: [] }) {
  const details = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'InspectorDetails'); assert.ok(details);
  const script = ts.transpileModule(`${details.getText(ast)}\nconst body=(${text});return body;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function('React', 'Field', 'selected', 'queries', 'updateProps', 'screen', 'isInput', script)(React, ({ children }) => children, selected, [{ id: 'read', kind: 'query' }], updateProps, screen, isInput);
}
check('actual option-source controls give only tree queries a parent column and retain static options on switch', () => {
  const sourceExpression = expressions.find(text => text.startsWith('["select", "list", "treeView"].includes(selected.type) && <Field designTime label="Option source"'));
  assert.ok(sourceExpression);
  for (const type of ['select', 'list', 'treeView']) {
    const component = make(type), patches = [], tree = authoredExpression(sourceExpression, component, patch => patches.push(patch));
    const select = nodes(tree).find(node => node.type === 'select'); select.props.onChange({ target: { value: 'query' } });
    assert.equal(patches[0].optionsSource.parentColumn, type === 'treeView' ? 'parent_id' : undefined); assert.equal(patches[0].defaultValue, ''); assert.equal(patches[0].selectionFields, undefined);
    select.props.onChange({ target: { value: 'static' } }); assert.equal(patches[1].optionsSource, undefined); assert.equal(patches[1].defaultValue, component.props.options[0].value); assert.ok(!Object.hasOwn(patches[1], 'options'));
  }
});

check('query properties expose parent and selection mapping controls in list/tree scopes', () => {
  const queryExpression = expressions.find(text => text.startsWith('["select", "list", "treeView"].includes(selected.type) && selected.props.optionsSource &&'));
  assert.ok(queryExpression);
  for (const type of ['list', 'treeView']) {
    const component = make(type); component.props.optionsSource = { queryId: 'read', valueColumn: 'id', labelColumn: 'name', ...(type === 'treeView' ? { parentColumn: 'parent_id' } : {}) };
    const patches = [], other = { id: 'notes', type: 'textInput', props: { fieldKey: 'notes', text: 'Notes' } };
    const tree = authoredExpression(queryExpression, component, patch => patches.push(patch), { components: [component, other] });
    assert.equal(nodes(tree).some(node => node.props?.['aria-label'] === 'Tree parent column'), type === 'treeView');
    const mapping = nodes(tree).find(node => node.props?.label === 'Notes'); assert.ok(mapping);
    nodes(mapping).find(node => node.type === 'input').props.onChange({ target: { value: 'description' } }); assert.deepEqual(patches[0], { selectionFields: { notes: 'description' } });
  }
});

// Exercise the actual App helper with the same staged React harness used above.
const optionsDeclaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'OptionsEditor'); assert.ok(optionsDeclaration);
const optionsScript = ts.transpileModule(`${optionsDeclaration.getText(ast)}\nreturn OptionsEditor;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
const { PropertyCollectionDialog } = await import(interactiveModules('PropertyCollectionEditor'));
const { RuntimePropertyRow } = await import(interactiveModules('RuntimePropertyRow'));
const SelectionOptions = new Function('React', 'useState', 'PropertyCollectionDialog', 'RuntimePropertyRow', optionsScript)(React, hooks.useState, PropertyCollectionDialog, RuntimePropertyRow);
function selectionOptions(type = 'select', props = {}) {
  const component = make(type); component.props = { ...component.props, ...props }; const before = structuredClone(component), patches = [];
  const ui = drive(SelectionOptions, { component, onChange: patch => patches.push(patch) });
  const click = text => { ui.button(text).props.onClick(); ui.refresh(); };
  click('Edit options'); return { ...ui, click, component, before, patches };
}
check('dropdown and radio options accept the gateway label and value boundaries in one staged Apply', () => {
  for (const type of ['select', 'radioGroup']) {
    const value = 'v'.repeat(4096), label = 'L'.repeat(200), ui = selectionOptions(type, { defaultValue: value });
    ui.change('Option definitions', `${label} | ${value}`); assert.deepEqual(ui.patches, []);
    ui.click('Apply options'); assert.deepEqual(ui.patches, [{ options: [{ label, value }] }]); assert.deepEqual(ui.component, ui.before);
    assert.ok(!ui.all().some(node => node.type === PropertyCollectionDialog));
  }
});
check('selection collections reject overlong, empty and duplicate entries without truncation or mutation', () => {
  for (const text of [`${'L'.repeat(201)} | child`, `Label | ${'v'.repeat(4097)}`, ' | child', 'Label | ', 'First | child\nSecond | child', '', Array.from({ length: 101 }, (_, index) => `Choice ${index} | ${index}`).join('\n')]) {
    const ui = selectionOptions(); ui.change('Option definitions', text); ui.click('Apply options');
    assert.deepEqual(ui.patches, []); assert.deepEqual(ui.component, ui.before);
    assert.ok(ui.all().some(node => node.props?.role === 'alert')); assert.equal(ui.label('Option definitions').props.value, text);
  }
  const ui = selectionOptions('radioGroup', { defaultValue: '0' });
  ui.change('Option definitions', Array.from({ length: 100 }, (_, index) => `Choice ${index} | ${index}`).join('\n')); ui.click('Apply options');
  assert.equal(ui.patches[0].options.length, 100);
});
check('every declared default must match exactly while an omitted default stays omitted', () => {
  for (const defaultValue of ['', 0, false, null, 'missing', 'Child']) {
    const ui = selectionOptions('select', { defaultValue }); ui.change('Option definitions', 'Machine | child'); ui.click('Apply options');
    assert.deepEqual(ui.patches, []); assert.match(ui.find(node => node.props?.role === 'alert').props.children, /default value must match/);
  }
  const ui = selectionOptions('radioGroup', { defaultValue: undefined }); ui.change('Option definitions', 'Lower | child\nUpper | Child'); ui.click('Apply options');
  assert.deepEqual(ui.patches, [{ options: [{ label: 'Lower', value: 'child' }, { label: 'Upper', value: 'Child' }] }]);
});
check('selection collection Cancel and title-bar close discard drafts and reopen the saved choices', () => {
  for (const close of ['Cancel', 'title']) {
    const ui = selectionOptions(); ui.change('Option definitions', 'Unsaved | child');
    if (close === 'Cancel') ui.click('Cancel'); else { ui.find(node => node.type === PropertyCollectionDialog).props.onClose(); ui.refresh(); }
    assert.deepEqual(ui.patches, []); assert.deepEqual(ui.component, ui.before); ui.click('Edit options');
    assert.equal(ui.label('Option definitions').props.value, 'Plant | root\nMachine | child');
  }
});

console.log(`${passed}/${passed} list/tree and selection authoring checks passed.`);
