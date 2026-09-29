#!/usr/bin/env node
// Isolated gateway only. Creates and archives its own projects; no device writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Drawing tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const created = [], run = randomUUID().slice(0, 12);
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const types = ['line', 'rectangle', 'ellipse', 'polyline', 'pipe', 'equipmentSymbol'];
const fillTypes = ['rectangle', 'ellipse', 'pipe', 'equipmentSymbol'];
const points = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 160 });
const binding = (expression, references = {}) => ({ expression, references });
const drawingProps = type => ({ strokeColor: '#123456', strokeWidth: type === 'pipe' ? 12 : 2, rotation: 0,
  ...(fillTypes.includes(type) ? { fillColor: type === 'pipe' ? '#334155' : type === 'equipmentSymbol' ? '#64748b' : 'none' } : {}),
  ...(['line', 'polyline', 'pipe'].includes(type) ? { points: structuredClone(points) } : {}),
  ...(type === 'rectangle' ? { cornerRadius: 12 } : {}), ...(type === 'pipe' ? { flowing: false, flowReverse: false } : {}),
  ...(type === 'equipmentSymbol' ? { symbol: 'pump', active: false } : {}),
});
const makeDrawings = () => types.map(type => component(type, type, drawingProps(type)));
const props = (project, id) => project.screens[0].components.find(item => item.id === id).props;
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected drawings must preserve the draft and revision.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
const action = ({ screen = 'main', id = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/${id}/action`), {
  method: 'POST', status, body: { publishedAt, ...body },
});

function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), method = bytes.readUInt16LE(offset + 10);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)); assert.ok(method === 0 || method === 8);
    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) }); offset += 46 + length + extra + comment;
  }
  return entries;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Drawing components ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { area: 'Demo' };
  draft.templates = [{ id: 'equipment', name: 'Reusable equipment', width: 600, height: 400, parameters: { name: 'Template pump' }, components: [
    ...makeDrawings(), component('open', 'equipmentSymbol', { symbol: 'valve', action: 'openPopup', targetScreenId: 'detail', parameters: { selected: '{name}' } }),
    component('template-reading', 'numberInput', { fieldKey: 'templateReading', defaultValue: 20 }),
    component('apply', 'button', { action: 'script', script: 'result = inputs' }),
  ] }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 900, parameters: {}, components: [
    ...makeDrawings(), ...types.map(type => component(`default-${type}`, type, {})),
    component('reading', 'numberInput', { fieldKey: 'reading', defaultValue: 37, min: 0, max: 100 }),
    component('legacy-label', 'label', { text: 'Legacy' }), component('legacy-value', 'value', { tagPath: '[default]{area}/Load' }),
    component('template', 'template', { templateId: 'equipment', parameters: { name: 'Instance pump' } }),
    component('rows', 'repeater', { templateId: 'equipment', rows: [{ id: 'one', parameters: { name: 'Row pump' } }], columns: 1, gap: 0 }),
    component('open', 'equipmentSymbol', { symbol: 'pump', action: 'openPopup', targetScreenId: 'detail', parameters: { selected: '{area}' } }),
    component('navigate', 'equipmentSymbol', { symbol: 'motor', action: 'navigate', targetScreenId: 'main' }),
    component('button-open', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { selected: 'Button' } }),
    component('apply', 'button', { action: 'script', script: 'result = inputs' }),
  ] }, { id: 'detail', kind: 'popup', name: 'Equipment details', width: 400, height: 300, parameters: { selected: 'Default' }, components: [
    component('apply', 'button', { action: 'script', script: 'result = parameters' }),
    component('symbol', 'equipmentSymbol', { symbol: 'motor' }),
  ] }];
  await test('six graphic types save and publish with explicit and omitted defaults across templates', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const type of types) { assert.deepEqual(props(runtime, type), props(draft, type)); assert.deepEqual(props(runtime, `default-${type}`), {}); }
    assert.deepEqual(runtime.templates[0].components.map(item => item.type), draft.templates[0].components.map(item => item.type));
  });
  await test('static vector styles reject malformed values even when a binding overrides them', async () => {
    for (const type of types) {
      for (const strokeColor of [null, true, 'red', 'none', 'url(#paint)', '#ggg']) await reject(project => { props(project, type).strokeColor = strokeColor; });
      for (const color of [null, true, 'red', 'none', 'url(#paint)']) await reject(project => { props(project, type).color = color; });
      for (const strokeWidth of [null, '2', false, 0, 32.01, 9007199254740992]) await reject(project => { props(project, type).strokeWidth = strokeWidth; });
      for (const rotation of [null, '0', false, -0.1, 360.1]) await reject(project => { props(project, type).rotation = rotation; });
      await reject(project => { props(project, type).strokeWidth = null; props(project, type).bindings = { strokeWidth: binding('2') }; });
      for (const field of ['svg', 'path', 'd', 'markup', 'src', 'url', 'href', 'script', 'tagPath']) await reject(project => { props(project, type)[field] = 'unsupported'; });
      await reject(project => { props(project, type).events = { change: { language: 'javascript', code: 'return {};' } }; });
    }
    for (const type of fillTypes) for (const fillColor of [null, false, 'NONE', 'none ', 'transparent', 'url(#fill)']) await reject(project => { props(project, type).fillColor = fillColor; });
    for (const cornerRadius of [null, '4', true, -1, 50.1]) await reject(project => { props(project, 'rectangle').cornerRadius = cornerRadius; });
    for (const symbol of [null, false, 'fan', 'Pump', '<svg>']) await reject(project => { props(project, 'equipmentSymbol').symbol = symbol; });
    for (const [type, field] of [['pipe', 'flowing'], ['pipe', 'flowReverse'], ['equipmentSymbol', 'active']])
      for (const value of [null, 'true', 1]) await reject(project => { props(project, type)[field] = value; });
  });
  await test('point paths use bounded normalized coordinates and preserve editable control points', async () => {
    for (const type of ['line', 'polyline', 'pipe']) for (const invalid of [null, '0,0 100,100', [], [points[0]], [{ x: 0, y: 0 }, { x: 0, y: 0 }],
      [{ x: -1, y: 0 }, points[1]], [{ x: 0, y: 101 }, points[1]], [{ x: null, y: 0 }, points[1]], [{ x: '0', y: 0 }, points[1]],
      [{ x: 0 }, points[1]], [{ x: 0, y: 0, z: 1 }, points[1]], [null, points[1]], Array.from({ length: 65 }, (_, index) => ({ x: index, y: 0 }))])
      await reject(project => { props(project, type).points = invalid; });
    await reject(project => { props(project, 'line').points = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }]; });
    props(draft, 'line').points = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    props(draft, 'polyline').points = Array.from({ length: 64 }, (_, index) => ({ x: index, y: index % 2 ? 100 : 0 }));
    props(draft, 'pipe').points = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 0 }];
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const type of ['line', 'polyline', 'pipe']) assert.deepEqual(props(runtime, type).points, props(draft, type).points);
  });
  await test('graphics fields and fx targets apply only to their supported component types', async () => {
    const specifics = { fillColor: ['rectangle', 'ellipse', 'pipe', 'equipmentSymbol'], points: ['line', 'polyline', 'pipe'], cornerRadius: ['rectangle'], symbol: ['equipmentSymbol'], flowing: ['pipe'], flowReverse: ['pipe'], active: ['equipmentSymbol'] };
    const values = { fillColor: 'none', points, cornerRadius: 2, symbol: 'pump', flowing: false, flowReverse: false, active: false };
    for (const [field, supported] of Object.entries(specifics)) for (const type of types.filter(type => !supported.includes(type))) {
      await reject(project => { props(project, type)[field] = values[field]; });
      await reject(project => { props(project, type).bindings = { [field]: binding(JSON.stringify(values[field])) }; });
    }
    for (const id of ['legacy-label', 'legacy-value', 'reading', 'template']) for (const field of ['strokeColor', 'strokeWidth', 'fillColor', 'rotation', 'flowing', 'flowReverse', 'active'])
      await reject(project => { props(project, id).bindings = { [field]: binding('1') }; });
    for (const type of types) for (const field of ['points', 'symbol', 'cornerRadius']) await reject(project => { props(project, type).bindings = { [field]: binding('1') }; });
  });
  await test('constrained constant fx expressions reject bad result types and support safe lazy branches', async () => {
    const bad = { color: ["'red'", "'none'", "'url(#paint)'", 'true', '2'], strokeColor: ["'red'", "'none'", 'true', '2'], strokeWidth: ['0', '33', "'2'", '1 / 0', '0 / 0', '9007199254740991 + 1'],
      fillColor: ["'transparent'", "'url(#fill)'", '2'], rotation: ['-1', '361', "'90'", 'true'], flowing: ['1', "'true'"], flowReverse: ['0', '1 / 0'] };
    for (const [target, expressions] of Object.entries(bad)) for (const expression of expressions) await reject(project => { props(project, 'pipe').bindings = { [target]: binding(expression) }; });
    for (const expression of ['1', "'false'", '0 / 0']) await reject(project => { props(project, 'equipmentSymbol').bindings = { active: binding(expression) }; });
    await reject(project => { props(project, 'pipe').bindings = { strokeWidth: binding("'bad'", { unused: { kind: 'parameter', key: 'area' } }) }; });
    props(draft, 'pipe').bindings = { strokeColor: binding("'#' + 'aabbcc'"), strokeWidth: binding('true ? 12 : 1 / 0'), fillColor: binding("'none'"),
      rotation: binding('180 + 180'), flowing: binding('true || (1 / 0 > 0)'), flowReverse: binding('false && (1 / 0 > 0)') };
    props(draft, 'equipmentSymbol').bindings = { active: binding('true') };
    await save(); await publish(); assert.deepEqual(props(await api(route('/runtime/project')), 'pipe').bindings, props(draft, 'pipe').bindings);
  });
  await test('dynamic bindings use the existing input, parameter, custom and tag scopes', async () => {
    const pipe = props(draft, 'pipe'); pipe.customProperties = { outline: { type: 'string', value: '#abcdef' }, running: { type: 'boolean', value: true } };
    pipe.bindings = { strokeColor: binding('outline', { outline: { kind: 'custom', key: 'outline' } }), strokeWidth: binding('reading / 10', { reading: { kind: 'input', key: 'reading' } }),
      flowing: binding('running', { running: { kind: 'custom', key: 'running' } }), flowReverse: binding('reverse', { reverse: { kind: 'tag', path: '[default]{area}/Reverse' } }) };
    props(draft, 'equipmentSymbol').bindings = { active: binding('running', { running: { kind: 'custom', componentId: 'pipe', key: 'running' } }) };
    draft.templates[0].components[0].props.bindings = { strokeColor: binding("name == 'Template pump' ? '#fff' : '#000'", { name: { kind: 'parameter', key: 'name' } }) };
    await save(); await publish();
    await reject(project => { props(project, 'pipe').bindings.strokeWidth.references.reading.key = 'templateReading'; });
    await reject(project => { props(project, 'pipe').bindings.flowReverse.references.reverse.path = '[default]{missing}/Reverse'; });
    await reject(project => { project.templates[0].components[0].props.bindings = { rotation: binding('reading', { reading: { kind: 'input', key: 'reading' } }) }; });
    assert.deepEqual(props(await api(route('/runtime/project')), 'pipe').bindings, pipe.bindings);
  });
  await test('equipment navigation validates target kinds and overrides while primitives remain inert', async () => {
    for (const type of types.filter(type => type !== 'equipmentSymbol')) await reject(project => { props(project, type).action = 'navigate'; props(project, type).targetScreenId = 'main'; });
    for (const action of [null, false, '', 'script', 'closePopup', 'writeTag']) await reject(project => { props(project, 'equipmentSymbol').action = action; });
    await reject(project => { props(project, 'open').targetScreenId = 'missing'; });
    await reject(project => { props(project, 'open').targetScreenId = 'main'; });
    await reject(project => { props(project, 'navigate').targetScreenId = 'detail'; });
    await reject(project => { props(project, 'navigate').parameters = { selected: 'ignored' }; });
    await reject(project => { props(project, 'open').parameters = { unknown: 'forged' }; });
    await reject(project => { props(project, 'open').parameters = { selected: null }; });
    await reject(project => { props(project, 'open').targetScreenId = null; });
    assert.deepEqual((await action()).result, { reading: 37 });
    assert.deepEqual((await action({ instanceId: 'template' })).result, { templateReading: 20 });
    assert.deepEqual((await action({ instanceId: 'rows', rowId: 'one' })).result, { templateReading: 20 });
    for (const type of types) { await action({ id: type, status: 404 }); await action({ inputs: { reading: 37, [type]: 1 }, status: 400 }); }
    await action({ id: 'open', status: 404 }); await action({ id: 'navigate', status: 404 });
  });
  await test('published symbol popup provenance resolves screen, template and row parameters', async () => {
    const invoke = (popupOrigin, extra = {}) => action({ screen: 'detail', popupOrigin, ...extra });
    assert.equal((await invoke({ screenId: 'main', componentId: 'open' })).result.selected, 'Demo');
    assert.equal((await invoke({ screenId: 'main', componentId: 'open', instanceId: 'template' })).result.selected, 'Instance pump');
    assert.equal((await invoke({ screenId: 'main', componentId: 'open', instanceId: 'rows', rowId: 'one' })).result.selected, 'Row pump');
    assert.equal((await invoke({ screenId: 'main', componentId: 'button-open' })).result.selected, 'Button');
    await invoke({ screenId: 'main', componentId: 'navigate' }, { status: 400 });
    await invoke({ screenId: 'main', componentId: 'equipmentSymbol' }, { status: 400 });
    await invoke({ screenId: 'main', componentId: 'pipe' }, { status: 400 });
    await invoke({ screenId: 'main', componentId: 'open', instanceId: 'rows', rowId: 'missing' }, { status: 404 });
    await action({ screen: 'detail', status: 400 });
    await action({ popupOrigin: { screenId: 'main', componentId: 'open' }, status: 400 });
    const original = structuredClone(draft);
    draft.screens[1].components.push(component('nested', 'equipmentSymbol', { action: 'openPopup', targetScreenId: 'detail' }));
    await save(); await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision }, status: 400 });
    assert.equal((await api(route('/project/publication'))).publishedAt, publishedAt);
    draft = { ...original, revision: draft.revision }; await save();
  });
  await test('drawing changes remain draft-only until republished', async () => {
    const before = props(await api(route('/runtime/project')), 'rectangle'); props(draft, 'rectangle').fillColor = '#1234'; props(draft, 'rectangle').rotation = 90;
    await save(); assert.deepEqual(props(await api(route('/runtime/project')), 'rectangle'), before);
    await publish(); assert.equal(props(await api(route('/runtime/project')), 'rectangle').rotation, 90);
  });
  await test('packages round-trip graphics and reject malformed imported definitions atomically', async () => {
    const bytes = await api(route('/export'), { binary: true }); const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`); for (const type of types) assert.deepEqual(props(restored, type), props(draft, type));
    assert.deepEqual(restored.templates, draft.templates); assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project, 'line').points[0].x = -1; }, project => { props(project, 'pipe').flowing = 'true'; },
      project => { props(project, 'rectangle').cornerRadius = 51; }, project => { props(project, 'equipmentSymbol').symbol = 'external'; },
      project => { props(project, 'pipe').bindings.strokeWidth = binding('1 / 0'); }, project => { props(project, 'open').targetScreenId = 'main'; },
      project => { project.templates[0].components[0].props.points = null; }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} drawing integration groups passed; ${rejected} malformed save variants rejected.`);
