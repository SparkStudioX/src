import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Pure authored fixtures: no gateway requests, live catalogs, credentials or devices.
const file = createTestModuleFiles(), modules = new Map(), require = createRequire(import.meta.url);
modules.set('api', file('export const displayValue=value=>JSON.stringify(value??null);'));
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const result = file(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); modules.set(name, result); return result; }
  const sourcePath = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(path => fs.existsSync(path));
  assert.ok(sourcePath, name);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/from (["'])([^"']+)\1/g, (_match, _quote, dependency) => `from ${JSON.stringify(dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = file(code); modules.set(name, result); return result;
}
const ops = await import(load('modelBuilderOperations')), parameterize = await import(load('modelParameterize'));
const resolution = await import(load('modelResolution')), model = await import(load('modelWorkspace'));
const rules = await import(load('modelParameterRules')), draft = await import(load('modelDraft'));
const review = await import(load('modelWorkspaceReview'));
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const type = (id, members = []) => ({ id, version: 1, parameters: [], members });
const instance = (definition, parameters = {}, path = '[default]Models/Test') => ({ path, definitionId: definition.id, version: definition.version, parameters, overrides: {} });
const reference = (path, target, dataType = 'Double') => ({ path, kind: 'reference', target, dataType });
const catalog = ['Press01', 'Press02', 'Press03', 'Press04'].flatMap((device, index) => ['Speed', 'Count', 'Axis/X/Load'].slice(0, index === 3 ? 2 : 3).map((member, i) => ({ path: `[default]Raw/${device}/${member}`, dataType: i === 1 ? 'Int64' : 'Double', unit: i === 0 ? 'rpm' : undefined })));
const dropped = ops.referenceMembersFromTags(catalog.slice(0, 3), [], '[default]Raw/Press01');
const press = type('Press', dropped.members), offer = parameterize.offerModelParameterization(press, catalog, '[default]Raw/Press01');
const accepted = parameterize.applyModelParameterization(press, offer);

check('browser and gateway use the same authored placeholder contract', () => {
  const contract = JSON.parse(fs.readFileSync(new URL('src/modelParameterContract.json', import.meta.url), 'utf8'));
  assert.equal(contract.version, 1);
  const project = fs.readFileSync(new URL('../../src/SparkStudio.Gateway/SparkStudio.Gateway.csproj', import.meta.url), 'utf8');
  assert.match(project, /EmbeddedResource Include="\.\.\/\.\.\/apps\/web\/src\/modelParameterContract\.json" LogicalName="SparkStudio\.ModelParameterContract\.json"/);
  for (const name of ['A', 'Device-ID_2', 'A' + 'z'.repeat(63)]) {
    assert.ok(rules.modelParameterNamePattern.test(name)); assert.deepEqual(rules.modelPlaceholderNames(`{${name}}`, [name]), [name]);
  }
  for (const name of ['_Device', '9Device', 'Device.name', 'Device name', 'A' + 'z'.repeat(64)]) {
    assert.equal(rules.modelParameterNamePattern.test(name), false); assert.throws(() => rules.modelPlaceholderNames(`{${name}}`, [name]));
  }
  assert.equal(rules.modelPlaceholderNames('{A}'.repeat(contract.maximumPlaceholders), ['A']).length, contract.maximumPlaceholders);
  assert.throws(() => rules.modelPlaceholderNames('{A}'.repeat(contract.maximumPlaceholders + 1), ['A']));
});
check('tag drop copies declared type and metadata, sanitizes names and disambiguates collisions', () => {
  const tags = [{ path: '[default]Raw/Speed RPM', dataType: 'Double', unit: 'rpm', description: 'Speed', range: { low: 0, high: 100 }, attributes: { critical: true } }];
  const result = ops.referenceMembersFromTags(tags, [reference('Speed_RPM', '[default]Other')]);
  assert.equal(result.members[0].path, 'Speed_RPM_2'); assert.equal(result.members[0].dataType, 'Double'); assert.equal(result.members[0].unit, 'rpm');
  result.members[0].range.high = 50; assert.equal(tags[0].range.high, 100); assert.equal(result.warnings.length, 0);
});
check('untyped source uses live hint but retains a warning and does not invent a declared type', () => {
  const tags = [{ path: '[default]Opc/Speed', liveDataType: 'Double' }], result = ops.referenceMembersFromTags(tags);
  assert.equal(result.members[0].dataType, 'Double'); assert.match(result.warnings[0], /Declare/);
  const definition = type('Opc', result.members), state = resolution.resolveModelInstance(instance(definition), [definition], tags);
  assert.equal(state.status, 'warning'); assert.match(state.members[0].message, /type unknown/);
});
check('folder drop keeps nested relative member paths and never mutates its inputs', () => {
  assert.deepEqual(dropped.members.map(member => member.path), ['Speed', 'Count', 'Axis/X/Load']);
  assert.equal(catalog[0].path, '[default]Raw/Press01/Speed'); assert.equal(dropped.members[0].target, catalog[0].path);
});
check('large folder offers bounded selection before creating members', () => {
  const large = Array.from({ length: 130 }, (_, i) => ({ path: `[default]Large/T${i}`, dataType: 'Int32' }));
  const candidates = ops.folderDropCandidates('[default]Large', large, [reference('Existing', '[default]Value')]);
  assert.equal(candidates.requiresSelection, true); assert.equal(candidates.limit, 127); assert.equal(candidates.tags.length, 130);
  assert.throws(() => ops.referenceMembersFromTags(large), /128/);
  assert.equal(ops.referenceMembersFromTags(large.slice(0, 127), [reference('Existing', '[default]Value')], '[default]Large').members.length, 127);
});
check('folder parameterization ranks complete and partial sibling suggestions', () => {
  assert.equal(offer.sourceValue, 'Press01'); assert.deepEqual(offer.suggestions.map(item => [item.value, item.matched, item.total]), [['Press02', 3, 3], ['Press03', 3, 3], ['Press04', 2, 3]]);
  assert.deepEqual(accepted.definition.parameters, [{ name: 'Device', type: 'String', required: true }]);
  assert.equal(accepted.definition.members[2].target, '[default]Raw/{Device}/Axis/X/Load'); assert.equal(accepted.instance.parameters.Device, 'Press01');
  assert.equal(accepted.instance.path, '[default]Models/Press/Press01');
});
check('declining parameterization keeps literal targets and no parameter', () => {
  assert.equal(press.parameters.length, 0); assert.equal(press.members[0].target, '[default]Raw/Press01/Speed');
  assert.equal(parameterize.offerModelParameterization(press, catalog.slice(0, 3)), undefined);
});
check('default locations follow the first model instance and support folder-to-grid', () => {
  const first = { ...accepted.instance, path: '[default]Plant/Line/Press01' };
  const next = parameterize.suggestedModelInstance(accepted.definition, accepted.offer, offer.suggestions[0], first);
  assert.equal(next.path, '[default]Plant/Line/Press02'); assert.equal(next.parameters.Device, 'Press02');
  assert.deepEqual(parameterize.modelInstanceFromFolder(accepted.definition, '[default]Raw/Press02', first), next);
  assert.throws(() => parameterize.modelInstanceFromFolder(accepted.definition, '[default]Elsewhere/Press02', first), /position/);
});
check('matching folders can be reopened for parameterized types without an existing instance', () => {
  const reopened = parameterize.inferModelParameterization(accepted.definition, '[default]Raw/Press01', catalog);
  assert.equal(reopened.parameterName, 'Device'); assert.equal(reopened.suggestions[0].value, 'Press02'); assert.equal(reopened.suggestions[0].matched, 3);
  const created = parameterize.suggestedModelInstance(accepted.definition, reopened, reopened.suggestions[0]);
  assert.equal(created.path, '[default]Models/Press/Press02'); assert.equal(created.parameters.Device, 'Press02');
  assert.equal(parameterize.inferModelParameterization(accepted.definition, '[default]Other/Press01', catalog), undefined);
});
check('parameterize rejects stale target edits and invalid names', () => {
  const changed = structuredClone(press); changed.members[0].target = '[default]Other';
  assert.throws(() => parameterize.applyModelParameterization(changed, offer), /changed/);
  assert.throws(() => parameterize.applyModelParameterization(press, offer, '_Device'), /names/);
  assert.equal(parameterize.applyModelParameterization(press, offer, 'Device-ID').definition.members[0].target, '[default]Raw/{Device-ID}/Speed');
});
check('nested drop pins the requested draft version and rejects cycles and a fifth level', () => {
  const leaf = type('Leaf', [{ path: 'Value', kind: 'memory', dataType: 'Double', value: 1 }]);
  const parent = ops.addNestedModelType(type('Parent'), leaf, [leaf]); assert.equal(parent.members[0].version, 1);
  assert.throws(() => ops.addNestedModelType(leaf, parent, [leaf, parent]), /cycle/);
  const second = ops.addNestedModelType(type('Second'), leaf, [leaf]);
  const third = ops.addNestedModelType(type('Third'), second, [leaf, second]);
  const fourth = ops.addNestedModelType(type('Fourth'), third, [leaf, second, third]);
  assert.throws(() => ops.addNestedModelType(type('Fifth'), fourth, [leaf, second, third, fourth]), /4 levels/);
});
check('member reordering and target replacement expose keyboard-equivalent pure operations', () => {
  const changed = ops.reorderModelMember(press, 0, 2); assert.deepEqual(changed.members.map(member => member.path), ['Count', 'Axis/X/Load', 'Speed']); assert.equal(press.members[0].path, 'Speed');
  const replacement = ops.replaceModelReferenceTarget(press.members[0], { path: '[default]Other', dataType: 'Int64' });
  assert.equal(replacement.requiresTypeConfirmation, true); assert.equal(press.members[0].dataType, 'Double');
});
check('resolution distinguishes complete, missing, type mismatch, required parameter and duplicate path', () => {
  const definition = accepted.definition, first = accepted.instance;
  assert.equal(resolution.resolveModelInstance(first, [definition], catalog).status, 'valid');
  assert.equal(resolution.resolveModelInstance(instance(definition, { Device: 'Missing' }), [definition], catalog).status, 'warning');
  assert.equal(resolution.resolveModelInstance(instance(definition, { Device: 'Press04' }), [definition], catalog).resolved, 2);
  const mismatch = catalog.map(tag => tag.path.endsWith('Press01/Speed') ? { ...tag, dataType: 'Int32' } : tag);
  assert.match(resolution.resolveModelInstance(first, [definition], mismatch).members[0].message, /Int32 target, Double member/);
  assert.equal(resolution.resolveModelInstance(instance(definition), [definition], catalog).status, 'invalid');
  assert.deepEqual(resolution.resolveModelInstances([first, structuredClone(first)], [definition], catalog).map(row => row.status), ['invalid', 'invalid']);
});
check('nested parameters, relative targets and full-path overrides resolve in the correct scope', () => {
  const nested = { id: 'Nested', version: 1, parameters: [{ name: 'Device', type: 'String', required: true }], members: [reference('Speed', '[default]Raw/{Device}/Speed'), reference('Copy', './Speed')] };
  const parent = { id: 'Parent', version: 1, parameters: [{ name: 'Machine', type: 'String', default: 'Press01' }], members: [{ path: 'Spindle', kind: 'type', definitionId: 'Nested', version: 1, parameters: { Device: '{Machine}' } }] };
  const current = instance(parent); current.overrides['Spindle/Speed'] = { target: '[default]Raw/Press02/Speed' };
  const row = resolution.resolveModelInstance(current, [parent, nested], catalog);
  assert.equal(row.status, 'valid'); assert.equal(row.members[0].target, '[default]Raw/Press02/Speed'); assert.equal(row.members[1].target, '[default]Models/Test/Spindle/Speed');
  current.overrides['Spindle/Absent'] = { enabled: false }; assert.equal(resolution.resolveModelInstance(current, [parent, nested], catalog).status, 'invalid');
});
check('placeholder grammar agrees with server names, occurrence limit and injection guards', () => {
  assert.deepEqual(rules.modelPlaceholderNames('{Device-ID}/{Device-ID}', ['Device-ID']), ['Device-ID', 'Device-ID']);
  for (const text of ['{_Bad}', '{X', '{X}'.repeat(17), '{Other}']) assert.throws(() => rules.modelPlaceholderNames(text, ['X']));
  const definition = { ...accepted.definition, parameters: [{ name: 'Device', type: 'String', required: true }] };
  for (const value of ['{Again}', 'Press\n01']) assert.equal(resolution.resolveModelInstance(instance(definition, { Device: value }), [definition], catalog).status, 'invalid');
  assert.equal(resolution.resolveModelInstance(instance(definition, { Device: 1 }), [definition], catalog).status, 'invalid');
});
check('Int64 parameter/default/memory resolution preserves both signed limits exactly', () => {
  const definition = type('Exact', [{ path: 'Value', kind: 'memory', dataType: 'Int64', value: '{Count}' }]); definition.parameters = [{ name: 'Count', type: 'Int64', required: true }];
  for (const text of ['9223372036854775807', '-9223372036854775808']) {
    const row = resolution.resolveModelInstance(instance(definition, { Count: text }), [definition], []); assert.equal(row.status, 'valid'); assert.equal(row.members[0].value, text);
  }
  for (const value of ['1', '-0', '09223372036854775807', '9223372036854775808', 9007199254740992, true]) assert.equal(resolution.resolveModelInstance(instance(definition, { Count: value }), [definition], []).status, 'invalid');
});
check('nested whole placeholders preserve scalar types and reject incompatible declaration types', () => {
  const nested = type('Nested', [{ path: 'Value', kind: 'memory', dataType: 'Int64', value: '{Count}' }]); nested.parameters = [{ name: 'Count', type: 'Int64' }];
  const parent = type('Parent', [{ path: 'Child', kind: 'type', definitionId: 'Nested', version: 1, parameters: { Count: '{Value}' } }]); parent.parameters = [{ name: 'Value', type: 'Int64', default: '9223372036854775807' }];
  assert.equal(resolution.resolveModelInstance(instance(parent), [parent, nested], []).members[0].value, '9223372036854775807');
  parent.parameters = [{ name: 'Value', type: 'Double', default: 42 }]; assert.equal(resolution.resolveModelInstance(instance(parent), [parent, nested], []).status, 'invalid');
});
check('exact Int64 wire strings retain numeric identity when used in typed memory or nested parameters', () => {
  const definition = type('Memory', [{ path: 'Value', kind: 'memory', dataType: 'String', value: '{Count}' }]); definition.parameters = [{ name: 'Count', type: 'Int64', default: '9223372036854775807' }];
  assert.equal(resolution.resolveModelInstance(instance(definition), [definition], []).status, 'invalid');
  const nested = type('Nested', [{ path: 'Value', kind: 'memory', dataType: 'Double', value: '{Number}' }]); nested.parameters = [{ name: 'Number', type: 'Double' }];
  definition.members = [{ path: 'Nested', kind: 'type', definitionId: 'Nested', version: 1, parameters: { Number: '{Count}' } }];
  const row = resolution.resolveModelInstance(instance(definition), [definition, nested], []); assert.equal(row.status, 'valid'); assert.equal(typeof row.members[0].value, 'number');
  for (const bad of ['0x10', '+4', '04', '-0x10']) assert.equal(typeof model.modelScalar(bad, 'Int64'), 'string');
});
check('expression/reference dependency cycles and member-folder collisions are invalid', () => {
  const cycle = type('Cycle', [reference('A', './B'), reference('B', './A')]); assert.equal(resolution.resolveModelInstance(instance(cycle), [cycle], []).status, 'invalid');
  const prefix = type('Prefix', [{ path: 'A', kind: 'memory', dataType: 'Double', value: 1 }, { path: 'A/B', kind: 'memory', dataType: 'Double', value: 2 }]);
  assert.equal(resolution.resolveModelInstance(instance(prefix), [prefix], []).status, 'invalid');
});
check('CSV and TSV selected-type paste preserves quotes, newlines and exact integers', () => {
  const definition = type('Paste', [{ path: 'Value', kind: 'memory', dataType: 'Double', value: 0 }]); definition.parameters = [{ name: 'Name', type: 'String' }, { name: 'Count', type: 'Int64' }];
  const rows = ops.pasteModelInstances('path\tName\tCount\r\n[default]A\t"one,\n two"\t9223372036854775807', definition);
  assert.equal(rows[0].parameters.Name, 'one,\n two'); assert.equal(rows[0].parameters.Count, '9223372036854775807'); assert.equal(rows[0].definitionId, 'Paste');
  assert.throws(() => ops.pasteModelInstances('path,Typo\n[default]A,x', definition), /not a parameter/);
  assert.throws(() => ops.pasteModelInstances('path\n[default]A\n[default]A', definition), /duplicate/);
});
check('selected-type paste admits 2000 rows and refuses 2001 or gateway total overflow', () => {
  const definition = type('Paste'), text = 'path\n' + Array.from({ length: 2000 }, (_, index) => `[default]P${index}`).join('\n');
  assert.equal(ops.pasteModelInstances(text, definition).length, 2000);
  assert.throws(() => ops.pasteModelInstances(text + '\n[default]Overflow', definition), /2,000/);
  assert.throws(() => ops.pasteModelInstances(text, definition, [instance(definition)]), /2,000/);
});
check('one draft package contains type plus three draft instances and supports undo/redo', () => {
  const base = model.emptyModelPackage(), first = accepted.instance;
  const instances = [first, ...offer.suggestions.filter(item => item.complete).map(item => parameterize.suggestedModelInstance(accepted.definition, accepted.offer, item, first))];
  const next = { ...base, udtDefinitions: [accepted.definition], instances }, state = draft.editModelDraft(draft.createModelDraft(base), next);
  const package_ = draft.modelDraftPackage(state.base, state.present); assert.equal(package_.udtDefinitions.length, 1); assert.equal(package_.instances.length, 3);
  assert.deepEqual(resolution.resolveModelInstances(instances, next.udtDefinitions, catalog).map(row => row.status), ['valid', 'valid', 'valid']);
  assert.equal(draft.undoModelDraft(state).present.udtDefinitions.length, 0); assert.equal(draft.redoModelDraft(draft.undoModelDraft(state)).present.instances.length, 3);
});
check('pending count represents net changed items across repeated hierarchy edits and reverts', () => {
  const base = { ...model.emptyModelPackage(), hierarchy: [{ path: '[default]Plant', level: 'Site' }] };
  let state = draft.createModelDraft(base);
  for (const level of ['Area', 'Line', 'Cell', 'Enterprise', 'Custom', 'Area']) {
    state = draft.editModelDraft(state, { ...state.present, hierarchy: [{ ...base.hierarchy[0], level }] });
    assert.deepEqual(draft.modelDraftChanges(base, state.present), [{ kind: 'hierarchy', key: '[default]Plant', action: 'update' }]);
    assert.equal(draft.modelDraftChangeSummary(draft.modelDraftChanges(base, state.present)), '1 location');
  }
  assert.equal(state.past.length, 6);
  state = draft.editModelDraft(state, structuredClone(base));
  assert.equal(draft.modelDraftChanges(base, state.present).length, 0); assert.equal(draft.modelDraftPackage(base, state.present).hierarchy.length, 0);
  assert.equal(draft.modelDraftChanges(base, draft.undoModelDraft(state).present).length, 1);
});
check('reverting optional provider defaults removes the net change and preserves compatible recovery', () => {
  const base = { ...model.emptyModelPackage(), provider: { name: 'default', enabled: true } };
  const enabled = { ...base, provider: { ...base.provider, requireDeclaredHierarchy: true } };
  const reverted = { ...base, provider: { ...base.provider, requireDeclaredHierarchy: false } };
  const state = draft.editModelDraft(draft.createModelDraft(base), enabled);
  assert.equal(draft.modelDraftChanges(base, enabled).length, 1);
  assert.equal(draft.modelDraftChanges(base, reverted).length, 0); assert.equal(draft.modelDraftPackage(base, reverted).provider, undefined);
  assert.equal(draft.editModelDraft(draft.createModelDraft(base), reverted).revision, 0);
  let raw; const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; }, removeItem() {} };
  draft.persistModelDraft(storage, 'owner', state);
  assert.deepEqual(draft.restoreModelDraft(storage, 'owner', reverted).conflicts, []);
  assert.equal(draft.restoreModelDraft(storage, 'owner', reverted).state.present.provider.requireDeclaredHierarchy, true);
});
check('draft summary explains which kinds of items changed', () => {
  assert.equal(draft.modelDraftChangeSummary([{ kind: 'udtDefinitions' }, { kind: 'instances' }, { kind: 'instances' }, { kind: 'hierarchy' }, { kind: 'provider' }]), '1 model · 2 equipment entries · 1 location · 1 gateway data setting');
});
check('session recovery restores the combined draft for its owner and reports changed saved resources', () => {
  const storage = new Map(), adapter = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const base = model.emptyModelPackage(), next = { ...base, udtDefinitions: [accepted.definition], instances: [accepted.instance], hierarchy: [{ path: '[default]Plant', level: 'Site' }] };
  const state = draft.editModelDraft(draft.createModelDraft(base), next); draft.persistModelDraft(adapter, 'owner-A', state);
  const restored = draft.restoreModelDraft(adapter, 'owner-A', base); assert.equal(restored.restored, true); assert.deepEqual(restored.state.present, next); assert.deepEqual(restored.conflicts, []);
  assert.equal(draft.restoreModelDraft(adapter, 'owner-B', base).restored, false);
  const changed = { ...base, hierarchy: [{ path: '[default]Plant', level: 'Enterprise' }] };
  assert.match(draft.restoreModelDraft(adapter, 'owner-A', changed).conflicts[0], /Plant changed/);
  draft.clearPersistedModelDraft(adapter, 'owner-A'); assert.equal(draft.restoreModelDraft(adapter, 'owner-A', base).restored, false);
});
check('malformed imported, assistant and recovered shapes cannot replace a working draft', () => {
  const base = model.emptyModelPackage(), state = draft.editModelDraft(draft.createModelDraft(base), { ...base, udtDefinitions: [accepted.definition] });
  for (const patch of [{ udtDefinitions: [{ id: 'Broken', version: 1, members: null }] }, { instances: [{ ...accepted.instance, parameters: [] }] }, { hierarchy: [{ path: {}, level: 'Site' }] }]) {
    const invalid = { ...base, ...patch };
    assert.throws(() => draft.mergeModelPackage(state.present, invalid));
    const raw = JSON.stringify({ schema: 1, ownerId: 'A', package: invalid, expected: [] });
    assert.throws(() => draft.restoreModelDraft({ getItem: () => raw }, 'A', base));
  }
  assert.throws(() => draft.mergeAssistantModelDraft(state, { definition: { id: 'Broken', version: 1, members: null } }));
  assert.equal(state.present.udtDefinitions[0], accepted.definition);
});
check('review groups the changed type, instance and members together and links conflicts to the longest known path', () => {
  const member = { ...accepted.definition.members[0], path: accepted.instance.path + '/Speed', udtInstance: accepted.instance.path, udtDefinition: 'Press', udtVersion: 1 };
  const preview = { changes: [{ path: member.path, kind: 'reference', action: 'update' }, { path: '[default]Plant', kind: 'hierarchy', action: 'add' }, { path: accepted.instance.path, kind: 'instances', action: 'add' }, { path: 'Press@1', kind: 'udtDefinitions', action: 'add' }], expandedTags: [member], conflicts: ['Reference ' + member.path + ' does not match target.'] };
  const current = { ...model.emptyModelPackage(), udtDefinitions: [accepted.definition], instances: [accepted.instance] };
  const rows = review.modelReviewRows(preview, current); assert.deepEqual(rows.slice(0, 3).map(row => row.change.path), ['Press@1', accepted.instance.path, member.path]);
  assert.equal(rows[0].group, 'Type Press@1'); assert.equal(rows[2].instancePath, accepted.instance.path);
  assert.deepEqual(review.modelConflictTargets(preview, current)[0], [{ path: member.path, label: 'Open ' + member.path }]);
});
check('review hides unrelated unchanged models and members by default but can show them explicitly', () => {
  const unchanged = { path: '[default]Old/Speed', kind: 'reference', dataType: 'Double', udtInstance: '[default]Old', udtDefinition: 'Old', udtVersion: 1 };
  const current = { ...unchanged, path: '[default]New/Speed', udtInstance: '[default]New', udtDefinition: 'New' };
  const preview = { changes: [{ path: 'Old@1', kind: 'udtDefinitions', action: 'unchanged' }, { path: unchanged.path, kind: 'reference', action: 'unchanged' }, { path: current.path, kind: 'reference', action: 'update' }], expandedTags: [unchanged, current] };
  assert.deepEqual(review.modelReviewRows(preview).map(row => row.change.path), [current.path]);
  assert.equal(review.modelReviewRows(preview, undefined, true).length, 3);
  assert.deepEqual(review.changedModelMembers(preview), [current]);
  for (const path of [current.udtInstance, 'New@1']) assert.deepEqual(review.changedModelMembers({ ...preview, changes: [{ path, action: 'update' }] }), [current]);
  assert.deepEqual(review.changedModelMembers({ ...preview, changes: [{ path: '[default]Plant', kind: 'hierarchy', action: 'update' }] }), []);
});
check('model status distinguishes waiting values and current good data from a stale unavailable snapshot', () => {
  const health = { state: 'Running', configuredTags: 1, goodTags: 0, unavailableTags: 1, disabledTags: 0 };
  const tag = { path: '[default]New/Speed' };
  assert.deepEqual(model.modelProviderStatus(null, [tag], []), { label: 'Connecting to gateway…', degraded: false });
  assert.deepEqual(model.modelProviderStatus(health, [], []), { label: 'Loading data status…', degraded: false });
  assert.deepEqual(model.modelProviderStatus(health, [tag], []), { label: '1 waiting for data', degraded: false });
  assert.deepEqual(model.modelProviderStatus(health, [tag], [{ ...tag, quality: 'Bad_WaitingForInitialData' }]), { label: '1 waiting for data', degraded: false });
  assert.deepEqual(model.modelProviderStatus(health, [tag], [{ ...tag, quality: 'Good' }]), { label: 'Data running · 1 tag', degraded: false });
});
check('model status keeps real bad and uncertain data visible and treats disabled members separately', () => {
  const health = { state: 'Running', configuredTags: 4, goodTags: 0, unavailableTags: 4, disabledTags: 0 };
  const tags = ['Bad_NoData', 'Uncertain_Retained', 'Bad_WaitingForInitialData', 'Bad_Disabled'].map((quality, index) => ({ path: '[default]T' + index, quality }));
  assert.deepEqual(model.modelProviderStatus(health, tags, tags), { label: '1 unavailable · 1 uncertain · 1 waiting for data · 1 disabled', degraded: true });
  assert.deepEqual(model.modelProviderStatus(health, [{ path: '[default]A', effectiveEnabled: false }], []), { label: '1 disabled', degraded: false });
  assert.deepEqual(model.modelProviderStatus({ ...health, state: 'Disabled' }, tags, tags), { label: 'Data collection paused', degraded: false });
});

check('source mappings participate in atomic draft diff, undo and session recovery', () => {
  const base=model.emptyModelPackage(), mapping={id:'SiemensPress',definitionId:'Press',version:1,bindings:{Speed:{kind:'reference',target:'[default]Raw/{Device}/Speed'}}};
  const present={...base,mappingProfiles:[mapping]}, state=draft.editModelDraft(draft.createModelDraft(base),present);
  assert.deepEqual(draft.modelDraftChanges(base,present),[{kind:'mappingProfiles',key:'SiemensPress',action:'add'}]);
  assert.deepEqual(draft.modelDraftPackage(base,present).mappingProfiles,[mapping]);assert.deepEqual(draft.undoModelDraft(state).present,base);
  const entries=new Map(),storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
  draft.persistModelDraft(storage,'author',state);assert.deepEqual(draft.restoreModelDraft(storage,'author',base).state.present.mappingProfiles,[mapping]);
  assert.deepEqual(draft.modelDraftPackage(present,base).removeMappingProfiles,['SiemensPress']);
});
check('reusable mappings replace only sources before parameter substitution and explicit equipment overrides', () => {
  const definition={id:'Mapped',version:1,parameters:[{name:'Device',type:'String',required:true}],members:[{path:'Speed',kind:'memory',dataType:'Double',value:0,range:{low:0,high:100},freshnessMs:1000}]};
  const profile={id:'PLC',definitionId:'Mapped',version:1,bindings:{Speed:{kind:'reference',target:'[default]Raw/{Device}/Speed'}}}, item={path:'[default]Mapped01',definitionId:'Mapped',version:1,mappingProfileId:'PLC',parameters:{Device:'Press01'}};
  const result=resolution.resolveModelInstance(item,[definition],catalog,[item],[profile]);assert.equal(result.status,'valid');assert.equal(result.members[0].target,'[default]Raw/Press01/Speed');assert.equal(result.members[0].value,undefined);assert.equal(result.members[0].freshnessMs,1000);
  const overridden=resolution.resolveModelInstance({...item,overrides:{Speed:{target:'[default]Raw/Press02/Speed',freshnessMs:2000}}},[definition],catalog,[item],[profile]);assert.equal(overridden.members[0].target,'[default]Raw/Press02/Speed');assert.equal(overridden.members[0].freshnessMs,2000);
  assert.equal(resolution.resolveModelInstance(item,[definition],catalog,[item],[]).status,'invalid');
  assert.equal(resolution.resolveModelInstance(item,[definition],catalog,[item],[{...profile,version:2}]).status,'invalid');
});
check('contract draft validation rejects malformed rules and preserves exact integer enum text', () => {
  const value={id:'Contract',version:1,members:[{path:'Count',kind:'memory',dataType:'Int64',value:'9223372036854775807',enumValues:['9223372036854775807'],freshnessMs:1000,unitSystem:'ucum',unit:'1'}]};
  model.validateDraftDefinition(value);assert.equal(value.members[0].enumValues[0],'9223372036854775807');
  for(const patch of [{freshnessMs:-1},{freshnessMs:86400001},{unitSystem:'unknown'},{enumValues:{}},{alarms:[{id:'bad'}]}]) assert.throws(()=>model.validateDraftDefinition({...value,members:[{...value.members[0],...patch}]}));
});

check('nested field source mappings bind the root equipment parameters before nested overrides', () => {
 const child={id:'ChildMapping',version:1,members:[{path:'Speed',kind:'memory',dataType:'Double',value:0}]},parent={id:'ParentMapping',version:1,parameters:[{name:'Device',type:'String',required:true}],members:[{path:'Axis',kind:'type',definitionId:'ChildMapping',version:1}]};
 const profile={id:'NestedSource',definitionId:'ParentMapping',version:1,bindings:{'Axis/Speed':{kind:'reference',target:'[default]Raw/{Device}/Speed'}}},equipment={path:'[default]NestedMapped',definitionId:'ParentMapping',version:1,mappingProfileId:'NestedSource',parameters:{Device:'Press01'}};
 const result=resolution.resolveModelInstance(equipment,[parent,child],catalog,[equipment],[profile]);assert.equal(result.status,'valid');assert.equal(result.members[0].target,'[default]Raw/Press01/Speed');assert.equal(result.members[0].path,'Axis/Speed');
});
console.log(`${passed} model builder checks passed.`);
