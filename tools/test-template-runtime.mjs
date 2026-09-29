#!/usr/bin/env node
// Uses only a disposable gateway on port 5091. Restores and republishes the
// original draft, leaves named queries unchanged, and removes its own memory tags.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.ok(process.argv.length <= 3);
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'Template tests require the isolated test gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);

async function api(path, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${raw.slice(0, 600)}`);
  return raw ? JSON.parse(raw) : null;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const component = (id, type, props, y = 0) => ({ id, type, x: 0, y, width: 260, height: 40, props });
const fixture = `template-test-${randomUUID().replaceAll('-', '')}`;
const paths = ['First', 'Second', 'RowOne', 'RowTwo'].map(name => `[default]${fixture}/${name}`);
const original = await api('/api/project');
const originalQueries = await api('/api/queries');
const screenId = fixture;
const templateId = 'reusable-form';
const created = [];
let changed = false;
let publishedAt;
let failure;
const publish = revision => api('/api/project/publish', { method: 'POST', body: { revision } });
const values = async () => (await api('/api/tags/read', { method: 'POST', body: { paths } })).map(tag => tag.value);
const action = (body, { componentId = 'apply', status = 200 } = {}) => api(`/api/runtime/screens/${screenId}/components/${componentId}/action`, {
  method: 'POST', body: { publishedAt, ...body }, status,
});

try {
  assert.equal((await api('/api/health')).pythonAvailable, true);
  assert.ok(originalQueries.some(query => query.id === 'production-summary'), 'The isolated gateway requires its sample query.');
  for (const path of paths) {
    await api('/api/tags', { method: 'POST', body: { path, kind: 'memory', dataType: 'Double', value: 0, enabled: true } });
    created.push(path);
  }
  const script = [
    '# reusable-template-action-source',
    "quality = system.tag.writeBlocking([parameters['target']], [inputs['setpoint']])[0]",
    "assert quality.isGood(), str(quality)",
    "result = {'marker': 'template-v1', 'parameters': parameters, 'inputs': inputs}",
  ].join('\n');
  const fixtureProject = {
    ...structuredClone(original), name: 'Isolated reusable forms',
    parameters: { line: 'Line1', token: '{line}' },
    templates: [{
      id: templateId, name: 'Reusable form', width: 320, height: 400,
      parameters: { line: 'Scoped-{line}', title: 'Default {line}', chained: '{token}', target: paths[0] },
      components: [
        component('heading', 'label', { text: '{title}' }),
        component('setpoint', 'numberInput', { fieldKey: 'setpoint', min: 0, max: 100, defaultValue: 7, tagPath: '{target}' }, 60),
        component('note', 'textInput', { fieldKey: 'note', defaultValue: 'Local note' }, 120),
        component('apply', 'button', { text: 'Save {title}', action: 'script', script }, 180),
        component('summary', 'table', { queryId: 'production-summary', text: 'Template query' }, 240),
      ],
    }],
    screens: [{
      id: screenId, name: 'Template and repeater host', width: 1400, height: 900,
      components: [
        component('root-field', 'textInput', { fieldKey: 'rootOnly', defaultValue: 'Root default' }),
        component('direct-action', 'button', { action: 'script', script: "result = {'scope': 'direct', 'inputs': inputs, 'parameters': parameters}" }, 50),
        component('first', 'template', { templateId, parameters: { target: paths[0], title: 'First {line}' } }, 100),
        component('second', 'template', { templateId, parameters: { target: paths[1], line: 'Second scope', title: 'Second {line}' } }, 150),
        component('orders', 'repeater', {
          templateId, columns: 2, gap: 12, parameters: { target: paths[0], title: 'Default row {line}' },
          rows: [
            { id: 'row-one', parameters: { target: paths[2], title: 'Order one {line}' } },
            { id: 'row-two', parameters: { target: paths[3], title: 'Order two {line}' } },
          ],
        }, 200),
      ],
    }],
  };
  let draft = await api('/api/project', { method: 'PUT', body: fixtureProject });
  changed = true;
  await publish(draft.revision);
  publishedAt = (await api('/api/runtime/project')).publishedAt;

  await test('published templates retain definitions and hide every authored script', async () => {
    const runtime = await api('/api/runtime/project');
    assert.equal(runtime.templates[0].id, templateId);
    assert.equal(runtime.templates[0].components.find(item => item.id === 'heading').props.text, '{title}');
    for (const document of [...runtime.screens, ...runtime.templates])
      for (const item of document.components) assert.ok(!Object.hasOwn(item.props, 'script'));
    assert.ok(!JSON.stringify(runtime).includes('reusable-template-action-source'));
    assert.equal((await api('/api/project')).templates[0].components.find(item => item.id === 'apply').props.script, script);
  });

  await test('tables inside templates are included in the published query allowlist', async () => {
    assert.ok(!(await api('/api/runtime/project')).screens[0].components.some(item => item.type === 'table'));
    const queries = await api('/api/runtime/queries');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].id, 'production-summary');
    assert.ok(!Object.hasOwn(queries[0], 'sql'));
    const result = await api('/api/runtime/queries/production-summary/execute', { method: 'POST', body: { parameters: { line: 'Line1' } } });
    assert.ok(result.rows.length > 0 && result.rows.every(row => row.Line === 'Line1'));
  });

  await test('two saved instances of one form write independently to their configured memory tags', async () => {
    const first = await action({ instanceId: 'first', inputs: { setpoint: 11, note: 'First edit' }, parameters: { line: 'Line2' } });
    assert.equal(first.success, true, first.stderr);
    assert.equal(first.result.parameters.target, paths[0]);
    assert.equal(first.result.parameters.title, 'First Line2');
    assert.deepEqual(await values(), [11, 0, 0, 0]);
    const second = await action({ instanceId: 'second', inputs: { setpoint: 22 } });
    assert.equal(second.success, true, second.stderr);
    assert.equal(second.result.parameters.target, paths[1]);
    assert.equal(second.result.inputs.note, 'Local note', 'One instance must not inherit another instance\'s fields.');
    assert.deepEqual(await values(), [11, 22, 0, 0]);
  });

  await test('template parameters shadow root context only after one-pass root substitution', async () => {
    const result = await action({ instanceId: 'first', parameters: { line: 'Line2', token: '{line}' }, inputs: { setpoint: 12 } });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.line, 'Scoped-Line2');
    assert.equal(result.result.parameters.title, 'First Line2', 'References must use root context, not another template parameter.');
    assert.equal(result.result.parameters.chained, '{line}', 'Substituted text must not be expanded again.');
    const second = await action({ instanceId: 'second', inputs: { setpoint: 22 } });
    assert.equal(second.result.parameters.line, 'Second scope');
  });

  await test('saved repeater rows override instance parameters and maintain independent inputs and targets', async () => {
    const first = await action({ instanceId: 'orders', rowId: 'row-one', inputs: { setpoint: 33, note: 'Row one edit' } });
    assert.equal(first.success, true, first.stderr);
    assert.equal(first.result.parameters.target, paths[2]);
    assert.equal(first.result.parameters.title, 'Order one Line1');
    const second = await action({ instanceId: 'orders', rowId: 'row-two', inputs: { setpoint: 44 } });
    assert.equal(second.success, true, second.stderr);
    assert.equal(second.result.parameters.target, paths[3]);
    assert.equal(second.result.inputs.note, 'Local note');
    assert.deepEqual(await values(), [12, 22, 33, 44]);
  });

  await test('direct screen actions retain their root-only input and parameter scope', async () => {
    const result = await action({}, { componentId: 'direct-action' });
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(result.result.inputs, { rootOnly: 'Root default' });
    assert.deepEqual(result.result.parameters, { line: 'Line1', token: '{line}' });
    await action({ inputs: { setpoint: 1 } }, { componentId: 'direct-action', status: 400 });
    await action({ instanceId: 'first', inputs: { rootOnly: 'Forged field' } }, { status: 400 });
  });

  await test('forged instance, row, leaf, parameter and input targets are rejected without writes', async () => {
    const baseline = await values();
    for (const [body, componentId, status] of [
      [{ instanceId: 'missing' }, 'apply', 404],
      [{ instanceId: '' }, 'apply', 400],
      [{ instanceId: 'root-field' }, 'apply', 400],
      [{ instanceId: 'first', rowId: 'row-one' }, 'apply', 400],
      [{ rowId: 'row-one' }, 'direct-action', 400],
      [{ instanceId: 'orders' }, 'apply', 400],
      [{ instanceId: 'orders', rowId: '' }, 'apply', 400],
      [{ instanceId: 'orders', rowId: 'missing' }, 'apply', 404],
      [{ instanceId: 'orders', rowId: 'row-one' }, 'direct-action', 404],
      [{ instanceId: 'first' }, 'heading', 404],
      [{}, 'apply', 404],
      [{ instanceId: 'first', parameters: { target: paths[1] } }, 'apply', 400],
      [{ instanceId: 'first', parameters: { line: 9 } }, 'apply', 400],
      [{ instanceId: 'first', inputs: { setpoint: 101 } }, 'apply', 400],
      [{ instanceId: 'orders', rowId: 'row-one', inputs: { otherRowField: 'forged' } }, 'apply', 400],
    ]) await action(body, { componentId, status });
    assert.deepEqual(await values(), baseline);
    const result = await action({ instanceId: 'first', inputs: { setpoint: 13 }, templateParameters: { target: paths[1] }, code: "raise Exception('Never execute caller code')" });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.target, paths[0]);
    assert.deepEqual(await values(), [13, 22, 33, 44]);
  });

  await test('invalid references, overrides, rows, nesting and expansion bounds preserve the published release', async () => {
    const before = await api('/api/project/publication');
    const invalid = [
      project => { project.screens[0].components.find(item => item.id === 'first').props.templateId = 'missing'; },
      project => { project.templates[0].parameters.target = 123; },
      project => { project.templates[0].parameters.title = '{undeclaredRoot}'; },
      project => { delete project.templates[0].parameters; },
      project => { project.templates[0].width = 0; },
      project => { project.templates[0].components.push(component('nested', 'template', { templateId })); },
      project => { project.templates[0].components.push(component('nested', 'repeater', { templateId, rows: [] })); },
      project => { project.templates[0].components.find(item => item.type === 'table').props.queryId = 'missing'; },
      project => { project.screens[0].components.find(item => item.id === 'first').props.parameters.unknown = 'value'; },
      project => { project.screens[0].components.find(item => item.id === 'first').props.parameters.target = null; },
      project => { project.screens[0].components.find(item => item.id === 'first').props.parameters.title = '{undeclaredRoot}'; },
      project => { project.screens[0].components.find(item => item.id === 'orders').props.rows[1].id = 'row-one'; },
      project => { project.screens[0].components.find(item => item.id === 'orders').props.rows[0].parameters.unknown = 'value'; },
      project => { project.screens[0].components.find(item => item.id === 'orders').props.rows[0].parameters.target = false; },
      project => { delete project.screens[0].components.find(item => item.id === 'orders').props.rows[0].parameters; },
      project => { project.screens[0].components.find(item => item.id === 'orders').props.rows = Array.from({ length: 101 }, (_, id) => ({ id: String(id), parameters: {} })); },
      ...[0, 13, 1.5].map(columns => project => { project.screens[0].components.find(item => item.id === 'orders').props.columns = columns; }),
      ...[-1, 65].map(gap => project => { project.screens[0].components.find(item => item.id === 'orders').props.gap = gap; }),
      project => {
        project.screens[0].components = Array.from({ length: 21 }, (_, index) => component(`large-${index}`, 'repeater', {
          templateId, rows: Array.from({ length: 100 }, (_, id) => ({ id: String(id), parameters: {} })),
        }));
      },
    ];
    // Typed template definitions reject malformed values and undeclared override
    // keys atomically on save; graph/reference/placement bounds are publish checks.
    const saveRejections = new Set([1, 3, 8, 9, 12, 13]);
    for (const [index, mutate] of invalid.entries()) {
      const candidate = structuredClone(fixtureProject);
      const priorDraft = await api('/api/project');
      candidate.revision = priorDraft.revision;
      mutate(candidate);
      const saved = await api('/api/project', { method: 'PUT', body: candidate, status: saveRejections.has(index) ? 400 : 200 });
      const rejected = saveRejections.has(index) ? saved
        : await api('/api/project/publish', { method: 'POST', body: { revision: saved.revision }, status: 400 });
      if (saveRejections.has(index)) assert.deepEqual(await api('/api/project'), priorDraft);
      assert.equal(typeof rejected.error, 'string', `Invalid fixture ${index} should explain rejection.`);
      assert.deepEqual(await api('/api/project/publication'), before);
    }
  });

  await test('malformed or oversized template collections cannot replace the saved draft', async () => {
    const current = await api('/api/project');
    const duplicateFields = structuredClone(fixtureProject.templates);
    duplicateFields[0].components.push(component('duplicate-field', 'textInput', { fieldKey: 'setpoint' }));
    for (const templates of [null, {}, [null], [fixtureProject.templates[0], fixtureProject.templates[0]],
      duplicateFields, Array.from({ length: 101 }, (_, index) => ({ ...fixtureProject.templates[0], id: `too-many-${index}` }))]) {
      await api('/api/project', { method: 'PUT', body: { ...current, templates }, status: 400 });
      assert.deepEqual(await api('/api/project'), current);
    }
  });

  await test('draft template code, defaults and instance targets do not change published actions', async () => {
    const updated = structuredClone(fixtureProject);
    updated.revision = (await api('/api/project')).revision;
    updated.templates[0].components.find(item => item.id === 'apply').props.script = script.replace('template-v1', 'template-v2');
    updated.templates[0].components.find(item => item.id === 'setpoint').props.defaultValue = 23;
    updated.screens[0].components.find(item => item.id === 'first').props.parameters.target = paths[1];
    draft = await api('/api/project', { method: 'PUT', body: updated });
    const result = await action({ instanceId: 'first' });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.marker, 'template-v1');
    assert.equal(result.result.parameters.target, paths[0]);
    assert.equal(result.result.inputs.setpoint, 7);
    assert.deepEqual(await values(), [7, 22, 33, 44]);
  });

  await test('republishing switches template code, definitions and instance mapping atomically', async () => {
    await publish(draft.revision);
    const baseline = await values();
    await action({ instanceId: 'first' }, { status: 409 });
    assert.deepEqual(await values(), baseline);
    publishedAt = (await api('/api/runtime/project')).publishedAt;
    const result = await action({ instanceId: 'first' });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.marker, 'template-v2');
    assert.equal(result.result.parameters.target, paths[1]);
    assert.equal(result.result.inputs.setpoint, 23);
    assert.deepEqual(await values(), [7, 23, 33, 44]);
  });
} catch (error) {
  failure = error;
  console.error(error.stack ?? error);
} finally {
  if (changed) {
    try {
      const revision = (await api('/api/project')).revision;
      const restored = await api('/api/project', { method: 'PUT', body: { ...original, revision } });
      await publish(restored.revision);
      const actual = await api('/api/project');
      actual.revision = original.revision;
      assert.deepEqual(actual, original);
      assert.deepEqual(await api('/api/queries'), originalQueries);
      console.log('PASS original project restored and republished; named queries unchanged');
    } catch (error) { failure ??= error; console.error(`Project cleanup failed: ${error.stack ?? error}`); }
  }
  for (const path of created) {
    try { await api(`/api/tag-definitions?path=${encodeURIComponent(path)}`, { method: 'DELETE', status: 204 }); }
    catch (error) { failure ??= error; console.error(`Tag cleanup failed: ${error.stack ?? error}`); }
  }
}
console.log(`${passed} template/repeater checks passed${failure ? '; test failed' : ''}.`);
if (failure) process.exitCode = 1;
