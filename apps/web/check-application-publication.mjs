import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooks = moduleUrl(`export const useState = initial => { const index = globalThis.__publicationCursor++; if (!(index in globalThis.__publicationState)) globalThis.__publicationState[index] = initial; return [globalThis.__publicationState[index], next => { globalThis.__publicationState[index] = typeof next === 'function' ? next(globalThis.__publicationState[index]) : next; }]; }; export const useRef = () => ({current:null}); export const useEffect = callback => { globalThis.__publicationEffects.push(callback); };`);
const portal = moduleUrl('export const createPortal = value => value;');
const api = moduleUrl('export const api = (...args) => globalThis.__publicationApi(...args);');
const source = fs.readFileSync(new URL('./src/ApplicationPublishDialog.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/from "([^"]+)"/g, (_, name) => `from ${JSON.stringify(name === 'react' ? hooks : name === 'react-dom' ? portal : name === './api' ? api : pathToFileURL(require.resolve(name)).href)}`);
const { default: Dialog } = await import(moduleUrl(code));
globalThis.document = { body: {} };
const review = { name: 'Dispatch', revision: 7, scriptsRevision: 4, reviewToken: 'saved-complete-hash', screens: 2, templates: 1, queries: 3,
  resources: [{ name: 'release', type: 'library', enabled: true }, { name: 'startup', type: 'gateway', event: 'startup', enabled: false }] };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);
function reset(state = [structuredClone(review), false, '']) { globalThis.__publicationState = state; globalThis.__publicationEffects = []; }
function render(props = {}) { globalThis.__publicationCursor = 0; return Dialog({ onClose() {}, onPublished() {}, ...props }); }
const flush = () => new Promise(resolve => setImmediate(resolve));

reset(); let received;
globalThis.__publicationApi = async (...args) => { received = args; return { published: true, revision: 7, scriptsRevision: 4 }; };
let published;
let tree = render({ onPublished: result => { published = result; } });
await button(tree, 'Publish application').props.onClick(); await flush();
assert.deepEqual(received, ['/project/publish', 'POST', { revision: 7, scriptsRevision: 4, reviewToken: review.reviewToken }]);
assert.deepEqual(published, { published: true, revision: 7, scriptsRevision: 4 });
console.log('PASS confirmation sends the reviewed project, script revision and complete-resource token');

reset(); globalThis.__publicationApi = async () => { throw new Error('Saved query changed. Review again.'); };
await button(render(), 'Publish application').props.onClick(); await flush(); tree = render();
assert.equal(globalThis.__publicationState[0], null); assert.match(globalThis.__publicationState[2], /Saved query changed/);
assert.equal(button(tree, 'Publish application').props.disabled, true);
console.log('PASS stale or failed publication invalidates the review and prevents a blind retry');

for (const props of [{ projectRevision: 6 }, { scriptsRevision: 3 }]) {
  reset([null, false, '']); globalThis.__publicationApi = async () => structuredClone(review);
  render(props); globalThis.__publicationEffects[0](); await flush(); tree = render(props);
  assert.equal(globalThis.__publicationState[0], null); assert.match(globalThis.__publicationState[2], /workspace loaded/);
  assert.equal(button(tree, 'Publish application').props.disabled, true);
}
console.log('PASS outdated Designer and Scripting workspaces cannot confirm a newer unseen saved draft');

reset([null, false, '']); globalThis.__publicationApi = async () => structuredClone(review);
render({ projectRevision: 7, scriptsRevision: 4 }); globalThis.__publicationEffects[0](); await flush(); tree = render();
assert.equal(button(tree, 'Publish application').props.disabled, false);
assert.ok(nodes(tree).some(node => node.type === 'td' && node.props.children === 'Disabled'));
console.log('PASS matching review exposes enabled/disabled resource states before confirmation');
console.log('PASS 4 application publication UI groups');
