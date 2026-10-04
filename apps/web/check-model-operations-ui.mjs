import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Authored interaction checks; provider operations are in-memory fakes and never contact a broker.
const file = createTestModuleFiles(), modules = new Map(), require = createRequire(import.meta.url);
const hooksUrl = file(`let stores=new Map(),scope='',index=0,effects=[];
export const begin=name=>{scope=name;index=0;if(!stores.has(name))stores.set(name,[]);};
export const clear=()=>{stores.clear();effects=[];};
export const flush=()=>{const pending=effects;effects=[];for(const run of pending)run();};
export const useState=initial=>{const values=stores.get(scope),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>useState({current:initial})[0];export const useMemo=run=>run();export const useCallback=run=>run;
export const useEffect=(run,deps)=>{const values=stores.get(scope),at=index++,previous=values[at];if(!previous||!deps||deps.some((value,i)=>value!==previous.deps[i])){values[at]={deps};effects.push(()=>{previous?.cleanup?.();values[at].cleanup=run();});}};
export const useId=()=>scope+'-'+index++;`);
const publishingUrl = file(`export let data={revision:'r1',publishers:[],diagnostics:[]};export const calls=[];
export const reset=()=>{data={revision:'r1',publishers:[],diagnostics:[]};calls.length=0;};
export const newModelPublisher=()=>({id:'sample',name:'Sample publisher',endpoint:'mqtt://localhost:1883',instancePaths:[],enabled:false,topicPrefix:'spark/models',shape:'object',mode:'onChange',intervalMs:1000,qos:1,retain:false,queueLimit:1000,queueBytes:10485760});
export const getModelPublishing=async()=>structuredClone(data);
export const saveModelPublisher=async(revision,value)=>{calls.push({kind:'save',revision,value:structuredClone(value)});data={...data,revision:'r'+(Number(data.revision.slice(1))+1),publishers:[structuredClone(value)]};};
export const testModelPublisher=async id=>{calls.push({kind:'test',id});return{success:true,message:'Connected; test sends no messages.'};};
export const previewModelPublishing=async value=>{calls.push({kind:'preview',value:structuredClone(value)});return{total:1,truncated:false,messages:[{topic:'spark/models/default/Press01',bytes:12,payload:{Load:25}}]};};
export const deleteModelPublisher=async()=>{};export const discardModelPublisherQueue=async()=>({discarded:0});`);
modules.set('modelPublisherApi', publishingUrl);
modules.set('api', file(`export const displayValue=value=>JSON.stringify(value??null);export const api=(path,_method,body)=>Promise.resolve(path==='/model/versions/compare'?{definitionId:body.definition.id,fromVersion:1,toVersion:body.definition.version,classification:'breaking',changes:[{path:'Load',reason:'Source mapping changed'}],usage:[{path:'[default]Factory/Line1/Press01',version:1}],affectedProjects:[],requiresReview:true}:{items:[]});`));
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const url = file('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8') + ';'); modules.set(name, url); return url; }
  const source = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(path => fs.existsSync(path)); assert.ok(source, name);
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+["'][^"']+\.css["'];?/g, '').replace(/from (["'])([^"']+)\1/g, (_match, _quote, dependency) => `from ${JSON.stringify(dependency === 'react' ? hooksUrl : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const url = file(code); modules.set(name, url); return url;
}
const hooks = await import(hooksUrl), publisher = await import(publishingUrl);
const { default: Operations } = await import(load('modelOperationsPanel')), { ModelPublishingPanel } = await import(load('modelPublishingPanel')), { BuilderMemberEditor } = await import(load('modelBuilderDrawer'));
const { emptyModelPackage } = await import(load('modelWorkspace'));
const { ModelVersionPanel } = await import(load('modelVersionPanel'));
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(content).join('');
const button = (tree, label) => { const found = nodes(tree).find(node => node.type === 'button' && content(node) === label); assert.ok(found, `button ${label}`); return found; };
const component = (tree, name) => { const found = nodes(tree).find(node => node.type?.name === name); assert.ok(found, `component ${name}`); return found; };
const render = (element, scope = element.type.name) => { hooks.begin(scope); const tree = element.type(element.props); hooks.flush(); return tree; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); hooks.flush(); };
function reset() { hooks.clear(); publisher.reset(); globalThis.window = { location: new URL('http://localhost/workspace?workspace=models&view=operations'), history: { state: {}, replaceState(_state, _title, url) { window.location = new URL(url); } } }; }
const model = { ...emptyModelPackage(), instances: [{ path: '[default]Factory/Line1/Press01', definitionId: 'Press', version: 1 }] };
let passed = 0;
const check = async (name, run) => { reset(); await run(); passed++; console.log(`PASS ${name}`); };
function operations(requestedTool) { const locks = []; const props = { model, savedModel: model, onChange() {}, connections: [], tagPaths: [], onNavigate() {}, onSelect() {}, onLockChange: value => locks.push(value), requestedTool }; const update = () => render({ type: Operations, props }, 'operations'); return { props, update, locks }; }
await check('model tools are grouped by intent and starters stay outside tool navigation', () => {
  const view = operations(), tree = view.update(), nav = nodes(tree).find(node => node.type === 'nav');
  assert.deepEqual(nodes(nav).filter(node => node.type === 'h3').map(content), ['Check', 'Manage', 'Share']);
  assert.equal(nodes(nav).filter(node => node.type === 'button').length, 7);
  assert.ok(!content(nav).includes('Use a starter')); assert.ok(button(tree, 'Use a starter')); assert.ok(component(tree, 'ModelLiveObjectPanel'));
});
await check('external requests update the initial URL and equipment context without repeated tab resets', () => {
  const view = operations({ tool: 'issues', requestId: 1, equipmentPath: model.instances[0].path }); let tree = view.update();
  assert.equal(window.location.searchParams.get('tool'), 'issues'); assert.equal(component(tree, 'ModelIssuesPanel').props.initialEquipment, model.instances[0].path);
  button(tree, 'Versions').props.onClick(); tree = view.update(); assert.ok(component(tree, 'ModelVersionPanel')); assert.equal(window.location.searchParams.get('tool'), 'versions');
  view.props.requestedTool = { tool: 'live', requestId: 2, equipmentPath: model.instances[0].path }; view.update(); tree = view.update(); assert.ok(component(tree, 'ModelLiveObjectPanel'));
});
await check('dirty publisher locks navigation and defers external requests until explicitly unlocked', () => {
  const view = operations({ tool: 'publish', requestId: 1 }); let tree = view.update(); const publish = component(tree, 'ModelPublishingPanel'); publish.props.onLockChange(true); tree = view.update();
  assert.equal(button(tree, 'Versions').props.disabled, true); assert.equal(button(tree, 'Use a starter').props.disabled, true);
  button(tree, 'Versions').props.onClick(); tree = view.update(); assert.ok(component(tree, 'ModelPublishingPanel'));
  view.props.requestedTool = { tool: 'start', requestId: 2 }; tree = view.update(); assert.ok(component(tree, 'ModelPublishingPanel'));
  publish.props.onLockChange(false); view.update(); tree = view.update(); assert.ok(component(tree, 'ModelStarterPanel')); assert.equal(window.location.searchParams.get('tool'), 'start');
});
function publishing() { const locks = [], props = { model, onLockChange: value => locks.push(value) }; const update = () => render({ type: ModelPublishingPanel, props }, 'publishing'); return { update, locks }; }
async function newPublisher(view) { view.update(); await settle(); let tree = view.update(); button(render(component(tree, 'PublisherPicker'), 'picker'), 'New publisher').props.onClick(); tree = view.update(); component(tree, 'PublisherEquipment').props.patch({ instancePaths: [model.instances[0].path] }); return view.update(); }
await check('publisher setup has ordered steps, named equipment and visible diagnostics before delivery', async () => {
  const view = publishing(); const tree = await newPublisher(view);
  assert.deepEqual(nodes(tree).filter(node => node.type?.name === 'PublisherStep').map(node => node.props.number), [1, 2, 3, 5]);
  assert.equal(render(component(tree, 'PublisherTestStep'), 'test-step').props.number, 4);
  const equipment = render(component(tree, 'PublisherEquipment'), 'equipment'); assert.equal(content(nodes(equipment).find(node => node.type === 'strong')), 'Press01'); assert.ok(content(equipment).includes(model.instances[0].path));
  assert.ok(component(tree, 'PublisherDiagnostics')); const delivery = render(component(tree, 'PublisherDeliveryFields'), 'delivery'); assert.equal(delivery.type, 'details'); assert.ok(!delivery.props.open); assert.equal(publisher.calls.length, 0);
});
await check('preview never saves or enables publishing and save-and-test persists delivery off before testing', async () => {
  const view = publishing(); let tree = await newPublisher(view); button(tree, 'Preview topics and payloads').props.onClick(); await settle(); tree = view.update();
  assert.deepEqual(publisher.calls.map(call => call.kind), ['preview']); assert.equal(publisher.calls[0].value.enabled, false);
  const testStep = render(component(tree, 'PublisherTestStep'), 'test-step'); assert.equal(button(testStep, 'Save and test broker').props.disabled, false); button(testStep, 'Save and test broker').props.onClick(); await settle(); tree = view.update();
  assert.deepEqual(publisher.calls.map(call => call.kind), ['preview', 'save', 'test']); assert.equal(publisher.calls[1].value.enabled, false); assert.equal(publisher.data.publishers[0].enabled, false); assert.equal(view.locks.at(-1), false);
  assert.equal(button(render(component(tree, 'PublisherTestStep'), 'test-step'), 'Test saved broker').props.disabled, false);
});
await check('enabled unsaved changes require explicit save rather than implicitly starting delivery from Test', async () => {
  const view = publishing(); let tree = await newPublisher(view); const enable = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(enable); enable.props.onChange({ target: { checked: true } }); tree = view.update();
  const testStep = render(component(tree, 'PublisherTestStep'), 'test-step'); assert.equal(button(testStep, 'Save and test broker').props.disabled, true);
  button(testStep, 'Save and test broker').props.onClick(); await settle(); assert.equal(publisher.calls.length, 0);
  button(view.update(), 'Save publisher').props.onClick(); await settle(); assert.equal(publisher.calls[0].kind, 'save'); assert.equal(publisher.calls[0].value.enabled, true);
});
await check('field details show essential inputs while advanced rules stay collapsed without losing configured values', () => {
  const member = { path: 'Load', kind: 'reference', dataType: 'Double', target: '[default]Sources/Load', unit: '%', unitSystem: 'ucum', semanticId: 'urn:example:load', range: { low: 0, high: 100 }, freshnessMs: 5000, alarms: [{ id: 'high', name: 'High load', mode: 'high', setpoint: 80 }] }, changes = [];
  const tree = render({ type: BuilderMemberEditor, props: { value: member, definition: { id: 'Press', version: 2, members: [member] }, model, connections: [], tags: [], readOnly: false, onChange: value => changes.push(value), onRemove() {} } }, 'field');
  assert.ok(nodes(tree).some(node => node.type === 'label' && content(node).startsWith('Name'))); assert.ok(nodes(tree).some(node => node.type === 'input' && node.props.readOnly && node.props.value === 'Double'));
  const metadata = render(component(tree, 'BuilderMemberMetadata'), 'metadata'), rules = render(component(metadata, 'ModelContractFields'), 'rules');
  assert.deepEqual(nodes(rules).filter(node => node.type === 'summary').map(content), ['Quality rules', 'Process alarms (1)']); assert.ok(nodes(rules).filter(node => node.type === 'details').every(node => !node.props.open));
  assert.ok(nodes(metadata).some(node => node.type === 'summary' && content(node) === 'Advanced metadata')); assert.equal(component(metadata, 'ModelUnitField').props.compact, true);
  assert.equal(component(metadata, 'ModelSemanticField').props.value.semanticId, member.semanticId); assert.equal(changes.length, 0);
});
await check('upgrades require explicit compatible mapping choices and retain equipment overrides and parameters', async () => {
  const first = { ...model.instances[0], mappingProfileId: 'old-source', parameters: { Device: 'Press01' }, overrides: { Load: { unit: '%' } } }, other = { path: '[default]Factory/Line1/Pump01', definitionId: 'Pump', version: 1 };
  const source = { ...model, udtDefinitions: [1, 2].map(version => ({ id: 'Press', version, members: [{ path: 'Load', kind: 'memory', dataType: 'Int32', value: 0 }] })), instances: [first, other], mappingProfiles: [{ id: 'old-source', definitionId: 'Press', version: 1, bindings: {} }, { id: 'new-source', definitionId: 'Press', version: 2, bindings: {} }] }, changes = [];
  const props = { model: source, onChange: next => changes.push(next) }, update = () => render({ type: ModelVersionPanel, props }, 'versions'); let tree = update();
  nodes(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'Press@2' } }); tree = update(); button(tree, 'Compare impact').props.onClick(); await settle(); tree = update();
  button(tree, 'Select all 1').props.onClick(); tree = update(); assert.equal(button(tree, 'Add 1 upgrades to draft').props.disabled, true); button(tree, 'Add 1 upgrades to draft').props.onClick(); assert.equal(changes.length, 0);
  const candidate = component(tree, 'UpgradeEquipment'); assert.equal(candidate.props.item.version, 1); assert.equal(candidate.props.targetVersion, 2); assert.equal(candidate.props.mapping, 'old-source'); candidate.props.onMapping('new-source'); tree = update();
  assert.equal(button(tree, 'Add 1 upgrades to draft').props.disabled, false); button(tree, 'Add 1 upgrades to draft').props.onClick();
  assert.equal(changes.length, 1); assert.equal(changes[0].instances[0].version, 2); assert.equal(changes[0].instances[0].mappingProfileId, 'new-source'); assert.deepEqual(changes[0].instances[0].parameters, first.parameters); assert.deepEqual(changes[0].instances[0].overrides, first.overrides); assert.deepEqual(changes[0].instances[1], other);
});
console.log(`${passed} Model operations UI checks passed.`);
