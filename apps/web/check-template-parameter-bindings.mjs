import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const modules = new Map(), asModule = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/(from\s+)(["'])\.\/([^"']+)\2/g, (_all, prefix, _quote, child) => prefix + JSON.stringify(load(child)));
  const url = asModule(code); modules.set(name, url); return url;
}
const { resolveParameterBindings, parameterBindingInputs, validateTemplateParameterBinding } = await import(load('templateParameterBindings'));
const { templateParameters, queryTemplateParameters, instanceRequestScope, projectInputContext, componentContexts } = await import(load('templateModel'));
const input = (id, type, props) => ({ id, type, x: 0, y: 0, width: 100, height: 40, props: { fieldKey: id, ...props } });
const machine = input('machine', 'select', { options: [{ value: 'A', label: 'Assembly' }, { value: 'B', label: 'Packaging' }], defaultValue: 'A' });
const quantity = input('quantity', 'spinner', { defaultValue: 2, min: 1, max: 20 });
const note = input('note', 'textInput', { defaultValue: '' });
const password = input('secret', 'passwordInput', { defaultValue: '' });
const binding = (expression, references = {}) => ({ expression, references });
const host = { id: 'card', type: 'template', x: 0, y: 0, width: 300, height: 200, props: {
  templateId: 'machine-card', parameters: { title: 'Static override' }, customProperties: { multiplier: { type: 'number', value: 3 } },
  parameterBindings: {
    machine: binding('selected', { selected: { kind: 'input', key: 'machine' } }),
    count: binding('amount * factor', { amount: { kind: 'input', key: 'quantity' }, factor: { kind: 'custom', key: 'multiplier' } }),
    title: binding('area + " / " + selected', { area: { kind: 'parameter', key: 'area' }, selected: { kind: 'input', key: 'machine' } }),
    permitted: binding('amount > 1', { amount: { kind: 'input', key: 'quantity' } }),
  },
} };
const template = { id: 'machine-card', name: 'Machine', width: 300, height: 200, parameters: { machine: 'old', count: '1', title: 'Default', permitted: 'false' }, parameterTypes: { count: 'number', permitted: 'boolean' }, components: [] };
const context = { components: [machine, quantity, note, password, host], parameters: { area: 'North' }, inputs: { machine: 'A', quantity: 2, note: '', secret: 'never sent' }, tags: [] };
const resolve = (component = host, parent = context) => resolveParameterBindings(component, template, parent);
let passed = 0;
function check(name, action) { action(); passed++; console.log(`PASS ${name}`); }
check('parent form inputs, parent parameters and custom properties yield typed child parameters', () => {
  assert.deepEqual(resolve(), { machine: 'A', count: 6, title: 'North / A', permitted: true });
  assert.deepEqual(resolve(host, { ...context, inputs: { ...context.inputs, machine: 'B', quantity: 1 } }), { machine: 'B', count: 3, title: 'North / B', permitted: false });
});
check('computed values override authored literals; saved rows and query values remain final', () => {
  const bound = resolve();
  assert.equal(templateParameters(template, context.parameters, host.props.parameters, {}, bound).title, 'North / A');
  assert.equal(templateParameters(template, context.parameters, host.props.parameters, { count: '12', title: '{area} row' }, bound).count, 12);
  assert.equal(templateParameters(template, context.parameters, {}, { title: '{area} row' }, bound).title, 'North row');
  assert.equal(queryTemplateParameters(template, context.parameters, {}, { title: '{area} query' }, bound).title, '{area} query');
});
check('bound brace values are literal, never another parameter substitution pass', () => {
  const changed = structuredClone(host); changed.props.parameterBindings.title = binding('"{area}"');
  assert.equal(templateParameters(template, context.parameters, {}, {}, resolve(changed)).title, '{area}');
});
check('bindings read parent values even when the child declares the same parameter', () => {
  const changed = structuredClone(host); changed.props.parameterBindings.count = binding('count + 1', { count: { kind: 'parameter', key: 'count' } });
  assert.equal(resolve(changed, { ...context, parameters: { ...context.parameters, count: 8 } }).count, 9);
});
check('only referenced parent inputs enter the request snapshot, excluding unrelated fields and passwords', () => {
  assert.deepEqual(parameterBindingInputs(host, context.inputs), { machine: 'A', quantity: 2 });
  assert.throws(() => parameterBindingInputs(host, { machine: 'A' }), /quantity.*unavailable/);
});
check('invalid parent input drafts block derived values even in an unused expression branch', () => {
  const changed = structuredClone(host); changed.props.parameterBindings.count = binding('false ? amount : 1', { amount: { kind: 'input', key: 'quantity' } });
  for (const amount of [null, '', 0, 21, 'wrong']) assert.throws(() => resolve(changed, { ...context, inputs: { ...context.inputs, quantity: amount } }));
  assert.throws(() => resolve(host, { ...context, inputs: { ...context.inputs, machine: 'not-a-choice' } }));
});
check('unrelated invalid inputs do not prevent a valid child binding', () => {
  assert.equal(resolve(host, { ...context, inputs: { ...context.inputs, note: null } }).count, 6);
});
check('unsupported source scopes and password inputs are rejected before use', () => {
  for (const reference of [{ kind: 'input', key: 'secret' }, { kind: 'tag', path: '[default]Test' }, { kind: 'sessionState', key: 'choice' }, { kind: 'screenState', key: 'choice' }]) {
    const changed = structuredClone(host); changed.props.parameterBindings.title = binding('value', { value: reference });
    assert.throws(() => resolve(changed));
  }
});
check('unknown parent or peer-child parameter, custom owner and source inputs are rejected', () => {
  for (const reference of [{ kind: 'parameter', key: 'count' }, { kind: 'input', key: 'unknown' }, { kind: 'custom', key: 'unknown' }, { kind: 'custom', key: 'multiplier', componentId: 'other-form' }]) {
    const changed = structuredClone(host); changed.props.parameterBindings.title = binding('value', { value: reference }); assert.throws(() => resolve(changed));
  }
});
check('same-form sibling custom properties are supported', () => {
  const changed = structuredClone(host); changed.props.parameterBindings.count = binding('value', { value: { kind: 'custom', key: 'factor', componentId: 'sibling' } });
  assert.equal(resolve(changed, { ...context, components: [...context.components, { ...host, id: 'sibling', props: { customProperties: { factor: { type: 'number', value: 9 } } } }] }).count, 9);
});
check('malformed maps, undeclared targets and expressions cannot produce actionable parameters', () => {
  for (const bindings of [null, [], { missing: binding('1') }, { count: binding('window.location') }, { count: binding('1 / 0') }, { permitted: binding('"yes"') }, { count: { expression: '1', references: {}, source: 'extra' } }]) {
    assert.throws(() => resolve({ ...host, props: { ...host.props, parameterBindings: bindings } }));
  }
  assert.throws(() => resolve({ ...host, type: 'label' }));
});
check('constant type failures are rejected by authoring validation', () => {
  assert.match(validateTemplateParameterBinding(binding('"no"'), host, context.components, context.parameters, 'count', 'number'), /number/);
  assert.equal(validateTemplateParameterBinding(binding('3'), host, context.components, context.parameters, 'count', 'number'), undefined);
  assert.match(validateTemplateParameterBinding(binding('true', { unused: { kind: 'input', key: 'quantity' } }), host, context.components, context.parameters, 'count', 'number'), /number/);
});
check('dynamic arithmetic failure never falls back to the saved parameter', () => {
  const changed = structuredClone(host); changed.props.parameterBindings.count = binding('1 / (amount - 2)', { amount: { kind: 'input', key: 'quantity' } }); assert.throws(() => resolve(changed), /finite/);
});
check('request scopes include the bounded snapshots but never serialize lifecycle guards', () => {
  const snapshots = [parameterBindingInputs(host, context.inputs), {}];
  const action = { instanceId: 'card', instancePath: [{ instanceId: 'card' }, { instanceId: 'child' }], bindingInputs: snapshots, isCurrent: () => true, parameters: { injected: 1 } };
  assert.deepEqual(instanceRequestScope(action), { instancePath: action.instancePath, bindingInputs: snapshots });
  assert.deepEqual(instanceRequestScope({ instanceId: 'old' }), { instanceId: 'old' });
});
check('binding edits invalidate authored preview context, while static enumeration omits dynamic fallbacks', () => {
  const project = { id: 'app', name: 'App', revision: 1, parameters: {}, templates: [template], screens: [{ id: 's', components: [host] }] };
  const changed = structuredClone(project); changed.screens[0].components[0].props.parameterBindings.count.expression = 'amount + factor';
  assert.notEqual(projectInputContext(project), projectInputContext(changed));
  assert.deepEqual(componentContexts([host], [template], context.parameters), []);
});
check('imported prototype-like target names remain own literal keys', () => {
  const imported = { ...template, parameters: JSON.parse('{"__proto__":"old","constructor":"old"}'), parameterTypes: {} };
  const component = { ...host, props: { ...host.props, parameterBindings: Object.fromEntries([['__proto__', binding('"new"')], ['constructor', binding('"ctor"')]]) } };
  const result = resolveParameterBindings(component, imported, context);
  assert.equal(Object.getPrototypeOf(result), Object.prototype); assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'new'); assert.equal(result.constructor, 'ctor');
});
console.log(`${passed} template parameter binding checks passed.`);
