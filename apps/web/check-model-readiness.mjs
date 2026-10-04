import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

const file = createTestModuleFiles();
const source = fs.readFileSync(new URL('src/modelReadiness.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { modelEquipmentReadiness, modelReadinessContext, modelIssueLabel } = await import(file(code));
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const member = { path: 'Load', concretePath: '[default]Plant/Press01/Load', kind: 'memory', dataType: 'Int32', value: 0, status: 'valid', issues: [] };
const definition = { id: 'Press', version: 1, members: [{ path: 'Load', kind: 'memory', dataType: 'Int32', value: 0 }] };
const instance = { path: '[default]Plant/Press01', definitionId: 'Press', version: 1, parameters: {}, overrides: {} };
const model = { format: 'sparkstudio.tags', version: 3, tags: [], hierarchy: [], udtDefinitions: [definition], instances: [instance], scanGroups: [] };
const resolution = { status: 'valid', errors: [], total: 1, resolved: 1, members: [member] };
const live = { path: member.concretePath, value: 0, dataType: 'Int32', quality: 'Good', timestamp: '2026-10-04T12:00:00Z' };
const state = (draft = model, saved = model, values = [live], result = resolution) => modelEquipmentReadiness(draft.instances[0], result, modelReadinessContext(draft, saved, values));

check('unapplied equipment is not ready even when its links and coincident live values look valid', () => {
  const result = state(model, { ...model, instances: [] }); assert.equal(result.state, 'setup'); assert.match(result.message, /apply the draft/);
});
check('saved resolvable equipment without samples waits for data', () => {
  const result = state(model, model, []); assert.equal(result.state, 'waiting'); assert.equal(result.good, 0); assert.equal(result.fields[0].path, 'Load');
});
check('initial no-data qualities wait rather than claiming a data failure', () => {
  for (const quality of ['Bad_WaitingForInitialData', 'Bad_NoData']) assert.equal(state(model, model, [{ ...live, quality }]).state, 'waiting');
});
check('saved equipment with good samples is ready and accepts zero and false values', () => {
  assert.equal(state().state, 'ready'); assert.equal(state(model, model, [{ ...live, value: false }]).state, 'ready');
});
check('a good quality label without a real sample timestamp still waits', () => {
  assert.equal(state(model, model, [{ ...live, timestamp: '' }]).state, 'waiting');
  assert.equal(state(model, model, [{ ...live, timestamp: '0001-01-01T00:00:00Z' }]).state, 'waiting');
  assert.equal(state(model, model, [{ ...live, timestamp: '', receiptTimestamp: live.timestamp }]).state, 'ready');
});
check('bad and uncertain source quality remains a data issue', () => {
  for (const quality of ['Bad_NotConnected', 'Bad_NotFound', 'Bad_Disabled', 'Uncertain_LastUsableValue']) assert.equal(state(model, model, [{ ...live, quality }]).state, 'issue');
});
check('model rule failures are human readable and cannot be hidden by source Good quality', () => {
  const result = state(model, model, [{ ...live, quality: 'Good', sourceQuality: 'Good', modelIssues: [{ code: 'outOfRange', message: 'Outside range', expected: '0–100' }] }]);
  assert.equal(result.state, 'issue'); assert.equal(result.fields[0].label, 'Out of range');
  assert.equal(state(model, model, [{ ...live, quality: 'Uncertain_ModelStale' }]).fields[0].label, 'Data is stale');
});
check('data failures take precedence over other members waiting for their first sample', () => {
  const result = state(model, model, [{ ...live, quality: 'Bad_NotFound' }], { ...resolution, total: 2, resolved: 2, members: [member, { ...member, path: 'Speed', concretePath: instance.path + '/Speed' }] });
  assert.equal(result.state, 'issue'); assert.equal(result.fields.length, 2);
});
check('invalid and unresolved setup retains configuration status before inspecting stale runtime data', () => {
  for (const status of ['invalid', 'warning']) assert.equal(state(model, model, [live], { ...resolution, status }).state, 'setup');
});
check('draft parameters overrides and model definition changes invalidate a former Ready result', () => {
  const draft = structuredClone(model); draft.instances[0].overrides = { Load: { value: 15 } }; assert.equal(state(draft).state, 'setup');
  const altered = structuredClone(model); altered.udtDefinitions[0].members[0].value = 12; assert.equal(state(altered).state, 'setup');
});
check('nested model changes are included in the saved definition comparison', () => {
  const parent = structuredClone(model); parent.udtDefinitions.push({ id: 'Motor', version: 1, members: [definition.members[0]] });
  parent.udtDefinitions[0].members = [{ path: 'Motor', kind: 'type', definitionId: 'Motor', version: 1 }];
  const draft = structuredClone(parent); draft.udtDefinitions[1].members[0].value = 5;
  assert.equal(state(draft, parent).state, 'setup');
});
check('an unsaved mapping or scan group change cannot reuse previous good data', () => {
  const saved = structuredClone(model); saved.instances[0].mappingProfileId = 'press-plc';
  saved.mappingProfiles = [{ id: 'press-plc', definitionId: 'Press', version: 1, bindings: { Load: { kind: 'memory', value: 1 } } }];
  const draft = structuredClone(saved); draft.mappingProfiles[0].bindings.Load.value = 2; assert.equal(state(draft, saved).state, 'setup');
  const withGroup = { ...resolution, members: [{ ...member, scanGroup: 'Fast' }] };
  const grouped = { ...model, scanGroups: [{ name: 'Fast', publishingIntervalMs: 1000 }] };
  assert.equal(state({ ...grouped, scanGroups: [{ name: 'Fast', publishingIntervalMs: 2000 }] }, grouped, [live], withGroup).state, 'setup');
});
check('unrelated model edits and object property order do not invalidate saved good equipment', () => {
  const draft = structuredClone(model); draft.udtDefinitions.push({ id: 'Other', version: 1, members: [] });
  draft.instances[0] = { overrides: {}, version: 1, definitionId: 'Press', parameters: {}, path: instance.path };
  assert.equal(state(draft).state, 'ready');
});
check('disabled equipment provider and all-disabled fields explain the setup action', () => {
  const disabled = { ...model, instances: [{ ...instance, enabled: false }] }; assert.match(state(disabled, disabled).message, /turned off/);
  const paused = { ...model, provider: { name: 'default', enabled: false } }; assert.match(state(paused, paused).message, /paused/);
  const inactive = { ...resolution, members: [{ ...member, enabled: false }] }; assert.match(state(model, model, [live], inactive).message, /No fields are enabled/);
});
check('intentionally disabled members do not prevent remaining enabled fields becoming Ready', () => {
  const result = { ...resolution, total: 2, resolved: 2, members: [member, { ...member, path: 'Unused', concretePath: instance.path + '/Unused', enabled: false }] };
  const value = state(model, model, [live], result); assert.equal(value.state, 'ready'); assert.equal(value.total, 1);
});
check('disabled nested models are excluded even though browser resolution does not carry effectiveEnabled', () => {
  const saved = structuredClone(model); saved.udtDefinitions.push({ id: 'Motor', version: 1, members: [definition.members[0]] });
  saved.udtDefinitions[0].members.push({ path: 'Optional/Motor', kind: 'type', definitionId: 'Motor', version: 1, enabled: false });
  const nested = { ...member, path: 'Optional/Motor/Load', concretePath: instance.path + '/Optional/Motor/Load' };
  const result = state(saved, saved, [live, { ...live, path: nested.concretePath, quality: 'Bad_Disabled' }], { ...resolution, total: 2, members: [member, nested] });
  assert.equal(result.state, 'ready'); assert.equal(result.total, 1);
});
check('referenced source edits block readiness while unrelated source edits do not', () => {
  const source = { path: '[default]Source/Load', kind: 'memory', dataType: 'Int32', value: 1 };
  const saved = { ...model, tags: [source] }, draft = { ...saved, tags: [{ ...source, value: 2 }] };
  const reference = { ...resolution, members: [{ ...member, kind: 'reference', target: source.path }] };
  assert.equal(state(draft, saved, [live], reference).state, 'setup');
  assert.equal(state({ ...saved, tags: [source, { ...source, path: '[default]Other', value: 7 }] }, saved, [live], reference).state, 'ready');
});
check('a changed referenced machine also prevents reusing old good data', () => {
  const other = { ...instance, path: '[default]Plant/Press02' }, saved = { ...model, instances: [instance, other] };
  const draft = { ...saved, instances: [instance, { ...other, overrides: { Load: { value: 15 } } }] };
  const reference = { ...resolution, members: [{ ...member, kind: 'reference', target: other.path + '/Load' }] };
  assert.equal(state(draft, saved, [live], reference).state, 'setup');
});
check('ten thousand runtime tags are indexed once for a thousand equipment rows', () => {
  const instances = Array.from({ length: 1000 }, (_, index) => ({ ...instance, path: '[default]Scale/Unit' + index }));
  const saved = { ...model, instances }, values = instances.flatMap(item => Array.from({ length: 10 }, (_, index) => ({ ...live, path: item.path + '/Field' + index })));
  const context = modelReadinessContext(saved, saved, values); assert.equal(context.live.size, 10000);
  for (const item of instances) {
    const result = { ...resolution, total: 10, resolved: 10, members: Array.from({ length: 10 }, (_, index) => ({ ...member, path: 'Field' + index, concretePath: item.path + '/Field' + index })) };
    assert.equal(modelEquipmentReadiness(item, result, context).state, 'ready');
  }
});
check('missing deferred resolution is Checking instead of a false readiness state', () => {
  assert.equal(modelEquipmentReadiness(instance, undefined, modelReadinessContext(model, model, [live])), undefined);
});
check('issue labels cover gateway contract codes and preserve unknown codes in technical detail', () => {
  for (const [code, label] of [['outOfRange', 'Out of range'], ['stale', 'Data is stale'], ['invalidEnum', 'Unexpected value'], ['invalidType', 'Wrong data type'], ['futureCode', 'Data issue']]) assert.equal(modelIssueLabel(code), label);
});
console.log(`Model readiness checks: ${passed} passed.`);
