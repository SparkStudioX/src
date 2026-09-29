#!/usr/bin/env node
// Isolated gateway only. Creates its own project fixtures and archives them;
// no existing projects, connections, tags or application databases are modified.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Template property tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const run = randomUUID().replaceAll('-', '').slice(0, 12), created = [];
async function api(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 700)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const component = (id, type, props) => ({ id, type, props, x: 10, y: 20, width: 360, height: 240 });
const binding = (expression, references = {}) => ({ expression, references });
const parameter = key => ({ kind: 'parameter', key });
const input = key => ({ kind: 'input', key });
const custom = (key, componentId) => ({ kind: 'custom', key, ...(componentId ? { componentId } : {}) });
const wrapperProperties = () => ({
  templateId: 'card', parameters: {}, text: 'Accessible card group', enabled: false, visible: false,
  color: '#246', backgroundColor: '#1234', foregroundColor: '#abcdef', borderColor: '#11223344', borderWidth: 2, fontSize: 18,
  customProperties: { offset: { type: 'number', value: 8 }, title: { type: 'string', value: 'Reusable panel' }, ready: { type: 'boolean', value: true } },
  bindings: {
    text: binding("caption + ': ' + name", { caption: parameter('parentTitle'), name: custom('title') }),
    enabled: binding('quantity > 0 && ready', { quantity: input('parentQuantity'), ready: custom('ready') }),
    visible: binding('show', { show: input('showCards') }),
    color: binding('tint', { tint: custom('tint', 'parent-style') }),
    x: binding('offset + 20', { offset: custom('offset') }), y: binding('40'),
    width: binding('300 + quantity', { quantity: input('parentQuantity') }),
    height: binding('load > 0 ? 240 : 180', { load: { kind: 'tag', path: '[default]{area}/Load' } }),
    fontSize: binding('18'), backgroundColor: binding("'#1234'"), foregroundColor: binding("'#abcdef'"),
    borderColor: binding("'#11223344'"), borderWidth: binding('2'),
  },
});
const parentFields = () => [
  component('parent-quantity', 'numberInput', { fieldKey: 'parentQuantity', defaultValue: 7 }),
  component('parent-show', 'checkbox', { fieldKey: 'showCards', defaultValue: true }),
  component('parent-style', 'label', { text: 'Parent style', customProperties: { tint: { type: 'string', value: '#246' } } }),
];
const wrapper = (project, id = 'instance', document = 'main') => project.screens.find(item => item.id === document).components.find(item => item.id === id);
let projectId, draft, publishedAt, passed = 0;
const route = suffix => `/api/projects/${projectId}${suffix}`;
async function save(value = draft) { draft = await api(route('/project'), { method: 'PUT', body: value }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 });
  assert.deepEqual(await api(route('/project')), draft, 'Rejected draft must leave project/revision intact.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
const action = (instanceId, rowId, { screen = 'main', status = 200, ...body } = {}) => api(route(`/runtime/screens/${screen}/components/apply/action`), {
  method: 'POST', status, body: { publishedAt, instanceId, rowId, ...body },
});

function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--; assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const method = bytes.readUInt16LE(offset + 10); assert.ok(method === 0 || method === 8);
    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) }); offset += 46 + length + extra + comment;
  }
  return entries;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let failure;
try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  const project = await api('/api/projects', { method: 'POST', body: { name: `Template properties ${run}` } }); projectId = project.id; created.push(projectId);
  draft = await api(route('/project')); delete draft.navigation;
  draft.parameters = { area: 'Assembly' };
  draft.templates = [{ id: 'card', name: 'Reusable card', width: 320, height: 200, parameters: { childOnly: 'Child {area}' }, components: [
    component('child-input', 'numberInput', { fieldKey: 'childQuantity', defaultValue: 3 }),
    component('child-label', 'label', { text: 'Child', customProperties: { childFlag: { type: 'boolean', value: true } },
      bindings: { text: binding('name', { name: parameter('childOnly') }), visible: binding('quantity > 0', { quantity: input('childQuantity') }) } }),
    component('apply', 'button', { action: 'script', script: "result = {'parameters':parameters,'inputs':inputs}" }),
  ] }];
  draft.screens = [
    { id: 'main', name: 'Main', width: 1400, height: 900, parameters: { parentTitle: 'Main {area}' }, components: [
      ...parentFields(), component('instance', 'template', wrapperProperties()),
      component('repeat', 'repeater', { ...wrapperProperties(), columns: 2, gap: 8, rows: [{ id: 'one', parameters: { childOnly: 'Saved row {parentTitle}' } }] }),
      component('query-repeat', 'repeater', { ...wrapperProperties(), columns: 1, gap: 0,
        rowsSource: { queryId: 'production-summary', rowKey: 'Line', parameterMap: { childOnly: 'Product' } } }),
      component('open-popup', 'button', { action: 'openPopup', targetScreenId: 'popup', parameters: { parentTitle: 'Opened {parentTitle}' } }),
    ] },
    { id: 'popup', name: 'Popup', kind: 'popup', width: 800, height: 600, parameters: { parentTitle: 'Popup {area}' },
      components: [...parentFields(), component('popup-instance', 'template', { ...wrapperProperties(), parameters: { childOnly: '{parentTitle}' } })] },
  ];
  const sample = (await api('/api/queries')).find(query => query.id === 'production-summary'); assert.ok(sample, 'Isolated gateway needs its authored sample query.');
  await api(route('/queries/production-summary'), { method: 'PUT', body: sample });
  await test('template and static/query repeater wrappers save all thirteen parent-scoped targets and static styles', async () => {
    await save();
    for (const id of ['instance', 'repeat', 'query-repeat']) {
      const props = wrapper(draft, id).props;
      assert.equal(Object.keys(props.bindings).length, 13); assert.equal(props.enabled, false); assert.equal(props.visible, false);
      assert.deepEqual(props.customProperties, wrapperProperties().customProperties);
    }
  });
  await test('publication retains wrapper definitions, custom properties and authored geometry', async () => {
    await publish(); const runtime = await api(route('/runtime/project'));
    for (const id of ['instance', 'repeat', 'query-repeat']) assert.deepEqual(wrapper(runtime, id), wrapper(draft, id));
    assert.deepEqual(wrapper(runtime, 'popup-instance', 'popup'), wrapper(draft, 'popup-instance', 'popup'));
    assert.equal(runtime.templates[0].components.find(item => item.id === 'apply').props.script, undefined);
  });
  await test('draft wrapper and custom-property changes remain isolated until publication', async () => {
    const before = wrapper(await api(route('/runtime/project')));
    wrapper(draft).props.customProperties.title.value = 'Edited title'; wrapper(draft).props.bindings.x = binding('99'); wrapper(draft).width = 420;
    await save(); assert.deepEqual(wrapper(await api(route('/runtime/project'))), before);
    await publish(); assert.deepEqual(wrapper(await api(route('/runtime/project'))), wrapper(draft));
  });
  await test('wrapper bindings cannot reach child inputs, child parameters or child custom-property owners', async () => {
    for (const reference of [input('childQuantity'), parameter('childOnly'), custom('childFlag', 'child-label'), { kind: 'tag', path: '[default]{childOnly}/Load' }])
      await reject(project => { wrapper(project).props.bindings.enabled = binding('value', { value: reference }); });
    await reject(project => { project.templates[0].components[1].props.bindings.visible = binding('value', { value: input('parentQuantity') }); });
    await reject(project => { project.templates[0].components[1].props.bindings.visible = binding('value', { value: custom('ready', 'instance') }); });
  });
  await test('declared sibling wrapper custom properties stay within their parent document', async () => {
    wrapper(draft, 'repeat').props.bindings.x = binding('offset + 1', { offset: custom('offset', 'instance') }); await save(); await publish();
    assert.deepEqual(wrapper(await api(route('/runtime/project')), 'repeat').props.bindings.x, wrapper(draft, 'repeat').props.bindings.x);
    await reject(project => { wrapper(project).props.bindings.x = binding('offset', { offset: custom('offset', 'popup-instance') }); });
  });
  await test('structural targets, tag-path targets and malformed typed properties remain rejected', async () => {
    for (const target of ['templateId', 'parameters', 'rows', 'rowsSource', 'columns', 'gap', 'customProperties', 'tagPath'])
      await reject(project => { wrapper(project).props.bindings[target] = binding('true'); });
    for (const mutate of [
      props => { props.enabled = 'false'; }, props => { props.visible = 0; }, props => { props.fontSize = 257; }, props => { props.borderWidth = -1; },
      props => { props.backgroundColor = 'red'; }, props => { props.foregroundColor = 'var(--color)'; }, props => { props.borderColor = '#12'; },
      props => { props.bindings = []; }, props => { props.bindings.enabled = binding('missing'); },
      props => { props.customProperties.offset.value = '8'; }, props => { props.customProperties.ready.value = 1; },
      props => { props.customProperties.title.value = 'x'.repeat(4097); },
    ]) await reject(project => mutate(wrapper(project).props));
  });
  await test('presentation bindings do not change server action inputs, template parameters or authorization', async () => {
    // Visibility/enablement are presentation rules. Trusted project scripts still
    // enforce their own authorization and database optimistic-update conditions.
    const single = await action('instance'); assert.equal(single.success, true, single.stderr);
    assert.deepEqual(single.result.inputs, { childQuantity: 3 }); assert.equal(single.result.parameters.childOnly, 'Child Assembly');
    const saved = await action('repeat', 'one'); assert.equal(saved.result.parameters.childOnly, 'Saved row Main Assembly');
    const queried = await action('query-repeat', 'Line1'); assert.equal(queried.result.parameters.childOnly, 'Assembly A');
    await action('instance', undefined, { inputs: { parentQuantity: 8 }, status: 400 });
    await action('instance', undefined, { parameters: { childOnly: 'Forged' }, status: 400 });
    const popup = await action('popup-instance', undefined, { screen: 'popup', popupOrigin: { screenId: 'main', componentId: 'open-popup' } });
    assert.equal(popup.result.parameters.childOnly, 'Opened Main Assembly');
  });
  await test('project packages preserve wrapper properties and reject invalid imported scopes atomically', async () => {
    const bytes = await api(route('/export'), { binary: true });
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    for (const id of ['instance', 'repeat', 'query-repeat']) assert.deepEqual(wrapper(restored, id), wrapper(draft, id));
    const catalog = await api('/api/projects');
    for (const mutation of [
      project => { wrapper(project).props.bindings.enabled = binding('child', { child: input('childQuantity') }); },
      project => { wrapper(project).props.bindings.parameters = binding("'not dynamic'"); },
      project => { wrapper(project).props.visible = 'false'; },
    ]) {
      const entries = unzip(bytes).map(entry => { if (entry.name !== 'project.json') return entry; const project = JSON.parse(entry.data); mutation(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) {
    try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); }
    catch (error) { failure ??= error; }
  }
}
if (failure) throw failure;
console.log(`${passed} template-property integration groups passed.`);
