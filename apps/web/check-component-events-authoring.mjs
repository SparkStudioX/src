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
export const useId=()=>'component-events-authoring';export const useEffect=()=>{};export const useMemo=factory=>factory();`);
const scriptUrl = asModule(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};export default function ScriptEditor(props){return React.createElement('script-editor',props);}`);
const modules = new Map();
function url(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === './ScriptEditor' ? scriptUrl : dependency === 'react' ? hookUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl), { default: Editor } = await import(url('ComponentLifecycleEditor'));
const { componentEventProperties } = await import(url('componentEventModel'));
const { checkpoint, restoreHistory } = await import(url('canvasEditing'));
const base = { id: 'caption', type: 'label', x: 10, y: 20, width: 200, height: 40, props: { text: 'Caption' } };
const input = { ...base, id: 'amount', type: 'numberInput', props: { fieldKey: 'amount', min: 0, max: 100 } };
const secret = { ...base, id: 'password', type: 'passwordInput', props: { fieldKey: 'password' } };
const script = code => ({ language: 'javascript', code });
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(component = base, extra = {}) {
  hooks.clear(); let tree; const applied = [], closed = [];
  const props = { component, components: [base, input, secret], inputs: { amount: 12, password: 'must-not-leak' }, parameters: { station: 'A' }, onApply: value => applied.push(value), onClose: () => closed.push(true), ...extra };
  function expand(node, path = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') { hooks.begin(`${path}:${node.type.name}:${node.key || ''}`); return expand(node.type(node.props), `${path}:${node.type.name}`); }
    return { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map((child, index) => expand(child, `${path}:${child?.key || index}`)) } };
  }
  const refresh = () => { tree = expand(React.createElement(Editor, props)); };
  const all = () => nodes(tree), find = predicate => { const node = all().find(predicate); assert.ok(node, 'Expected component event editor control'); return node; };
  const field = name => find(node => node.props?.['aria-label'] === name);
  const click = name => { find(node => node.type === 'button' && text(node) === name).props.onClick(); refresh(); };
  const tab = name => { find(node => node.props?.role === 'tab' && text(node).startsWith(name)).props.onClick(); refresh(); };
  const setCode = value => { find(node => node.type === 'script-editor').props.onChange(value); refresh(); };
  const watch = (name, checked = true) => { field(`Watch ${name}`).props.onChange({ target: { checked } }); refresh(); };
  refresh(); return { refresh, all, find, field, click, tab, setCode, watch, applied, closed, props, content: () => text(tree) };
}
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('every declared component exposes automatic events, including templates and repeaters', () => {
  const ast = ts.createSourceFile('types.ts', fs.readFileSync(new URL('src/types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const definition = ast.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ComponentType');
  for (const member of definition.type.types) {
    const component = { ...base, type: member.literal.text }, ui = drive(component); ui.tab('Property changed');
    assert.deepEqual(ui.all().filter(node => node.type === 'input' && node.props.type === 'checkbox').map(node => node.props['aria-label'].slice(6)), componentEventProperties(component));
    ui.tab('Mounted'); ui.setCode('app.notify("Mounted");'); ui.click('Apply component events'); assert.equal(ui.applied[0].mount.code, 'app.notify("Mounted");');
  }
});
check('actual input value is observable, password value is never offered', () => {
  const ui = drive(input); ui.tab('Property changed'); assert.ok(ui.field('Watch value'));
  const password = drive(secret); password.tab('Property changed'); assert.ok(!password.all().some(node => node.props?.['aria-label'] === 'Watch value'));
});
check('three handlers remain staged across tabs and apply together preserving watch order', () => {
  const ui = drive(); ui.setCode('app.notify("mounted");'); ui.tab('Property changed'); ui.setCode('app.notify(event.property);'); ui.watch('y'); ui.watch('x'); ui.watch('text'); ui.watch('x', false); ui.watch('x');
  ui.tab('Unmounted'); ui.setCode('console.log(event.type);'); assert.deepEqual(ui.applied, []); ui.click('Apply component events');
  assert.deepEqual(ui.applied, [{ mount: script('app.notify("mounted");'), propertyChange: { ...script('app.notify(event.property);'), properties: ['y', 'text', 'x'] }, unmount: script('console.log(event.type);') }]);
});
check('cancel, close and escape discard drafts without applying', () => {
  for (const action of ['cancel', 'close', 'escape']) {
    const ui = drive(); ui.setCode('app.notify("discarded");');
    if (action === 'cancel') ui.click('Cancel');
    if (action === 'close') ui.field('Close component events').props.onClick();
    if (action === 'escape') { let prevented = false; ui.find(node => node.type === 'dialog').props.onCancel({ preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); }
    assert.deepEqual(ui.applied, []); assert.equal(ui.closed.length, 1);
  }
});
check('blanking one handler removes only that handler and preserves the remaining scripts', () => {
  const ui = drive({ ...base, props: { ...base.props, componentEvents: { mount: script('app.notify("mounted");'), unmount: script('console.log("closed");') } } });
  ui.setCode('   '); ui.click('Apply component events'); assert.deepEqual(ui.applied, [{ unmount: script('console.log("closed");') }]);
});
check('property-change requires a supported nonempty unique watchlist', () => {
  const invalid = [[], ['x', 'x'], ['missing']];
  for (const properties of invalid) {
    const ui = drive({ ...base, props: { componentEvents: { propertyChange: { ...script('app.notify(event.property);'), properties } } } });
    ui.click('Apply component events'); assert.deepEqual(ui.applied, []); assert.match(text(ui.find(node => node.props?.role === 'alert')), /1–16 unique properties/);
  }
});
check('unsupported saved watch targets are visible and can be explicitly removed', () => {
  const ui = drive({ ...base, props: { componentEvents: { propertyChange: { ...script('app.notify(event.property);'), properties: ['value', 'text'] } } } });
  ui.tab('Property changed'); assert.match(ui.content(), /Unsupported property: value/); ui.field('Remove unsupported watched property value').props.onClick(); ui.refresh(); ui.click('Apply component events');
  assert.deepEqual(ui.applied[0].propertyChange.properties, ['text']);
});
check('watch selection is capped at sixteen and oversized saved configuration rejects Apply', () => {
  const component = { ...base, type: 'progressBar' }, allowed = componentEventProperties(component); assert.ok(allowed.length > 16);
  const ui = drive(component); ui.tab('Property changed'); ui.setCode('app.notify(event.property);'); allowed.slice(0, 16).forEach(name => ui.watch(name)); assert.equal(ui.field(`Watch ${allowed[16]}`).props.disabled, true);
  ui.click('Apply component events'); assert.equal(ui.applied[0].propertyChange.properties.length, 16);
  const invalid = drive({ ...component, props: { componentEvents: { propertyChange: { ...script('app.notify(event.property);'), properties: allowed.slice(0, 17) } } } }); invalid.click('Apply component events'); assert.deepEqual(invalid.applied, []);
});
check('syntax errors select the affected handler while async syntax parses without executing', () => {
  const ui = drive({ ...base, props: { componentEvents: { unmount: script('if (') } } }); ui.click('Apply component events'); assert.deepEqual(ui.applied, []);
  assert.equal(text(ui.find(node => node.props?.role === 'tab' && node.props['aria-selected'])), 'UnmountedConfigured'); assert.match(text(ui.find(node => node.props?.role === 'alert')), /Unmounted/);
  ui.setCode('await Promise.resolve(); globalThis.__authoringExecuted = true;'); ui.click('Apply component events'); assert.equal(ui.applied.length, 1); assert.equal(globalThis.__authoringExecuted, undefined);
});
check('handler size limits and configured counters are visible and enforced', () => {
  const ui = drive(); assert.match(ui.content(), /0 of 3 handlers configured/); ui.setCode(' '.repeat(65535) + ';'); ui.click('Apply component events'); assert.equal(ui.applied.length, 1); assert.match(ui.content(), /1 of 3 handlers configured/);
  ui.setCode(' '.repeat(65536) + ';'); ui.click('Apply component events'); assert.equal(ui.applied.length, 1); assert.match(text(ui.find(node => node.props?.role === 'alert')), /65,536/); assert.ok(ui.all().some(node => node.props?.className?.includes('is-invalid')));
});
check('editor Ctrl+S and ScriptEditor save use the staged Apply action', () => {
  const ui = drive(); ui.setCode('app.notify("save");'); let prevented = false, stopped = false;
  ui.find(node => node.type === 'dialog').props.onKeyDown({ key: 's', ctrlKey: true, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(ui.applied.length, 1); ui.find(node => node.type === 'script-editor').props.onSave(); assert.equal(ui.applied.length, 2);
});
check('context help exposes snapshots and lifecycle helpers without password values', () => {
  for (const available of [false, true]) {
    const ui = drive(base, { instanceStateAvailable: available }); assert.doesNotMatch(ui.content(), /must-not-leak/); assert.match(ui.content(), /Inputs and parameters are frozen snapshots/);
    const completions = ui.find(node => node.type === 'script-editor').props.completions;
    for (const name of ['app.signal', 'app.onCleanup', 'event.previousAvailable', 'event.previousError']) assert.ok(completions.some(item => item.label === name));
    assert.equal(completions.find(item => item.label === 'app.state.get').detail.includes('instance'), available);
    assert.match(ui.content(), /128 property changes/); assert.match(ui.content(), /512 mount\/property events/); assert.match(ui.content(), /read-only operators/);
  }
});

const parse = name => ts.createSourceFile(`${name}.tsx`, fs.readFileSync(new URL(`src/${name}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findJsx = (ast, name) => { const result = []; function visit(node) { if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === name) result.push(node); ts.forEachChild(node, visit); } visit(ast); return result; };
const attribute = (node, name) => node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === name);
check('actual Designer Apply updates only componentEvents in one undoable change', () => {
  const ast = parse('App'), editor = findJsx(ast, 'ComponentLifecycleEditor')[0]; assert.ok(editor);
  const component = { ...base, props: { text: 'Keep', script: 'print("keep")', events: { change: script('app.notify("user");') } } };
  const original = { id: 'p', name: 'P', revision: 1, parameters: {}, screens: [{ id: 's', components: [component] }] };
  let project = structuredClone(original), history = { past: [], future: [] }, changes = 0, closes = 0;
  const update = (id, patch) => { changes++; history = checkpoint(history, project); project = { ...project, screens: [{ ...project.screens[0], components: project.screens[0].components.map(item => item.id === id ? { ...item, ...patch } : item) }] }; };
  const apply = events => new Function('screen', 'lifecycleEventEditorId', 'updateComponent', 'setLifecycleEventEditorId', `return (${attribute(editor, 'onApply').initializer.expression.getText(ast)});`)(project.screens[0], component.id, update, () => { closes++; })(events);
  const events = { mount: script('app.notify("automatic");') }; apply(events); assert.equal(changes, 1); assert.equal(closes, 1); assert.deepEqual(project.screens[0].components[0].props, { ...component.props, componentEvents: events });
  apply(events); assert.equal(changes, 1); const undone = restoreHistory(history, project, 'undo'); assert.deepEqual(undone.project, original); assert.deepEqual(restoreHistory(undone.history, undone.project, 'redo').project, project);
  apply({}); assert.equal(project.screens[0].components[0].props.componentEvents, undefined);
  assert.equal(findJsx(ast, 'InputEventsEditor').length, 1); assert.equal(findJsx(ast, 'ComponentEventEditor').length, 1);
});
check('Designer, operator and popup owners wire separate automatic setters and visible diagnostics', () => {
  for (const name of ['App', 'OperatorRuntime', 'Popup']) {
    const ast = parse(name), diagnostics = findJsx(ast, 'ComponentEventDiagnostics'); assert.equal(diagnostics.length, 1);
    assert.equal(attribute(diagnostics[0], 'state').initializer.expression.getText(ast), 'applicationState');
    assert.equal(Boolean(attribute(diagnostics[0], 'errorsOnly')), name === 'Popup');
    const views = findJsx(ast, name === 'App' ? 'Canvas' : 'ProjectComponentView'); assert.equal(views.length, 1);
    assert.equal(attribute(views[0], 'onInputChange').initializer.expression.getText(ast), name === 'App' ? 'previewForm.assign' : 'form.assign');
    assert.equal(attribute(views[0], 'onAutomaticInputChange').initializer.expression.getText(ast), name === 'App' ? 'previewForm.assignAutomatic' : 'form.assignAutomatic');
    if (name === 'App') {
      assert.equal(attribute(findJsx(ast, 'ProjectComponentView')[0], 'onAutomaticInputChange').initializer.expression.getText(ast), 'onAutomaticInputChange');
      assert.match(diagnostics[0].parent.getText(ast), /^preview &&/);
    }
  }
});
console.log(`${checks}/${checks} component-events authoring checks passed.`);
