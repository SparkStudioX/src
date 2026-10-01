import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const cache = new Map();
function url(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (cache.has(name)) return cache.get(name);
  const code = ts.transpileModule(fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from "\.\/([^"\n]+)"/g, (_, dependency) => `from ${JSON.stringify(url(dependency))}`);
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; cache.set(name, result); return result;
}
const { createPopup, popupQuerySource, popupSourceStatus, screenParameters } = await import(url('popupModel'));
const { queryTemplateParameters, templateParameters } = await import(url('templateModel'));
const { resolveParameterBindings } = await import(url('templateParameterBindings'));
const leaf = (id, type, props) => ({ id, type, x: 0, y: 0, width: 100, height: 50, props });
const button = leaf('open', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: { station: '{station}', target: '{target}' } });
const inner = { id: 'inner', name: 'Inner', width: 200, height: 100, parameters: { station: '{station}', target: '{target}', ready: '{ready}' }, parameterTypes: { target: 'number', ready: 'boolean' }, components: [button] };
const child = leaf('form', 'template', { templateId: 'inner', parameters: {} });
const outer = { id: 'outer', name: 'Outer', width: 220, height: 130, parameters: { station: 'Assembly', target: '24', ready: 'true' }, parameterTypes: { target: 'number', ready: 'boolean' }, components: [child] };
const source = { queryId: 'stations', rowKey: 'key', parameterMap: { station: 'station', target: 'target' } };
const host = { id: 'main', name: 'Main', width: 900, height: 600, parameters: {}, components: [leaf('cards', 'repeater', { templateId: 'outer', rowsSource: source })] };
const popupScreen = { id: 'popup', kind: 'popup', name: 'Popup', width: 500, height: 350, parameters: { station: '', target: '' }, components: [] };
const project = { id: 'p', name: 'Project', revision: 1, parameters: { area: 'A' }, screens: [host, popupScreen], templates: [outer, inner] };
const row = { id: 'A:v1', parameters: { station: 'Press {area}', target: 31 } };
const path = [{ instanceId: 'cards', rowId: row.id }, { instanceId: 'form' }];
function make(fixture = project) {
  const parent = queryTemplateParameters(fixture.templates[0], screenParameters(host, fixture.parameters), {}, row.parameters);
  const current = templateParameters(fixture.templates[1], parent, fixture.templates[0].components[0].props.parameters);
  return createPopup(fixture, host, button, fixture.parameters, current, { instanceId: 'cards', rowId: row.id, instancePath: path,
    template: fixture.templates[1], parameters: current, inputs: {}, querySourceParameters: parent });
}
const state = rows => ({ rows, loading: false, error: '' });
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check('nested popup transmits only the complete opener identity and keeps literal typed contexts', () => {
  const popup = make(); assert.deepEqual(popup.origin, { screenId: 'main', componentId: 'open', instancePath: path });
  assert.equal(popup.parameters.station, 'Press {area}'); assert.equal(popup.parameters.target, '31');
  assert.equal(popup.querySourceParameters.target, 31); assert.equal(popup.querySourceParameters.ready, true);
  assert.equal('querySourceParameters' in popup.origin, false);
});
check('source verification rechecks the outer query row then resolves each nested typed scope', () => {
  const popup = make(), definition = popupQuerySource(project, popup);
  assert.equal(definition.error, ''); assert.equal(definition.rowId, row.id); assert.equal(definition.template.id, 'outer');
  assert.equal(definition.descendants[0].template.id, 'inner'); assert.equal(popupSourceStatus(popup, definition, state([row])).ready, true);
  assert.equal(popupSourceStatus(popup, definition, state([])).stale, true);
  assert.equal(popupSourceStatus(popup, definition, state([{ ...row, parameters: { ...row.parameters, target: 32 } }])).stale, true);
});
check('changing an outer value hidden by a child override still invalidates an open popup', () => {
  const fixture = structuredClone(project); fixture.templates[0].components[0].props.parameters = { target: '7' };
  const popup = make(fixture), definition = popupQuerySource(fixture, popup);
  assert.equal(popup.querySourceParameters.target, 7); assert.equal(popup.queryRootParameters.target, 31);
  assert.equal(popupSourceStatus(popup, definition, state([row])).ready, true);
  assert.equal(popupSourceStatus(popup, definition, state([{ ...row, parameters: { ...row.parameters, target: 32 } }])).stale, true);
});
check('removed child, changed ancestor types and replaced opener cannot keep an old popup active', () => {
  for (const mutate of [p => { p.templates[0].components = []; }, p => { p.templates[0].parameterTypes.target = 'string'; }, p => { p.templates[1].components[0].props.targetScreenId = 'other'; }]) {
    const popup = make(), changed = structuredClone(project); mutate(changed);
    const definition = popupQuerySource(changed, popup); assert.ok(definition.error); assert.equal(popupSourceStatus(popup, definition, state([row])).stale, true);
  }
});
check('saved nested rows retain their full identity and detect removed or changed declarations', () => {
  const fixture = structuredClone(project); const staticHost = fixture.screens[0];
  staticHost.components[0].props = { templateId: 'outer', rows: [{ id: row.id, parameters: { station: 'Press B', target: '41' } }] };
  const parent = templateParameters(fixture.templates[0], fixture.parameters, {}, staticHost.components[0].props.rows[0].parameters);
  const current = templateParameters(fixture.templates[1], parent);
  const popup = createPopup(fixture, staticHost, button, fixture.parameters, current, { instanceId: 'cards', rowId: row.id, instancePath: path, template: inner, parameters: current, inputs: {} });
  assert.equal(popup.querySourceParameters, undefined); assert.equal(popupQuerySource(fixture, popup).error, '');
  fixture.screens[0].components[0].props.rows = []; assert.ok(popupQuerySource(fixture, popup).error);
});
check('one-step embedded popup openers work while previewing their containing template', () => {
  const parent = templateParameters(outer, project.parameters);
  const current = templateParameters(inner, parent, child.props.parameters);
  const popup = createPopup(project, outer, button, project.parameters, current, {
    instanceId: child.id, template: inner, parameters: current, inputs: {},
  });
  assert.deepEqual(popup.origin, { screenId: outer.id, componentId: button.id, instanceId: child.id });
  assert.equal(popupQuerySource(project, popup).error, '');
  assert.equal(popupSourceStatus(popup, popupQuerySource(project, popup), state([])).ready, true);
  const missing = { ...project, templates: [inner] };
  assert.equal(popupSourceStatus(popup, popupQuerySource(missing, popup), state([])).stale, true);
});
check('nested paths reject missing row identities, missing descendants and excessive depth', () => {
  const popup = make();
  for (const changed of [
    { ...popup, origin: { ...popup.origin, instancePath: [{ instanceId: 'cards' }, { instanceId: 'form' }] } },
    { ...popup, origin: { ...popup.origin, instancePath: [...path, { instanceId: 'missing' }] } },
    { ...popup, origin: { ...popup.origin, instancePath: Array.from({length:5}, () => ({ instanceId: 'form' })) } },
  ]) assert.ok(popupQuerySource(project, changed).error);
});
check('bound popup input snapshots remain independent and are re-evaluated through query descendants', () => {
  const fixture = structuredClone(project), screen = fixture.screens[0], parent = fixture.templates[0], detail = fixture.templates[1];
  const rootInput = leaf('line','textInput',{fieldKey:'line'}), childInput = leaf('offset','numberInput',{fieldKey:'offset',min:0,max:100});
  screen.components.push(rootInput); parent.components.push(childInput);
  screen.components[0].props.parameterBindings = {station:{expression:'line',references:{line:{kind:'input',key:'line'}}}};
  parent.components[0].props.parameterBindings = {target:{expression:'target + offset',references:{target:{kind:'parameter',key:'target'},offset:{kind:'input',key:'offset'}}}};
  const bindingInputs = [{line:'Bound {area}'},{offset:4}], rootContext=screenParameters(screen,fixture.parameters);
  const parentContext=queryTemplateParameters(parent,rootContext,{},row.parameters,resolveParameterBindings(screen.components[0],parent,{components:screen.components,tags:[],parameters:rootContext,inputs:bindingInputs[0]}));
  const childContext=templateParameters(detail,parentContext,{},undefined,resolveParameterBindings(parent.components[0],detail,{components:parent.components,tags:[],parameters:parentContext,inputs:bindingInputs[1]}));
  const popup=createPopup(fixture,screen,button,fixture.parameters,childContext,{instanceId:'cards',rowId:row.id,instancePath:path,template:detail,parameters:childContext,inputs:{},bindingInputs,querySourceParameters:parentContext});
  assert.equal(popup.parameters.target,'35');assert.deepEqual(popup.origin.bindingInputs,[{line:'Bound {area}'},{offset:4}]);
  bindingInputs[0].line='later parent value';bindingInputs[1].offset=9;
  assert.deepEqual(popup.origin.bindingInputs,[{line:'Bound {area}'},{offset:4}]);
  assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),state([row])).ready,true);
  const editedRow={...row,parameters:{...row.parameters,target:32}};
  assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),state([editedRow])).stale,true);
  const missing={...popup,origin:{...popup.origin,bindingInputs:[{}]}};
  assert.equal(popupSourceStatus(missing,popupQuerySource(fixture,missing),state([row])).stale,true);
  const absent={...popup,origin:{...popup.origin,bindingInputs:[{},{}]}};
  assert.equal(popupSourceStatus(absent,popupQuerySource(fixture,absent),state([row])).stale,true);
  const changed=structuredClone(fixture);changed.templates[0].components[1].props.max=3;
  assert.ok(popupQuerySource(changed,popup).error);
});
check('static bound popups preserve the opening input and stale on binding or referenced custom-definition changes', () => {
  const fixture=structuredClone(project),screen=fixture.screens[0],parent=fixture.templates[0],detail=fixture.templates[1];
  screen.components[0]=leaf('cards','template',{templateId:'outer',customProperties:{station:{type:'string',value:'Assembly'}},parameterBindings:{station:{expression:'value',references:{value:{kind:'custom',key:'station'}}}}});
  parent.components.push(leaf('offset','numberInput',{fieldKey:'offset',min:0,max:10}));
  parent.components[0].props.parameterBindings={target:{expression:'n',references:{n:{kind:'input',key:'offset'}}}};
  const staticPath=[{instanceId:'cards'},{instanceId:'form'}],parentContext=templateParameters(parent,fixture.parameters);
  const caller=templateParameters(detail,parentContext,{},undefined,{target:7});
  const popup=createPopup(fixture,screen,button,fixture.parameters,caller,{instanceId:'cards',instancePath:staticPath,template:detail,parameters:caller,inputs:{},bindingInputs:[{},{offset:7}]});
  assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),state([])).ready,true);
  const changed=structuredClone(fixture);changed.screens[0].components[0].props.customProperties.station.value='Replacement';
  assert.equal(popupSourceStatus(popup,popupQuerySource(changed,popup),state([])).stale,true);
  const bad={...popup,origin:{...popup.origin,bindingInputs:[{},{offset:20}]}};
  assert.equal(popupSourceStatus(bad,popupQuerySource(fixture,bad),state([])).stale,true);
  const removed=structuredClone(fixture);delete removed.templates[0].components[0].props.parameterBindings;
  assert.equal(popupSourceStatus(popup,popupQuerySource(removed,popup),state([])).stale,true);
});
check('a typed template Preview parent feeds arithmetic bindings when verifying its popup', () => {
  const fixture=structuredClone(project),parent=fixture.templates[0],detail=fixture.templates[1];
  parent.components[0].props.parameterBindings={target:{expression:'n + 1',references:{n:{kind:'parameter',key:'target'}}}};
  const caller=templateParameters(detail,templateParameters(parent,fixture.parameters),{},undefined,{target:25});
  const popup=createPopup(fixture,parent,button,fixture.parameters,caller,{instanceId:'form',template:detail,parameters:caller,inputs:{},bindingInputs:[{}]});
  assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),state([])).ready,true);
});
console.log(`${checks} nested popup checks passed.`);
