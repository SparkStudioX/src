import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the same lifetime-aware helpers used by runtime buttons and browser scripts.
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = new URL(`src/${name}.ts`, import.meta.url);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText.replace(/from (["'])\.\/([^"']+)\1/g, (_, _quote, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); cache.set(name, url); return url;
}
const { ApplicationStateStore } = await import(load('applicationStateModel'));
const { InputEventLifecycle } = await import(load('inputEvents'));
const { BrowserScriptLifecycle } = await import(load('browserScriptModel'));
const { setPreviewRequestContext } = await import(load('previewRequest'));
let checks = 0;
async function check(name, run) { await run(); console.log(`PASS ${name}`); checks++; }
function fixture() {
  const store = new ApplicationStateStore(); store.configure('project');
  const screen = store.activateScreen('home');
  const received = [];
  store.componentMessages.register('changed', 'session', { screenKey: screen.key, instanceKey: screen.key }, event => { received.push(event); return true; });
  return { store, screen, received, context: store.context(screen) };
}
await check('button sender inherits all parent lifetimes and never revives after close/reopen', () => {
  const { store, screen, received } = fixture();
  const parent = store.createScope('outer'), child = store.createScope('inner');
  const context = store.context(screen, child, [parent]);
  assert.equal(context.sendMessage('changed', { text: 'active' }, { scope: 'session' }).accepted, 1);
  store.closeScope(parent);
  assert.equal(context.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  store.resumeScope(parent);
  assert.equal(context.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  const fresh = store.context(screen, child, [parent]);
  assert.equal(fresh.sendMessage('changed', {}, { scope: 'session' }).accepted, 1);
  store.suspend(); store.resume();
  assert.equal(fresh.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  assert.equal(received.length, 2);
});
await check('input JavaScript sends payloads, and captured helpers expire on control change or scope closure', async () => {
  const { store, screen, context, received } = fixture(); let captured;
  const component = { id: 'input', type: 'textInput', x: 0, y: 0, width: 200, height: 40,
    props: { fieldKey: 'text', events: { change: { language: 'javascript', code: "app.sendMessage('changed', {text:event.value}, {scope:'session'});" } } } };
  const runner = new InputEventLifecycle((script, event, inputs, parameters, app) => {
    captured = app;
    return new Function('event', 'inputs', 'parameters', 'app', script.code)(event, inputs, parameters, app);
  });
  const input = { key: 'one', component, components: [component], inputs: { text: '' }, parameters: {},
    setInput() {}, notify() {}, error(message) { throw new Error(message); }, sendMessage: context.sendMessage };
  runner.activate(); runner.setContext(input, ''); runner.change('Updated'); await runner.whenIdle();
  assert.equal(received[0].payload.text, 'Updated');
  runner.setContext({ ...input, key: 'two' }, '');
  assert.equal(captured.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  runner.change('Second'); await runner.whenIdle();
  store.closeScope(screen);
  assert.equal(captured.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  assert.equal(received.length, 2); runner.deactivate();
});
await check('published browser scripts send locally and stale publication helpers cannot reach a new run', async () => {
  const { store, context, received } = fixture(); let captured;
  const runner = new BrowserScriptLifecycle((_resource, event, _parameters, app) => {
    captured = app; app.sendMessage('changed', { event: event.type }, { scope: 'session' });
  });
  runner.activate(); runner.setContext({ projectKey: 'project', screenId: 'home', screenName: 'Home',
    notify() {}, navigate() {}, refresh() {}, scopeKey: context.key, sendMessage: context.sendMessage });
  runner.update({ revision: 1, resources: [{ id: 'open', name: 'Open', event: 'screenOpen', code: 'send', parameters: {} }] });
  await runner.whenIdle(); assert.equal(received[0].payload.event, 'screenOpen');
  const old = captured;
  runner.update({ revision: 2, resources: [] }); await runner.whenIdle();
  assert.equal(old.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  store.configure('another-project');
  assert.equal(context.sendMessage('changed', {}, { scope: 'session' }).accepted, 0);
  assert.equal(received.length, 1); runner.deactivate();
});
await check('native and scripted senders respect read-only Preview and remain isolated across tabs', () => {
  const first = fixture(), second = fixture();
  setPreviewRequestContext({ token: 'fixture', mode: 'read-only', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  try { assert.equal(first.context.sendMessage('changed', {}, { scope: 'session' }).accepted, 0); }
  finally { setPreviewRequestContext(null, false); }
  assert.equal(first.context.sendMessage('changed', {}, { scope: 'session' }).accepted, 1);
  assert.equal(first.received.length, 1); assert.equal(second.received.length, 0);
});
console.log(`${checks}/${checks} component message helper checks passed.`);
