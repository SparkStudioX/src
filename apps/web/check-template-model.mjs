import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = name => fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const authSessionUrl = asModule(compile(source('authSession')));
const apiUrl = asModule(compile(source('api')).replaceAll('"./authSession"', JSON.stringify(authSessionUrl)));
const listTreeUrl = asModule(compile(source('listTreeModel')));
const drawingUrl = asModule(compile(source('drawingComponents')));
const load = name => import(asModule(compile(source(name)).replaceAll('"./api"', JSON.stringify(apiUrl)).replaceAll('"./listTreeModel"', JSON.stringify(listTreeUrl)).replaceAll('"./drawingComponents"', JSON.stringify(drawingUrl))));
const { resolvePath } = await import(apiUrl);
const { templateParameters, queryTemplateParameters, resolveTemplateParameters, coerceTemplateParameter, instanceInputKey, actionKey, componentContexts, projectInputContext } = await load('templateModel');
const { resolveInputs, validateInputs } = await load('inputs');
const { evaluateComponentBindings } = await load('propertyBindings');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const field = { id: 'target', type: 'numberInput', x: 10, y: 20, width: 200, height: 80, props: { fieldKey: 'target', text: '{title}', tagPath: '[default]Workcenters/{machine}/Target', min: 0, max: 100 } };
const template = { id: 'form', name: 'Form', width: 600, height: 400, parameters: { machine: '{line}', title: 'Machine {line}' }, components: [field] };
const root = { line: 'WC1', extra: 'root only' };
const instance = { id: 'instance1', type: 'template', x: 0, y: 0, width: 600, height: 400, props: { templateId: 'form', parameters: { machine: 'WC2' } } };
const repeater = { ...instance, id: 'rows', type: 'repeater', props: { templateId: 'form', parameters: { title: 'Instance' }, rows: [{ id: 'a', parameters: { machine: 'WC1' } }, { id: 'b', parameters: { machine: 'WC2', title: 'Second' } }] } };
const project = { id: 'project', name: 'Project', revision: 1, parameters: root, templates: [template], screens: [{ id: 'screen', name: 'Screen', width: 1200, height: 760, components: [instance, repeater] }] };
const tags = [1,2].map(n => ({ path: `[default]Workcenters/WC${n}/Target`, value: n * 10, dataType: 'Int32', quality: 'Good', timestamp: '' }));
check('template precedence and root shadowing', () => assert.deepEqual(templateParameters(template, root, { machine: 'WC2' }, { machine: 'WC3' }), { line: 'WC1', extra: 'root only', machine: 'WC3', title: 'Machine WC1' }));
check('one-pass substitution never expands replacements', () => assert.equal(templateParameters(template, { line: '{extra}', extra: 'WC2' }).machine, '{extra}'));
check('substitution uses own keys and backend brace semantics', () => { assert.equal(resolvePath('{constructor} {toString}', {}), '{constructor} {toString}'); assert.equal(resolvePath('{{line}}', root), '{WC1}'); });
check('instance and row scope keys cannot collide', () => assert.equal(new Set([instanceInputKey('s','i'), instanceInputKey('s','i','a'), instanceInputKey('s','i','b'), instanceInputKey('s','j','a'), instanceInputKey('s2','i','a')]).size, 5));
check('action busy state is isolated by instance and row', () => assert.notEqual(actionKey('save', { instanceId: 'rows', rowId: 'a' }), actionKey('save', { instanceId: 'rows', rowId: 'b' })));
check('nested bindings expand every saved row with own context', () => { const expanded = componentContexts([instance, repeater], [template], root); assert.deepEqual(expanded.map(item => item.parameters.machine), ['WC2', 'WC1', 'WC2']); assert.equal(expanded[2].parameters.title, 'Second'); });
check('input values stay isolated across instances', () => { const edits = { [instanceInputKey('s','i1')]: { target: 71 } }; assert.equal(resolveInputs(template, tags, { machine: 'WC1' }, edits[instanceInputKey('s','i1')]).target, 71); assert.equal(resolveInputs(template, tags, { machine: 'WC2' }, edits[instanceInputKey('s','i2')]).target, 20); });
check('unavailable initial values do not turn into zero', () => { const values = resolveInputs(template, [], { machine: 'WC3' }); assert.equal(values.target, null); assert.match(validateInputs(template, values, { title: 'Machine 3' }), /Machine 3: the initial value is unavailable/); });
check('template override edits invalidate preview form state', () => { const changed = structuredClone(project); changed.screens[0].components[0].props.parameters.machine = 'WC3'; assert.notEqual(projectInputContext(project), projectInputContext(changed)); });
check('row parameter edits invalidate preview form state', () => { const changed = structuredClone(project); changed.screens[0].components[1].props.rows[0].parameters.machine = 'WC3'; assert.notEqual(projectInputContext(project), projectInputContext(changed)); });
check('template default edits invalidate preview form state', () => { const changed = structuredClone(project); changed.templates[0].parameters.machine = 'WC4'; assert.notEqual(projectInputContext(project), projectInputContext(changed)); });
check('moving/resizing an instance preserves typed form state', () => { const changed = structuredClone(project); changed.screens[0].components[0].x += 24; changed.screens[0].components[0].width += 40; assert.equal(projectInputContext(project), projectInputContext(changed)); });
const typed = { ...template, parameters: { count: '{count}', permitted: 'false', caption: 'Ready {count}' }, parameterTypes: { count: 'number', permitted: 'boolean' } };
check('declared types preserve native numbers and Booleans through precedence and parent inheritance', () => {
  assert.deepEqual(templateParameters(typed, { count: '2', inherited: 'parent' }, { count: '3', permitted: 'true' }, { count: '4' }),
    { count: 4, inherited: 'parent', permitted: true, caption: 'Ready 2' });
  assert.equal(templateParameters(typed, { count: 5, inherited: true }).count, 5);
  assert.equal(resolvePath('{count}/{permitted}', { count: 12, permitted: false }), '12/false');
  assert.deepEqual(typed.parameters, { count: '{count}', permitted: 'false', caption: 'Ready {count}' });
});
check('strict numeric grammar rejects unsafe, malformed and nonfinite values', () => {
  for (const value of ['', ' ', ' 2', '2 ', '2\n', '2\r\n', '+2', '.5', '1.', '01', '-01', '0x10', 'NaN', 'Infinity', '1e999', '9007199254740992', true, null, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => coerceTemplateParameter('count', value, 'number'), /count.*number/);
  for (const [value, expected] of [['0', 0], ['-2.5', -2.5], ['1e2', 100], ['-1.25E-2', -0.0125], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]])
    assert.equal(coerceTemplateParameter('count', value, 'number'), expected);
});
check('Boolean parameters accept only canonical text or native Booleans', () => {
  for (const value of ['True', 'FALSE', ' true', 'false ', '1', '0', 1, 0, '', null, {}, []]) assert.throws(() => coerceTemplateParameter('permit', value, 'boolean'));
  for (const value of ['true', true]) assert.equal(coerceTemplateParameter('permit', value, 'boolean'), true);
  for (const value of ['false', false]) assert.equal(coerceTemplateParameter('permit', value, 'boolean'), false);
});
check('legacy string parameters use canonical primitives and keep query braces literal', () => {
  assert.equal(coerceTemplateParameter('caption', false), 'false'); assert.equal(coerceTemplateParameter('caption', -0), '0');
  assert.equal(coerceTemplateParameter('caption', '{root}'), '{root}');
  for (const value of [null, [], {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => coerceTemplateParameter('caption', value));
  assert.equal(coerceTemplateParameter('caption', 'x'.repeat(5000)).length, 5000);
  assert.equal(queryTemplateParameters(typed, { count: '{unresolved}' }, {}, { count: 7, permitted: true, caption: '{count}' }).caption, '{count}');
});
check('query values overlay invalid dynamic defaults before final coercion', () => {
  assert.equal(queryTemplateParameters(typed, { count: 'bad' }, { count: '{missing}' }, { count: 8 }).count, 8);
  assert.throws(() => queryTemplateParameters(typed, { count: 'bad' }, {}, {}), /count/);
  assert.throws(() => templateParameters(typed, { count: '{other}', other: '8' }), /count/);
});
check('invalid typed contexts return explicit diagnostics and omit actionable component contexts', () => {
  const failed = resolveTemplateParameters(typed, { count: 'bad' });
  assert.match(failed.error, /count/); assert.equal(failed.parameters, undefined);
  const host = { ...instance, props: { templateId: typed.id } };
  assert.deepEqual(componentContexts([host], [typed], { count: 'bad' }), []);
  for (const types of [null, [], { missing: 'number' }, { count: 'decimal' }, Object.fromEntries(Array.from({length: 65}, (_, i) => [`p${i}`, 'string']))])
    assert.throws(() => templateParameters({ ...typed, parameterTypes: types }, { count: '1' }));
});
check('parameter types invalidate form context even when effective strings remain equal', () => {
  const changed = structuredClone(project); changed.templates[0].parameterTypes = { machine: 'string' };
  assert.notEqual(projectInputContext(project), projectInputContext(changed));
});
check('typed template values drive arithmetic and Boolean bindings without string conversion', () => {
  const parameters = templateParameters(typed, { count: '4' }, { permitted: 'true' });
  const component = { ...field, props: { bindings: {
    text: { expression: 'count + 3', references: { count: { kind: 'parameter', key: 'count' } } },
    enabled: { expression: 'permit && count > 2', references: { permit: { kind: 'parameter', key: 'permitted' }, count: { kind: 'parameter', key: 'count' } } },
  } } };
  const resolved = evaluateComponentBindings(component, { parameters, components: [component], tags: [], inputs: {} });
  assert.deepEqual(resolved.errors, {}); assert.equal(resolved.component.props.text, '7'); assert.equal(resolved.component.props.enabled, true);
});
console.log(`${checks}/${checks} template model checks passed.`);
