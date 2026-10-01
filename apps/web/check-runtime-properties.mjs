import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`./src/${name}${name.endsWith('.json') ? '' : '.ts'}`, import.meta.url), 'utf8');
  const output = name.endsWith('.json') ? `export default ${source};` : ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  modules.set(name, url); return url;
}
const { evaluateComponentBindings, evaluatePropertyBinding, validatePropertyBinding, bindingReferenceDependencies, propertyValue } = await import(load('propertyBindings'));
const { runtimeBindingTargets, runtimePropertyDefinitions, normalizeRuntimePropertyValue } = await import(load('runtimePropertyCatalog'));
const { imageUrlError, transientImageUrl } = await import(load('imageSource'));
const { parameterBindingInputs, parameterBindingState, validateTemplateParameterBinding } = await import(load('templateParameterBindings'));
const component = (type, props = {}, id = type) => ({ id, type, x: 0, y: 0, width: 200, height: 100, props });
const binding = (expression, references = {}) => ({ expression, references });
const literal = value => binding(JSON.stringify(value));
const json = value => literal(JSON.stringify(value));
const custom = (key, componentId) => ({ kind: 'custom', key, ...(componentId ? { componentId } : {}) });
const context = (components, changes = {}) => ({ components, tags: [], inputs: {}, parameters: {}, ...changes });
const evaluate = (item, changes = {}, peers = [item]) => evaluateComponentBindings(item, context(peers, changes));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

check('catalog registers all component families and excludes executable and initial-only fields', () => {
  const types = [...new Set(runtimePropertyDefinitions.flatMap(item => item.components).filter(type => type !== '*')), 'button', 'label', 'template', 'equipmentCommand'];
  for (const type of types) {
    const item = component(type, { customProperties: { temperature: { type: 'number', value: 20 } } });
    const targets = runtimeBindingTargets(item);
    assert.ok(targets.includes('enabled')); assert.ok(targets.includes('customProperties.temperature.value'));
    for (const key of ['id', 'type', 'script', 'action', 'fieldKey', 'commandId', 'queryId', 'templateId', 'defaultValue', 'stateBinding', 'customProperties.temperature.type']) assert.ok(!targets.includes(key));
  }
  assert.ok(runtimeBindingTargets(component('numberInput')).includes('step'));
  assert.ok(runtimeBindingTargets(component('gauge')).includes('max'));
  assert.ok(runtimeBindingTargets(component('icon')).includes('alt'));
});
check('nested chart fields apply together without mutating authored definitions', () => {
  const item = component('chart', { chart: { kind: 'line', xKey: 'x', series: [{ key: 'y' }], yMin: 0, yMax: 100 }, bindings: { 'chart.yMin': literal(200), 'chart.yMax': literal(300), 'chart.showLegend': literal(false) } });
  const snapshot = structuredClone(item), result = evaluate(item);
  assert.deepEqual(result.errors, {}); assert.equal(propertyValue(result.component, 'chart.yMin'), 200); assert.equal(result.component.props.chart.showLegend, false);
  assert.deepEqual(item, snapshot); assert.notEqual(item.props.chart, result.component.props.chart); assert.equal(result.component.props.chart.series, item.props.chart.series);
});
check('generated image URLs reject remote, opaque, credentialed and malformed sources', () => {
  const origin = 'http://127.0.0.1:6090';
  const url = `blob:${origin}/generated-badge`;
  assert.equal(imageUrlError('', origin), null);
  assert.equal(imageUrlError(url, origin), null);
  assert.equal(transientImageUrl(url, origin), url);
  assert.equal(transientImageUrl(url), null);
  for (const value of [null, 1, 'https://api.labelary.com/label.png', 'data:image/png;base64,AA==', 'javascript:alert(1)',
    'blob:null/badge', 'blob:file:///badge', 'blob:ftp://127.0.0.1/badge', 'blob:http://user:password@127.0.0.1:6090/badge',
    `blob:${origin}/`, `blob:${origin}/badge#fragment`, `blob:${origin}/badge?query`, `blob:${origin}/bad\nge`, 'x'.repeat(4097)]) {
    assert.ok(imageUrlError(value, origin));
    assert.equal(transientImageUrl(value, origin), null);
  }
  assert.match(imageUrlError('blob:http://127.0.0.1:5090/badge', origin), /origin/);
  assert.match(imageUrlError('blob:https://127.0.0.1:6090/badge', origin), /origin/);
});
check('generated image source is bindable, bounded and checked against the current browser origin', () => {
  const image = component('image');
  assert.ok(runtimeBindingTargets(image).includes('imageUrl'));
  assert.ok(!runtimeBindingTargets(component('label')).includes('imageUrl'));
  assert.equal(normalizeRuntimePropertyValue('imageUrl', '', image), '');
  assert.throws(() => normalizeRuntimePropertyValue('imageUrl', 'https://example.com/image.png', image), /blob URL/);
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'https://gateway.example' } };
    const url = 'blob:https://gateway.example/badge';
    assert.equal(normalizeRuntimePropertyValue('imageUrl', url, image), url);
    assert.throws(() => normalizeRuntimePropertyValue('imageUrl', 'blob:https://other.example/badge', image), /origin/);
    const bound = component('image', { imageUrl: '', bindings: { imageUrl: binding('url', { url: { kind: 'screenState', key: 'badgeUrl' } }) } });
    const result = evaluate(bound, { state: { session: {}, screen: { badgeUrl: url } } });
    assert.deepEqual(result.errors, {}); assert.equal(result.component.props.imageUrl, url); assert.equal(bound.props.imageUrl, '');
    const failed = evaluate(bound, { state: { session: {}, screen: { badgeUrl: 'blob:https://other.example/badge' } } });
    assert.match(failed.errors.imageUrl, /origin/); assert.equal(failed.component.props.imageUrl, undefined);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
check('invalid resolved chart groups fail visibly and unrelated bindings remain live', () => {
  const item = component('chart', { chart: { kind: 'line', xKey: 'x', series: [{ key: 'y' }], yMax: 100 }, bindings: { 'chart.yMin': literal(200), text: literal('still current') } });
  const result = evaluate(item); assert.match(result.errors['chart.yMin'], /minimum/); assert.equal(result.component.props.chart.yMin, undefined); assert.equal(result.component.props.text, 'still current');
});
check('strict JSON datasets and collections are decoded only for registered structured targets', () => {
  const data = { columns: ['x', 'y'], rows: [{ x: 'A', y: 10 }, { x: 'B', y: null }] };
  const chart = component('chart', { chart: { kind: 'line', xKey: 'x', series: [{ key: 'y' }] }, bindings: { data: json(data) } });
  const result = evaluate(chart); assert.deepEqual(result.errors, {}); assert.deepEqual(result.component.props.data, data);
  assert.notEqual(result.component.props.data, data);
  assert.throws(() => normalizeRuntimePropertyValue('data', data, chart), /JSON text/);
  assert.throws(() => normalizeRuntimePropertyValue('data', '{"columns":["x"],"rows":[{}]}', chart), /row/);
  assert.throws(() => normalizeRuntimePropertyValue('data', '{"columns":["__proto__"],"rows":[]}', chart), /columns/);
  assert.throws(() => normalizeRuntimePropertyValue('data', '{"columns":["x"],"rows":[{"x":9007199254740992}]}', chart), /bounded JSON/);
  assert.throws(() => normalizeRuntimePropertyValue('data', 'x'.repeat(4097), chart), /4096/);
  assert.throws(() => normalizeRuntimePropertyValue('script', 'alert(1)', chart), /supported runtime property/);
});
check('option graphs and state maps enforce family rules before rendering', () => {
  const tree = component('treeView');
  assert.throws(() => normalizeRuntimePropertyValue('options', JSON.stringify([{ value: 'a', label: 'A', parentValue: 'b' }, { value: 'b', label: 'B', parentValue: 'a' }]), tree), /cycle/);
  const good = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', parentValue: 'a' }];
  assert.deepEqual(normalizeRuntimePropertyValue('options', JSON.stringify(good), tree), good);
  assert.throws(() => normalizeRuntimePropertyValue('options', JSON.stringify(good), component('list')), /only tree/);
  assert.throws(() => normalizeRuntimePropertyValue('options', JSON.stringify([good[0]]), component('multiStateButton')), /2–32/);
  assert.throws(() => normalizeRuntimePropertyValue('states', JSON.stringify([{ value: 'a', label: 'A', color: 'red' }]), component('multiStateIndicator')), /hex/);
});
check('drawing paths and table columns retain strict existing family validation', () => {
  assert.throws(() => normalizeRuntimePropertyValue('points', JSON.stringify([{ x: 0, y: 0 }, { x: 0, y: 0 }]), component('pipe')), /different/);
  assert.throws(() => normalizeRuntimePropertyValue('points', JSON.stringify([{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 30, y: 30 }]), component('line')), /exactly two/);
  assert.throws(() => normalizeRuntimePropertyValue('tableColumns', JSON.stringify([{ key: 'x', visible: false }]), component('table')), /at least one/);
  assert.throws(() => normalizeRuntimePropertyValue('data', '{"columns":[],"rows":[]}', component('table', { tableEdit: { versionColumn: 'v', columns: [] } })), /supported runtime property/);
});
check('existing pane presentation paths copy arrays and reject unknown pane indices', () => {
  const item = component('viewContainer', { viewLayout: { kind: 'dock', panes: [{ id: 'main', label: 'Main', templateId: 'main', edge: 'center' }, { id: 'side', label: 'Side', templateId: 'side', edge: 'right', size: 220 }] }, bindings: { 'viewLayout.panes.1.label': literal('Current'), 'viewLayout.panes.1.size': literal(300) } });
  assert.ok(runtimeBindingTargets(item).includes('viewLayout.panes.1.size')); assert.ok(!runtimeBindingTargets(item).includes('viewLayout.panes.0.size'));
  const result = evaluate(item); assert.deepEqual(result.errors, {}); assert.equal(result.component.props.viewLayout.panes[1].label, 'Current'); assert.equal(item.props.viewLayout.panes[1].label, 'Side');
  assert.equal(result.component.props.viewLayout.panes[1].templateId, 'side');
  assert.throws(() => normalizeRuntimePropertyValue('viewLayout.panes.2.label', 'unknown', item), /supported runtime property/);
});
check('bound custom properties resolve dependencies within each containing scope', () => {
  const source = component('label', { customProperties: { amount: { type: 'number', value: 1 }, doubled: { type: 'number', value: 2 } }, bindings: { 'customProperties.amount.value': binding('input', { input: { kind: 'input', key: 'amount' } }), 'customProperties.doubled.value': binding('amount * 2', { amount: custom('amount') }) } }, 'source');
  const sink = component('label', { bindings: { text: binding('value', { value: custom('doubled', 'source') }) } }, 'sink');
  assert.equal(evaluate(sink, { inputs: { amount: 9 } }, [source, sink]).component.props.text, '18');
  assert.equal(evaluate(sink, { inputs: { amount: 3 } }, [source, sink]).component.props.text, '6');
  assert.equal(source.props.customProperties.amount.value, 1);
  assert.match(evaluate(sink, { inputs: { amount: 3 } }, [sink]).errors.text, /scope/);
});
check('custom value types, cycles, and unavailable queries never reuse saved fallback values', () => {
  const item = component('label', { customProperties: { a: { type: 'number', value: 1 }, b: { type: 'number', value: 2 } }, bindings: { 'customProperties.a.value': binding('b', { b: custom('b') }), 'customProperties.b.value': binding('a', { a: custom('a') }), text: binding('a', { a: custom('a') }) } });
  const cyclic = evaluate(item); assert.match(cyclic.errors.text, /cycle/); assert.equal(cyclic.component.props.customProperties.a.value, undefined);
  item.props.bindings['customProperties.a.value'] = binding('false ? b : 1', { b: custom('b') });
  assert.match(evaluate(item).errors.text, /cycle/);
  item.props.bindings = { 'customProperties.a.value': literal('wrong'), text: binding('a', { a: custom('a') }) };
  assert.match(evaluate(item).errors.text, /number/);
  item.props.bindings = { text: binding('a', { a: custom('a') }) }; item.props.queryBindings = { 'customProperties.a.value': { queryId: 'q', column: 'value' } };
  assert.match(evaluate(item).errors.text, /unavailable/);
  const queryProperties = { label: { 'customProperties.a.value': { status: 'ready', value: 7 } } };
  assert.equal(evaluate(item, { queryProperties }).component.props.text, '7');
});
check('transitive custom source capture includes inputs/state and rejects hidden passwords', () => {
  const peer = component('label', { customProperties: { derived: { type: 'number', value: 0 } }, bindings: { 'customProperties.derived.value': binding('count + value', { count: { kind: 'input', key: 'count' }, value: { kind: 'screenState', key: 'limit' } }) } }, 'peer');
  const placement = component('template', { parameterBindings: { result: binding('source', { source: custom('derived', 'peer') }) } });
  const input = component('numberInput', { fieldKey: 'count' }); const components = [placement, peer, input];
  assert.deepEqual(parameterBindingInputs(placement, { count: 2, secret: 'omit' }, components), { count: 2 });
  assert.deepEqual(parameterBindingState(placement, { screen: { limit: 3, omit: 4 } }, components), { screen: { limit: 3 } });
  assert.equal(bindingReferenceDependencies(placement.props.parameterBindings.result, placement, { components }).length, 3);
  input.type = 'passwordInput'; assert.match(validateTemplateParameterBinding(placement.props.parameterBindings.result, placement, components, {}, 'result', 'number', { session: {}, screen: { limit: 3 } }), /non-password/);
});
check('invalid input constraints disable controls regardless of enabled binding order', () => {
  const item = component('textInput', { validation: { minLength: 1, maxLength: 5 }, bindings: { 'validation.minLength': literal(10), enabled: literal(true) } });
  const result = evaluate(item); assert.match(result.errors['validation.minLength'], /Minimum length/); assert.equal(result.component.props.enabled, false);
  const numeric = component('slider', { min: 0, max: 100, bindings: { min: literal(200), max: literal(300), step: literal(2) } });
  assert.deepEqual(evaluate(numeric).errors, {}); numeric.props.bindings.step = literal(0); assert.equal(evaluate(numeric).component.props.enabled, false);
});
check('custom tag quality and simulation metadata propagate through dependencies', () => {
  const item = component('label', { customProperties: { reading: { type: 'number', value: 1 } }, bindings: { 'customProperties.reading.value': binding('tag', { tag: { kind: 'tag', path: '[default]Reading' } }), text: binding('value', { value: custom('reading') }) } });
  assert.match(evaluate(item).errors.text, /not found/);
  const ctx = context([item], { tags: [{ path: '[default]Reading', value: 12, quality: 'Good', source: 'simulated' }] });
  const result = evaluatePropertyBinding(item.props.bindings.text, item, ctx); assert.equal(result.value, 12); assert.equal(result.simulated, true);
  assert.equal(validatePropertyBinding(literal('wrong'), 'customProperties.reading.value', item)?.includes('number'), true);
});
check('unregistered and prototype paths are errors and cannot write arbitrary properties', () => {
  const item = component('label', { bindings: { 'customProperties.__proto__.value': literal(1), script: literal('run()'), 'arbitrary.value': literal(1) } });
  const result = evaluate(item); assert.equal(Object.keys(result.errors).length, 3); assert.equal(result.component.props.script, undefined); assert.equal({}.value, undefined);
  const prototype = evaluate(component('label', { bindings: JSON.parse('{"__proto__":{"expression":"1","references":{}}}') }));
  assert.ok(Object.hasOwn(prototype.errors, '__proto__')); assert.match(prototype.errors.__proto__, /not supported/); assert.equal(Object.getPrototypeOf(prototype.errors), Object.prototype);
});
const { createPopup, validatePopupSource } = await import(load('popupModel'));
{
  const peer = component('label', { customProperties: { first: { type: 'number', value: 1 }, second: { type: 'number', value: 1 }, derived: { type: 'number', value: 1 } },
    queryBindings: { 'customProperties.first.value': { queryId: 'first', column: 'value', parameters: { count: binding('count', { count: { kind: 'input', key: 'count' } }) } },
      'customProperties.second.value': { queryId: 'second', column: 'value', parameters: { source: binding('first', { first: custom('first') }) } } },
    bindings: { 'customProperties.derived.value': binding('second + 1', { second: custom('second') }) } }, 'peer');
  const opener = component('button', { action: 'openPopup', targetScreenId: 'detail', parameters: { title: '{amount}' } }, 'open');
  const template = { id: 'card', name: 'Card', width: 200, height: 100, parameters: { amount: '0' }, parameterTypes: { amount: 'number' }, components: [opener] };
  const placement = component('template', { templateId: 'card', parameterBindings: { amount: binding('derived', { derived: custom('derived', 'peer') }) } }, 'placement');
  const input = component('numberInput', { fieldKey: 'count' }, 'count');
  const screen = { id: 'screen', name: 'Screen', width: 500, height: 300, components: [input, peer, placement] };
  const detail = { id: 'detail', name: 'Detail', kind: 'popup', width: 200, height: 100, parameters: { title: '' }, components: [] };
  const project = { id: 'p', name: 'Project', revision: 1, parameters: {}, screens: [screen, detail], templates: [template] };
  const popup = createPopup(project, screen, opener, {}, { amount: 13 }, { instanceId: placement.id, template, parameters: { amount: 13 }, inputs: {}, bindingInputs: [{ count: 2 }], sourceParameterScopes: [{ amount: 13 }] });
  assert.deepEqual(popup.querySourceParameters, { amount: 13 });
  const calls = []; let adjustment = 0;
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.startsWith('/runtime/queries?')) return [{ id: 'first', kind: 'query', parameters: [{ name: 'count', type: 'number' }] }, { id: 'second', kind: 'query', parameters: [{ name: 'source', type: 'number' }] }];
    assert.equal(body.publishedAt, 'published-v1');
    return { columns: ['value'], rows: [{ value: path.includes('/first/') ? body.parameters.count * 3 : body.parameters.source * 2 + adjustment }], durationMs: 1 };
  };
  const ready = await validatePopupSource(project, popup, [], 'runtime', request, 'published-v1');
  assert.deepEqual(ready, { ready: true, stale: false, message: '' });
  assert.equal(calls.filter(call => call.method === 'GET').length, 1);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body.parameters), [{ count: 2 }, { source: 6 }]);
  adjustment = 1;
  const changed = await validatePopupSource(project, popup, [], 'runtime', request, 'published-v1');
  assert.equal(changed.ready, false); assert.equal(changed.stale, true); assert.match(changed.message, /changed/);
  const denied = await validatePopupSource(project, popup, [], 'runtime', async () => { throw new Error('Denied'); }, 'published-v1');
  assert.equal(denied.ready, false); assert.match(denied.message, /Denied/);
  const abort = new AbortController(); abort.abort(new Error('Cancelled'));
  await assert.rejects(validatePopupSource(project, popup, [], 'runtime', request, 'published-v1', abort.signal), /Cancelled/);
  checks++; console.log('PASS popup replay resolves custom queries in order, pins publication, deduplicates reads and rejects changed/denied/cancelled sources');
}
console.log(`${checks} runtime property catalog and dependency checks passed.`);
