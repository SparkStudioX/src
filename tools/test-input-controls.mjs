#!/usr/bin/env node
// Mutates only a disposable local gateway on port 5091. Restores and republishes
// the original draft; removes only uniquely named memory-tag fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.ok(process.argv.length <= 3, 'Pass at most one isolated gateway URL.');
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'Tests are restricted to the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);

async function api(path, { method = 'GET', body, rawBody, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: body === undefined && rawBody === undefined ? {} : { 'Content-Type': 'application/json' },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const original = await api('/api/project');
const originalQueries = await api('/api/queries');
const fixtureId = `inputs-${randomUUID().replaceAll('-', '')}`;
const prefix = `[default]${fixtureId}`;
const tags = ['Root', 'First', 'Second', 'Popup', 'Calls'].map(name => `${prefix}/${name}`);
const defaults = {
  note: 'Initial\nline', count: 2.5, level: 25, mode: 'auto', when: '2024-02-29T09:30', enabled: false,
  legacyNumber: 7, legacyText: 'Legacy', legacyChoice: 'auto', legacyBool: true,
};
const options = [{ label: 'Automatic', value: 'auto' }, { label: 'Manual', value: 'manual' }];
const component = (id, type, props, y = 0) => ({ id, type, x: 10, y, width: 220, height: 50, props });
const source = [
  'import json',
  "payload = {'marker': 'controls-v1', 'inputs': inputs, 'parameters': parameters}",
  `count_path = ${JSON.stringify(tags[4])}`,
  'count = system.tag.readBlocking([count_path])[0].value',
  "qualities = system.tag.writeBlocking([parameters['target'], count_path], [json.dumps(payload), count + 1])",
  'assert all(quality.isGood() for quality in qualities)',
  'result = payload',
].join('\n');
const inputComponents = () => [
  component('note', 'textArea', { fieldKey: 'note', defaultValue: defaults.note }),
  component('count', 'spinner', { fieldKey: 'count', min: -10, max: 10, step: 0.5, defaultValue: defaults.count }, 60),
  component('level', 'slider', { fieldKey: 'level', min: 0, max: 100, step: 10, defaultValue: defaults.level }, 120),
  component('mode', 'radioGroup', { fieldKey: 'mode', options: structuredClone(options), defaultValue: defaults.mode }, 180),
  component('when', 'dateTimeInput', { fieldKey: 'when', defaultValue: defaults.when }, 240),
  component('enabled', 'toggle', { fieldKey: 'enabled', defaultValue: defaults.enabled }, 300),
  component('legacy-number', 'numberInput', { fieldKey: 'legacyNumber', step: 0.1, defaultValue: defaults.legacyNumber }, 360),
  component('legacy-text', 'textInput', { fieldKey: 'legacyText', defaultValue: defaults.legacyText }, 420),
  component('legacy-choice', 'select', { fieldKey: 'legacyChoice', options: structuredClone(options), defaultValue: defaults.legacyChoice }, 480),
  component('legacy-bool', 'checkbox', { fieldKey: 'legacyBool', defaultValue: defaults.legacyBool }, 540),
  component('apply', 'button', { action: 'script', text: 'Apply', script: source }, 600),
];
const fixture = {
  id: fixtureId, name: 'Isolated extended inputs', revision: original.revision,
  parameters: { root: 'Root context', target: tags[0] },
  templates: [{ id: 'form', name: 'Shared controls', width: 300, height: 700, parameters: { target: tags[1], label: '{root}' }, components: inputComponents() }],
  screens: [
    {
      id: 'main', name: 'Extended input controls', width: 1200, height: 800, parameters: { label: 'Main form' },
      components: [
        ...inputComponents(), component('root-only', 'textInput', { fieldKey: 'rootOnly', defaultValue: 'Root-only field' }),
        component('first', 'template', { templateId: 'form', parameters: { target: tags[1] } }),
        component('second', 'template', { templateId: 'form', parameters: { target: tags[2] } }),
        component('rows', 'repeater', { templateId: 'form', columns: 2, gap: 8, rows: [{ id: 'row-a', parameters: { target: tags[1] } }, { id: 'row-b', parameters: { target: tags[2] } }] }),
        component('open-popup', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { target: tags[3], label: '{root}' } }),
      ],
    },
    {
      id: 'detail', name: 'Control popup', kind: 'popup', width: 500, height: 800, parameters: { target: '{target}', label: 'Popup' },
      components: [component('popup-form', 'template', { templateId: 'form', parameters: { target: '{target}', label: '{label}' } })],
    },
  ],
};
let publishedAt;
let draft;
let changed = false;
const created = [];
let primaryFailure;
const publish = revision => api('/api/project/publish', { method: 'POST', body: { revision } });
const read = async () => (await api('/api/tags/read', { method: 'POST', body: { paths: tags } })).map(value => value.value);
const action = (body = {}, { screenId = 'main', componentId = 'apply', status = 200, rawBody } = {}) =>
  api(`/api/runtime/screens/${screenId}/components/${componentId}/action`, { method: 'POST', body: { publishedAt, ...body }, rawBody, status });
const inputProps = (project, id, scope = 'screen') => (scope === 'template' ? project.templates[0] : project.screens[0]).components.find(item => item.id === id).props;

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  for (const [index, path] of tags.entries()) {
    await api('/api/tags', { method: 'POST', body: { path, kind: 'memory', enabled: true, dataType: index === 4 ? 'Int32' : 'String', value: index === 4 ? 0 : '' } });
    created.push(path);
  }
  await test('all six new controls save and publish alongside the existing inputs', async () => {
    draft = await api('/api/project', { method: 'PUT', body: fixture });
    changed = true;
    await publish(draft.revision);
    const runtime = await api('/api/runtime/project');
    publishedAt = runtime.publishedAt;
    for (const scope of [runtime.screens[0], runtime.templates[0]]) {
      for (const type of ['textArea', 'spinner', 'slider', 'radioGroup', 'dateTimeInput', 'toggle'])
        assert.ok(scope.components.some(item => item.type === type));
      assert.equal(scope.components.find(item => item.id === 'apply').props.script, undefined);
    }
    assert.ok(!JSON.stringify(runtime).includes('controls-v1'));
    assert.equal(runtime.templates[0].components.find(item => item.id === 'level').props.step, 10);
  });

  await test('published inputs retain their types, multiline text and exact local wall-clock strings', async () => {
    const inputs = { ...defaults, note: 'First line\nSecond line ✓', count: 3.75, level: 33.3, mode: 'manual', when: '2024-03-10T02:30', enabled: true, legacyNumber: 0.125 };
    const result = await action({ inputs });
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result.inputs, { ...inputs, rootOnly: 'Root-only field' });
    assert.equal(result.result.parameters.label, 'Main form');
    assert.deepEqual(JSON.parse((await read())[0]), result.result);
  });

  await test('published defaults work and numeric step never imposes a divisibility constraint', async () => {
    const result = await action();
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result.inputs, { ...defaults, rootOnly: 'Root-only field' });
    for (const inputs of [{ count: -9.875, level: 99.99, legacyNumber: 0.333 }, { count: -10, level: 0 }, { count: 10, level: 100 }])
      assert.equal((await action({ inputs })).success, true);
  });

  await test('date/time allows empty, Gregorian leap days and local DST-gap values without conversion', async () => {
    for (const when of ['', '0001-01-01T00:00', '9999-12-31T23:59', '2000-02-29T12:34', '2024-03-10T02:30', '2024-11-03T01:30']) {
      const result = await action({ inputs: { when } });
      assert.equal(result.success, true, result.stderr);
      assert.equal(result.result.inputs.when, when);
    }
  });

  const badDates = [
    '0000-01-01T00:00', '10000-01-01T00:00', '1900-02-29T00:00', '2023-02-29T00:00', '2024-04-31T00:00',
    '2024-13-01T00:00', '2024-00-01T00:00', '2024-01-00T00:00', '2024-01-32T00:00',
    '2024-01-01T24:00', '2024-01-01T23:60', '2024-1-01T00:00', '2024-01-1T00:00',
    '2024-01-01 00:00', '2024-01-01t00:00', '2024-01-01T00:00:00', '2024-01-01T00:00Z',
    '2024-01-01T00:00+01:00', ' 2024-01-01T00:00', '2024-01-01T00:00\n', '２０２４-01-01T00:00',
  ];
  await test('invalid dates, formats and timezones are rejected before script execution', async () => {
    const baseline = await read();
    for (const when of [...badDates, null, 42, true, {}, []]) await action({ inputs: { when } }, { status: 400 });
    assert.deepEqual(await read(), baseline);
  });

  await test('unsafe integers, nonfinite values, type mismatches, bounds and unknown fields are rejected', async () => {
    const baseline = await read();
    const invalid = [
      ...[null, 123, true, {}, [], 'x'.repeat(4097)].map(note => ({ note })),
      ...['count', 'level', 'legacyNumber'].flatMap(key => ['5', null, true, {}, [], Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1].map(value => ({ [key]: value }))),
      ...[-10.001, 10.001].map(count => ({ count })), ...[-0.01, 100.01].map(level => ({ level })),
      ...['mode', 'legacyChoice'].flatMap(key => ['', 'unsupported', 1, true, null, [], {}].map(value => ({ [key]: value }))),
      ...['enabled', 'legacyBool'].flatMap(key => ['true', 0, 1, null, [], {}].map(value => ({ [key]: value }))),
      { undeclared: 'x' }, { Note: 'case-sensitive' },
    ];
    for (const inputs of invalid) await action({ inputs }, { status: 400 });
    for (const key of ['count', 'level', 'legacyNumber'])
      await action({}, { rawBody: `{"publishedAt":${JSON.stringify(publishedAt)},"inputs":{"${key}":1e400}}`, status: 400 });
    assert.deepEqual(await read(), baseline);
    for (const legacyNumber of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])
      assert.equal((await action({ inputs: { legacyNumber } })).result.inputs.legacyNumber, legacyNumber);
    assert.equal((await action({ inputs: { note: 'x'.repeat(4096) } })).result.inputs.note.length, 4096);
  });

  await test('malformed saved definitions and defaults cannot replace the draft or publication', async () => {
    const before = await api('/api/project');
    const release = await api('/api/project/publication');
    const invalid = [
      ...[null, 12, true, {}, [], 'x'.repeat(4097)].map(defaultValue => project => { inputProps(project, 'note').defaultValue = defaultValue; }),
      ...badDates.map(defaultValue => project => { inputProps(project, 'when').defaultValue = defaultValue; }),
      ...['count', 'level', 'legacy-number'].flatMap(id => [
        ...[null, '1', true, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1].map(defaultValue => project => { inputProps(project, id).defaultValue = defaultValue; }),
        ...[0, -1, null, '0.5', false].map(step => project => { inputProps(project, id).step = step; }),
        ...['min', 'max'].flatMap(key => [null, '1', false, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1].map(value => project => { inputProps(project, id)[key] = value; })),
      ]),
      project => { delete inputProps(project, 'level').min; }, project => { delete inputProps(project, 'level').max; },
      project => { inputProps(project, 'level').min = 100; }, project => { inputProps(project, 'level').min = 101; },
      project => { inputProps(project, 'count').min = 11; }, project => { inputProps(project, 'count').defaultValue = 11; },
      project => { inputProps(project, 'enabled').defaultValue = 'false'; }, project => { inputProps(project, 'legacy-bool').defaultValue = 0; },
      ...['mode', 'legacy-choice'].flatMap(id => [
        ...[null, [], {}, [null], [{ label: 'x', value: 'x' }, { label: 'y', value: 'x' }], [{ label: '', value: 'x' }], [{ label: 'x', value: '' }], [{ label: 'x'.repeat(201), value: 'x' }], [{ label: 'x', value: 'x'.repeat(4097) }], Array.from({ length: 101 }, (_, index) => ({ label: `${index}`, value: `${index}` }))].map(options => project => { inputProps(project, id).options = options; }),
        project => { inputProps(project, id).defaultValue = 'missing'; },
      ]),
      ...['', 'space key', 'trailing\n', 'a'.repeat(65), null, 3].map(fieldKey => project => { inputProps(project, 'note').fieldKey = fieldKey; }),
      project => { inputProps(project, 'note').fieldKey = 'count'; }, project => { inputProps(project, 'note').tagPath = {}; },
      project => { inputProps(project, 'level', 'template').step = 0; },
      project => { project.screens[1].components.push(component('bad-popup-input', 'dateTimeInput', { fieldKey: 'when', defaultValue: 'invalid' })); },
    ];
    for (const mutate of invalid) {
      const candidate = structuredClone(before);
      mutate(candidate);
      await api('/api/project', { method: 'PUT', body: candidate, status: 400 });
      assert.deepEqual(await api('/api/project'), before, 'An invalid definition must not advance or replace the saved draft.');
    }
    for (const property of ['defaultValue', 'step', 'min', 'max']) {
      const candidate = structuredClone(before);
      inputProps(candidate, 'legacy-number')[property] = '__NONFINITE__';
      await api('/api/project', { method: 'PUT', rawBody: JSON.stringify(candidate).replace('"__NONFINITE__"', '1e400'), status: 400 });
    }
    assert.deepEqual(await api('/api/project'), before);
    assert.deepEqual(await api('/api/project/publication'), release);
    console.log(`  Rejected ${invalid.length + 4} malformed definition/default variants.`);
  });

  await test('safe integer bounds allow large positive editing increments without step quantization', async () => {
    const candidate = await api('/api/project');
    Object.assign(inputProps(candidate, 'legacy-number'), { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, step: 1e20 });
    draft = await api('/api/project', { method: 'PUT', body: candidate });
    await publish(draft.revision);
    publishedAt = (await api('/api/runtime/project')).publishedAt;
    const result = await action({ inputs: { legacyNumber: 0.125 } });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.inputs.legacyNumber, 0.125);
  });

  await test('template instances and repeater rows keep control inputs and writes isolated', async () => {
    await action({ instanceId: 'first', inputs: { note: 'First', enabled: true } });
    await action({ instanceId: 'second', inputs: { note: 'Second', mode: 'manual' } });
    const state = await read();
    assert.equal(JSON.parse(state[1]).inputs.note, 'First');
    assert.equal(JSON.parse(state[1]).inputs.enabled, true);
    assert.equal(JSON.parse(state[2]).inputs.note, 'Second');
    assert.equal(JSON.parse(state[2]).inputs.enabled, false);
    const row = await action({ instanceId: 'rows', rowId: 'row-b', inputs: { note: 'Row B', when: '' } });
    assert.equal(row.result.parameters.target, tags[2]);
    assert.equal(JSON.parse((await read())[1]).inputs.note, 'First');
    assert.equal(JSON.parse((await read())[2]).inputs.note, 'Row B');
  });

  await test('popup template actions receive the saved opener context and preserve new input types', async () => {
    const result = await action({ instanceId: 'popup-form', popupOrigin: { screenId: 'main', componentId: 'open-popup' }, parameters: { root: 'Popup caller' }, inputs: { level: 72.125, enabled: true, note: 'Popup\nform', when: '2026-09-28T14:05' } }, { screenId: 'detail' });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.target, tags[3]);
    assert.equal(result.result.parameters.label, 'Popup caller');
    assert.equal(result.result.inputs.when, '2026-09-28T14:05');
    assert.deepEqual(JSON.parse((await read())[3]), result.result);
  });

  await test('forged instance, row, popup and field scopes never execute the published action', async () => {
    const baseline = await read();
    for (const [body, status] of [
      [{ instanceId: 'missing' }, 404], [{ instanceId: 'first', rowId: 'row-a' }, 400], [{ instanceId: 'rows' }, 400],
      [{ instanceId: 'rows', rowId: 'missing' }, 404], [{ rowId: 'row-a' }, 400],
      [{ instanceId: 'first', inputs: { rootOnly: 'forged' } }, 400],
      [{ popupOrigin: { screenId: 'main', componentId: 'open-popup' } }, 400], [{ parameters: { undeclared: 'x' } }, 400],
    ]) await action(body, { status });
    await action({ instanceId: 'popup-form' }, { screenId: 'detail', status: 400 });
    await action({ instanceId: 'popup-form', popupOrigin: { screenId: 'main', componentId: 'apply' } }, { screenId: 'detail', status: 400 });
    await action({ instanceId: 'popup-form', popupOrigin: { screenId: 'main', componentId: 'open-popup', rowId: 'row-a' } }, { screenId: 'detail', status: 400 });
    await action({}, { componentId: 'note', status: 404 });
    await action({}, { rawBody: JSON.stringify({ inputs: {} }), status: 400 });
    assert.deepEqual(await read(), baseline);
  });

  await test('draft new-control defaults, limits and action source stay separate until publication', async () => {
    const updated = await api('/api/project');
    inputProps(updated, 'note').defaultValue = 'Draft note';
    inputProps(updated, 'count').max = 50;
    inputProps(updated, 'when').defaultValue = '';
    updated.screens[0].components.find(item => item.id === 'apply').props.script = source.replace('controls-v1', 'controls-v2');
    draft = await api('/api/project', { method: 'PUT', body: updated });
    const result = await action({ code: "raise Exception('Caller code must not execute')" });
    assert.equal(result.result.marker, 'controls-v1');
    assert.equal(result.result.inputs.note, defaults.note);
    assert.equal(result.result.inputs.when, defaults.when);
    await action({ inputs: { count: 20 } }, { status: 400 });
    const baseline = await read();
    await publish(draft.revision);
    await action({ inputs: { count: 20 } }, { status: 409 });
    assert.deepEqual(await read(), baseline);
    publishedAt = (await api('/api/runtime/project')).publishedAt;
    const updatedResult = await action({ inputs: { count: 20 } });
    assert.equal(updatedResult.result.marker, 'controls-v2');
    assert.equal(updatedResult.result.inputs.note, 'Draft note');
    assert.equal(updatedResult.result.inputs.when, '');
    assert.equal(updatedResult.result.inputs.count, 20);
  });

  await test('omitted defaults remain required at execution rather than becoming coerced values', async () => {
    const updated = await api('/api/project');
    delete inputProps(updated, 'note').defaultValue;
    draft = await api('/api/project', { method: 'PUT', body: updated });
    await publish(draft.revision);
    publishedAt = (await api('/api/runtime/project')).publishedAt;
    const baseline = await read();
    await action({}, { status: 400 });
    assert.deepEqual(await read(), baseline);
    assert.equal((await action({ inputs: { note: '' } })).result.inputs.note, '');
  });
} catch (error) {
  primaryFailure = error;
  console.error(error.stack ?? error);
} finally {
  const cleanupErrors = [];
  if (changed) {
    try {
      const current = await api('/api/project');
      const restored = await api('/api/project', { method: 'PUT', body: { ...original, revision: current.revision } });
      await publish(restored.revision);
      const { revision: _actualRevision, ...actual } = await api('/api/project');
      const { revision: _originalRevision, ...expected } = original;
      assert.deepEqual(actual, expected);
      assert.deepEqual(await api('/api/queries'), originalQueries);
      console.log('PASS original project restored and republished; named queries unchanged');
    } catch (error) { cleanupErrors.push(error); }
  }
  for (const path of created) {
    try { await api(`/api/tag-definitions?path=${encodeURIComponent(path)}`, { method: 'DELETE', status: 204 }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    for (const error of cleanupErrors) console.error(`Fixture cleanup failed: ${error.stack ?? error}`);
    primaryFailure ??= cleanupErrors[0];
  }
}
console.log(`${passed} input-control integration checks passed${primaryFailure ? '; test failed' : ''}.`);
if (primaryFailure) process.exitCode = 1;
