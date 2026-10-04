import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

// Independently authored, offline engineering-flow checks. No gateway or broker traffic.
const require = createRequire(import.meta.url), cache = new Map();
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hooksUrl = moduleUrl(`let values=[],index=0,pending=[],writes=0;
export const begin=()=>{index=0;}; export const countWrites=()=>writes;
export const unmount=()=>{values.forEach(value=>value?.cleanup?.());pending=[];};
export const clear=()=>{unmount();values=[];index=0;pending=[];writes=0;};
export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return [values[at],next=>{writes++;values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};
export const useMemo=callback=>callback();
export const useCallback=(callback,deps)=>{const at=index++,old=values[at];if(!old||deps.some((item,i)=>item!==old.deps[i]))values[at]={callback,deps};return values[at].callback;};
export const useEffect=(run,deps)=>{const at=index++,old=values[at];if(!old||deps.some((item,i)=>item!==old.deps[i]))pending.push(()=>{old?.cleanup?.();values[at]={deps,cleanup:run()};});};
export const flush=()=>{const jobs=pending;pending=[];jobs.forEach(run=>run());};`);
const fieldUrl = moduleUrl(`import React from ${JSON.stringify(reactUrl)};export const Field=props=>React.createElement('label',{'data-field':props.label},props.label,props.children);`);
const apiUrl = moduleUrl('export const api=(...args)=>globalThis.__sourceApi(...args);export const id=kind=>kind+"-fixture";export const displayValue=value=>typeof value==="object"?JSON.stringify(value):String(value??"");export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}');
const emptyUrl = moduleUrl('export default ()=>null;export const DeviceConnectionFields=()=>null;export const DeviceRegisterMap=()=>null;export const SourceConnectionFields=()=>null;export const SourceConnectionTools=()=>null;');
cache.set('TagModels', moduleUrl('export default props=>{globalThis.__sourceModelDraft=props.initialDraft;return null;};'));
cache.set('Auth', moduleUrl('export const useAuth=()=>({user:{id:"source-fixture"}});'));
cache.set('askSparkContext',moduleUrl('const registerContext=()=>()=>{};const value={registerContext};export const useAskSpark=()=>value;'));
function url(name) {
  if (cache.has(name)) return cache.get(name);
  if (name.endsWith('.json')) { const result = moduleUrl(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); cache.set(name, result); return result; }
  const file = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(candidate => fs.existsSync(candidate));
  assert.ok(file, name);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import\s+["'][^"']+\.css["'];?/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooksUrl : dependency === './App' ? fieldUrl : dependency === './api' ? apiUrl : dependency === './Icon' || name === 'Connections' && ['./ConnectionDiagnostics', './CreationMenu', './DeviceConnectionEditor', './SourceConnectionEditor'].includes(dependency) ? emptyUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const result = moduleUrl(output); cache.set(name, result); return result;
}
const model = await import(url('sourceConnections'));
const devices = await import(url('deviceConnections'));
const modelWorkspace = await import(url('modelWorkspace'));
const { SourceConnectionFields, SourceConnectionTools } = await import(url('SourceConnectionEditor'));
const { default: Connections } = await import(url('Connections'));
const { default: ConnectionDiagnostics } = await import(url('ConnectionDiagnostics'));
const { ApiError } = await import(apiUrl);
const hooks = await import(hooksUrl);
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const visibleNodes = node => !node || typeof node !== 'object' || node.props?.hidden ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(visibleNodes)];
const expand = node => !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: React.Children.toArray(node.props.children).map(expand) } };
function ui(Component, initial, handler = async () => ({}), expanded = true) {
  hooks.clear(); const props = { ...initial }, calls = []; let tree;
  globalThis.__sourceApi = (...args) => { calls.push(args); return handler(...args); };
  const render = () => { hooks.begin(); const result = Component(props); tree = expanded ? expand(result) : result; hooks.flush(); };
  const find = predicate => { const result = nodes(tree).find(predicate); assert.ok(result, 'Requested control was present'); return result; };
  const button = label => find(node => node.type === 'button' && text(node) === label);
  const click = label => { const control = button(label); assert.ok(!control.props.disabled, label); control.props.onClick(); render(); };
  const field = label => nodes(find(node => node.props?.['data-field'] === label)).find(node => ['input', 'textarea', 'select'].includes(node.type));
  const change = (label, value) => { field(label).props.onChange({ target: { value } }); render(); };
  render(); render(); return { props, calls, render, find, button, click, field, change, content: () => text(tree), all: () => nodes(tree), visible: () => visibleNodes(tree) };
}
const point = (patch = {}) => ({ id: 'p1', name: 'Speed', address: 'opaque/address#id', dataType: 'Double', writable: false, ...patch });
const mapping = (patch = {}) => ({ id: 'm1', topicFilter: 'plant/#', root: '[default]MQTT', tags: 'review', payload: 'scalar', ...patch });
const sourceConnection = (type = 'mtconnect', patch = {}) => ({ id: 'source1', name: 'Source 1', type, revision: 3, enabled: true, source: model.defaultSourceSettings(type), ...patch });
const connectionTabs = view => view.all().filter(node => node.type === 'button' && node.props.role === 'tab');
const activeConnectionTab = view => connectionTabs(view).find(node => node.props['aria-selected'] === true);
function assertConnectionPanel(view) {
  const tabs = connectionTabs(view), active = tabs.find(node => node.props['aria-selected'] === true);
  assert.ok(active, 'One connection section is selected');
  assert.equal(tabs.filter(tab => tab.props['aria-selected'] === true).length, 1);
  assert.deepEqual(tabs.filter(tab => tab.props.tabIndex === 0), [active], 'Only the active tab is in the tab sequence');
  assert.ok(tabs.filter(tab => tab !== active).every(tab => tab.props.tabIndex === -1));
  const panels = view.all().filter(node => node.props?.role === 'tabpanel');
  assert.equal(panels.length, 1, 'Sections share one accessible panel');
  assert.equal(active.props['aria-controls'], panels[0].props.id);
  assert.equal(panels[0].props['aria-labelledby'], active.props.id);
  assert.ok(!panels[0].props.hidden);
}
function tools(connection = sourceConnection(), handler, saved = true) {
  const changes = [], imports = [], notices = [];
  let view;
  view = ui(SourceConnectionTools, { connection, saved, disabled: false, onChange: source => { changes.push(source); view.props.connection = { ...view.props.connection, source }; view.props.saved = false; }, onImported: value => imports.push(value), notify: (...args) => notices.push(args) }, handler);
  return { ...view, changes, imports, notices };
}

await check('all three source defaults are separate from PLC settings and MQTT defaults to subscription', () => {
  for (const type of model.sourceTypes) {
    const connection = sourceConnection(type);
    assert.ok(model.isSourceType(type)); assert.ok(model.isPointConnection(connection)); assert.ok(devices.isEquipmentType(type));
    assert.deepEqual(connection.source.points, []); assert.equal(connection.source.authentication.mode, 'none'); assert.equal(connection.device, undefined);
  }
  assert.equal(model.defaultSourceSettings('mqtt').acquisition, 'subscribe'); assert.equal(devices.isDeviceType('mqtt'), false);
});
await check('common point catalog resolves source stable IDs without conflating raw addresses or selectors', () => {
  const p = point({ selector: '/child/~1' }), connection = sourceConnection('i3x', { source: { ...model.defaultSourceSettings('i3x'), points: [p] } });
  assert.equal(model.connectionPoints(connection)[0], p);
  assert.notEqual(model.sourceEntryKey(p), model.sourceEntryKey({ ...p, selector: '/other' }));
  assert.notEqual(model.sourceEntryKey(p), model.sourceEntryKey({ ...p, mappingId: 'other' }));
});
await check('point JSON accepts envelopes, preserves exact Int64 metadata, and rejects forged write authority', () => {
  const p = point({ dataType: 'Int64', address: 'urn:node/#[]' });
  assert.deepEqual(model.parseSourceMap(JSON.stringify({ points: [p] })), [p]);
  for (const value of [true, 'true', 1]) assert.throws(() => model.parseSourceMap(JSON.stringify([{ ...p, writable: value }])), /read-only/);
  for (const value of [null, {}, [point(), point()], [point({ selector: 'x'.repeat(513) })], [point({ mappingId: 'bad/identity' })]]) assert.throws(() => model.parseSourceMap(JSON.stringify(value)));
});
await check('map byte cap is measured in UTF-8 and large map imports fail before applying', () => {
  const points = Array.from({ length: 500 }, (_, index) => point({ id: 'p' + index, address: 'é'.repeat(1500) }));
  assert.throws(() => model.parseSourceMap(JSON.stringify(points)), /768 KiB/);
  assert.throws(() => model.parseSourceMap(' '.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});
await check('browse retains both an own-value row and its real topic children including literal value', () => {
  const folder = { address: 'a/b', name: 'b', isVariable: false }, value = { ...folder, isVariable: true, dataType: 'Int64' }, child = { ...value, address: 'a/b/value', name: 'value' };
  assert.deepEqual(model.sourceBrowseRows([folder, value, child, value, folder]), [folder, value, child]);
  assert.equal(model.sourceImportPoint(value, '[default]Topics').address, 'a/b');
  assert.equal(model.sourceImportPoint(child, '[default]Topics').address, 'a/b/value');
});
await check('suggested paths preserve owned roots while raw addresses and JSON pointers remain untouched', () => {
  const entry = { address: 'plant//a[#]', selector: '/a~1b', name: 'A/B', isVariable: true, dataType: 'Int64', mappingId: 'm1', suggestedPath: '[default]MQTT/plant/_/a___' };
  assert.deepEqual(model.sourceImportPoint(entry, '[default]Other'), { address: entry.address, name: entry.name, selector: entry.selector, mappingId: entry.mappingId, dataType: 'Int64', path: entry.suggestedPath });
});
await check('saved secrets display placeholders and omission retains them; explicit clear uses null', () => {
  let view; const settings = { ...model.defaultSourceSettings('i3x'), authentication: { mode: 'basic', username: 'engineer', hasPassword: true } };
  view = ui(SourceConnectionFields, { type: 'i3x', source: settings, onChange: source => { view.props.source = source; } });
  assert.equal(view.field('Password').props.placeholder, 'Saved password'); assert.equal(view.field('Password').props.value, '');
  view.change('Base URL', 'https://changed/v1'); assert.equal(Object.hasOwn(view.props.source.authentication, 'password'), false);
  view.click('Clear password'); assert.equal(view.props.source.authentication.password, null);
});
await check('MQTT mappings require an explicit automatic choice and scripted payloads persist their displayed expression', () => {
  let view; view = ui(SourceConnectionFields, { type: 'mqtt', source: model.defaultSourceSettings('mqtt'), onChange: source => { view.props.source = source; } });
  view.click('Add mapping'); assert.equal(view.props.source.mqtt.mappings[0].tags, 'review');
  view.change('Payload', 'script'); assert.equal(view.props.source.mqtt.mappings[0].script, 'json(payload).value');
  view.change('Tag creation', 'automatic'); assert.match(view.content(), /Automatic mode owns definitions/);
  view.change('Result shape', 'structure'); view.change('Tag creation', 'explicit'); assert.equal(view.props.source.mqtt.mappings[0].shape, 'scalar');
});
await check('new mapping IDs can be authored while saved mapping identities remain fixed', () => {
  let view; const settings = model.defaultSourceSettings('mqtt'); settings.mqtt.mappings = [mapping()];
  view = ui(SourceConnectionFields, { type: 'mqtt', source: settings, savedMappingIds: ['m1'], onChange: source => { view.props.source = source; } });
  view.change('Mapping', 'm1'); assert.equal(view.field('Mapping ID').props.readOnly, true);
  view.props.savedMappingIds = []; view.render(); view.change('Mapping ID', 'chosen-before-save'); assert.equal(view.props.source.mqtt.mappings[0].id, 'chosen-before-save'); assert.equal(view.field('Mapping ID').props.value, 'chosen-before-save');
});
await check('generated point metadata keeps owned identities out of authored map edits without hiding their values', () => {
  const generated = point({ id: 'owned', owned: true }), authored = point({ id: 'authored' });
  const connection = sourceConnection('mqtt'); connection.source.points = [generated, authored];
  const view = tools(connection);
  assert.match(view.content(), /generated \/ owned/);
  const edits = view.all().filter(node => node.type === 'button' && text(node) === 'Edit'); assert.equal(edits[0].props.disabled, true); assert.equal(edits[1].props.disabled, false);
  view.click('Import / edit JSON'); assert.deepEqual(JSON.parse(view.field('Source points JSON').props.value).map(point => point.id), ['authored']);
  view.change('Source points JSON', '[]'); view.click('Validate map'); view.click('Apply reviewed map to draft'); assert.deepEqual(view.changes[0].points.map(point => point.id), ['owned']);
});
await check('adding a point cannot overwrite an existing stable identity', () => {
  const view = tools(sourceConnection('mtconnect', { source: { ...model.defaultSourceSettings('mtconnect'), points: [point()] } }));
  view.click('Add point'); view.change('Point ID', 'p1'); view.change('Raw address', 'different'); view.click('Apply point to draft');
  assert.equal(view.changes.length, 0); assert.match(view.content(), /unique ID/);
});
await check('existing point IDs stay fixed and source maps change only after reviewed draft apply', () => {
  const view = tools(sourceConnection('mtconnect', { source: { ...model.defaultSourceSettings('mtconnect'), points: [point()] } }));
  view.click('Edit'); assert.equal(view.field('Point ID').props.readOnly, true); view.click('Cancel point');
  view.click('Import / edit JSON'); view.change('Source points JSON', JSON.stringify([point({ id: 'new' })])); view.click('Validate map');
  assert.equal(view.changes.length, 0); view.click('Apply reviewed map to draft'); assert.equal(view.changes[0].points[0].id, 'new'); assert.equal(view.changes[0].points[0].writable, false);
});
await check('late file contents cannot replace typed JSON or resurrect an obsolete map preview', async () => {
  const view = tools(), pending = deferred(); view.click('Import / edit JSON');
  view.field('Load source map file').props.onChange({ target: { files: [{ size: 100, text: () => pending.promise }], value: 'fixture.json' } });
  view.change('Source points JSON', JSON.stringify([point({ id: 'typed' })])); view.click('Validate map');
  pending.resolve(JSON.stringify([point({ id: 'old' })])); await settle(); view.render();
  assert.equal(JSON.parse(view.field('Source points JSON').props.value)[0].id, 'typed'); view.click('Apply reviewed map to draft'); assert.equal(view.changes[0].points[0].id, 'typed');
});
await check('a newly loaded map file invalidates an old preview until its actual contents are reviewed', async () => {
  const view = tools(), pending = deferred(); view.click('Import / edit JSON');
  view.field('Load source map file').props.onChange({ target: { files: [{ size: 100, text: () => pending.promise }], value: 'fixture.json' } }); view.render(); view.click('Validate map');
  pending.resolve(JSON.stringify([point()])); await settle(); view.render();
  assert.ok(!view.all().some(node => node.type === 'button' && text(node) === 'Apply reviewed map to draft'));
});
await check('paged source browse sends the saved revision and retains root/variable collisions', async () => {
  const own = { address: 'a', name: 'Own', isVariable: true, dataType: 'Int64' }, child = { address: 'a/value', name: 'Child', isVariable: true, dataType: 'Double' };
  const view = tools(sourceConnection('mqtt'), async (_route, _method, body) => body.continuationToken ? { entries: [child], truncated: false } : { entries: [{ ...own, isVariable: false }, own], continuationToken: 'next', truncated: false });
  view.click('Browse / refresh'); await settle(); view.render(); view.click('Load next page'); await settle(); view.render();
  assert.equal(view.calls[0][2].revision, 3); assert.equal(view.calls[1][2].continuationToken, 'next');
  assert.match(view.content(), /Own/); assert.match(view.content(), /Child/); assert.equal(view.all().filter(node => node.type === 'div' && node.props.className === 'browse-node').length, 3);
});
await check('MTConnect bulk device selection keeps Agent excluded while allowing explicit browse', async () => {
  const view = tools(sourceConnection(), async () => ({ entries: [{ address: 'agent', name: 'Agent', isVariable: false, metadata: { agent: true } }, { address: 'cnc', name: 'CNC', isVariable: false }], truncated: false }));
  view.click('Browse / refresh'); await settle(); view.render();
  const selectors = view.all().filter(node => node.type === 'button' && text(node) === 'Select device points'); assert.equal(selectors[0].props.disabled, true); assert.equal(selectors[1].props.disabled, false);
});
await check('browse selection previews the complete transaction before a single atomic apply', async () => {
  const entry = { address: 'opaque#raw', name: 'Speed', isVariable: true, dataType: 'Int64', selector: '/value' }, connection = sourceConnection();
  const view = tools(connection, async (route, _method, body) => route.endsWith('/browse') ? { entries: [entry], truncated: false } : route.endsWith('/preview') ? { previewToken: 'reviewed', points: body.points, tags: [], totalTags: 1 } : { imported: 1, connection: { ...connection, revision: 4 } });
  view.click('Browse / refresh'); await settle(); view.render();
  view.find(node => node.type === 'input' && node.props['aria-label'] === 'Import Speed /value').props.onChange({ target: { checked: true } }); view.render();
  assert.equal(view.calls.length, 1); view.click('Preview point and tag import'); await settle(); view.render(); assert.equal(view.imports.length, 0);
  view.click('Apply reviewed import'); await settle(); view.render();
  assert.equal(view.calls[2][2].previewToken, 'reviewed'); assert.equal(view.calls[2][2].points[0].address, 'opaque#raw'); assert.equal(view.calls[2][2].points[0].selector, '/value'); assert.equal(view.imports[0].revision, 4);
});
await check('source browse proposes a reference type from ingested points without applying or importing', async () => {
  for (const type of ['mtconnect','i3x','mqtt']) {
    globalThis.__sourceModelDraft=undefined; const draftStorage=new Map(); globalThis.sessionStorage={getItem:key=>draftStorage.get(key)??null,setItem:(key,value)=>draftStorage.set(key,value),removeItem:key=>draftStorage.delete(key)}; globalThis.window={...(globalThis.window||{}),dispatchEvent(){}};
    const entry={address:'plant/speed',name:'Speed',isVariable:true,dataType:'Double',metadata:{units:'rpm'},...(type==='mqtt'?{mappingId:'mapping1'}:{})};
    const settings={...model.defaultSourceSettings(type),points:type==='mqtt'?[]:[point({address:entry.address})]},connection=sourceConnection(type,{source:settings});
    const configured=[{path:'[default]Raw/Machine/Speed',kind:'device',dataType:'Double',connectionId:connection.id,nodeId:'p1'}];
    const view=tools(connection,async route=>route.endsWith('/browse')?{entries:[entry],truncated:false}:route.endsWith('/definitions')?configured:route.endsWith('/ownership')?{leaves:[{pointId:'p1',mappingId:'mapping1',address:entry.address,path:configured[0].path,dataType:'Double',suppressed:false,pruned:false}]}:{});
    view.click('Browse / refresh');await settle();view.render();
    view.find(node=>node.type==='input'&&node.props['aria-label']==='Import Speed').props.onChange({target:{checked:true}});view.render();
    view.click('Create model from selection');await settle();view.render();
    globalThis.__sourceModelDraft=modelWorkspace.takeModelDraft('source-fixture');
    assert.equal(globalThis.__sourceModelDraft.definition.members[0].kind,'reference');assert.equal(globalThis.__sourceModelDraft.definition.members[0].unit,'rpm');assert.equal(view.imports.length,0);assert.equal(view.changes.length,0);
    assert.ok(view.calls.every(([route])=>!route.includes('/apply')&&!route.includes('/import')));
  }
});
await check('source model draft rejects selections without ingested gateway tags', async () => {
  globalThis.__sourceModelDraft=undefined;const entry={address:'missing',name:'Missing',isVariable:true,dataType:'Double'};
  const view=tools(sourceConnection(),async route=>route.endsWith('/browse')?{entries:[entry],truncated:false}:[]);
  view.click('Browse / refresh');await settle();view.render();view.find(node=>node.type==='input'&&node.props['aria-label']==='Import Missing').props.onChange({target:{checked:true}});view.render();
  view.click('Create model from selection');await settle();view.render();assert.match(view.content(),/Import Missing as a gateway tag first/);assert.equal(globalThis.__sourceModelDraft,undefined);assert.equal(view.imports.length,0);
});
await check('obsolete browse responses and failures cannot cross configuration/revision/disable/unmount fences', async () => {
  for (const transition of [view => { view.props.connection = { ...view.props.connection, revision: 4 }; view.render(); }, view => { view.props.connection = { ...view.props.connection, source: { ...view.props.connection.source, endpoint: 'https://other' } }; view.render(); }, view => { view.props.disabled = true; view.render(); }, () => hooks.unmount()]) {
    for (const failure of [false, true]) {
      const pending = deferred(), view = tools(sourceConnection(), () => pending.promise); view.click('Browse / refresh'); transition(view); const before = hooks.countWrites();
      if (failure) pending.reject(new Error('Obsolete source failure')); else pending.resolve({ entries: [{ address: 'old', name: 'Obsolete source result', isVariable: true }], truncated: false });
      await settle(); assert.equal(hooks.countWrites(), before);
    }
  }
});
await check('read displays exact Int64 decimal strings and independent source/receipt timestamps', async () => {
  const view = tools(sourceConnection('mtconnect', { source: { ...model.defaultSourceSettings('mtconnect'), points: [point({ dataType: 'Int64' })] } }), async () => ({ values: [{ pointId: 'p1', value: '9223372036854775807', dataType: 'Int64', quality: 'Good', sourceTimestamp: '2026-10-01T01:00:00Z', receiptTimestamp: '2026-10-01T02:00:00Z' }] }));
  view.click('Read'); await settle(); view.render(); assert.match(view.content(), /9223372036854775807/); assert.match(view.content(), /Source 2026-10-01T01/); assert.match(view.content(), /Receipt 2026-10-01T02/);
  assert.deepEqual(view.calls[0][2], { revision: 3, nodeIds: ['p1'] });
});
await check('draft MQTT extraction test sends its candidate mapping and commits neither values nor definitions', async () => {
  const draftMapping = mapping({ payload: 'script', script: 'json(payload).value' }), connection = sourceConnection('mqtt'); connection.source.mqtt.mappings = [draftMapping];
  const view = tools(connection, async () => ({ typedResult: '9223372036854775807', diagnostics: [], elapsedMs: 2.5, structuredUpdates: 'snapshot' }), false);
  view.change('Test mapping', 'm1'); view.change('Test payload', '{"value":9223372036854775807}'); view.click('Test mapping'); await settle(); view.render();
  assert.equal(view.calls.length, 1); assert.ok(view.calls[0][0].endsWith('/script/test')); assert.deepEqual(view.calls[0][2].mapping, draftMapping); assert.equal(view.changes.length, 0); assert.equal(view.imports.length, 0); assert.match(view.content(), /9223372036854775807/);
  assert.match(view.content(), /Elapsed 2.50 ms/); assert.match(view.content(), /Snapshot · omitted leaves become NoData/);
});
await check('changing a supplied test payload prevents a late result being shown for the new payload', async () => {
  const pending = deferred(), connection = sourceConnection('mqtt'); connection.source.mqtt.mappings = [mapping()];
  const view = tools(connection, () => pending.promise); view.change('Test mapping', 'm1'); view.click('Test mapping'); view.change('Test payload', 'new payload');
  pending.resolve({ typedResult: 'Obsolete test result' }); await settle(); view.render(); assert.ok(!view.content().includes('Obsolete test result'));
});
await check('ownership and deliberate suppression clear remain available on disabled saved MQTT connections', async () => {
  const connection = sourceConnection('mqtt', { enabled: false }), leaf = { pointId: 'p1', address: 'plant/a', name: 'a', dataType: 'Double', path: '[default]MQTT/a', suppressed: true };
  const view = tools(connection, async route => route.endsWith('/ownership') ? [leaf] : undefined);
  view.click('Load ownership'); await settle(); view.render(); view.click('Allow rediscovery'); await settle(); view.render();
  assert.ok(view.calls[1][0].endsWith('/suppression/clear')); assert.equal(view.calls[1][2].pointId, 'p1'); assert.equal(view.notices.length, 1);
});
await check('every configurable connection exposes its section tabs immediately below its heading', () => {
  const expected = {
    opcua: ['Connection', 'Security', 'Browse', 'Diagnostics'],
    sqlite: ['Connection', 'Database', 'Diagnostics'],
    sqlserver: ['Connection', 'Security', 'Diagnostics'],
    'modbus-tcp': ['Connection', 'Register map', 'Browse', 'Diagnostics'],
    'ab-eip': ['Connection', 'Register map', 'Browse', 'Diagnostics'],
    'siemens-s7': ['Connection', 'Register map', 'Browse', 'Diagnostics'],
    'beckhoff-ads': ['Connection', 'Register map', 'Browse', 'Diagnostics'],
    mtconnect: ['Connection', 'Security', 'Acquisition', 'Points', 'Browse & import', 'Advanced', 'Diagnostics'],
    i3x: ['Connection', 'Security', 'Acquisition', 'Points', 'Browse & import', 'Advanced', 'Diagnostics'],
    mqtt: ['Connection', 'Security', 'Topic mappings', 'Points', 'Observed topics', 'Mapping test', 'Ownership', 'Advanced', 'Diagnostics'],
  };
  for (const [type, labels] of Object.entries(expected)) {
    const connection = { id: 'sections-' + type, name: 'Section fixture', type, revision: 1, enabled: true,
      ...(model.isSourceType(type) ? { source: model.defaultSourceSettings(type) } : devices.isDeviceType(type) ? { device: devices.defaultDeviceSettings(type) } : {}) };
    const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} });
    const tablist = view.find(node => node.props?.role === 'tablist' && node.props['aria-label'] === 'Connection sections');
    assert.deepEqual(nodes(tablist).filter(node => node.props?.role === 'tab').map(text), labels, type);
    const editor = view.find(node => node.type === 'section' && node.props.className?.split(' ').includes('connection-editor'));
    const children = React.Children.toArray(editor.props.children).flatMap(child => child.type === React.Fragment ? React.Children.toArray(child.props.children) : [child]);
    const headingAt = children.findIndex(child => child.props?.className === 'resource-editor-heading');
    assert.ok(headingAt >= 0, type);
    assert.equal(children[headingAt + 1].props.role, 'tablist', type + ' tabs follow the action heading');
    assert.equal(text(activeConnectionTab(view)), 'Connection');
    for (const label of labels) {
      view.click(label); assertConnectionPanel(view);
      for (const action of ['Test connection', 'Delete connection', 'Save connection']) assert.ok(view.button(action), type + ' keeps ' + action + ' available in every section');
    }
    assert.equal(view.calls.length, 0, 'Changing tabs performs no connection operation');
  }
});
await check('connection section keyboard navigation moves focus and maintains accessible selection', () => {
  const connection = { id: 'opc-tabs', name: 'Keyboard fixture', type: 'opcua', revision: 1, enabled: true };
  const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} });
  const press = (key, expected) => {
    const focused = []; let prevented = false;
    for (const tab of connectionTabs(view)) (tab.props.ref ?? tab.ref)?.({ focus: () => focused.push(text(tab)) });
    activeConnectionTab(view).props.onKeyDown({ key, preventDefault: () => { prevented = true; } }); view.render();
    assert.equal(prevented, true); assert.deepEqual(focused, [expected]); assert.equal(text(activeConnectionTab(view)), expected); assertConnectionPanel(view);
  };
  press('ArrowRight', 'Security'); press('End', 'Diagnostics'); press('ArrowRight', 'Connection');
  press('ArrowLeft', 'Diagnostics'); press('Home', 'Connection');
  let prevented = false;
  activeConnectionTab(view).props.onKeyDown({ key: 'Tab', preventDefault: () => { prevented = true; } }); view.render();
  assert.equal(prevented, false); assert.equal(text(activeConnectionTab(view)), 'Connection');
});
await check('cross-section edits save together and saving or refreshing the same connection retains its tab', async () => {
  const connection = { id: 'opc-draft', name: 'Original connection', type: 'opcua', revision: 3, enabled: true, endpoint: 'opc.tcp://localhost:4840', username: 'original-user' };
  let saved = connection, view;
  view = ui(Connections, { connections: [connection], onChange: values => { view.props.connections = values; }, onTagsChanged() {}, notify() {} }, async (route, method, body) => {
    assert.equal(route, '/connections');
    if (method === 'POST') { saved = { ...body, revision: 4 }; return saved; }
    return [saved];
  });
  view.change('Connection name', 'Changed connection'); view.click('Security'); view.change('Username', 'changed-user');
  view.click('Browse'); assert.equal(view.calls.length, 0);
  view.click('Connection'); assert.equal(view.field('Connection name').props.value, 'Changed connection');
  view.click('Security'); assert.equal(view.field('Username').props.value, 'changed-user');
  view.click('Save connection'); await settle(); view.render();
  assert.equal(view.calls.length, 2); assert.equal(view.calls[0][2].name, 'Changed connection'); assert.equal(view.calls[0][2].username, 'changed-user');
  assert.equal(text(activeConnectionTab(view)), 'Security'); assert.equal(view.button('Save connection').props.disabled, true);
  view.props.connections = [{ ...saved }]; view.render();
  assert.equal(text(activeConnectionTab(view)), 'Security'); assertConnectionPanel(view);
});
await check('selecting another connection resets its section without carrying over a previous draft', () => {
  const first = { id: 'opc-first', name: 'First connection', type: 'opcua', revision: 1, enabled: true, username: 'first-user' };
  const second = { id: 'sql-second', name: 'Second connection', type: 'sqlserver', revision: 1, enabled: true, username: 'second-user' };
  const view = ui(Connections, { connections: [first, second], onChange() {}, onTagsChanged() {}, notify() {} });
  view.click('Security'); view.change('Username', 'unsaved-first-user');
  view.find(node => node.type === 'button' && node.props.className?.split(' ').includes('resource-item') && text(node).includes('Second connection')).props.onClick(); view.render();
  assert.equal(text(activeConnectionTab(view)), 'Connection'); assert.equal(view.field('Connection name').props.value, 'Second connection');
  view.click('Security'); assert.equal(view.field('Username').props.value, 'second-user'); assert.equal(view.button('Save connection').props.disabled, true);
});
await check('a deletion blocked by references opens Diagnostics and keeps the failure visible', async () => {
  const connection = { id: 'referenced-opc', name: 'Referenced connection', type: 'opcua', revision: 3, enabled: true };
  const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} }, async (route, method) => {
    assert.equal(route, '/connections/referenced-opc'); assert.equal(method, 'DELETE');
    throw new ApiError('Synthetic saved references block deletion', 409);
  });
  view.click('Browse'); view.click('Delete connection'); view.click('Delete connection'); await settle(); view.render();
  assert.equal(text(activeConnectionTab(view)), 'Diagnostics'); assertConnectionPanel(view);
  assert.ok(view.visible().some(node => node.props?.role === 'status' && text(node).includes('Synthetic saved references block deletion')));
});
await check('a saved general connection error remains visible while browsing or reviewing diagnostics', () => {
  const message = 'Synthetic transport failure needs investigation';
  const connection = { id: 'failed-opc', name: 'Failed connection', type: 'opcua', revision: 3, enabled: true, lastError: message };
  const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} });
  for (const section of ['Browse', 'Diagnostics']) {
    view.click(section);
    assert.ok(!view.visible().some(node => node.props?.['data-field'] === 'Connection name'), 'Configuration is hidden in ' + section);
    assert.ok(view.visible().some(node => node.props?.role === 'status' && text(node) === message), 'General error remains visible in ' + section);
  }
  assert.equal(view.calls.length, 0);
});
await check('adding a browsed symbol moves keyboard focus to its register-map draft', async () => {
  const connection = { id: 'ads-focus', name: 'Focus fixture', type: 'beckhoff-ads', revision: 3, enabled: true, device: devices.defaultDeviceSettings('beckhoff-ads') };
  const symbol = { nodeId: 'MAIN.Speed', address: 'MAIN.Speed', displayName: 'Speed', isVariable: true, dataType: 'Double', browseMode: 'native' };
  const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} }, async route => {
    assert.equal(route, '/connections/ads-focus/browse?nodeId='); return [symbol];
  });
  view.click('Browse'); view.click('Browse controller'); await settle(); view.render();
  const focused = [], mapTab = connectionTabs(view).find(tab => text(tab) === 'Register map');
  (mapTab.props.ref ?? mapTab.ref)({ focus: () => focused.push('Register map') });
  view.click('Add to map');
  assert.equal(text(activeConnectionTab(view)), 'Register map'); assert.deepEqual(focused, ['Register map']);
  assert.equal(view.button('Save connection').props.disabled, false); assert.equal(view.calls.length, 1, 'Adding a symbol changes the draft without another gateway operation');
});
await check('switching source tool sections preserves unapplied point and map drafts', () => {
  const view = tools(); view.props.section = 'points'; view.render();
  view.click('Add point'); view.change('Point name', 'Unapplied point'); view.change('Raw address', 'kept-address');
  view.props.section = 'browse'; view.render(); view.props.section = 'points'; view.render();
  assert.equal(view.field('Point name').props.value, 'Unapplied point'); assert.equal(view.field('Raw address').props.value, 'kept-address');
  assert.equal(view.changes.length, 0); assert.equal(view.calls.length, 0);
  view.click('Cancel point'); view.click('Import / edit JSON'); view.change('Source points JSON', JSON.stringify([point({ id: 'kept-map' })])); view.click('Validate map');
  view.props.section = 'browse'; view.render(); view.props.section = 'points'; view.render();
  view.click('Apply reviewed map to draft'); assert.equal(view.changes[0].points[0].id, 'kept-map'); assert.equal(view.calls.length, 0);
});
await check('source section visibility separates connection, security, acquisition and advanced controls', () => {
  for (const type of ['mtconnect', 'i3x']) {
    const view = ui(SourceConnectionFields, { type, source: model.defaultSourceSettings(type), section: 'connection', onChange() {} });
    const shown = label => view.visible().some(node => node.props?.['data-field'] === label);
    assert.equal(shown('Base URL'), true); assert.equal(shown('Authentication mode'), false);
    assert.equal(shown('Acquisition'), false); assert.equal(shown('Poll / sync interval (ms)'), false);
    const acquisitionLabel = type === 'mtconnect' ? 'Device filter' : 'Reconcile current state every (seconds)';
    assert.equal(shown(acquisitionLabel), false); assert.equal(shown('Request timeout (ms)'), false);
    view.props.section = 'security'; view.render(); assert.equal(shown('Authentication mode'), true); assert.equal(shown('Base URL'), false);
    view.props.section = 'acquisition'; view.render(); assert.equal(shown(acquisitionLabel), true); assert.equal(shown('Authentication mode'), false);
    assert.equal(shown('Acquisition'), true); assert.equal(shown('Poll / sync interval (ms)'), true);
    view.props.section = 'advanced'; view.render(); assert.equal(shown('Request timeout (ms)'), true); assert.equal(shown(acquisitionLabel), false);
  }
});
await check('MQTT selected mapping and extraction draft remain available after visiting another section', () => {
  let view; const source = model.defaultSourceSettings('mqtt'); source.mqtt.mappings = [mapping()];
  view = ui(SourceConnectionFields, { type: 'mqtt', source, section: 'mappings', onChange: next => { view.props.source = next; } });
  view.change('Mapping', 'm1'); view.change('Payload', 'script'); view.change('Extraction expression', 'json(payload).speed');
  assert.ok(view.visible().some(node => node.props?.['data-field'] === 'Extraction expression'));
  view.props.section = 'security'; view.render();
  assert.ok(!view.visible().some(node => node.props?.['data-field'] === 'Extraction expression'));
  view.props.section = 'mappings'; view.render();
  assert.equal(view.field('Mapping').props.value, 'm1'); assert.equal(view.field('Extraction expression').props.value, 'json(payload).speed');
  assert.ok(view.visible().some(node => node.props?.['data-field'] === 'Extraction expression'));
  assert.equal(view.calls.length, 0);
});
await check('leaving source browse preserves the reviewed import until a configuration change', async () => {
  const entry = { address: 'kept-value', name: 'Kept value', isVariable: true, dataType: 'Double' }, connection = sourceConnection();
  const view = tools(connection, async (route, _method, body) => route.endsWith('/browse') ? { entries: [entry], truncated: false } : route.endsWith('/preview') ? { previewToken: 'kept-review', points: body.points, tags: [], totalTags: 1 } : { imported: 1, connection: { ...connection, revision: 4 } });
  view.props.section = 'browse'; view.render(); view.click('Browse / refresh'); await settle(); view.render();
  view.find(node => node.type === 'input' && node.props['aria-label'] === 'Import Kept value').props.onChange({ target: { checked: true } }); view.render();
  view.click('Preview point and tag import'); await settle(); view.render();
  view.props.section = 'points'; view.render(); view.props.section = 'browse'; view.render();
  assert.equal(view.calls.length, 2); view.click('Apply reviewed import'); await settle(); view.render();
  assert.equal(view.calls[2][2].previewToken, 'kept-review'); assert.equal(view.imports[0].revision, 4);
});
await check('source tests show version and capabilities from revision-fenced source endpoint', async () => {
  const connection = sourceConnection(), saved = { success: true, message: 'Synthetic MTConnect profile accepted', revision: 3, accepted: true, durationMs: 12, completedAt: '2026-10-01T12:00:00Z' }; let view;
  view = ui(Connections, { connections: [connection], onChange: values => { view.props.connections = values; }, onTagsChanged() {}, notify() {} }, async route => route.endsWith('/source/test') ? { success: true, message: saved.message, version: '2.8', capabilities: { read: true, write: false }, details: { namespace: 'urn:mtconnect.org:MTConnectDevices:2.8' }, saved } : [connection], false);
  view.click('Test connection'); await settle(); view.render();
  assert.equal(view.calls[0][0], '/connections/source1/source/test'); assert.equal(view.calls[0][2].revision, 3); assert.equal(view.calls.length, 2);
  assert.match(view.content(), /Source version 2.8/); assert.match(view.content(), /tested revision 3/); assert.match(view.content(), /"write": false/);
});
await check('unaccepted or wrong-revision source test results cannot display stale capability evidence', async () => {
  for (const [accepted, revision] of [[false, 3], [true, 2]]) {
    const connection = sourceConnection();
    const view = ui(Connections, { connections: [connection], onChange() {}, onTagsChanged() {}, notify() {} }, async route => route.endsWith('/source/test') ? { success: true, message: 'obsolete', version: 'obsolete-version', capabilities: { read: true }, saved: { success: true, message: 'obsolete', accepted, revision } } : [connection], false);
    view.click('Test connection'); await settle(); view.render();
    assert.match(view.content(), /superseded/); assert.ok(!view.content().includes('obsolete-version'));
  }
});
await check('MQTT namespace migrations require reviewed token approval before saving', async () => {
  const connection = sourceConnection('mqtt'), calls = []; let view;
  view = ui(Connections, { connections: [connection], onChange: values => { view.props.connections = values; }, onTagsChanged() {}, notify() {} }, async (route, _method, body) => {
    calls.push([route, body]); return route.endsWith('/migration/preview') ? { token: 'migration-review', changed: true, changes: [{ pointId: 'stable', before: '[default]old/a', after: '[default]new/a' }] } : route === '/connections' && body ? { ...connection, revision: 4 } : [{ ...connection, revision: 4 }];
  }, false);
  view.find(node => node.type === 'input' && node.props.value === 'Source 1').props.onChange({ target: { value: 'Changed source' } }); view.render(); view.click('Save connection'); await settle(); view.render();
  assert.equal(calls.length, 1); assert.match(view.content(), /stable/); view.click('Save reviewed migration'); await settle(); view.render(); assert.equal(calls[1][1].sourceMigrationToken, 'migration-review');
});
await check('nested live source diagnostics render acquisition and transport independently without object children', async () => {
  const snapshot = { capturedAt: '2026-10-01T12:00:00Z', revision: 3, enabled: true, dependencyCount: 0, omittedDependencies: 0, omittedValues: 0, dependencies: [], values: [], subscriptions: [], source: {
    transport: { state: 'connected', generation: 4, bindingRevision: 3, acceptedValues: 7, lastAcceptedAt: '2026-10-01T12:00:00Z', diagnostics: { inputBytes: 179258, inputBytesPerSecond: 929.65, inputRateBasis: 'mean since connection owner creation', lastTransportActivityAt: '2026-10-01T12:00:00Z', mode: 'poll', catalogCount: 4 }, globalMemory: { state: 1380 }, peakGlobalMemory: { state: 1500 } },
    state: { state: 'degraded', generation: 4, bindingRevision: 3, message: 'Definitions unavailable', reason: 'AcquisitionFailure', lostUpdates: 2 }, acquisitionFailure: 'Acquisition commit rejected', ownership: 3,
  } };
  const view = ui(ConnectionDiagnostics, { connection: sourceConnection(), expanded: false, onExpandedChange() {} }, async () => snapshot);
  await settle(); view.render();
  assert.match(view.content(), /degraded · generation 4 · binding revision 3/); assert.match(view.content(), /Transport connected/);
  assert.match(view.content(), /Acquisition commit rejected/); assert.match(view.content(), /7 values · 2 known lost updates · 3 owned leaves/);
  assert.match(view.content(), /inputBytes179258/); assert.match(view.content(), /catalogCount4/); assert.match(view.content(), /peakGlobalMemory/);
});
await check('source diagnostics fall back to disconnected transport before any acquisition status exists', async () => {
  const view = ui(ConnectionDiagnostics, { connection: sourceConnection(), expanded: false, onExpandedChange() {} }, async () => ({ capturedAt: '2026-10-01T12:00:00Z', revision: 3, enabled: true, dependencyCount: 0, omittedDependencies: 0, omittedValues: 0, dependencies: [], values: [], subscriptions: [], source: { transport: { state: 'disconnected' }, state: null, acquisitionFailure: null, ownership: 0 } }));
  await settle(); view.render(); assert.match(view.content(), /Transport disconnected/); assert.match(view.content(), /not received · 0 values/);
});
console.log(`${passed} source connection engineering checks passed.`);
