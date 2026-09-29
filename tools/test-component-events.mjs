#!/usr/bin/env node
// Mutation tests require a disposable loopback gateway whose draft is published.
// Original project/publication content is restored with a new revision/timestamp.
import assert from 'node:assert/strict';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname) && base.protocol === 'http:' && base.port === '5091');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
async function api(path, method = 'GET', body, status = 200) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}
const original = await api('/project');
const publication = await api('/project/publication');
assert.ok(publication.published && publication.revision === original.revision,
  'Before running this suite, publish the current disposable gateway draft so both original contents can be restored.');
const originalRuntime = await api('/runtime/project');
const stripVersions = project => {
  const copy = structuredClone(project);
  delete copy.revision; delete copy.publishedAt;
  return copy;
};
const event = (code = 'app.notify("Changed");') => ({ language: 'javascript', code });
const events = () => ({ change: event(), commit: event('app.notify("Committed");') });
const inputTypes = ['textInput', 'textArea', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'radioGroup', 'dateTimeInput'];
const component = (id, type, props, index = 0) => ({ id, type, x: 20 + (index % 2) * 300, y: 20 + Math.floor(index / 2) * 70, width: 260, height: 50, props });
const inputs = inputTypes.map((type, index) => {
  const props = { text: type, fieldKey: `field_${index}`, events: events() };
  if (['numberInput', 'spinner', 'slider'].includes(type)) Object.assign(props, { defaultValue: 5, min: 0, max: 100, step: 1 });
  else if (['checkbox', 'toggle'].includes(type)) props.defaultValue = true;
  else if (['select', 'radioGroup'].includes(type)) Object.assign(props, { defaultValue: 'one', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] });
  else props.defaultValue = type === 'dateTimeInput' ? '2026-01-01T12:00' : 'Initial';
  return component(`input_${index}`, type, props, index);
});
inputs[0].groupId = 'paired-inputs';
inputs[1].groupId = 'paired-inputs';
const fixture = {
  id: 'component-event-contract', name: 'Component events contract', revision: original.revision,
  parameters: {}, templates: [],
  screens: [{ id: 'event-form', name: 'Input events', width: 960, height: 700,
    components: [...inputs, component('python-action', 'button', { text: 'Python action', action: 'script', script: 'result = {"source": "published"}' }, 10)] }],
};
const first = project => project.screens[0].components[0];
const second = project => project.screens[0].components[1];
const publish = revision => api('/project/publish', 'POST', { revision });
let saved, changed = false, passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function rejectMutations(mutations) {
  for (const mutate of mutations) {
    const invalid = structuredClone(saved); mutate(invalid);
    await api('/project', 'PUT', invalid, 400);
    assert.equal((await api('/project')).revision, saved.revision);
  }
  assert.deepEqual(await api('/project'), saved);
}
try {
  await test('all ten input types save both browser event definitions and flat groups', async () => {
    saved = await api('/project', 'PUT', fixture); changed = true;
    assert.deepEqual(saved.screens, fixture.screens);
    assert.deepEqual((await api('/project')).screens, fixture.screens);
  });
  await test('publication preserves browser source and group metadata while hiding Python', async () => {
    await publish(saved.revision);
    const runtime = await api('/runtime/project');
    for (let index = 0; index < 10; index++) assert.deepEqual(runtime.screens[0].components[index].props.events, events());
    assert.equal(first(runtime).groupId, 'paired-inputs');
    assert.equal(second(runtime).groupId, 'paired-inputs');
    assert.equal(runtime.screens[0].components.find(item => item.id === 'python-action').props.script, undefined);
    assert.equal(saved.screens[0].components.find(item => item.id === 'python-action').props.script, 'result = {"source": "published"}');
  });
  await test('draft event and group edits stay isolated from the published screen', async () => {
    const next = structuredClone(saved);
    first(next).props.events.change.code = 'app.notify("Draft only");';
    delete first(next).groupId; delete second(next).groupId;
    saved = await api('/project', 'PUT', next);
    const runtime = await api('/runtime/project');
    assert.equal(first(runtime).props.events.change.code, event().code);
    assert.equal(first(runtime).groupId, 'paired-inputs');
    assert.equal(first(saved).groupId, undefined);
  });
  await test('invalid event maps and exact definitions cannot change the saved revision', async () => {
    const values = [
      null, [], 'change', 1,
      { input: event() }, { change: event(), commit: event(), blur: event() },
      { change: null }, { change: [] }, { change: 'script' },
      { change: { language: 'python', code: 'result = 1' } },
      { change: { language: 'JavaScript', code: '1;' } },
      { change: { code: '1;' } }, { change: { language: 'javascript' } },
      { change: { language: 'javascript', code: 123 } },
      { change: { language: 'javascript', code: '' } },
      { change: { language: 'javascript', code: ' \r\n\t' } },
      { change: { language: 'javascript', code: 'x'.repeat(65537) } },
      { change: { language: 'javascript', code: '1;', extra: true } },
      { change: { language: 'javascript', source: '1;' } },
    ];
    await rejectMutations(values.map(value => project => { first(project).props.events = value; }));
  });
  await test('non-input components reject browser input events even when empty', async () => {
    const mutations = [];
    for (const type of ['label', 'value', 'gauge', 'button', 'table', 'template', 'repeater', 'image', 'icon'])
      for (const definition of [events(), {}]) mutations.push(project => {
        project.screens[0].components.push(component('unsupported-event-owner', type, { events: definition }));
      });
    await rejectMutations(mutations);
  });
  await test('the maximum event source length round-trips without truncation', async () => {
    const next = structuredClone(saved);
    const source = '//' + 'x'.repeat(65534);
    first(next).props.events.commit = event(source);
    saved = await api('/project', 'PUT', next); await publish(saved.revision);
    assert.equal(first(saved).props.events.commit.code.length, 65536);
    assert.equal(first(await api('/runtime/project')).props.events.commit.code, source);
  });
  await test('invalid, nested and singleton group metadata cannot change the saved revision', async () => {
    const invalidIds = [null, false, 1, [], ['one', 'two'], { id: 'one' }, '', ' ', '9start', 'bad/id', 'bad.id', 'bad id', 'équipe', 'valid\n', 'a'.repeat(65)];
    await rejectMutations([
      ...invalidIds.map(groupId => project => { first(project).groupId = groupId; second(project).groupId = groupId; }),
      project => { first(project).groupId = 'singleton'; },
      project => { first(project).groupId = 'one'; second(project).groupId = 'two'; },
    ]);
  });
  await test('groups are document-local and can contain template and repeater instances', async () => {
    const next = structuredClone(saved);
    first(next).groupId = 'shared-group'; second(next).groupId = 'shared-group';
    const templateComponents = structuredClone(next.screens[0].components.slice(0, 2));
    next.templates = [{ id: 'event-template', name: 'Grouped inputs', width: 600, height: 180, parameters: {}, components: templateComponents }];
    next.screens[0].components.push(
      { ...component('embedded-form', 'template', { templateId: 'event-template', parameters: {} }, 11), groupId: '_containers-1' },
      { ...component('repeated-form', 'repeater', { templateId: 'event-template', parameters: {}, rows: [{ id: 'one', parameters: {} }], columns: 1, gap: 8 }, 12), groupId: '_containers-1' },
    );
    saved = await api('/project', 'PUT', next); await publish(saved.revision);
    const runtime = await api('/runtime/project');
    assert.deepEqual(runtime.templates, saved.templates);
    assert.equal(runtime.screens[0].components.find(item => item.id === 'embedded-form').groupId, '_containers-1');
    await rejectMutations([
      project => { delete second(project).groupId; },
      project => { delete project.templates[0].components[1].groupId; },
    ]);
  });
  await test('group identifiers accept exact 64-character and prototype-like names safely', async () => {
    for (const name of ['G'.repeat(64), '__proto__', 'constructor']) {
      const next = structuredClone(saved); first(next).groupId = name; second(next).groupId = name;
      saved = await api('/project', 'PUT', next); await publish(saved.revision);
      assert.equal(first(await api('/runtime/project')).groupId, name);
    }
  });
  await test('all thirteen property targets and static styles round-trip through publication', async () => {
    const next = structuredClone(saved);
    first(next).props.bindings = Object.fromEntries(Object.entries({
      text: '"Bound input"', enabled: 'true', visible: 'true', color: '"#123"',
      x: '20 + 5', y: '30', width: '250', height: '60', fontSize: '18',
      backgroundColor: '"#1234"', foregroundColor: '"#aabbcc"', borderColor: '"#12345678"', borderWidth: '2',
    }).map(([target, expression]) => [target, { expression, references: {} }]));
    Object.assign(first(next).props, { backgroundColor: '#0000', foregroundColor: '#abcdef', borderColor: '#12ab34ef', borderWidth: 1.5, fontSize: 16 });
    saved = await api('/project', 'PUT', next); await publish(saved.revision);
    const published = first(await api('/runtime/project'));
    assert.deepEqual(published.props.bindings, first(saved).props.bindings);
    assert.deepEqual(published.props, first(saved).props);
    assert.equal(published.x, first(saved).x, 'Publication retains authored geometry; binding evaluation belongs to the browser.');
  });
  await test('unsupported property targets and malformed static styles are rejected', async () => {
    const mutations = [project => { first(project).props.bindings.rotation = { expression: '1', references: {} }; }];
    for (const property of ['backgroundColor', 'foregroundColor', 'borderColor'])
      for (const color of [null, 1, 'red', '#12', '#12345', '#123\n', 'var(--accent)', '#zzzzzz'])
        mutations.push(project => { first(project).props[property] = color; });
    for (const fontSize of [null, '16', 0, -1, 257]) mutations.push(project => { first(project).props.fontSize = fontSize; });
    for (const borderWidth of [null, '1', -1, 33]) mutations.push(project => { first(project).props.borderWidth = borderWidth; });
    await rejectMutations(mutations);
  });
  await test('input events may be removed without changing ordinary component fields', async () => {
    const next = structuredClone(saved);
    first(next).props.events = {}; delete second(next).props.events;
    saved = await api('/project', 'PUT', next); await publish(saved.revision);
    assert.deepEqual(first(await api('/runtime/project')).props.events, {});
    assert.equal(second(await api('/runtime/project')).props.events, undefined);
  });
  console.log(`${passed} component-event/group/property API groups passed.`);
} finally {
  if (changed) {
    const current = await api('/project');
    const restored = await api('/project', 'PUT', { ...original, revision: current.revision });
    await publish(restored.revision);
    assert.deepEqual(stripVersions(restored), stripVersions(original));
    assert.deepEqual(stripVersions(await api('/runtime/project')), stripVersions(originalRuntime));
    console.log('Original draft and publication contents restored.');
  }
}
