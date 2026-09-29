#!/usr/bin/env node
// Uses only a new project on the isolated gateway; archives its own fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'State control tests require the isolated gateway on port 5091.');
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
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 220, height: 64 });
const options = [{ value: 'stopped', label: 'Stopped' }, { value: 'manual', label: 'Manual' }, { value: 'auto', label: 'Automatic' }];
const states = [{ value: 'stopped', label: 'Stopped', color: '#666' }, { value: 'manual', label: 'Manual', color: '#e9a23b' }, { value: 'auto', label: 'Automatic', color: '#22c55eff' }];
const inputs = () => [component('secret', 'passwordInput', { text: 'Local password', fieldKey: 'secret', defaultValue: '' }),
  component('mode', 'multiStateButton', { text: 'Operating mode', fieldKey: 'mode', defaultValue: 'stopped', options: structuredClone(options),
    events: { change: { language: 'javascript', code: 'return {};' } } }),
  component('status', 'multiStateIndicator', { text: 'Operating state', stateValue: '', states: structuredClone(states),
    bindings: { stateValue: { expression: 'mode', references: { mode: { kind: 'input', key: 'mode' } } } } }),
  component('apply', 'button', { action: 'script', script: 'result = inputs' })];
let projectId, draft, publishedAt, passed = 0, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const props = (project, id) => project.screens[0].components.find(item => item.id === id).props;
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) { const invalid = structuredClone(draft); mutate(invalid); await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); assert.deepEqual(await api(route('/project')), draft); }
const action = ({ status = 200, ...body } = {}) => api(route('/runtime/screens/main/components/apply/action'), { method: 'POST', status, body: { publishedAt, ...body } });
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }

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
  const project = await api('/api/projects', { method: 'POST', body: { name: `State controls ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = { area: 'Demo' };
  draft.templates = [{ id: 'form', name: 'Reusable form', width: 360, height: 320, parameters: {}, components: inputs() }];
  draft.screens = [{ id: 'main', name: 'Main', width: 1000, height: 700, parameters: {}, components: [
    ...inputs(), component('form', 'template', { templateId: 'form' }), component('rows', 'repeater', { templateId: 'form', columns: 1, gap: 0, rows: [{ id: 'one', parameters: {} }] }),
    component('tag-status', 'multiStateIndicator', { stateValue: 'unknown', states: structuredClone(states), bindings: { stateValue: { expression: 'value', references: { value: { kind: 'tag', path: '[default]{area}/State' } } } } }),
  ] }];
  await test('passwords, state buttons and indicators save and publish in screens and reusable forms', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    for (const id of ['secret', 'mode', 'status', 'tag-status']) assert.deepEqual(props(runtime, id), props(draft, id));
    assert.equal(runtime.templates[0].components[0].type, 'passwordInput');
    assert.equal(runtime.templates[0].components[1].type, 'multiStateButton');
    assert.equal(runtime.templates[0].components[2].type, 'multiStateIndicator');
  });
  await test('local submitted passwords and declared state choices reach only explicit Python actions', async () => {
    assert.deepEqual((await action()).result, { secret: '', mode: 'stopped' });
    const values = { secret: 'synthetic-local-secret', mode: 'manual' };
    for (const identity of [{}, { instanceId: 'form' }, { instanceId: 'rows', rowId: 'one' }]) {
      const result = await action({ ...identity, inputs: values }); assert.equal(result.success, true, result.stderr); assert.deepEqual(result.result, values);
    }
    assert.deepEqual(await api(route('/project')), draft, 'Operator local form values must never become saved defaults.');
    for (const secret of [null, 5, true, 'x'.repeat(4097)]) await action({ inputs: { secret, mode: 'manual' }, status: 400 });
    for (const mode of [null, 1, true, 'missing', 'MANUAL', 'manual ']) await action({ inputs: { secret: '', mode }, status: 400 });
  });
  await test('password definitions cannot persist a credential default or bind to tag/query data', async () => {
    for (const defaultValue of [null, 1, false, 'synthetic-not-allowed']) await reject(project => { props(project, 'secret').defaultValue = defaultValue; });
    for (const tagPath of ['', '[default]Anything', null]) await reject(project => { props(project, 'secret').tagPath = tagPath; });
    await reject(project => { props(project, 'secret').optionsSource = { queryId: 'q', valueColumn: 'value', labelColumn: 'label' }; });
    delete props(draft, 'secret').defaultValue; await save(); await publish(); await action({ status: 400 });
    assert.equal((await action({ inputs: { secret: '' } })).success, true);
    props(draft, 'secret').defaultValue = ''; await save(); await publish();
  });
  await test('state-button options are bounded, distinct and enforced at definition and runtime', async () => {
    for (const optionsValue of [[], [options[0]], Array.from({ length: 33 }, (_, i) => ({ value: `v${i}`, label: `L${i}` })), [options[0], options[0]], [{ value: '', label: 'Empty' }, options[1]], [{ value: '\ufeff', label: 'Blank' }, options[1]], [{ value: 'x', label: '\ufeff' }, options[1]], [{ value: 'x', label: '' }, options[1]], [{ value: 'x'.repeat(4097), label: 'Long' }, options[1]], [{ value: 'x', label: 'x'.repeat(201) }, options[1]]])
      await reject(project => { props(project, 'mode').options = optionsValue; });
    for (const defaultValue of [null, 1, true, '', 'missing']) await reject(project => { props(project, 'mode').defaultValue = defaultValue; });
    await reject(project => { props(project, 'mode').optionsSource = { queryId: 'q', valueColumn: 'value', labelColumn: 'label' }; });
    await reject(project => { props(project, 'mode').fieldKey = 'secret'; });
    props(draft, 'mode').options.push({ value: '\u0085', label: '\u0085' }); await save();
    props(draft, 'mode').options = structuredClone(options); await save();
  });
  await test('stateValue is bindable only on indicators and retains normal reference scoping', async () => {
    for (const id of ['secret', 'mode', 'apply', 'form']) await reject(project => { props(project, id).bindings = { stateValue: { expression: "'auto'", references: {} } }; });
    await reject(project => { props(project, 'status').bindings.stateValue = { expression: 'value', references: { value: { kind: 'input', key: 'missing' } } }; });
    await reject(project => { props(project, 'status').bindings.stateValue = { expression: 'value', references: { value: { kind: 'tag', path: '[default]{missing}/State' } } }; });
    for (const expression of ['true', '2', "'manual'"]) {
      props(draft, 'status').bindings.stateValue = { expression, references: {} }; await save(); await publish();
      assert.equal(props(await api(route('/runtime/project')), 'status').bindings.stateValue.expression, expression);
    }
  });
  await test('indicator state tables reject ambiguous, unbounded or malformed values', async () => {
    for (const value of [null, 1, false, 'x'.repeat(4097)]) await reject(project => { props(project, 'status').stateValue = value; });
    for (const value of [null, [], Array.from({ length: 33 }, (_, index) => ({ value: `v${index}`, label: 'State', color: '#123' })), [states[0], states[0]], [{ ...states[0], value: '' }], [{ ...states[0], value: 'x'.repeat(129) }], [{ ...states[0], label: ' ' }], [{ ...states[0], label: 'x'.repeat(129) }], [{ ...states[0], color: 'red' }], [{ ...states[0], color: '#12' }], [{ ...states[0], icon: 'play' }]])
      await reject(project => { props(project, 'status').states = value; });
    for (const tagPath of ['', '[default]Anything', null]) await reject(project => { props(project, 'status').tagPath = tagPath; });
    props(draft, 'status').stateValue = 'unmapped-value'; await save(); await publish();
    assert.equal(props(await api(route('/runtime/project')), 'status').stateValue, 'unmapped-value', 'Unknown states remain explicit values for the neutral UI diagnostic.');
  });
  await test('published state option membership is isolated from mutable draft changes', async () => {
    props(draft, 'mode').options = [{ value: 'stopped', label: 'Stopped' }, { value: 'maintenance', label: 'Maintenance' }]; await save();
    assert.equal((await action({ inputs: { secret: '', mode: 'manual' } })).success, true);
    await action({ inputs: { secret: '', mode: 'maintenance' }, status: 400 });
    const old = publishedAt; await publish(); await action({ publishedAt: old, status: 409 });
    await action({ inputs: { secret: '', mode: 'manual' }, status: 400 });
    assert.equal((await action({ inputs: { secret: '', mode: 'maintenance' } })).success, true);
  });
  await test('packages preserve new component contracts and reject credential seeds or malformed states', async () => {
    const bytes = await api(route('/export'), { binary: true }); const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`); for (const id of ['secret', 'mode', 'status']) assert.deepEqual(props(restored, id), props(draft, id));
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project, 'secret').defaultValue = 'not-permitted'; }, project => { props(project, 'mode').options = []; }, project => { props(project, 'status').states[0].color = 'invalid'; }]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally { for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; } }
if (failure) throw failure;
console.log(`${passed} state-control integration groups passed.`);
