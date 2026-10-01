import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(moduleUrl(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  modules.set(name, url); return url;
}
const { discoverComponentMessageReceivers: discover } = await import(moduleUrl('componentMessageReceivers'));
const handler = (scope = 'screen', messageType = 'check-in', id = `listen-${scope}`) => ({ id, scope, messageType, language: 'javascript', code: 'app.notify("received");' });
const component = (id, props = {}, type = 'label') => ({ id, type, x: 0, y: 0, width: 100, height: 40, props });
const receiver = (id, scope = 'screen', messageType = 'check-in', extra = {}) => component(id, { messageHandlers: [handler(scope, messageType)], ...extra });
const document = (id, components = [], changes = {}) => ({ id, name: id, width: 800, height: 600, components, ...changes });
const template = (id, components = []) => document(id, components, { parameters: {} });
const placement = (id, templateId, type = 'template') => component(id, { templateId }, type);
const options = (project, current = project.screens[0], scope = 'screen', messageType = 'check-in', changes = {}) => ({ project, document: current, documentKind: 'screen', scope, messageType, ...changes });
const names = result => result.receivers.map(value => value.componentId);
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('message types and scopes match exactly, while unrelated root screens remain visibly elsewhere', () => {
  const project = { screens: [document('welcome', [receiver('local'), receiver('session-only', 'session'), receiver('different-case', 'screen', 'Check-in')]), document('other', [receiver('other-screen')])], templates: [] };
  const result = discover(options(project));
  assert.deepEqual(names(result), ['local', 'other-screen']);
  assert.equal(result.receivers[0].applicability, 'possible');
  assert.equal(result.receivers[1].applicability, 'elsewhere');
  assert.match(result.receivers[1].reason, /Another root screen/);
  assert.deepEqual(new Set(result.messageTypes), new Set(['check-in', 'Check-in']));
  assert.deepEqual(names(discover(options(project, undefined, 'screen', 'Check-in'))), ['different-case']);
  assert.deepEqual(names(discover(options(project, undefined, 'screen', '  check-in  '))), ['local', 'other-screen']);
  assert.equal(result.receivers[0].componentType, 'label');
});
check('instance scope stays in the current form and excludes nested template forms', () => {
  const project = { screens: [document('welcome', [receiver('local', 'instance'), placement('card', 'card')])], templates: [template('card', [receiver('nested', 'instance')])] };
  const result = discover(options(project, undefined, 'instance'));
  assert.equal(result.receivers.find(value => value.componentId === 'local').applicability, 'possible');
  const nested = result.receivers.find(value => value.componentId === 'nested');
  assert.equal(nested.applicability, 'elsewhere'); assert.match(nested.reason, /Different form/);
  const editing = discover(options(project, project.templates[0], 'instance', 'check-in', { documentKind: 'template' }));
  assert.equal(editing.receivers.find(value => value.componentId === 'nested').applicability, 'possible');
  assert.equal(editing.receivers.find(value => value.componentId === 'local').applicability, 'elsewhere');
});
check('screen scope includes four nested template levels without crossing popup boundaries', () => {
  const templates = Array.from({ length: 4 }, (_value, index) => template('level-' + index,
    [receiver('listener-' + index), ...(index < 3 ? [placement('child-' + index, 'level-' + (index + 1))] : [])]));
  const project = { screens: [document('welcome', [placement('first', 'level-0')]), document('inspection', [receiver('popup')], { kind: 'popup' })], templates };
  const result = discover(options(project));
  assert.equal(result.truncated, false);
  for (let index = 0; index < 4; index++) assert.equal(result.receivers.find(value => value.componentId === 'listener-' + index).applicability, 'possible');
  assert.equal(result.receivers.find(value => value.componentId === 'popup').applicability, 'elsewhere');
});
check('template definitions deduplicate across placements and report repeater multiplicity', () => {
  const project = { screens: [document('welcome', [placement('left', 'card'), placement('right', 'card', 'repeater')])], templates: [template('card', [receiver('listener')])] };
  const result = discover(options(project));
  assert.equal(result.receivers.length, 1); assert.equal(result.receivers[0].locations.length, 2);
  assert.ok(result.receivers[0].locations.some(value => /left/.test(value)));
  assert.ok(result.receivers[0].locations.some(value => /right/.test(value)));
  assert.equal(result.receivers[0].repeated, true); assert.match(result.receivers[0].reason, /per mounted repeater row/);
  assert.equal(discover(options(project)).receivers[0].key, result.receivers[0].key);
});
check('session scope lists possible active screens and open popups without treating unplaced templates as mounted', () => {
  const project = { screens: [document('welcome', [receiver('local', 'session')]), document('other', [receiver('other', 'session')]), document('popup', [receiver('popup', 'session')], { kind: 'popup' })], templates: [template('unused', [receiver('unused', 'session')])] };
  const result = discover(options(project, undefined, 'session'));
  assert.equal(result.receivers.filter(value => value.applicability === 'possible').length, 3);
  assert.equal(result.receivers.find(value => value.componentId === 'unused').applicability, 'unplaced');
  assert.match(result.notes.join(' '), /this browser tab/); assert.match(result.notes.join(' '), /popup only while open/);
});
check('an unplaced template remains inspectable locally without implying a mounted session receiver', () => {
  const current = template('unplaced', [component('controller', { messageHandlers: [handler('session'), handler('screen'), handler('instance')] })]);
  const project = { screens: [document('welcome')], templates: [current] };
  const localOptions = scope => options(project, current, scope, 'check-in', { documentKind: 'template' });
  const session = discover(localOptions('session')).receivers[0];
  assert.equal(session.applicability, 'unplaced'); assert.deepEqual(session.locations, []);
  assert.match(session.reason, /no authored placement/);
  for (const scope of ['screen', 'instance']) {
    const local = discover(localOptions(scope)).receivers[0];
    assert.equal(local.applicability, 'possible'); assert.equal(local.locations.length, 1);
  }
  project.screens[0].components.push(placement('card', current.id));
  const placed = discover(localOptions('session')).receivers[0];
  assert.equal(placed.applicability, 'possible'); assert.equal(placed.locations.length, 1);
  assert.match(placed.locations[0], /Screen welcome/);
});
check('tab and dock receivers expose activation conditions and retain their pane paths', () => {
  const tabs = component('tabs', { viewLayout: { kind: 'tabs', panes: [{ id: 'first', label: 'Registration', templateId: 'tab' }, { id: 'second', label: 'Badge', templateId: 'other' }] } }, 'viewContainer');
  const dock = component('dock', { viewLayout: { kind: 'dock', panes: [{ id: 'center', label: 'Main', edge: 'center', templateId: 'other' }, { id: 'side', label: 'Details', edge: 'right', templateId: 'side' }] } }, 'viewContainer');
  const project = { screens: [document('welcome', [tabs, dock])], templates: [template('tab', [receiver('tab-listener')]), template('other', [receiver('other-listener')]), template('side', [receiver('side-listener')])] };
  const result = discover(options(project));
  assert.match(result.receivers.find(value => value.componentId === 'tab-listener').reason, /tab must be active/);
  const side = result.receivers.find(value => value.componentId === 'side-listener');
  assert.match(side.reason, /dock panel must be open/); assert.match(side.locations[0], /Details/);
  assert.equal(result.receivers.find(value => value.componentId === 'other-listener').locations.length, 2);
});
check('template authoring shows receivers in containing screens and excludes unrelated roots', () => {
  const card = template('card', [receiver('card-listener'), placement('child', 'nested')]);
  const project = { screens: [document('line-a', [placement('placed', 'card'), receiver('parent-a')]), document('line-b', [placement('another', 'card'), receiver('parent-b')]), document('unrelated', [receiver('different-root')])], templates: [card, template('nested', [receiver('child-listener')])] };
  const result = discover(options(project, card, 'screen', 'check-in', { documentKind: 'template' }));
  for (const id of ['card-listener', 'child-listener', 'parent-a', 'parent-b']) assert.equal(result.receivers.find(value => value.componentId === id).applicability, 'possible');
  assert.equal(result.receivers.find(value => value.componentId === 'different-root').applicability, 'elsewhere');
  assert.match(result.receivers[0].reason, /containing screen/);
});
check('the current document and staged handler override supersede saved definitions without mutation', () => {
  const saved = document('welcome', [receiver('controller', 'screen', 'old-type')]);
  const current = structuredClone(saved); current.components[0].props.text = 'Draft controller';
  const project = { screens: [saved], templates: [] }, before = JSON.stringify({ project, current });
  const result = discover(options(project, current, 'screen', 'new-type', { override: { componentId: 'controller', handlers: [handler('screen', 'new-type')] } }));
  assert.deepEqual(result.messageTypes, ['new-type']); assert.equal(result.receivers.length, 1);
  assert.equal(result.receivers[0].componentName, 'Draft controller');
  assert.equal(JSON.stringify({ project, current }), before);
  assert.equal(discover(options(project, current, 'screen', 'new-type', { override: { componentId: 'controller', handlers: [] } })).receivers.length, 0);
});
check('hidden and disabled receivers remain discoverable, and empty code is described as unconfigured', () => {
  const hidden = receiver('hidden', 'screen', 'check-in', { text: '  Controller  ', visible: false, enabled: false });
  const empty = receiver('empty'); empty.props.messageHandlers[0].code = '';
  const project = { screens: [document('welcome', [hidden, empty])], templates: [] };
  const result = discover(options(project));
  assert.equal(result.receivers.length, 2);
  assert.equal(result.receivers.find(value => value.componentId === 'hidden').componentName, 'Controller');
  assert.equal(result.receivers.find(value => value.componentId === 'hidden').applicability, 'possible');
  assert.equal(result.receivers.find(value => value.componentId === 'empty').ready, false);
  assert.match(result.receivers.find(value => value.componentId === 'empty').reason, /Add handler code/);
});
check('invalid message types are omitted and discovery never parses or executes authored code', () => {
  const valid = receiver('valid'); valid.props.messageHandlers[0].code = 'throw new Error("must never run")';
  const project = { screens: [document('welcome', [valid, receiver('spaced', 'screen', ' check-in '), receiver('control', 'screen', 'check\nin')])], templates: [] };
  const result = discover(options(project));
  assert.deepEqual(names(result), ['valid']); assert.deepEqual(result.messageTypes, ['check-in']);
  assert.match(result.notes.join(' '), /invalid message types/);
  assert.equal(discover(options(project, undefined, 'screen', '')).receivers.length, 0);
});
check('screen and template IDs may coincide without merging their forms', () => {
  const project = { screens: [document('same', [receiver('screen', 'instance'), placement('placed', 'same')])], templates: [template('same', [receiver('template', 'instance')])] };
  const result = discover(options(project, undefined, 'instance'));
  assert.equal(result.receivers.find(value => value.componentId === 'screen').applicability, 'possible');
  assert.equal(result.receivers.find(value => value.componentId === 'template').applicability, 'elsewhere');
  assert.notEqual(result.receivers[0].key, result.receivers[1].key);
});
check('missing templates, cycles and excessive depth terminate and report incomplete static inspection', () => {
  const cycle = template('cycle', [receiver('cycle-listener'), placement('again', 'cycle')]);
  const deep = Array.from({ length: 5 }, (_value, index) => template('deep-' + index, [receiver('deep-listener-' + index), ...(index < 4 ? [placement('next', 'deep-' + (index + 1))] : [])]));
  const project = { screens: [document('welcome', [placement('loop', 'cycle'), placement('missing', 'absent'), placement('deep', 'deep-0')])], templates: [cycle, ...deep] };
  const result = discover(options(project));
  assert.equal(result.truncated, true); assert.match(result.notes.join(' '), /cycle/); assert.match(result.notes.join(' '), /missing template/);
  assert.equal(result.receivers.find(value => value.componentId === 'cycle-listener').locations.length, 1);
  const uninspected = result.receivers.find(value => value.componentId === 'deep-listener-4');
  assert.equal(uninspected.applicability, 'uninspected'); assert.match(uninspected.reason, /beyond the inspection limit/);
  assert.doesNotMatch(uninspected.reason, /no authored placement/);
});
check('a suggestion limit does not imply that complete placement inspection was truncated', () => {
  const suggestions = Array.from({ length: 513 }, (_value, index) => receiver('suggestion-' + index, 'session', 'type-' + index));
  const project = { screens: [document('welcome', suggestions)], templates: [template('unused', [receiver('unused', 'session')])] };
  const result = discover(options(project, undefined, 'session'));
  assert.equal(result.truncated, true); assert.equal(result.messageTypes.length, 512);
  assert.equal(result.receivers[0].applicability, 'unplaced');
  assert.match(result.receivers[0].reason, /no authored placement/);
});

console.log(`${checks} authored component-message receiver checks passed.`);
