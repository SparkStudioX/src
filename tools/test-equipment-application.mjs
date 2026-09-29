#!/usr/bin/env node
// Run against a disposable gateway with the published equipment example only.
// Business fields are restored through its guarded action; versions/timestamps advance.
import assert from 'node:assert/strict';

assert.ok(process.argv.length <= 4, 'Pass an isolated gateway URL and optional project ID.');
const base = new URL(process.argv[2] || 'http://127.0.0.1:5091');
const projectId = process.argv[3] || 'default';
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
  'Equipment acceptance tests require a disposable local gateway on port 5091.');
assert.match(projectId, /^[a-z][a-z0-9-]{0,63}$/);
const prefix = `/api/projects/${projectId}`;
async function api(path, body, expectedStatus = 200) {
  const response = await fetch(new URL(prefix + path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${path}: ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const publication = await api('/runtime/project');
assert.ok(publication.screens.some(screen => screen.id === 'equipment-workbench'), 'Load and publish tools/load-equipment-example.mjs on the disposable gateway first.');
const query = id => api(`/runtime/queries/${id}/execute`, { parameters: {} });
const options = () => query('equipment-options');
const columns = ['id', 'version', 'work_order', 'machine', 'quantity', 'status'];
const toInputs = row => ({ ...Object.fromEntries(columns.map(key => [key, row[key]])), selected_record: row.record_id });
const action = (inputs, status = 200) => api('/runtime/screens/equipment-workbench/components/save/action', { publishedAt: publication.publishedAt, parameters: {}, inputs }, status);
let original, touched = false;
try {
  await check('operator publication exposes read sources while keeping save SQL and Python private', async () => {
    const metadata = await api('/runtime/queries');
    assert.ok(metadata.some(item => item.id === 'equipment-options'));
    assert.ok(metadata.some(item => item.id === 'equipment-list'));
    assert.ok(!metadata.some(item => item.id === 'equipment-save'));
    assert.ok(!JSON.stringify(publication).includes('system.db.runNamedQuery'));
    assert.ok(!JSON.stringify(metadata).includes('production_records'));
    await api('/runtime/queries/equipment-save/execute', { parameters: {} }, 404);
  });
  await check('equipment choices contain typed record mappings and unique string IDs', async () => {
    const result = await options();
    assert.ok(result.rows.length > 0 && result.rows.length < 100, 'The disposable equipment example needs 1–99 synthetic production records so all fixture rows remain visible.');
    assert.equal(new Set(result.rows.map(row => row.record_id)).size, result.rows.length);
    for (const row of result.rows) {
      assert.equal(row.record_id, String(row.id)); assert.equal(typeof row.equipment_label, 'string');
      for (const key of columns) assert.ok(Object.hasOwn(row, key));
    }
    original = structuredClone(result.rows[0]);
    assert.ok(Number.isInteger(original.quantity) && original.quantity >= 0 && original.quantity <= 1000000);
    assert.ok(Number.isInteger(original.version) && original.version >= 1 && original.version < 2147483646);
  });
  const inputs = toInputs(original);
  await check('forged dropdown choice is rejected before the Python save action', async () => {
    await action({ ...inputs, selected_record: 'not-a-record' }, 400);
    assert.deepEqual((await options()).rows.find(row => row.id === original.id), original);
  });
  await check('form validation and selected-record relationship reject invalid writes', async () => {
    await action({ ...inputs, quantity: -1 }, 400);
    const missingText = await action({ ...inputs, work_order: '   ' });
    assert.equal(missingText.success, false); assert.match(missingText.stderr, /required/);
    const wrongId = await action({ ...inputs, id: original.id + 1 });
    assert.equal(wrongId.success, false); assert.match(wrongId.stderr, /selected ID must match/);
    assert.deepEqual((await options()).rows.find(row => row.id === original.id), original);
  });
  await check('published Python saves through parameterized SQLite and refresh reads return the new row', async () => {
    touched = true; // A timeout after a committed update must still attempt cleanup.
    const changedQuantity = original.quantity < 1000000 ? original.quantity + 1 : original.quantity - 1;
    const saved = await action({ ...inputs, quantity: changedQuantity });
    assert.equal(saved.success, true, saved.stderr); assert.match(saved.result.message, /Changes saved/);
    const choice = (await options()).rows.find(row => row.id === original.id);
    const tableRow = (await query('equipment-list')).rows.find(row => row.id === original.id);
    assert.equal(choice.quantity, changedQuantity); assert.equal(choice.version, original.version + 1);
    assert.equal(tableRow.quantity, choice.quantity); assert.equal(tableRow.version, choice.version);
  });
  await check('the old form revision cannot overwrite the saved record', async () => {
    const before = (await options()).rows.find(row => row.id === original.id);
    const stale = await action(inputs);
    assert.equal(stale.success, false); assert.match(stale.stderr, /changed after selection/);
    assert.deepEqual((await options()).rows.find(row => row.id === original.id), before);
  });
  await check('valid long machine and work-order names remain usable query choices', async () => {
    const current = (await options()).rows.find(row => row.id === original.id);
    const saved = await action({ ...inputs, version: current.version, machine: 'M'.repeat(200), work_order: 'W'.repeat(200) });
    assert.equal(saved.success, true, saved.stderr);
    const choice = (await options()).rows.find(row => row.id === original.id);
    assert.equal(choice.equipment_label.length, 200); assert.equal(choice.record_id, original.record_id);
    assert.equal(choice.machine.length, 200); assert.equal(choice.work_order.length, 200);
  });
} finally {
  if (touched) await check('original business fields are restored using the latest guarded revision', async () => {
    const current = (await options()).rows.find(row => row.id === original.id);
    assert.ok(current, 'The tested record disappeared; cleanup needs attention.');
    const restored = await action({ ...toInputs(original), version: current.version });
    assert.equal(restored.success, true, restored.stderr);
    const row = (await query('equipment-list')).rows.find(item => item.id === original.id);
    for (const key of columns.filter(key => key !== 'version')) assert.equal(row[key], original[key]);
    assert.equal(row.version, current.version + 1);
  });
}
console.log(`${passed} equipment application API groups passed. Business fields restored; normal save revisions and timestamps advanced.`);
