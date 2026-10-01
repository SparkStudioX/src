import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

// Controlled requests exercise the shipped orchestration and confirmation hook.
// No running gateway, script or device is involved.
const require = createRequire(import.meta.url), modules = new Map();
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hookUrl = asModule(`export * from ${JSON.stringify(reactUrl)};
export const useState=initial=>globalThis.__tagHost.useState(initial);
export const useRef=initial=>globalThis.__tagHost.useRef(initial);
export const useId=()=>'native-tag-test';
export const useEffect=(effect,deps)=>globalThis.__tagHost.useEffect(effect,deps);`);
const apiUrl = asModule(`export const api=(...args)=>globalThis.__tagHost.request(...args);
export const resolvePath=value=>value;export const displayValue=value=>String(value??'');
export const tagByPath=(tags,path)=>tags.find(tag=>tag.path===path);export const apiUrl=path=>path;
export const currentProjectId=()=> 'fixture';export const projectStorageKey=key=>key;
export const scriptFailureMessage=value=>value;export class ApiError extends Error{};
export const authenticatedFetch=()=>{throw new Error('Unexpected fetch');};
export const assertAuthResponseCurrent=()=>{};export const authHeaders=()=>({});export const eventStreamUrl=path=>path;`);
const authUrl = asModule('export const useAuth=()=>globalThis.__tagAuth;');
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) return asModule('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8'));
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(
      dependency === 'react' ? hookUrl : dependency === './api' ? apiUrl : dependency === './Auth' ? authUrl : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
  const url = asModule(code); modules.set(name, url); return url;
}
const { runTagValueAction } = await import(moduleUrl('tagValueAction'));
const { useTagValueAction } = await import(moduleUrl('useTagValueAction'));
const { ComponentView } = await import(moduleUrl('Components'));
const identity = { publishedAt: 'published-version', parameters: { line: 'A' }, inputs: { amount: 12 },
  instancePath: [{ instanceId: 'cards', rowId: 'one' }], bindingInputs: [{}], bindingState: [{}], ui: { state: { session: {}, screen: {} }, properties: {} } };
const review = { token: 'review-ticket', commandId: 'native-tag', name: 'Set fixture', currentValue: 0, requestedValue: 12, confirmation: '', expiresAt: new Date(Date.now() + 60000).toISOString() };
const receipt = { correlationId: 'receipt', status: 'confirmed', message: 'Value observed.', requestedValue: 12, observedValue: 12 };
const route = '/runtime/screens/home/components/write/tag-action';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ticks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
function options(extra = {}) { return { signal: new AbortController().signal, isCurrent: () => true, confirm: async () => { throw new Error('Unexpected confirmation'); }, ...extra }; }
await check('an unqualified click reviews scoped context then executes only the one-use ticket', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return args[0].endsWith('/review') ? review : receipt; };
  assert.deepEqual(await runTagValueAction(request, route, identity, options()), receipt);
  assert.equal(calls.length, 2); assert.equal(calls[0][0], route + '/review'); assert.deepEqual(calls[0][2], identity);
  assert.ok(!Object.hasOwn(calls[0][2], 'tagPath') && !Object.hasOwn(calls[0][2], 'value'));
  assert.deepEqual(calls[1].slice(0, 3), [route + '/execute', 'POST', { token: review.token, confirmed: true }]);
});
await check('qualified actions show the resolved value before dispatch and Cancel never executes', async () => {
  for (const answer of [false, true]) {
    const calls = [], confirmations = [], qualified = { ...review, confirmation: 'Set the fixture?' };
    const result = await runTagValueAction(async (...args) => { calls.push(args); return args[0].endsWith('/review') ? qualified : receipt; }, route, identity,
      options({ confirm: async value => { confirmations.push(value); return answer; } }));
    assert.deepEqual(confirmations, [qualified]); assert.equal(calls.length, answer ? 2 : 1); assert.deepEqual(result, answer ? receipt : null);
  }
});
await check('expired reviews and malformed gateway reviews never dispatch', async () => {
  for (const invalid of [{ ...review, expiresAt: '2000-01-01' }, { ...review, token: '' }, { ...review, confirmation: null }, { ...review, expiresAt: 'invalid' }]) {
    let calls = 0; await assert.rejects(runTagValueAction(async () => { calls++; return invalid; }, route, identity, options())); assert.equal(calls, 1);
  }
});
await check('a closed scope before or during review cannot execute', async () => {
  let calls = 0; await assert.rejects(runTagValueAction(async () => { calls++; return review; }, route, identity, options({ isCurrent: () => false })), /context changed/); assert.equal(calls, 0);
  let current = true; await assert.rejects(runTagValueAction(async () => { calls++; current = false; return review; }, route, identity, options({ isCurrent: () => current })), /context changed/); assert.equal(calls, 1);
});
await check('context or access changes while confirming discard the reviewed action', async () => {
  let current = true, calls = 0;
  await assert.rejects(runTagValueAction(async () => { calls++; return { ...review, confirmation: 'Confirm' }; }, route, identity,
    options({ isCurrent: () => current, confirm: async () => { current = false; return true; } })), /context changed/);
  assert.equal(calls, 1);
});
await check('abort before dispatch never calls the gateway', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(runTagValueAction(async () => { calls++; }, route, identity, options({ signal: controller.signal }))); assert.equal(calls, 0);
});
await check('loss of an execution receipt is reported as uncertain without a retry', async () => {
  let calls = 0;
  await assert.rejects(runTagValueAction(async () => { calls++; if (calls === 1) return review; throw new Error('Connection lost'); }, route, identity, options()), /Check the tag's current value/);
  assert.equal(calls, 2);
});
await check('negative and uncertain receipts remain negative without fabricated success', async () => {
  for (const status of ['notConfirmed', 'rejected', 'uncertain']) {
    const outcome = { ...receipt, status, message: status }; let calls = 0;
    assert.deepEqual(await runTagValueAction(async () => ++calls === 1 ? review : outcome, route, identity, options()), outcome); assert.equal(calls, 2);
  }
});
function host() {
  const state = { values: [], refs: [], effects: [], pending: [], calls: [], stateIndex: 0, refIndex: 0, effectIndex: 0,
    useState(initial) { const index = this.stateIndex++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial;
      return [this.values[index], next => { this.values[index] = typeof next === 'function' ? next(this.values[index]) : next; }]; },
    useRef(initial) { return this.refs[this.refIndex++] ??= { current: initial }; },
    useEffect(effect, dependencies) { const index = this.effectIndex++, previous = this.effects[index];
      if (!previous || dependencies?.some((value, at) => value !== previous.dependencies?.[at])) this.pending.push(() => { previous?.cleanup?.(); this.effects[index] = { dependencies, cleanup: effect() }; }); },
    request(...args) { const promise = deferred(); this.calls.push({ args, ...promise }); return promise.promise; },
    render(key = 'home', available = true) { this.stateIndex = this.refIndex = this.effectIndex = 0; const result = useTagValueAction(key, available); this.pending.splice(0).forEach(effect => effect()); return result; },
    close() { this.effects.forEach(effect => effect?.cleanup?.()); } };
  globalThis.__tagHost = state; return state;
}
await check('the confirmation owner prevents duplicate clicks even before React rerenders', async () => {
  const state = host(), owner = state.render(), running = owner.run(route, identity, () => true);
  await assert.rejects(owner.run(route, identity, () => true), /already running/); assert.equal(state.calls.length, 1);
  state.calls[0].resolve(review); await ticks(); assert.equal(state.calls.length, 2); state.calls[1].resolve(receipt); await running; state.close();
});
await check('screen changes and access revocation cancel pending confirmation permanently', async () => {
  for (const changed of [['another-screen', true], ['home', false]]) {
    const state = host(), pending = state.render().run(route, identity, () => true); const outcome = pending.catch(error => error);
    state.calls[0].resolve({ ...review, confirmation: 'Confirm' }); await ticks(); assert.ok(state.values[0]);
    state.render(...changed); await outcome; assert.equal(state.calls.length, 1); assert.equal(state.values[0], null); state.close();
  }
});
await check('late review responses cannot reopen a closed owner', async () => {
  const state = host(), pending = state.render().run(route, identity, () => true); const outcome = pending.catch(error => error);
  state.close(); state.calls[0].resolve({ ...review, confirmation: 'Confirm' }); await outcome; assert.equal(state.calls.length, 1); assert.equal(state.values[0], null);
});
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(descendants)];
await check('confirmation uses the reviewed value and Cancel or Escape never executes', async () => {
  for (const escape of [false, true]) {
    const state = host(), pending = state.render().run(route, identity, () => true);
    state.calls[0].resolve({ ...review, confirmation: 'Confirm' }); await ticks(); const modal = state.render().confirmation;
    assert.equal(modal.type, 'dialog'); assert.equal(modal.props['aria-labelledby'], 'tag-action-confirm-title');
    const values = descendants(modal).filter(node => node.type === 'dd'); assert.equal(values[1].props.children, '12');
    if (escape) modal.props.onCancel({ preventDefault() {} }); else descendants(modal).find(node => node.type === 'button' && node.props.children === 'Cancel').props.onClick();
    assert.equal(await pending, null); assert.equal(state.calls.length, 1); state.close();
  }
});
await check('native buttons require Commands and remain disabled when read-only, offline or locked', () => {
  const component = { id: 'set', type: 'button', x: 0, y: 0, width: 180, height: 50, props: { text: 'Set fixture', action: 'setTagValue', tagWrite: { tagPath: '[default]Fixture', dataType: 'Double', value: 12 } } };
  for (const extra of [{ commands: false }, { readOnly: true }, { communicationLost: true }, { interactionLocked: true }, { actionBusy: true }]) {
    const state = host(); globalThis.__tagAuth = { permissions: { commands: extra.commands !== false } }; let calls = 0;
    const node = ComponentView({ component, tags: [], parameters: {}, preview: true, queryScope: 'runtime', onNavigate() {}, onAction() { calls++; }, ...extra });
    const button = node.type(node.props); assert.equal(button.props.disabled, true); button.props.onClick(); assert.equal(calls, 0); state.close();
  }
});
console.log(`${passed} native tag action checks passed.`);
