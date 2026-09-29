#!/usr/bin/env node
// Offline authored-style resolution and resource admission; no gateway or external systems.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const url = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const source = name => readFile(new URL(`../apps/web/src/${name}.ts`, import.meta.url), 'utf8');
const { validateVisualStyles, validateProjectStyles, applyVisualStyle, applyStyleCatalog, styleReferences, visualStyleSource } = await import(url(await source('visualStyles')));
const drawing = url(await source('drawingComponents'));
const { evaluateComponentBindings } = await import(url((await source('propertyBindings')).replace('from "./drawingComponents"', `from "${drawing}"`)));
const style = () => ({ id: 'station', name: 'Station', properties: { backgroundColor: '#14263b', foregroundColor: '#f4f7fa', borderColor: '#506c90', borderWidth: 2, fontSize: 18, color: '#587ccc' } });
const component = props => ({ id: 'note', type: 'textInput', x: 10, y: 20, width: 200, height: 80, props: { text: 'Note', fieldKey: 'note', defaultValue: 'unchanged', styleId: 'station', ...props } });
const project = () => ({ id: 'style-test', name: 'Visual styles', revision: 4, parameters: {}, styles: [style()], screens: [{ id: 'home', name: 'Home', width: 800, height: 600, components: [component({})] }], templates: [{ id: 'card', name: 'Card', parameters: {}, width: 300, height: 180, components: [component({})] }] });
const context = { components: [], tags: [], parameters: {}, inputs: {} };
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('catalog accepts legacy absence, bounded resources and supported hexadecimal forms', () => {
  validateVisualStyles(undefined); validateVisualStyles([]); validateProjectStyles(project());
  for (const color of ['#abc', '#abcd', '#AbCdEf', '#abcdef80']) validateVisualStyles([{ ...style(), properties: { color } }]);
  validateVisualStyles(Array.from({ length: 100 }, (_, index) => ({ ...style(), id: `style_${index}` })));
});
check('malformed resources and unsupported semantics cannot enter a catalog', () => {
  for (const invalid of [null, {}, 'styles', [null], [1], [{ ...style(), id: 'bad id' }], [{ ...style(), id: 'ok\n' }], [style(), style()], [{ ...style(), name: ' ' }], [{ ...style(), name: ' leading' }], [{ ...style(), name: 'bad\u0085name' }], [{ ...style(), name: 'x'.repeat(81) }], [{ ...style(), properties: {} }], [{ ...style(), properties: null }], [{ ...style(), enabled: true }], Array.from({ length: 101 }, (_, i) => ({ ...style(), id: `s${i}` }))]) assert.throws(() => validateVisualStyles(invalid));
  for (const key of ['enabled', 'visible', 'script', 'text', 'x', 'styleId', 'animation', 'permissions', 'bindings']) assert.throws(() => validateVisualStyles([{ ...style(), properties: { [key]: true } }]));
});
check('style values enforce types, ranges and exact color text', () => {
  for (const value of ['red', 'var(--accent)', '#fff\n', ' #fff', '#ff', null, true, 5]) assert.throws(() => validateVisualStyles([{ ...style(), properties: { color: value } }]));
  for (const value of [-1, 33, Infinity, NaN, '2', null]) assert.throws(() => validateVisualStyles([{ ...style(), properties: { borderWidth: value } }]));
  for (const value of [0, 257, Infinity, '18', null]) assert.throws(() => validateVisualStyles([{ ...style(), properties: { fontSize: value } }]));
  validateVisualStyles([{ ...style(), properties: { fontSize: 1, borderWidth: 0 } }]);
});
check('style values override parent defaults without changing the authored input', () => {
  const control = component({}); const before = JSON.stringify(control);
  const result = applyVisualStyle(control, [style()], { backgroundColor: '#fff', foregroundColor: '#000', fontSize: 50 });
  assert.equal(result.error, undefined); assert.equal(result.component.props.backgroundColor, '#14263b'); assert.equal(result.component.props.fontSize, 18);
  assert.equal(JSON.stringify(control), before); assert.equal(result.component.props.defaultValue, 'unchanged'); assert.equal(result.component.props.fieldKey, 'note');
  assert.equal(result.component.x, 10); assert.equal(result.component.width, 200);
});
check('defined local overrides retain false-like zero and undefined returns to style', () => {
  const result = applyVisualStyle(component({ fontSize: 22, borderWidth: 0, backgroundColor: undefined }), [style()]);
  assert.equal(result.component.props.fontSize, 22); assert.equal(result.component.props.borderWidth, 0); assert.equal(result.component.props.backgroundColor, '#14263b');
});
check('unstyled legacy controls retain parent fallback and explicit child accent suppresses inherited text', () => {
  const parent = { color: '#cde', foregroundColor: '#111', backgroundColor: '#fff', fontSize: 20 };
  const plain = applyVisualStyle(component({ styleId: undefined }), [], parent).component;
  assert.equal(plain.props.foregroundColor, '#111'); assert.equal(plain.props.color, '#cde');
  const accented = applyVisualStyle(component({ styleId: undefined, color: '#abc' }), [], parent).component;
  assert.equal(accented.props.foregroundColor, undefined); assert.equal(accented.props.backgroundColor, '#fff');
});
check('assigned accent suppresses inherited text but preserves its own foreground', () => {
  assert.equal(applyVisualStyle(component({}), [{ ...style(), properties: { color: '#123' } }], { foregroundColor: '#fff' }).component.props.foregroundColor, undefined);
  assert.equal(applyVisualStyle(component({}), [style()], { foregroundColor: '#000' }).component.props.foregroundColor, '#f4f7fa');
});
check('expression binding wins and does not rewrite style or local fallback', () => {
  const control = component({ fontSize: 24, bindings: { fontSize: { expression: '30', references: {} }, backgroundColor: { expression: '"#abcdef"', references: {} } } });
  const styled = applyVisualStyle(control, [style()]);
  const result = evaluateComponentBindings(styled.component, context);
  assert.equal(result.component.props.fontSize, 30); assert.equal(result.component.props.backgroundColor, '#abcdef'); assert.deepEqual(result.errors, {});
  assert.equal(control.props.fontSize, 24); assert.equal(style().properties.fontSize, 18);
});
check('query binding wins while unavailable color exposes existing error semantics', () => {
  const control = component({ queryBindings: { foregroundColor: { queryId: 'read', column: 'color' } } });
  const styled = applyVisualStyle(control, [style()]).component;
  assert.equal(evaluateComponentBindings(styled, { ...context, queryProperties: { note: { foregroundColor: { status: 'ready', value: '#123456' } } } }).component.props.foregroundColor, '#123456');
  const unavailable = evaluateComponentBindings(styled, { ...context, queryProperties: { note: { foregroundColor: { status: 'error', error: 'Access denied' } } } });
  assert.equal(unavailable.component.props.foregroundColor, undefined); assert.equal(unavailable.errors.foregroundColor, 'Access denied');
});
check('appearance resolution cannot grant visibility, enabled state or edit authority', () => {
  const control = component({ enabled: false, visible: false, bindings: { enabled: { expression: 'missing', references: { missing: { kind: 'input', key: 'unknown' } } } } });
  const result = evaluateComponentBindings(applyVisualStyle(control, [style()]).component, context);
  assert.equal(result.component.props.enabled, false); assert.equal(result.component.props.visible, false); assert.ok(result.errors.enabled);
});
check('nested style inheritance resolves wrapper then child style then local override', () => {
  const wrapper = applyVisualStyle(component({ type: undefined }), [style()]).component.props;
  const childStyle = { id: 'child', name: 'Child', properties: { fontSize: 24, backgroundColor: '#fff' } };
  const child = applyVisualStyle(component({ styleId: 'child', fontSize: 28 }), [style(), childStyle], wrapper).component;
  assert.equal(child.props.fontSize, 28); assert.equal(child.props.backgroundColor, '#fff'); assert.equal(child.props.foregroundColor, '#f4f7fa');
});
check('missing or invalid style reports failure and does not apply unsafe data', () => {
  const missing = applyVisualStyle(component({}), []); assert.match(missing.error, /missing/); assert.equal(missing.component.props.defaultValue, 'unchanged');
  const invalid = applyVisualStyle(component({}), [{ ...style(), properties: { enabled: true, color: 'red' } }]); assert.match(invalid.error, /invalid/); assert.equal(invalid.component.props.color, undefined); assert.equal(invalid.component.props.enabled, undefined);
});
check('resource references include every screen/template and prevent referenced deletion', () => {
  const original = project(); assert.equal(styleReferences(original, 'station').length, 2);
  assert.throws(() => validateProjectStyles({ ...original, styles: [] }), /missing/);
  original.templates[0].components[0].props.styleId = 'bad'; assert.throws(() => validateProjectStyles(original), /missing/);
});
check('catalog application is immutable, preserves identity/form data and rejects stale snapshot', () => {
  const original = project(), snapshot = JSON.stringify(original), styles = [{ ...style(), name: 'Renamed', properties: { color: '#111' } }];
  const next = applyStyleCatalog(original, snapshot, styles);
  assert.equal(JSON.stringify(original), snapshot); assert.equal(next.revision, original.revision); assert.equal(next.screens, original.screens); assert.equal(next.templates, original.templates);
  styles[0].name = 'Mutated'; assert.equal(next.styles[0].name, 'Renamed');
  assert.throws(() => applyStyleCatalog({ ...original, revision: 5 }, snapshot, styles), /changed/);
  assert.throws(() => applyStyleCatalog(original, snapshot, []), /missing/);
});
check('source inspection describes binding, local, style and inherited precedence', () => {
  assert.equal(visualStyleSource(component({ bindings: { color: {} } }), style(), 'color'), 'Binding');
  assert.equal(visualStyleSource(component({ fontSize: 21 }), style(), 'fontSize'), 'Local override');
  assert.equal(visualStyleSource(component({}), style(), 'fontSize'), 'Station');
  assert.equal(visualStyleSource(component({}), undefined, 'fontSize'), 'Parent / theme');
});
console.log(`${passed} visual-style model groups passed.`);
