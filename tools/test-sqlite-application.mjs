#!/usr/bin/env node
// Run only against a disposable gateway on port 5091. Restores/republishes its
// original project. Unique database, connection and query fixtures remain in the
// isolated gateway's data directory because those APIs intentionally lack delete.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.ok(process.argv.length <= 3);
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'SQLite application checks require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);

async function api(path, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(35_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const id = `sqlite-test-${randomUUID().replaceAll('-', '')}`;
const ids = Object.fromEntries(['read', 'list', 'update', 'insert', 'delete', 'late', 'unsafe'].map(name => [name, `${id}-${name}`]));
const connection = { id, name: 'Disposable SQLite application check', type: 'sqlite', database: `${id}.db` };
const original = await api('/api/project');
const originalQueries = await api('/api/queries');
const saveQuery = (name, query) => api(`/api/queries/${ids[name]}`, { method: 'PUT', body: { id: ids[name], name: `SQLite test ${name}`, connectionId: id, parameters: [], ...query } });
const runQuery = (name, parameters = {}, status = 200) => api(`/api/queries/${ids[name]}/execute`, { method: 'POST', body: { parameters }, status });
const python = code => api('/api/scripts/run', { method: 'POST', body: { code } });
const publish = revision => api('/api/project/publish', { method: 'POST', body: { revision } });
const component = (id, type, props, y = 0) => ({ id, type, props, x: 0, y, width: 300, height: 40 });
let draft;
let publishedAt;
let changed = false;
let failure;
const action = (quantity, extra = {}, status = 200) => api(`/api/runtime/screens/${id}/components/apply/action`, {
  method: 'POST', body: { publishedAt, inputs: { quantity, useLate: false }, ...extra }, status,
});
const updateDefinition = {
  kind: 'update', sql: 'UPDATE production_records SET quantity=@quantity,version=version+1 WHERE id=@id AND version=@version',
  parameters: [{ name: 'quantity', type: 'int' }, { name: 'id', type: 'int' }, { name: 'version', type: 'int' }],
};

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  await test('managed SQLite connection validation rejects unsafe filenames', async () => {
    for (const database of ['../escape.db', 'C:\\escape.db', 'file:escape.db', 'x.db;Mode=Memory', 'x.db\n', 'CON.db'])
      await api('/api/connections', { method: 'POST', body: { ...connection, database }, status: 400 });
    await api('/api/connections', { method: 'POST', body: connection });
  });
  await test('connection tests leave a missing database absent until explicit creation', async () => {
    for (let count = 0; count < 2; count++) {
      const result = await api(`/api/connections/${id}/test`, { method: 'POST' });
      assert.equal(result.success, false);
      assert.match(result.message, /Create it explicitly/);
    }
    await api(`/api/connections/${id}/schema`, { status: 409 });
    const created = await api(`/api/connections/${id}/database`, { method: 'POST', body: { initializeSampleData: true } });
    assert.equal(created.success, true);
    assert.equal((await api(`/api/connections/${id}/test`, { method: 'POST' })).success, true);
  });
  await test('schema discovery and non-overwriting creation preserve the managed sample', async () => {
    const schema = await api(`/api/connections/${id}/schema`);
    assert.equal(schema.length, 1);
    assert.equal(schema[0].name, 'production_records');
    assert.deepEqual(schema[0].columns.map(column => column.name), ['id', 'work_order', 'machine', 'quantity', 'status', 'recorded_at', 'version']);
    assert.equal(schema[0].columns[0].primaryKey, true);
    await api(`/api/connections/${id}/database`, { method: 'POST', body: { initializeSampleData: false }, status: 409 });
    assert.deepEqual(await api(`/api/connections/${id}/schema`), schema);
  });
  await saveQuery('read', { sql: 'SELECT * FROM production_records WHERE id=@id', parameters: [{ name: 'id', type: 'int', defaultValue: 1 }] });
  await saveQuery('list', { kind: 'query', sql: 'SELECT * FROM production_records ORDER BY id' });
  await saveQuery('update', updateDefinition);
  await saveQuery('insert', { kind: 'update', sql: "INSERT INTO production_records(work_order,machine,quantity,status,recorded_at) VALUES(@order,'Fixture',1,'queued','2026-01-01T10:00:00Z')", parameters: [{ name: 'order', type: 'string' }] });
  await saveQuery('delete', { kind: 'update', sql: 'DELETE FROM production_records WHERE id=@id', parameters: [{ name: 'id', type: 'int' }] });
  await test('named reads return datasets and named updates return scalar affected-row counts', async () => {
    assert.equal((await runQuery('list')).rows.length, 3);
    assert.equal((await runQuery('read')).rows[0].quantity, 0);
    assert.equal(await runQuery('update', { quantity: 12, id: 1, version: 1 }), 1);
    assert.equal(await runQuery('update', { quantity: 99, id: 1, version: 1 }), 0);
    assert.equal((await runQuery('read')).rows[0].quantity, 12);
    assert.equal(await runQuery('insert', { order: "'; DROP TABLE production_records;--" }), 1);
    assert.equal((await runQuery('read', { id: 4 })).rows[0].work_order, "'; DROP TABLE production_records;--");
    assert.equal(await runQuery('delete', { id: 4 }), 1);
  });
  await test('named SQL rejects undeclared parameters, mutations in read mode and stacked updates', async () => {
    await runQuery('read', { id: 1, undeclared: 'value' }, 400);
    await runQuery('update', { id: 1, version: 2 }, 400);
    await saveQuery('unsafe', { kind: 'query', sql: 'UPDATE production_records SET quantity=999' });
    await runQuery('unsafe', {}, 400);
    await saveQuery('unsafe', { kind: 'update', sql: 'UPDATE production_records SET quantity=999; DELETE FROM production_records' });
    await runQuery('unsafe', {}, 400);
    assert.equal((await runQuery('read')).rows[0].quantity, 12);
  });
  await test('CPython receives real datasets and integer update results through runNamedQuery', async () => {
    const result = await python([
      `before = system.db.runNamedQuery('${ids.read}', {'id': 1})`,
      `affected = system.db.runNamedQuery('${ids.update}', {'id': 1, 'version': before.getValueAt(0, 'version'), 'quantity': 23})`,
      'assert isinstance(affected, int)',
      `after = system.db.runNamedQuery('${ids.read}', {'id': 1})`,
      "result = {'affected': affected, 'quantity': after.getValueAt(0, 'quantity'), 'rows': after.getRowCount(), 'columns': after.getColumnNames()}",
    ].join('\n'));
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.affected, 1);
    assert.equal(result.result.quantity, 23);
    assert.equal(result.result.rows, 1);
    assert.ok(result.result.columns.includes('version'));
  });
  const source = [
    '# sqlite-published-action-v1',
    "if inputs['useLate']:",
    `    result = system.db.runNamedQuery('${ids.late}').getValueAt(0, 'n')`,
    'else:',
    `    before = system.db.runNamedQuery('${ids.read}', {'id': 1})`,
    `    affected = system.db.runNamedQuery('${ids.update}', {'id': 1, 'version': before.getValueAt(0, 'version'), 'quantity': inputs['quantity']})`,
    `    after = system.db.runNamedQuery('${ids.read}', {'id': 1})`,
    "    result = {'marker': 'published-v1', 'affected': affected, 'quantity': after.getValueAt(0, 'quantity')}",
  ].join('\n');
  const project = {
    ...structuredClone(original), name: 'Disposable SQLite application', parameters: {}, templates: [],
    screens: [{ id, name: 'SQLite form', width: 900, height: 600, components: [
      component('quantity', 'numberInput', { fieldKey: 'quantity', min: 0, max: 5000, defaultValue: 10 }),
      component('useLate', 'checkbox', { fieldKey: 'useLate', defaultValue: false }, 50),
      component('apply', 'button', { action: 'script', script: source, text: 'Apply' }, 100),
      component('records', 'table', { queryId: ids.list }, 160),
    ] }],
  };
  draft = await api('/api/project', { method: 'PUT', body: project }); changed = true;
  await publish(draft.revision);
  publishedAt = (await api('/api/runtime/project')).publishedAt;
  await test('published operator action executes captured named SQL and hides implementation source', async () => {
    const result = await action(34);
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result, { marker: 'published-v1', affected: 1, quantity: 34 });
    const runtime = JSON.stringify(await api('/api/runtime/project'));
    assert.ok(!runtime.includes('sqlite-published-action-v1') && !runtime.includes('UPDATE production_records') && !runtime.includes('scriptQueries'));
    const queries = await api('/api/runtime/queries');
    assert.deepEqual(queries.map(query => query.id), [ids.list]);
    assert.ok(!JSON.stringify(queries).includes('SELECT'));
    await api(`/api/runtime/queries/${ids.update}/execute`, { method: 'POST', body: { parameters: {} }, status: 404 });
  });
  await test('tables reject update queries at publication and preserve prior publication', async () => {
    const invalid = structuredClone(draft);
    invalid.screens[0].components.find(component => component.id === 'records').props.queryId = ids.update;
    draft = await api('/api/project', { method: 'PUT', body: invalid });
    await api('/api/project/publish', { method: 'POST', body: { revision: draft.revision }, status: 400 });
    assert.equal((await api('/api/runtime/project')).publishedAt, publishedAt);
    draft.screens[0].components.find(component => component.id === 'records').props.queryId = ids.list;
    draft = await api('/api/project', { method: 'PUT', body: draft });
  });
  await test('draft query and script edits do not change existing published actions', async () => {
    await saveQuery('update', { ...updateDefinition, sql: updateDefinition.sql.replace('quantity=@quantity', 'quantity=@quantity+1000') });
    draft.screens[0].components.find(component => component.id === 'apply').props.script = source.replaceAll('published-v1', 'published-v2');
    draft = await api('/api/project', { method: 'PUT', body: draft });
    const result = await action(45);
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result, { marker: 'published-v1', affected: 1, quantity: 45 });
    const row = (await runQuery('read')).rows[0];
    assert.equal(await runQuery('update', { quantity: 1, id: 1, version: row.version }), 1);
    assert.equal((await runQuery('read')).rows[0].quantity, 1001);
  });
  await test('new draft named queries are unavailable to captured operator actions', async () => {
    await saveQuery('late', { sql: 'SELECT count(*) AS n FROM production_records' });
    const result = await action(0, { inputs: { quantity: 0, useLate: true } });
    assert.equal(result.success, false);
    assert.match(result.stderr, /not part of the published application/);
    const preview = await python(`result = system.db.runNamedQuery('${ids.late}').getValueAt(0, 'n')`);
    assert.equal(preview.success, true, preview.stderr);
    assert.equal(preview.result, 3);
  });
  await test('republishing adopts new query/script definitions and invalidates old action tokens', async () => {
    const previous = publishedAt;
    await publish(draft.revision);
    publishedAt = (await api('/api/runtime/project')).publishedAt;
    assert.notEqual(publishedAt, previous);
    const before = (await runQuery('read')).rows[0];
    await action(88, { publishedAt: previous }, 409);
    assert.deepEqual((await runQuery('read')).rows[0], before);
    const result = await action(56);
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result, { marker: 'published-v2', affected: 1, quantity: 1056 });
    const late = await action(0, { inputs: { quantity: 0, useLate: true } });
    assert.equal(late.success, true, late.stderr);
    assert.equal(late.result, 3);
  });
  await test('forged action scope and malformed inputs cause no database changes', async () => {
    const before = (await runQuery('read')).rows[0];
    await action(10, { publishedAt: null }, 400);
    await action(10, { inputs: { quantity: '10', useLate: false } }, 400);
    await action(10, { inputs: { quantity: 10, useLate: false, sql: 'DELETE FROM production_records' } }, 400);
    await action(10, { parameters: { query: ids.delete } }, 400);
    await api(`/api/runtime/screens/${id}/components/records/action`, { method: 'POST', body: { publishedAt, inputs: {} }, status: 404 });
    assert.deepEqual((await runQuery('read')).rows[0], before);
  });
} catch (error) {
  failure = error; console.error(error.stack ?? error);
} finally {
  if (changed) {
    try {
      const current = await api('/api/project');
      const restored = await api('/api/project', { method: 'PUT', body: { ...original, revision: current.revision } });
      await publish(restored.revision);
      const { revision: _actualRevision, ...actual } = await api('/api/project');
      const { revision: _originalRevision, ...expected } = original;
      assert.deepEqual(actual, expected);
      const currentQueries = await api('/api/queries');
      for (const query of originalQueries) assert.deepEqual(currentQueries.find(current => current.id === query.id), query);
      console.log('PASS original project restored and republished; pre-existing queries unchanged');
    } catch (error) { failure ??= error; console.error(`Cleanup failed: ${error.stack ?? error}`); }
  }
}
console.log(`${passed} SQLite application checks passed${failure ? '; test failed' : ''}.`);
if (failure) process.exitCode = 1;
