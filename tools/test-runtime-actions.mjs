#!/usr/bin/env node
// Usage: node tools/test-runtime-actions.mjs [http://127.0.0.1:5091]
// Uses a disposable gateway only. Restores the original draft and republishes it;
// this intentionally replaces the isolated gateway's previous publication.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.ok(process.argv.length <= 3, 'Pass at most one isolated gateway URL.');
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Tests require a local isolated gateway.');
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'Tests are restricted to the isolated test gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);

async function request(path, { method = 'GET', body, rawBody, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: body === undefined && rawBody === undefined ? {} : { 'Content-Type': 'application/json' },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

let passed = 0;
async function test(name, action) {
  await action();
  passed++;
  console.log(`PASS ${name}`);
}

const fixture = `action-test-${randomUUID().replaceAll('-', '')}`;
const prefix = `[default]${fixture}`;
const paths = ['Setpoint', 'Note', 'Enabled', 'Mode'].map(name => `${prefix}/${name}`);
const screenId = fixture;
const componentId = 'apply';
const actionUrl = `/api/runtime/screens/${screenId}/components/${componentId}/action`;
let publishedAt;
const execute = (body, status = 200) => request(actionUrl, { method: 'POST', body: { publishedAt, ...body }, status });
const readValues = async () => (await request('/api/tags/read', { method: 'POST', body: { paths } })).map(tag => tag.value);
const publish = revision => request('/api/project/publish', { method: 'POST', body: { revision } });
const component = (id, type, props, y = 20) => ({ id, type, x: 20, y, width: 240, height: 40, props });
const original = await request('/api/project');
const originalQueries = await request('/api/queries');
const createdPaths = [];
let savedFixture = false;
let primaryFailure;

try {
  assert.equal((await request('/api/health')).pythonAvailable, true, 'The test gateway needs a Python runtime.');
  for (const [index, dataType, value] of [[0, 'Double', 0], [1, 'String', ''], [2, 'Boolean', false], [3, 'String', 'auto']]) {
    await request('/api/tags', { method: 'POST', body: { path: paths[index], kind: 'memory', dataType, value, enabled: true } });
    createdPaths.push(paths[index]);
  }

  const source = [
    '# published-action-fixture-v1',
    `paths = ${JSON.stringify(paths)}`,
    "values = [inputs['setpoint'], inputs['note'], inputs['enabled'], inputs['mode']]",
    'qualities = system.tag.writeBlocking(paths, values)',
    'assert all(quality.isGood() for quality in qualities)',
    "result = {'marker': 'published-v1', 'inputs': inputs, 'parameters': parameters, 'readback': [value.value for value in system.tag.readBlocking(paths)]}",
  ].join('\n');
  const form = {
    ...structuredClone(original),
    name: 'Isolated runtime action fixture',
    parameters: { line: 'Line1', station: 'QA' },
    screens: [{
      id: screenId, name: 'Operator form', width: 800, height: 600,
      components: [
        component('heading', 'label', { text: 'Form fixture' }),
        component('setpoint', 'numberInput', { fieldKey: 'setpoint', min: 0, max: 100, defaultValue: 10, tagPath: paths[0] }, 80),
        component('note', 'textInput', { fieldKey: 'note' }, 140),
        component('enabled', 'checkbox', { fieldKey: 'enabled', defaultValue: false }, 200),
        component('mode', 'select', { fieldKey: 'mode', defaultValue: 'auto', options: [{ label: 'Automatic', value: 'auto' }, { label: 'Manual', value: 'manual' }] }, 260),
        component(componentId, 'button', { text: 'Apply', action: 'script', script: source }, 320),
        component('navigate', 'button', { text: 'Go', action: 'navigate', targetScreenId: screenId }, 380),
      ],
    }],
  };
  let draft = await request('/api/project', { method: 'PUT', body: form });
  savedFixture = true;
  await publish(draft.revision);
  publishedAt = (await request('/api/runtime/project')).publishedAt;
  assert.equal(typeof publishedAt, 'string');

  await test('published form action receives typed inputs and writes only authored memory tags', async () => {
    const inputs = { setpoint: 42.5, note: 'Shift B', enabled: true, mode: 'manual' };
    const response = await execute({ parameters: { line: 'Line2' }, inputs });
    assert.equal(response.success, true, response.stderr);
    assert.equal(response.result.marker, 'published-v1');
    assert.deepEqual(response.result.inputs, inputs);
    assert.deepEqual(response.result.parameters, { line: 'Line2', station: 'QA' });
    assert.deepEqual(response.result.readback, [42.5, 'Shift B', true, 'manual']);
    assert.deepEqual(await readValues(), response.result.readback);
  });

  await test('omitted fields use published defaults and context parameters merge with defaults', async () => {
    const response = await execute({ inputs: { note: 'Defaults' } });
    assert.equal(response.success, true, response.stderr);
    assert.deepEqual(response.result.inputs, { setpoint: 10, note: 'Defaults', enabled: false, mode: 'auto' });
    assert.deepEqual(response.result.parameters, { line: 'Line1', station: 'QA' });
    assert.deepEqual(await readValues(), [10, 'Defaults', false, 'auto']);
  });

  await test('missing required inputs, nulls, unknown fields and invalid types are rejected before execution', async () => {
    const baseline = await readValues();
    const valid = { setpoint: 25, note: 'Valid', enabled: true, mode: 'manual' };
    const invalid = [
      {}, { inputs: {} }, { inputs: null },
      { inputs: { ...valid, note: null } },
      { inputs: { ...valid, note: 123 } },
      { inputs: { ...valid, note: 'x'.repeat(4097) } },
      { inputs: { ...valid, setpoint: '25' } },
      { inputs: { ...valid, setpoint: true } },
      { inputs: { ...valid, setpoint: [] } },
      { inputs: { ...valid, setpoint: -0.01 } },
      { inputs: { ...valid, setpoint: 100.01 } },
      { inputs: { ...valid, enabled: 'true' } },
      { inputs: { ...valid, enabled: 1 } },
      { inputs: { ...valid, mode: 'unsupported' } },
      { inputs: { ...valid, mode: {} } },
      { inputs: { ...valid, tagPath: paths[0] } },
      { inputs: { ...valid, Setpoint: 20 } },
      { inputs: valid, parameters: { line: 3 } },
      { inputs: valid, parameters: { line: null } },
      { inputs: valid, parameters: { undeclared: 'value' } },
    ];
    for (const body of invalid) {
      await execute(body, 400);
      assert.deepEqual(await readValues(), baseline, 'Rejected input must not execute the script.');
    }
    // JSON permits exponents whose magnitude exceeds a finite double. Keep the
    // literal intact so JavaScript does not turn Infinity into JSON null.
    await request(actionUrl, { method: 'POST', rawBody: `{"publishedAt":${JSON.stringify(publishedAt)},"inputs":{"setpoint":1e400,"note":"Overflow"}}`, status: 400 });
    assert.deepEqual(await readValues(), baseline);
  });

  await test('numeric bounds are inclusive and empty text remains a valid supplied value', async () => {
    for (const setpoint of [0, 100]) {
      const response = await execute({ inputs: { setpoint, note: '' } });
      assert.equal(response.success, true, response.stderr);
      assert.equal(response.result.inputs.setpoint, setpoint);
      assert.equal(response.result.inputs.note, '');
    }
  });

  await test('actions require the displayed publication token', async () => {
    const baseline = await readValues();
    await request(actionUrl, { method: 'POST', body: { inputs: { note: 'Missing token' } }, status: 400 });
    await execute({ inputs: { note: 'Empty token' }, publishedAt: '' }, 400);
    assert.deepEqual(await readValues(), baseline);
  });

  await test('runtime project exposes input definitions but omits authored Python source', async () => {
    const runtime = await request('/api/runtime/project');
    const runtimeScreen = runtime.screens.find(screen => screen.id === screenId);
    assert.equal(runtimeScreen.components.find(item => item.id === componentId).props.script, undefined);
    assert.equal(runtimeScreen.components.find(item => item.id === 'setpoint').props.fieldKey, 'setpoint');
    assert.ok(!JSON.stringify(runtime).includes('published-action-fixture-v1'));
    assert.equal((await request('/api/project')).screens[0].components.find(item => item.id === componentId).props.script, source);
  });

  await test('labels, navigation buttons, unknown components and unknown screens cannot execute actions', async () => {
    const baseline = await readValues();
    for (const [screen, id] of [[screenId, 'heading'], [screenId, 'navigate'], [screenId, 'missing'], ['missing', componentId]]) {
      await request(`/api/runtime/screens/${screen}/components/${id}/action`, { method: 'POST', body: { publishedAt, inputs: { note: 'No execution' } }, status: 404 });
    }
    assert.deepEqual(await readValues(), baseline);
  });

  await test('draft script and input-definition edits do not affect the published action', async () => {
    draft.screens[0].components.find(item => item.id === componentId).props.script = source.replace('published-v1', 'published-v2');
    draft.screens[0].components.find(item => item.id === 'setpoint').props.defaultValue = 99;
    draft = await request('/api/project', { method: 'PUT', body: draft });
    const response = await execute({ inputs: { note: 'Still v1' }, code: "raise Exception('Caller source must never execute')" });
    assert.equal(response.success, true, response.stderr);
    assert.equal(response.result.marker, 'published-v1');
    assert.equal(response.result.inputs.setpoint, 10);
  });

  await test('explicit publication switches action source and defaults together', async () => {
    const baseline = await readValues();
    await publish(draft.revision);
    await execute({ inputs: { note: 'Stale screen' } }, 409);
    assert.deepEqual(await readValues(), baseline, 'An old screen must not execute a newly published action.');
    publishedAt = (await request('/api/runtime/project')).publishedAt;
    const response = await execute({ inputs: { note: 'Now v2' } });
    assert.equal(response.success, true, response.stderr);
    assert.equal(response.result.marker, 'published-v2');
    assert.equal(response.result.inputs.setpoint, 99);
    assert.deepEqual(await readValues(), [99, 'Now v2', false, 'auto']);
  });

  await test('designer Python preview exposes inputs and scripts without inputs remain compatible', async () => {
    const preview = await request('/api/scripts/run', { method: 'POST', body: { code: "result = [inputs['amount'], parameters['line']]", parameters: { line: 'Preview' }, inputs: { amount: 7 } } });
    assert.equal(preview.success, true, preview.stderr);
    assert.deepEqual(preview.result, [7, 'Preview']);
    const legacy = await request('/api/scripts/run', { method: 'POST', body: { code: 'result = [inputs, parameters]' } });
    assert.equal(legacy.success, true, legacy.stderr);
    assert.deepEqual(legacy.result, [{}, {}]);
  });
} catch (error) {
  primaryFailure = error;
  console.error(error.stack ?? error);
} finally {
  const cleanupErrors = [];
  if (savedFixture) {
    try {
      const current = await request('/api/project');
      const restored = await request('/api/project', { method: 'PUT', body: { ...original, revision: current.revision } });
      await publish(restored.revision);
      const { revision: _revision, ...actual } = await request('/api/project');
      const { revision: _originalRevision, ...expected } = original;
      assert.deepEqual(actual, expected);
      assert.deepEqual(await request('/api/queries'), originalQueries);
      console.log('PASS original draft restored and republished; queries unchanged');
    } catch (error) { cleanupErrors.push(error); }
  }
  for (const path of createdPaths) {
    try { await request(`/api/tag-definitions?path=${encodeURIComponent(path)}`, { method: 'DELETE', status: 204 }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    for (const error of cleanupErrors) console.error(`Fixture cleanup failed: ${error.stack ?? error}`);
    primaryFailure ??= cleanupErrors[0];
  }
}

console.log(`${passed} runtime action checks passed${primaryFailure ? '; test failed' : ''}.`);
if (primaryFailure) process.exitCode = 1;
