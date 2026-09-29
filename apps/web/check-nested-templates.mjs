import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

// Avoid printing enormous data-URL module stacks when an assertion fails.
process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), modules = new Map();
const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hookUrl = url(`export * from ${JSON.stringify(reactUrl)}; export const useState=v=>globalThis.__nestedHooks.useState(v); export const useRef=v=>globalThis.__nestedHooks.useRef(v); export const useEffect=(run,deps)=>globalThis.__nestedHooks.useEffect(run,deps);`);
const leafUrl = url(`import React from ${JSON.stringify(reactUrl)}; export default function BoundComponent(props) { return React.createElement('bound-leaf', props); }`);
const stateUrl = url('export const useApplicationStateContext=()=>globalThis.__nestedState; export const useInstanceApplicationState=parent=>parent; export const ApplicationStateProvider=({children})=>children;');
const queryUrl = url('export const useQueryRepeater=(source)=>source ? globalThis.__nestedQuery : {rows:[],key:"none",loading:false,error:""};');
function load(name, harness = false) {
  const key = `${harness}:${name}`;
  if (modules.has(key)) return modules.get(key);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => {
      const stub = harness && name === 'inputStateBindings' && dependency === 'react' ? hookUrl : harness && name === 'templates' ? ({react: hookUrl, './BoundComponent': leafUrl,
        './applicationState': stateUrl, './useQueryRepeater': queryUrl, './ComponentEvents': url('export const useComponentEvents=()=>{};'),
        './useQueryPropertyBindings': url('export const useQueryPropertyBindings=()=>({});export const useQueryPropertyContext=()=>undefined;export const QueryPropertyProvider=({children})=>children;')})[dependency] : undefined;
      return prefix + JSON.stringify(stub ?? (dependency.startsWith('./') ? load(dependency.slice(2), harness) : pathToFileURL(require.resolve(dependency)).href));
    });
  const result = url(code); modules.set(key, result); return result;
}
const {templateExpansion, templatePlacementError, templateParameters, componentContexts, instanceInputKey, instancePath, instanceRequestScope, actionKey} = await import(load('templateModel'));
const {runtimeBindingHealth} = await import(load('runtimeQuality'));
const {ProjectComponentView} = await import(load('templates', true));
const {ProjectComponentView: RealView} = await import(load('templates'));
const {ApplicationStateProvider} = await import(load('applicationState'));
const {ApplicationStateStore} = await import(load('applicationStateModel'));
const c = (id, type, props = {}) => ({id, type, x: 8, y: 9, width: 240, height: 100, props});
const t = (id, components, parameters = {}, parameterTypes) => ({id, name: id, width: 300, height: 200, parameters, parameterTypes, components});
const embed = (id, target, props = {}) => c(id, 'template', {templateId: target, ...props});
const repeat = (id, target, ids, props = {}) => c(id, 'repeater', {templateId: target, rows: ids.map(id => ({id, parameters: {}})), ...props});
const field = c('note', 'textInput', {fieldKey: 'note', defaultValue: 'default'});
const save = c('save', 'button', {text: 'Save', action: 'script', script: 'result = inputs'});
const detail = t('detail', [field, save, c('table', 'table'), c('popup', 'button', {action: 'openPopup', text: 'Open'})], {count: '{count}', permit: '{permit}', title: '{title}'}, {count: 'number', permit: 'boolean'});
const inner = repeat('children', 'detail', ['x', 'y'], {parameters: {title: 'Child {title}'}});
const outer = t('outer', [field, inner], {count: '{count}', permit: '{permit}', title: '{title}'}, {count: 'number', permit: 'boolean'});
const host = repeat('machines', 'outer', ['a', 'b'], {parameters: {title: 'Machine {title}'}});
const base = {component: host, components: [host], templates: [outer, detail], screenId: 'screen', tags: [],
  parameters: {count: 3, permit: true, title: 'Root'}, inputs: {}, scopedInputs: {}, preview: true};
let passed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.message}`); process.exit(1); }
}

// A small keyed hook host exercises real recursive functions, callback closures,
// effect cleanup and row remounts while keeping external controls deterministic.
function harness(overrides = {}) {
  const sessions = new Map(), actions = [], edits = [], popups = [], tables = [], navigation = [];
  let visited, effects, nodes, cursor, current;
  const h = {props: {...base, ...overrides}, actions, edits, popups, tables, navigation};
  h.props.onAction = (component, instance) => actions.push({component, instance});
  h.props.onOpenPopup = (component, instance) => popups.push({component, instance});
  h.props.onTableEdit = async (component, edit, instance) => { tables.push({component, edit, instance}); return {success: true}; };
  h.props.onNavigate = target => navigation.push(target);
  h.props.onScopedInputChange = (scope, key, value) => {
    edits.push({scope, key, value}); h.props.scopedInputs = {...h.props.scopedInputs, [scope]: {...h.props.scopedInputs[scope], [key]: value}};
  };
  const hooks = {
    useState(initial) { const slots = current.slots, index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; return current.slots[index] ??= {current: initial}; },
    useEffect(run, deps) { const owner = current, index = cursor++, before = owner.effects[index];
      if (!before || deps.some((value, i) => !Object.is(value, before.deps[i]))) effects.push(() => { before?.cleanup?.(); owner.effects[index] = {deps, cleanup: run()}; }); },
  };
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${path}/${child?.key ?? i}`)); return; }
    if (typeof node.type === 'function') {
      const key = `${path}/${node.type.name}:${node.key ?? ''}`;
      visited.add(key); current = sessions.get(key) ?? {slots: [], effects: []}; sessions.set(key, current); cursor = 0;
      globalThis.__nestedHooks = hooks;
      walk(node.type(node.props), key); return;
    }
    nodes.push(node); React.Children.toArray(node.props?.children).forEach((child, i) => walk(child, `${path}/${child.key ?? i}`));
  }
  h.render = () => {
    visited = new Set(); effects = []; nodes = [];
    walk(React.createElement(ProjectComponentView, h.props), 'root');
    for (const [key, session] of sessions) if (!visited.has(key)) { session.effects.forEach(effect => effect?.cleanup?.()); sessions.delete(key); }
    effects.forEach(run => run()); h.nodes = nodes; return h.leaves();
  };
  h.leaves = id => h.nodes.filter(node => node.type === 'bound-leaf' && (!id || node.props.component.id === id));
  h.stop = () => { for (const session of sessions.values()) session.effects.forEach(effect => effect?.cleanup?.()); sessions.clear(); };
  return h;
}

await check('four template levels are accepted and five fail before expansion', () => {
  const templates = [1, 2, 3, 4].map(n => t(`t${n}`, n === 4 ? [save] : [embed(`i${n + 1}`, `t${n + 1}`)]));
  const top = embed('i1', 't1'); assert.deepEqual(templateExpansion([top], templates), {count: 5});
  templates[3].components = [embed('i5', 't5')]; templates.push(t('t5', [save]));
  assert.match(templateExpansion([top], templates).error, /at most 4 levels/);
});
await check('placement counts every shared-template ancestor including unplaced definition roots', () => {
  const templates = [t('A', [embed('ab', 'B')]), t('B', [embed('bc', 'C')]), t('C', []), t('D', [embed('de', 'E')]), t('E', [])];
  assert.match(templatePlacementError(templates, 'C', 'D'), /at most 4 levels/);
  assert.equal(templatePlacementError(templates, 'C', 'E'), undefined);
  assert.equal(templatePlacementError(templates, 'B', 'D'), undefined);
  assert.match(templatePlacementError(templates, 'C', 'A'), /cycle/);
  // The short caller must not mask another caller that already uses four levels.
  templates.unshift(t('short', [embed('short-c', 'C')]));
  templates.push(t('above', [embed('above-a', 'A')]));
  assert.match(templatePlacementError(templates, 'C', 'E'), /at most 4 levels/);
});
await check('cycle, missing definitions and nested queries fail including empty saved rows', () => {
  const a = t('a', [repeat('child', 'b', [])]), b = t('b', [embed('back', 'a')]);
  assert.match(templateExpansion([embed('a', 'a')], [a, b]).error, /cycle/);
  assert.match(templatePlacementError([a, b], 'a', 'a'), /cycle/);
  assert.match(templateExpansion([embed('missing', 'unknown')], []).error, /unavailable/);
  b.components = [repeat('nested-query', 'leaf', [], {rowsSource: {queryId: 'q', rowKey: 'id', parameterMap: {}}})];
  assert.match(templateExpansion([embed('a', 'a')], [a, b, t('leaf', [])]).error, /screen root/);
});
await check('component ceiling counts containers and multiplies all saved and query row levels', () => {
  const leaf = t('leaf', [save]), mid = t('mid', [repeat('nested', 'leaf', Array.from({length: 99}, (_, i) => String(i)))]);
  const root = repeat('root', 'mid', Array.from({length: 100}, (_, i) => String(i)));
  assert.match(templateExpansion([root], [mid, leaf]).error, /10,000/);
  mid.components[0].props.rows.pop(); assert.equal(templateExpansion([root], [mid, leaf]).count, 9901);
  root.props.rows = []; root.props.rowsSource = {queryId: 'q', rowKey: 'id', parameterMap: {}};
  assert.equal(templateExpansion([root], [mid, leaf]).count, 9901);
  const exact = t('exact', Array.from({length: 9999}, (_, i) => c(`l${i}`, 'label')));
  assert.equal(templateExpansion([embed('top', 'exact')], [exact]).count, 10000);
  assert.match(templateExpansion([c('extra', 'label'), embed('top', 'exact')], [exact]).error, /10,000/);
});
await check('shared empty-row graphs inspect each definition once and do not count unreachable expansion', () => {
  const templates = [1, 2, 3, 4].map(n => t(`t${n}`, n === 4 ? [save] : Array.from({length: 500}, (_, i) => repeat(`r${i}`, `t${n + 1}`, []))));
  const started = performance.now();
  assert.deepEqual(templateExpansion([embed('top', 't1')], templates), {count: 501});
  assert.ok(performance.now() - started < 1500, 'Shared empty-row graphs should not grow exponentially');
  const huge = t('huge', Array.from({length: 10001}, (_, i) => c(`l${i}`, 'label')));
  assert.deepEqual(templateExpansion([repeat('empty', 'huge', [])], [huge]), {count: 1});
});
await check('full identities preserve legacy wire shapes and distinguish each ancestor row', () => {
  const legacy = {instanceId: 'machines', rowId: 'a'};
  assert.deepEqual(instanceRequestScope(legacy), legacy); assert.deepEqual(instanceRequestScope(), {});
  const a = {...legacy, instancePath: [legacy, {instanceId: 'children', rowId: 'x'}]}, b = {...a, instancePath: [{...legacy, rowId: 'b'}, a.instancePath[1]]};
  assert.deepEqual(instanceRequestScope(a), {instancePath: a.instancePath}); assert.deepEqual(instancePath(legacy), [legacy]);
  assert.notEqual(instanceInputKey('s', a.instancePath), instanceInputKey('s', b.instancePath));
  assert.notEqual(actionKey('save', a), actionKey('save', b));
  assert.equal(instanceInputKey('s', [legacy]), instanceInputKey('s', 'machines', 'a'));
});
await check('typed parameters chain once per level and saved contexts reach every descendant', () => {
  const contexts = componentContexts([host], [outer, detail], base.parameters).filter(item => item.component.id === 'save');
  assert.equal(contexts.length, 4); assert.ok(contexts.every(item => item.parameters.count === 3 && item.parameters.permit === true && item.parameters.title === 'Child Machine Root'));
  assert.equal(templateParameters(detail, {...base.parameters, title: '{count}'}).title, '{count}');
});
await check('saved forms isolate identical field names at every full path and callbacks carry innermost form', async () => {
  const h = harness(); try {
    h.render(); assert.equal(h.leaves('note').length, 6);
    const fields = h.leaves('note'); fields[0].props.onInputChange('note', 'outer A'); fields[1].props.onInputChange('note', 'child AX'); fields[4].props.onInputChange('note', 'child BX');
    h.render(); assert.deepEqual(h.leaves('note').map(node => node.props.inputs.note), ['outer A', 'child AX', 'default', 'default', 'child BX', 'default']);
    const target = h.leaves('save')[0]; target.props.onAction();
    await h.leaves('table')[0].props.onTableEdit({rowKey: 'record', column: 'name', value: 'x'}); h.leaves('popup')[0].props.onOpenPopup();
    const action = h.actions[0].instance; assert.equal(action.template.id, 'detail'); assert.equal(action.inputs.note, 'child AX'); assert.equal(action.parameters.title, 'Child Machine Root');
    assert.deepEqual(action.instancePath, [{instanceId: 'machines', rowId: 'a'}, {instanceId: 'children', rowId: 'x'}]);
    assert.equal(action.instanceId, 'machines'); assert.equal(action.rowId, 'a'); assert.deepEqual(h.tables[0].instance, action); assert.deepEqual(h.popups[0].instance, action);
    h.props.actionBusyId = actionKey('save', action); h.render(); assert.equal(h.leaves('save').filter(node => node.props.actionBusy).length, 1);
  } finally { h.stop(); }
});
await check('query ancestor replacement resets all its descendant drafts while other rows retain theirs', () => {
  const dynamic = {...host, props: {...host.props, rows: [], rowsSource: {queryId: 'machines', rowKey: 'id', parameterMap: {}}}};
  globalThis.__nestedQuery = {rows: [{id: 'a', parameters: {title: 'A', count: 1}}, {id: 'b', parameters: {title: 'B', count: 2}}], key: 'query', loading: false, error: ''};
  const h = harness({component: dynamic, components: [dynamic]}); try {
    h.render(); h.leaves('note')[0].props.onInputChange('note', 'outer A'); h.leaves('note')[1].props.onInputChange('note', 'AX'); h.leaves('note')[4].props.onInputChange('note', 'BX');
    h.render(); assert.deepEqual(h.leaves('note').map(node => node.props.inputs.note), ['outer A', 'AX', 'default', 'default', 'BX', 'default']); assert.equal(h.edits.length, 0);
    h.leaves('save')[0].props.onAction(); assert.equal(h.actions[0].instance.querySourceParameters.title, 'A'); assert.equal(h.actions[0].instance.parameters.title, 'Child A');
    const expiredInput = h.leaves('note')[1], expiredAction = h.leaves('save')[0];
    globalThis.__nestedQuery.rows[0] = {id: 'a', parameters: {title: 'changed A', count: 3}}; h.render();
    expiredInput.props.onInputChange('note', 'expired'); expiredAction.props.onAction(); assert.equal(h.actions.length, 1);
    assert.deepEqual(h.leaves('note').map(node => node.props.inputs.note), ['default', 'default', 'default', 'default', 'BX', 'default']);
    globalThis.__nestedQuery.rows.reverse(); h.render(); assert.equal(h.leaves('note')[1].props.inputs.note, 'BX');
    globalThis.__nestedQuery.rows = []; h.render(); assert.equal(h.leaves().length, 0);
  } finally { h.stop(); }
});
await check('query descendant drafts reset on nested template and parameter changes while owning row drafts remain', () => {
  const dynamic = {...host, props: {...host.props, rows: [], rowsSource: {queryId: 'machines', rowKey: 'id', parameterMap: {}}}};
  const changing = structuredClone(outer), replacement = {...detail, id: 'replacement'};
  globalThis.__nestedQuery = {rows: [{id: 'a', parameters: {title: 'A'}}, {id: 'b', parameters: {title: 'B'}}], key: 'query', loading: false, error: ''};
  const h = harness({component: dynamic, components: [dynamic], templates: [changing, detail, replacement]}); try {
    h.render(); h.leaves('note')[0].props.onInputChange('note', 'owner A'); h.leaves('note')[1].props.onInputChange('note', 'old AX'); h.leaves('note')[3].props.onInputChange('note', 'owner B');
    changing.components[1].props.templateId = 'replacement'; h.render();
    assert.deepEqual(h.leaves('note').map(node => node.props.inputs.note), ['owner A', 'default', 'default', 'owner B', 'default', 'default']);
    h.leaves('note')[1].props.onInputChange('note', 'new AX'); h.render();
    changing.components[1].props.parameters = {title: 'Changed {title}'}; h.render();
    assert.deepEqual(h.leaves('note').map(node => node.props.inputs.note), ['owner A', 'default', 'default', 'owner B', 'default', 'default']);
    h.leaves('note')[1].props.onInputChange('note', 'keep after move'); changing.components[1].x += 5; h.render();
    assert.equal(h.leaves('note')[1].props.inputs.note, 'keep after move'); assert.equal(h.edits.length, 0);
  } finally { h.stop(); }
});
await check('disabled or read-only ancestors gate stale input, action, popup, table and navigation callbacks', async () => {
  const h = harness(); try {
    h.render(); const input = h.leaves('note')[1], button = h.leaves('save')[0], popup = h.leaves('popup')[0], table = h.leaves('table')[0];
    h.props.component = {...host, props: {...host.props, enabled: false}}; h.props.components = [h.props.component]; h.render();
    assert.ok(h.leaves().every(node => node.props.interactionLocked)); input.props.onInputChange('note', 'expired'); button.props.onAction(); popup.props.onOpenPopup(); button.props.onNavigate('elsewhere');
    await assert.rejects(table.props.onTableEdit({}), /no longer interactive/);
    assert.deepEqual([h.edits.length, h.actions.length, h.popups.length, h.navigation.length, h.tables.length], [0, 0, 0, 0, 0]);
    h.props.component = host; h.props.components = [host]; h.props.readOnly = true; h.render();
    input.props.onInputChange('note', 'expired'); button.props.onAction(); await assert.rejects(table.props.onTableEdit({}), /no longer interactive/);
    assert.equal(h.edits.length + h.actions.length, 0);
  } finally { h.stop(); }
});
await check('nested bound inputs share state, retain only local invalid drafts and submit current values', () => {
  const store = new ApplicationStateStore(); store.configure('run'); const scope = store.activateScreen('screen', {amount:{type:'number',value:3}});
  const bound = c('amount','spinner',{fieldKey:'amount',min:0,max:10,stateBinding:{scope:'screen',key:'amount'}});
  const boundDetail = {...detail,components:[bound,save]}, h = harness({templates:[outer,boundDetail]});
  const render = () => {globalThis.__nestedState=store.context(scope);h.render();};
  try {
    render(); h.leaves('amount')[0].props.onInputChange('amount',8); render(); assert.deepEqual(h.leaves('amount').map(node=>node.props.inputs.amount),[8,8,8,8]);
    h.leaves('amount')[0].props.onInputChange('amount',''); render(); assert.deepEqual(h.leaves('amount').map(node=>node.props.inputs.amount),['',8,8,8]);
    store.context(scope).api.reset('screen','amount'); render(); assert.deepEqual(h.leaves('amount').map(node=>node.props.inputs.amount),[3,3,3,3]);
    h.leaves('save')[1].props.onAction(); assert.deepEqual(h.actions[0].instance.inputs,{amount:3});
    const expired=h.leaves('amount')[0]; h.props.readOnly=true;render(); expired.props.onInputChange('amount',5); assert.equal(store.context(scope).api.get('screen','amount'),3);
  } finally {h.stop();globalThis.__nestedState=undefined;}
});
await check('nested wrapper geometry stays authored in Design and evaluates in Preview with parent form state', () => {
  const sized = structuredClone(outer); sized.components[1].props.bindings = {x: {expression: '42', references: {}}, width: {expression: 'n * 100', references: {n: {kind: 'parameter', key: 'count'}}}};
  const h = harness({templates: [sized, detail], preview: false}); try {
    h.render(); let node = h.nodes.find(node => node.props.className === 'template-leaf component-repeater'); assert.equal(node.props.style.left, 8); assert.equal(node.props.style.width, 240);
    h.props.preview = true; h.render(); node = h.nodes.find(node => node.props.className === 'template-leaf component-repeater'); assert.equal(node.props.style.left, 42); assert.equal(node.props.style.width, 300);
  } finally { h.stop(); }
});
await check('runtime health follows saved descendant parameter and input scopes', () => {
  const value = c('value', 'value', {bindings: {tagPath: {expression: "'[default]' + machine", references: {machine: {kind: 'input', key: 'note'}}}}});
  const leaf = {...detail, components: [field, value]}; const screen = {id: 'screen', name: 'Screen', width: 1000, height: 700, components: [host]};
  const tags = [{path: '[default]default', value: 2, quality: 'Good'}, {path: '[default]simulated', value: 3, quality: 'Good', source: 'simulated'}];
  const path = [{instanceId: 'machines', rowId: 'a'}, {instanceId: 'children', rowId: 'x'}];
  assert.deepEqual(runtimeBindingHealth(screen, [outer, leaf], tags, base.parameters, {[instanceInputKey('screen', path)]: {note: 'simulated'}}), {badCount: 0, simulated: true});
  assert.equal(runtimeBindingHealth(screen, [outer, leaf], tags, base.parameters, {[instanceInputKey('screen', path)]: {note: 'missing'}}).badCount, 1);
});
await check('real rendering inherits appearance and disabled/hidden state through every descendant', () => {
  const styled = {...host, props: {...host.props, enabled: false, backgroundColor: '#112233', foregroundColor: '#abcdef', fontSize: 19}};
  const html = renderToStaticMarkup(React.createElement(RealView, {...base, component: styled, components: [styled], onNavigate() {}}));
  assert.equal((html.match(/<input[^>]*disabled=""/g) || []).length, 6); assert.match(html, /--component-text-color:#abcdef/); assert.match(html, /--component-font-size:19px/);
  const hidden = {...styled, props: {...styled.props, visible: false}};
  assert.match(renderToStaticMarkup(React.createElement(RealView, {...base, component: hidden, components: [hidden], onNavigate() {}})), /template-binding-frame bound-component-hidden/);
});
await check('four-level rendering and bindings share the containing screen state', () => {
  const label = c('state', 'label', {bindings: {text: {expression: 'count', references: {count: {kind: 'screenState', key: 'count'}}}, x: {expression: 'count * 10', references: {count: {kind: 'screenState', key: 'count'}}}}});
  const templates = [1, 2, 3, 4].map(n => t(`t${n}`, n === 4 ? [label] : [embed(`i${n + 1}`, `t${n + 1}`)]));
  const root = embed('i1', 't1');
  const html = renderToStaticMarkup(React.createElement(ApplicationStateProvider, {value: {key: 'containing-screen', values: {session: {}, screen: {count: 7}}}},
    React.createElement(RealView, {...base, component: root, components: [root], templates, onNavigate() {}})));
  assert.match(html, />7</); assert.match(html, /left:70px/); assert.doesNotMatch(html, /Binding error/);
  assert.equal((html.match(/data-instance-path=/g) || []).length, 4);
});
await check('invalid recursive graphs render explicit diagnostics without actionable descendants', () => {
  const cycle = t('cycle', [embed('back', 'cycle')]), root = embed('start', 'cycle');
  const h = harness({component: root, components: [root], templates: [cycle]}); try {
    h.render(); assert.equal(h.leaves().length, 0); assert.ok(h.nodes.some(node => node.type === 'span' && String(node.props.children).includes('cycle')));
  } finally { h.stop(); }
});
await check('parent input parameter bindings resolve before rows and capture only referenced inputs at every boundary', () => {
  const chooser = c('choice', 'textInput', {fieldKey:'choice', defaultValue:'Root'});
  const boundHost = {...host, props:{...host.props, parameterBindings:{title:{expression:'selected',references:{selected:{kind:'input',key:'choice'}}}}}};
  const boundOuter = structuredClone(outer);
  boundOuter.components[1].props.parameterBindings = {title:{expression:'text',references:{text:{kind:'input',key:'note'}}}};
  const h = harness({component:boundHost, components:[chooser,boundHost], templates:[boundOuter,detail], inputs:{choice:'Machine {title}',secret:'do not capture'}});
  try {
    h.render(); assert.equal(h.leaves('note')[0].props.parameters.title,'Machine {title}');
    h.leaves('note')[0].props.onInputChange('note','Nested {title}'); h.render();
    assert.equal(h.leaves('save')[0].props.parameters.title,'Nested {title}');
    h.leaves('save')[0].props.onAction(); const action=h.actions[0].instance;
    assert.deepEqual(action.bindingInputs,[{choice:'Machine {title}'},{note:'Nested {title}'}]);
    assert.deepEqual(instanceRequestScope(action),{instancePath:action.instancePath,bindingInputs:action.bindingInputs});
  } finally { h.stop(); }
});
await check('changed bound context resets descendant edits, rejects expired callbacks and never restores saved scoped drafts', async () => {
  const chooser=c('choice','textInput',{fieldKey:'choice'});
  const boundHost={...host,props:{...host.props,parameterBindings:{title:{expression:'selected',references:{selected:{kind:'input',key:'choice'}}}}}};
  const oldScope=instanceInputKey('screen',[{instanceId:'machines',rowId:'a'},{instanceId:'children',rowId:'x'}]);
  const h=harness({component:boundHost,components:[chooser,boundHost],inputs:{choice:'A'},scopedInputs:{[oldScope]:{note:'expired saved draft'}}});
  try {
    h.render(); assert.equal(h.leaves('note')[1].props.inputs.note,'default');
    h.leaves('note')[1].props.onInputChange('note','typed for A'); h.render();
    const expired=h.leaves('save')[0], table=h.leaves('table')[0], popup=h.leaves('popup')[0]; expired.props.onAction();
    const instance=h.actions[0].instance; assert.equal(instance.isCurrent(),true);
    h.props.inputs={choice:'B'};h.render(); assert.equal(instance.isCurrent(),false);
    assert.equal(h.leaves('note')[1].props.inputs.note,'default'); expired.props.onAction();popup.props.onOpenPopup();
    await assert.rejects(table.props.onTableEdit({}),/no longer interactive/); assert.equal(h.actions.length,1);assert.equal(h.popups.length,0);
    h.props.inputs={choice:'A'};h.render();assert.equal(h.leaves('note')[1].props.inputs.note,'default');assert.equal(h.edits.length,0);
  } finally {h.stop();}
});
await check('unchanged bound values preserve drafts, while bad bindings hide every row even when a row overrides the target', () => {
  const chooser=c('choice','numberInput',{fieldKey:'choice',min:0,max:10});
  const boundHost={...host,props:{...host.props,rows:[{id:'a',parameters:{count:'4'}},{id:'b',parameters:{}}],parameterBindings:{count:{expression:'selected',references:{selected:{kind:'input',key:'choice'}}}}}};
  const h=harness({component:boundHost,components:[chooser,boundHost],inputs:{choice:3,unrelated:'a'}});
  try {
    h.render();assert.equal(h.leaves('save')[0].props.parameters.count,4); assert.equal(h.leaves('save')[2].props.parameters.count,3);
    h.leaves('note')[1].props.onInputChange('note','keep');h.render();
    h.props.inputs={choice:3,unrelated:'changed'};h.render();assert.equal(h.leaves('note')[1].props.inputs.note,'keep');
    h.props.inputs={choice:11};h.render();assert.equal(h.leaves().length,0);
    assert.ok(h.nodes.some(node=>node.type==='div'&&String(node.props.className).includes('query-repeater-error')));
  } finally{h.stop();}
});
await check('a nested binding pads unbound ancestor snapshots and query row parameters still override bindings literally', () => {
  const boundOuter=structuredClone(outer);
  boundOuter.components[1].props.parameterBindings={title:{expression:'text',references:{text:{kind:'input',key:'note'}}}};
  const h=harness({templates:[boundOuter,detail]});try{
    h.render();h.leaves('save')[0].props.onAction();assert.deepEqual(h.actions[0].instance.bindingInputs,[{},{note:'default'}]);
  }finally{h.stop();}
  const dynamic={...host,props:{...host.props,rows:[],rowsSource:{queryId:'machines',rowKey:'id',parameterMap:{}},parameterBindings:{title:{expression:"'bound'",references:{}}}}};
  globalThis.__nestedQuery={rows:[{id:'a',parameters:{title:'Query {title}'}}],key:'q',loading:false,error:''};
  const query=harness({component:dynamic,components:[dynamic]});try{
    query.render();assert.equal(query.leaves('save')[0].props.parameters.title,'Child Query {title}');
    query.leaves('save')[0].props.onAction();assert.deepEqual(query.actions[0].instance.bindingInputs,[{},{}]);
  }finally{query.stop();}
});
console.log(`${passed} nested-template checks passed.`);
