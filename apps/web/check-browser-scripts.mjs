import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('./src/browserScriptModel.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { BrowserScriptLifecycle } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const resources = [
  { id: 'start', name: 'Start', event: 'startup', code: '', parameters: { greeting: 'hello' } },
  { id: 'open', name: 'Open', event: 'screenOpen', code: '', parameters: {} },
];
const publication = (revision = 1) => ({ revision, publishedAt: `publication-${revision}`, resources });
const context = (screenId = 'A', effects = [], projectKey = 'project-1') => ({ projectKey, screenId, screenName: `Screen ${screenId}`, notify: message => effects.push(['notify', message]), navigate: id => effects.push(['navigate', id]), refresh: () => effects.push(['refresh']) });
const defer = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const mount = execute => { const runner = new BrowserScriptLifecycle(execute); runner.activate(); return runner; };
await test('startup precedes screen-open and rerenders do not duplicate events', async () => {
  const events = [];
  const runner = mount((resource, event) => events.push(`${resource.id}:${event.screenId}`));
  runner.setContext(context()); runner.update(publication()); await runner.whenIdle();
  runner.setContext(context()); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(events, ['start:A', 'open:A']);
});
await test('old queued screen-open is skipped after asynchronous startup navigates away', async () => {
  const pending = defer(); const events = [];
  const runner = mount(async (resource, event) => { events.push(`${resource.id}:${event.screenId}`); if (resource.id === 'start') await pending.promise; });
  runner.setContext(context()); runner.update(publication()); const oldQueue = runner.whenIdle(); await Promise.resolve();
  runner.setContext(context('B')); runner.update(publication()); await runner.whenIdle();
  pending.resolve(); await oldQueue;
  assert.deepEqual(events, ['start:A', 'open:B']);
});
await test('helper effects become inert immediately when screen context changes', async () => {
  const effects = []; let oldApp;
  const runner = mount((_resource, _event, _parameters, app) => { oldApp = app; });
  runner.setContext(context('A', effects)); runner.update(publication()); await runner.whenIdle();
  runner.setContext(context('B', effects)); // no effect/update needed for invalidation
  oldApp.notify('stale'); oldApp.navigate('C'); oldApp.refresh();
  assert.deepEqual(effects, []);
});
await test('unresolved old code does not block a new script publication', async () => {
  const events = []; const effects = []; let oldApp;
  const runner = mount((_resource, event, _parameters, app) => { events.push(event.revision); if (event.revision === 1) { oldApp = app; return new Promise(() => {}); } });
  runner.setContext(context('A', effects)); runner.update(publication()); await Promise.resolve();
  runner.update(publication(2)); await runner.whenIdle();
  oldApp.notify('old version'); oldApp.navigate('B'); oldApp.refresh();
  assert.deepEqual(events, [1, 2, 2]);
  assert.deepEqual(effects, []);
});
await test('unmounted handlers and their rejected promises cannot produce effects', async () => {
  const pending = defer(); const effects = []; let app;
  const runner = mount(async (_resource, _event, _parameters, helper) => { app = helper; await pending.promise; throw new Error('late failure'); });
  runner.setContext(context('A', effects)); runner.update(publication()); const queue = runner.whenIdle(); await Promise.resolve();
  runner.deactivate(); app.notify('late'); app.navigate('B'); app.refresh(); pending.resolve(); await queue;
  assert.deepEqual(effects, []);
});
await test('loading a new project snapshot reopens its screen without rerunning client startup', async () => {
  const events = []; const runner = mount((resource, event) => events.push(`${resource.id}:${event.screenId}`));
  runner.setContext(context()); runner.update(publication()); await runner.whenIdle();
  runner.setContext(context('A', [], 'project-2')); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(events, ['start:A', 'open:A', 'open:A']);
});
await test('current handler failures are reported and do not poison later events', async () => {
  const effects = []; const events = [];
  const runner = mount(resource => { events.push(resource.id); if (resource.id === 'start') throw new Error('bad code'); });
  runner.setContext(context('A', effects)); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(events, ['start', 'open']);
  assert.deepEqual(effects, [['notify', 'Start: bad code']]);
});
await test('resource parameter edits cannot mutate the published defaults and session persists between events', async () => {
  const values = []; const runner = mount((resource, _event, parameters, _app, session) => { session.runs = (session.runs ?? 0) + 1; parameters.greeting = 'edited'; values.push(session.runs); });
  runner.setContext(context()); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(values, [1, 2]); assert.equal(resources[0].parameters.greeting, 'hello');
});
await test('state helpers delegate typed reads, writes and property or scope resets without changing legacy session memory', async () => {
  const calls = []; const state = { get: (...args) => { calls.push(['get', ...args]); return 17; }, set: (...args) => calls.push(['set', ...args]), reset: (...args) => calls.push(['reset', ...args]) };
  const legacy = []; const runner = mount((resource, _event, _parameters, app, session) => {
    session.visits = (session.visits ?? 0) + 1; legacy.push(session.visits);
    if (resource.id !== 'start') return;
    assert.equal(app.state.get('screen', 'quantity'), 17);
    app.state.set('session', 'selectedAsset', 'pump-1'); app.state.reset('screen', 'quantity'); app.state.reset('session');
  });
  runner.setContext({ ...context(), scopeKey: 'account-A:screen-A:visit-1', state }); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(calls, [['get', 'screen', 'quantity'], ['set', 'session', 'selectedAsset', 'pump-1'], ['reset', 'screen', 'quantity'], ['reset', 'session', undefined]]);
  assert.deepEqual(legacy, [1, 2]);
});
await test('state validation failures report against the script and later handlers still run', async () => {
  const effects = []; const events = [];
  const state = { get() { throw new Error('State property missing is not declared.'); }, set() { throw new Error('State quantity requires a number.'); }, reset() {} };
  const runner = mount((resource, _event, _parameters, app) => { events.push(resource.id); if (resource.id === 'start') app.state.set('screen', 'quantity', 'bad'); else assert.throws(() => app.state.get('session', 'missing'), /not declared/); });
  runner.setContext({ ...context('A', effects), state }); runner.update(publication()); await runner.whenIdle();
  assert.deepEqual(events, ['start', 'open']); assert.deepEqual(effects, [['notify', 'Start: State quantity requires a number.']]);
});
await test('missing state context is explicit while legacy scripts continue without state', async () => {
  let app; const runner = mount((_resource, _event, _parameters, helper) => { app = helper; });
  runner.setContext(context()); runner.update(publication()); await runner.whenIdle();
  for (const call of [() => app.state.get('session', 'name'), () => app.state.set('screen', 'name', 'x'), () => app.state.reset('screen')]) assert.throws(call, /state is unavailable/);
});
await test('leaving and returning to the same screen before effects cannot resurrect old state helpers', async () => {
  const effects = []; const apps = []; const events = []; const state = { get: () => 'current', set: (...args) => effects.push(args), reset: (...args) => effects.push(args) };
  const runner = mount((resource, _event, _parameters, app) => { apps.push(app); events.push(resource.id); });
  const ctx = { ...context('A', effects), state, scopeKey: 'visit-1' };
  runner.setContext(ctx); runner.update(publication()); await runner.whenIdle(); const old = apps[0];
  runner.setContext({ ...ctx, screenId: 'B' }); runner.setContext(ctx);
  assert.equal(old.state.get('session', 'name'), undefined); old.state.set('session', 'name', 'stale'); old.state.reset('screen'); old.notify('stale');
  assert.deepEqual(effects, []);
  runner.update(publication()); await runner.whenIdle(); assert.deepEqual(events, ['start', 'open', 'open']);
});
await test('popup, account and publication scope changes expire captured async helpers before the next event', async () => {
  for (const change of ['popup', 'account', 'publication', 'unmount']) {
    const effects = []; let old; const state = { get: () => 7, set: (...args) => effects.push(args), reset: (...args) => effects.push(args) };
    const runner = mount((_resource, _event, _parameters, app) => { if (!old) { old = app; return new Promise(() => {}); } });
    const ctx = { ...context('A', effects), state, scopeKey: 'account-A:screen-A' };
    runner.setContext(ctx); runner.update(publication()); await Promise.resolve();
    if (change === 'publication') runner.update(publication(2));
    else if (change === 'unmount') runner.deactivate();
    else runner.setContext({ ...ctx, scopeKey: change === 'popup' ? 'account-A:popup-1' : 'account-B:screen-A' });
    assert.equal(old.state.get('screen', 'quantity'), undefined, change); old.state.set('session', 'quantity', 99); old.state.reset('session');
    assert.deepEqual(effects, [], change);
  }
});
await test('same-scope rerenders use the current state API without rerunning lifecycle scripts', async () => {
  let app; const events = []; const runner = mount((resource, _event, _parameters, helper) => { app = helper; events.push(resource.id); });
  const ctx = { ...context(), scopeKey: 'A', state: { get: () => 1, set() {}, reset() {} } };
  runner.setContext(ctx); runner.update(publication()); await runner.whenIdle();
  runner.setContext({ ...ctx, state: { get: () => 2, set() {}, reset() {} } }); runner.update(publication()); await runner.whenIdle();
  assert.equal(app.state.get('screen', 'count'), 2); assert.deepEqual(events, ['start', 'open']);
});
console.log(`${passed}/${passed} browser scripting lifecycle checks passed.`);
