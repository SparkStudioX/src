import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function loader(fakeHooks = false) {
  const modules = new Map();
  const hooks = `data:text/javascript;base64,${Buffer.from('export const useId = () => "input-test"; export const useRef = value => ({current:value}); export const useState = value => [value,()=>{}]; export const useEffect = () => {};').toString('base64')}`;
  return function moduleUrl(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
    assert.ok(file, name);
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' && fakeHooks ? hooks : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    modules.set(name, url); return url;
  };
}
const moduleUrl = loader();
const { InputEventLifecycle, inputAssignmentError, executeInputEvent } = await import(moduleUrl('inputEvents'));
const { ComponentView } = await import(loader(true)('Components'));
const { default: BoundComponent } = await import(moduleUrl('BoundComponent'));
const component = (id = 'amount', type = 'numberInput', props = {}) => ({ id, type, x: 0, y: 0, width: 220, height: 90, props: { fieldKey: id, defaultValue: 0, events: { change: { language: 'javascript', code: 'change' }, commit: { language: 'javascript', code: 'commit' } }, ...props } });
const form = [component(), component('enabled', 'checkbox', { defaultValue: false }), component('choice', 'select', { defaultValue: 'A', options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }] })];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = (overrides = {}) => ({ key: 'form:A:v1', component: form[0], components: form, inputs: { amount: 0, enabled: false, choice: 'A' }, parameters: { asset: 'A' }, setInput() {}, notify() {}, error() {}, ...overrides });
const mount = (execute, ctx = context(), initial = 0) => { const runner = new InputEventLifecycle(execute); runner.setContext(ctx, initial); runner.activate(); return runner; };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('change uses previous edit; commits deduplicate and use the last committed baseline', async () => {
  const events = []; const runner = mount((_script, event) => events.push(event));
  runner.change(1); runner.setContext(context({ inputs: { amount: 1 } }), 1);
  runner.change(2); runner.setContext(context({ inputs: { amount: 2 } }), 2);
  runner.commit(2); runner.commit(2); runner.change(3); runner.commit(3);
  await runner.whenIdle();
  assert.deepEqual(events.map(({ type, value, previousValue }) => [type, value, previousValue]), [['change', 1, 0], ['change', 2, 1], ['commit', 2, 0], ['change', 3, 2], ['commit', 3, 2]]);
  assert.ok(events.every(event => event.componentId === 'amount' && event.fieldKey === 'amount'));
});
await test('mount, tag/default changes, and external scripted values do not emit events or later phantom commits', async () => {
  const events = []; const runner = mount((_script, event) => events.push(event));
  runner.setContext(context(), 5); runner.commit(5); runner.setContext(context(), null);
  runner.setContext(context(), 9); runner.commit(9); await runner.whenIdle();
  assert.deepEqual(events, []);
});
await test('compound selections capture all mapped fields before change and commit without firing sibling events', async () => {
  const events = []; const ctx = context();
  const runner = mount((_script, event, inputs) => events.push({event,inputs}), ctx);
  runner.updateInputs({enabled:true}); runner.updateInputs({choice:'B'}); runner.updateInputs({amount:8});
  runner.change(8); runner.commit(8);
  runner.updateInputs({choice:'A'});
  await runner.whenIdle();
  assert.deepEqual(events.map(item => item.event.type), ['change','commit']);
  assert.ok(events.every(item => item.inputs.enabled === true && item.inputs.choice === 'B' && item.inputs.amount === 8));
  assert.equal(events[0].event.previousValue, 0);
  assert.equal(ctx.inputs.choice, 'A');
});
await test('async handlers execute serially and queue is bounded at 32 including the running handler', async () => {
  const gate = defer(); const values = []; const errors = [];
  const runner = mount(async (_script, event) => { values.push(event.value); if (event.value === 1) await gate.promise; }, context({ error: message => errors.push(message) }));
  for (let value = 1; value <= 40; value++) runner.change(value);
  await Promise.resolve(); assert.deepEqual(values, [1]); assert.equal(runner.pendingCount, 32); assert.ok(errors.every(message => message.includes('queue is full')));
  gate.resolve(); await runner.whenIdle(); assert.deepEqual(values, Array.from({ length: 32 }, (_, index) => index + 1)); assert.equal(runner.pendingCount, 0);
});
await test('scope/code changes invalidate old helpers and release a new queue from a stalled handler', async () => {
  const effects = []; let oldApp; const values = [];
  const runner = mount((_script, event, _inputs, _parameters, app) => { values.push(event.value); if (event.value === 1) { oldApp = app; return new Promise(() => {}); } }, context({ notify: message => effects.push(message), setInput: (...args) => effects.push(args) }));
  runner.change(1); runner.change(2); await Promise.resolve();
  runner.setContext(context({ key: 'form:B:v2', notify: message => effects.push(message), setInput: (...args) => effects.push(args) }), 10);
  oldApp.notify('stale'); oldApp.setInput('amount', 99); runner.change(11); await runner.whenIdle();
  assert.deepEqual(values, [1, 11]); assert.deepEqual(effects, []); assert.equal(runner.pendingCount, 0);
});
await test('disabled/unmounted contexts suppress queued handlers, late errors and helper effects', async () => {
  for (const disable of [runner => runner.setContext(null, 0), runner => runner.deactivate()]) {
    const gate = defer(); const effects = []; let oldApp;
    const runner = mount(async (_script, _event, _inputs, _parameters, app) => { oldApp = app; await gate.promise; throw new Error('late'); }, context({ notify: message => effects.push(message), error: message => effects.push(message), setInput: (...args) => effects.push(args) }));
    runner.change(1); const queue = runner.whenIdle(); await Promise.resolve(); disable(runner);
    oldApp.notify('late'); oldApp.setInput('amount', 3); runner.change(2); gate.resolve(); await queue; assert.deepEqual(effects, []);
  }
});
await test('current handler failures are visible and do not poison later events', async () => {
  const errors = []; const events = [];
  const runner = mount((_script, event) => { events.push(event.type); if (event.type === 'change') throw new Error('broken'); }, context({ error: message => errors.push(message) }));
  runner.change(2); runner.commit(2); await runner.whenIdle();
  assert.deepEqual(events, ['change', 'commit']); assert.deepEqual(errors, ['change: broken']);
});
await test('app.setInput validates local declarations and assignments do not recursively trigger events', async () => {
  const changes = []; const events = [];
  const runner = mount((_script, event, _inputs, _parameters, app) => { events.push(event.type); app.setInput('amount', 7); app.setInput('enabled', true); }, context({ setInput: (...args) => changes.push(args) }));
  runner.change(1); await runner.whenIdle(); runner.commit(7); await runner.whenIdle();
  assert.deepEqual(changes, [['amount', 7], ['enabled', true]]); assert.deepEqual(events, ['change']);
  const limits = component('n', 'spinner', { min: 0, max: 10 });
  for (const value of [11, -1, NaN, Infinity, '3', null, 9007199254740992]) assert.ok(inputAssignmentError([limits], 'n', value));
  assert.equal(inputAssignmentError([limits], 'n', 3), null);
  assert.ok(inputAssignmentError(form, 'outside', 3)); assert.ok(inputAssignmentError(form, 'choice', 'C')); assert.ok(inputAssignmentError(form, 'enabled', 'true'));
  assert.ok(inputAssignmentError([component('date', 'dateTimeInput')], 'date', '2025-02-30T12:00'));
  assert.ok(inputAssignmentError([component('text', 'textInput')], 'text', 'x'.repeat(4097)));
});
await test('event snapshots are isolated and real JavaScript receives the declared context', async () => {
  const effects = []; const ctx = context({ notify: message => effects.push(message) });
  const c = structuredClone(ctx.component); c.props.events.change.code = 'inputs.enabled = true; parameters.asset = "edited"; app.notify(event.fieldKey + ":" + event.value);';
  const runner = mount(executeInputEvent, { ...ctx, component: c }); runner.change(4); await runner.whenIdle();
  assert.deepEqual(effects, ['amount:4']); assert.equal(ctx.inputs.enabled, false); assert.equal(ctx.parameters.asset, 'A');
});
await test('real input JavaScript reads and writes state while preserving event snapshots and form assignments', async () => {
  const effects = []; const values = { session: { total: 2 }, screen: { amount: 0 } };
  const state = { get: (scope, key) => values[scope][key], set: (scope, key, value) => { values[scope][key] = value; }, reset: (...args) => effects.push(['reset', ...args]) };
  const c = component(); c.props.events.change.code = 'app.state.set("session", "total", app.state.get("session", "total") + event.value); app.state.set("screen", "amount", event.value); app.state.reset("screen", "draft"); app.state.reset("session"); app.setInput("enabled", true);';
  const runner = mount(executeInputEvent, context({ component: c, state, setInput: (...args) => effects.push(['input', ...args]) }));
  runner.change(4); await runner.whenIdle();
  assert.deepEqual(values, { session: { total: 6 }, screen: { amount: 4 } });
  assert.deepEqual(effects, [['reset', 'screen', 'draft'], ['reset', 'session', undefined], ['input', 'enabled', true]]);
});
await test('state type failures become input diagnostics and do not block subsequent events', async () => {
  const errors = []; const events = []; const state = { get() {}, set() { throw new Error('State total requires a number.'); }, reset() {} };
  const runner = mount((_script, event, _inputs, _parameters, app) => { events.push(event.type); if (event.type === 'change') app.state.set('session', 'total', 'bad'); }, context({ state, error: text => errors.push(text) }));
  runner.change(2); runner.commit(2); await runner.whenIdle();
  assert.deepEqual(errors, ['change: State total requires a number.']); assert.deepEqual(events, ['change', 'commit']);
});
await test('captured state helpers expire on screen, popup, publication, account and disabled input contexts', async () => {
  for (const key of ['screen:B', 'popup:2', 'publication:2', 'account:B', null, 'unmounted']) {
    let app; const effects = []; const state = { get: () => 1, set: (...args) => effects.push(args), reset: (...args) => effects.push(args) };
    const ctx = context({ key: 'screen:A', state });
    const runner = mount((_script, _event, _inputs, _parameters, helper) => { app = helper; return new Promise(() => {}); }, ctx);
    runner.change(1); await Promise.resolve();
    if (key === 'unmounted') runner.deactivate(); else runner.setContext(key === null ? null : { ...ctx, key }, 0);
    assert.equal(app.state.get('session', 'count'), undefined); app.state.set('session', 'count', 99); app.state.reset('screen');
    if (key !== null && key !== 'unmounted') { runner.setContext(ctx, 0); app.state.set('screen', 'count', 99); }
    assert.deepEqual(effects, [], String(key));
  }
});
await test('state helpers read the latest same-scope context and unavailable state has a clear error', async () => {
  let app; const runner = mount((_script, _event, _inputs, _parameters, helper) => { app = helper; });
  runner.change(1); await runner.whenIdle();
  for (const call of [() => app.state.get('screen', 'count'), () => app.state.set('screen', 'count', 1), () => app.state.reset('screen')]) assert.throws(call, /state is unavailable/);
  runner.setContext(context({ state: { get: () => 12, set() {}, reset() {} } }), 1);
  assert.equal(app.state.get('screen', 'count'), 12);
});

function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)]; }
function harness(type, initial, extra = {}, preview = true, locked = false) {
  const c = component('field', type, { defaultValue: initial, ...extra }); const events = []; const changes = [];
  const runner = mount((_script, event) => events.push([event.type, event.value, event.previousValue]), context({ component: c, components: [c], inputs: { field: initial } }), initial);
  const tree = ComponentView({ component: c, tags: [], parameters: {}, inputs: { field: initial }, preview, interactionLocked: locked, onNavigate() {}, onInputChange: (key, value) => { changes.push([key, value]); runner.change(value); }, onInputCommit: (_key, value) => runner.commit(value) });
  return { tree, events, changes, runner, native: nodes(tree).filter(node => ['input', 'textarea', 'select', 'button'].includes(node.type)) };
}
const enter = (overrides = {}) => ({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {}, ...overrides });
await test('text, number, spinner text and date inputs change while typing and commit once on Enter/blur', async () => {
  for (const [type, initial, entered, expected] of [['textInput', '', 'abc', 'abc'], ['numberInput', 0, '3', 3], ['spinner', 0, '3', 3], ['dateTimeInput', '', '2026-09-28T10:00', '2026-09-28T10:00']]) {
    const h = harness(type, initial); const input = h.native.find(node => node.type === 'input');
    input.props.onChange({ target: { value: entered } }); await h.runner.whenIdle(); assert.deepEqual(h.events, [['change', expected, initial]], type);
    input.props.onKeyDown(enter()); input.props.onBlur(); await h.runner.whenIdle(); assert.deepEqual(h.events, [['change', expected, initial], ['commit', expected, initial]], type); assert.equal(h.changes.length, 1);
  }
});
await test('textarea Enter stays multiline and Ctrl+Enter/blur commit; composition Enter does not commit', async () => {
  const h = harness('textArea', ''); const input = h.native[0]; input.props.onChange({ target: { value: 'line' } });
  input.props.onKeyDown(enter()); input.props.onKeyDown(enter({ ctrlKey: true, nativeEvent: { isComposing: true } })); await h.runner.whenIdle(); assert.equal(h.events.length, 1);
  input.props.onKeyDown(enter({ ctrlKey: true })); input.props.onBlur(); await h.runner.whenIdle(); assert.deepEqual(h.events.map(event => event[0]), ['change', 'commit']);
});
await test('checkbox, toggle, select and radio changes commit immediately', async () => {
  for (const type of ['checkbox', 'toggle', 'select', 'radioGroup']) {
    const boolean = type === 'checkbox' || type === 'toggle'; const h = harness(type, boolean ? false : 'A', { options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }] });
    const control = type === 'radioGroup' ? h.native[1] : h.native[0]; control.props.onChange({ target: { checked: true, value: 'B' } }); await h.runner.whenIdle();
    assert.deepEqual(h.events.map(event => event[0]), ['change', 'commit'], type); assert.deepEqual(h.events.map(event => event[1]), [boolean ? true : 'B', boolean ? true : 'B'], type);
  }
});
await test('spinner buttons commit immediately and slider changes commit once on pointer or key release', async () => {
  const spinner = harness('spinner', 0, { min: 0, max: 10 }); spinner.native.find(node => node.type === 'button' && node.props['aria-label'].startsWith('Increase')).props.onClick(); await spinner.runner.whenIdle(); assert.deepEqual(spinner.events, [['change', 1, 0], ['commit', 1, 0]]);
  const h = harness('slider', 0, { min: 0, max: 10 }); const range = h.native[0]; range.props.onChange({ target: { value: '3' } }); range.props.onChange({ target: { value: '5' } });
  range.props.onPointerUp({ currentTarget: { value: '5' } }); range.props.onBlur(); await h.runner.whenIdle(); assert.deepEqual(h.events, [['change', 3, 0], ['change', 5, 3], ['commit', 5, 0]]);
  const keyboard = harness('slider', 0, { min: 0, max: 10 }); keyboard.native[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); keyboard.native[0].props.onKeyUp({ key: 'ArrowRight' }); keyboard.native[0].props.onBlur(); await keyboard.runner.whenIdle(); assert.deepEqual(keyboard.events, [['change', 1, 0], ['commit', 1, 0]]);
});
await test('renderer callbacks suppress design and locked edits even if directly invoked', async () => {
  for (const [preview, locked] of [[false, false], [true, true]]) {
    const h = harness('checkbox', false, {}, preview, locked); h.native[0].props.onChange({ target: { checked: true } }); await h.runner.whenIdle(); assert.deepEqual(h.events, []); assert.deepEqual(h.changes, []);
  }
});
await test('rendering defaults never executes event code and explicit appearance reaches wrapper variables', () => {
  const c = component('display', 'textInput', { defaultValue: '', backgroundColor: '#112233', foregroundColor: '#abcdef', borderColor: '#445566', borderWidth: 2, fontSize: 18, events: { change: { language: 'javascript', code: 'throw new Error("must not run")' } } });
  const html = renderToStaticMarkup(React.createElement(BoundComponent, { component: c, components: [c], inputs: { display: '' }, tags: [], parameters: {}, preview: true, onNavigate() {} }));
  for (const fragment of ['has-custom-background', 'has-custom-foreground', 'has-custom-font', '--component-background:#112233', '--component-text-color:#abcdef', '--component-border-width:2px', '--component-font-size:18px']) assert.ok(html.includes(fragment), fragment);
  assert.doesNotMatch(html, /must not run|component-input-event-status/);
});
await test('read-only and unavailable Preview never start authored input JavaScript or its fetch', async () => {
  const { setPreviewRequestContext } = await import(moduleUrl('previewRequest'));
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return {}; };
  const event = { language: 'javascript', code: 'await fetch("https://example.invalid");' };
  try {
    setPreviewRequestContext(null); assert.throws(() => executeInputEvent(event, {}, {}, {}, {}), /read-only Preview/);
    setPreviewRequestContext({ token: 'x', mode: 'read-only', expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.throws(() => executeInputEvent(event, {}, {}, {}, {}), /read-only Preview/); assert.equal(calls, 0);
    setPreviewRequestContext({ token: 'x', mode: 'live-actions', expiresAt: new Date(Date.now() + 60000).toISOString() });
    await executeInputEvent(event, {}, {}, {}, {}); assert.equal(calls, 1);
    setPreviewRequestContext(null, false); await executeInputEvent(event, {}, {}, {}, {}); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; setPreviewRequestContext(null, false); }
});
console.log(`${passed}/${passed} input event model and renderer checks passed.`);
