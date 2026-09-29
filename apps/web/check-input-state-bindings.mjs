import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(
      dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); modules.set(name, url); return url;
}
const {ApplicationStateStore} = await import(load('applicationStateModel'));
const {InputStateBindingForm} = await import(load('inputStateBindings'));
const {resolveInputs, stateInputError, validateInputs} = await import(load('inputs'));
const {InputEventLifecycle, executeInputEvent} = await import(load('inputEvents'));
const {ApplicationStateProvider} = await import(load('applicationState'));
const {default: BoundComponent} = await import(load('BoundComponent'));
const {ProjectComponentView} = await import(load('templates'));
const {runtimeBindingHealth} = await import(load('runtimeQuality'));
const {projectInputContext} = await import(load('templateModel'));
const {queryRowFormKey} = await import(load('queryRepeater'));
const c = (id, type = 'numberInput', props = {}) => ({id, type, x: 0, y: 0, width: 200, height: 80,
  props: {fieldKey: id, defaultValue: 99, stateBinding: {scope: 'screen', key: 'amount'}, min: 0, max: 10, ...props}});
const document = components => ({id: 'main', name: 'Main', width: 800, height: 600, components});
const definitions = {amount: {type: 'number', value: 3}, note: {type: 'string', value: 'Saved'}, enabled: {type: 'boolean', value: true}};
function owner() {
  const store = new ApplicationStateStore(); store.configure('project:v1', definitions);
  const scope = store.activateScreen('main', definitions);
  return {store, scope, context: () => store.context(scope)};
}
function form(owner, components = [c('amount')], extra = {}) {
  const raw = [], model = new InputStateBindingForm();
  let options = {document: document(components), tags: [], parameters: {}, state: owner.context(), active: true, onEdit: (...args) => raw.push(args), ...extra};
  const refresh = patch => { options = {...options, state: owner.context(), ...patch}; model.update(options); return model.values(); };
  refresh(); return {model, raw, refresh, assign: (...args) => model.assignment()(...args)};
}
let passed = 0;
async function check(name, run) { try { await run(); passed++; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}\n${error.message}`); process.exit(1); } }

await check('state wins over authored defaults, stale form edits and disconnected tags without seeding', () => {
  const o = owner(), component = c('quantity');
  const values = resolveInputs(document([component]), [], {}, {quantity: 8}, true, o.context().values);
  assert.deepEqual(values, {quantity: 3}); assert.equal(o.context().api.get('screen', 'amount'), 3);
  assert.deepEqual(resolveInputs(document([component]), [], {}, {quantity: 8}, false), {quantity: null});
});
await check('accepted changes mirror same-scope inputs and separate nested forms with normal explicit form payloads', () => {
  const o = owner(), left = form(o, [c('quantity'), c('mirror')]), right = form(o, [c('other')]);
  left.assign('quantity', 8);
  assert.deepEqual(left.refresh(), {quantity: 8, mirror: 8}); assert.deepEqual(right.refresh(), {other: 8});
  assert.deepEqual(left.raw, []); assert.equal(validateInputs(document([c('quantity'), c('mirror')]), left.model.values()), null);
  assert.deepEqual(Object.keys(left.model.values()), ['quantity', 'mirror']);
});
await check('invalid drafts stay visible only in their own form and block submission without changing accepted state', () => {
  const o = owner(), left = form(o), right = form(o);
  for (const value of ['', '9007199254740993', -1, 11]) {
    left.assign('amount', value); assert.equal(left.refresh().amount, value); assert.equal(right.refresh().amount, 3);
    assert.ok(validateInputs(document([c('amount')]), left.model.values())); assert.equal(o.context().api.get('screen', 'amount'), 3);
  }
  left.assign('amount', 4); assert.equal(left.refresh().amount, 4); assert.equal(right.refresh().amount, 4);
});
await check('external updates, same-value reset and whole-scope reset clear drafts but unrelated writes do not', () => {
  const o = owner(), f = form(o), api = o.context().api;
  f.assign('amount', ''); api.set('screen', 'note', 'Other'); assert.equal(f.refresh().amount, '');
  api.set('screen', 'amount', 4); api.set('screen', 'amount', 3); assert.equal(f.refresh().amount, 3);
  f.assign('amount', ''); api.reset('screen', 'amount'); assert.equal(f.refresh().amount, 3);
  f.assign('amount', ''); api.reset('screen'); assert.equal(f.refresh().amount, 3);
});
await check('session binding crosses popup and main scopes while screen bindings remain local', () => {
  const o = owner(), popupScope = o.store.createScope('popup', definitions);
  const popup = {context: () => o.store.context(popupScope)};
  const main = form(o, [c('shared', 'numberInput', {stateBinding: {scope: 'session', key: 'amount'}}), c('local')]);
  const modal = form(popup, [c('shared', 'numberInput', {stateBinding: {scope: 'session', key: 'amount'}}), c('local')]);
  modal.assign('shared', 7); modal.assign('local', 9);
  assert.deepEqual(main.refresh(), {shared: 7, local: 3}); assert.deepEqual(modal.refresh(), {shared: 7, local: 9});
  o.store.closeScope(popupScope); const before = o.context().api.get('session', 'amount'); modal.assign('shared', 1);
  assert.equal(o.context().api.get('session', 'amount'), before);
});
await check('inactive and stale callbacks cannot write, while temporary ancestor locks preserve drafts', () => {
  const o = owner(), f = form(o); f.assign('amount', ''); const captured = f.model.assignment();
  f.refresh({active: false}); captured('amount', 8); f.assign('amount', 9); assert.equal(o.context().api.get('screen', 'amount'), 3);
  f.refresh({active: true}); assert.equal(f.model.values().amount, ''); captured('amount', 6); assert.equal(o.context().api.get('screen', 'amount'), 3);
  f.assign('amount', 5); assert.equal(f.refresh().amount, 5); const unmounted = f.model.assignment(); f.model.deactivate(); unmounted('amount', 6);
  assert.equal(o.context().api.get('screen', 'amount'), 5);
});
await check('new screen, publication and changed form context discard drafts and invalidate captured assignment helpers', () => {
  for (const mode of ['screen', 'publication', 'row', 'binding']) {
    const o = owner(), f = form(o); f.assign('amount', ''); const captured = f.model.assignment();
    if (mode === 'screen') o.scope = o.store.activateScreen('other', definitions);
    if (mode === 'publication') { o.store.configure('project:v2', definitions); o.scope = o.store.activateScreen('main', definitions); }
    // Context getter must track the replaced scope for this fixture.
    if (mode === 'screen' || mode === 'publication') f.refresh({state: o.store.context(o.scope)});
    else f.refresh(mode === 'row' ? {contextKey: 'next-row'} : {document: document([c('amount', 'numberInput', {stateBinding: {scope: 'session', key: 'amount'}})])});
    assert.equal(f.model.values().amount, 3); captured('amount', 8); assert.equal(o.store.context(o.scope).api.get('screen', 'amount'), 3);
  }
});
await check('all supported scalar inputs preserve exact types and configured option/date/range rules', () => {
  const types = [
    ['textInput','string','text'], ['textArea','string','long'], ['dateTimeInput','string','2026-09-29T08:30'],
    ['checkbox','boolean',false], ['toggle','boolean',true], ['numberInput','number',2.25], ['spinner','number',2], ['slider','number',3],
    ...['select','radioGroup','multiStateButton','list','treeView'].map(type => [type,'string','B']),
  ];
  for (const [type, scalar, value] of types) {
    const store = new ApplicationStateStore(); store.configure('run'); const scope = store.activateScreen('main', {x: {type: scalar, value}});
    const component = c('field', type, {stateBinding: {scope: 'screen', key: 'x'}, options: [{label: 'A', value: 'A'}, {label: 'B', value: 'B'}]});
    assert.equal(stateInputError(component, store.context(scope).values), null, type);
    assert.deepEqual(resolveInputs(document([component]), [], {}, {}, false, store.context(scope).values), {field: value});
  }
  const values = {session: {}, screen: {x: '2026-02-30T12:00'}};
  assert.match(stateInputError(c('date', 'dateTimeInput', {stateBinding: {scope: 'screen', key: 'x'}}), values), /valid local date/);
  assert.match(stateInputError(c('choice', 'select', {stateBinding: {scope: 'screen', key: 'x'}, options: [{label:'A',value:'A'}]}), values), /available options/);
});
await check('passwords, query options, tags, malformed bindings and incompatible current values fail closed', () => {
  const values = owner().context().values;
  for (const component of [c('password','passwordInput'), c('query','select',{optionsSource:{queryId:'q'}}), c('tag','numberInput',{tagPath:'[default]n'}),
    c('label','label'), c('missing','numberInput',{stateBinding:{scope:'screen',key:'missing'}}), c('number','numberInput',{stateBinding:{scope:'screen',key:'note'}}),
    c('bad','numberInput',{stateBinding:{scope:'scope',key:'amount'}}), c('extra','numberInput',{stateBinding:{scope:'screen',key:'amount',extra:true}}),
    c('newline','numberInput',{stateBinding:{scope:'screen',key:'amount\n'}}),c('null','numberInput',{stateBinding:null}),
    c('optionsNull','numberInput',{optionsSource:null}),c('mapped','numberInput',{selectionFields:{}})]) assert.ok(stateInputError(component, values), component.id);
  assert.deepEqual(resolveInputs(document([c('null','numberInput',{stateBinding:null})]),[],{}, {},false,values),{null:null});
  const o = owner(), f = form(o); o.context().api.set('screen','amount',99); assert.equal(f.refresh().amount,null); f.assign('amount',2); assert.equal(o.context().api.get('screen','amount'),99);
});
await check('unbound inputs keep existing local edit routing and never write shared state', () => {
  const o = owner(), f = form(o,[c('local','textInput',{stateBinding:undefined,defaultValue:'original'})]);
  f.assign('local','draft'); assert.deepEqual(f.raw,[['local','draft']]); assert.equal(o.context().api.get('screen','note'),'Saved');
  assert.deepEqual(f.refresh({edits:{local:'draft'}}),{local:'draft'});
});
await check('authoring and dynamic row identities reset when state binding contracts change', () => {
  const screen=document([c('amount')]), template={...screen,id:'template',parameters:{}}, project={id:'p',revision:1,name:'P',parameters:{},screens:[screen],templates:[template]};
  const before=projectInputContext(project), row={id:'row',parameters:{}}, beforeRow=queryRowFormKey('query',row,template,{});
  screen.components[0].props.stateBinding={scope:'session',key:'amount'};
  assert.notEqual(projectInputContext(project),before); assert.notEqual(queryRowFormKey('query',row,template,{}),beforeRow);
});
await check('event app.setInput and mapped assignments flow through the same state writer without recursive events', async () => {
  const o = owner(), component = c('amount'); component.props.events = {change:{language:'javascript',code:'app.setInput("mirror", 8);'}};
  const f = form(o,[component,c('mirror')]), events = [];
  const runner = new InputEventLifecycle(async (...args) => {events.push(args[1].type); await executeInputEvent(...args);});
  const ctx = () => ({key:'same-form',component,components:[component,c('mirror')],inputs:f.refresh(),parameters:{},setInput:f.model.assignment(),state:o.context().api,notify(){},error(message){throw new Error(message);}});
  runner.setContext(ctx(),3); runner.activate(); f.assign('amount',4); runner.updateInputs({amount:4}); runner.change(4); await runner.whenIdle();
  assert.deepEqual(f.refresh(),{amount:8,mirror:8}); runner.setContext(ctx(),8); runner.commit(8); await runner.whenIdle(); assert.deepEqual(events,['change']);
  f.assign('mirror',6); assert.deepEqual(f.refresh(),{amount:6,mirror:6});
});
await check('external state changes establish silent event baselines instead of producing feedback loops', async () => {
  const o = owner(), f = form(o), events = [], component = c('amount'); component.props.events={change:{language:'javascript',code:'x'},commit:{language:'javascript',code:'x'}};
  const runner = new InputEventLifecycle((_script,event)=>events.push(event.type));
  const ctx = () => ({key:'form',component,components:[component],inputs:f.refresh(),parameters:{},setInput:f.model.assignment(),state:o.context().api,notify(){},error(){}});
  runner.setContext(ctx(),3); runner.activate(); o.context().api.set('screen','amount',6); runner.setContext(ctx(),6); runner.commit(6); await runner.whenIdle(); assert.deepEqual(events,[]);
});
await check('rendered bound inputs show shared typed values and invalid-source diagnostics', () => {
  const o = owner(), component = c('quantity');
  const render = () => renderToStaticMarkup(React.createElement(ApplicationStateProvider,{value:{...o.context(),store:o.store}},
    React.createElement(BoundComponent,{component,components:[component],tags:[],parameters:{},inputs:resolveInputs(document([component]),[],{}, {},false,o.context().values),preview:true,onNavigate(){}})));
  assert.match(render(),/value="3"/); assert.doesNotMatch(render(),/disabled=""/);
  o.context().api.set('screen','amount',99); assert.match(render(),/Binding error: value/); assert.match(render(),/disabled=""/);
});
await check('nested template leaves consume containing state and runtime health reports invalid state values', () => {
  const o = owner(), leaf=c('quantity'), template={id:'form',name:'Form',width:240,height:120,parameters:{},components:[leaf]}, instance=c('instance','template',{stateBinding:undefined,templateId:'form'});
  const render=()=>renderToStaticMarkup(React.createElement(ApplicationStateProvider,{value:{...o.context(),store:o.store}},React.createElement(ProjectComponentView,{component:instance,components:[instance],templates:[template],screenId:'main',tags:[],parameters:{},preview:true,onNavigate(){}})));
  assert.match(render(),/value="3"/); assert.equal(runtimeBindingHealth(document([instance]),[template],[],{}, {},false,o.context().values).badCount,0);
  o.context().api.set('screen','amount',99); assert.match(render(),/Binding error: value/); assert.equal(runtimeBindingHealth(document([instance]),[template],[],{}, {},false,o.context().values).badCount,1);
});
console.log(`${passed} input-state binding checks passed.`);
