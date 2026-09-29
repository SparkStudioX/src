import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
// This harness isolates source-record verification. No state provider is present;
// state lifetimes are exercised by check-application-state and nested render checks.
const hooks = moduleUrl(`export { createContext } from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}; export const useContext=()=>undefined; export const useState=v=>globalThis.__popupHooks.useState(v); export const useRef=v=>globalThis.__popupHooks.useRef(v); export const useEffect=(run,deps)=>globalThis.__popupHooks.useEffect(run,deps);`);
const rows = moduleUrl('export const useQueryRepeater=(...args)=>{globalThis.__popupQueryCalls.push(args); return globalThis.__popupRows;};');
const icon = moduleUrl('export default function Icon(){return null;}');
const cache = new Map();
function url(name) {
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => {
      const target = ['Popup', 'applicationState', 'inputStateBindings'].includes(name) && dependency === 'react' ? hooks
        : name === 'Popup' && dependency === './useQueryRepeater' ? rows
        : name === 'Popup' && dependency === './Icon' ? icon
        : name === 'Popup' && dependency === './templates' ? moduleUrl(`export {actionKey} from ${JSON.stringify(url('templateModel'))}; export function ProjectComponentView(){return null;}`)
        : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href;
      return `${prefix}${JSON.stringify(target)}`;
    });
  const result = moduleUrl(code); cache.set(name, result); return result;
}
const { default: Popup } = await import(url('Popup'));
const { ApiError } = await import(url('api'));
const { createPopup, screenParameters } = await import(url('popupModel'));
const { queryTemplateParameters } = await import(url('templateModel'));
const leaf = (id, type, props) => ({ id, type, x: 5, y: 5, width: 180, height: 60, props });
const opener = leaf('open', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { title: '{name}' } });
const template = { id: 'card', name: 'Card', width: 240, height: 180, parameters: { name: 'Default' }, components: [opener] };
const source = { queryId: 'rows', rowKey: 'row_key', parameterMap: { name: 'name' } };
const screen = { id: 'screen', name: 'Screen', width: 1000, height: 700, parameters: { area: 'Screen area' }, components: [leaf('cards', 'repeater', { templateId: 'card', rowsSource: source })] };
const target = { id: 'detail', kind: 'popup', name: 'Detail', width: 600, height: 360, parameters: { title: '' }, components: [
  leaf('note', 'textInput', { fieldKey: 'note', defaultValue: '' }),
  leaf('submit', 'button', { action: 'script', script: 'result = inputs', text: 'Submit' }),
  leaf('close', 'button', { action: 'closePopup', text: 'Close' }),
] };
const project = { id: 'project', name: 'Project', revision: 1, publishedAt: 'v1', parameters: { area: 'Root area' }, screens: [screen, target], templates: [template] };
const row = { id: 'record:v1', parameters: { name: '{area}' } };
const caller = queryTemplateParameters(template, screenParameters(screen, project.parameters), {}, row.parameters);
const makePopup = () => createPopup(project, screen, opener, project.parameters, caller,
  { instanceId: 'cards', rowId: row.id, template, parameters: caller, inputs: {} });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
}
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? React.Children.toArray(node.props?.children).map(content).join(' ') : '';
function harness({ popup = makePopup(), execute = async () => ({ success: true, result: { message: 'Saved successfully.' } }) } = {}) {
  const states = [], effects = [], pending = [], dispatched = [], executions = [], stale = [], closed = [];
  let cursor = 0;
  globalThis.__popupHooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return states[i] ??= { current: initial }; },
    useEffect(run, deps) { const i = cursor++, previous = effects[i]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) pending.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: run() }; }); },
  };
  globalThis.__popupRows = { rows: [row], loading: false, error: '' };
  globalThis.__popupQueryCalls = [];
  globalThis.document = { activeElement: null };
  globalThis.window = { innerWidth: 1400, innerHeight: 1000, addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { dispatched.push(event.type); } };
  const props = { project, popup, tags: [], communicationLost: false, queryScope: 'runtime', onClose: () => closed.push(true), onNavigate() {},
    onBusyChange() {}, onStale: () => stale.push(true), onExecute: async action => { executions.push(action); return execute(action); } };
  return { props, dispatched, executions, stale, closed,
    render(changes = {}) { cursor = 0; const tree = Popup({ ...props, ...changes }); assert.equal(tree.props.value, undefined); return tree.props.children; },
    commit() { while (pending.length) pending.shift()(); },
    fields(tree) { return Object.fromEntries(descendants(tree, node => typeof node.type === 'function' && node.type.name === 'ProjectComponentView').map(node => [node.props.component.id, node.props])); },
    stop() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await check('initial verification locks actions while Close remains available; unchanged polls preserve usable inputs', () => {
  const h = harness(); globalThis.__popupRows = { rows: [], loading: true, error: '' };
  let tree = h.render(), fields = h.fields(tree);
  assert.equal(fields.note.interactionLocked, true); assert.equal(fields.submit.interactionLocked, true); assert.equal(fields.close.interactionLocked, false);
  assert.match(content(tree), /Checking the source record/); h.commit();
  globalThis.__popupRows = { rows: [row], loading: false, error: '' };
  fields = h.fields(h.render()); assert.equal(fields.note.interactionLocked, false);
  globalThis.__popupRows.loading = true;
  fields = h.fields(h.render()); assert.equal(fields.note.interactionLocked, false); assert.equal(fields.submit.interactionLocked, false);
  const call = globalThis.__popupQueryCalls.at(-1);
  assert.equal(call[2], 'runtime'); assert.equal(call[3].area, 'Screen area'); assert.equal(call[5], 'v1'); h.stop();
});
await check('changed source permanently invalidates the popup even if matching data later returns', async () => {
  const h = harness(); h.render(); h.commit();
  globalThis.__popupRows = { rows: [{ ...row, parameters: { name: 'Changed' } }], loading: false, error: '' };
  let tree = h.render(); assert.equal(h.fields(tree).submit.interactionLocked, true); h.commit();
  globalThis.__popupRows.rows = [row]; tree = h.render();
  assert.equal(h.fields(tree).submit.interactionLocked, true); assert.match(content(tree), /source record has changed/i);
  h.fields(tree).submit.onAction(target.components[1]); await flush(); assert.equal(h.executions.length, 0);
  h.fields(tree).close.onClosePopup(); assert.equal(h.closed.length, 1); h.stop();
});
await check('popup edits and literal parameters stay isolated from the opener and each new popup session', () => {
  const h = harness(); let fields = h.fields(h.render());
  assert.equal(fields.note.parameters.title, '{area}');
  fields.note.onInputChange('note', 'Draft for this record'); fields = h.fields(h.render());
  assert.equal(fields.note.inputs.note, 'Draft for this record'); assert.equal(row.parameters.name, '{area}');
  const second = harness(); assert.notEqual(second.props.popup.id, h.props.popup.id);
  assert.equal(second.fields(second.render()).note.inputs.note, ''); second.stop();
});
await check('successful popup actions refresh surrounding data and keep success feedback when the row disappears', async () => {
  const h = harness(); const fields = h.fields(h.render()); h.commit();
  fields.submit.onAction(target.components[1]); await flush();
  assert.deepEqual(h.dispatched, ['sparkstudio:refresh-data']); assert.equal(h.executions[0].popup.origin.rowId, row.id);
  assert.equal(h.executions[0].parameters.title, '{area}');
  globalThis.__popupRows = { rows: [], loading: false, error: '' };
  const tree = h.render(); assert.match(content(tree), /Saved successfully/); assert.match(content(tree), /The action completed/);
  assert.equal(h.fields(tree).submit.interactionLocked, true); assert.equal(h.closed.length, 0); h.stop();
});
await check('a missing source row HTTP400 stays inside the popup without unloading or navigating the application', async () => {
  const h = harness({ execute: async () => { throw new ApiError('The source row no longer exists. Reopen a current record.', 400); } });
  h.fields(h.render()).submit.onAction(target.components[1]); await flush();
  const tree = h.render(); assert.equal(tree.type, 'dialog'); assert.match(content(tree), /source row no longer exists/);
  assert.equal(h.closed.length, 0); assert.equal(h.stale.length, 0); assert.deepEqual(h.dispatched, []); h.stop();
});
await check('publication conflicts mark the dynamic popup stale and block another action', async () => {
  const h = harness({ execute: async () => { throw new ApiError('New publication', 409); } });
  h.fields(h.render()).submit.onAction(target.components[1]); await flush();
  const tree = h.render(); assert.equal(h.stale.length, 1); assert.match(content(tree), /application version changed/);
  assert.equal(h.fields(tree).submit.interactionLocked, true); h.fields(tree).submit.onAction(target.components[1]); await flush();
  assert.equal(h.executions.length, 1); h.stop();
});
await check('static popup actions keep their existing interaction behavior and also refresh after success', async () => {
  const staticPopup = { ...makePopup(), querySourceParameters: undefined };
  const h = harness({ popup: staticPopup }); globalThis.__popupRows = { rows: [], loading: true, error: '' };
  const fields = h.fields(h.render()); assert.equal(fields.submit.interactionLocked, false);
  fields.submit.onAction(target.components[1]); await flush();
  assert.deepEqual(h.dispatched, ['sparkstudio:refresh-data']); assert.equal(h.closed.length, 0); h.stop();
});

delete globalThis.__popupHooks; delete globalThis.__popupRows; delete globalThis.__popupQueryCalls;
delete globalThis.window; delete globalThis.document;
console.log(`${passed} popup-source checks passed.`);
