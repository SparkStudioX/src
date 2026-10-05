import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Designer Tags pane: Raw tags | Model tabs and the lazily loaded model tree. Offline; the model API is mocked.
const file = createTestModuleFiles(), modules = new Map(), require = createRequire(import.meta.url);
const hooksUrl = file(`let values=[],index=0,pending=[];
export const begin=()=>{index=0;};
export const clear=()=>{values.forEach(item=>item?.cleanup?.());values=[];index=0;pending=[];};
export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return [values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useRef=initial=>{const at=index++;return values[at]??={current:initial};};
export const useCallback=callback=>{const at=index++;return values[at]??=callback;};
export const useEffect=(run,deps)=>{const at=index++,old=values[at];if(!old||deps.some((item,i)=>item!==old.deps[i]))pending.push(()=>{old?.cleanup?.();values[at]={deps,cleanup:run()};});};
export const flush=()=>{const jobs=pending;pending=[];jobs.forEach(run=>run());};`);
modules.set('api', file('export const displayValue=value=>JSON.stringify(value??null);'));
modules.set('Icon', file('export default function Icon(){return null;}'));
modules.set('designerModel', file('export const createModelFaceplate=object=>({id:"faceplate-"+object.path});'));
modules.set('modelApi', file(`export const modelChangedEvent='sparkstudio:model-changed';
export const getModelTree=(...args)=>globalThis.__tree(...args);export const getModelObject=(...args)=>globalThis.__object(...args);
export function modelLeaves(members){const out=[];for(const value of Object.values(members)){if(value&&typeof value==='object'&&'modelPath' in value)out.push(value);else out.push(...modelLeaves(value));}return out;}`));
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(path => fs.existsSync(path));
  assert.ok(source, name);
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import\s+["'][^"']+\.css["'];?/g, '')
    .replace(/from (["'])([^"']+)\1/g, (_match, _quote, dependency) => `from ${JSON.stringify(dependency === 'react' ? hooksUrl : dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = file(code); modules.set(name, result); return result;
}
const listeners = new Map();
globalThis.window = { addEventListener: (name, run) => listeners.set(name, run), removeEventListener: name => listeners.delete(name) };
const { DesignerModelBrowser, TagBrowserTabs } = await import(load('DesignerModelBrowser'));
const hooks = await import(hooksUrl);
const settle = () => new Promise(resolve => setImmediate(resolve));
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : typeof node.type === 'function' && node.type.name !== 'Icon' ? content(node.type(node.props)) : React.Children.toArray(node.props?.children).map(content).join('');
const nodes = node => !node || typeof node !== 'object' ? [] : typeof node.type === 'function' && node.type.name !== 'Icon' ? nodes(node.type(node.props)) : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

const pages = {
  '[default]': [{ path: '[default]Acme', name: 'Acme', kind: 'hierarchy', level: 'Enterprise' }, { path: '[default]Kepware', name: 'Kepware', kind: 'folder' }],
  '[default]Acme': [{ path: '[default]Acme/Press01', name: 'Press01', kind: 'instance', definitionId: 'Press', version: 2 }],
};
const press = { path: '[default]Acme/Press01', definitionId: 'Press', version: 2, restrictedMembers: 0, generation: 1, members: { Speed: { path: '[default]Acme/Press01/Speed', modelPath: 'Speed', dataType: 'Double', kind: 'reference', value: 42, quality: 'Good', metadata: { unit: 'rpm' } } } };
async function browser() {
  hooks.clear(); const calls = [], selected = [], faceplates = []; let tree;
  globalThis.__tree = async (path, offset) => { calls.push(['tree', path, offset]); return { generation: 1, items: pages[path] ?? [], offset, limit: 100, total: (pages[path] ?? []).length }; };
  globalThis.__object = async path => { calls.push(['object', path]); return press; };
  const render = () => { hooks.begin(); tree = DesignerModelBrowser({ onSelect: path => selected.push(path), onCreateFaceplate: template => faceplates.push(template) }); hooks.flush(); };
  const step = async () => { render(); await settle(); render(); await settle(); render(); };
  await step();
  const row = name => { const item = nodes(tree).find(node => node.props?.role === 'treeitem' && content(node).includes(name)); assert.ok(item, `row ${name}`); return item; };
  return { calls, selected, faceplates, step, row, get tree() { return tree; }, text: () => content(tree) };
}

await check('the model tree opens at the root with folders collapsed and no Up button', async () => {
  const view = await browser();
  assert.deepEqual(view.calls, [['tree', '[default]', 0]]);
  assert.equal(view.row('Acme').props['aria-expanded'], false);
  assert.match(view.text(), /Enterprise/); assert.match(view.text(), /Folder/);
  assert.ok(!nodes(view.tree).some(node => node.type === 'button' && /^Up$|^Previous$|^Next$/.test(content(node))));
  assert.equal(nodes(view.tree).find(node => node.props?.role === 'tree').props['aria-label'], 'Model');
});
await check('expanding a location and a machine loads children lazily and leaves bind on click', async () => {
  const view = await browser();
  view.row('Acme').props.onClick(); await view.step();
  assert.equal(view.row('Acme').props['aria-expanded'], true); assert.deepEqual(view.calls.at(-1), ['tree', '[default]Acme', 0]);
  assert.match(view.text(), /Press v2/);
  view.row('Press01').props.onClick(); await view.step();
  assert.deepEqual(view.calls.at(-1), ['object', '[default]Acme/Press01']);
  const leaf = view.row('Speed'); assert.equal(leaf.props.draggable, true); assert.match(content(leaf), /42 rpm/);
  const dragged = []; leaf.props.onDragStart({ dataTransfer: { setData: (type, value) => dragged.push([type, value]) } });
  assert.deepEqual(dragged, [['text/spark-tag', '[default]Acme/Press01/Speed']]);
  leaf.props.onClick(); assert.deepEqual(view.selected, ['[default]Acme/Press01/Speed']);
  nodes(view.tree).find(node => node.type === 'button' && content(node) === 'Create faceplate').props.onClick();
  assert.deepEqual(view.faceplates, [{ id: 'faceplate-[default]Acme/Press01' }]);
  view.row('Acme').props.onClick(); await view.step(); assert.ok(!view.text().includes('Press01'));
  const count = view.calls.length; view.row('Acme').props.onClick(); await view.step(); assert.equal(view.calls.length, count, 'reopening uses the loaded branch');
});
await check('the refresh icon and model-changed events reload every open branch', async () => {
  const view = await browser();
  view.row('Acme').props.onClick(); await view.step();
  const refresh = nodes(view.tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Refresh model');
  assert.ok(refresh); view.calls.length = 0; refresh.props.onClick(); await view.step();
  assert.deepEqual(view.calls.map(call => call[1]).sort(), ['[default]', '[default]Acme']);
  view.calls.length = 0; listeners.get('sparkstudio:model-changed')(); await view.step();
  assert.equal(view.calls.length, 2); assert.match(view.text(), /Press01/);
});
await check('Raw tags and Model are tabs with one selected', () => {
  const chosen = []; const tabs = TagBrowserTabs({ view: 'model', onView: view => chosen.push(view) });
  assert.equal(tabs.props.role, 'tablist');
  const buttons = nodes(tabs).filter(node => node.props?.role === 'tab');
  assert.deepEqual(buttons.map(button => [content(button), button.props['aria-selected']]), [['Raw tags', false], ['Model', true]]);
  buttons[0].props.onClick(); assert.deepEqual(chosen, ['raw']);
});
console.log(`${passed} Designer model browser checks passed.`);
