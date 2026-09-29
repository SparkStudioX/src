#!/usr/bin/env node
// Authenticated isolated gateway only. Independently authored projects are
// archived afterward; one unique SQLite connection remains in disposable data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync, inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Lifecycle tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Use the authenticated test-session preload.');
const created = [], run = randomUUID().replaceAll('-', '').slice(0, 12);
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path === '/api/projects/import' && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes) : null;
}
const script = (code = 'app.notify("Browser lifecycle only");') => ({ language: 'javascript', code });
const events = (properties = ['text', 'visible', 'x']) => ({ mount: script(), unmount: script(), propertyChange: { ...script(), properties } });
const component = (id, type, props = {}) => ({ id, type, x: 10, y: 10, width: 250, height: 90, props });
const allTypes = ['label', 'value', 'gauge', 'button', 'table', 'textInput', 'numberInput', 'checkbox', 'select', 'list', 'treeView',
  'template', 'repeater', 'image', 'icon', 'textArea', 'spinner', 'slider', 'radioGroup', 'dateTimeInput', 'toggle', 'passwordInput',
  'multiStateButton', 'multiStateIndicator', 'ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer',
  'line', 'rectangle', 'ellipse', 'polyline', 'pipe', 'equipmentSymbol'];
const inputTypes = ['textInput', 'textArea', 'passwordInput', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'list', 'treeView', 'radioGroup', 'multiStateButton', 'dateTimeInput'];
const commonTargets = ['text', 'enabled', 'visible', 'color', 'x', 'y', 'width', 'height', 'fontSize', 'backgroundColor', 'foregroundColor', 'borderColor', 'borderWidth'];
const targets = [...commonTargets, 'tagPath', 'stateValue', 'value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent', 'orientation',
  'strokeColor', 'strokeWidth', 'fillColor', 'rotation', 'flowing', 'flowReverse', 'active'];
// Independent contract table: the API must enforce each type's scalar surface.
function supported(type) {
  const result = [...commonTargets];
  if (['value', 'gauge'].includes(type)) result.push('tagPath');
  if (type === 'multiStateIndicator') result.push('stateValue');
  if (inputTypes.includes(type) && type !== 'passwordInput') result.push('value');
  if (['ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer'].includes(type)) {
    result.push('value', 'decimals', 'unit');
    if (type !== 'ledDisplay') result.push('min', 'max', 'showValue', 'showPercent');
    if (['progressBar', 'levelIndicator'].includes(type)) result.push('orientation');
  }
  if (['line', 'rectangle', 'ellipse', 'polyline', 'pipe', 'equipmentSymbol'].includes(type)) {
    result.push('strokeColor', 'strokeWidth', 'rotation');
    if (['rectangle', 'ellipse', 'pipe', 'equipmentSymbol'].includes(type)) result.push('fillColor');
    if (type === 'pipe') result.push('flowing', 'flowReverse');
    if (type === 'equipmentSymbol') result.push('active');
  }
  return result;
}
const control = (project = draft, type = 'label') => project.screens[0].components.find(item => item.type === type);
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Malformed lifecycle definitions must not mutate the saved draft.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function png() {
  const chunk = (type, data) => { const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 24, 85, 140, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
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
  const project = await api('/api/projects', { method: 'POST', body: { name: `Component lifecycle ${run}` } }); projectId = project.id; created.push(projectId);
  const connection = { id: `lifecycle-${run}`, name: 'Lifecycle test dependency', type: 'sqlite', database: `lifecycle-${run}.db` };
  await api('/api/connections', { method: 'POST', body: connection });
  await api(route('/queries/rows'), { method: 'PUT', body: { id: 'rows', name: 'Lifecycle rows', connectionId: connection.id, sql: "SELECT 1 AS id, 1 AS version, 'A' AS label", parameters: [] } });
  const asset = await api(route('/assets'), { method: 'POST', body: { name: 'Lifecycle pixel.png', contentType: 'image/png', dataBase64: png().toString('base64') } });
  const python = "result = {'parameters': parameters, 'keys': sorted(inputs), 'leaked': [key for key in ['componentEvents', 'event', 'propertyName', 'value'] if key in globals()]}";
  const components = allTypes.map(type => {
    const props = { text: type, componentEvents: events() };
    if (inputTypes.includes(type)) {
      props.fieldKey = type;
      props.defaultValue = ['numberInput', 'spinner', 'slider'].includes(type) ? 1 : ['checkbox', 'toggle'].includes(type) ? false : type === 'passwordInput' ? '' : type === 'dateTimeInput' ? '2026-09-29T09:15' : 'A';
      props.events = { change: script(), commit: script() };
    }
    if (['select', 'list', 'treeView', 'radioGroup', 'multiStateButton'].includes(type)) props.options = [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }];
    if (type === 'slider') Object.assign(props, { min: 0, max: 10, step: 1 });
    if (type === 'multiStateIndicator') props.states = [{ value: 'A', label: 'Active', color: '#123456' }];
    if (type === 'button') Object.assign(props, { action: 'script', script: python });
    if (type === 'icon') props.icon = 'spark';
    if (type === 'image') props.assetId = asset.id;
    if (type === 'table') Object.assign(props, { queryId: 'rows', rowKey: 'id', tableEdit: { versionColumn: 'version', columns: [{ key: 'label', type: 'string' }], script: 'result = {"message": "Only explicit table requests"}' } });
    if (type === 'template' || type === 'repeater') Object.assign(props, { templateId: 'child', parameters: {} });
    if (type === 'repeater') Object.assign(props, { rows: [{ id: 'A', parameters: {} }, { id: 'B', parameters: {} }], columns: 2, gap: 8 });
    return component(type, type, props);
  });
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = {};
  draft.templates = [{ id: 'child', name: 'Child', width: 300, height: 180, parameters: {}, components: [component('inner', 'label', { componentEvents: events() })] },
    { id: 'unused', name: 'Unplaced', width: 300, height: 180, parameters: {}, components: [component('unused', 'label', { componentEvents: events() })] }];
  draft.screens = [{ id: 'main', name: 'Lifecycle', width: 1000, height: 700, components },
    { id: 'popup', name: 'Popup', kind: 'popup', width: 400, height: 200, components: [component('popup-label', 'label', { componentEvents: events() })] }];
  await test('every component type, popup, template and wrapper saves lifecycle handlers alongside input events', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const type of allTypes) assert.deepEqual(control(runtime, type).props.componentEvents, events());
    for (const type of inputTypes) assert.deepEqual(control(runtime, type).props.events, { change: script(), commit: script() });
    assert.deepEqual(runtime.templates, draft.templates); assert.deepEqual(runtime.screens[1], draft.screens[1]);
    assert.equal(control(runtime, 'button').props.script, undefined); assert.equal(control(runtime, 'table').props.tableEdit.script, undefined);
  });
  await test('published browser handlers remain immutable while later draft events change', async () => {
    control().props.componentEvents.mount.code = 'app.notify("Draft only");'; await save();
    assert.equal(control(await api(route('/runtime/project'))).props.componentEvents.mount.code, script().code);
    const previous = publishedAt; await publish(); assert.notEqual(publishedAt, previous);
    assert.equal(control(await api(route('/runtime/project'))).props.componentEvents.mount.code, 'app.notify("Draft only");');
  });
  await test('all allowed watched targets round-trip with a maximum of sixteen per event', async () => {
    for (let offset = 0; offset < Math.max(...allTypes.map(type => supported(type).length)); offset += 16) {
      for (const type of allTypes) control(draft, type).props.componentEvents = events(supported(type).slice(offset, offset + 16).length ? supported(type).slice(offset, offset + 16) : ['text']);
      await save(); await publish();
      for (const type of allTypes) assert.deepEqual(control(await api(route('/runtime/project')), type).props.componentEvents, control(draft, type).props.componentEvents);
    }
  });
  await test('every unsupported type/property combination rejects atomically, including password value', async () => {
    for (const type of allTypes) for (const target of targets.filter(target => !supported(type).includes(target)))
      await reject(project => { control(project, type).props.componentEvents = events([target]); });
  });
  await test('malformed event maps and exact script definitions reject atomically', async () => {
    for (const value of [null, [], 'mount', false, 1, { Mount: script() }, { change: script() }, { click: script() }, { mount: script(), extra: script() }])
      await reject(project => { control(project).props.componentEvents = value; });
    const definitions = [null, [], 'code', true, { language: 'python', code: 'result = 1' }, { language: 'JavaScript', code: '1;' },
      { code: '1;' }, { language: 'javascript' }, { language: 'javascript', code: null }, { language: 'javascript', code: 1 },
      script(''), script(' \r\n\t'), script('\uFEFF'), script('x'.repeat(65537)), { ...script(), extra: true }, { language: 'javascript', source: '1;' }];
    for (const name of ['mount', 'unmount', 'propertyChange']) for (const definition of definitions)
      await reject(project => { control(project).props.componentEvents = { [name]: name === 'propertyChange' && definition && typeof definition === 'object' && !Array.isArray(definition) ? { ...definition, properties: ['text'] } : definition }; });
    for (const name of ['mount', 'unmount']) await reject(project => { control(project).props.componentEvents = { [name]: { ...script(), properties: ['text'] } }; });
    await reject(project => { control(project).props.componentEvents = { propertyChange: script() }; });
  });
  await test('property watch lists reject unknown, non-scalar, duplicate and oversized declarations', async () => {
    for (const properties of [null, [], {}, 'text', true, [null], [1], [{}], ['text', 'text'], ['Text'], [''], [' text'], ['text '],
      ['__proto__'], ['constructor'], ['parameters'], ['componentEvents'], ['events'], ['script'], ['customProperties'], ['points'], ['rows'], ['defaultValue'], supported('progressBar').slice(0, 17)])
      await reject(project => { control(project, 'progressBar').props.componentEvents = { propertyChange: { ...script(), properties } }; });
  });
  await test('misplaced event fields and invalid unplaced template declarations are rejected', async () => {
    for (const target of [project => project, project => project.screens[0], project => project.screens[1], project => project.templates[0], project => control(project)])
      for (const value of [{}, events(), null]) await reject(project => { target(project).componentEvents = value; });
    await reject(project => { project.templates[1].components[0].props.componentEvents = { click: script() }; });
    await reject(project => { project.templates[1].components[0].props.componentEvents = events(['value']); });
    await reject(project => { control(project, 'template').props.componentEvents = events(['value']); });
    await reject(project => { control(project, 'repeater').props.componentEvents = events(['stateValue']); });
  });
  await test('65,536 UTF-16 characters survive save and publication without truncation', async () => {
    for (const source of ['//' + 'x'.repeat(65534), '//' + '\u00e9'.repeat(65534), '//' + '\u{1f527}'.repeat(32767)]) {
      assert.equal(source.length, 65536); control().props.componentEvents = { mount: script(source), unmount: script(source), propertyChange: { ...script(source), properties: ['text'] } };
      await save(); await publish(); assert.deepEqual(control(await api(route('/runtime/project'))).props.componentEvents, control().props.componentEvents);
    }
    control().props.componentEvents = events(); await save(); await publish();
  });
  await test('browser lifecycle does not expand gateway action authority or enter Python context', async () => {
    const actionPath = route('/runtime/screens/main/components/button/action');
    const valid = await api(actionPath, { method: 'POST', body: { publishedAt } });
    assert.equal(valid.success, true, valid.stderr); assert.deepEqual(valid.result.leaked, []); assert.deepEqual(valid.result.parameters, {});
    for (const field of ['componentEvents', 'event', 'eventName', 'propertyName', 'previousValue', 'code', 'language']) {
      await api(actionPath, { method: 'POST', body: { publishedAt, [field]: 'forged' }, status: 400 });
      await api(route('/runtime/screens/main/components/table/table-edit'), { method: 'POST', body: { publishedAt, key: 1, version: 1, column: 'label', value: 'B', [field]: 'forged' }, status: 400 });
    }
    for (const componentId of ['label', 'template', 'repeater']) await api(route(`/runtime/screens/main/components/${componentId}/action`), { method: 'POST', body: { publishedAt }, status: 404 });
    assert.deepEqual(await api(route('/project')), draft);
  });
  await test('sparkproj preserves browser events and rejects malformed lifecycle imports before catalog changes', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.screens, draft.screens); assert.deepEqual(restored.templates, draft.templates);
    assert.equal((await api(`/api/projects/${imported.id}/project/publication`)).published, false);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { control(project).props.componentEvents = null; }, project => { control(project).props.componentEvents = { click: script() }; },
      project => { control(project).props.componentEvents.mount.code = 'x'.repeat(65537); },
      project => { control(project, 'passwordInput').props.componentEvents = events(['value']); },
      project => { project.templates[1].components[0].props.componentEvents = events(['rows']); },
      project => { project.screens[1].componentEvents = {}; }, project => { project.componentEvents = {}; }]) {
      const malformed = unzip(bytes).map(entry => {
        if (entry.name !== 'project.json') return entry;
        const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) };
      });
      await api('/api/projects/import', { method: 'POST', raw: zip(malformed), status: 400 });
      assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
  await test('empty maps and omitted lifecycle metadata preserve legacy input event behavior', async () => {
    control().props.componentEvents = {}; delete control(draft, 'numberInput').props.componentEvents;
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.deepEqual(control(runtime).props.componentEvents, {});
    assert.equal(Object.hasOwn(control(runtime, 'numberInput').props, 'componentEvents'), false);
    assert.deepEqual(control(runtime, 'numberInput').props.events, { change: script(), commit: script() });
    await reject(project => { control(project).props.events = { change: script() }; });
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} component lifecycle integration groups passed; ${rejected} malformed save variants rejected.`);
