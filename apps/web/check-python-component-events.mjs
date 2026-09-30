import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.stack?.split('\n').filter(line => !line.includes('data:')).join('\n') ?? error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dep) => prefix + JSON.stringify(dep.startsWith('./') ? load(dep.slice(2)) : pathToFileURL(require.resolve(dep)).href));
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); cache.set(name, url); return url;
}
const {PythonComponentEventQueue, PythonMountBarrier, completePythonEvent, pythonEventRequest, withoutPasswordInputs} = await import(load('pythonComponentEvents'));
const {InputEventLifecycle} = await import(load('inputEvents'));
const {ComponentEventLifecycle, ComponentEventCoordinator, componentEventSamples, componentEventProperties} = await import(load('componentEventModel'));
const {ComponentMessageBus} = await import(load('componentMessageModel'));
const {ApplicationStateStore} = await import(load('applicationStateModel'));
const {capturePythonUiAction} = await import(load('pythonUiModel'));
const {setPreviewRequestContext} = await import(load('previewRequest'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };
const c = (id, type = 'label', props = {}) => ({id, type, x: 0, y: 0, width: 120, height: 40, props});
const py = {language: 'python'}; // Published definitions intentionally omit source.
const value = v => ({value: v, available: true, error: ''});
const input = c('quantity', 'numberInput', {fieldKey: 'quantity', events: {change: py, commit: py}});
const label = c('title', 'label', {text: 'initial', componentEvents: {propertyChange: {...py, properties: ['text']}}});
function state() { const store = new ApplicationStateStore(); store.configure('test'); const screen = store.activateScreen('main', {title: {type: 'string', value: 'initial'}}); return {store, screen, context: () => store.context(screen)}; }
function inputContext(extra = {}) { return {key: 'input-owner', component: input, components: [input], inputs: {quantity: 0}, parameters: {machine: 'A'}, notify() {}, error() {}, setInput() {}, ...extra}; }
function mountInput(ctx, execute) { const life = new InputEventLifecycle(execute); life.setContext(ctx, 0); life.activate(); return life; }
function eventContext(extra = {}) { return {key: 'component-owner', component: label, components: [label], inputs: {}, parameters: {}, coordinator: new ComponentEventCoordinator(), ...extra}; }
function mountEvent(ctx, samples = {text: value('initial')}) { const life = new ComponentEventLifecycle(() => { throw new Error('Python must never enter the JavaScript executor'); }); life.activate(); life.prepare(ctx, samples); life.commit(); return life; }
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('published source-free Python input handlers receive typed event snapshots and preserve commit baselines', async () => {
  const calls = [], ctx = inputContext({python: async (...args) => { calls.push(args); return ''; }});
  const life = mountInput(ctx, () => { throw new Error('wrong executor'); });
  life.change(5); life.commit(5); life.commit(5); ctx.parameters.machine = 'B'; await life.whenIdle();
  assert.deepEqual(calls.map(([handler, event, values, parameters]) => [handler.type, event.value, event.previousValue, event.origin, values.quantity, parameters.machine]), [['change', 5, 0, 'user', 5, 'A'], ['commit', 5, 0, 'user', 5, 'A']]);
  life.setContext({...ctx, inputs: {quantity: 10}}, 10); life.commit(10); await life.whenIdle(); assert.equal(calls.length, 2); life.deactivate();
});
await check('property changes carry old/new availability and origin, run serially, and surface Python print output', async () => {
  const calls = [], ctx = eventContext({origins: {text: 'binding'}, python: async (handler, event) => { calls.push({handler, event}); return 'loaded record'; }}), life = mountEvent(ctx);
  life.prepare(ctx, {text: value('updated')}); life.commit(); await life.whenIdle();
  assert.deepEqual(calls[0].handler, {family: 'propertyChange'}); assert.equal(calls[0].event.value, 'updated'); assert.equal(calls[0].event.previousValue, 'initial'); assert.equal(calls[0].event.origin, 'binding');
  assert.equal(ctx.coordinator.snapshot().diagnostics[0].message, 'loaded record'); assert.equal(ctx.coordinator.snapshot().diagnostics[0].level, 'info'); life.deactivate(); await life.whenIdle();
});
await check('a silent successful Python input event clears its prior inline error and keeps diagnostic history', async () => {
  const coordinator = new ComponentEventCoordinator(); let inline = null, attempts = 0;
  const life = mountInput(inputContext({coordinator, error: message => { inline = message; }, clearStatus: () => { inline = null; }, python: async () => {
    if (++attempts === 1) throw new Error('temporary response failure'); return '';
  }}));
  life.change(1); await life.whenIdle(); assert.match(inline, /temporary response failure/);
  life.change(2); await life.whenIdle(); assert.equal(inline, null); assert.equal(coordinator.snapshot().diagnostics.length, 1); life.deactivate();
});
await check('Python assigned property text is observed literally including parameter braces', () => {
  const evaluated = {...label, props: {...label.props, text: '{station}'}};
  assert.equal(componentEventSamples(label, evaluated, {}, {station: 'Resolved'}, undefined, undefined, {text: '{station}'}).text.value, '{station}');
  assert.equal(componentEventSamples(label, evaluated, {}, {station: 'Resolved'}, undefined).text.value, 'Resolved');
});
await check('Python message handlers use the addressed receiver identity and frozen payload in one instance', async () => {
  const coordinator = new ComponentEventCoordinator(), bus = new ComponentMessageBus(coordinator), calls = [];
  const receiver = c('receiver', 'label', {messageHandlers: [{id: 'receive-load', messageType: 'load', scope: 'instance', language: 'python'}]});
  const create = row => eventContext({key: row, component: receiver, components: [receiver, c('secret', 'passwordInput')], inputs: {secret: 'forbidden', quantity: 3}, coordinator,
    messages: {bus, screenKey: 'main', instanceKey: row}, python: async (handler, event, inputs) => { calls.push({row, handler, event, inputs}); return ''; }});
  const a = mountEvent(create('row-a'), {}), b = mountEvent(create('row-b'), {});
  const payload = {order: {id: 42}}; assert.equal(bus.send('load', payload, {scope: 'instance'}, {screenKey: 'main', instanceKey: 'row-a'}).accepted, 1); payload.order.id = 99;
  await a.whenIdle(); assert.equal(calls.length, 1); assert.equal(calls[0].row, 'row-a'); assert.deepEqual(calls[0].handler, {family: 'message', handlerId: 'receive-load'}); assert.equal(calls[0].event.payload.order.id, 42); assert.ok(Object.isFrozen(calls[0].event.payload)); assert.deepEqual(calls[0].inputs, {quantity: 3});
  a.deactivate(); b.deactivate(); await Promise.all([a.whenIdle(), b.whenIdle()]);
});
await check('request identities select saved published or Preview handlers without transmitting source or flattened instance aliases', () => {
  const env = state(), invocation = {eventHandler: {family: 'input', type: 'commit'}, event: {type: 'commit', value: 3}, inputs: {quantity: 3}, parameters: {local: 'not-root'}, uiAction: capturePythonUiAction(env.context(), [input]), signal: new AbortController().signal};
  const instance = {instanceId: 'outer', instancePath: [{instanceId: 'outer'}, {instanceId: 'rows', rowId: '42'}], bindingInputs: [{selection: 42}]};
  const request = pythonEventRequest({scope: 'runtime', screenId: 'main', parameters: {machine: 'A'}, publishedAt: 'publication-1'}, 'quantity', invocation, instance);
  assert.equal(request.path, '/runtime/screens/main/components/quantity/events'); assert.deepEqual(request.body.parameters, {machine: 'A'}); assert.equal(request.body.publishedAt, 'publication-1'); assert.equal('instanceId' in request.body, false); assert.equal('code' in request.body, false); assert.deepEqual(request.body.instancePath, instance.instancePath);
  const preview = pythonEventRequest({scope: 'designer', templateId: 'work-form', parameters: {}}, 'quantity', invocation);
  assert.equal(preview.path, '/preview/templates/work-form/components/quantity/events'); assert.equal('publishedAt' in preview.body, false);
  assert.throws(() => pythonEventRequest({scope: 'runtime', templateId: 'no', parameters: {}}, 'quantity', invocation), /owner/);
});
await check('password values are stripped from snapshots and password controls cannot enqueue Python input handlers', async () => {
  assert.deepEqual(withoutPasswordInputs([input, c('secret', 'passwordInput', {fieldKey: 'pin'})], {quantity: 2, pin: '1234'}), {quantity: 2});
  const errors = [], life = mountInput(inputContext({component: {...input, type: 'passwordInput'}, python: () => { throw new Error('secret leaked'); }, error: message => errors.push(message)}));
  life.change(1); await life.whenIdle(); assert.match(errors[0], /Password inputs/); life.deactivate();
});
await check('one component FIFO orders different Python event families and enforces queue/deadline limits', async () => {
  const queue = new PythonComponentEventQueue(15), signal = new AbortController().signal, gate = defer(), seen = [];
  const first = queue.run(signal, async s => { seen.push('input'); await gate.promise; assert.equal(s.aborted, true); return 'late'; });
  const caught = first.catch(error => error.message);
  const later = queue.run(signal, async () => { seen.push('message'); return 'next'; });
  assert.match(await caught, /timed out/); assert.equal(await later, 'next'); assert.deepEqual(seen, ['input', 'message']); gate.resolve();
  const blocked = new PythonComponentEventQueue(100), blocker = defer(), controller = new AbortController(), work = [];
  for (let i = 0; i < 32; i++) work.push(blocked.run(controller.signal, async () => { await blocker.promise; return ''; }).catch(() => {}));
  await assert.rejects(blocked.run(controller.signal, async () => ''), /queue is full/); controller.abort(); blocker.resolve(); await Promise.all(work);
});
await check('browser response guard allows transport overhead beyond the two-second gateway execution budget', async () => {
  const queue = new PythonComponentEventQueue();
  assert.equal(await queue.run(new AbortController().signal, async signal => { await delay(2100); assert.equal(signal.aborted, false); return 'delivered'; }), 'delivered');
});
await check('closing input and component owners aborts gateway transport and prevents queued deliveries', async () => {
  const invocations = [], queue = new PythonComponentEventQueue(100), ctx = inputContext({python: (_h, _e, _i, _p, signal) => queue.run(signal, async combined => { invocations.push(combined); return new Promise(() => {}); })});
  const life = mountInput(ctx); life.change(1); life.change(2); await delay(1); life.deactivate(); await life.whenIdle(); assert.equal(invocations.length, 1); assert.equal(invocations[0].aborted, true);
  const eventCalls = [], eventCtx = eventContext({python: (_h, _e, _i, _p, signal) => queue.run(signal, async combined => { eventCalls.push(combined); return new Promise(() => {}); })});
  const events = mountEvent(eventCtx); events.prepare(eventCtx, {text: value('changed')}); events.commit(); await delay(4); events.deactivate(); await events.whenIdle(); assert.equal(eventCalls[0].aborted, true);
});
await check('successful Python responses atomically apply UI changes and refresh gateway data; failures discard effects', async () => {
  const env = state(), controller = new AbortController(), updates = []; env.store.subscribe(() => updates.push(env.context().uiSnapshot())); let refresh = 0;
  const effects = [{kind: 'property', componentId: 'title', property: 'text', value: 'loaded'}, {kind: 'state', scope: 'screen', key: 'title', value: 'loaded'}];
  const action = capturePythonUiAction(env.context(), [label]);
  assert.equal(await completePythonEvent(async () => ({success: true, stdout: 'Loaded\n', uiEffects: effects}), action, controller.signal, () => refresh++), 'Loaded');
  assert.equal(updates.length, 1); assert.equal(refresh, 1); assert.equal(env.context().uiSnapshot().properties.title.text, 'loaded');
  assert.equal(await completePythonEvent(async () => ({success: true, stdout: 'Saved\n', result: {message: 'Work order saved'}}), capturePythonUiAction(env.context(), [label]), controller.signal, () => {}), 'Saved\nWork order saved');
  await assert.rejects(completePythonEvent(async () => ({success: false, stderr: 'Invalid work order', uiEffects: effects}), capturePythonUiAction(env.context(), [label]), controller.signal, () => refresh++), /Invalid work order/); assert.equal(updates.length, 1); assert.equal(refresh, 1);
});
await check('late or conflicting successful responses refresh data but cannot overwrite current UI edits', async () => {
  const env = state(), controller = new AbortController(); let refresh = 0;
  const action = capturePythonUiAction(env.context(), [label]); env.context().api.set('screen', 'title', 'newer edit');
  await assert.rejects(completePythonEvent(async () => ({success: true, uiEffects: [{kind: 'state', scope: 'screen', key: 'title', value: 'late'}]}), action, controller.signal, () => refresh++), /already have completed/); assert.equal(env.context().api.get('screen', 'title'), 'newer edit'); assert.equal(refresh, 1);
  const late = capturePythonUiAction(env.context(), [label]); env.store.closeScope(env.screen);
  assert.equal(await completePythonEvent(async () => ({success: true, uiEffects: []}), late, controller.signal, () => refresh++), ''); assert.equal(refresh, 2);
});
await check('read-only Preview never invokes Python and view-only receivers do not register runnable Python handlers', async () => {
  setPreviewRequestContext({token: 'read-only', mode: 'read-only', expiresAt: new Date(Date.now() + 60000).toISOString()});
  let calls = 0; const life = mountInput(inputContext({python: async () => { calls++; return ''; }})); life.change(2); await life.whenIdle(); life.deactivate(); assert.equal(calls, 0);
  setPreviewRequestContext(null, false);
  const ctx = eventContext(), events = mountEvent(ctx); events.prepare(ctx, {text: value('changed')}); events.commit(); await events.whenIdle(); assert.deepEqual(ctx.coordinator.snapshot().diagnostics, []); events.deactivate();
});
await check('wrapper and redacted password Python property/message handlers use their own receiver context', async () => {
  for (const type of ['template', 'repeater', 'passwordInput']) {
    const bus = new ComponentMessageBus(), calls = [], control = {...label, type, props: {fieldKey: 'secret', componentEvents: {propertyChange: {...py, properties: ['enabled']}}, messageHandlers: [{id: 'notice', messageType: 'notice', scope: 'screen', ...py}]}};
    const ctx = eventContext({component: control, components: [control, c('secret', 'passwordInput', {fieldKey: 'secret'})], inputs: {secret: 'must not leave browser'},
      messages: {bus, screenKey: 'main', instanceKey: 'main'}, python: async (handler, event, inputs) => { calls.push({handler, event}); assert.equal(Object.hasOwn(inputs, 'secret'), false); return ''; }});
    const events = mountEvent(ctx, {enabled: value(true)});
    events.prepare(ctx, {enabled: value(false)}); events.commit();
    bus.send('notice', {}, {scope: 'screen'}, {screenKey: 'main', instanceKey: 'main'}); await events.whenIdle();
    assert.deepEqual(calls.map(call => call.event.type), ['propertyChange', 'message']); assert.equal(ctx.coordinator.snapshot().diagnostics.length, 0);
    events.deactivate(); await events.whenIdle();
  }
});
await check('password Python property watches redact text and value while existing JavaScript caption watches remain', () => {
  const password = c('secret', 'passwordInput', {text: 'Password', componentEvents: {propertyChange: {...py, properties: ['text']}}});
  assert.equal(componentEventProperties(password, 'python').includes('text'), false);
  assert.equal(componentEventProperties(password, 'python').includes('value'), false);
  assert.equal(componentEventProperties(password, 'javascript').includes('text'), true);
  assert.equal(componentEventSamples(password, password, {}, {}, 'typed-secret').text.available, false);
  assert.equal(componentEventSamples(password, password, {}, {}, 'typed-secret').text.value, null);
});

await check('Python mount precedes property and message deliveries and uses the saved lifecycle selector', async () => {
  const calls = [], bus = new ComponentMessageBus(), gate = defer(), queue = new PythonComponentEventQueue();
  const control = {...label, props: {...label.props, componentEvents: {mount: py, propertyChange: {...py, properties: ['text']}}, messageHandlers: [{id: 'notice', messageType: 'notice', scope: 'screen', ...py}]}};
  const ctx = eventContext({component: control, components: [control], messages: {bus, screenKey: 'main', instanceKey: 'main'}, python: (handler, event, _i, _p, signal) => queue.run(signal, async () => {
    calls.push({handler, event}); if (event.type === 'mount') await gate.promise; return '';
  })});
  const events = mountEvent(ctx); events.prepare(ctx, {text: value('changed')}); events.commit();
  bus.send('notice', {}, {scope: 'screen'}, {screenKey: 'main', instanceKey: 'main'});
  await delay(5); assert.deepEqual(calls.map(call => call.event.type), ['mount']); gate.resolve(); await events.whenIdle();
  assert.deepEqual(calls.map(call => call.event.type), ['mount', 'propertyChange', 'message']);
  assert.deepEqual(calls[0].handler, {family: 'lifecycle', type: 'mount'}); events.deactivate(); await events.whenIdle();
});
await check('Python mount barrier holds input until mount settles and aborts a departed waiting input', async () => {
  const gate = new PythonMountBarrier(), abort = new AbortController(); let entered = false;
  const pending = gate.wait(abort.signal).then(() => { entered = true; }); await delay(3); assert.equal(entered, false);
  gate.finish(); await pending; assert.equal(entered, true);
  const retired = new PythonMountBarrier(), controller = new AbortController(), waiting = retired.wait(controller.signal);
  controller.abort(); await assert.rejects(waiting, /closed|abort/i);
});
await check('StrictMode phantom owner sends neither mount nor unmount and its replacement cleans up exactly once', async () => {
  const calls = [], control = {...label, props: {componentEvents: {mount: py, unmount: py}}};
  const ctx = eventContext({component: control, components: [control], python: async (handler, event, _i, _p, signal) => { assert.equal(signal.aborted, false); calls.push(event.type); return ''; }});
  const events = mountEvent(ctx, {}); events.deactivate(); events.activate(); events.commit(); await events.whenIdle();
  assert.deepEqual(calls, ['mount']); events.deactivate(); events.deactivate(); await events.whenIdle(); assert.deepEqual(calls, ['mount', 'unmount']);
});
await check('Python cleanup waits for cancelled mount, uses a fresh signal, and retains departing values', async () => {
  const calls = [], control = {...label, props: {componentEvents: {mount: py, unmount: py}}};
  const ctx = eventContext({component: control, components: [control], inputs: {quantity: 7}, parameters: {station: 'A'}, python: async (handler, event, inputs, parameters, signal) => {
    calls.push(event.type);
    if (event.type === 'mount') await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    else { assert.equal(signal.aborted, false); assert.deepEqual(inputs, {quantity: 7}); assert.deepEqual(parameters, {station: 'A'}); return 'closed A'; }
    return '';
  }});
  const events = mountEvent(ctx, {}); await delay(3); events.deactivate(); await events.whenIdle();
  assert.deepEqual(calls, ['mount', 'unmount']); assert.equal(ctx.coordinator.snapshot().diagnostics.at(-1).message, 'closed A');
});
await check('unmount-only Python handlers run once after a real owner and never from read-only Preview', async () => {
  let calls = 0; const control = {...label, props: {componentEvents: {unmount: py}}};
  const ctx = eventContext({component: control, components: [control], python: async () => { calls++; return ''; }});
  const events = mountEvent(ctx, {}); await events.whenIdle(); events.deactivate(); await events.whenIdle(); assert.equal(calls, 1);
  setPreviewRequestContext({token: 'read-only', mode: 'read-only', expiresAt: new Date(Date.now()+60000).toISOString()});
  const disabled = mountEvent(ctx, {}); await disabled.whenIdle(); setPreviewRequestContext(null, false); disabled.deactivate(); await disabled.whenIdle(); assert.equal(calls, 1);
});
await check('wrapper and redacted password lifecycle and property handlers share the containing form', async () => {
  for (const type of ['template', 'repeater', 'passwordInput']) {
    const calls = [], control = {...label, type, props: {componentEvents: {mount: py, unmount: py, propertyChange: {...py, properties: ['enabled']}}}};
    const ctx = eventContext({component: control, components: [control], parameters: {station: 'containing'}, python: async (_handler, event, _inputs, parameters) => {
      calls.push(event.type); assert.equal(parameters.station, 'containing'); return '';
    }});
    const events = mountEvent(ctx, {enabled: value(true)}); await events.whenIdle(); events.prepare(ctx, {enabled: value(false)}); events.commit(); await events.whenIdle();
    assert.equal(ctx.coordinator.snapshot().diagnostics.length, 0);
    events.deactivate(); await events.whenIdle(); assert.deepEqual(calls, ['mount', 'propertyChange', 'unmount']);
  }
});
await check('unmount wire snapshot permits retired reads but the same retired context cannot send live events', () => {
  const ui = {state: {session: {}, screen: {}}, properties: {}}, action = {ui, isCurrent: () => false};
  const invocation = {eventHandler: {family: 'lifecycle', type: 'unmount'}, event: {type: 'unmount', componentId: 'title'}, inputs: {}, parameters: {}, uiAction: action, signal: new AbortController().signal};
  const request = pythonEventRequest({scope: 'runtime', screenId: 'main', parameters: {}, publishedAt: 'revision'}, 'title', invocation, {instancePath: [{instanceId: 'rows', rowId: 'r1'}], isCurrent: () => false});
  assert.equal(request.body.ui, ui); assert.equal(request.body.rowId, 'r1');
  assert.throws(() => pythonEventRequest({scope: 'runtime', screenId: 'main', parameters: {}, publishedAt: 'revision'}, 'title', {...invocation, eventHandler: {family: 'lifecycle', type: 'mount'}}), /closed/);
});

console.log(`${passed} Python component event checks passed.`);
