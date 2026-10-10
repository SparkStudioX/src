import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Pure navigation checks: no running gateway, browser profile or user data.
const file = createTestModuleFiles();
const moduleUrl = file(ts.transpileModule(fs.readFileSync(new URL('src/modelNavigation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const navigation = await import(moduleUrl);
const listeners = new Map(), assigned = [], pushes = [];
const location = { href: 'http://localhost/designer/lab?workspace=models&view=build&type=CNC%402', assign: url => assigned.push(url) };
globalThis.window = { location, history: { state: null, pushState: (_state, _title, url) => { pushes.push(String(url)); location.href = String(url); }, replaceState: (_state, _title, url) => { location.href = String(url); } },
  addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name), dispatchEvent: event => listeners.get(event.type)?.(event) };
globalThis.Element = class {};
let dirty = true, blocked = false, blockedNotices = 0, discarded = 0, proceeded = 0, pending = false, passed = 0;
const check = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const unregister = navigation.registerModelNavigationGuard('alice', { isDirty: () => dirty, isBlocked: () => blocked, onBlocked: () => { blockedNotices++; }, discard: () => { discarded++; dirty = false; } });
const unsubscribe = navigation.subscribeModelNavigation(value => { pending = value; });
const uninstall = navigation.installModelNavigationGuards();
check('Stay keeps the draft and prevents deferred navigation', () => {
  navigation.requestModelNavigation(() => { proceeded++; }); assert.equal(pending, true); assert.equal(proceeded, 0);
  navigation.resolveModelNavigation(false); assert.equal(pending, false); assert.equal(dirty, true); assert.equal(discarded, 0);
});
check('Discard precedes navigation and nested requests do not prompt again', () => {
  navigation.requestModelNavigation(() => navigation.requestModelNavigation(() => { assert.equal(discarded, 1); proceeded++; }));
  navigation.resolveModelNavigation(true); assert.equal(pending, false); assert.equal(proceeded, 1);
});
check('Clean drafts navigate immediately', () => {
  navigation.requestModelNavigation(() => { proceeded++; }); assert.equal(proceeded, 2); assert.equal(pending, false);
});
check('Back restores the active URL while Stay preserves the draft', () => {
  dirty = true; navigation.recordModelNavigationLocation(); const active = location.href;
  location.href = 'http://localhost/'; let stopped = false;
  listeners.get('popstate')({ stopImmediatePropagation: () => { stopped = true; } });
  assert.equal(stopped, true); assert.equal(location.href, active); assert.equal(pending, true);
  navigation.resolveModelNavigation(false); assert.equal(dirty, true); assert.equal(assigned.length, 0);
});
check('Back discard navigates to the originally requested destination', () => {
  location.href = 'http://localhost/gateway'; listeners.get('popstate')({ stopImmediatePropagation() {} });
  navigation.resolveModelNavigation(true); assert.deepEqual(assigned, ['http://localhost/gateway']);
});
check('Changing model views through history stays in the draft', () => {
  dirty = true; location.href = 'http://localhost/designer/lab?workspace=models&view=namespace';
  listeners.get('popstate')({ stopImmediatePropagation: () => assert.fail('must not block Model views') });
  assert.equal(pending, false); assert.equal(dirty, true);
});
check('Project links are intercepted before their ordinary handler', () => {
  let clicked = false, prevented = false, stopped = false;
  const link = { href: 'http://localhost/designer/another', target: '', download: '', click: () => { clicked = true; assert.equal(navigation.modelNavigationDirty(), false); } };
  const target = new Element(); target.closest = () => link;
  listeners.get('click')({ target, button: 0, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert.ok(prevented && stopped && pending); assert.equal(clicked, false);
  navigation.resolveModelNavigation(true); assert.equal(clicked, true);
});
check('Leaving Model clears only its URL fields', () => {
  location.href = 'http://localhost/gateway?workspace=models&view=build&type=CNC%402&keep=1#data';
  navigation.clearModelLocation(); assert.equal(location.href, 'http://localhost/gateway?keep=1#data');
});
check('Opening Models keeps the selected Designer project and uses a top-level workspace', () => {
  location.href = 'http://localhost/designer/lab?workspace=tags#old';
  navigation.openModelsWorkspace();
  assert.equal(location.href, 'http://localhost/designer/lab?workspace=models&view=plant');
});
check('Source handoffs from gateway settings open Models in the default project', () => {
  location.href = 'http://localhost/gateway#data';
  navigation.openModelsWorkspace();
  assert.equal(location.href, 'http://localhost/designer?workspace=models&view=plant');
});
check('An in-flight apply blocks navigation even after its draft clears', () => {
  blocked = true; dirty = false;
  assert.equal(navigation.modelNavigationDirty(), true);
  navigation.requestModelNavigation(() => assert.fail('must wait for apply refresh'));
  assert.equal(pending, false); assert.equal(blockedNotices, 1);
  const active = location.href; navigation.recordModelNavigationLocation();
  location.href = 'http://localhost/projects';
  listeners.get('popstate')({ stopImmediatePropagation() {} });
  assert.equal(location.href, active); assert.equal(pending, false); assert.equal(blockedNotices, 2);
  blocked = false;
});
check('An already pending discard cannot leave during a request', () => {
  dirty = true; const before = discarded;
  navigation.requestModelNavigation(() => assert.fail('cannot leave during request'));
  blocked = true; navigation.resolveModelNavigation(true);
  assert.equal(discarded, before); assert.equal(dirty, true); assert.equal(pending, false);
  blocked = false;
});
check('Back from a dirty Tags workspace to Models still requires a decision', () => {
  dirty = true; location.href = 'http://localhost/workspace?workspace=tags'; navigation.recordModelNavigationLocation();
  location.href = 'http://localhost/workspace?workspace=models'; let stopped=false;
  listeners.get('popstate')({stopImmediatePropagation(){stopped=true;}});
  assert.equal(stopped,true);assert.equal(location.href,'http://localhost/workspace?workspace=tags');assert.equal(pending,true);
  navigation.resolveModelNavigation(false);assert.equal(dirty,true);
});
check('Identity cleanup cancels pending navigation and unregisters dirty state', () => {
  dirty = true; navigation.requestModelNavigation(() => assert.fail('old account action')); navigation.clearModelNavigation();
  navigation.resolveModelNavigation(true); assert.equal(pending, false); assert.equal(navigation.modelNavigationDirty(), false);
});
uninstall(); unsubscribe(); unregister();
console.log(`${passed} Model navigation checks passed.`);
