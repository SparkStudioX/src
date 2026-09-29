import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookModule = asModule('export const useState = value => globalThis.__queryHooks.useState(value); export const useRef = value => globalThis.__queryHooks.useRef(value); export const useEffect = (run,deps) => globalThis.__queryHooks.useEffect(run,deps); export const useId = () => "query-select-test";');
const apiModule = asModule('export const api = (...args) => globalThis.__queryRequests.request(...args);');
const selectOptionsModule = asModule('export const useQueryOptions = (...args) => globalThis.__selectOptions(...args);');
function loader(fakeHook = false) {
  const cache = new Map();
  function url(name) {
    if (cache.has(name)) return cache.get(name);
    const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => {
        const target = fakeHook === 'select' && name === 'Components' && dependency === 'react' ? hookModule
          : fakeHook === 'select' && name === 'Components' && dependency === './useQueryOptions' ? selectOptionsModule
          : fakeHook && name === 'useQueryOptions' && dependency === 'react' ? hookModule
          : fakeHook && name === 'useQueryOptions' && dependency === './api' ? apiModule
          : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href;
        return `${prefix}${JSON.stringify(target)}`;
      });
    const result = asModule(js); cache.set(name, result); return result;
  }
  return url;
}
const modules = loader();
const { queryOptions, querySelectionChanges, loadQueryOptions } = await import(modules('queryOptions'));
const { initialInput, validateInputs, resolveInputs } = await import(modules('inputs'));
const { ComponentView } = await import(modules('Components'));
const { useQueryOptions } = await import(loader(true)('useQueryOptions'));
const { QuerySelect } = await import(loader('select')('Components'));
const source = { queryId: 'machines', valueColumn: 'id', labelColumn: 'name' };
const result = rows => ({ columns: ['id', 'name', 'count', 'enabled'], rows, durationMs: 2 });
const component = (id, type, props = {}) => ({ id, type, x: 0, y: 0, width: 250, height: 100, props: { fieldKey: id, ...props } });
const selector = component('choice', 'select', { optionsSource: source });
const form = components => ({ id: 'form', name: 'Form', width: 1000, height: 700, components });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('normalizes text and exact numbers without confusing boolean/null with choices', () => {
  assert.deepEqual(queryOptions(result([{ id: 1, name: 'Cell A' }, { id: '002', name: 2.5 }]), source).map(({ value, label }) => ({ value, label })), [{ value: '1', label: 'Cell A' }, { value: '002', label: '2.5' }]);
  for (const invalid of [null, undefined, true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '   ', 'x'.repeat(4097)])
    assert.throws(() => queryOptions(result([{ id: invalid, name: 'A' }]), source));
  for (const invalid of [null, false, {}, '', 'x'.repeat(201)]) assert.throws(() => queryOptions(result([{ id: 'A', name: invalid }]), source));
});
await test('rejects ambiguous, oversize, or missing-column results in their entirety', () => {
  assert.throws(() => queryOptions(result([{ id: 1, name: 'A' }, { id: '1', name: 'B' }]), source), /duplicate/);
  assert.throws(() => queryOptions(result(Array.from({ length: 501 }, (_, id) => ({ id, name: id }))), source), /500/);
  assert.throws(() => queryOptions({ ...result([]), columns: ['id'] }, source), /columns/);
  assert.throws(() => queryOptions(result([{ name: 'Missing ID' }]), source));
  assert.deepEqual(queryOptions(result([]), source), []);
});
await test('query controls never initialize from the first static or fetched option', () => {
  const field = { ...selector, props: { ...selector.props, options: [{ value: 'A', label: 'A' }] } };
  assert.equal(initialInput(field, [], {}), null);
  assert.equal(initialInput({ ...field, props: { ...field.props, defaultValue: '' } }, [], {}), null);
  assert.equal(initialInput({ ...field, props: { ...field.props, defaultValue: 'B' } }, [], {}), 'B');
  assert.equal(resolveInputs(form([field]), [], {}, { choice: 'operator edit' }).choice, 'operator edit');
});
await test('dynamic choices validate text shape locally while static choices retain membership rules', () => {
  assert.equal(validateInputs(form([selector]), { choice: 'A' }), null);
  for (const value of ['', '  ', false, 1, null, 'x'.repeat(4097)]) assert.ok(validateInputs(form([selector]), { choice: value }));
  assert.ok(validateInputs(form([component('choice', 'select', { options: [{ value: 'A', label: 'A' }] })]), { choice: 'B' }));
});
await test('all mapped fields are type/range checked before any changes are returned', () => {
  const count = component('amount', 'spinner', { min: 0, max: 100 });
  const enabled = component('active', 'toggle');
  const field = { ...selector, props: { ...selector.props, selectionFields: { amount: 'count', active: 'enabled' } } };
  const options = queryOptions(result([{ id: 'A', name: 'Cell A', count: 12, enabled: true }]), source);
  assert.deepEqual(querySelectionChanges(options[0], field, [field, count, enabled]), [['amount', 12], ['active', true]]);
  assert.throws(() => querySelectionChanges({ ...options[0], row: { count: 101, enabled: true } }, field, [field, count, enabled]), /at most/);
  assert.throws(() => querySelectionChanges({ ...options[0], row: { count: 12, enabled: 'true' } }, field, [field, count, enabled]), /On or Off/);
  assert.throws(() => querySelectionChanges(options[0], field, [field, count]), /one input/);
  assert.throws(() => querySelectionChanges(options[0], { ...field, props: { ...field.props, selectionFields: { choice: 'name' } } }, [field]), /cannot also/);
});
await test('mapped text, choice, date, null, and unsafe numeric values follow input rules', () => {
  for (const [target, value, valid] of [
    [component('target', 'textInput'), 'A', true], [component('target', 'textInput'), 5, false],
    [component('target', 'numberInput'), 3.5, true], [component('target', 'numberInput'), Number.MAX_SAFE_INTEGER + 1, false],
    [component('target', 'textInput'), null, false],
    [component('target', 'select', { options: [{ value: 'A', label: 'A' }] }), 'B', false],
    [component('target', 'dateTimeInput'), '2026-02-30T12:00', false],
  ]) {
    const field = { ...selector, props: { ...selector.props, selectionFields: { target: 'data' } } };
    const option = { value: 'A', label: 'A', row: { data: value } };
    if (valid) assert.deepEqual(querySelectionChanges(option, field, [field, target]), [['target', value]]);
    else assert.throws(() => querySelectionChanges(option, field, [field, target]));
  }
});
await test('executes only available read queries with declared context parameters', async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return calls.length === 1 ? [{ id: 'machines', parameters: [{ name: 'area' }, { name: 'limit' }] }] : result([{ id: 'A', name: 'Cell A' }]); };
  assert.equal((await loadQueryOptions(source, 'runtime', { area: 'West', private: 'never-sent' }, api))[0].value, 'A');
  assert.deepEqual(calls, [['/runtime/queries'], ['/runtime/queries/machines/execute', 'POST', { parameters: { area: 'West' } }]]);
  await assert.rejects(loadQueryOptions(source, 'designer', {}, async () => [{ id: 'machines', kind: 'update', parameters: [] }]), /read query/);
  await assert.rejects(loadQueryOptions(source, 'designer', {}, async () => []), /not available/);
});
await test('runtime metadata and execution pin one publication while designer calls omit the token', async () => {
  for (const scope of ['runtime', 'designer']) {
    const calls = [];
    const request = async (...args) => { calls.push(args); return calls.length === 1 ? [{ id: 'machines', parameters: [] }] : result([{ id: 'A', name: 'Cell A' }]); };
    const publication = '2026-09-28T15:00:00.0000000+00:00';
    await loadQueryOptions(source, scope, {}, request, publication);
    assert.deepEqual(calls[0], [scope === 'runtime' ? `/runtime/queries?publishedAt=${encodeURIComponent(publication)}` : '/queries']);
    assert.deepEqual(calls[1][2], { parameters: {}, ...(scope === 'runtime' ? { publishedAt: publication } : {}) });
  }
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setupHook() {
  const states = [], effects = [], pending = [], requests = [], listeners = new Map();
  let cursor = 0, interval;
  globalThis.__queryHooks = {
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index]; },
    useEffect(run, deps) { const index = cursor++; const previous = effects[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() }; }); },
  };
  globalThis.__queryRequests = { request(...args) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); requests.push({ args, resolve, reject }); return promise; } };
  globalThis.window = {
    setInterval(run) { interval = run; return 1; }, clearInterval() { interval = null; },
    addEventListener(name, run) { listeners.set(name, run); }, removeEventListener(name) { listeners.delete(name); },
  };
  return {
    requests, listeners,
    render(parameters = {}, offline = false, publishedAt) { cursor = 0; return useQueryOptions(source, 'runtime', parameters, offline, publishedAt); },
    commit() { while (pending.length) pending.shift()(); },
    async respond(index, data) { requests[index].resolve(data); await flush(); },
    tick() { interval?.(); },
    stop() { for (const effect of effects) effect?.cleanup?.(); },
  };
}
const metadata = [{ id: 'machines', parameters: [{ name: 'area' }] }];
await test('hook invalidates prior context synchronously and ignores stale completions', async () => {
  const h = setupHook();
  assert.equal(h.render({ area: 'A' }).loading, true); h.commit();
  await h.respond(0, metadata);
  assert.deepEqual(h.requests[1].args[2], { parameters: { area: 'A' } });
  assert.deepEqual(h.render({ area: 'B' }).options, []); h.commit();
  await h.respond(2, metadata); await h.respond(3, result([{ id: 'B', name: 'Cell B' }]));
  assert.equal(h.render({ area: 'B' }).options[0].value, 'B');
  await h.respond(1, result([{ id: 'A', name: 'Cell A' }]));
  assert.equal(h.render({ area: 'B' }).options[0].value, 'B');
  h.stop();
});
await test('poll and action refresh disable loading, latest request wins, offline clears choices', async () => {
  const h = setupHook(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([{ id: 'A', name: 'Cell A' }]));
  assert.equal(h.render().loading, false);
  h.tick(); assert.equal(h.render().loading, true);
  h.listeners.get('sparkstudio:refresh-data')();
  await h.respond(3, metadata); await h.respond(4, result([{ id: 'C', name: 'Cell C' }]));
  await h.respond(2, metadata); await h.respond(5, result([{ id: 'B', name: 'Cell B' }]));
  assert.equal(h.render().options[0].value, 'C');
  const beforeOffline = h.requests.length;
  assert.deepEqual(h.render({}, true).options, []); h.commit();
  assert.match(h.render({}, true).error, /Communication lost/);
  assert.equal(h.requests.length, beforeOffline);
  assert.equal(h.listeners.size, 0); h.stop();
});
await test('query errors remove obsolete options and recover on the next refresh', async () => {
  const h = setupHook(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([{ id: 'A', name: 'Cell A' }]));
  h.listeners.get('sparkstudio:refresh-queries')(); h.requests[2].reject(new Error('Database unavailable')); await flush();
  assert.equal(h.render().error, 'Database unavailable'); assert.deepEqual(h.render().options, []);
  h.tick(); await h.respond(3, metadata); await h.respond(4, result([]));
  assert.equal(h.render().error, ''); assert.equal(h.render().loading, false); h.stop();
});
await test('publication changes invalidate pending options and stale publication responses stay unavailable', async () => {
  const h = setupHook(); h.render({}, false, 'v1'); h.commit(); await h.respond(0, metadata);
  assert.equal(h.requests[1].args[2].publishedAt, 'v1');
  assert.deepEqual(h.render({}, false, 'v2').options, []); h.commit();
  await h.respond(2, metadata); await h.respond(3, result([{ id: 'New', name: 'New version' }]));
  await h.respond(1, result([{ id: 'Old', name: 'Old version' }]));
  assert.equal(h.render({}, false, 'v2').options[0].value, 'New');
  h.tick(); h.requests[4].reject(new Error('A new version is published. Load the new version.')); await flush();
  assert.deepEqual(h.render({}, false, 'v2').options, []);
  assert.match(h.render({}, false, 'v2').error, /new version/);
  h.stop();
});
await test('explicit reload returns fresh rows only while its form context remains active', async () => {
  const h = setupHook(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([{ id: 'A', name: 'Cell A', count: 1 }]));
  const refresh = h.render().refresh(); await h.respond(2, metadata); await h.respond(3, result([{ id: 'A', name: 'Cell A', count: 2 }]));
  assert.equal((await refresh)[0].row.count, 2);
  const stale = h.render().refresh(); h.render({ area: 'New context' }); h.commit();
  await h.respond(4, metadata); await h.respond(6, result([{ id: 'A', name: 'Cell A', count: 3 }]));
  assert.equal(await stale, null); h.stop();
});
await test('unmounted queries cannot publish pending results or keep polling', async () => {
  const h = setupHook(); h.render(); h.commit(); h.stop();
  await h.respond(0, metadata); await h.respond(1, result([{ id: 'A', name: 'Cell A' }]));
  assert.equal(h.render().loading, true); assert.equal(h.listeners.size, 0);
});
await test('pending explicit reload cannot overwrite a newer form edit or changed target definition', async () => {
  function findButton(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'button') return node;
    return React.Children.toArray(node.props?.children).map(findButton).find(Boolean);
  }
  for (const changed of ['none', 'input', 'definition']) {
    const states = [], effects = [], changes = []; let cursor = 0; let resolve;
    globalThis.__queryHooks = {
      useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
      useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index]; },
      useEffect(run) { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(run); } },
    };
    const option = { value: 'A', label: 'Cell A', row: { count: 12 } };
    globalThis.__selectOptions = () => ({ key: 'current', options: [option], loading: false, error: '', refresh: () => new Promise(done => { resolve = done; }) });
    const choice = { ...selector, props: { ...selector.props, selectionFields: { amount: 'count' } } };
    const amount = component('amount', 'numberInput', { min: 0, max: 100 });
    const props = { label: 'Choice', component: choice, components: [choice, amount], parameters: {}, queryScope: 'runtime', communicationLost: false, value: 'A', inputs: { choice: 'A', amount: 3 }, inputProps: { disabled: false }, onMappedChange: (...args) => changes.push(args), onChange: value => changes.push(['choice', value]) };
    const render = properties => { cursor = 0; return QuerySelect(properties); };
    const tree = render(props); effects.forEach(effect => effect());
    const pending = findButton(tree).props.onClick({ preventDefault() {} });
    if (changed === 'input') render({ ...props, inputs: { ...props.inputs, amount: 9 } });
    else if (changed === 'definition') render({ ...props, components: [choice, { ...amount, props: { ...amount.props, max: 10 } }] });
    resolve([option]); await pending;
    assert.deepEqual(changes, changed === 'none' ? [['amount', 12], ['choice', 'A']] : []);
  }
  delete globalThis.__selectOptions;
});
delete globalThis.window;
await test('initial server render exposes a disabled, labeled query selector and loading status', () => {
  const html = renderToStaticMarkup(React.createElement(ComponentView, { component: selector, scopeComponents: [selector], inputs: {}, tags: [], parameters: {}, preview: true, onNavigate() {} }));
  assert.match(html, /<select[^>]*disabled=""/); assert.match(html, /Loading options/); assert.match(html, /aria-label="choice"/);
});
delete globalThis.__queryHooks; delete globalThis.__queryRequests;
console.log(`${passed} query-options checks passed.`);
