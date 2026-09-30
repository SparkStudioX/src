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
  const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const hooks = asModule(`export * from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)}; export const useId=()=>"state-test"; export const useRef=v=>({current:v}); export const useState=v=>[v,()=>{}]; export const useEffect=()=>{};`);
  return function url(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
    assert.ok(file, name);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' && fakeHooks ? hooks : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
    const result = asModule(code); modules.set(name, result); return result;
  };
}
const url = loader();
const { initialInput, isInput, resolveInputs, validateInputs } = await import(url('inputs'));
const { inputAssignmentError, InputEventLifecycle } = await import(url('inputEvents'));
const { resolveIndicatorState } = await import(url('stateControls'));
const { evaluateComponentBindings } = await import(url('propertyBindings'));
const { templateParameters } = await import(url('templateModel'));
const { ComponentView } = await import(loader(true)('Components'));
const { default: BoundComponent } = await import(url('BoundComponent'));
const component = (id, type, props = {}) => ({ id, type, x: 0, y: 0, width: 220, height: 90, props: { fieldKey: id, ...props } });
const field = component('secret', 'passwordInput', { text: 'Password' });
const options = [{ value: 'off', label: 'Off' }, { value: 'manual', label: 'Manual' }, { value: 'auto', label: 'Automatic' }];
const mode = component('mode', 'multiStateButton', { text: 'Mode', options, defaultValue: 'manual' });
const states = [{ value: 'off', label: 'Stopped', color: '#555' }, { value: 'manual', label: 'Manual operation', color: '#fa0' }, { value: 'auto', label: 'Automatic operation', color: '#0a0' }];
const indicator = component('status', 'multiStateIndicator', { text: 'Machine state', stateValue: 'manual', states });
const screen = { id: 'screen', name: 'Screen', width: 1000, height: 700, components: [field, mode] };
const descendants = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
function view(item, extra = {}) { return ComponentView({ component: item, tags: [], parameters: {}, preview: true, onNavigate() {}, ...extra }); }
function markup(item, extra = {}) { return renderToStaticMarkup(React.createElement(BoundComponent, { component: item, components: [item], tags: [], inputs: {}, parameters: {}, preview: true, onNavigate() {}, ...extra })); }
const bindState = (ref, changes = {}) => ({ ...indicator, props: { ...indicator.props, ...changes, bindings: { stateValue: { expression: 'state', references: { state: ref } } } } });
const evaluate = (item, extra = {}) => evaluateComponentBindings(item, { components: [item], parameters: {}, inputs: {}, tags: [], ...extra });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('password controls always begin blank and never disclose saved defaults or tag values', () => {
  assert.equal(isInput('passwordInput'), true); assert.equal(isInput('multiStateButton'), true); assert.equal(isInput('multiStateIndicator'), false);
  const invalidSaved = { ...field, props: { ...field.props, defaultValue: 'stored-secret', tagPath: '[default]Secret' } };
  for (const offline of [false, true]) {
    const tags = [{ path: '[default]Secret', value: 'tag-secret', quality: 'Good', dataType: 'String', timestamp: '' }];
    assert.equal(initialInput(invalidSaved, tags, {}, offline), '');
    const html = markup(invalidSaved, { tags, communicationLost: offline });
    assert.match(html, /type="password"/); assert.doesNotMatch(html, /stored-secret|tag-secret/);
  }
  const input = descendants(view(field), node => node.type === 'input')[0];
  assert.equal(input.props.type, 'password'); assert.equal(input.props.value, ''); assert.equal(input.props.autoComplete, 'new-password'); assert.equal(input.props.spellCheck, false);
});
await test('password operator edits are valid transient text and remain isolated from authored resources', () => {
  const before = structuredClone(screen);
  assert.equal(resolveInputs(screen, [], {}, { secret: 'operator-entry' }).secret, 'operator-entry');
  assert.equal(resolveInputs(screen, [], {}).secret, '');
  assert.equal(validateInputs(screen, { secret: 'operator-entry', mode: 'auto' }), null);
  assert.equal(inputAssignmentError(screen.components, 'secret', 'operator-entry'), null);
  assert.match(inputAssignmentError(screen.components, 'secret', 123), /text/);
  assert.match(inputAssignmentError(screen.components, 'secret', 'x'.repeat(4097)), /4096/);
  assert.deepEqual(screen, before);
});
await test('password changes on typing and commits on Enter or blur without bypassing design locks', () => {
  const events = [];
  const input = descendants(view(field, { onInputChange: (...args) => events.push(['change', ...args]), onInputCommit: (...args) => events.push(['commit', ...args]) }), node => node.type === 'input')[0];
  input.props.onChange({ target: { value: 'entered' } });
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} });
  input.props.onBlur();
  assert.deepEqual(events, [['change', 'secret', 'entered'], ['commit', 'secret', 'entered'], ['commit', 'secret', 'entered']]);
  for (const lock of [{ preview: false }, { interactionLocked: true }]) {
    const locked = descendants(view(field, { ...lock, onInputChange: () => assert.fail('locked edit'), onInputCommit: () => assert.fail('locked commit') }), node => node.type === 'input')[0];
    assert.equal(locked.props.disabled, true); locked.props.onChange({ target: { value: 'ignored' } }); locked.props.onBlur();
  }
});
await test('segmented multi-state input exposes named radio choices and updates only local form values', () => {
  assert.equal(initialInput(mode, [], {}), 'manual');
  assert.equal(initialInput({ ...mode, props: { ...mode.props, defaultValue: 'missing' } }, [], {}), null);
  const updates = [], tree = view(mode, { inputs: { mode: 'manual' }, onInputChange: (...args) => updates.push(['change', ...args]), onInputCommit: (...args) => updates.push(['commit', ...args]) });
  const fieldset = descendants(tree, node => node.type === 'fieldset')[0], radios = descendants(tree, node => node.type === 'input');
  assert.match(fieldset.props.className, /state-options/); assert.equal(radios.length, 3);
  assert.ok(radios.every(node => node.props.type === 'radio')); assert.equal(radios[1].props.checked, true);
  radios[2].props.onChange(); assert.deepEqual(updates, [['change', 'mode', 'auto'], ['commit', 'mode', 'auto']]);
  assert.equal(validateInputs(screen, { secret: '', mode: 'auto' }), null);
  assert.match(validateInputs(screen, { secret: '', mode: 'missing' }), /available options/);
  assert.equal(inputAssignmentError(screen.components, 'mode', 'off'), null);
});
await test('all supported segmented options render accessibly while design and disabled controls reject events', () => {
  for (const length of [2, 32]) {
    const item = { ...mode, props: { ...mode.props, defaultValue: '0', options: Array.from({ length }, (_, index) => ({ value: String(index), label: `State ${index}` })) } };
    assert.equal(descendants(view(item), node => node.type === 'input').length, length);
  }
  for (const lock of [{ preview: false }, { interactionLocked: true }]) {
    const tree = view(mode, { ...lock, onInputChange: () => assert.fail('locked edit'), onInputCommit: () => assert.fail('locked commit') });
    const fieldset = descendants(tree, node => node.type === 'fieldset')[0], radio = descendants(tree, node => node.type === 'input')[0];
    assert.equal(fieldset.props.disabled, true); radio.props.onChange();
  }
});
await test('both new inputs use serialized change and deduplicated commit event contracts', async () => {
  for (const [item, initial, next] of [[field, '', 'entered'], [mode, 'manual', 'auto']]) {
    const events = [], bound = { ...item, props: { ...item.props, events: { change: { language: 'javascript', code: 'change' }, commit: { language: 'javascript', code: 'commit' } } } };
    const lifecycle = new InputEventLifecycle((_script, event, _inputs, parameters) => events.push({ event, parameters }));
    lifecycle.setContext({ key: item.id, component: bound, components: [bound], inputs: { [item.id]: initial }, parameters: { count: 3, permitted: false }, setInput() {}, notify() {}, error: assert.fail }, initial);
    lifecycle.activate(); lifecycle.change(next); lifecycle.commit(next); lifecycle.commit(next); await lifecycle.whenIdle();
    assert.deepEqual(events.map(item => item.event.type), ['change', 'commit']); assert.equal(events[0].parameters.count, 3); assert.equal(events[1].parameters.permitted, false);
    lifecycle.deactivate();
  }
});
await test('indicator exact state mapping displays labels and explicit hex colors', () => {
  for (const state of states) {
    assert.deepEqual(resolveIndicatorState({ ...indicator.props, stateValue: state.value }), { state });
    const html = markup({ ...indicator, props: { ...indicator.props, stateValue: state.value } });
    assert.ok(html.includes(state.label)); assert.match(html, /role="status"/); assert.doesNotMatch(html, /state-unavailable/);
  }
  for (const color of ['#abc', '#abcd', '#AABBCC', '#AABBCCDD']) assert.ok(resolveIndicatorState({ states: [{ value: 'x', label: 'X', color }], stateValue: 'x' }).state);
  assert.ok(resolveIndicatorState({ states: Array.from({ length: 32 }, (_, i) => ({ value: String(i), label: String(i), color: '#abc' })), stateValue: '31' }).state);
});
await test('malformed maps and unknown state values are neutral instead of reusing a good state', () => {
  const good = states[0];
  for (const invalid of [undefined, null, [], [null], [good, good], Array.from({ length: 33 }, (_, i) => ({ ...good, value: String(i) })), [{ ...good, value: '' }], [{ ...good, label: ' ' }], [{ ...good, value: 'x'.repeat(129) }], [{ ...good, label: 'x'.repeat(129) }], [{ ...good, color: '#fff\n' }], [{ ...good, color: ' #fff' }], [{ ...good, color: 'green' }], [{ ...good, extra: true }]]) {
    const resolved = resolveIndicatorState({ ...indicator.props, states: invalid }); assert.equal(resolved.state, undefined); assert.ok(resolved.diagnostic);
  }
  for (const value of ['missing', 'Manual', '', undefined, 0, false]) {
    const resolved = resolveIndicatorState({ ...indicator.props, stateValue: value }); assert.equal(resolved.state, undefined); assert.ok(resolved.diagnostic);
  }
  const html = markup({ ...indicator, props: { ...indicator.props, stateValue: 'missing' } });
  assert.match(html, /Unknown state|state-unavailable/); assert.doesNotMatch(html, /Manual operation|#fa0/);
});
await test('state bindings canonicalize input, typed parameter and tag scalar values', () => {
  const item = bindState({ kind: 'parameter', key: 'mode' }, { states: [{ value: '2', label: 'Second', color: '#f80' }, { value: 'false', label: 'No', color: '#999' }] });
  const template = { id: 't', name: 'T', width: 1, height: 1, components: [], parameters: { mode: '2' }, parameterTypes: { mode: 'number' } };
  const native = templateParameters(template, {});
  assert.equal(evaluate(item, { parameters: native }).component.props.stateValue, '2');
  assert.equal(evaluate(item, { parameters: { mode: false } }).component.props.stateValue, 'false');
  const local = bindState({ kind: 'input', key: 'mode' });
  assert.equal(evaluate(local, { inputs: { mode: 'auto' } }).component.props.stateValue, 'auto');
  const tagged = bindState({ kind: 'tag', path: '[default]Mode' });
  assert.equal(evaluate(tagged, { tags: [{ path: '[default]Mode', value: true, quality: 'Good', dataType: 'Boolean', timestamp: '' }] }).component.props.stateValue, 'true');
});
await test('failed state bindings discard authored good fallback and show an unavailable diagnostic', () => {
  const item = bindState({ kind: 'tag', path: '[default]Mode' });
  const tag = { path: '[default]Mode', value: 'auto', quality: 'Good', dataType: 'String', timestamp: '' };
  for (const context of [{ tags: [] }, { tags: [{ ...tag, quality: 'Bad_NotConnected' }] }, { tags: [tag], communicationLost: true }, { tags: [{ ...tag, value: Number.MAX_SAFE_INTEGER + 1 }] }]) {
    const resolved = evaluate(item, context); assert.ok(resolved.errors.stateValue); assert.equal(resolved.component.props.stateValue, undefined);
    const html = markup(item, context); assert.match(html, /State unavailable/); assert.doesNotMatch(html, /Manual operation|Automatic operation/);
  }
  assert.ok(evaluate(bindState({ kind: 'input', key: 'mode' }), { inputs: { mode: null } }).errors.stateValue);
  assert.ok(evaluate({ ...item, type: 'label' }, { tags: [tag] }).errors.stateValue);
});

console.log(`${passed} state-control model and renderer checks passed.`);
