import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
    .replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(name, url); return url;
}
const {runtimeBindingHealth} = await import(load('runtimeQuality'));
const {evaluateComponentBindings} = await import(load('propertyBindings'));
const {instanceInputKey} = await import(load('templateModel'));
const component = (id, type, props) => ({id, type, x: 0, y: 0, width: 100, height: 50, props});
const tag = (path, changes = {}) => ({path, value: 64, quality: 'Good', dataType: 'Double', timestamp: '', ...changes});
const field = component('machine', 'textInput', {fieldKey: 'machine', defaultValue: 'Press01'});
const gauge = component('load', 'gauge', {tagPath: '[default]Unselected/Load', bindings: {tagPath: {expression: "'[default]' + machine + '/Load'", references: {machine: {kind: 'input', key: 'machine'}}}}});
const screen = {id: 'main', name: 'Main', width: 800, height: 600, components: [field, gauge]};
const tags = [tag('[default]Press01/Load'), tag('[default]Press02/Load', {source: 'simulated'}), tag('[default]Unselected/Load', {quality: 'Bad_NotConnected'})];
const health = (changes = {}) => {
  const data = {screen, templates: [], tags, parameters: {}, edits: {}, offline: false, ...changes};
  return runtimeBindingHealth(data.screen, data.templates, data.tags, data.parameters, data.edits, data.offline);
};
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
test('selected display tag replaces authored fallback in health and simulated status', () => {
  assert.deepEqual(health(), {badCount: 0, simulated: false});
  assert.deepEqual(health({edits: {main: {machine: 'Press02'}}}), {badCount: 0, simulated: true});
  assert.deepEqual(health({edits: {main: {machine: 'Missing'}}}), {badCount: 1, simulated: false});
});
test('failed path bindings never report the authored fallback as healthy or simulated', () => {
  assert.deepEqual(health({edits: {main: {machine: null}}, tags: [tag('[default]Unselected/Load', {source: 'simulated'})]}), {badCount: 1, simulated: false});
});
test('dynamic parameter references use the same complete-path validation as rendering', () => {
  const dynamic = structuredClone(gauge); dynamic.props.bindings.tagPath.references.machine = {kind: 'parameter', key: 'machine'};
  assert.deepEqual(health({screen: {...screen, components: [dynamic]}, parameters: {machine: 'Press02'}}), {badCount: 0, simulated: true});
  dynamic.props.bindings.tagPath = {expression: "'[default]{machine}/Load'", references: {}};
  assert.deepEqual(health({screen: {...screen, components: [dynamic]}, parameters: {machine: 'Press02'}}), {badCount: 1, simulated: false});
});
test('unknown, bad quality, communication loss and unsafe integer displays need attention', () => {
  assert.equal(health({tags: []}).badCount, 1);
  assert.equal(health({tags: [tag('[default]Press01/Load', {quality: 'Bad_NotConnected'})]}).badCount, 1);
  assert.equal(health({offline: true}).badCount, 1);
  assert.equal(health({tags: [tag('[default]Press01/Load', {value: Number.MAX_SAFE_INTEGER + 1})]}).badCount, 1);
  assert.equal(health({screen: {...screen, components: [component('empty', 'value', {})]}}).badCount, 1);
});
test('binding errors count once per component and include non-tag property failures', () => {
  const broken = component('caption', 'label', {bindings: {text: {expression: 'missing', references: {}}, visible: {expression: 'missing', references: {}}}});
  assert.deepEqual(health({screen: {...screen, components: [broken]}}), {badCount: 1, simulated: false});
});
test('sibling custom properties resolve inside the owning component scope', () => {
  const owner = component('settings', 'label', {customProperties: {machine: {type: 'string', value: 'Press02'}}});
  const dynamic = structuredClone(gauge); dynamic.props.bindings.tagPath.references.machine = {kind: 'custom', componentId: 'settings', key: 'machine'};
  assert.deepEqual(health({screen: {...screen, components: [owner, dynamic]}}), {badCount: 0, simulated: true});
});
test('template and repeater row fields resolve using isolated edits and saved defaults', () => {
  const template = {id: 'equipment', name: 'Equipment', width: 300, height: 200, parameters: {}, components: [field, gauge]};
  const instance = component('one', 'template', {templateId: template.id});
  const repeat = component('repeat', 'repeater', {templateId: template.id, rows: [{id: 'a', parameters: {}}, {id: 'b', parameters: {}}]});
  const fixture = {...screen, components: [field, gauge, instance, repeat]};
  const edits = {main: {machine: 'Missing'}, [instanceInputKey('main', 'one')]: {machine: 'Press02'}, [instanceInputKey('main', 'repeat', 'a')]: {machine: 'Press01'}, [instanceInputKey('main', 'repeat', 'b')]: {machine: 'Missing'}};
  assert.deepEqual(health({screen: fixture, templates: [template], edits}), {badCount: 2, simulated: true});
});
test('invalid typed template contexts produce health diagnostics instead of crashing', () => {
  const template = {id: 'typed', name: 'Typed', width: 300, height: 200, parameters: {count: '{count}'}, parameterTypes: {count: 'number'}, components: [gauge]};
  const instance = component('typedInstance', 'template', {templateId: template.id});
  assert.equal(health({screen: {...screen, components: [instance]}, templates: [template], parameters: {count: 'bad'}}).badCount, 1);
});
test('unknown or malformed indicators count once and valid mappings remain healthy', () => {
  const indicator = component('indicator', 'multiStateIndicator', { stateValue: 'run', states: [{ value: 'run', label: 'Running', color: '#0a0' }] });
  const current = (changes = {}, context = {}) => health({ screen: {...screen, components: [{...indicator, props: {...indicator.props, ...changes}}]}, ...context });
  assert.equal(current().badCount, 0);
  assert.equal(current({stateValue: 'unknown'}).badCount, 1);
  assert.equal(current({states: [{value: 'run', label: 'Running', color: 'invalid'}]}).badCount, 1);
  assert.equal(current({stateValue: undefined}).badCount, 1);
  assert.equal(current({bindings: {stateValue: {expression: 'missing', references: {}}, text: {expression: 'missing', references: {}}}}).badCount, 1);
});
test('indicator health uses one-pass authored interpolation and literal bound scalar semantics', () => {
  const indicator = component('indicator', 'multiStateIndicator', { stateValue: '{mode}', states: [{value: '{next}', label: 'Literal braces', color: '#abc'}] });
  const fixture = {...screen, components: [indicator]};
  assert.equal(health({screen: fixture, parameters: {mode: '{next}', next: 'other'}}).badCount, 0);
  indicator.props.bindings = {stateValue: {expression: 'mode', references: {mode: {kind: 'parameter', key: 'mode'}}}};
  assert.equal(health({screen: fixture, parameters: {mode: '{next}', next: 'other'}}).badCount, 0);
  indicator.props.states = [{value: '2', label: 'Second', color: '#abc'}];
  assert.equal(health({screen: fixture, parameters: {mode: 2}}).badCount, 0);
  assert.equal(health({screen: fixture, parameters: {mode: 3}}).badCount, 1);
});
test('bad-quality indicator bindings never retain a healthy authored state', () => {
  const indicator = component('indicator', 'multiStateIndicator', {stateValue: 'run', states: [{value: 'run', label: 'Running', color: '#0a0'}],
    bindings: {stateValue: {expression: 'mode', references: {mode: {kind: 'tag', path: '[default]Mode'}}}}});
  const fixture = {...screen, components: [indicator]}, stateTag = tag('[default]Mode', {value: 'run', dataType: 'String'});
  assert.equal(health({screen: fixture, tags: [stateTag]}).badCount, 0);
  assert.equal(health({screen: fixture, tags: [{...stateTag, quality: 'Bad_NotConnected'}]}).badCount, 1);
  assert.equal(health({screen: fixture, tags: [stateTag], offline: true}).badCount, 1);
});
test('template and row parameter overrides match renderer precedence for static tags', () => {
  const template = {id: 'static', name: 'Static', width: 300, height: 200, parameters: {machine: 'Press01'}, components: [component('value', 'value', {tagPath: '[default]{machine}/Load'})]};
  const repeat = component('repeat', 'repeater', {templateId: template.id, parameters: {machine: 'Missing'}, rows: [{id: 'a', parameters: {machine: 'Press02'}}, {id: 'b', parameters: {machine: 'Press01'}}]});
  assert.deepEqual(health({screen: {...screen, components: [repeat]}, templates: [template], parameters: {machine: 'Root'}}), {badCount: 0, simulated: true});
});
test('tag-backed form inputs drive dynamic display paths without edited state', () => {
  const bound = {...field, props: {...field.props, tagPath: '[default]Selection'}};
  assert.deepEqual(health({screen: {...screen, components: [bound, gauge]}, tags: [...tags, tag('[default]Selection', {value: 'Press02', dataType: 'String'})]}), {badCount: 0, simulated: true});
});
test('empty screen and empty repeater have no phantom bindings; missing template is flagged', () => {
  assert.deepEqual(health({screen: undefined}), {badCount: 0, simulated: false});
  assert.equal(health({screen: {...screen, components: [component('missing', 'template', {templateId: 'missing'})]}}).badCount, 1);
  const template = {id: 'empty', name: 'Empty', width: 100, height: 100, parameters: {}, components: [gauge]};
  assert.equal(health({screen: {...screen, components: [component('repeat', 'repeater', {templateId: 'empty', rows: []})]}, templates: [template]}).badCount, 0);
});
test('wrapper binding failures count once in parent scope independently of each child row', () => {
  const template = {id: 'empty', name: 'Empty', width: 100, height: 100, parameters: {}, components: []};
  const wrapper = component('wrapper', 'repeater', {templateId: 'empty', rows: [{id: 'a', parameters: {}}, {id: 'b', parameters: {}}], bindings: {
    enabled: {expression: 'permit', references: {permit: {kind: 'input', key: 'permit'}}},
    backgroundColor: {expression: 'missing', references: {}},
  }});
  const fixture = {...screen, components: [component('permit', 'checkbox', {fieldKey: 'permit', defaultValue: null}), wrapper]};
  assert.equal(health({screen: fixture, templates: [template]}).badCount, 1);
  assert.equal(health({screen: fixture, templates: []}).badCount, 1);
  delete wrapper.props.bindings.backgroundColor;
  assert.equal(health({screen: fixture, templates: [template], edits: {main: {permit: true}}}).badCount, 0);
  assert.equal(health({screen: fixture, templates: [template], edits: {[instanceInputKey('main', 'wrapper', 'a')]: {permit: true}}}).badCount, 1);
});
test('wrapper tag quality and connection failures contribute to runtime diagnostics', () => {
  const template = {id: 'empty', name: 'Empty', width: 100, height: 100, parameters: {}, components: []};
  const wrapper = component('wrapper', 'template', {templateId: 'empty', bindings: {width: {expression: 'size', references: {size: {kind: 'tag', path: '[default]Width'}}}}});
  const fixture = {screen: {...screen, components: [wrapper]}, templates: [template], tags: [tag('[default]Width', {value: 500})]};
  assert.equal(health(fixture).badCount, 0);
  assert.equal(health({...fixture, offline: true}).badCount, 1);
  assert.equal(health({...fixture, tags: [tag('[default]Width', {value: 500, quality: 'Bad'})]}).badCount, 1);
});

test('successful drawing fx tag reads contribute simulated status without a direct tagPath', () => {
  for (const [type, target] of [['pipe', 'flowing'], ['equipmentSymbol', 'active']]) {
    const drawing = component('drawing', type, { [target]: false, bindings: { [target]: { expression: 'running', references: { running: { kind: 'tag', path: '[default]{machine}/Running' } } } } });
    const fixture = { screen: { ...screen, components: [drawing] }, parameters: { machine: 'Demo' }, tags: [tag('[default]Demo/Running', { value: true, source: 'simulated' })] };
    assert.deepEqual(health(fixture), { badCount: 0, simulated: true });
    assert.deepEqual(health({ ...fixture, tags: [tag('[default]Demo/Running', { value: false })] }), { badCount: 0, simulated: false });
    for (const changes of [{ quality: 'Bad_NotConnected' }, { value: 'true' }, { value: Number.MAX_SAFE_INTEGER + 1 }])
      assert.deepEqual(health({ ...fixture, tags: [{ ...fixture.tags[0], ...changes }] }), { badCount: 1, simulated: false });
    assert.deepEqual(health({ ...fixture, offline: true }), { badCount: 1, simulated: false });
  }
});

test('simulation metadata tracks only visited references of successful targets and preserves inputs', () => {
  const drawing = component('drawing', 'pipe', { flowing: true, bindings: { flowing: {
    expression: 'permit ? running : false', references: { permit: { kind: 'parameter', key: 'permit' }, running: { kind: 'tag', path: '[default]Demo/Running' }, unused: { kind: 'tag', path: '[default]Unused' } },
  } } });
  const context = { components: [drawing], parameters: { permit: false }, inputs: {}, tags: [tag('[default]Demo/Running', { value: true, source: 'simulated' })] };
  const before = structuredClone({ drawing, context });
  assert.equal(evaluateComponentBindings(drawing, context).simulated, undefined);
  assert.equal(evaluateComponentBindings(drawing, { ...context, parameters: { permit: true } }).simulated, true);
  for (const expression of ['false && running', 'true || running', 'false ? running : true']) {
    const item = { ...drawing, props: { ...drawing.props, bindings: { flowing: { ...drawing.props.bindings.flowing, expression } } } };
    assert.deepEqual(evaluateComponentBindings(item, context).errors, {});
    assert.equal(evaluateComponentBindings(item, context).simulated, undefined);
  }
  const failed = { ...drawing, props: { ...drawing.props, bindings: { flowing: { expression: 'running && missing', references: { running: drawing.props.bindings.flowing.references.running, missing: { kind: 'parameter', key: 'missing' } } } } } };
  const failure = evaluateComponentBindings(failed, context);
  assert.ok(failure.errors.flowing); assert.equal(failure.simulated, undefined);
  const partlyValid = { ...drawing, props: { ...drawing.props, bindings: { ...drawing.props.bindings, text: { expression: 'missing', references: {} } } } };
  const partial = evaluateComponentBindings(partlyValid, { ...context, parameters: { permit: true } });
  assert.ok(partial.errors.text); assert.equal(partial.simulated, true);
  assert.deepEqual({ drawing, context }, before);
});

test('template and repeated-row fx use local inputs and scoped tag path parameters for simulated status', () => {
  const permit = component('permit', 'checkbox', { fieldKey: 'permit', defaultValue: false });
  const pipe = component('pipe', 'pipe', { bindings: { flowing: { expression: 'permit && running', references: { permit: { kind: 'input', key: 'permit' }, running: { kind: 'tag', path: '[default]{machine}/Running' } } } } });
  const template = { id: 'drawing-template', name: 'Drawing', width: 300, height: 200, parameters: { machine: 'Live' }, components: [permit, pipe] };
  const instance = component('drawing-instance', 'template', { templateId: template.id, parameters: { machine: 'Demo' } });
  const repeat = component('drawing-rows', 'repeater', { templateId: template.id, rows: [{ id: 'live', parameters: { machine: 'Live' } }, { id: 'demo', parameters: { machine: 'Demo' } }] });
  const fixture = { screen: { ...screen, components: [permit, instance, repeat] }, templates: [template], parameters: { machine: 'Missing' }, tags: [tag('[default]Live/Running', { value: true }), tag('[default]Demo/Running', { value: true, source: 'simulated' })], edits: { main: { permit: true } } };
  assert.deepEqual(health(fixture), { badCount: 0, simulated: false });
  assert.deepEqual(health({ ...fixture, edits: { [instanceInputKey('main', instance.id)]: { permit: true } } }), { badCount: 0, simulated: true });
  assert.deepEqual(health({ ...fixture, edits: { [instanceInputKey('main', repeat.id, 'live')]: { permit: true } } }), { badCount: 0, simulated: false });
  assert.deepEqual(health({ ...fixture, edits: { [instanceInputKey('main', repeat.id, 'demo')]: { permit: true } } }), { badCount: 0, simulated: true });
});

test('template wrapper fx metadata contributes before child inspection', () => {
  const template = { id: 'empty-drawing', name: 'Empty', width: 100, height: 100, parameters: {}, components: [] };
  const wrapper = component('wrapper', 'template', { templateId: template.id, bindings: { enabled: { expression: 'ready', references: { ready: { kind: 'tag', path: '[default]Ready' } } } } });
  const fixture = { screen: { ...screen, components: [wrapper] }, templates: [template], tags: [tag('[default]Ready', { value: true, source: 'simulated' })] };
  assert.deepEqual(health(fixture), { badCount: 0, simulated: true });
  assert.deepEqual(health({ ...fixture, tags: [{ ...fixture.tags[0], quality: 'Bad' }] }), { badCount: 1, simulated: false });
});
console.log(`${passed} runtime quality checks passed.`);
