#!/usr/bin/env node
// Offline immutable authoring previews. No gateway, script execution or dependencies.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const dataModule = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const searchUrl = dataModule(await readFile(new URL('../apps/web/src/projectSearch.ts', import.meta.url), 'utf8'));
const navigationUrl = dataModule(await readFile(new URL('../apps/web/src/runtimeNavigation.ts', import.meta.url), 'utf8'));
const modelSource = (await readFile(new URL('../apps/web/src/resourceChanges.ts', import.meta.url), 'utf8'))
  .replace('from "./projectSearch";', `from "${searchUrl}";`)
  .replace('from "./runtimeNavigation";', `from "${navigationUrl}";`);
const { planResourceChange, applyResourceChange } = await import(dataModule(modelSource));
const component = (id, type = 'label', props = {}, groupId) => ({ id, type, x: 10, y: 10, width: 100, height: 40, props, ...(groupId ? { groupId } : {}) });
const binding = reference => ({ expression: 'value', references: { value: reference } });
const fixture = () => ({
  id: 'resource-change-fixture', name: 'Resource changes', revision: 12, parameters: {},
  navigation: { startupScreenId: 'home', mode: 'menu', items: [{ screenId: 'home', label: 'My start' }, { screenId: 'other', label: 'Other page' }] },
  screens: [
    { id: 'home', name: 'Home screen', width: 1000, height: 700, components: [
      component('quantity', 'numberInput', { fieldKey: 'requestedAmount', customProperties: { maximum: { type: 'number', value: 20 } } }, 'batch-fields'),
      component('caption', 'label', { bindings: { text: binding({ kind: 'custom', componentId: 'quantity', key: 'maximum' }) } }, 'batch-fields'),
      component('display', 'label', { bindings: { text: binding({ kind: 'input', key: 'requestedAmount' }) } }),
      component('card', 'template', { templateId: 'card-template' }),
      component('popup-button', 'button', { targetScreenId: 'popup', action: 'openPopup' }),
    ] },
    { id: 'other', name: 'Other screen', width: 800, height: 600, components: [
      component('quantity', 'numberInput', { fieldKey: 'requestedAmount' }),
      component('caption', 'label', { bindings: { text: binding({ kind: 'custom', componentId: 'quantity', key: 'maximum' }) } }),
    ] },
    { id: 'popup', name: 'Details', kind: 'popup', width: 500, height: 300, components: [component('self', 'button', { targetScreenId: 'popup', action: 'openPopup' })] },
  ],
  templates: [
    { id: 'card-template', name: 'Production card', width: 300, height: 200, parameters: { label: 'Card' }, instanceState: { active: { type: 'boolean', value: false } }, components: [component('nested', 'template', { templateId: 'detail-template' })] },
    { id: 'detail-template', name: 'Detail card', width: 300, height: 100, parameters: {}, components: [] },
  ],
});
const queries = [{ id: 'sample', name: 'Summary', connectionId: 'sample', kind: 'query', sql: 'SELECT 1 AS amount', parameters: [] }];
const scripts = [{ id: 'client-start', name: 'Client start', type: 'client', enabled: false, event: 'startup', code: '/* requestedAmount */', revision: 3 }];
const deletion = target => ({ action: 'delete', target });
const rename = (kind, id, name) => ({ action: 'rename', target: { kind, id }, name });
const selected = ids => deletion({ kind: 'components', ownerKind: 'screen', ownerId: 'home', ids });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('screen rename trims display name and retains stable identity, component links and custom menu labels', () => {
  const project = fixture(); project.screens[1].components.push(component('go-home', 'button', { targetScreenId: 'home' }));
  freeze(project); const before = JSON.stringify(project);
  const plan = planResourceChange(project, queries, scripts, rename('screen', 'home', '  Operations  '));
  assert.deepEqual(plan.errors, []); assert.deepEqual(plan.blockingReferences, []);
  assert.equal(plan.beforeName, 'Home screen'); assert.equal(plan.afterName, 'Operations');
  assert.equal(plan.retainedReferences.length, 3);
  const next = applyResourceChange(plan, project, queries, scripts);
  assert.equal(next.screens[0].id, 'home'); assert.equal(next.screens[0].name, 'Operations');
  assert.deepEqual(next.navigation, project.navigation);
  assert.equal(next.screens[1].components.at(-1).props.targetScreenId, 'home');
  assert.equal(JSON.stringify(project), before); assert.equal(next.revision, 12);
});
check('template rename retains instances, template parameters and private state', () => {
  const project = freeze(fixture());
  const plan = planResourceChange(project, queries, scripts, rename('template', 'card-template', 'Station card'));
  assert.equal(plan.retainedReferences.length, 1);
  const next = applyResourceChange(plan, project, queries, scripts);
  assert.equal(next.templates[0].name, 'Station card'); assert.equal(next.templates[0].id, 'card-template');
  assert.deepEqual(next.templates[0].parameters, project.templates[0].parameters);
  assert.deepEqual(next.templates[0].instanceState, project.templates[0].instanceState);
  assert.equal(next.screens[0].components.find(item => item.id === 'card').props.templateId, 'card-template');
});
check('empty, overlong, control-character and no-op names cannot apply', () => {
  const project = fixture();
  for (const name of ['  ', 'A'.repeat(121), 'Bad\nname', '  Home screen  ']) {
    const plan = planResourceChange(project, queries, scripts, rename('screen', 'home', name));
    assert.ok(plan.errors.length, JSON.stringify(name)); assert.equal(plan.nextProject, null);
    assert.throws(() => applyResourceChange(plan, project, queries, scripts));
  }
  assert.deepEqual(planResourceChange(project, queries, scripts, rename('screen', 'home', 'A'.repeat(120))).errors, []);
});
check('missing documents and invalid or empty component selections are blocked', () => {
  const project = fixture();
  for (const request of [deletion({ kind: 'screen', id: 'absent' }), rename('template', 'absent', 'Name'), selected([]), selected(['quantity', 'absent'])]) {
    const plan = planResourceChange(project, queries, scripts, request);
    assert.ok(plan.errors.length); assert.equal(plan.nextProject, null);
    assert.throws(() => applyResourceChange(plan, project, queries, scripts));
  }
});
check('last regular screen cannot be deleted even when popup screens remain', () => {
  const project = fixture(); project.screens = project.screens.filter(item => item.id !== 'other');
  const plan = planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'home' }));
  assert.match(plan.errors.join(' '), /regular screen/); assert.equal(plan.nextProject, null);
  assert.throws(() => applyResourceChange(plan, project, queries, scripts), /regular screen/);
});
check('screen deletion previews navigation cleanup in one immutable project result', () => {
  const project = freeze(fixture()); const before = JSON.stringify(project);
  const plan = planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'home' }));
  assert.deepEqual(plan.blockingReferences, []); assert.deepEqual(plan.retainedReferences, []);
  assert.ok(plan.notices.some(notice => notice.includes('menu item')));
  assert.ok(plan.notices.some(notice => notice.includes('Other screen')));
  const next = applyResourceChange(plan, project, queries, scripts);
  assert.deepEqual(next.screens.map(item => item.id), ['other', 'popup']);
  assert.deepEqual(next.navigation, { startupScreenId: 'other', mode: 'menu', items: [{ screenId: 'other', label: 'Other page' }] });
  assert.deepEqual(next.templates, project.templates); assert.equal(JSON.stringify(project), before);
  // The original history checkpoint contains both the screen and its navigation.
  assert.equal(project.navigation.startupScreenId, 'home'); assert.equal(project.navigation.items.length, 2);
  assert.equal(project.screens[0].components.length, 5);
});
check('legacy projects without explicit navigation stay legacy after deletion', () => {
  const project = fixture(); delete project.navigation;
  const next = applyResourceChange(planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'home' })), project, queries, scripts);
  assert.equal(next.navigation, undefined); assert.equal(next.screens[0].id, 'other');
});
check('external screen links block deletion while references inside deleted screen do not', () => {
  const project = fixture();
  let plan = planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'popup' }));
  assert.deepEqual(plan.blockingReferences.map(entry => entry.target.componentId), ['popup-button']);
  assert.equal(plan.nextProject, null); assert.throws(() => applyResourceChange(plan, project, queries, scripts), /still used/);
  project.screens[0].components = project.screens[0].components.filter(item => item.id !== 'popup-button');
  plan = planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'popup' }));
  assert.deepEqual(plan.blockingReferences, []); assert.equal(applyResourceChange(plan, project, queries, scripts).screens.length, 2);
});
check('invalid popup navigation is not silently treated as managed regular-screen navigation', () => {
  const project = fixture(); project.navigation.items.push({ screenId: 'popup', label: 'Invalid popup' });
  project.screens[0].components = project.screens[0].components.filter(item => item.id !== 'popup-button');
  const plan = planResourceChange(project, queries, scripts, deletion({ kind: 'screen', id: 'popup' }));
  assert.equal(plan.blockingReferences.length, 1); assert.equal(plan.blockingReferences[0].target.kind, 'project');
});
check('template instances and nested template instances are structured deletion blockers', () => {
  const project = fixture();
  const card = planResourceChange(project, queries, scripts, deletion({ kind: 'template', id: 'card-template' }));
  assert.deepEqual(card.blockingReferences.map(entry => entry.target.componentId), ['card']);
  const detail = planResourceChange(project, queries, scripts, deletion({ kind: 'template', id: 'detail-template' }));
  assert.deepEqual(detail.blockingReferences.map(entry => entry.target.componentId), ['nested']);
  assert.equal(detail.blockingReferences[0].target.kind, 'template');
  project.screens[0].components = project.screens[0].components.filter(item => item.id !== 'card');
  project.templates[0].components.push(component('self', 'template', { templateId: 'card-template' }));
  const self = planResourceChange(project, queries, scripts, deletion({ kind: 'template', id: 'card-template' }));
  assert.deepEqual(self.blockingReferences, []);
  assert.deepEqual(applyResourceChange(self, project, queries, scripts).templates.map(item => item.id), ['detail-template']);
});
check('group deletion expands selection, ignores internal uses and blocks external input bindings', () => {
  const project = fixture();
  const plan = planResourceChange(project, queries, scripts, selected(['quantity']));
  assert.deepEqual(plan.componentIds, ['quantity', 'caption']);
  assert.ok(plan.notices.some(notice => notice.includes('grouped')));
  assert.deepEqual(plan.blockingReferences.map(entry => entry.target.componentId), ['display']);
  assert.equal(plan.blockingReferences[0].target.property, 'props.bindings.text.references.value');
  assert.equal(plan.nextProject, null);
  project.screens[0].components = project.screens[0].components.filter(item => item.id !== 'display');
  const safe = planResourceChange(project, queries, scripts, selected(['quantity']));
  assert.deepEqual(safe.blockingReferences, []);
  const next = applyResourceChange(safe, project, queries, scripts);
  assert.deepEqual(next.screens[0].components.map(item => item.id), ['card', 'popup-button']);
  assert.deepEqual(next.screens[1].components, project.screens[1].components, 'Identical component IDs in other documents are independent.');
});
check('explicit multi-selection removes references between selected components atomically', () => {
  const project = freeze(fixture());
  const plan = planResourceChange(project, queries, scripts, selected(['quantity', 'display']));
  assert.deepEqual(plan.componentIds, ['quantity', 'caption', 'display']); assert.deepEqual(plan.blockingReferences, []);
  const next = applyResourceChange(plan, project, queries, scripts);
  assert.equal(next.screens[0].components.length, 2); assert.equal(project.screens[0].components.length, 5);
});
check('table and query choice selection mappings block deletion of their target input', () => {
  const project = fixture(); project.screens[0].components = [component('amount', 'numberInput', { fieldKey: 'amountKey' }),
    component('table', 'table', { queryId: 'sample', rowKey: 'id', selectionFields: { amountKey: 'amount' } }),
    component('choice', 'select', { fieldKey: 'chosen', optionsSource: { queryId: 'sample', valueColumn: 'id', labelColumn: 'name' }, selectionFields: { amountKey: 'amount' } }),
  ];
  const plan = planResourceChange(project, queries, scripts, selected(['amount']));
  assert.deepEqual(plan.blockingReferences.map(entry => entry.target.componentId), ['table', 'choice']);
  assert.ok(plan.blockingReferences.every(entry => entry.target.property === 'props.selectionFields.amountKey'));
  const together = planResourceChange(project, queries, scripts, selected(['amount', 'table', 'choice']));
  assert.deepEqual(together.blockingReferences, []); assert.equal(together.nextProject.screens[0].components.length, 0);
});
check('template component deletion resolves input, parameter and query parameter binding uses in owner scope', () => {
  const project = fixture(); const template = project.templates[0];
  template.components = [component('amount', 'numberInput', { fieldKey: 'amountKey' }),
    component('instance', 'template', { templateId: 'detail-template', parameterBindings: { amount: binding({ kind: 'input', key: 'amountKey' }) } }),
    component('bound', 'label', { queryBindings: { text: { queryId: 'sample', column: 'amount', parameters: { amount: binding({ kind: 'custom', componentId: 'amount', key: 'limit' }) } } } }),
  ];
  const plan = planResourceChange(project, queries, scripts, deletion({ kind: 'components', ownerKind: 'template', ownerId: 'card-template', ids: ['amount'] }));
  assert.deepEqual(plan.blockingReferences.map(entry => entry.target.componentId), ['instance', 'bound']);
  assert.ok(plan.blockingReferences.every(entry => entry.target.id === 'card-template'));
});
check('literal code and SQL hints are external, nonblocking and never executed or rewritten', () => {
  const project = fixture(); project.screens[0].components = [component('victim', 'button', { fieldKey: 'requestedAmount', script: 'globalThis.resourceFixtureExecuted = true; /* victim */' })];
  project.screens[1].components.push(component('handler', 'button', { script: '/* VICTIM */', events: { commit: { language: 'javascript', code: '/* requestedAmount */' } } }));
  const sql = [{ ...queries[0], sql: "SELECT 'victim' AS note" }];
  const plan = planResourceChange(project, sql, scripts, selected(['victim']));
  assert.deepEqual(plan.blockingReferences, []); assert.equal(plan.textMatches.length, 4);
  assert.ok(plan.textMatches.every(entry => entry.textOnly && !(entry.target.kind === 'screen' && entry.target.id === 'home')));
  assert.ok(plan.notices.some(notice => notice.includes('Dynamic references')));
  const next = applyResourceChange(plan, project, sql, scripts);
  assert.equal(next.screens[0].components.length, 0); assert.deepEqual(next.screens[1].components, project.screens[1].components);
  assert.equal(globalThis.resourceFixtureExecuted, undefined);
});
check('text matching searches authored code, not the source property path or location', () => {
  const project = fixture(); project.screens[0].components = [component('script')];
  project.screens[1].components.push(component('safe', 'button', { script: 'return 1;' }));
  const plan = planResourceChange(project, [], [], selected(['script']));
  assert.equal(plan.textMatches.length, 0);
});
check('rename hints include stable IDs and old names without rewriting source', () => {
  const project = fixture();
  const source = [{ ...scripts[0], code: '/* Home screen; dynamic lookup of home */' }];
  const plan = planResourceChange(project, queries, source, rename('screen', 'home', 'Operations'));
  assert.equal(plan.textMatches.length, 1); assert.equal(plan.nextProject.screens[0].name, 'Operations');
  assert.equal(source[0].code, '/* Home screen; dynamic lookup of home */');
});
check('stale previews reject unrelated local project edits and server revision changes', () => {
  const project = fixture(); const plan = planResourceChange(project, queries, scripts, rename('screen', 'home', 'Operations'));
  for (const change of [draft => { draft.revision++; }, draft => { draft.screens[1].width++; }, draft => { draft.parameters.newValue = 'x'; }]) {
    const current = structuredClone(project); change(current);
    assert.throws(() => applyResourceChange(plan, current, queries, scripts), /stale/);
  }
});
check('query and script editor draft or revision changes invalidate a preview', () => {
  const project = fixture(); const plan = planResourceChange(project, queries, scripts, rename('screen', 'home', 'Operations'));
  const changedQueries = structuredClone(queries); changedQueries[0].sql = 'SELECT 2 AS amount';
  assert.throws(() => applyResourceChange(plan, project, changedQueries, scripts), /stale/);
  const changedScripts = structuredClone(scripts); changedScripts[0].code += ' /* draft */';
  assert.throws(() => applyResourceChange(plan, project, queries, changedScripts), /stale/);
  changedScripts[0].code = scripts[0].code; changedScripts[0].revision++;
  assert.throws(() => applyResourceChange(plan, project, queries, changedScripts), /stale/);
});
check('preview owns its request, ignores tampered output and rejects a changed request', () => {
  const project = fixture(); const request = rename('screen', 'home', 'Operations');
  const plan = planResourceChange(project, queries, scripts, request);
  request.name = 'Outside mutation'; assert.equal(plan.request.name, 'Operations');
  plan.nextProject.screens[0].name = 'Tampered result';
  assert.equal(applyResourceChange(plan, project, queries, scripts).screens[0].name, 'Operations');
  plan.request.name = 'Changed request'; assert.throws(() => applyResourceChange(plan, project, queries, scripts), /stale/);
});
console.log(`${passed} resource change groups passed.`);
