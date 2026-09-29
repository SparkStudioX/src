#!/usr/bin/env node
// Use only a disposable gateway; source examples contain synthetic data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const example = JSON.parse(await readFile(new URL('../examples/property-bindings.json', import.meta.url), 'utf8'));
const fixture = { id: 'binding-contract-check', name: 'Binding checks', revision: original.revision, parameters: { area: 'Assembly' }, screens: example.screens, templates: [] };
const button = project => project.screens[0].components.find(c => c.id === 'binding-apply');
const publish = revision => api('/project/publish', 'POST', { revision });
let passed = 0, changed = false;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  let saved;
  await test('typed custom properties and all four binding targets round-trip', async () => {
    saved = await api('/project', 'PUT', fixture); changed = true;
    assert.deepEqual(button(saved).props, button(fixture).props);
    assert.deepEqual((await api('/project')).screens, fixture.screens);
  });
  await test('publication retains binding definitions and strips Python source', async () => {
    await publish(saved.revision);
    const runtime = await api('/runtime/project');
    assert.deepEqual(button(runtime).props.bindings, button(saved).props.bindings);
    assert.equal(button(runtime).props.script, undefined);
    assert.equal(button(runtime).props.customProperties.minimum.value, 0);
  });
  await test('draft custom-property changes remain isolated from runtime', async () => {
    const next = structuredClone(saved); button(next).props.customProperties.minimum.value = 10;
    saved = await api('/project', 'PUT', next);
    assert.equal(button(await api('/runtime/project')).props.customProperties.minimum.value, 0);
    assert.equal(button(await api('/project')).props.customProperties.minimum.value, 10);
  });
  await test('bound buttons retain the published Python action and typed inputs', async () => {
    const runtime = await api('/runtime/project');
    const result = await api('/runtime/screens/property-binding-workshop/components/binding-apply/action', 'POST', {
      publishedAt: runtime.publishedAt, inputs: { quantity: 7, showDetails: true }, parameters: { area: 'Assembly' },
    });
    assert.equal(result.success, true); assert.deepEqual(result.result, { quantity: 7, showDetails: true });
  });
  await test('malformed custom properties, flags and binding definitions are rejected without saving', async () => {
    const variants = [
      p => p.enabled = 'false', p => p.visible = 1,
      p => p.customProperties = [],
      p => p.customProperties = { minimum: { type: 'number', value: '10' } },
      p => p.customProperties = { minimum: { type: 'boolean', value: 1 } },
      p => p.customProperties = { minimum: { type: 'string', value: false } },
      p => p.customProperties = { 'bad-name': { type: 'number', value: 1 } },
      p => p.customProperties = { minimum: { type: 'array', value: [] } },
      p => p.bindings = [],
      p => p.bindings = { script: { expression: 'true', references: {} } },
      p => p.bindings = { enabled: { expression: '(', references: {} } },
      p => p.bindings = { enabled: { expression: 'missing > 0', references: {} } },
      p => p.bindings = { enabled: { expression: 'a()', references: { a: { kind: 'input', key: 'quantity' } } } },
      p => p.bindings = { enabled: { expression: 'x', references: { x: { kind: 'sql', key: 'quantity' } } } },
      p => p.bindings = { enabled: { expression: 'x', references: { x: { kind: 'custom', key: 'minimum', componentId: 'missing' } } } },
      p => p.bindings = { enabled: { expression: 'x', references: { x: { kind: 'custom', key: 'missing' } } } },
      p => p.bindings = { enabled: { expression: 'true'.repeat(600), references: {} } },
    ];
    for (const mutate of variants) {
      const invalid = structuredClone(saved); mutate(button(invalid).props);
      await api('/project', 'PUT', invalid, 400);
    }
    const after = await api('/project');
    assert.equal(after.revision, saved.revision); assert.deepEqual(after, saved);
  });
  await test('explicit sibling custom references and template-local references save and publish', async () => {
    const next = structuredClone(saved);
    button(next).props.bindings.enabled = { expression: 'qty > limit', references: {
      qty: { kind: 'input', key: 'quantity' }, limit: { kind: 'custom', componentId: 'binding-status', key: 'minimum' },
    } };
    const components = structuredClone(next.screens[0].components);
    next.templates = [{ id: 'binding-template', name: 'Bound form', width: 960, height: 650, parameters: {}, components }];
    next.screens[0].components.push({ id: 'bound-instance', type: 'template', x: 0, y: 0, width: 300, height: 220, props: { templateId: 'binding-template', parameters: {} } });
    saved = await api('/project', 'PUT', next); await publish(saved.revision);
    assert.deepEqual((await api('/runtime/project')).templates[0].components.find(c => c.id === 'binding-apply').props.bindings, button(next).props.bindings);
  });
  await test('template wrapper flags retain explicit false through save and publication', async () => {
    for (const flag of ['enabled', 'visible']) {
      const next = structuredClone(saved);
      next.screens[0].components.find(c => c.id === 'bound-instance').props[flag] = false;
      saved = await api('/project', 'PUT', next); await publish(saved.revision);
      assert.equal((await api('/runtime/project')).screens[0].components.find(c => c.id === 'bound-instance').props[flag], false);
    }
  });
  await test('indirect display tag paths publish while unsupported input tag bindings are rejected', async () => {
    const next = structuredClone(saved);
    const display = {id:'indirect-load',type:'gauge',x:0,y:0,width:180,height:120,props:{text:'Load',tagPath:'[default]Fallback',bindings:{tagPath:{expression:"'[default]Area/' + area + '/Load'",references:{area:{kind:'parameter',key:'area'}}}}}};
    next.screens[0].components.push(display);
    saved = await api('/project','PUT',next); await publish(saved.revision);
    assert.deepEqual((await api('/runtime/project')).screens[0].components.find(c=>c.id===display.id).props.bindings, display.props.bindings);
    const invalid = structuredClone(saved);
    const input = invalid.screens[0].components.find(c=>c.props.fieldKey === 'quantity');
    input.props.bindings = display.props.bindings;
    await api('/project','PUT',invalid,400);
    assert.equal((await api('/project')).revision,saved.revision);
  });
  console.log(`${passed} property-binding API groups passed.`);
} finally {
  if (changed) {
    const current = await api('/project');
    const restored = await api('/project', 'PUT', { ...original, revision: current.revision });
    await publish(restored.revision);
  }
}
