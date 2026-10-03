import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url), url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooksUrl = url(`
export * from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
let values=[],index=0;
export function seed(entries){values=[];for(const [key,value] of entries)values[key]=value}
export function begin(){index=0}
export function useState(initial){const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next}]}
export const useEffect=()=>{};export const useMemo=fn=>fn();export const useCallback=fn=>fn;
export const useRef=value=>({current:value});export const useId=()=>':scaling:';
`);
const apiUrl = url(`export function api(...args){return globalThis.__tagApi(...args)};export const displayValue=value=>String(value??'');`);
const stubUrl = url('export const Field=()=>null;export default ()=>null;');
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  const source = fs.readFileSync(new URL(`src/${name}.${fs.existsSync(new URL(`src/${name}.ts`, import.meta.url)) ? 'ts' : 'tsx'}`, import.meta.url), 'utf8');
  return url(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(
      dependency === 'react' ? hooksUrl : dependency === 'react-dom' ? url('export const createPortal=value=>value;') : dependency === './api' ? apiUrl : dependency === './deviceConnections' ? load('deviceConnections') : dependency === './sourceConnections' ? load('sourceConnections') : dependency.startsWith('./') ? stubUrl : pathToFileURL(require.resolve(dependency)).href)));
}
const hooks = await import(hooksUrl), { default: Tags } = await import(load('Tags')), { default: TagTransfer } = await import(load('TagTransfer'));
const definitions = Array.from({ length: 10000 }, (_, index) => ({ path: `[default]Scaling/T${String(index).padStart(5, '0')}`, kind: 'memory', dataType: 'Double', value: index }));
const samples = definitions.map(tag => ({ ...tag, quality: 'Good', timestamp: '2026-09-30T12:00:00Z', source: 'memory' }));
samples.find = () => { throw new Error('Live-value linear scans are not allowed per rendered row.'); };
globalThis.document = { body: {} };
function nodes(element, predicate, result = []) {
  if (Array.isArray(element)) element.forEach(child => nodes(child, predicate, result));
  else if (element && typeof element === 'object') { if (predicate(element)) result.push(element); nodes(element.props?.children, predicate, result); }
  return result;
}
const text = element => Array.isArray(element) ? element.map(text).join('') : element && typeof element === 'object' ? text(element.props?.children) : element == null ? '' : String(element);
const button = (tree, label) => nodes(tree, node => node.type === 'button' && text(node) === label)[0];
const rows = tree => nodes(tree, node => node.type === 'tbody').flatMap(body => nodes(body, node => node.type === 'tr'));
const tags = () => { hooks.begin(); return Tags({ connections: [], tags: samples, onTagsChanged() {}, notify() {} }); };
const transfer = () => { hooks.begin(); return TagTransfer({ onClose() {}, onApplied() {} }); };
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
hooks.seed([[0, definitions]]);
let tree = tags();
check('10,000 live tags render only100 indexed table rows', () => { assert.equal(rows(tree).length, 100); assert.ok(text(tree).includes('1–100 of 10000 tags')); assert.equal(button(tree, 'Previous').props.disabled, true); });
check('last page exposes the final tag and selection stays editable across pages', () => {
  button(tree, 'Last').props.onClick(); tree = tags();
  assert.equal(rows(tree).length, 100); assert.ok(text(tree).includes('9901–10000 of 10000 tags'));
  rows(tree).at(-1).props.onClick(); tree = tags();
  assert.ok(text(tree).includes('Edit tag')); assert.ok(text(tree).includes(definitions.at(-1).path));
  button(tree, 'First').props.onClick(); tree = tags();
  assert.ok(text(tree).includes('1–100 of 10000 tags')); assert.ok(text(tree).includes('Edit tag')); assert.ok(nodes(tree, node => node.type === 'input' && node.props.value === definitions.at(-1).path).length);
});
check('filtering and shrinking results never strands the view on an empty high page', () => {
  button(tree, 'Last').props.onClick(); tree = tags();
  nodes(tree, node => node.type === 'input' && node.props['aria-label'] === 'Filter configured tags')[0].props.onChange({ target: { value: 'T00000' } }); tree = tags();
  assert.equal(rows(tree).length, 1); assert.ok(text(tree).includes('1–1 of 1 tags')); assert.equal(button(tree, 'Next').props.disabled, true);
});
const packageText = JSON.stringify({ format: 'sparkstudio.tags', version: 1, tags: definitions.map(tag => ({ ...tag, enabled: true, publishingIntervalMs: 1000 })) });
assert.ok(Buffer.byteLength(packageText) > 900000 && Buffer.byteLength(packageText) < 32 * 1024 * 1024);
const preview = { revision: 'revision', previewToken: 'token', totalTags: 10000, canApply: true, conflicts: [], changes: definitions.map(tag => ({ path: tag.path, action: 'add', kind: 'memory' })) };
let previewCalls = 0;
globalThis.__tagApi = async (path, method, body) => { assert.equal(path, '/tag-engineering/preview'); assert.equal(method, 'POST'); assert.equal(body.tags.length, 10000); previewCalls++; return preview; };
hooks.seed([[0, packageText]]); tree = transfer(); button(tree, 'Preview import').props.onClick();
await new Promise(resolve => setImmediate(resolve)); tree = transfer();
check('a real10k package over900KB reaches preview and limits rendered changes to100', () => { assert.equal(previewCalls, 1); assert.equal(rows(tree).length, 100); assert.ok(text(tree).includes('of 10000 reviewed changes')); });
check('preview pagination reveals further changes without expanding the DOM', () => { button(tree, 'Next changes').props.onClick(); tree = transfer(); assert.equal(rows(tree).length, 100); assert.ok(text(tree).includes('Showing 101–200 of 10000')); assert.ok(text(rows(tree)[0]).includes(definitions[100].path)); });
nodes(tree, node => node.type === 'input' && node.props.type === 'file')[0].props.onChange({ target: { files: [{ size: 32 * 1024 * 1024 + 1, text() { throw new Error('Oversize files must not be read.'); } }] } });
await new Promise(resolve => setImmediate(resolve)); tree = transfer();
check('files above32MiB are rejected before reading or gateway access', () => { assert.ok(text(tree).includes('Tag files are limited to 32 MiB.')); assert.equal(previewCalls, 1); });
console.log(`${checks} tag manager scaling checks passed.`);
