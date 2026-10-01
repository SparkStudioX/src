import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.stack?.split('\n').filter(line => !line.includes('data:')).join('\n') ?? error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), cache = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dep) => prefix + JSON.stringify(dep.startsWith('./') ? load(dep.slice(2)) : pathToFileURL(require.resolve(dep)).href));
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); cache.set(name, url); return url;
}
const {ComponentMessageBus, createComponentMessageSender, componentMessagePayload} = await import(load('componentMessageModel'));
const {ComponentEventCoordinator, ComponentEventLifecycle, executeComponentEvent} = await import(load('componentEventModel'));
const {setPreviewRequestContext} = await import(load('previewRequest'));
const {ApplicationStateStore} = await import(load('applicationStateModel'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };
const handler = (id, scope = 'screen', code = 'handler', messageType = 'refresh') => ({id, messageType, scope, language: 'javascript', code});
const component = (id, messageHandlers = [handler('handler')], componentEvents) => ({id, type: 'label', x: 0, y: 0, width: 200, height: 50, props: {messageHandlers, componentEvents}});
const scope = (screenKey = 'main', instanceKey = screenKey) => ({screenKey, instanceKey});
function environment() { const coordinator = new ComponentEventCoordinator(); return {coordinator, bus: new ComponentMessageBus(coordinator)}; }
function context(env, item = component('receiver'), location = scope(), extra = {}) {
  return {key: item.id + ':' + location.instanceKey, component: item, components: [item], inputs: {}, parameters: {}, coordinator: env.coordinator,
    messages: {bus: env.bus, ...location}, ...extra};
}
function mount(ctx, execute = executeComponentEvent, timeout = 2000) {
  const life = new ComponentEventLifecycle(execute, timeout); life.activate(); life.prepare(ctx); life.commit(); return life;
}
async function dispose(...lifetimes) { for (const life of lifetimes) life.deactivate(); await Promise.all(lifetimes.map(life => life.whenIdle())); }
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('instance, screen and session match exact listener scopes across repeated forms and popups', () => {
  const bus = new ComponentMessageBus(), hits = [];
  for (const [name, location] of [['a', scope('main', 'row-a')], ['b', scope('main', 'row-b')], ['popup', scope('popup', 'popup-row')]])
    for (const listenScope of ['instance', 'screen', 'session']) bus.register('refresh', listenScope, location, event => { hits.push(`${name}:${event.scope}`); return true; });
  assert.equal(bus.send('refresh', {}, {scope: 'instance'}, scope('main', 'row-a')).accepted, 1); assert.deepEqual(hits.splice(0), ['a:instance']);
  assert.equal(bus.send('refresh', {}, {}, scope('main', 'row-a')).accepted, 2); assert.deepEqual(hits.splice(0), ['a:screen', 'b:screen']);
  assert.equal(bus.send('refresh', {}, {scope: 'screen'}, scope('popup', 'popup-row')).accepted, 1); assert.deepEqual(hits.splice(0), ['popup:screen']);
  assert.equal(bus.send('refresh', {}, {scope: 'session'}, scope('main')).accepted, 3); assert.deepEqual(hits, ['a:session', 'b:session', 'popup:session']);
  const another = new ComponentMessageBus(); assert.equal(another.send('refresh', {}, {scope: 'session'}, scope()).accepted, 0);
  assert.equal(bus.send('other', {}, {}, scope()).accepted, 0);
});
await check('names, scopes and sender options are validated without accidental broadcast fallbacks', () => {
  const bus = new ComponentMessageBus();
  for (const name of ['', ' padded', 'trailing ', 'a\u0085b', 'x'.repeat(81), 3]) assert.throws(() => bus.send(name, {}, {}, scope()), /Message type/);
  for (const options of [{scope: 'project'}, {scope: 1}, {target: 'all'}, [], null]) assert.throws(() => bus.send('ok', {}, options, scope()), /scope|options/);
  assert.throws(() => bus.register('ok', 'project', scope(), () => true), /scope/);
  assert.throws(() => bus.send('ok', {}, {}, {screenKey: '', instanceKey: 'a'}), /context/);
});
await check('payloads are detached and deeply frozen per recipient, with safe ordinary JSON keys', () => {
  const bus = new ComponentMessageBus(), events = [], payload = JSON.parse('{"nested":{"values":[1,true,null]},"__proto__":{"polluted":true}}');
  bus.register('x', 'screen', scope(), event => { events.push(event); return true; });
  bus.register('x', 'screen', scope(), event => { events.push(event); return true; });
  const receipt = bus.send('x', payload, {}, scope()); payload.nested.values[0] = 9;
  assert.equal(receipt.accepted, 2); assert.equal(events[0].payload.nested.values[0], 1);
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].payload.nested.values));
  assert.notEqual(events[0].payload, events[1].payload); assert.notEqual(events[0].payload.nested, events[1].payload.nested);
  assert.equal({}.polluted, undefined); assert.equal(events[0].payload.__proto__.polluted, true);
  assert.equal(events[0].messageId, events[1].messageId);
});
await check('payload byte, nesting and node boundaries reject lossy and non-JSON inputs', () => {
  assert.equal(componentMessagePayload({x: 'a'.repeat(65528)}).x.length, 65528);
  assert.throws(() => componentMessagePayload({x: 'a'.repeat(65529)}), /64 KiB/);
  assert.equal(componentMessagePayload({x: 'é'.repeat(32764)}).x.length, 32764);
  assert.throws(() => componentMessagePayload({x: 'é'.repeat(32765)}), /64 KiB/);
  const depth = count => { let item = 0; for (let i = 0; i < count; i++) item = {x: item}; return item; };
  componentMessagePayload(depth(16)); assert.throws(() => componentMessagePayload(depth(17)), /16 nested/);
  componentMessagePayload({x: Array(4094).fill(0)}); assert.throws(() => componentMessagePayload({x: Array(4095).fill(0)}), /4,096/);
  const cycle = {}; cycle.self = cycle;
  for (const payload of [null, [], 'text', 3, {x: undefined}, {x: NaN}, {x: Infinity}, {x: Number.MAX_SAFE_INTEGER + 1}, {x: 1n}, {x() {}}, {x: new Date()}, cycle, {x: Array(2)}])
    assert.throws(() => componentMessagePayload(payload));
  let called = 0; const accessor = Object.defineProperty({}, 'x', {enumerable: true, get() { called++; return 1; }});
  assert.throws(() => componentMessagePayload(accessor), /accessors/); assert.equal(called, 0);
  const shared = {value: 1}; assert.deepEqual(componentMessagePayload({one: shared, two: shared}), {one: {value: 1}, two: {value: 1}});
});
await check('registration is commit-only and authored handlers run later in the component event queue', async () => {
  const env = environment(), events = [], ctx = context(env, component('receiver', [handler('h')], {mount: {language: 'javascript', code: 'mount'}}));
  const life = new ComponentEventLifecycle((_script, event) => events.push(event.type)); life.activate(); life.prepare(ctx);
  assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0);
  life.commit(); assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 1); assert.deepEqual(events, []);
  await life.whenIdle(); assert.deepEqual(events, ['mount', 'message']); await dispose(life);
});
await check('one component may handle the same name at distinct scopes while duplicate scope registrations fail atomically', async () => {
  const env = environment(), events = [], handlers = ['instance', 'screen', 'session'].map(s => handler(s, s));
  const life = mount(context(env, component('receiver', handlers)), (_script, event) => events.push(event.scope));
  for (const target of ['instance', 'screen', 'session']) assert.equal(env.bus.send('refresh', {}, {scope: target}, scope()).accepted, 1);
  await life.whenIdle(); assert.deepEqual(events, ['instance', 'screen', 'session']); await dispose(life);
  const bad = mount(context(env, component('bad', [handler('one'), handler('two')]))); assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0);
  assert.match(env.coordinator.snapshot().diagnostics.at(-1).message, /twice/); await dispose(bad);
});
await check('messages capture recipient inputs and parameters at enqueue and remove password fields', async () => {
  const env = environment(), received = [], item = component('receiver');
  const ctx = context(env, item, scope(), {components: [item, {id: 'secret', type: 'passwordInput', props: {fieldKey: 'password'}}], inputs: {quantity: 1, password: 'omit'}, parameters: {machine: 'A'}});
  const life = mount(ctx, (_script, event, inputs, parameters) => received.push({event, inputs, parameters}));
  env.bus.send('refresh', {value: 3}, {}, scope()); ctx.inputs.quantity = 2; ctx.parameters.machine = 'B'; await life.whenIdle();
  assert.deepEqual(received[0].inputs, {quantity: 1}); assert.deepEqual(received[0].parameters, {machine: 'A'});
  assert.equal(received[0].event.componentId, 'receiver'); assert.ok(Object.isFrozen(received[0].inputs)); await dispose(life);
});
await check('accurate acknowledgments reject component queue overflow and preserve accepted FIFO order', async () => {
  const env = environment(), hold = deferred(), received = [], life = mount(context(env), async (_script, event) => { received.push(event.payload.index); if (received.length === 1) await hold.promise; });
  const receipts = Array.from({length: 40}, (_, index) => env.bus.send('refresh', {index}, {}, scope()));
  assert.equal(receipts.reduce((total, receipt) => total + receipt.accepted, 0), 32); hold.resolve(); await life.whenIdle();
  assert.deepEqual(received, Array.from({length: 32}, (_, index) => index)); assert.match(env.coordinator.snapshot().diagnostics[0].message, /queue is full/); await dispose(life);
});
await check('closing, stale contexts and bus reset revoke registration and queued delivery', async () => {
  const env = environment(), received = [], ctx = context(env); let current = true; ctx.isCurrent = () => current;
  const life = mount(ctx, (_script, event) => received.push(event));
  env.bus.send('refresh', {}, {}, scope()); current = false; await life.whenIdle(); assert.equal(received.length, 0);
  assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0); current = true;
  const sender = createComponentMessageSender(env.bus, scope()); env.bus.send('refresh', {}, {}, scope()); env.bus.reset();
  await life.whenIdle(); assert.equal(received.length, 0); assert.deepEqual(sender('refresh'), {messageId: '', accepted: 0});
  await dispose(life); assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0);
});
await check('scope and handler changes retire old queued work without reviving old helper authority', async () => {
  const env = environment(), received = [], ctx = context(env, component('receiver', [handler('h', 'instance')])); let oldApp;
  const life = mount(ctx, (_script, event, _inputs, _parameters, app) => { received.push(event.payload.value); oldApp ??= app; });
  env.bus.send('refresh', {value: 1}, {scope: 'instance'}, scope()); await life.whenIdle();
  env.bus.send('refresh', {value: 2}, {scope: 'instance'}, scope());
  const next = {...ctx, messages: {bus: env.bus, ...scope('main', 'other')}}; life.prepare(next); life.commit();
  assert.equal(oldApp.sendMessage('refresh', {}, {scope: 'session'}).accepted, 0);
  assert.equal(env.bus.send('refresh', {value: 3}, {scope: 'instance'}, scope()).accepted, 0);
  assert.equal(env.bus.send('refresh', {value: 4}, {scope: 'instance'}, scope('main', 'other')).accepted, 1);
  await life.whenIdle(); assert.deepEqual(received, [1, 4]); await dispose(life);
});
await check('timed-out handlers lose send authority while later serial handlers continue', async () => {
  const env = environment(), hold = deferred(), received = []; let abandoned;
  const life = mount(context(env), async (_script, event, _inputs, _parameters, app) => {
    if (event.payload.wait) { abandoned = app; await hold.promise; app.sendMessage('refresh', {late: true}); }
    else received.push(event.payload);
  }, 15);
  env.bus.send('refresh', {wait: true}, {}, scope()); env.bus.send('refresh', {ok: true}, {}, scope()); await life.whenIdle();
  assert.deepEqual(received, [{ok: true}]); assert.equal(abandoned.sendMessage('refresh').accepted, 0); hold.resolve(); await delay(5);
  assert.deepEqual(received, [{ok: true}]); assert.match(env.coordinator.snapshot().diagnostics[0].message, /timed out/); await dispose(life);
});
await check('suspend and resume cannot revive old message helpers when the scope key stays unchanged', async () => {
  const store = new ApplicationStateStore(); store.configure('p'); const screen = store.activateScreen('main'), initial = store.context(screen);
  const env = {bus: store.componentMessages, coordinator: store.componentEvents}, apps = [];
  const ctx = context(env, component('receiver'), {screenKey: screen.key, instanceKey: screen.key}, {isCurrent: initial.isCurrent});
  const life = mount(ctx, (_script, _event, _inputs, _parameters, app) => apps.push(app));
  initial.sendMessage('refresh'); await life.whenIdle(); assert.equal(apps.length, 1);
  store.suspend(); assert.equal(apps[0].sendMessage('refresh').accepted, 0); store.resume();
  const next = store.context(screen); assert.equal(initial.key, next.key);
  life.prepare({...ctx, isCurrent: next.isCurrent}); life.commit();
  assert.equal(apps[0].sendMessage('refresh').accepted, 0); assert.equal(next.sendMessage('refresh').accepted, 1);
  await life.whenIdle(); assert.equal(apps.length, 2); await dispose(life);
});
await check('cleanup and read-only Preview cannot send or register authored message handlers', async () => {
  const env = environment(), receipts = [], item = component('receiver', [handler('h')], {mount: {language: 'javascript', code: 'mount'}, unmount: {language: 'javascript', code: 'unmount'}});
  const life = mount(context(env, item), (_script, event, _inputs, _parameters, app) => {
    if (event.type === 'mount') app.onCleanup(() => receipts.push(app.sendMessage('refresh')));
    if (event.type === 'unmount') receipts.push(app.sendMessage('refresh'));
  });
  await life.whenIdle(); await dispose(life); assert.deepEqual(receipts.map(receipt => receipt.accepted), [0, 0]);
  setPreviewRequestContext({token: 'fixture', mode: 'read-only', expiresAt: new Date(Date.now() + 60000).toISOString()});
  try {
    const blocked = mount(context(env), () => { throw new Error('authored code must not run'); });
    assert.deepEqual(env.bus.send('refresh', {}, {}, scope()), {messageId: '', accepted: 0});
    setPreviewRequestContext(null, false); assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0); await dispose(blocked);
  } finally { setPreviewRequestContext(null, false); }
});
await check('message feedback uses the shared continuous cascade breaker and unregisters cancelled handlers', async () => {
  const env = environment(); let runs = 0;
  const life = mount(context(env), (_script, _event, _inputs, _parameters, app) => { runs++; app.sendMessage('refresh'); });
  env.bus.send('refresh', {}, {}, scope());
  for (let index = 0; index < 500 && !env.coordinator.snapshot().breaker; index++) await delay(5);
  assert.equal(runs, 128); assert.match(env.coordinator.snapshot().breaker, /128.*messages/);
  assert.equal(env.bus.send('refresh', {}, {}, scope()).accepted, 0); await dispose(life);
});
await check('mixed property and message cascades share one budget and sender-only floods remain bounded', async () => {
  const env = environment(); for (let index = 0; index < 127; index++) assert.equal(env.coordinator.accept('propertyChange'), true);
  env.bus.send('unhandled', {}, {}, scope()); env.bus.send('unhandled', {}, {}, scope()); assert.match(env.coordinator.snapshot().breaker, /128/);
  const bus = new ComponentMessageBus(); let admissions = 0; bus.register('x', 'screen', scope(), () => { admissions++; return true; });
  for (let index = 0; index < 520; index++) bus.send('x', {}, {}, scope()); assert.equal(admissions, 512);
  await delay(55);
});
await check('registration count is bounded and cleanup releases capacity without removing newer listeners', () => {
  const bus = new ComponentMessageBus(), removals = [];
  for (let index = 0; index < 4096; index++) removals.push(bus.register('x', 'screen', scope(), () => true));
  assert.throws(() => bus.register('x', 'screen', scope(), () => true), /4,096/);
  removals[0](); bus.register('x', 'screen', scope(), () => true); removals[0]();
  assert.throws(() => bus.register('x', 'screen', scope(), () => true), /4,096/); bus.reset();
});
await check('real JavaScript handlers can send a named message with frozen payload through the same event executor', async () => {
  const env = environment(), received = [];
  const sender = component('sender', [], {mount: {language: 'javascript', code: 'app.sendMessage("refresh", {value: 42}, {scope: "screen"});'}});
  const receiver = component('receiver', [handler('h', 'screen', 'if (!Object.isFrozen(event.payload)) throw new Error("mutable"); app.notify(String(event.payload.value));')]);
  const target = mount(context(env, receiver)); const source = mount(context(env, sender));
  await source.whenIdle(); await target.whenIdle(); received.push(...env.coordinator.snapshot().diagnostics.map(item => item.message));
  assert.deepEqual(received, ['42']); await dispose(source, target);
});
await check('gateway injection reaches exact session listeners across forms and preserves server correlation', () => {
  const bus = new ComponentMessageBus(), received = [];
  for (const [name, location] of [['main', scope('main', 'row-a')], ['row', scope('main', 'row-b')], ['popup', scope('popup', 'row-a')]])
    for (const listening of ['instance', 'screen', 'session']) bus.register('refresh', listening, location, event => { received.push({name, event}); return true; });
  const payload = {nested:{quantity:4}}, receipt = bus.receiveSessionMessage('gateway-1','refresh',payload); payload.nested.quantity=8;
  assert.deepEqual(receipt,{messageId:'gateway-1',accepted:3}); assert.deepEqual(received.map(item=>item.name),['main','row','popup']);
  assert.ok(received.every(item=>item.event.scope==='session'&&item.event.messageId==='gateway-1'&&item.event.payload.nested.quantity===4&&Object.isFrozen(item.event.payload.nested)));
  assert.notEqual(received[0].event.payload,received[1].event.payload);assert.equal(bus.receiveSessionMessage('gateway-1','refresh',{quantity:9}).accepted,0);
});
await check('gateway duplicate suppression has no listener replay and invalid payloads do not consume IDs', () => {
  const bus=new ComponentMessageBus();assert.equal(bus.receiveSessionMessage('before-mount','refresh',{}).accepted,0);let hits=0;
  bus.register('refresh','session',scope(),()=>{hits++;return true;});assert.equal(bus.receiveSessionMessage('before-mount','refresh',{}).accepted,0);assert.equal(hits,0);
  assert.throws(()=>bus.receiveSessionMessage('retry-id','refresh',[]));assert.equal(bus.receiveSessionMessage('retry-id','refresh',{}).accepted,1);
  for(const bad of ['', 'x'.repeat(129), 'bad\nidentity', null])assert.throws(()=>bus.receiveSessionMessage(bad,'refresh',{}),/identifier/);
  assert.throws(()=>bus.receiveSessionMessage('id',' padded',{}),/Message type/);
  bus.reset();bus.register('refresh','session',scope(),()=>true);assert.equal(bus.receiveSessionMessage('retry-id','refresh',{}).accepted,1);
});
await check('gateway events execute saved handler code in receiving context and cancel after closure', async () => {
  const env=environment(),events=[],gate=deferred(),started=deferred();let runs=0;
  const target=component('target',[handler('published','session','saved-code')]);
  const life=mount(context(env,target,scope(),{inputs:{quantity:3},parameters:{station:'A'}}),async(script,event,inputs,parameters)=>{runs++;events.push({script,event,inputs,parameters});started.resolve();if(runs===1)await gate.promise;});
  assert.equal(env.bus.receiveSessionMessage('gateway-one','refresh',{code:'attacker-code',quantity:88}).accepted,1);
  await started.promise;assert.equal(env.bus.receiveSessionMessage('gateway-two','refresh',{}).accepted,1);life.deactivate();gate.resolve();await life.whenIdle();
  assert.equal(runs,1);assert.equal(events[0].script.code,'saved-code');assert.equal(events[0].event.payload.code,'attacker-code');assert.deepEqual(events[0].inputs,{quantity:3});assert.deepEqual(events[0].parameters,{station:'A'});
  assert.equal(env.bus.receiveSessionMessage('gateway-closed','refresh',{}).accepted,0);
});
await check('gateway deliveries use existing admission and rate budgets', () => {
  let admissions=0;const bus=new ComponentMessageBus({accept:()=>++admissions<=1});bus.register('refresh','session',scope(),()=>true);bus.register('refresh','session',scope('popup'),()=>true);
  assert.equal(bus.receiveSessionMessage('budget-one','refresh',{}).accepted,1);assert.equal(admissions,2);
  const limited=new ComponentMessageBus();let hits=0;limited.register('refresh','session',scope(),()=>{hits++;return true;});for(let i=0;i<520;i++)limited.receiveSessionMessage(`gateway-${i}`,'refresh',{});assert.equal(hits,512);
});
await check('read-only Preview does not accept gateway-injected authored behavior', () => {
  const bus=new ComponentMessageBus();let hits=0;bus.register('refresh','session',scope(),()=>{hits++;return true;});
  setPreviewRequestContext({token:'fixture',mode:'read-only',expiresAt:new Date(Date.now()+60000).toISOString()});
  try {assert.deepEqual(bus.receiveSessionMessage('gateway-preview','refresh',{}),{messageId:'',accepted:0});assert.equal(hits,0);}finally{setPreviewRequestContext(null,false);}
});
await check('retained inactive panes unregister messages and never revive queued or captured message authority', async () => {
  const env = environment(), seen = [], effects = [], started = deferred(), target = component('retained', [handler('session', 'session')]);
  const ctx = context(env, target, scope(), { setInput: (...args) => effects.push(args) });
  let oldApp;
  const life = mount(ctx, (_script, event, _inputs, _parameters, app) => {
    seen.push(event.payload.order);
    if (event.payload.order === 1) { oldApp = app; started.resolve(); return new Promise(() => {}); }
  });
  const send = order => env.bus.receiveSessionMessage('retained-' + order, 'refresh', { order });
  assert.equal(send(1).accepted, 1); await started.promise; assert.equal(send(2).accepted, 1);
  life.prepare({ ...ctx, suspended: true }); life.commit();
  assert.equal(oldApp.signal.aborted, true); assert.equal(send(3).accepted, 0);
  life.prepare(ctx); life.commit(); oldApp.notify('obsolete');
  assert.equal(oldApp.sendMessage('refresh', { order: 99 }, { scope: 'session' }).accepted, 0);
  assert.equal(send(4).accepted, 1); await life.whenIdle();
  assert.deepEqual(seen, [1, 4]); assert.deepEqual(effects, []); assert.deepEqual(env.coordinator.snapshot().diagnostics, []);
  await dispose(life); assert.equal(send(5).accepted, 0);
});
console.log(`${passed} component-message checks passed.`);
