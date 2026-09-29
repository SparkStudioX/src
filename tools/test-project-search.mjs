#!/usr/bin/env node
// Offline authoring search checks. Node 22.17+; no running gateway or packages needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../apps/web/src/projectSearch.ts', import.meta.url), 'utf8');
const { buildProjectSearch, searchProject, findProjectReferences } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const component = (id, type, props = {}) => ({ id, type, x: 12, y: 24, width: 180, height: 60, props });
const binding = (expression, references = {}) => ({ expression, references });
const project = {
  id: 'project-search-fixture', name: 'Resource workshop', revision: 7, parameters: { line: 'North' },
  sessionState: { batch: { type: 'number', value: 3 } },
  navigation: { startupScreenId: 'home', mode: 'menu', items: [{ screenId: 'home', label: 'Overview' }, { screenId: 'deleted-screen', label: 'Retired station' }] },
  screens: [
    { id: 'home', name: 'Production home', width: 960, height: 700, parameters: { machine: 'A' }, state: { note: { type: 'string', value: 'Hold North' } }, components: [
      component('qty', 'numberInput', { text: 'Quantity', fieldKey: 'quantity', customProperties: { limit: { type: 'number', value: 25 } } }),
      component('table', 'table', { text: 'Work orders', queryId: 'orders', tableEdit: { versionColumn: 'version', columns: [], script: 'result = "orders"' } }),
      component('select', 'select', { text: 'Choose order', optionsSource: { queryId: 'orders', valueColumn: 'id', labelColumn: 'name' } }),
      component('card', 'template', { templateId: 'machine-card', parameters: { line: 'West' }, parameterBindings: {
        amount: binding('input + local', { input: { kind: 'input', key: 'quantity' }, local: { kind: 'custom', componentId: 'qty', key: 'limit' } }),
      } }),
      component('repeat', 'repeater', { templateId: 'machine-card', rowsSource: { queryId: 'orders', rowKey: 'id', parameterMap: { label: 'name' } } }),
      component('gauge', 'gauge', { text: 'North pressure', tagPath: '[default]North/{machine}/Pressure', bindings: {
        max: binding('local', { local: { kind: 'custom', componentId: 'qty', key: 'limit' } }),
        min: binding('missing', { missing: { kind: 'custom', componentId: 'deleted-component', key: 'limit' } }),
        value: binding('reading', { reading: { kind: 'tag', path: '[default]North/{machine}/Flow' } }),
      }, queryBindings: { width: { queryId: 'dimension', column: 'width', parameters: { batch: binding('selected', { selected: { kind: 'sessionState', key: 'batch' } }) } } } }),
      component('open', 'button', { text: 'Open inspector', action: 'openPopup', targetScreenId: 'inspector', script: 'globalThis.searchFixtureExecuted = true; /* orders */' }),
      component('logo', 'image', { assetId: 'unloaded-asset', alt: 'North line logo', metadata: { references: { label: { kind: 'tag', path: 'literal-metadata-tag' } } } }),
      component('missing', 'template', { templateId: 'deleted-template', queryId: 'deleted-query' }),
      component('sensor', 'value', { text: 'Token [x] .*', componentEvents: { mount: { language: 'javascript', code: '/* orders: literal code, not dependency */' }, propertyChange: { language: 'javascript', code: 'return;', properties: ['text'] } }, events: { commit: { language: 'javascript', code: '/* input handler */' } } }),
    ] },
    { id: 'inspector', name: 'Order inspector', kind: 'popup', width: 420, height: 300, components: [component('qty', 'numberInput', { text: 'Popup quantity' })] },
  ],
  templates: [{ id: 'machine-card', name: 'Machine card', width: 320, height: 220, parameters: { line: 'East' }, parameterTypes: { line: 'string' }, instanceState: { selected: { type: 'boolean', value: false } }, components: [
    component('qty', 'numberInput', { text: 'Template quantity', customProperties: { limit: { type: 'number', value: 10 } } }),
    component('caption', 'label', { text: 'Template limit', bindings: { width: binding('limit', { limit: { kind: 'custom', componentId: 'qty', key: 'limit' } }) } }),
  ] }],
};
const queries = [
  { id: 'orders', name: 'Work order data', connectionId: 'sample', sql: 'SELECT id, name FROM work_orders', kind: 'query', parameters: [{ name: 'line', type: 'string', defaultValue: 'North' }] },
  { id: 'dimension', name: 'Card dimensions', connectionId: 'sample', sql: 'SELECT 240 AS width', kind: 'query', parameters: [] },
];
const scripts = [
  { id: 'startup', name: 'Initialize station', type: 'gateway', enabled: false, event: 'startup', code: 'system.db.runNamedQuery("orders")', parameters: { station: 'North' } },
  { id: 'ui-start', name: 'Open application', type: 'client', enabled: false, event: 'screenOpen', code: '/* inspector */' },
];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
freeze(project); freeze(queries); freeze(scripts);
const entries = buildProjectSearch(project, queries, scripts);
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const at = (kind, id, componentId, property) => entries.find(entry => entry.target.kind === kind && entry.target.id === id && entry.target.componentId === componentId && entry.target.property === property);

check('resource roots navigate by stable IDs and contain readable locations', () => {
  assert.equal(at('screen', 'home').label, 'Production home');
  assert.equal(at('template', 'machine-card').category, 'template');
  assert.equal(at('query', 'orders').category, 'query');
  assert.equal(at('script', 'startup').target.id, 'startup');
  assert.equal(at('project', project.id).label, project.name);
  assert.match(at('screen', 'home', 'qty').location, /Production home \/ Quantity \(qty\)/);
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
});
check('all geometry, authored parameters and private state can be found without flattening owners', () => {
  for (const property of ['x', 'y', 'width', 'height']) assert.equal(at('screen', 'home', 'qty', property).target.property, property);
  assert.equal(at('screen', 'home', undefined, 'height').text, 'height 700');
  assert.equal(at('template', 'machine-card', undefined, 'instanceState.selected.value').text, 'instanceState.selected.value false');
  assert.equal(at('project', project.id, undefined, 'sessionState.batch.value').text, 'sessionState.batch.value 3');
  assert.equal(at('screen', 'home', 'card', 'props.parameters.line').text, 'props.parameters.line West');
});
check('queries are referenced from tables, options, repeater rows and scalar properties', () => {
  const uses = findProjectReferences(entries, { kind: 'query', id: 'orders' });
  assert.deepEqual(uses.map(entry => entry.target.componentId).sort(), ['repeat', 'select', 'table']);
  const scalar = findProjectReferences(entries, { kind: 'query', id: 'dimension' });
  assert.equal(scalar.length, 1); assert.equal(scalar[0].target.property, 'props.queryBindings.width.queryId');
  assert.equal(scalar[0].category, 'binding');
  assert.equal(at('screen', 'home', 'gauge', 'props.queryBindings.width.parameters.batch.references.selected').category, 'binding');
});
check('template and navigation references identify the source location including project settings', () => {
  assert.deepEqual(findProjectReferences(entries, { kind: 'template', id: 'machine-card' }).map(entry => entry.target.componentId), ['card', 'repeat']);
  const homeUses = findProjectReferences(entries, { kind: 'screen', id: 'home' });
  assert.equal(homeUses.length, 2); assert.ok(homeUses.every(entry => entry.target.kind === 'project'));
  const popup = findProjectReferences(entries, { kind: 'screen', id: 'inspector' });
  assert.equal(popup.length, 1); assert.equal(popup[0].target.componentId, 'open');
});
check('component used-by is scoped to the owning screen or template, including input and parameter bindings', () => {
  const homeUses = findProjectReferences(entries, { kind: 'component', id: 'qty', ownerKind: 'screen', ownerId: 'home' });
  assert.equal(homeUses.length, 3);
  assert.deepEqual(homeUses.map(entry => entry.target.componentId), ['card', 'card', 'gauge']);
  const templateUses = findProjectReferences(entries, { kind: 'component', id: 'qty', ownerKind: 'template', ownerId: 'machine-card' });
  assert.equal(templateUses.length, 1); assert.equal(templateUses[0].target.componentId, 'caption');
  assert.equal(findProjectReferences(entries, { kind: 'component', id: 'qty', ownerKind: 'screen', ownerId: 'inspector' }).length, 0);
  assert.equal(findProjectReferences(entries, { kind: 'component', id: 'qty' }).length, 0, 'An unscoped identity must not combine unrelated components.');
});
check('only complete known resource sets produce missing-reference diagnostics', () => {
  const missing = entries.filter(entry => entry.missing);
  assert.deepEqual(missing.map(entry => entry.reference.id).sort(), ['deleted-component', 'deleted-query', 'deleted-screen', 'deleted-template']);
  assert.equal(findProjectReferences(entries, { kind: 'asset', id: 'unloaded-asset' })[0].missing, undefined);
  assert.equal(findProjectReferences(entries, { kind: 'tag', id: '[default]North/{machine}/Pressure' })[0].missing, undefined);
  assert.equal(findProjectReferences(entries, { kind: 'tag', id: '[default]North/{machine}/Flow' })[0].missing, undefined);
  const loading = buildProjectSearch(project, [], scripts, { queriesLoaded: false });
  assert.ok(loading.filter(entry => entry.reference?.kind === 'query').every(entry => entry.missing === undefined));
});
check('row-selection field mappings reference only local inputs on supported controls', () => {
  const changed = structuredClone(project);
  changed.screens[0].components.find(item => item.id === 'table').props.selectionFields = { quantity: 'amount', unknown: 'missing' };
  changed.screens[0].components.find(item => item.id === 'select').props.selectionFields = { quantity: 'amount' };
  changed.screens[0].components.find(item => item.id === 'logo').props.selectionFields = { quantity: 'not-a-selection-control' };
  changed.screens[0].components.find(item => item.id === 'logo').props.metadata.selectionFields = { quantity: 'metadata' };
  changed.templates[0].components.push(component('list', 'list', { fieldKey: 'selected', selectionFields: { qty: 'amount' } }));
  const changedEntries = buildProjectSearch(changed, queries, scripts);
  const uses = findProjectReferences(changedEntries, { kind: 'component', id: 'qty', ownerKind: 'screen', ownerId: 'home' })
    .filter(entry => entry.target.property.startsWith('props.selectionFields.'));
  assert.deepEqual(uses.map(entry => entry.target.componentId), ['table', 'select']);
  assert.ok(uses.every(entry => entry.target.property === 'props.selectionFields.quantity'));
  assert.equal(changedEntries.find(entry => entry.target.property === 'props.selectionFields.unknown').reference, undefined);
  const templateUses = findProjectReferences(changedEntries, { kind: 'component', id: 'qty', ownerKind: 'template', ownerId: 'machine-card' });
  assert.ok(templateUses.some(entry => entry.target.componentId === 'list'));
  assert.ok(!uses.some(entry => entry.target.componentId === 'logo'));
});
check('script and SQL matches stay text-only and are never executed or promoted to dependencies', () => {
  const code = searchProject(entries, 'orders').filter(entry => entry.textOnly);
  assert.ok(code.some(entry => entry.target.kind === 'script'));
  assert.ok(code.some(entry => entry.target.property === 'props.tableEdit.script'));
  assert.ok(code.some(entry => entry.target.property === 'props.componentEvents.mount.code'));
  assert.ok(code.every(entry => !entry.reference));
  assert.equal(at('query', 'orders', undefined, 'sql').textOnly, true);
  assert.equal(at('screen', 'home', 'sensor', 'props.events.commit.code').textOnly, true);
  assert.equal(globalThis.searchFixtureExecuted, undefined);
  assert.equal(findProjectReferences(entries, { kind: 'tag', id: 'literal-metadata-tag' }).length, 0, 'Unknown property objects do not become binding dependencies.');
});
check('literal case-insensitive AND search combines location and value without treating punctuation as regex', () => {
  const results = searchProject(entries, '  NORTH    PRESSURE  ');
  assert.ok(results.length); assert.ok(results.every(entry => entry.target.componentId === 'gauge'));
  assert.ok(searchProject(entries, '[x] .*').some(entry => entry.target.componentId === 'sensor'));
  assert.equal(searchProject(entries, '[unclosed').length, 0);
  assert.equal(searchProject(entries, 'absolutely-absent-token').length, 0);
});
check('category filters do not lose property or binding matches and leave result limits to the view', () => {
  assert.ok(searchProject(entries, 'quantity', 'component').length);
  assert.ok(searchProject(entries, 'limit', 'binding').every(entry => entry.category === 'binding'));
  assert.ok(searchProject(entries, '240', 'query').some(entry => entry.target.property === 'sql'));
  assert.equal(searchProject(entries, '', 'all').length, entries.length);
  assert.ok(entries.length > 100, 'This fixture exercises a result set larger than the initial page.');
});
check('rebuilding from unsaved edits changes results and diagnostics without stale cache or mutations', () => {
  const changed = structuredClone(project);
  changed.screens[0].components[0].props.text = 'Unsaved station quantity';
  changed.templates = [];
  const changedEntries = buildProjectSearch(changed, queries, scripts);
  assert.equal(searchProject(entries, 'Unsaved station quantity').length, 0);
  assert.ok(searchProject(changedEntries, 'Unsaved station quantity').length);
  assert.ok(findProjectReferences(changedEntries, { kind: 'template', id: 'machine-card' }).every(entry => entry.missing));
  assert.equal(project.screens[0].components[0].props.text, 'Quantity');
  assert.equal(changedEntries.find(entry => entry.target.componentId === 'qty' && !entry.target.property).id, at('screen', 'home', 'qty').id);
});
check('empty projects and partial editor loads remain searchable without fabricated missing resources', () => {
  const empty = buildProjectSearch({ id: 'empty', name: 'Empty project', revision: 1, parameters: {}, screens: [] }, [], []);
  assert.equal(empty.length, 1); assert.equal(empty[0].target.kind, 'project');
  assert.equal(findProjectReferences(empty, { kind: 'screen', id: 'home' }).length, 0);
});
console.log(`${passed} project search groups passed.`);
