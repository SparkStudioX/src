import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
function loader(hookModule) {
  const modules = new Map();
  return function url(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(value => fs.existsSync(value));
    assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' && hookModule && name === 'applicationState' ? hookModule : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = asModule(code); modules.set(name, result); return result;
  };
}
const url = loader();
const { ApplicationStateStore, stateDefinitionsError, stateDefaults, stateKeyValid } = await import(url('applicationStateModel'));
const { evaluateComponentBindings, validatePropertyBinding } = await import(url('propertyBindings'));
const { default: BoundComponent } = await import(url('BoundComponent'));
const { ApplicationStateProvider, useApplicationState } = await import(url('applicationState'));
const { ProjectComponentView } = await import(url('templates'));
const { runtimeBindingHealth } = await import(url('runtimeQuality'));
const { BrowserScriptLifecycle } = await import(url('browserScriptModel'));
const session = { selectedAsset: { type: 'string', value: 'P-101' }, count: { type: 'number', value: 0 }, running: { type: 'boolean', value: false } };
const screen = { quantity: { type: 'number', value: 3 }, message: { type: 'string', value: 'Ready' }, expanded: { type: 'boolean', value: true } };
function owner(key = 'project-1:publication-1') { const store = new ApplicationStateStore(); store.configure(key, session); const scope = store.activateScreen('main', screen); return { store, scope, api: store.context(scope).api }; }
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check('schema accepts bounded scalar defaults and creates independent default maps', () => {
  const definitions = { text: { type: 'string', value: 'x'.repeat(4096) }, decimal: { type: 'number', value: 0.125 }, max: { type: 'number', value: Number.MAX_SAFE_INTEGER }, enabled: { type: 'boolean', value: true } };
  assert.equal(stateDefinitionsError(definitions), null); assert.deepEqual(stateDefaults(undefined), {});
  const first = stateDefaults(definitions); first.text = 'edited'; assert.equal(stateDefaults(definitions).text.length, 4096);
  assert.equal(stateDefinitionsError(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`key${i}`, { type: 'number', value: i }]))), null);
});
await check('schema rejects malformed names, trailing newline, unexpected fields and invalid numeric or text values', () => {
  for (const name of ['', '1first', 'with.dot', 'with space', 'first\n', 'first\r', 'first\r\n', ' first', 'last ', '__proto__', 'constructor', 'prototype', 'x'.repeat(65)]) assert.equal(stateKeyValid(name), false, JSON.stringify(name));
  assert.equal(stateKeyValid('_valid_1'), true); assert.equal(stateKeyValid('x'.repeat(64)), true);
  for (const value of [null, [], false, { x: null }, { x: { type: 'string', value: 4 } }, { x: { type: 'number', value: NaN } }, { x: { type: 'number', value: Infinity } }, { x: { type: 'number', value: Number.MAX_SAFE_INTEGER + 1 } }, { x: { type: 'string', value: 'x'.repeat(4097) } }, { x: { type: 'boolean', value: 'true' } }, { x: { type: 'array', value: [] } }, { x: { type: 'number' } }, { x: { type: 'number', value: 0, secret: true } }, JSON.parse('{"__proto__":{"type":"string","value":"x"}}'), { 'x\n': { type: 'number', value: 0 } }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x${i}`, { type: 'number', value: 0 }]))]) assert.ok(stateDefinitionsError(value), JSON.stringify(value));
});
await check('sets enforce declared types and bounds without coercion or partial updates', () => {
  const { api } = owner();
  for (const value of ['3', null, NaN, Infinity, {}, [], Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => api.set('screen', 'quantity', value));
  assert.throws(() => api.set('session', 'running', 'true')); assert.throws(() => api.set('session', 'selectedAsset', 'x'.repeat(4097)));
  api.set('screen', 'quantity', -0.125); api.set('session', 'running', true);
  assert.equal(api.get('screen', 'quantity'), -0.125); assert.equal(api.get('session', 'running'), true);
  for (const call of [() => api.get('screen', 'missing'), () => api.set('screen', 'missing', 1), () => api.reset('session', 'missing'), () => api.get('account', 'count'), () => api.reset('account')]) assert.throws(call);
  assert.equal(api.get('session', 'count'), 0);
});
await check('reactive snapshots are immutable and notify only for changed values', () => {
  const { store, scope, api } = owner(); const before = store.context(scope).values; let events = 0;
  const unsubscribe = store.subscribe(() => events++);
  api.set('screen', 'quantity', 4); api.set('screen', 'quantity', 4); api.set('session', 'count', 1);
  const after = store.context(scope).values;
  assert.equal(events, 2); assert.equal(before.screen.quantity, 3); assert.equal(after.screen.quantity, 4); assert.equal(after.session.count, 1);
  assert.ok(Object.isFrozen(after.screen)); assert.ok(Object.isFrozen(after.session));
  assert.throws(() => { after.screen.quantity = 99; }); unsubscribe(); api.set('session', 'count', 2); assert.equal(events, 2);
});
await check('reset restores one property or its whole scope and leaves the other scope untouched', () => {
  const { store, scope, api } = owner(); let events = 0; store.subscribe(() => events++);
  api.set('screen', 'quantity', 7); api.set('screen', 'message', 'Draft'); api.set('session', 'count', 5);
  api.reset('screen', 'quantity'); assert.equal(api.get('screen', 'quantity'), 3); assert.equal(api.get('screen', 'message'), 'Draft');
  api.reset('screen'); assert.deepEqual(store.context(scope).values.screen, stateDefaults(screen)); assert.equal(api.get('session', 'count'), 5);
  api.reset('session'); assert.equal(api.get('session', 'count'), 0); const count = events;
  api.reset('screen'); api.reset('session', 'count'); assert.equal(events, count + 2, 'explicit resets notify bound drafts even when accepted values match defaults');
});
await check('same-screen rerenders retain state; navigation preserves session but starts fresh screen state', () => {
  const { store, scope, api } = owner(); api.set('screen', 'quantity', 8); api.set('session', 'count', 4);
  assert.equal(store.activateScreen('main', structuredClone(screen)), scope);
  const other = store.activateScreen('other', screen); assert.notEqual(other.key, scope.key);
  assert.equal(api.get('session', 'count'), undefined); api.set('session', 'count', 99);
  assert.equal(store.context(other).api.get('session', 'count'), 4); assert.equal(store.context(other).api.get('screen', 'quantity'), 3);
  const back = store.activateScreen('main', screen); assert.equal(store.context(back).api.get('screen', 'quantity'), 3);
});
await check('new project, publication, account run or session schema resets both scopes and expires captured APIs', () => {
  for (const key of ['project-2:publication-1', 'project-1:publication-2', 'account-2:project-1']) {
    const { store, scope, api } = owner(); api.set('session', 'count', 4); api.set('screen', 'quantity', 8);
    store.configure(key, session); api.set('session', 'count', 99); api.reset('screen'); assert.equal(api.get('session', 'count'), undefined);
    const current = store.activateScreen('main', screen); assert.notEqual(current.key, scope.key); assert.equal(store.context(current).api.get('session', 'count'), 0);
  }
  const { store, api } = owner(); api.set('session', 'count', 4); const definitions = structuredClone(session); definitions.count.value = 9;
  store.configure('project-1:publication-1', definitions); const current = store.activateScreen('main', screen); assert.equal(store.context(current).api.get('session', 'count'), 9);
});
await check('separate tabs have independent state and foreign handles cannot be resumed', () => {
  const a = owner(); const b = owner(); a.api.set('session', 'count', 5); assert.equal(b.api.get('session', 'count'), 0);
  b.store.resumeScope(a.scope); const foreign = b.store.context(a.scope); foreign.api.set('session', 'count', 99); assert.equal(foreign.api.get('session', 'count'), undefined); assert.equal(b.api.get('session', 'count'), 0);
});
await check('each popup has separate screen state and shares the parent session without changing parent screen values', () => {
  const { store, scope, api } = owner(); const a = store.createScope('detail:1', screen); const b = store.createScope('detail:2', screen);
  const first = store.context(a).api; const second = store.context(b).api;
  first.set('screen', 'quantity', 11); first.set('session', 'selectedAsset', 'P-202');
  assert.equal(second.get('screen', 'quantity'), 3); assert.equal(api.get('screen', 'quantity'), 3); assert.equal(api.get('session', 'selectedAsset'), 'P-202');
  assert.equal(store.context(scope).values.session.selectedAsset, 'P-202');
  store.closeScope(a); first.set('session', 'selectedAsset', 'stale'); assert.equal(first.get('screen', 'quantity'), undefined); assert.equal(second.get('session', 'selectedAsset'), 'P-202');
  const reopened = store.createScope('detail:1', screen); assert.equal(store.context(reopened).api.get('screen', 'quantity'), 3);
});
await check('closed scopes can resume for StrictMode but their old APIs never regain authority', () => {
  const { store, api } = owner(); const popup = store.createScope('detail', screen); const previous = store.context(popup).api;
  store.closeScope(popup); store.resumeScope(popup); previous.set('session', 'count', 99); assert.equal(previous.get('session', 'count'), undefined);
  store.context(popup).api.set('session', 'count', 2); assert.equal(api.get('session', 'count'), 2);
  store.activateScreen('other', screen); store.resumeScope(popup); assert.equal(store.context(popup).api.get('session', 'count'), undefined);
});
await check('owner suspension expires API captures across resumed mounts without silently changing state', () => {
  const { store, scope, api } = owner(); api.set('session', 'count', 4); store.suspend(); api.set('session', 'count', 99); assert.equal(api.get('session', 'count'), undefined);
  store.resume(); assert.equal(api.get('session', 'count'), undefined); const fresh = store.context(scope).api; assert.equal(fresh.get('session', 'count'), 4);
  fresh.set('session', 'count', 6); assert.equal(store.context(scope).values.session.count, 6);
});
await check('invalid new definitions preserve the current project, screen and API', () => {
  const { store, scope, api } = owner(); api.set('session', 'count', 2); api.set('screen', 'quantity', 6);
  assert.throws(() => store.configure('bad-project', { count: { type: 'number', value: 'bad' } }));
  assert.throws(() => store.activateScreen('bad-screen', { quantity: { type: 'number', value: null } }));
  assert.equal(store.activateScreen('main', screen), scope); assert.equal(api.get('session', 'count'), 2); assert.equal(api.get('screen', 'quantity'), 6);
});
const component = { id: 'status', type: 'label', x: 0, y: 0, width: 250, height: 80, props: { text: 'Fallback', bindings: {
  text: { expression: 'asset + ": " + (count > 5 ? "High" : "Low")', references: { asset: { kind: 'sessionState', key: 'selectedAsset' }, count: { kind: 'screenState', key: 'quantity' } } },
  visible: { expression: 'expanded', references: { expanded: { kind: 'screenState', key: 'expanded' } } },
} } };
await check('fx state references consume fresh typed values and work while gateway communication is offline', () => {
  const { store, scope, api } = owner();
  const evaluate = () => evaluateComponentBindings(component, { components: [component], parameters: {}, inputs: {}, tags: [], state: store.context(scope).values, communicationLost: true });
  let result = evaluate(); assert.deepEqual(result.errors, {}); assert.equal(result.component.props.text, 'P-101: Low');
  api.set('session', 'selectedAsset', 'P-202'); api.set('screen', 'quantity', 7); api.set('screen', 'expanded', false);
  result = evaluate(); assert.equal(result.component.props.text, 'P-202: High'); assert.equal(result.component.props.visible, false); assert.equal(component.props.text, 'Fallback');
});
await check('fx missing declarations and malformed state references fail visibly without inherited-object values', () => {
  const ctx = { components: [component], parameters: {}, inputs: {}, tags: [] };
  const result = evaluateComponentBindings(component, ctx); assert.match(result.errors.text, /not declared/); assert.equal(result.component.props.text, 'Binding error');
  for (const key of ['__proto__', 'constructor', 'x\n', 'x.y', ' ']) assert.ok(validatePropertyBinding({ expression: 'value', references: { value: { kind: 'sessionState', key } } }), JSON.stringify(key));
  const inherited = Object.create({ selectedAsset: 'forged' }); const failure = evaluateComponentBindings(component, { ...ctx, state: { session: inherited, screen: { quantity: 3, expanded: true } } }); assert.match(failure.errors.text, /not declared/);
});
await check('real React provider supplies screen defaults to bound rendering without running browser events', () => {
  const project = { id: 'plant', revision: 1, sessionState: session, screens: [{ id: 'main', state: screen }] };
  function Scene() { const state = useApplicationState(project, project.screens[0], 'preview'); return React.createElement(ApplicationStateProvider, { value: state }, React.createElement(BoundComponent, { component, components: [component], tags: [], parameters: {}, inputs: {}, preview: true, onNavigate() {} })); }
  const html = renderToStaticMarkup(React.createElement(Scene)); assert.match(html, /P-101: Low/); assert.doesNotMatch(html, /Binding error|Fallback/);
});
await check('template wrappers and leaves inherit their containing screen state, including geometry and popup overrides', () => {
  const { store, scope, api } = owner();
  const leaf = { ...component, props: { ...component.props, bindings: { ...component.props.bindings, x: { expression: 'amount * 10', references: { amount: { kind: 'screenState', key: 'quantity' } } } } } };
  const template = { id: 'card', name: 'State card', width: 300, height: 100, parameters: {}, components: [leaf] };
  const instance = { id: 'instance', type: 'template', x: 0, y: 0, width: 300, height: 100, props: { templateId: 'card', parameters: {}, bindings: { text: { expression: 'name', references: { name: { kind: 'sessionState', key: 'selectedAsset' } } } } } };
  const render = target => renderToStaticMarkup(React.createElement(ApplicationStateProvider, { value: { ...store.context(target), store } }, React.createElement(ProjectComponentView, { component: instance, components: [instance], templates: [template], tags: [], parameters: {}, inputs: {}, screenId: 'main', preview: true, onNavigate() {} })));
  const main = render(scope); assert.match(main, /aria-label="P-101"/); assert.match(main, /P-101: Low/); assert.match(main, /left:30px/);
  const popup = store.createScope('popup:1', { ...screen, quantity: { type: 'number', value: 9 } });
  const overlay = render(popup); assert.match(overlay, /P-101: High/); assert.match(overlay, /left:90px/); assert.equal(api.get('screen', 'quantity'), 3);
});
await check('health uses the same state values as main-screen and saved-template rendering', () => {
  const { store, scope } = owner(); const state = store.context(scope).values;
  const main = { id: 'main', name: 'Main', width: 800, height: 600, components: [component] };
  assert.deepEqual(runtimeBindingHealth(main, [], [], {}, {}, false, state), { badCount: 0, simulated: false });
  assert.equal(runtimeBindingHealth(main, [], [], {}, {}, false).badCount, 1);
  const template = { ...main, id: 'card', parameters: {}, components: [component] };
  const host = { ...main, components: [{ id: 'instance', type: 'template', x: 0, y: 0, width: 300, height: 100, props: { templateId: 'card', parameters: {} } }] };
  assert.equal(runtimeBindingHealth(host, [template], [], {}, {}, false, state).badCount, 0);
  assert.equal(runtimeBindingHealth(host, [template], [], {}, {}, false, { session: state.session, screen: {} }).badCount, 1);
});
await check('actual state updates from startup reach screenOpen and navigation expires previous script captures', async () => {
  const { store, scope } = owner(); const events = []; let first;
  const runner = new BrowserScriptLifecycle((resource, _event, _parameters, app) => {
    if (!first) first = app;
    if (resource.event === 'startup') app.state.set('session', 'count', 6);
    else { events.push(app.state.get('session', 'count')); app.state.set('screen', 'quantity', 7); }
  });
  const context = target => ({ projectKey: 'project:1', screenId: target.sourceKey, screenName: 'Main', scopeKey: target.key, state: store.context(target).api, notify() {}, navigate() {}, refresh() {} });
  const publication = { revision: 1, publishedAt: 'scripts:1', resources: [{ id: 'start', name: 'Start', event: 'startup', parameters: {}, code: '' }, { id: 'open', name: 'Open', event: 'screenOpen', parameters: {}, code: '' }] };
  runner.activate(); runner.setContext(context(scope)); runner.update(publication); await runner.whenIdle();
  assert.deepEqual(events, [6]); assert.equal(store.context(scope).api.get('screen', 'quantity'), 7);
  const next = store.activateScreen('second', screen); runner.setContext(context(next)); first.state.set('session', 'count', 99);
  runner.update(publication); await runner.whenIdle(); assert.deepEqual(events, [6, 6]); assert.equal(store.context(next).api.get('session', 'count'), 6); runner.deactivate();
});

// Exercise effect cleanup/setup directly to cover the stale API contract that
// SSR cannot observe. The hook bodies and state model are unchanged.
const hookModule = asModule(`export * from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
export const useRef = value => globalThis.__applicationStateHooks.useRef(value);
export const useState = value => globalThis.__applicationStateHooks.useState(value);
export const useEffect = (setup,deps) => globalThis.__applicationStateHooks.useEffect(setup,deps);`);
const hookUrl = loader(hookModule);
const hooks = await import(hookUrl('applicationState'));
function harness() {
  const slots = []; let index = 0; const effects = [];
  return {
    useRef(value) { const at = index++; return slots[at] ??= { current: value }; },
    useState(value) { const at = index++; if (!(at in slots)) slots[at] = typeof value === 'function' ? value() : value; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }]; },
    useEffect(setup, deps) { const at = index++; const old = slots[at]; if (!old || deps.some((item, i) => !Object.is(item, old.deps[i]))) { old?.cleanup?.(); const effect = { setup, deps, cleanup: undefined }; slots[at] = effect; effects.push(effect); } },
    render(fn) { index = 0; globalThis.__applicationStateHooks = this; return fn(); },
    mount() { for (const effect of effects) if (!effect.cleanup) effect.cleanup = effect.setup(); },
    cleanup() { for (const effect of effects) { effect.cleanup?.(); effect.cleanup = undefined; } },
  };
}
await check('owner hook cleanup and StrictMode setup keep old APIs expired and refresh the current context', () => {
  const h = harness(); const project = { id: 'plant', sessionState: session }; const active = { id: 'main', state: screen };
  const render = () => h.render(() => hooks.useApplicationState(project, active, 'preview-run'));
  const before = render(); h.mount(); before.api.set('session', 'count', 5); h.cleanup(); assert.equal(before.api.get('session', 'count'), undefined);
  h.mount(); const after = render(); assert.equal(after.api.get('session', 'count'), 5); assert.equal(before.api.get('session', 'count'), undefined);
  h.cleanup(); assert.equal(after.api.get('screen', 'quantity'), undefined);
});
await check('popup hook switches parent stores and removing its parent synchronously expires old helpers', () => {
  const a = owner(); const b = owner(); const parent = value => ({ ...value.store.context(value.scope), store: value.store }); const h = harness();
  const first = h.render(() => hooks.usePopupApplicationState(parent(a), 'popup', screen)); h.mount(); first.api.set('screen', 'quantity', 9);
  const second = h.render(() => hooks.usePopupApplicationState(parent(b), 'popup', screen)); h.mount(); assert.equal(first.api.get('screen', 'quantity'), undefined); assert.equal(second.api.get('screen', 'quantity'), 3);
  assert.equal(h.render(() => hooks.usePopupApplicationState(undefined, 'popup', screen)), undefined); assert.equal(second.api.get('screen', 'quantity'), undefined); h.cleanup();
});
delete globalThis.__applicationStateHooks;
console.log(`${checks} application state checks passed.`);
