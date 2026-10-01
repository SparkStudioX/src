#!/usr/bin/env node
// Offline previews and atomic edits of an explicit authored-field inventory.
import assert from 'node:assert/strict';
import { webModelModule } from './web-model-module.mjs';
const { planBulkReplacement, applyBulkReplacement } = await import(await webModelModule('bulkReplacement'));
const component = (id, type = 'label', props = {}) => ({ id, type, x: 10, y: 20, width: 200, height: 40, props });
const tagBinding = (path = '[default]Line1/Speed') => ({ expression: 'live', references: { live: { kind: 'tag', path } } });
const fixture = () => ({
  id: 'Line1-project', name: 'Line1 plant', revision: 17, parameters: { unit: 'Line1', 'line.name': 'Line1' },
  navigation: { startupScreenId: 'Line1-home', mode: 'menu', items: [{ screenId: 'Line1-home', label: 'Line1 overview' }] },
  screens: [
    { id: 'Line1-home', name: 'Line1 overview', width: 1000, height: 700, parameters: { station: 'Line1' }, components: [
      component('shared.id', 'label', { text: 'Line1 Line1 status', bindings: { text: tagBinding() }, customProperties: { note: { type: 'string', value: 'Line1' } }, arbitrary: { text: 'Line1', tagPath: '[default]Line1/Secret' } }),
      component('readout', 'value', { text: 'Line1 speed', tagPath: '[default]Line1/Speed', unit: 'Line1/hr' }),
      component('input', 'textInput', { text: 'Line1 note', defaultValue: 'Line1 value', value: 'Line1 value', fieldKey: 'Line1-field', stateBinding: { scope: 'session', key: 'Line1' }, events: { change: { language: 'javascript', code: 'return "Line1";' } } }),
      component('password', 'passwordInput', { text: 'Line1 password', defaultValue: 'Line1 secret' }),
      component('choose', 'select', { text: 'Line1 choice', defaultValue: 'Line1-id', options: [{ value: 'Line1-id', label: 'Line1 option' }], optionsSource: { queryId: 'Line1-query', labelColumn: 'Line1-label', valueColumn: 'Line1-value' } }),
      component('indicator', 'multiStateIndicator', { text: 'Line1 state', stateValue: 'Line1-code', states: [{ value: 'Line1-code', label: 'Line1 ready', color: '#123456' }] }),
      component('table', 'table', { text: 'Line1 records', queryId: 'Line1-query', tableColumns: [{ key: 'Line1-key', label: 'Line1 amount', format: 'number', suffix: 'Line1' }], selectionFields: { 'Line1-field': 'Line1-column' }, tableEdit: { script: 'return "Line1";' } }),
      component('image', 'image', { text: 'Line1 photo', alt: 'Line1 equipment', assetId: 'Line1-asset', url: 'https://Line1.invalid' }),
      component('button', 'button', { text: 'Line1 action', targetScreenId: 'Line1-home', script: 'return "Line1";', parameters: { unit: 'Line1' } }),
      component('placement', 'template', { text: 'Line1 placement', templateId: 'Line1-card', parameters: { unit: 'Line1' }, parameterBindings: { 'line.name': tagBinding('[default]Line1/{line.name}') } }),
    ] },
    { id: 'other', name: 'Other', width: 800, height: 600, components: [component('shared.id', 'label', { text: 'Line1 elsewhere' })] },
  ],
  templates: [{ id: 'Line1-card', name: 'Line1 card', width: 200, height: 100, parameters: { unit: 'Line1' }, components: [component('shared.id', 'label', { text: 'Line1 card caption' })] }],
  sessionState: { selected: { type: 'string', value: 'Line1' } },
  arbitrary: { sql: "SELECT 'Line1'", script: 'return "Line1";' },
});
const request = (overrides = {}) => ({ find: 'Line1', replace: 'Line2', matchCase: true, scope: 'all', kind: 'displayText', ...overrides });
const all = plan => plan.changes.map(change => change.id);
const applyAll = (project, options = {}) => { const plan = planBulkReplacement(project, request(options)); return applyBulkReplacement(plan, project, all(plan)); };
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('display replacement is immutable and preserves identity, scripts, input values and structured references', () => {
  const project = freeze(fixture()); const before = JSON.stringify(project);
  const plan = planBulkReplacement(project, request());
  assert.deepEqual(plan.errors, []); assert.ok(plan.changes.length > 15);
  assert.equal(plan.changes.find(change => change.target.componentId === 'shared.id' && change.target.id === 'Line1-home' && change.property === 'props.text').occurrences, 2);
  const next = applyBulkReplacement(plan, project, all(plan));
  assert.equal(JSON.stringify(project), before); assert.notEqual(next, project); assert.equal(next.revision, 17);
  assert.equal(next.id, project.id); assert.equal(next.name, project.name);
  assert.equal(next.screens[0].id, 'Line1-home'); assert.equal(next.screens[0].name, 'Line2 overview');
  assert.equal(next.screens[0].components[0].id, 'shared.id'); assert.equal(next.screens[0].components[0].props.text, 'Line2 Line2 status');
  assert.deepEqual(next.screens[0].components[0].props.bindings, project.screens[0].components[0].props.bindings);
  assert.deepEqual(next.screens[0].components[0].props.customProperties, project.screens[0].components[0].props.customProperties);
  for (const [index, keys] of [[2, ['defaultValue', 'value', 'fieldKey', 'events', 'stateBinding']], [4, ['defaultValue', 'optionsSource']], [5, ['stateValue']], [6, ['queryId', 'selectionFields', 'tableEdit']], [7, ['url', 'assetId']], [8, ['targetScreenId', 'script', 'parameters']], [9, ['templateId', 'parameters', 'parameterBindings']]])
    for (const key of keys) assert.deepEqual(next.screens[0].components[index].props[key], project.screens[0].components[index].props[key], `${index}/${key}`);
  assert.equal(next.screens[0].components[4].props.options[0].value, 'Line1-id');
  assert.equal(next.screens[0].components[5].props.states[0].value, 'Line1-code');
  assert.equal(next.screens[0].components[6].props.tableColumns[0].key, 'Line1-key');
  assert.deepEqual(next.parameters, project.parameters); assert.deepEqual(next.sessionState, project.sessionState); assert.deepEqual(next.arbitrary, project.arbitrary);
});
check('menu labels are explicit display fields with stable screen targets and selective application', () => {
  const project = fixture(); const plan = planBulkReplacement(project, request());
  const menu = plan.changes.find(change => change.target.kind === 'project');
  assert.equal(menu.property, 'navigation.items[0].label');
  const next = applyBulkReplacement(plan, project, [menu.id]);
  assert.equal(next.navigation.items[0].label, 'Line2 overview');
  assert.equal(next.navigation.items[0].screenId, 'Line1-home'); assert.deepEqual(next.screens, project.screens);
  assert.equal(next.navigation.startupScreenId, 'Line1-home');
});
check('scope distinguishes screens, templates and project menu labels', () => {
  const project = fixture();
  const screens = planBulkReplacement(project, request({ scope: 'screens' }));
  assert.ok(screens.changes.some(change => change.target.kind === 'project'));
  assert.ok(screens.changes.every(change => change.target.kind !== 'template'));
  const templates = planBulkReplacement(project, request({ scope: 'templates' }));
  assert.ok(templates.changes.length); assert.ok(templates.changes.every(change => change.target.kind === 'template'));
  assert.deepEqual(applyBulkReplacement(templates, project, all(templates)).screens, project.screens);
});
check('component IDs remain distinct across owners and path segments containing dots are not parsed', () => {
  const project = fixture();
  const plan = planBulkReplacement(project, request());
  const shared = plan.changes.filter(change => change.target.componentId === 'shared.id');
  assert.equal(shared.length, 3); assert.equal(new Set(shared.map(change => change.id)).size, 3);
  const templateOnly = shared.find(change => change.target.kind === 'template');
  const next = applyBulkReplacement(plan, project, [templateOnly.id]);
  assert.deepEqual(next.screens, project.screens); assert.equal(next.templates[0].components[0].props.text, 'Line2 card caption');
  const tags = planBulkReplacement(project, request({ kind: 'tagPaths' }));
  const dotted = tags.changes.find(change => change.property.includes('["line.name"]'));
  assert.ok(dotted); const tagged = applyBulkReplacement(tags, project, [dotted.id]);
  assert.equal(tagged.screens[0].components[9].props.parameterBindings['line.name'].references.live.path, '[default]Line2/{line.name}');
});
check('tag inventory changes direct supported paths and supported binding references, never expressions', () => {
  const project = fixture();
  project.screens[0].components[0].props.bindings.text.expression = 'live + "Line1"';
  const plan = planBulkReplacement(project, request({ kind: 'tagPaths' }));
  assert.equal(plan.changes.length, 3); assert.deepEqual(plan.errors, []);
  const next = applyBulkReplacement(plan, project, all(plan));
  assert.equal(next.screens[0].components[1].props.tagPath, '[default]Line2/Speed');
  assert.equal(next.screens[0].components[0].props.bindings.text.references.live.path, '[default]Line2/Speed');
  assert.equal(next.screens[0].components[0].props.bindings.text.expression, 'live + "Line1"');
  assert.equal(next.screens[0].components[1].props.text, 'Line1 speed');
  assert.equal(next.screens[0].name, project.screens[0].name);
});
check('arbitrary metadata and unsupported component, binding and query-parameter locations are excluded', () => {
  const project = fixture();
  project.screens[0].components.push(component('unknown', 'extension', { text: 'Line1', tagPath: '[default]Line1', bindings: { text: tagBinding() } }));
  project.screens[0].components[0].props.bindings.arbitrary = tagBinding();
  project.screens[0].components[0].props.parameterBindings = { unit: tagBinding() };
  project.screens[0].components[0].props.queryBindings = { text: { queryId: 'Line1-query', column: 'Line1', transform: 'value + "Line1"', parameters: { number: tagBinding() } } };
  project.screens[0].components[0].props.metadata = { bindings: { text: tagBinding() } };
  project.screens[0].components[0].props.tagPath = '[default]Line1/Unsupported';
  const tagged = applyAll(project, { kind: 'tagPaths' });
  for (const key of ['metadata', 'parameterBindings', 'queryBindings', 'tagPath', 'arbitrary']) assert.deepEqual(tagged.screens[0].components[0].props[key], project.screens[0].components[0].props[key]);
  assert.deepEqual(tagged.screens[0].components[0].props.bindings.arbitrary, project.screens[0].components[0].props.bindings.arbitrary);
  assert.deepEqual(tagged.screens[0].components.at(-1), project.screens[0].components.at(-1));
  const displayed = applyAll(project);
  assert.deepEqual(displayed.screens[0].components.at(-1), project.screens[0].components.at(-1));
  assert.deepEqual(displayed.screens[0].components[3], project.screens[0].components[3]);
});
check('literal special characters and dollar replacement sequences are never regex or substitutions', () => {
  const project = fixture(); project.screens[0].components[0].props.text = 'Prefix [a.*](x)?$+^\\ Suffix [a.*](x)?$+^\\';
  const plan = planBulkReplacement(project, request({ find: '[a.*](x)?$+^\\', replace: '$& $1 $$ $`' }));
  assert.equal(plan.changes.length, 1); assert.equal(plan.changes[0].occurrences, 2);
  assert.equal(plan.changes[0].after, 'Prefix $& $1 $$ $` Suffix $& $1 $$ $`');
  assert.equal(applyBulkReplacement(plan, project, all(plan)).screens[0].components[0].props.text, plan.changes[0].after);
});
check('case-insensitive Unicode matching retains original indices and complete astral characters', () => {
  const project = fixture(); project.screens[0].components[0].props.text = 'İ xX Σςσ 😀';
  const plan = planBulkReplacement(project, request({ find: 'x', replace: 'Z', matchCase: false }));
  const text = plan.changes.find(change => change.target.componentId === 'shared.id');
  assert.equal(text.after, 'İ ZZ Σςσ 😀'); assert.equal(text.occurrences, 2);
  const sigma = planBulkReplacement(project, request({ find: 'σ', replace: 'S', matchCase: false })).changes[0];
  assert.equal(sigma.after, 'İ xX SSS 😀'); assert.equal(sigma.occurrences, 3);
  const emoji = planBulkReplacement(project, request({ find: '😀', replace: '😃' })).changes[0];
  assert.equal(emoji.after, 'İ xX Σςσ 😃'); assert.equal(emoji.occurrences, 1);
  const sensitive = planBulkReplacement(project, request({ find: 'x', replace: 'Z' })).changes.find(change => change.target.componentId === 'shared.id');
  assert.equal(sensitive.after, 'İ ZX Σςσ 😀'); assert.equal(sensitive.occurrences, 1);
});
check('matches do not overlap and replacement text is not matched again', () => {
  const project = fixture(); project.screens[0].components[0].props.text = 'aaa';
  const change = planBulkReplacement(project, request({ find: 'aa', replace: 'aaaa' })).changes[0];
  assert.equal(change.after, 'aaaaa'); assert.equal(change.occurrences, 1);
});
check('dense large expansions are rejected before constructing expanded replacement text', () => {
  const project = fixture(); project.screens[0].components[0].props.text = 'x'.repeat(1024 * 1024);
  const originalReplace = String.prototype.replace;
  let expandedReplacementCalled = false;
  // A regression must fail as an assertion, not attempt a two-gigabyte allocation.
  String.prototype.replace = function (pattern, replacement) {
    if (this.length >= 1024 * 1024 && typeof replacement === 'function') {
      expandedReplacementCalled = true;
      throw new Error('Expanded replacement allocated before preview limit');
    }
    return originalReplace.call(this, pattern, replacement);
  };
  try {
    const plan = planBulkReplacement(project, request({ find: 'x', replace: 'y'.repeat(2048) }));
    assert.match(plan.errors.join(' '), /preview is too large.*Narrow the search/);
    assert.deepEqual(plan.changes, []); assert.equal(expandedReplacementCalled, false);
    assert.throws(() => applyBulkReplacement(plan, project, ['invented']), /preview is too large/);
    assert.equal(expandedReplacementCalled, false);
  } finally { String.prototype.replace = originalReplace; }
});
check('preview output budget is aggregate and ordinary medium-sized replacements still apply', () => {
  const project = fixture(); project.screens[0].components = [0, 1, 2].map(index => component(`dense-${index}`, 'label', { text: 'x'.repeat(1000) }));
  const overBudget = planBulkReplacement(project, request({ find: 'x', replace: 'y'.repeat(1000) }));
  assert.match(overBudget.errors.join(' '), /preview is too large/); assert.deepEqual(overBudget.changes, []);
  project.screens[0].components = [component('normal', 'label', { text: 'x'.repeat(50_000) })];
  const normal = planBulkReplacement(project, request({ find: 'x', replace: 'yy' }));
  assert.deepEqual(normal.errors, []); assert.equal(normal.changes.length, 1);
  assert.equal(normal.changes[0].occurrences, 50_000); assert.equal(normal.changes[0].after.length, 100_000);
  const next = applyBulkReplacement(normal, project, all(normal));
  assert.equal(next.screens[0].components[0].props.text, 'yy'.repeat(50_000));
  assert.equal(project.screens[0].components[0].props.text, 'x'.repeat(50_000));
});
check('empty find, excessive request bounds and invalid options fail before inventory evaluation', () => {
  const project = fixture();
  for (const options of [{ find: '' }, { find: 'x'.repeat(257) }, { replace: 'x'.repeat(2049) }, { scope: 'scripts' }, { kind: 'json' }, { matchCase: 'yes' }, { find: null }, { replace: null }]) {
    const plan = planBulkReplacement(project, request(options));
    assert.ok(plan.errors.length, JSON.stringify(options)); assert.deepEqual(plan.changes, []);
    assert.throws(() => applyBulkReplacement(plan, project, ['fake']));
  }
  assert.deepEqual(planBulkReplacement(project, request({ find: 'x'.repeat(256), replace: 'x'.repeat(2048) })).errors, []);
});
check('no-op fields and absent matches never become selectable replacements', () => {
  const project = fixture();
  assert.deepEqual(planBulkReplacement(project, request({ replace: 'Line1' })).changes, []);
  assert.deepEqual(planBulkReplacement(project, request({ find: 'no occurrence' })).changes, []);
  project.screens[0].name = 'Line1';
  const plan = planBulkReplacement(project, request({ replace: '  Line1  ' }));
  assert.ok(!plan.changes.some(change => change.target.id === 'Line1-home' && change.property === 'name'));
});
check('name normalization and invalid unchecked candidates permit a valid selective transaction', () => {
  const project = fixture(); project.screens[0].name = 'Line1';
  const plan = planBulkReplacement(project, request({ replace: '' }));
  const invalid = plan.changes.find(change => change.target.id === 'Line1-home' && change.property === 'name');
  const valid = plan.changes.find(change => change.target.componentId === 'shared.id' && change.target.id === 'Line1-home');
  assert.ok(invalid.errors.length); assert.deepEqual(valid.errors, []);
  assert.throws(() => applyBulkReplacement(plan, project, [valid.id, invalid.id]), /cannot be empty/);
  const next = applyBulkReplacement(plan, project, [valid.id]);
  assert.equal(next.screens[0].name, 'Line1'); assert.equal(next.screens[0].components[0].props.text, '  status');
  const trimmed = planBulkReplacement(project, request({ replace: '  Line2  ' }));
  assert.equal(trimmed.changes.find(change => change.property === 'name' && change.target.id === 'Line1-home').after, 'Line2');
});
check('name and menu errors enforce bounded nonempty text without controls', () => {
  const project = fixture(); project.screens[0].name = 'Line1'; project.navigation.items[0].label = 'Line1';
  for (const replace of ['', ' '.repeat(5), 'x'.repeat(121), 'bad\ntext']) {
    const plan = planBulkReplacement(project, request({ replace }));
    assert.ok(plan.changes.filter(change => change.property === 'name' && change.target.id === 'Line1-home' || change.target.kind === 'project').every(change => change.errors.length));
  }
  const limit = planBulkReplacement(project, request({ replace: 'x'.repeat(120) }));
  assert.deepEqual(limit.changes.find(change => change.property === 'name' && change.target.id === 'Line1-home').errors, []);
  assert.deepEqual(limit.changes.find(change => change.target.kind === 'project').errors, []);
});
check('option, state, column and suffix limits are validated per selected field', () => {
  const project = fixture();
  const plan = planBulkReplacement(project, request({ replace: 'x'.repeat(200) }));
  for (const path of ['props.options[0].label', 'props.states[0].label', 'props.tableColumns[0].label', 'props.tableColumns[0].suffix'])
    assert.ok(plan.changes.find(change => change.property === path).errors.length, path);
  const valid = plan.changes.find(change => change.target.componentId === 'image' && change.property === 'props.alt');
  assert.deepEqual(valid.errors, []); assert.doesNotThrow(() => applyBulkReplacement(plan, project, [valid.id]));
  project.screens[0].components[4].props.options[0].label = 'Line1';
  const nel = planBulkReplacement(project, request({ replace: '\u0085' })).changes.find(change => change.property === 'props.options[0].label');
  assert.match(nel.errors.join(' '), /empty/);
});
check('tag path candidates reject emptiness, length and controls without claiming gateway tag existence', () => {
  const project = fixture(); project.screens[0].components[1].props.tagPath = 'Line1';
  for (const replace of ['', ' '.repeat(4), 'x'.repeat(1025), 'Line2\n']) {
    const plan = planBulkReplacement(project, request({ replace, kind: 'tagPaths' }));
    const change = plan.changes.find(change => change.property === 'props.tagPath');
    assert.ok(change.errors.length); assert.throws(() => applyBulkReplacement(plan, project, [change.id]));
  }
  const boundary = planBulkReplacement(project, request({ replace: 'x'.repeat(1024), kind: 'tagPaths' }));
  assert.deepEqual(boundary.changes.find(change => change.property === 'props.tagPath').errors, []);
  const missingTag = planBulkReplacement(project, request({ replace: '[default]Unconfigured/Device', kind: 'tagPaths' }));
  assert.deepEqual(missingTag.changes.find(change => change.property === 'props.tagPath').errors, []);
});
check('tag indirection tokens cannot be renamed, removed, introduced, reordered or malformed', () => {
  const project = fixture();
  const plan = planBulkReplacement(project, request({ find: 'line.name', replace: 'missing', kind: 'tagPaths' }));
  assert.equal(plan.changes.length, 1); assert.match(plan.changes[0].errors.join(' '), /not declared/);
  assert.throws(() => applyBulkReplacement(plan, project, all(plan)), /not declared/);
  const declared = planBulkReplacement(project, request({ find: 'line.name', replace: 'station', kind: 'tagPaths' }));
  assert.match(declared.changes[0].errors.join(' '), /tokens are not changed/);
  project.screens[0].components[1].props.tagPath = '[default]Line1/{station}/{unit}';
  for (const options of [{ find: 'station', replace: 'unit' }, { find: '{station}', replace: '' }, { find: 'Line1', replace: '{unit}' }, { find: '{station}/{unit}', replace: '{unit}/{station}' }, { find: 'Line1', replace: 'Line2{' }]) {
    const candidate = planBulkReplacement(project, request({ ...options, kind: 'tagPaths' })).changes.find(change => change.property === 'props.tagPath');
    assert.ok(candidate.errors.length, JSON.stringify(options));
  }
  const unchangedTokens = planBulkReplacement(project, request({ kind: 'tagPaths' }));
  const next = applyBulkReplacement(unchangedTokens, project, all(unchangedTokens));
  assert.equal(next.screens[0].components[1].props.tagPath, '[default]Line2/{station}/{unit}');
  assert.deepEqual(next.parameters, project.parameters);
});
check('direct input initialization tag paths are included while password paths remain excluded', () => {
  const project = fixture();
  const types = ['textInput', 'multiStateButton', 'list', 'treeView', 'textArea', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'radioGroup', 'dateTimeInput'];
  project.screens[0].components = types.map(type => component(type, type, { tagPath: '[default]Line1/Initial', defaultValue: 'Line1' }));
  project.screens[0].components.push(component('password', 'passwordInput', { tagPath: '[default]Line1/Secret', defaultValue: 'Line1' }));
  const plan = planBulkReplacement(project, request({ kind: 'tagPaths', scope: 'screens' }));
  assert.equal(plan.changes.length, types.length);
  const next = applyBulkReplacement(plan, project, all(plan));
  for (const input of next.screens[0].components.slice(0, -1)) { assert.equal(input.props.tagPath, '[default]Line2/Initial'); assert.equal(input.props.defaultValue, 'Line1'); }
  assert.deepEqual(next.screens[0].components.at(-1), project.screens[0].components.at(-1));
});
check('process display unit limits match the gateway and do not block an unselected error', () => {
  const project = fixture(); project.screens[0].components.push(component('tank', 'cylindricalTank', { unit: 'Line1' }));
  const plan = planBulkReplacement(project, request({ replace: 'x'.repeat(33) }));
  const unit = plan.changes.find(change => change.target.componentId === 'tank');
  assert.match(unit.errors.join(' '), /32 characters/);
  assert.throws(() => applyBulkReplacement(plan, project, [unit.id]), /32 characters/);
  const caption = plan.changes.find(change => change.target.componentId === 'readout' && change.property === 'props.text');
  assert.doesNotThrow(() => applyBulkReplacement(plan, project, [caption.id]));
  const boundary = planBulkReplacement(project, request({ replace: 'x'.repeat(32) }));
  assert.deepEqual(boundary.changes.find(change => change.target.componentId === 'tank').errors, []);
});
check('interpolated captions, alt text, resource names and process units retain parameter tokens', () => {
  const project = fixture(); project.parameters.Line1 = 'Assembly';
  project.screens[0].name = 'Station {Line1}';
  project.templates[0].name = 'Station {Line1} card';
  project.screens[0].components[0].props.text = 'Station {Line1} caption';
  project.screens[0].components[7].props.alt = 'Station {Line1} equipment';
  project.screens[0].components.push(component('tank', 'cylindricalTank', { unit: 'Station {Line1}' }));
  const plan = planBulkReplacement(project, request());
  const protectedFields = plan.changes.filter(change => change.before.includes('{Line1}'));
  assert.equal(protectedFields.length, 5);
  for (const change of protectedFields) {
    assert.match(change.errors.join(' '), /Display parameter tokens/);
    assert.throws(() => applyBulkReplacement(plan, project, [change.id]), /Display parameter tokens/);
  }
  const allowed = planBulkReplacement(project, request({ find: 'Station', replace: 'Area' }));
  assert.equal(allowed.changes.length, 5); assert.ok(allowed.changes.every(change => !change.errors.length));
  const next = applyBulkReplacement(allowed, project, all(allowed));
  assert.equal(next.screens[0].name, 'Area {Line1}');
  assert.equal(next.screens[0].components[0].props.text, 'Area {Line1} caption');
  assert.equal(next.screens[0].components.at(-1).props.unit, 'Area {Line1}');
  assert.deepEqual(next.parameters, project.parameters);
  for (const options of [{ find: '{Line1}', replace: '' }, { find: 'Station', replace: '{Line1}' }]) {
    const changed = planBulkReplacement(project, request(options)).changes.filter(change => change.before.includes('{Line1}'));
    assert.equal(changed.length, 5); assert.ok(changed.every(change => change.errors.length));
  }
});
check('changed revisions, unrelated fields, geometry and owner order invalidate the exact preview', () => {
  const project = fixture(); const plan = planBulkReplacement(project, request());
  for (const mutate of [next => next.revision++, next => next.parameters.extra = 'unrelated', next => next.screens[0].components[0].x++, next => next.screens.reverse(), next => next.arbitrary.script += '// changed']) {
    const changed = structuredClone(project); mutate(changed);
    assert.throws(() => applyBulkReplacement(plan, changed, [plan.changes[0].id]), /changed/);
  }
});
check('preview request is captured and later request mutation cannot change its authority', () => {
  const project = fixture(); const options = request(); const plan = planBulkReplacement(project, options);
  options.replace = 'Intruder'; assert.equal(plan.request.replace, 'Line2');
  assert.equal(applyBulkReplacement(plan, project, all(plan)).screens[0].name, 'Line2 overview');
  plan.request.replace = 'Changed'; assert.throws(() => applyBulkReplacement(plan, project, all(plan)), /changed/);
});
check('tampered rows are ignored and selections must identify current unique valid fields', () => {
  const project = fixture(); const plan = planBulkReplacement(project, request());
  const id = plan.changes.find(change => change.property === 'name' && change.target.id === 'Line1-home').id;
  plan.changes = [{ id, before: 'not real', after: 'Injected', errors: [], target: { kind: 'project', id: project.id, property: 'id' } }];
  assert.equal(applyBulkReplacement(plan, project, [id]).screens[0].name, 'Line2 overview');
  assert.throws(() => applyBulkReplacement(plan, project, []), /Select at least/);
  assert.throws(() => applyBulkReplacement(plan, project, ['invented']), /no longer available/);
  assert.throws(() => applyBulkReplacement(plan, project, [id, id]), /duplicate/);
  const invalid = planBulkReplacement(project, request({ replace: '\n' }));
  const invalidId = invalid.changes.find(change => change.property === 'name' && change.target.id === 'Line1-home').id;
  invalid.changes.forEach(change => change.errors = []);
  assert.throws(() => applyBulkReplacement(invalid, project, [invalidId]), /control characters/);
});
check('preview and application never execute authored functions or scripts', () => {
  const project = fixture(); let called = false;
  project.screens[0].components[8].props.script = 'throw new Error("Line1")';
  project.screens[0].components[8].props.bindings = { text: { expression: 'danger()', references: {} } };
  globalThis.danger = () => { called = true; throw new Error('Unexpected execution'); };
  try { applyAll(project); assert.equal(called, false); } finally { delete globalThis.danger; }
});
check('nested runtime and declared custom bindings participate through the shared catalog', () => {
  const project = fixture();
  project.screens[0].components.push(component('chart-runtime', 'chart', { chart: { kind: 'line', xKey: 'x', series: [{ key: 'y' }] }, bindings: { 'chart.yMin': tagBinding(), 'chart.unknown': tagBinding() } }),
    component('custom-runtime', 'label', { customProperties: { speed: { type: 'number', value: 0 } }, bindings: { 'customProperties.speed.value': tagBinding(), 'customProperties.missing.value': tagBinding() } }),
    component('history-runtime', 'historicalTrend', { bindings: { historyMinutes: tagBinding() } }));
  const plan = planBulkReplacement(project, request({ kind: 'tagPaths' }));
  for (const id of ['chart-runtime', 'custom-runtime', 'history-runtime']) {
    const changes = plan.changes.filter(change => change.target.componentId === id);
    assert.equal(changes.length, 1); assert.equal(changes[0].after, '[default]Line2/Speed');
  }
  const next = applyBulkReplacement(plan, project, all(plan));
  assert.equal(next.screens[0].components.find(item => item.id === 'custom-runtime').props.bindings['customProperties.speed.value'].references.live.path, '[default]Line2/Speed');
  assert.equal(next.screens[0].components.find(item => item.id === 'chart-runtime').props.bindings['chart.unknown'].references.live.path, '[default]Line1/Speed');
});
check('camera captions and general tag-binding references participate without changing captured input identity', () => {
  const project = fixture();
  project.screens[0].components.push(component('camera', 'computerCamera', { text: 'Line1 visitor photo', fieldKey: 'Line1-photo', defaultValue: '', bindings: { text: tagBinding() } }));
  const camera = project.screens[0].components.at(-1);
  const displayed = applyAll(project);
  assert.equal(displayed.screens[0].components.at(-1).props.text, 'Line2 visitor photo');
  assert.deepEqual(displayed.screens[0].components.at(-1).props.bindings, camera.props.bindings);
  const tagged = applyAll(project, { kind: 'tagPaths' });
  assert.equal(tagged.screens[0].components.at(-1).props.bindings.text.references.live.path, '[default]Line2/Speed');
  assert.equal(tagged.screens[0].components.at(-1).props.text, camera.props.text);
  for (const next of [displayed, tagged]) {
    assert.equal(next.screens[0].components.at(-1).props.fieldKey, 'Line1-photo');
    assert.equal(next.screens[0].components.at(-1).props.defaultValue, '');
  }
  assert.equal(camera.props.text, 'Line1 visitor photo');
  assert.equal(camera.props.bindings.text.references.live.path, '[default]Line1/Speed');
});
check('native tag-write targets remain outside tag-path replacement', () => {
  const project = fixture();
  project.screens[0].components.push(component('write', 'button', { action: 'setTagValue', tagWrite: { tagPath: '[default]Line1/Speed', dataType: 'Double', value: 1 } }));
  const plan = planBulkReplacement(project, request({ kind: 'tagPaths' }));
  assert.ok(!plan.changes.some(change => change.target.componentId === 'write'));
  const next = applyBulkReplacement(plan, project, all(plan));
  assert.deepEqual(next.screens[0].components.at(-1).props.tagWrite, project.screens[0].components.at(-1).props.tagWrite);
});
console.log(`Bulk replacement: ${passed} checks passed.`);
