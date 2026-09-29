#!/usr/bin/env node
// Isolated gateway only. Creates and archives its own projects; no device writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Process display tests require the isolated gateway on port 5091.');
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
const types = ['ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer'];
const rangeTypes = types.slice(1);
const targets = ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent', 'orientation'];
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 240, height: 160 });
const binding = (expression, references = {}) => ({ expression, references });
const input = key => ({ kind: 'input', key });
const parameter = key => ({ kind: 'parameter', key });
const custom = key => ({ kind: 'custom', key });
const displayProps = type => ({ value: 42.5, decimals: 1, unit: 'kPa',
  ...(type === 'ledDisplay' ? {} : { min: 0, max: 100, showValue: true, showPercent: false }),
  ...(type === 'progressBar' || type === 'levelIndicator' ? { orientation: type === 'progressBar' ? 'horizontal' : 'vertical' } : {}),
});
const makeDisplays = () => types.map(type => component(type, type, displayProps(type)));
const props = (project, id) => project.screens[0].components.find(item => item.id === id).props;
let projectId, draft, publishedAt, passed = 0, rejected = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Rejected data must preserve the saved draft and revision.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
const action = ({ button = 'apply', status = 200, ...body } = {}) => api(route(`/runtime/screens/main/components/${button}/action`), { method: 'POST', status, body: { publishedAt, ...body } });

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
  const project = await api('/api/projects', { method: 'POST', body: { name: `Process displays ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { area: 'Demo' };
  draft.templates = [{ id: 'meters', name: 'Reusable displays', width: 600, height: 500, parameters: { sample: '42.5' }, parameterTypes: { sample: 'number' }, components: [
    ...makeDisplays(), component('template-reading', 'numberInput', { fieldKey: 'templateReading', defaultValue: 20 }),
    component('apply', 'button', { action: 'script', script: 'result = inputs' }),
  ] }];
  draft.templates[0].components[0].props.bindings = { value: binding('sample', { sample: parameter('sample') }) };
  draft.screens = [{ id: 'main', name: 'Main', width: 1200, height: 900, parameters: {}, components: [
    ...makeDisplays(), ...types.map(type => component(`default-${type}`, type, {})),
    component('reading', 'numberInput', { fieldKey: 'reading', defaultValue: 37, min: -100, max: 200 }),
    component('legacy-value', 'value', { tagPath: '[default]{area}/Load', unit: '%' }),
    component('legacy-gauge', 'gauge', { tagPath: '[default]{area}/Load', min: 0, max: 100 }),
    component('legacy-label', 'label', { text: 'Legacy', bindings: { text: binding("'Preserved'") } }),
    component('template', 'template', { templateId: 'meters' }),
    component('rows', 'repeater', { templateId: 'meters', rows: [{ id: 'one', parameters: { sample: '24.5' } }], columns: 1, gap: 0 }),
    component('apply', 'button', { action: 'script', script: 'result = inputs' }),
  ] }];
  await test('five display types save and publish with explicit or omitted defaults', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const type of types) { assert.deepEqual(props(runtime, type), props(draft, type)); assert.deepEqual(props(runtime, `default-${type}`), {}); }
    assert.deepEqual(runtime.templates[0].components.map(item => item.type), draft.templates[0].components.map(item => item.type));
  });
  await test('all applicable fx fields support normal input, parameter, custom and tag scopes', async () => {
    const progress = props(draft, 'progressBar'); progress.customProperties = { scale: { type: 'number', value: 100 }, unitName: { type: 'string', value: 'kPa' } };
    progress.bindings = { value: binding('reading', { reading: input('reading') }), min: binding('-20'), max: binding('scale', { scale: custom('scale') }),
      decimals: binding('1 + 1'), unit: binding('unitName', { unitName: custom('unitName') }), showValue: binding('true'), showPercent: binding('false'), orientation: binding("'horizontal'") };
    props(draft, 'thermometer').bindings = { value: binding('temperature', { temperature: { kind: 'tag', path: '[default]{area}/Temperature' } }) };
    await save(); await publish();
    assert.deepEqual(props(await api(route('/runtime/project')), 'progressBar').bindings, progress.bindings);
    await reject(project => { props(project, 'progressBar').bindings.value = binding('child', { child: input('templateReading') }); });
    await reject(project => { project.templates[0].components[0].props.bindings.value = binding('parent', { parent: input('reading') }); });
    await reject(project => { props(project, 'thermometer').bindings.value.references.temperature.path = '[default]{missing}/Temperature'; });
  });
  await test('static numeric fields require finite exact numbers and coherent ranges', async () => {
    for (const type of types) {
      for (const value of [null, '42', true, 9007199254740992, -9007199254740992]) await reject(project => { props(project, type).value = value; });
      for (const decimals of [null, '2', true, -1, 7, 0.5]) await reject(project => { props(project, type).decimals = decimals; });
      for (const unit of [null, 2, false, 'x'.repeat(33)]) await reject(project => { props(project, type).unit = unit; });
      for (const tagPath of ['', '[default]Anything', null]) await reject(project => { props(project, type).tagPath = tagPath; });
    }
    for (const type of rangeTypes) {
      for (const key of ['min', 'max']) for (const value of [null, '0', false, 9007199254740992]) await reject(project => { props(project, type)[key] = value; });
      for (const key of ['showValue', 'showPercent']) for (const value of [null, 'true', 1]) await reject(project => { props(project, type)[key] = value; });
      await reject(project => { props(project, type).min = 100; }); await reject(project => { props(project, type).min = 200; });
      await reject(project => { props(project, `default-${type}`).max = 0; });
    }
  });
  await test('out-of-range values and safe numeric boundaries retain raw values for honest rendering', async () => {
    for (const type of rangeTypes) props(draft, type).value = -10;
    props(draft, 'ledDisplay').value = 9007199254740991; props(draft, 'ledDisplay').unit = 'x'.repeat(32);
    await save(); await publish(); const below = await api(route('/runtime/project'));
    for (const type of rangeTypes) assert.equal(props(below, type).value, -10);
    for (const type of rangeTypes) props(draft, type).value = 150;
    props(draft, 'ledDisplay').value = -9007199254740991; await save(); await publish();
    const above = await api(route('/runtime/project')); for (const type of rangeTypes) assert.equal(props(above, type).value, 150);
    assert.equal(props(above, 'ledDisplay').value, -9007199254740991);
  });
  await test('field and binding targets stay limited to appropriate display types', async () => {
    for (const key of ['min', 'max', 'showValue', 'showPercent', 'orientation']) {
      await reject(project => { props(project, 'ledDisplay')[key] = key === 'orientation' ? 'vertical' : key.startsWith('show') ? true : 5; });
      await reject(project => { props(project, 'ledDisplay').bindings = { [key]: binding(key === 'orientation' ? "'vertical'" : key.startsWith('show') ? 'true' : '5') }; });
    }
    for (const type of ['cylindricalTank', 'thermometer']) {
      await reject(project => { props(project, type).orientation = 'vertical'; });
      await reject(project => { props(project, type).bindings = { ...props(project, type).bindings, orientation: binding("'vertical'") }; });
    }
    for (const type of ['progressBar', 'levelIndicator']) for (const orientation of [null, true, 'diagonal', 'Vertical', 'vertical '])
      await reject(project => { props(project, type).orientation = orientation; });
    for (const id of ['legacy-label', 'legacy-value', 'legacy-gauge', 'reading', 'template']) for (const target of targets)
      await reject(project => { props(project, id).bindings = { [target]: binding('1') }; });
    for (const type of types) await reject(project => { props(project, type).bindings = { tagPath: binding("'[default]Anything'") }; });
  });
  await test('constant expressions reject bad result types, unsafe arithmetic and invalid enum or text bounds', async () => {
    const bad = {
      value: ["'42'", 'true', '1 / 0', '0 / 0', '9007199254740991 + 1', "'1' + 2", 'true == 1 ? 1 : 2'],
      min: ["'0'", 'false'], max: ["'100'", 'true'], decimals: ['-1', '7', '1 / 2', "'2'"],
      unit: ['true', '2', JSON.stringify('x'.repeat(33))], showValue: ['1', "'true'"], showPercent: ['0', "'false'"], orientation: ["'diagonal'", "'vertical '", 'true'],
    };
    for (const [target, expressions] of Object.entries(bad)) for (const expression of expressions)
      await reject(project => { props(project, 'progressBar').bindings[target] = binding(expression); });
    await reject(project => { props(project, 'progressBar').bindings.value = binding("'not numeric'", { unused: parameter('area') }); });
  });
  await test('valid constants preserve lazy branches, strict operations and decoded string values', async () => {
    const progress = props(draft, 'progressBar');
    progress.bindings = { value: binding('true ? 42.5 : 1 / 0'), min: binding('-20'), max: binding('100'), decimals: binding('(2 + 3) * 4 % 7'),
      unit: binding("'k' + '\\u0050a'"), showValue: binding('true || (1 / 0 > 0)'), showPercent: binding('false && (1 / 0 > 0)'),
      orientation: binding("'a' < 'b' ? 'vertical' : 'horizontal'") };
    await save(); await publish(); assert.deepEqual(props(await api(route('/runtime/project')), 'progressBar').bindings, progress.bindings);
  });
  await test('known effective range conflicts fail while reference-dependent ranges remain runtime checks', async () => {
    await reject(project => { props(project, 'progressBar').bindings.min = binding('100'); });
    await reject(project => { props(project, 'progressBar').bindings.max = binding('-20'); });
    await reject(project => { props(project, 'progressBar').bindings = { min: binding('150') }; });
    props(draft, 'progressBar').bindings.min = binding('reading', { reading: input('reading') });
    props(draft, 'progressBar').bindings.max = binding('reading - 1', { reading: input('reading') });
    await save(); await publish();
    assert.equal(props(await api(route('/runtime/project')), 'progressBar').bindings.max.expression, 'reading - 1');
  });
  await test('process displays never become form inputs, browser event sources or executable actions', async () => {
    assert.deepEqual((await action()).result, { reading: 37 });
    assert.deepEqual((await action({ instanceId: 'template' })).result, { templateReading: 20 });
    assert.deepEqual((await action({ instanceId: 'rows', rowId: 'one' })).result, { templateReading: 20 });
    for (const type of types) {
      await action({ button: type, status: 404 }); await action({ inputs: { reading: 37, [type]: 10 }, status: 400 });
      await reject(project => { props(project, type).events = { change: { language: 'javascript', code: 'return {};' } }; });
    }
  });
  await test('draft display definitions stay isolated and existing direct tag displays remain compatible', async () => {
    const before = props(await api(route('/runtime/project')), 'ledDisplay'); props(draft, 'ledDisplay').value = 123.45; props(draft, 'ledDisplay').decimals = 2;
    await save(); assert.deepEqual(props(await api(route('/runtime/project')), 'ledDisplay'), before);
    await publish(); const runtime = await api(route('/runtime/project'));
    assert.equal(props(runtime, 'ledDisplay').value, 123.45); assert.equal(props(runtime, 'legacy-value').tagPath, '[default]{area}/Load');
    assert.equal(props(runtime, 'legacy-gauge').tagPath, '[default]{area}/Load'); assert.deepEqual(props(runtime, 'reading'), props(draft, 'reading'));
  });
  await test('packages preserve process display fields and reject invalid static or constant bindings atomically', async () => {
    const bytes = await api(route('/export'), { binary: true }); const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`); for (const type of types) assert.deepEqual(props(restored, type), props(draft, type));
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project, 'thermometer').value = '42'; }, project => { props(project, 'ledDisplay').min = 0; },
      project => { props(project, 'cylindricalTank').min = props(project, 'cylindricalTank').max; }, project => { props(project, 'progressBar').bindings.value = binding('1 / 0'); },
      project => { props(project, 'progressBar').bindings.unit = binding(JSON.stringify('x'.repeat(33))); }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} process-display integration groups passed; ${rejected} malformed save variants rejected.`);
