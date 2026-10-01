import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

// Pure schema and staged-editor checks; no gateway session or equipment traffic.
const require = createRequire(import.meta.url), modules = new Map();
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hooksUrl = asModule(`let values=[],index=0,pending=[],writeCount=0; export const begin=()=>{index=0;}; export const unmount=()=>{values.forEach(value=>value?.cleanup?.());pending=[];}; export const clear=()=>{unmount();values=[];index=0;pending=[];writeCount=0;}; export const writes=()=>writeCount; export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{writeCount++;values[at]=typeof next==='function'?next(values[at]):next;}];};export const useRef=value=>{const at=index++;return values[at]??=( {current:value} );};export const useEffect=(run,deps)=>{const at=index++,before=values[at];if(!before||deps.some((value,i)=>value!==before.deps[i]))pending.push(()=>{before?.cleanup?.();values[at]={deps,cleanup:run()};});};export const flushEffects=()=>{const jobs=pending;pending=[];jobs.forEach(run=>run());};`);
const fieldUrl = asModule(`import React from ${JSON.stringify(reactUrl)};export const Field=props=>React.createElement('label',null,props.label,props.children);`);
const iconUrl = asModule(`export default ()=>null;`);
const connectionChildUrl = asModule('export default ()=>null;export const DeviceConnectionFields=()=>null;export const DeviceRegisterMap=()=>null;');
const apiUrl = asModule('export const api=(...args)=>globalThis.__deviceApi(...args);export const id=type=>type+"-fixture";export const displayValue=value=>String(value??"");export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}');
function url(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) return asModule('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8'));
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooksUrl : dependency === './App' ? fieldUrl : dependency === './Icon' ? iconUrl : name === 'Connections' && ['./ConnectionDiagnostics', './CreationMenu', './DeviceConnectionEditor'].includes(dependency) ? connectionChildUrl : name === 'Connections' && dependency === './api' ? apiUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const result = asModule(code); modules.set(name, result); return result;
}
const model = await import(url('deviceConnections'));
const { writableActionTags } = await import(url('componentActionsAuthoring'));
const hooks = await import(hooksUrl), { DeviceConnectionFields, DeviceRegisterMap } = await import(url('DeviceConnectionEditor'));
let passed = 0;
const check = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const point = (patch = {}) => ({ id: 'speed', name: 'Speed', address: 'holdingRegister:100', dataType: 'Float', writable: false, scale: 1, offset: 0, ...patch });
const parse = (value, type = 'modbus-tcp') => model.parseDevicePointImport(type, JSON.stringify(value));
const familyParse = (value, family) => model.parseDevicePointImport('ab-eip', JSON.stringify(value), family);
check('all four driver defaults have protocol-specific ports and a valid initial authored point', () => {
  for (const [type, port] of [['modbus-tcp', 502], ['ab-eip', 44818], ['siemens-s7', 102], ['beckhoff-ads', 851]]) {
    assert.equal(model.defaultDeviceSettings(type).port, port); assert.deepEqual(model.validateDevicePoints(type, [model.newDevicePoint(type, 1)]), []);
  }
});
check('map import accepts array/envelope and preserves exact codec fields', () => {
  const points = [point({ writable: true, byteSwap: true, wordSwap: true, scale: 0.1, offset: -2 })];
  assert.deepEqual(parse(points), points); assert.deepEqual(parse({ points }), points);
});
check('invalid roots, duplicate identities, unknown fields and non-Boolean authority fail closed', () => {
  for (const input of [{}, null, [null], [point(), point()], [point({ id: '1' })], [point({ id: 'a'.repeat(65) })], [point({ writable: 'true' })], [point({ credentials: 'ignored' })]]) assert.throws(() => parse(input));
});
check('Modbus addresses reject reference-number ambiguity, input writes and overflow', () => {
  for (const item of [point({ address: '40001' }), point({ address: 'holdingRegister:65535' }), point({ address: 'inputRegister:0', writable: true }), point({ address: 'discreteInput:0', dataType: 'Boolean', writable: true }), point({ address: 'coil:0' }), point({ address: 'coil:0', dataType: 'Boolean', byteSwap: true })]) assert.throws(() => parse([item]));
  assert.deepEqual(parse([point({ address: 'coil:65535', dataType: 'Boolean', writable: true })]).map(item => item.address), ['coil:65535']);
});
check('string layouts respect read/write request sizes and native protocol capacity', () => {
  assert.equal(parse([point({ dataType: 'String', stringLength: 250 })])[0].stringLength, 250);
  assert.throws(() => parse([point({ dataType: 'String', stringLength: 250, writable: true })]));
  assert.throws(() => parse([point({ dataType: 'String', address: 'Text', stringLength: 83 })], 'ab-eip'));
  assert.throws(() => parse([point({ dataType: 'String', address: 'DB1.DBB0', stringLength: 255 })], 'siemens-s7'));
});
check('numeric scaling requires finite invertible metadata and does not apply to Boolean/text', () => {
  for (const item of [point({ scale: 0 }), point({ scale: '1' }), point({ offset: null }), point({ address: 'coil:0', dataType: 'Boolean', scale: 2 }), point({ dataType: 'String', stringLength: 12, offset: 1 })]) assert.throws(() => parse([item]));
  assert.deepEqual(parse([point({ scale: -0.5, offset: 4 })])[0].scale, -0.5);
});
check('raw integer storage supports fractional Double engineering without changing register widths', () => {
  const temperature = point({ address: 'holdingRegister:65535', dataType: 'Double', rawDataType: 'UInt16', scale: 0.1 });
  assert.deepEqual(parse([temperature])[0], temperature); assert.equal(model.pointStorageType(temperature), 'UInt16');
  assert.equal(parse([point({ address: 'DB1.DBW0', dataType: 'Double', rawDataType: 'Int16', scale: 0.1 })], 'siemens-s7')[0].dataType, 'Double');
  for (const item of [point({ rawDataType: 'Boolean' }), point({ rawDataType: 'Unknown' }), point({ dataType: 'String', rawDataType: 'UInt16', stringLength: 30 }), point({ dataType: 'Boolean', rawDataType: 'Double', address: 'coil:0' })]) assert.throws(() => parse([item]));
  assert.throws(() => parse([point({ dataType: 'Double', rawDataType: 'UInt16', scale: 1e-29 })]), /decimal precision/);
  assert.throws(() => parse([point({ dataType: 'Double', rawDataType: 'UInt16', offset: 1e29 })]), /decimal precision/);
});
check('native symbol identity cannot collide with a saved ID and ADS strings retain native capacity', () => {
  const saved = point({ id: 'Speed', address: 'Program:Main.Other', dataType: 'Double', rawDataType: 'UInt16', scale: 0.1 });
  const connection = { type: 'ab-eip', device: { points: [saved] } };
  assert.equal(model.mappedDevicePoint(connection, { nodeId: 'Speed', address: 'Speed', browseMode: 'native' }), undefined);
  assert.equal(model.mappedDevicePoint(connection, { nodeId: 'Program:Main.Other', address: 'Program:Main.Other', pointId: 'Speed', browseMode: 'native' }), saved);
  assert.equal(model.mappedDevicePoint(connection, { nodeId: 'Speed', address: 'Speed', pointId: 'Speed', browseMode: 'native' }), undefined);
  const textPoint = model.nativeDevicePoint('beckhoff-ads', { nodeId: 'MAIN.Name', address: 'MAIN.Name', displayName: 'Name', dataType: 'String', stringLength: 30, writable: true }, 1);
  assert.equal(textPoint.stringLength, 30); assert.equal(textPoint.rawDataType, 'String'); assert.equal(textPoint.writable, false);
});
check('native drivers reject transport strings, swaps and mismatched S7 widths', () => {
  assert.equal(parse([point({ address: 'Program:Main.Speed' })], 'ab-eip')[0].address, 'Program:Main.Speed');
  assert.equal(parse([point({ address: 'MAIN.Values[0]' })], 'beckhoff-ads')[0].address, 'MAIN.Values[0]');
  for (const [type, item] of [['ab-eip', point({ address: 'Speed&gateway=other' })], ['beckhoff-ads', point({ address: 'MAIN.Speed', wordSwap: true })], ['siemens-s7', point({ address: 'DB1.DBW0' })], ['siemens-s7', point({ address: 'Q0.0', dataType: 'Boolean', writable: true })]]) assert.throws(() => parse([item], type));
});
check('all six Allen Bradley families apply qualified routes and native-browse capabilities', () => {
  const initial = model.defaultDeviceSettings('ab-eip');
  assert.deepEqual(model.allenBradleyFamilies, ['ControlLogix', 'CompactLogix', 'Micro800', 'MicroLogix', 'Slc500', 'Plc5']);
  for (const family of model.allenBradleyFamilies) {
    const settings = model.withAllenBradleyFamily(initial, family), logix = ['ControlLogix', 'CompactLogix'].includes(family);
    assert.equal(settings.route, logix ? '1,0' : ''); assert.equal(model.supportsNativeDeviceBrowse('ab-eip', family), logix); assert.deepEqual(model.validateAllenBradleySettings(settings), []);
    assert.deepEqual(model.validateDevicePoints('ab-eip', [model.newDevicePoint('ab-eip', 1, family)], family), []);
    if (!logix) assert.ok(model.validateAllenBradleySettings({ ...settings, route: '1,0' }).length);
  }
  assert.equal(model.withAllenBradleyFamily({ ...initial, route: '' }, 'ControlLogix').route, '1,0');
  for (const route of ['', '1', '1,0,1', '1,256', '1,0, 2,3']) assert.ok(model.validateAllenBradleySettings({ ...initial, route }).length);
  assert.deepEqual(model.validateAllenBradleySettings({ ...initial, route: '1,0,2,3' }), []);
  assert.match(model.allenBradleyFamilyName('Micro800'), /Micro850.*Micro870/);
});
check('PCCC file maps preserve native storage, Boolean masked-write addresses and engineering scaling', () => {
  for (const family of ['MicroLogix', 'Slc500', 'Plc5']) {
    const points = [point({ id: 'word', address: 'n7:0', dataType: 'Double', rawDataType: 'Int16', scale: 0.1 }), point({ id: 'bits', address: 'B3:0', dataType: 'UInt16' }), point({ id: 'bit', address: 'N7:0/15', dataType: 'Boolean', writable: true }), point({ id: 'real', address: 'F8:0', dataType: 'Double', rawDataType: 'Float' }), point({ id: 'text', address: 'ST9:0', dataType: 'String', stringLength: 82 })];
    assert.deepEqual(familyParse(points, family), points); assert.match(model.pointAddressHint('ab-eip', family), /N7:0.*F8:0.*ST9:0/);
  }
  assert.equal(familyParse([point({ address: 'L9:0', dataType: 'Double', rawDataType: 'Int32' })], 'MicroLogix')[0].rawDataType, 'Int32');
});
check('PCCC family validation rejects unsupported files, widths, subfields and unbounded addresses', () => {
  const invalid = [point({ address: 'N256:0', dataType: 'Int16' }), point({ address: 'N7:65536', dataType: 'Int16' }), point({ address: 'N0007:0', dataType: 'Int16' }), point({ address: 'N7:000000', dataType: 'Int16' }), point({ address: 'N7:0/015', dataType: 'Boolean' }), point({ address: 'B3:0/16', dataType: 'Boolean' }), point({ address: 'F8:0/0', dataType: 'Boolean' }), point({ address: 'N7:0.ACC', dataType: 'Int16' }), point({ address: 'T4:0', dataType: 'Int16' }), point({ address: 'I0:0', dataType: 'Int16' }), point({ address: 'N7:0', dataType: 'Double' }), point({ address: 'F8:0', dataType: 'Int16' }), point({ address: 'ST9:0', dataType: 'String', stringLength: 83 })];
  for (const family of ['MicroLogix', 'Slc500', 'Plc5']) for (const item of invalid) assert.throws(() => familyParse([item], family));
  for (const family of ['Slc500', 'Plc5']) assert.throws(() => familyParse([point({ address: 'L9:0', dataType: 'Int32' })], family));
  assert.deepEqual(model.rawNumericPointTypes('ab-eip', 'Plc5'), ['Int16', 'UInt16', 'Float']);
});
check('Micro800 symbols reject Program scope and unqualified string layouts', () => {
  assert.equal(familyParse([point({ address: 'MyStruct.Values[0]', dataType: 'Double', rawDataType: 'UInt16' })], 'Micro800')[0].address, 'MyStruct.Values[0]');
  assert.throws(() => familyParse([point({ address: 'Program:Main.Speed' })], 'Micro800'));
  assert.throws(() => familyParse([point({ address: 'Name', dataType: 'String', stringLength: 80 })], 'Micro800'), /Micro800/);
  assert.ok(!model.engineeringPointTypes('ab-eip', 'Micro800').includes('String'));
});
check('map change preview reports removals and replacements without changing the original map', () => {
  const before = [point(), point({ id: 'old', name: 'Old' })], original = structuredClone(before);
  assert.deepEqual(model.deviceMapChanges(before, [point({ name: 'New name' }), point({ id: 'new' })]).map(change => change.action), ['Change', 'Add', 'Remove']); assert.deepEqual(before, original);
});
check('compact map capacity accounts for omitted codec defaults and UTF-8 text', () => {
  const minimal = point(); assert.equal(model.deviceMapBytes([minimal]), model.deviceMapBytes([{ ...minimal, byteSwap: false, wordSwap: false, stringLength: 32 }]));
  assert.ok(model.deviceMapBytes([point({ name: 'Température' })]) > model.deviceMapBytes([point({ name: 'Temperature' })]));
  const large = Array.from({ length: 1500 }, (_, index) => point({ id: `p${index}`, name: 'A'.repeat(200), address: 'MAIN.' + 'A'.repeat(480) }));
  assert.ok(JSON.stringify(large).length < 2 * 1024 * 1024); assert.throws(() => parse(large, 'beckhoff-ads'), /compact register map exceeds 768 KiB/);
});
check('operator actions include only explicitly writable device values', () => {
  const tags = [{ path: 'memory', source: 'memory', dataType: 'Double' }, { path: 'opc', source: 'opcua', dataType: 'Float' }, { path: 'read', source: 'device', dataType: 'Double', writable: false }, { path: 'unknown', source: 'device', dataType: 'Double' }, { path: 'write', source: 'device', dataType: 'Double', writable: true }, { path: 'structure', source: 'device', dataType: 'Structure', writable: true }];
  assert.deepEqual(writableActionTags(tags).map(tag => tag.path), ['memory', 'opc', 'write']);
});
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function editor(initial, type = 'modbus-tcp', controllerFamily) {
  hooks.clear(); let tree; const changes = [], props = { type, controllerFamily, points: initial, onChange: next => { changes.push(next); props.points = next; } };
  const expand = node => !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: React.Children.toArray(node.props.children).map(expand) } };
  const render = () => { hooks.begin(); tree = expand(DeviceRegisterMap(props)); hooks.flushEffects(); };
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node); return node; };
  const click = label => { const button = find(node => node.type === 'button' && text(node) === label); assert.ok(!button.props.disabled); button.props.onClick(); render(); };
  const editJson = value => { find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); };
  const chooseFile = file => { find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: file ? [file] : [] } }); render(); };
  render(); return { click, editJson, chooseFile, changes, render, find, props, content: () => text(tree) };
}
check('JSON import only changes the connection draft after explicit validation/review/apply', () => {
  const ui = editor([point()]); ui.click('Import / edit JSON'); ui.editJson(JSON.stringify([point({ id: 'new' })])); ui.click('Validate and preview map'); assert.deepEqual(ui.changes, []); assert.match(ui.content(), /2 changes/);
  ui.click('Apply reviewed map to draft'); assert.equal(ui.changes.length, 1); assert.equal(ui.changes[0][0].id, 'new');
});
check('an invalid JSON map never becomes an applicable preview', () => {
  const ui = editor([point()]); ui.click('Import / edit JSON'); ui.editJson(JSON.stringify([point({ writable: 'yes' })])); ui.click('Validate and preview map'); assert.deepEqual(ui.changes, []); assert.match(ui.content(), /writable must be true or false/); assert.ok(!nodes(ui.find(node => node.type === 'div')).find(node => node.type === 'button' && text(node) === 'Apply reviewed map to draft'));
});
check('a map changed after preview invalidates apply until another review', () => {
  const ui = editor([point()]); ui.click('Import / edit JSON'); ui.editJson(JSON.stringify([point({ id: 'new' })])); ui.click('Validate and preview map'); ui.props.points = [point({ name: 'Concurrent edit' })]; ui.render();
  assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Apply reviewed map to draft').props.disabled, true); assert.deepEqual(ui.changes, []);
});
check('the point editor retains separate raw and engineering numeric types in its reviewed draft', () => {
  const temperature = point({ dataType: 'Double', rawDataType: 'UInt16', scale: 0.1 });
  const ui = editor([temperature]); ui.click('Edit');
  assert.ok(ui.content().includes('Raw storage data type')); assert.ok(ui.content().includes('Engineering data type'));
  assert.ok(ui.find(node => node.type === 'select' && node.props.value === 'UInt16'));
  assert.ok(ui.find(node => node.type === 'select' && node.props.value === 'Double'));
  ui.click('Apply point to draft'); assert.equal(ui.changes[0][0].rawDataType, 'UInt16'); assert.equal(ui.changes[0][0].scale, 0.1);
});
check('family changes clear direct routes and the register editor validates imported PCCC addresses', () => {
  let settings = model.defaultDeviceSettings('ab-eip');
  const fields = () => DeviceConnectionFields({ type: 'ab-eip', settings, onChange: value => { settings = value; } });
  nodes(fields()).find(node => node.type === 'select' && node.props.value === 'ControlLogix').props.onChange({ target: { value: 'Micro800' } });
  assert.equal(settings.route, ''); assert.equal(nodes(fields()).find(node => node.props?.label === 'CIP route').props.children.props.disabled, true);
  nodes(fields()).find(node => node.type === 'select').props.onChange({ target: { value: 'ControlLogix' } }); assert.equal(settings.route, '1,0');
  const ui = editor([], 'ab-eip', 'Slc500'); ui.click('Import / edit JSON'); ui.editJson(JSON.stringify([point({ address: 'N7:0', dataType: 'Double', rawDataType: 'UInt16', scale: 0.1 })])); ui.click('Validate and preview map'); ui.click('Apply reviewed map to draft'); assert.equal(ui.changes[0][0].address, 'N7:0');
});
check('an import preview validated for Logix cannot be applied after switching to PCCC', () => {
  const ui = editor([], 'ab-eip', 'ControlLogix'); ui.click('Import / edit JSON'); ui.editJson(JSON.stringify([point({ address: 'Speed' })])); ui.click('Validate and preview map');
  ui.props.controllerFamily = 'Slc500'; ui.render(); assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Apply reviewed map to draft').props.disabled, true); assert.deepEqual(ui.changes, []);
  ui.click('Validate and preview map'); assert.match(ui.content(), /supported PCCC file/); assert.deepEqual(ui.changes, []);
});
const { default: Connections } = await import(url('Connections'));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
function connectionUi(connection, handler) {
  hooks.clear(); const calls = [], props = { connections: [connection], onChange: value => { props.connections = value; }, onTagsChanged() {}, notify() {} }; let tree;
  globalThis.__deviceApi = (...args) => { calls.push(args); return handler(...args); };
  const render = () => { hooks.begin(); tree = Connections(props); hooks.flushEffects(); };
  const find = predicate => { const result = nodes(tree).find(predicate); assert.ok(result); return result; };
  const click = label => { const button = find(node => node.type === 'button' && text(node) === label); assert.ok(!button.props.disabled); button.props.onClick(); render(); };
  render(); return { props, render, click, find, calls, content: () => text(tree) };
}
const asyncCheck = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const mapFile = pending => ({ size: 100, text: () => pending.promise });
const applyButton = ui => nodes(ui.find(node => node.type === 'div')).find(node => node.type === 'button' && text(node) === 'Apply reviewed map to draft');
await asyncCheck('newer map files and typed JSON supersede older asynchronous file contents and failures', async () => {
  const older = deferred(), newer = deferred(), ui = editor([point()]); ui.click('Import / edit JSON'); ui.chooseFile(mapFile(older)); ui.chooseFile(mapFile(newer));
  newer.resolve(JSON.stringify([point({ id: 'newer' })])); await settle(); ui.render(); older.resolve(JSON.stringify([point({ id: 'older' })])); await settle(); ui.render();
  assert.equal(JSON.parse(ui.find(node => node.type === 'textarea').props.value)[0].id, 'newer');
  const pending = deferred(); ui.chooseFile(mapFile(pending)); ui.editJson(JSON.stringify([point({ id: 'typed' })])); ui.click('Validate and preview map');
  pending.resolve(JSON.stringify([point({ id: 'late-file' })])); await settle(); ui.render(); assert.equal(JSON.parse(ui.find(node => node.type === 'textarea').props.value)[0].id, 'typed');
  ui.click('Apply reviewed map to draft'); assert.equal(ui.changes[0][0].id, 'typed');
  ui.click('Import / edit JSON'); const failure = deferred(); ui.chooseFile(mapFile(failure)); ui.editJson(JSON.stringify([point({ id: 'preserved' })])); failure.reject(new Error('Obsolete file failure')); await settle(); ui.render(); assert.ok(!ui.content().includes('Obsolete file failure'));
});
await asyncCheck('accepted asynchronous file contents invalidate an older preview until the displayed JSON is reviewed', async () => {
  const pending = deferred(), ui = editor([point()]); ui.click('Import / edit JSON'); ui.chooseFile(mapFile(pending)); ui.click('Validate and preview map'); assert.ok(applyButton(ui));
  pending.resolve(JSON.stringify([point({ id: 'loaded' })])); await settle(); ui.render(); assert.equal(JSON.parse(ui.find(node => node.type === 'textarea').props.value)[0].id, 'loaded'); assert.equal(applyButton(ui), undefined); assert.deepEqual(ui.changes, []);
  ui.click('Validate and preview map'); ui.click('Apply reviewed map to draft'); assert.equal(ui.changes[0][0].id, 'loaded');
});
await asyncCheck('closing, disabling, changing configuration and unmounting fence pending map-file preparation', async () => {
  for (const transition of [ui => { ui.click('Import / edit JSON'); ui.click('Import / edit JSON'); }, ui => { ui.props.disabled = true; ui.render(); ui.props.disabled = false; ui.render(); }, ui => { ui.props.configurationKey = 'new-controller-revision'; ui.render(); }, ui => { ui.props.points = [point({ name: 'Changed map' })]; ui.render(); }, ui => { ui.props.controllerFamily = 'Micro800'; ui.render(); }, () => hooks.unmount()]) {
    const pending = deferred(), ui = editor([point()]); ui.click('Import / edit JSON'); ui.chooseFile(mapFile(pending)); transition(ui); const before = hooks.writes();
    pending.resolve(JSON.stringify([point({ id: 'discarded' })])); await settle(); assert.equal(hooks.writes(), before); assert.deepEqual(ui.changes, []);
  }
});
await asyncCheck('symbolic EtherNet/IP String remains unavailable while PCCC and other verified string profiles remain editable', async () => {
  const symbol = { nodeId: 'Text', address: 'Text', displayName: 'Text', isVariable: true, dataType: 'String', browseMode: 'native', stringLength: 82 };
  for (const family of ['ControlLogix', 'CompactLogix', 'Micro800']) {
    assert.ok(!model.engineeringPointTypes('ab-eip', family).includes('String'));
    assert.throws(() => familyParse([point({ address: 'Text', dataType: 'String', stringLength: 82 })], family), /String storage is outside/);
    assert.throws(() => familyParse([point({ address: 'Text', rawDataType: 'String', stringLength: 82 })], family), /String storage is outside/);
    assert.throws(() => model.nativeDevicePoint('ab-eip', symbol, 1, family), /supported scalar symbol/);
    const ui = editor([], 'ab-eip', family); ui.click('Add point'); assert.ok(!nodes(ui.find(node => node.type === 'select' && node.props.value === 'UInt16')).some(node => node.type === 'option' && node.props.value === 'String' || node.type === 'option' && text(node) === 'String'));
  }
  for (const family of ['MicroLogix', 'Slc500', 'Plc5']) {
    assert.ok(model.engineeringPointTypes('ab-eip', family).includes('String'));
    assert.equal(familyParse([point({ address: 'ST9:0', dataType: 'String', stringLength: 82 })], family)[0].dataType, 'String');
  }
  for (const type of ['modbus-tcp', 'siemens-s7', 'beckhoff-ads']) assert.ok(model.engineeringPointTypes(type).includes('String'));
  const ui = connectionUi({ id: 'plc', name: 'PLC', type: 'ab-eip', revision: 1, device: { controllerFamily: 'ControlLogix', route: '1,0', points: [] } }, async () => [symbol]);
  ui.click('Browse controller'); await settle(); ui.render(); assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Add to map').props.disabled, true);
  assert.match(ui.find(node => node.type === 'button' && text(node) === 'Add to map').props.title, /outside the supported controller profile/);
});
await asyncCheck('configured-only families retain saved-map browsing and test requires an authored point', async () => {
  for (const controllerFamily of ['Micro800', 'MicroLogix', 'Slc500', 'Plc5']) {
    const ui = connectionUi({ id: 'plc', name: 'PLC', type: 'ab-eip', revision: 1, device: { controllerFamily, route: '', points: [] } }, async () => []);
    assert.ok(!ui.content().includes('Browse controller')); assert.ok(ui.content().includes('Browse saved map'));
    const test = ui.find(node => node.type === 'button' && text(node) === 'Test connection'); assert.equal(test.props.disabled, true); assert.match(test.props.title, /at least one point/);
    ui.click('Browse saved map'); await settle(); assert.ok(ui.calls[0][0].includes('nodeId=%40configured'));
  }
});
await asyncCheck('native quick watch and tag creation resolve saved point IDs rather than symbol names', async () => {
  const saved = point({ id: 'Speed', address: 'Program:Main.Other', dataType: 'Double', rawDataType: 'UInt16', scale: 0.1 });
  const mapped = { nodeId: saved.address, address: saved.address, pointId: saved.id, displayName: 'Other', isVariable: true, dataType: 'Double', browseMode: 'native' };
  const ui = connectionUi({ id: 'plc', name: 'PLC', type: 'ab-eip', revision: 3, device: { points: [saved] } }, async route => route.includes('/browse') ? [mapped] : route.includes('/read') ? [{ nodeId: 'Speed', value: 12.3, quality: 'Good', timestamp: '2026-10-01T01:00:00Z', dataType: 'Double' }] : {});
  ui.click('Browse controller'); await settle(); ui.render(); ui.click('Read value'); await settle(); ui.render();
  assert.deepEqual(ui.calls.find(call => call[0].includes('/read'))[2], { revision: 3, nodeIds: ['Speed'] }); assert.ok(ui.content().includes('12.3'));
  ui.click('Add tag'); ui.find(node => node.type === 'button' && node.props.className === 'button primary' && text(node) === 'Add tag').props.onClick(); await settle();
  const body = ui.calls.find(call => call[0] === '/tags')[2]; assert.equal(body.nodeId, 'Speed'); assert.equal(body.dataType, 'Double');
});
await asyncCheck('late browse/read results cannot cross a saved revision refresh and drafts survive it', async () => {
  let resolveBrowse; const saved = { id: 'plc', name: 'PLC', type: 'ab-eip', revision: 1, device: { points: [point()] } };
  const ui = connectionUi(saved, () => new Promise(resolve => { resolveBrowse = resolve; }));
  ui.click('Browse controller'); ui.props.connections = [{ ...saved, revision: 2 }]; ui.render();
  resolveBrowse([{ nodeId: 'Old', address: 'Old', displayName: 'Stale symbol', isVariable: true, dataType: 'Float', browseMode: 'native' }]); await settle(); ui.render(); assert.ok(!ui.content().includes('Stale symbol'));
  ui.find(node => node.type === 'input' && node.props.value === 'PLC').props.onChange({ target: { value: 'Draft name' } }); ui.render();
  ui.props.connections = [{ ...saved, name: 'Other engineer', revision: 3 }]; ui.render(); ui.render();
  assert.ok(ui.find(node => node.type === 'input' && node.props.value === 'Draft name')); assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Save connection').props.disabled, false);
  let resolveRead;
  const mapped = { nodeId: 'speed', pointId: 'speed', address: 'holdingRegister:100', displayName: 'Speed', isVariable: true, dataType: 'Float', browseMode: 'configured' };
  const reader = connectionUi({ ...saved, type: 'modbus-tcp' }, route => route.includes('/browse') ? Promise.resolve([mapped]) : new Promise(resolve => { resolveRead = resolve; }));
  reader.click('Browse saved map'); await settle(); reader.render(); reader.click('Read value'); reader.props.connections = [{ ...saved, type: 'modbus-tcp', revision: 2 }]; reader.render();
  resolveRead([{ nodeId: 'speed', value: 'Old read response', quality: 'Good', timestamp: '2026-10-01T01:00:00Z', dataType: 'Float' }]); await settle(); reader.render(); assert.ok(!reader.content().includes('Old read response'));
});
await asyncCheck('a parent poll observing our own new revision does not interrupt successful Save acknowledgement', async () => {
  const saved = { id: 'plc', name: 'PLC', type: 'modbus-tcp', revision: 1, device: { points: [point()] } }, newer = { ...saved, name: 'Saved draft', revision: 2 }; let resolveRefresh;
  const ui = connectionUi(saved, (_route, method) => method === 'POST' ? Promise.resolve(newer) : new Promise(resolve => { resolveRefresh = resolve; }));
  ui.find(node => node.type === 'input' && node.props.value === 'PLC').props.onChange({ target: { value: newer.name } }); ui.render(); ui.click('Save connection'); await settle();
  ui.props.connections = [newer]; ui.render(); resolveRefresh([newer]); await settle(); ui.render();
  assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Save connection').props.disabled, true);
});
await asyncCheck('an obsolete read cannot release the new saved revision read lock or publish stale errors', async () => {
  for (const failOld of [false, true]) {
    const saved = { id: 'plc', name: 'PLC', type: 'modbus-tcp', revision: 1, device: { points: [point()] } };
    const mapped = { nodeId: 'speed', pointId: 'speed', address: 'holdingRegister:100', displayName: 'Speed', isVariable: true, dataType: 'Float', browseMode: 'configured' }, reads = [];
    const ui = connectionUi(saved, route => route.includes('/browse') ? Promise.resolve([mapped]) : (() => { const pending = deferred(); reads.push(pending); return pending.promise; })());
    ui.click('Browse saved map'); await settle(); ui.render(); ui.click('Read value'); ui.props.connections = [{ ...saved, revision: 2 }]; ui.render(); ui.render();
    ui.click('Browse saved map'); await settle(); ui.render(); ui.click('Read value'); assert.equal(reads.length, 2);
    if (failOld) reads[0].reject(new Error('Obsolete read failure')); else reads[0].resolve([{ nodeId: 'speed', value: 'Obsolete value', quality: 'Good', dataType: 'Float', timestamp: '2026-10-01T01:00:00Z' }]);
    await settle(); ui.render(); assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Reading…').props.disabled, true); assert.ok(!ui.content().includes('Obsolete'));
    reads[1].resolve([{ nodeId: 'speed', value: 12.3, quality: 'Good', dataType: 'Float', timestamp: '2026-10-01T01:00:00Z' }]); await settle(); ui.render(); assert.equal(ui.find(node => node.type === 'button' && text(node) === 'Read value').props.disabled, false); assert.ok(ui.content().includes('12.3'));
  }
});
console.log(`${passed} industrial connection UI checks passed.`);
