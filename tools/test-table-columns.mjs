#!/usr/bin/env node
// Isolated authenticated gateway only. Uses synthetic SQL rows, archives its own projects and disables its test viewer.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Table column tests require the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_TEST_AUTH_FILE, 'Run with the authenticated test-session preload.');
const created = [], run = randomUUID().slice(0, 8);
let projectId, draft, publishedAt, passed = 0, rejected = 0, viewerUser, failure;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const component = (id, type, props) => ({ id, type, props, x: 0, y: 0, width: 500, height: 200 });
const props = (project, id = 'configured') => project.screens[0].components.find(item => item.id === id).props;
const tableProps = () => ({ queryId: 'sample-rows', rowKey: 'id', selectionFields: { selectedId: 'id' }, pageSize: 10 });
const configured = [
  { key: 'id', label: 'Record ID', visible: false },
  { key: 'machine', label: 'Machine', width: 220, align: 'left', format: 'text' },
  { key: 'quantity', label: 'Quantity', width: 140, align: 'right', format: 'number', precision: 2, suffix: ' pcs' },
  { key: 'active', label: 'Active', align: 'center', format: 'boolean' },
  { key: 'recorded_at', label: 'Recorded', format: 'datetime' },
];
async function api(url, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(url, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: raw ? { 'Content-Type': 'application/zip' } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (url.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${url}: ${response.status} ${bytes.toString('utf8').slice(0, 800)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
async function save() { draft = await api(route('/project'), { method: 'PUT', body: draft }); }
async function publish() { publishedAt = (await api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt; }
async function reject(mutate) {
  const invalid = structuredClone(draft); mutate(invalid);
  await api(route('/project'), { method: 'PUT', body: invalid, status: 400 }); rejected++;
  assert.deepEqual(await api(route('/project')), draft, 'Invalid column configuration must not alter the saved draft.');
}
async function test(name, execute) { await execute(); passed++; console.log(`PASS ${name}`); }
// Bypass only the admin test preload so viewer checks use their own actual cookie and grant.
async function viewerApi(url, { method = 'GET', body, cookie, csrf, status = 200 } = {}) {
  return new Promise((resolve, rejectRequest) => {
    const request = httpRequest(new URL(url, base), { method, headers: { 'X-SPARK-AUDIENCE': 'operator', 'X-SPARK-PROJECT': projectId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-SPARK-CSRF': csrf } : {}) } }, response => {
      const parts = []; response.on('data', part => parts.push(part)); response.on('end', () => {
        try { const bytes = Buffer.concat(parts), data = bytes.length ? JSON.parse(bytes) : null;
          assert.equal(response.statusCode, status, `${method} ${url}: expected ${status}, received ${response.statusCode}; ${JSON.stringify(data).slice(0, 500)}`);
          resolve({ data, cookie: (response.headers['set-cookie'] ?? []).map(item => item.split(';')[0]).join('; ') });
        } catch (error) { rejectRequest(error); }
      });
    });
    request.on('error', rejectRequest); request.setTimeout(30_000, () => request.destroy(new Error('Viewer request timed out.')));
    if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
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
  projectId = (await api('/api/projects', { method: 'POST', body: { name: `Table columns ${run}` } })).id; created.push(projectId);
  const connection = { id: `table-columns-${run}`, name: 'Synthetic table columns', type: 'sqlite', database: `table-columns-${run}.db` };
  await api('/api/connections', { method: 'POST', body: connection });
  assert.equal((await api(`/api/connections/${connection.id}/database`, { method: 'POST', body: { initializeSampleData: false } })).success, true);
  await api(route('/queries/sample-rows'), { method: 'PUT', body: { id: 'sample-rows', name: 'Synthetic rows', connectionId: connection.id,
    sql: "SELECT 7 AS id, 'Machine A' AS machine, 12.5 AS quantity, 1 AS active, '2026-09-28T12:30:00Z' AS recorded_at", parameters: [] } });
  draft = await api(route('/project')); delete draft.navigation; draft.parameters = {};
  draft.templates = [{ id: 'grid', name: 'Reusable table', width: 800, height: 500, parameters: {}, components: [
    component('nested', 'table', { queryId: 'sample-rows', tableColumns: structuredClone(configured) }),
  ] }];
  draft.screens = [{ id: 'main', name: 'Table columns', width: 1400, height: 900, parameters: {}, components: [
    component('configured', 'table', { ...tableProps(), tableColumns: structuredClone(configured) }),
    component('automatic', 'table', tableProps()), component('empty', 'table', { ...tableProps(), tableColumns: [] }),
    component('label', 'label', { text: 'Synthetic table workshop' }), component('selected-id', 'numberInput', { fieldKey: 'selectedId', defaultValue: 0 }),
    component('template', 'template', { templateId: 'grid' }),
    component('repeater', 'repeater', { templateId: 'grid', rows: [{ id: 'one', parameters: {} }], columns: 1, gap: 0 }),
    component('apply', 'button', { text: 'Read selected ID', action: 'script', script: 'result = inputs' }),
  ] }];

  await test('explicit, absent and empty column lists save and publish in screens and reusable templates', async () => {
    await save(); await publish(); const runtime = await api(route('/runtime/project'));
    assert.deepEqual(props(runtime).tableColumns, configured); assert.equal(props(runtime, 'automatic').tableColumns, undefined);
    assert.deepEqual(props(runtime, 'empty').tableColumns, []); assert.deepEqual(runtime.templates[0].components[0].props.tableColumns, configured);
    assert.equal(props(runtime).rowKey, 'id'); assert.deepEqual(props(runtime).selectionFields, { selectedId: 'id' });
  });

  await test('exact unique keys, all formats and inclusive authoring limits remain lossless', async () => {
    const boundary = [
      { key: 'K'.repeat(128), label: 'L'.repeat(120), visible: true, width: 40, align: 'left', format: 'number', precision: 0, suffix: 's'.repeat(32) },
      { key: 'other', label: ' Authored label ', width: 1200, align: 'right', format: 'number', precision: 10, suffix: '' },
      { key: 'case', format: 'auto' }, { key: 'CASE', format: 'text' }, { key: 'active', format: 'boolean' },
      { key: 'when', format: 'datetime' }, { key: 'literal {source} name', align: 'center' },
      ...Array.from({ length: 57 }, (_, index) => ({ key: `extra-${index}`, visible: false })),
    ];
    props(draft).tableColumns = boundary; await save(); await publish(); assert.deepEqual(props(await api(route('/runtime/project'))).tableColumns, boundary);
    props(draft).tableColumns = structuredClone(configured); await save(); await publish();
  });

  await test('malformed arrays, keys, labels and unknown column fields are rejected atomically', async () => {
    const invalid = [null, {}, 'auto', true, [null], [1], ['id'], [{}], [{ key: 'id', unexpected: true }],
      [{ key: 'id', editable: true }], [{ key: 'id', binding: {} }], [{ key: 'id' }, { key: 'id' }],
      [{ key: 'id', visible: false }], Array.from({ length: 65 }, (_, index) => ({ key: `key-${index}` }))];
    for (const key of [null, false, 2, {}, [], '', ' ', ' first', 'last ', '\ufefffirst', 'last\ufeff', 'K'.repeat(129), 'a\nkey', 'a\u0000key', 'a\u007fkey', 'a\u0085key', 'a\u009fkey']) invalid.push([{ key }]);
    for (const label of [null, false, 2, {}, [], '', ' ', '\ufeff', 'L'.repeat(121), 'a\tlabel', 'a\u007flabel', 'a\u009flabel']) invalid.push([{ key: 'id', label }]);
    for (const tableColumns of invalid) await reject(project => { props(project).tableColumns = tableColumns; });
  });

  await test('visibility, width, alignment and numeric-format options enforce exact scalar types and bounds', async () => {
    for (const [field, values] of [
      ['visible', [null, 0, 1, 'true', {}, []]], ['width', [null, '40', true, {}, [], 39, 1201, 40.5, -1]],
      ['align', [null, true, 1, '', 'Left', ' left', 'middle', {}, []]],
      ['format', [null, true, 1, '', 'Number', ' number', 'currency', {}, []]],
    ]) for (const value of values) await reject(project => { props(project).tableColumns = [{ key: 'id', [field]: value }]; });
    for (const precision of [null, '0', true, {}, [], -1, 11, 0.5])
      await reject(project => { props(project).tableColumns = [{ key: 'id', format: 'number', precision }]; });
    for (const suffix of [null, 0, true, {}, [], 'x'.repeat(33), 'a\nsuffix', 'a\u007fsuffix', 'a\u009fsuffix'])
      await reject(project => { props(project).tableColumns = [{ key: 'id', format: 'number', suffix }]; });
    for (const format of [undefined, 'auto', 'text', 'boolean', 'datetime']) for (const extra of [{ precision: 0 }, { suffix: '' }])
      await reject(project => { props(project).tableColumns = [{ key: 'id', ...(format ? { format } : {}), ...extra }]; });
  });

  await test('column configuration is table-only structural metadata, including inside templates', async () => {
    for (const id of ['label', 'selected-id', 'template', 'repeater', 'apply'])
      for (const tableColumns of [[], configured]) await reject(project => { props(project, id).tableColumns = tableColumns; });
    await reject(project => { props(project).bindings = { tableColumns: { expression: 'true', references: {} } }; });
    for (const tableColumns of [null, [{ key: 'a', visible: false }], [{ key: 'a', width: 1201 }], [{ key: 'a', precision: 1 }]])
      await reject(project => { project.templates[0].components[0].props.tableColumns = tableColumns; });
    await reject(project => { project.templates[0].components.push(component('not-table', 'label', { text: 'Invalid', tableColumns: [] })); });
  });

  await test('draft reordering, visibility and formatting changes stay isolated until publication', async () => {
    const before = await api(route('/runtime/project')), token = publishedAt;
    props(draft).tableColumns = [{ key: 'quantity', label: 'Updated quantity', width: 400, format: 'number', precision: 3, suffix: ' units' },
      { key: 'id', visible: false }, { key: 'missing-source-column', label: 'Not yet returned', format: 'text' }];
    await save(); assert.deepEqual(props(await api(route('/runtime/project'))).tableColumns, props(before).tableColumns);
    await publish(); assert.notEqual(publishedAt, token);
    assert.deepEqual(props(await api(route('/runtime/project'))).tableColumns, props(draft).tableColumns);
    props(draft).tableColumns = structuredClone(configured); await save(); await publish();
  });

  await test('hidden and formatted columns preserve raw query rows, source keys and selection mappings', async () => {
    const result = await api(route('/runtime/queries/sample-rows/execute'), { method: 'POST', body: { publishedAt, parameters: {} } });
    assert.deepEqual(result.columns, ['id', 'machine', 'quantity', 'active', 'recorded_at']);
    assert.deepEqual(result.rows[0], { id: 7, machine: 'Machine A', quantity: 12.5, active: 1, recorded_at: '2026-09-28T12:30:00Z' });
    const action = await api(route('/runtime/screens/main/components/apply/action'), { method: 'POST', body: { publishedAt, inputs: { selectedId: 7 } } });
    assert.equal(action.success, true, action.stderr); assert.equal(action.result.selectedId, 7);
    await api(route('/runtime/screens/main/components/configured/action'), { method: 'POST', body: { publishedAt }, status: 404 });
  });

  await test('a real project viewer reads presentation settings but gains no designer or action permission', async () => {
    const identity = { username: `table-viewer-${run}`, password: randomBytes(24).toString('base64url') };
    viewerUser = await api('/api/security/users', { method: 'POST', body: { ...identity, displayName: 'Table test viewer',
      projectGrants: { [projectId]: { view: true, operate: false, design: false, publish: false } } }, status: 201 });
    const signed = await viewerApi('/api/auth/login', { method: 'POST', body: { ...identity, audience: 'operator', projectId } });
    const session = { cookie: signed.cookie, csrf: signed.data.csrfToken };
    assert.deepEqual(props((await viewerApi(route('/runtime/project'), session)).data).tableColumns, configured);
    assert.equal(signed.data.permissions.view, true); assert.equal(signed.data.permissions.operate, false); assert.equal(signed.data.permissions.design, false);
    await viewerApi(route('/project'), { ...session, method: 'PUT', body: draft, status: 401 });
    await viewerApi(route('/runtime/screens/main/components/apply/action'), { ...session, method: 'POST', body: { publishedAt }, status: 403 });
    await viewerApi(route('/runtime/screens/main/components/configured/action'), { ...session, method: 'POST', body: { publishedAt }, status: 403 });
    const read = await viewerApi(route('/runtime/queries/sample-rows/execute'), { ...session, method: 'POST', body: { publishedAt, parameters: {} } });
    assert.equal(read.data.rows[0].id, 7, 'Hiding a column is presentation, not a data authorization boundary.');
    await viewerApi('/api/auth/logout', { ...session, method: 'POST', body: { audience: 'operator' } });
  });

  await test('project packages preserve column configuration and reject invalid nested settings before import', async () => {
    const bytes = await api(route('/export'), { binary: true }), entries = unzip(bytes);
    const exported = JSON.parse(entries.find(entry => entry.name === 'project.json').data);
    assert.deepEqual(props(exported).tableColumns, configured);
    const imported = await api('/api/projects/import', { method: 'POST', raw: bytes });
    const restored = await api(`/api/projects/${imported.id}/project`);
    assert.deepEqual(props(restored), props(draft)); assert.deepEqual(restored.templates[0].components[0].props, draft.templates[0].components[0].props);
    const catalog = await api('/api/projects');
    for (const mutate of [project => { props(project).tableColumns = null; }, project => { props(project).tableColumns[0].editable = true; },
      project => { props(project).tableColumns = [{ key: 'a', visible: false }]; }, project => { props(project, 'label').tableColumns = []; },
      project => { project.templates[0].components[0].props.tableColumns[1].width = 1201; }]) {
      const invalid = entries.map(entry => { if (entry.name !== 'project.json') return entry;
        const project = JSON.parse(entry.data); mutate(project); return { ...entry, data: Buffer.from(JSON.stringify(project)) }; });
      await api('/api/projects/import', { method: 'POST', raw: zip(invalid), status: 400 }); assert.deepEqual(await api('/api/projects'), catalog);
    }
  });
} catch (error) { failure = error; }
finally {
  if (viewerUser) try { await api(`/api/security/users/${viewerUser.id}`, { method: 'PUT', body: { ...viewerUser, disabled: true, projectGrants: {} } }); } catch (error) { failure ??= error; }
  for (const id of created.reverse()) try { await api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived: true } }); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${passed} table-column integration groups passed; ${rejected} malformed save variants rejected.`);
