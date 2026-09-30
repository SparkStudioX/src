import assert from 'node:assert/strict';
process.on('uncaughtException',error=>{console.error(error.stack?.split('\n').filter(line=>!line.includes('data:')).join('\n')??error.message);process.exit(1);});
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooks = moduleUrl(`export * from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}; export const useState=v=>globalThis.__repeaterHooks.useState(v); export const useRef=v=>globalThis.__repeaterHooks.useRef(v); export const useEffect=(run,deps)=>globalThis.__repeaterHooks.useEffect(run,deps);
export const useMemo=run=>run(); export const useCallback=run=>run;
// Cell tests run without a provider, preserving the context's declared default.
export const createContext=value=>({defaultValue:value,Provider:({children})=>children});export const useContext=context=>context.defaultValue;`);
const requests = moduleUrl('export const api=(...args)=>globalThis.__repeaterRequest(...args);export const currentProjectId=()=>null;');
const appState = moduleUrl('export const useApplicationStateContext=()=>undefined;');
const rowsHook = moduleUrl('export const useQueryRepeater=()=>globalThis.__repeaterRows;');
function loader(mode) {
  const cache = new Map();
  const url = name => {
    if (cache.has(name)) return cache.get(name);
    const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
      .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => {
        const target = (mode === 'hook' && name === 'useQueryRepeater' || mode === 'cells') && dependency === 'react' ? hooks
          : mode === 'hook' && ['useQueryRepeater','queryPropertyCoordinator'].includes(name) && dependency === './api' ? requests
          : mode === 'hook' && name === 'useQueryRepeater' && dependency === './applicationState' ? appState
          : ['render', 'cells'].includes(mode) && name === 'templates' && dependency === './useQueryRepeater' ? rowsHook
          : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href;
        return `${prefix}${JSON.stringify(target)}`;
      });
    const result = moduleUrl(code); cache.set(name, result); return result;
  };
  return url;
}
const modules = loader();
const { queryRepeaterRows, validateRepeaterSource, loadQueryRepeater, queryRowFormKey } = await import(modules('queryRepeater'));
const { queryTemplateParameters, templateParameters, projectInputContext } = await import(modules('templateModel'));
const { useQueryRepeater } = await import(loader('hook')('useQueryRepeater'));
const { ProjectComponentView: RenderView } = await import(loader('render')('templates'));
const { ProjectComponentView: CellView } = await import(loader('cells')('templates'));
const source = { queryId: 'records', rowKey: 'row_key', parameterMap: { title: 'name', amount: 'amount', active: 'active' } };
const leaf = (id, type, props) => ({ id, type, x: 0, y: 0, width: 180, height: 55, props });
const template = { id: 'card', name: 'Record card', width: 220, height: 160,
  parameters: { title: '{area}', amount: '0', active: 'false', area: 'Saved {area}' },
  components: [leaf('title', 'label', { text: '{title}' }), leaf('edit', 'textInput', { fieldKey: 'note', defaultValue: '' }), leaf('apply', 'button', { action: 'script', script: 'result = parameters', text: 'Apply' })] };
const typedTemplate = { ...template, parameterTypes: { amount: 'number', active: 'boolean' } };
const result = (rows = []) => ({ columns: ['row_key', 'name', 'amount', 'active'], rows, durationMs: 1 });
const row = (id = 'a', name = 'Record A') => ({ row_key: id, name, amount: 2.5, active: true });
const metadata = [{ id: 'records', kind: 'query', parameters: [{ name: 'area' }, { name: 'limit', defaultValue: 100 }] }];
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('mapped primitive values become literal text without substituting braces', () => {
  const rows = queryRepeaterRows(result([row('a', '{area}'), { ...row('b'), amount: -0, active: false }]), source, template);
  assert.deepEqual(rows, [{ id: 'a', parameters: { title: '{area}', amount: '2.5', active: 'true' } }, { id: 'b', parameters: { title: 'Record A', amount: '0', active: 'false' } }]);
  assert.deepEqual(queryTemplateParameters(template, { area: 'West' }, { amount: '8' }, rows[0].parameters),
    { area: 'Saved West', title: '{area}', amount: '2.5', active: 'true' });
  assert.equal(templateParameters(template, { area: 'West' }, {}, { title: '{area}' }).title, 'West');
});
await check('typed query mappings retain native scalars and reject the whole result on one bad value', () => {
  assert.deepEqual(queryRepeaterRows(result([row()]), source, typedTemplate)[0].parameters, { title: 'Record A', amount: 2.5, active: true });
  assert.deepEqual(queryRepeaterRows(result([{ ...row(), amount: '-2.5e1', active: 'false' }]), source, typedTemplate)[0].parameters, { title: 'Record A', amount: -25, active: false });
  for (const value of ['bad', '1\n', '', '01', true, null])
    assert.throws(() => queryRepeaterRows(result([row('good'), { ...row('bad'), amount: value }]), source, typedTemplate), /amount/);
  for (const value of [0, 1, 'False', 'false\n', null])
    assert.throws(() => queryRepeaterRows(result([row('good'), { ...row('bad'), active: value }]), source, typedTemplate), /active/);
});
await check('row identities require nonempty unique strings and never silently truncate', () => {
  for (const invalid of [1, true, null, {}, [], '', '\ufeff ', 'x'.repeat(201)]) assert.throws(() => queryRepeaterRows(result([row(invalid)]), source, template));
  assert.throws(() => queryRepeaterRows(result([row('a'), row('a')]), source, template), /unique/);
  assert.throws(() => queryRepeaterRows(result(Array.from({ length: 101 }, (_, i) => row(String(i)))), source, template), /100/);
  assert.equal(queryRepeaterRows(result(Array.from({ length: 100 }, (_, i) => row(String(i)))), source, template).length, 100);
  assert.deepEqual(queryRepeaterRows(result(), source, template), []);
});
await check('invalid mapped values or missing columns reject the complete result', () => {
  for (const invalid of [null, undefined, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'x'.repeat(4097)])
    assert.throws(() => queryRepeaterRows(result([row(), { ...row('b'), amount: invalid }]), source, template));
  assert.throws(() => queryRepeaterRows({ ...result(), columns: ['row_key', 'name'] }, source, template), /columns/);
  assert.throws(() => queryRepeaterRows(result([null]), source, template));
  assert.throws(() => queryRepeaterRows({ rows: [], columns: null }, source, template));
  assert.deepEqual(queryRepeaterRows(result([row()]), { ...source, parameterMap: {} }, template), [{ id: 'a', parameters: {} }]);
});
await check('source configuration allows only declared parameter mappings and bounded columns', () => {
  for (const invalid of [{ ...source, extra: true }, { ...source, queryId: '' }, { ...source, rowKey: 'x'.repeat(129) }, { ...source, parameterMap: null }, { ...source, parameterMap: { undeclared: 'name' } }, { ...source, parameterMap: { title: ' ' } }])
    assert.throws(() => validateRepeaterSource(invalid, template));
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field${i}`, 'name']));
  assert.throws(() => validateRepeaterSource({ ...source, parameterMap: many }, { ...template, parameters: many }), /64/);
});
await check('loader filters context parameters and pins metadata and results to the same publication', async () => {
  for (const scope of ['designer', 'runtime']) {
    const calls = [];
    const request = async (...args) => { calls.push(args); return calls.length === 1 ? metadata : result([row()]); };
    const rows = await loadQueryRepeater(source, template, scope, { area: 'West', title: 'Must not be sent' }, request, 'v 1');
    assert.equal(rows.length, 1);
    assert.equal(calls[0][0], scope === 'runtime' ? '/runtime/queries?publishedAt=v%201' : '/queries');
    assert.deepEqual(calls[1][2], { parameters: { area: 'West' }, ...(scope === 'runtime' ? { publishedAt: 'v 1' } : {}) });
  }
});
await check('row source queries preserve typed caller values without forwarding undeclared context', async () => {
  const calls = [];
  await loadQueryRepeater(source, typedTemplate, 'designer', { limit: 6, enabled: false, ignored: true }, async (...args) => {
    calls.push(args); return calls.length === 1 ? [{ id: 'records', parameters: [{ name: 'limit' }, { name: 'enabled' }] }] : result([row()]);
  });
  assert.deepEqual(calls[1][2], { parameters: { limit: 6, enabled: false } });
});
await check('missing and update queries never execute as row sources', async () => {
  for (const queries of [[], [{ id: 'records', kind: 'update', parameters: [] }]]) {
    let calls = 0;
    await assert.rejects(loadQueryRepeater(source, template, 'runtime', {}, async () => { calls++; return queries; }), /read query/);
    assert.equal(calls, 1);
  }
});
await check('row form identity preserves unchanged edits but resets changed context, values and input definitions', () => {
  const first = { id: 'a', parameters: { title: 'A' } }, context = { area: 'West', title: 'A' };
  const key = queryRowFormKey('query1', first, template, context);
  assert.equal(key, queryRowFormKey('query1', structuredClone(first), structuredClone(template), { title: 'A', area: 'West' }));
  assert.notEqual(key, queryRowFormKey('query2', first, template, context));
  assert.notEqual(key, queryRowFormKey('query1', { ...first, id: 'a-v2' }, template, context));
  assert.notEqual(key, queryRowFormKey('query1', first, template, { ...context, title: 'Changed' }));
  const moved = structuredClone(template); moved.components[1].x += 100;
  assert.equal(key, queryRowFormKey('query1', first, moved, context));
  moved.components[1].props.defaultValue = 'New default';
  assert.notEqual(key, queryRowFormKey('query1', first, moved, context));
  assert.notEqual(key, queryRowFormKey('query1', first, { ...template, parameterTypes: { title: 'string' } }, context));
});
await check('query source edits invalidate authoring form context', () => {
  const project = { parameters: {}, screens: [{ id: 'screen', components: [{ id: 'rows', type: 'repeater', props: { rowsSource: source } }] }] };
  const changed = structuredClone(project); changed.screens[0].components[0].props.rowsSource.rowKey = 'revision_key';
  assert.notEqual(projectInputContext(project), projectInputContext(changed));
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function hookHarness() {
  const states = [], effects = [], pending = [], calls = [], listeners = new Map();
  let cursor = 0;
  globalThis.__repeaterHooks = {
    useRef(initial) { return states[cursor++] ??= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useEffect(run, deps) { const index = cursor++; const previous = effects[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() }; }); },
  };
  globalThis.__repeaterRequest = (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
  globalThis.window = {
    addEventListener(name, run) { listeners.set(name, run); }, removeEventListener(name) { listeners.delete(name); },
  };
  return {
    calls, listeners,
    render(parameters = { area: 'A' }, offline = false, publication, sourceValue = source, declaration = template) { cursor = 0; return useQueryRepeater(sourceValue, declaration, 'runtime', parameters, offline, publication); },
    commit() { while (pending.length) pending.shift()(); },
    async respond(index, data) { calls[index].resolve(data); await flush(); },
    tick() { listeners.get('sparkstudio:refresh-data')?.(); },
    stop() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
await check('one initial load, synchronous context invalidation and stale completion protection', async () => {
  const h = hookHarness(); assert.equal(h.render({ area: 'A' }).loading, true); h.commit();
  h.render({ area: 'A' }); h.commit(); assert.equal(h.calls.length, 1);
  await h.respond(0, metadata); assert.deepEqual(h.calls[1].args[2], { parameters: { area: 'A' } });
  assert.deepEqual(h.render({ area: 'B' }).rows, []); h.commit();
  await h.respond(2, metadata); await h.respond(3, result([row('b', 'B')]));
  await h.respond(1, result([row('a', 'Old A')]));
  assert.equal(h.render({ area: 'B' }).rows[0].id, 'b'); h.stop();
});
await check('refresh coalesces an in-flight read and offline aborts and clears rows', async () => {
  const h = hookHarness(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([row()]));
  h.tick(); await flush(); assert.equal(h.render().loading, true); assert.equal(h.render().rows[0].id, 'a');
  h.tick(); assert.equal(h.calls.length, 3);
  await h.respond(2, result([row('b')])); assert.equal(h.calls.length, 4);
  await h.respond(3, result([row('c')])); assert.equal(h.render().rows[0].id, 'c');
  h.tick(); await flush(); const signal = h.calls[4].args[3];
  assert.deepEqual(h.render({ area: 'A' }, true).rows, []); h.commit();
  assert.equal(signal.aborted, true); assert.equal(h.listeners.size, 0);
  await h.respond(4, result([row('late')])); assert.deepEqual(h.render({ area: 'A' }, true).rows, []); h.stop();
});
await check('query failure clears the complete result and an explicit refresh can recover empty rows', async () => {
  const h = hookHarness(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([row()]));
  h.tick(); await flush(); h.calls[2].reject(new Error('Database unavailable')); await flush();
  assert.equal(h.render().error, 'Database unavailable'); assert.deepEqual(h.render().rows, []);
  h.tick(); await flush(); await h.respond(3, result()); assert.deepEqual(h.render().rows, []); assert.equal(h.render().loading, false); h.stop();
});
await check('publication replacement aborts old reads and hides old data before effects commit', async () => {
  const h = hookHarness(); h.render({ area: 'A' }, false, 'v1'); h.commit(); await h.respond(0, metadata);
  const oldSignal = h.calls[1].args[3];
  assert.deepEqual(h.render({ area: 'A' }, false, 'v2').rows, []); h.commit(); assert.equal(oldSignal.aborted, true);
  await h.respond(2, metadata); await h.respond(3, result([row('new')])); await h.respond(1, result([row('old')]));
  assert.equal(h.render({ area: 'A' }, false, 'v2').rows[0].id, 'new'); h.stop(); assert.equal(h.listeners.size, 0);
});
await check('saved repeaters do not request query data', () => {
  const h = hookHarness(); assert.equal(h.render({}, false, undefined, null).loading, false); h.commit();
  assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0); h.stop();
});
await check('current type metadata revalidates the shared raw dataset synchronously', async () => {
  const h = hookHarness(); h.render(); h.commit(); await h.respond(0, metadata); await h.respond(1, result([row()]));
  assert.equal(h.render().rows[0].parameters.amount, '2.5');
  assert.equal(h.render({ area: 'A' }, false, undefined, source, typedTemplate).rows[0].parameters.amount, 2.5);
  const invalid = { ...typedTemplate, parameterTypes: { ...typedTemplate.parameterTypes, title: 'number' } };
  assert.deepEqual(h.render({ area: 'A' }, false, undefined, source, invalid).rows, []);
  assert.match(h.render({ area: 'A' }, false, undefined, source, invalid).error, /title/); h.stop();
});
delete globalThis.window;

const host = { id: 'cards', type: 'repeater', x: 0, y: 0, width: 640, height: 400, props: { templateId: 'card', rowsSource: source, columns: 2, gap: 12 } };
const viewProps = { component: host, templates: [template], screenId: 'screen', tags: [], parameters: { area: 'West' }, preview: true, queryScope: 'runtime', onNavigate() {} };
await check('loading, empty and error states are explicit and never render obsolete rows', () => {
  for (const [state, text] of [[{ loading: true, error: '' }, 'Loading rows'], [{ loading: false, error: '' }, 'No matching rows'], [{ loading: false, error: 'Database unavailable' }, 'Database unavailable']]) {
    globalThis.__repeaterRows = { key: 'query', rows: [], ...state };
    const html = renderToStaticMarkup(React.createElement(RenderView, viewProps));
    assert.match(html, new RegExp(text)); assert.doesNotMatch(html, /data-row-id=/);
  }
});
await check('query row data renders literally while saved rows retain substitution', () => {
  globalThis.__repeaterRows = { key: 'query', rows: [{ id: 'a', parameters: { title: '{area}' } }], loading: false, error: '' };
  const html = renderToStaticMarkup(React.createElement(RenderView, viewProps));
  assert.match(html, /\{area\}/); assert.match(html, /data-row-id="a"/);
  const saved = { ...host, props: { templateId: 'card', rows: [{ id: 'saved', parameters: { title: '{area}' } }] } };
  assert.match(renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, component: saved })), />West</);
});
await check('query templates render popup opener controls using their row context', () => {
  const popupTemplate = { ...template, components: [leaf('popup', 'button', { action: 'openPopup', targetScreenId: 'detail' })] };
  const html = renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, templates: [popupTemplate] }));
  assert.doesNotMatch(html, /do not support popup actions/); assert.match(html, /data-row-id="a"/); assert.match(html, /render-button/);
});
await check('invalid typed embedded and saved-row contexts show diagnostics before mounting any children', () => {
  const typed = { ...typedTemplate, parameters: { ...template.parameters, amount: '{missing}' } };
  const embedded = { ...host, type: 'template', props: { templateId: 'card' } };
  const html = renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, component: embedded, templates: [typed] }));
  assert.match(html, /Parameters unavailable/); assert.match(html, /amount/); assert.doesNotMatch(html, /render-button|data-instance-id=/);
  const saved = { ...host, props: { templateId: 'card', rows: [{ id: 'good', parameters: { amount: '2' } }, { id: 'bad', parameters: { amount: 'bad' } }] } };
  const rows = renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, component: saved, templates: [typedTemplate] }));
  assert.match(rows, /Rows unavailable/); assert.doesNotMatch(rows, /data-row-id=|render-button/);
});
await check('query values can repair unresolved defaults and render native numeric Boolean bindings', () => {
  globalThis.__repeaterRows = { key: 'typed', rows: [{ id: 'a', parameters: { amount: 7, active: true } }], loading: false, error: '' };
  const typed = { ...typedTemplate, parameters: { ...template.parameters, amount: '{missing}' }, components: [
    leaf('title', 'label', { bindings: { text: { expression: 'amount + 1', references: { amount: { kind: 'parameter', key: 'amount' } } } } }),
    leaf('apply', 'button', { text: 'Apply', bindings: { enabled: { expression: 'active', references: { active: { kind: 'parameter', key: 'active' } } } } }),
  ] };
  const html = renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, templates: [typed] }));
  assert.match(html, />8</); assert.match(html, /data-row-id="a"/); assert.doesNotMatch(html, /Binding error|Rows unavailable/);
  globalThis.__repeaterRows.rows.push({ id: 'bad', parameters: { amount: 5, active: 'invalid' } });
  const bad = renderToStaticMarkup(React.createElement(RenderView, { ...viewProps, templates: [typed] }));
  assert.match(bad, /Rows unavailable/); assert.doesNotMatch(bad, /data-row-id=/);
});
function localHooks() {
  const values = []; let cursor = 0;
  return { begin() { cursor = 0; globalThis.__repeaterHooks = this; },
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useEffect() {},
  };
}
function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
}
await check('rendered row keys isolate edits and action callbacks carry the resolved row context', () => {
  const calls = [], parentHooks = localHooks();
  const props = { ...viewProps, onAction: (...args) => calls.push(args) };
  const list = () => {
    parentHooks.begin(); let wrapper = CellView(props).props.children;
    if (typeof wrapper.type === "object" && wrapper.type.type) wrapper = wrapper.type.type(wrapper.props);
    const frame = wrapper.type(wrapper.props);
    const host = descendants(frame, node => typeof node.type === 'function' && node.type.name === 'TemplateInstances')[0];
    const tree = host.type(host.props);
    return descendants(tree, node => typeof node.type === 'function' && node.type.name === 'TemplateInstanceCell');
  };
  globalThis.__repeaterRows = { key: 'query', rows: [{ id: 'a', parameters: { title: 'A' } }, { id: 'b', parameters: { title: 'B' } }], loading: false, error: '' };
  const rows = list(), rowHooks = localHooks();
  const render = element => { rowHooks.begin(); return descendants(element.type(element.props), node => typeof node.type === 'function' && node.type.name === 'BoundComponent'); };
  let leaves = render(rows[0]); leaves.find(node => node.props.component.id === 'edit').props.onInputChange('note', 'An operator edit');
  leaves = render(rows[0]); leaves.find(node => node.props.component.id === 'apply').props.onAction();
  assert.equal(calls[0][1].rowId, 'a'); assert.equal(calls[0][1].parameters.title, 'A'); assert.equal(calls[0][1].inputs.note, 'An operator edit');
  assert.deepEqual(list().map(node => node.key), rows.map(node => node.key));
  props.component = { ...host, props: { ...host.props, visible: false } };
  const hiddenRows = list(); assert.deepEqual(hiddenRows.map(node => node.key), rows.map(node => node.key));
  assert.equal(hiddenRows[0].props.interactionLocked, true);
  leaves = render(hiddenRows[0]); assert.equal(leaves[0].props.inputs.note, 'An operator edit');
  props.component = host;
  const shownRows = list(); assert.deepEqual(shownRows.map(node => node.key), rows.map(node => node.key));
  leaves = render(shownRows[0]); assert.equal(leaves[0].props.inputs.note, 'An operator edit');
  globalThis.__repeaterRows.rows[0].parameters.title = 'Changed';
  const changed = list(); assert.notEqual(changed[0].key, rows[0].key); assert.equal(changed[1].key, rows[1].key);
  const freshHooks = localHooks(); freshHooks.begin();
  const fresh = descendants(changed[0].type(changed[0].props), node => typeof node.type === 'function' && node.type.name === 'BoundComponent');
  assert.equal(fresh[0].props.inputs.note, '');
  globalThis.__repeaterRows.rows = [globalThis.__repeaterRows.rows[1]];
  assert.deepEqual(list().map(node => node.props.row.id), ['b']);
});
await check('typed cell actions and child event contexts keep scalar types and invalidate on metadata edits', () => {
  const calls = [], parentHooks = localHooks(), props = { ...viewProps, templates: [typedTemplate], onAction: (...args) => calls.push(args) };
  globalThis.__repeaterRows = { key: 'typed', rows: [{ id: 'a', parameters: { title: 'A', amount: 6, active: false } }], loading: false, error: '' };
  const cells = () => { parentHooks.begin(); let wrapper = CellView(props).props.children;
    if (typeof wrapper.type === "object" && wrapper.type.type) wrapper = wrapper.type.type(wrapper.props);
    const frame = wrapper.type(wrapper.props);
    const host = descendants(frame, node => typeof node.type === 'function' && node.type.name === 'TemplateInstances')[0];
    return descendants(host.type(host.props), node => typeof node.type === 'function' && node.type.name === 'TemplateInstanceCell'); };
  const first = cells()[0], rowHooks = localHooks(); rowHooks.begin();
  const children = descendants(first.type(first.props), node => typeof node.type === 'function' && node.type.name === 'BoundComponent');
  assert.equal(children[0].props.parameters.amount, 6); assert.equal(children[0].props.parameters.active, false);
  children.find(node => node.props.component.id === 'apply').props.onAction();
  assert.equal(calls[0][1].parameters.amount, 6); assert.equal(calls[0][1].parameters.active, false);
  props.templates = [{ ...typedTemplate, parameterTypes: { ...typedTemplate.parameterTypes, title: 'string' } }];
  assert.notEqual(cells()[0].key, first.key);
});

await check('saved templates and rows keep mounted owners across connection changes while query-owned rows invalidate', () => {
  const parentHooks = localHooks(), props = {...viewProps};
  const cells = () => { parentHooks.begin(); let wrapper = CellView(props).props.children;
    if (typeof wrapper.type === "object" && wrapper.type.type) wrapper = wrapper.type.type(wrapper.props);
    const frame = wrapper.type(wrapper.props);
    const host = descendants(frame, node => typeof node.type === 'function' && node.type.name === 'TemplateInstances')[0];
    return descendants(host.type(host.props), node => typeof node.type === 'function' && node.type.name === 'TemplateInstanceCell'); };
  for (const type of ['template', 'repeater']) {
    props.component = {...host, type, props: {templateId: 'card', ...(type === 'repeater' ? {rows: [{id: 'saved', parameters: {title: 'Saved'}}]} : {})}};
    props.communicationLost = true; globalThis.__repeaterRows = {key: 'offline-query-hook', rows: [], loading: false, error: ''};
    const offline = cells().map(node => node.key);
    props.communicationLost = false; globalThis.__repeaterRows = {key: 'online-query-hook', rows: [], loading: false, error: ''};
    assert.deepEqual(cells().map(node => node.key), offline, `${type} must not unmount and rerun Python merely because tag transport connected`);
  }
  props.component = host;
  globalThis.__repeaterRows = {key: 'query-before', rows: [{id: 'a', parameters: {title: 'A'}}], loading: false, error: ''};
  const before = cells()[0].key; globalThis.__repeaterRows.key = 'query-after';
  assert.notEqual(cells()[0].key, before, 'an actual query owner still expires its row context');
});

delete globalThis.__repeaterHooks; delete globalThis.__repeaterRequest; delete globalThis.__repeaterRows;
console.log(`${passed} query-repeater checks passed.`);
