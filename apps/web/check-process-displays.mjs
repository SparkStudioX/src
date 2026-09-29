import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), modules = new Map();
function url(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; modules.set(name, result); return result;
}
const { processDisplayTypes, isProcessDisplay, resolveProcessDisplay } = await import(url('processDisplays'));
const { evaluateComponentBindings } = await import(url('propertyBindings'));
const { templateParameters } = await import(url('templateModel'));
const { runtimeBindingHealth } = await import(url('runtimeQuality'));
const { isInput } = await import(url('inputs'));
const { default: BoundComponent } = await import(url('BoundComponent'));
const { ProjectComponentView } = await import(url('templates'));
const component = (type = 'progressBar', props = {}) => ({ id: 'display', type, x: 0, y: 0, width: 220, height: 260, props: { text: 'Process value', ...props } });
const rangeTypes = processDisplayTypes.filter(type => type !== 'ledDisplay');
const model = (props = {}, type = 'progressBar', parameters = {}) => resolveProcessDisplay(component(type, props), parameters);
const binding = (key, kind = 'parameter') => ({ expression: key, references: { [key]: { kind, key } } });
const evaluate = (item, extra = {}) => evaluateComponentBindings(item, { components: [item], tags: [], parameters: {}, inputs: {}, ...extra });
const view = (item, extra = {}) => React.createElement(BoundComponent, { component: item, components: [item], tags: [], parameters: {}, inputs: {}, preview: true, onNavigate() {}, ...extra });
const html = (item, extra = {}) => renderToStaticMarkup(view(item, extra));
const form = components => ({ id: 'main', name: 'Main', width: 1000, height: 700, components });
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('five display types remain passive and absent static values use documented defaults', () => {
  assert.equal(processDisplayTypes.length, 5);
  for (const type of processDisplayTypes) {
    assert.equal(isProcessDisplay(type), true); assert.equal(isInput(type), false);
    const value = model({}, type); assert.equal(value.available, true); assert.equal(value.value, 0); assert.equal(value.formatted, '0.0'); assert.equal(value.unit, '');
    assert.equal(value.showValue, true); assert.equal(value.showPercent, false);
    if (type !== 'ledDisplay') { assert.equal(value.min, 0); assert.equal(value.max, 100); assert.equal(value.ratio, 0); }
    assert.equal(value.orientation, type === 'ledDisplay' || type === 'progressBar' ? 'horizontal' : 'vertical');
  }
  assert.equal(isProcessDisplay('gauge'), false); assert.equal(resolveProcessDisplay(component('label')).available, false);
});
test('numbers keep exact values while decimals affect presentation only', () => {
  for (const [value, decimals, formatted] of [[0, 0, '0'], [-0, 2, '0.00'], [-12.375, 2, '-12.38'], [0.125, 3, '0.125'], [12, 6, '12.000000'], [Number.MAX_SAFE_INTEGER, 0, '9007199254740991']]) {
    const resolved = model({ value, decimals }, 'ledDisplay'); assert.equal(resolved.available, true); assert.equal(resolved.value, value); assert.equal(resolved.formatted, formatted);
  }
});
test('invalid numeric values and decimal definitions are unavailable without invented zero', () => {
  for (const value of [null, '', '12', true, false, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
    const resolved = model({ value }); assert.equal(resolved.available, false); assert.match(resolved.diagnostic, /Value/); assert.equal(resolved.value, undefined);
  }
  for (const decimals of [-1, 7, 0.5, '2', null, true, NaN, Infinity]) {
    const resolved = model({ decimals }); assert.equal(resolved.available, false); assert.match(resolved.diagnostic, /Decimal/);
  }
});
test('all bounded displays validate ordered exact finite ranges and accept negative scales', () => {
  for (const type of rangeTypes) {
    for (const props of [{ min: 10, max: 10 }, { min: 11, max: 10 }, { min: null }, { max: '100' }, { min: Infinity }, { max: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(model(props, type).available, false);
    const value = model({ min: -50, max: 50, value: -25 }, type); assert.equal(value.available, true); assert.equal(value.ratio, 0.25); assert.equal(value.rangeStatus, undefined);
    assert.equal(model({ min: 0, max: Number.MIN_VALUE, value: Number.MIN_VALUE }, type).ratio, 1);
  }
});
test('out-of-range values retain actual numbers while fill and percentage clamp to zero or one hundred', () => {
  for (const type of rangeTypes) {
    for (const [value, status, ratio, percent] of [[-25, 'below', 0, '0.0%'], [125, 'above', 1, '100.0%']]) {
      const resolved = model({ value, showValue: false, showPercent: true }, type);
      assert.equal(resolved.available, true); assert.equal(resolved.value, value); assert.equal(resolved.formatted, value.toFixed(1));
      assert.equal(resolved.rangeStatus, status); assert.equal(resolved.ratio, ratio); assert.equal(resolved.percent, percent);
    }
    const extreme = model({ min: 0, max: Number.MIN_VALUE, value: 1, showPercent: true }, type);
    assert.equal(extreme.available, true); assert.equal(extreme.ratio, 1); assert.equal(extreme.percent, '100.0%');
  }
});
test('unit text resolves once for static definitions and stays literal when bound', () => {
  assert.equal(model({ unit: '{unit}' }, 'ledDisplay', { unit: '{nested}', nested: 'kPa' }).unit, '{nested}');
  assert.equal(model({ unit: '{unit}', bindings: { unit: binding('unit') } }, 'ledDisplay', { unit: 'kPa' }).unit, '{unit}');
  assert.equal(model({ unit: 'x'.repeat(32) }).available, true);
  for (const unit of [false, 2, null, 'x'.repeat(33)]) assert.equal(model({ unit }).available, false);
  assert.equal(model({ unit: '{unit}' }, 'progressBar', { unit: 'x'.repeat(33) }).available, false);
});
test('Boolean visibility flags and orientations enforce their exact types', () => {
  for (const key of ['showValue', 'showPercent']) for (const value of ['true', 0, null]) assert.equal(model({ [key]: value }).available, false);
  for (const type of ['progressBar', 'levelIndicator']) {
    for (const orientation of ['horizontal', 'vertical']) assert.equal(model({ orientation }, type).orientation, orientation);
    for (const orientation of ['Horizontal', '', false, null]) assert.equal(model({ orientation }, type).available, false);
  }
});
test('cleared bound properties never reuse defaults including flags, unit and orientation', () => {
  for (const key of ['value', 'min', 'max', 'decimals', 'unit', 'showValue', 'showPercent', 'orientation']) {
    const resolved = model({ [key]: undefined, bindings: { [key]: binding('missing') } });
    assert.equal(resolved.available, false, key); assert.match(resolved.diagnostic, /binding is unavailable/);
    assert.equal(resolved.ratio, undefined); assert.equal(resolved.value, undefined);
  }
});
test('native typed parameter and form input bindings drive values and limits without coercion', () => {
  const template = { id: 'typed', name: 'Typed', width: 200, height: 100, components: [], parameters: { reading: '25', minimum: '-50', maximum: '50' }, parameterTypes: { reading: 'number', minimum: 'number', maximum: 'number' } };
  const parameters = templateParameters(template, {}), item = component('progressBar', { bindings: { value: binding('reading'), min: binding('minimum'), max: binding('maximum'), showPercent: binding('percent', 'input') } });
  const evaluated = evaluate(item, { parameters, inputs: { percent: true } });
  assert.deepEqual(evaluated.errors, {});
  const resolved = resolveProcessDisplay(evaluated.component, parameters); assert.equal(resolved.value, 25); assert.equal(resolved.ratio, .75); assert.equal(resolved.percent, '75.0%');
  const malformed = evaluate(item, { parameters: { ...parameters, reading: '25' }, inputs: { percent: true } });
  assert.ok(malformed.errors.value); assert.equal(resolveProcessDisplay(malformed.component).available, false);
});
test('quality loss, missing tags and offline bindings discard the last good measurement and fill', () => {
  const item = component('cylindricalTank', { value: 72, bindings: { value: { expression: 'level', references: { level: { kind: 'tag', path: '[default]Level' } } } } });
  const tag = { path: '[default]Level', value: 45, quality: 'Good', dataType: 'Double', timestamp: '' };
  assert.equal(resolveProcessDisplay(evaluate(item, { tags: [tag] }).component).value, 45);
  for (const context of [{ tags: [] }, { tags: [{ ...tag, quality: 'Bad_NotConnected' }] }, { tags: [tag], communicationLost: true }, { tags: [{ ...tag, value: NaN }] }]) {
    const evaluated = evaluate(item, context); assert.ok(evaluated.errors.value); const resolved = resolveProcessDisplay(evaluated.component);
    assert.equal(resolved.available, false); assert.equal(resolved.value, undefined); assert.equal(resolved.ratio, undefined);
    const rendered = html(item, context); assert.match(rendered, /Value unavailable/); assert.doesNotMatch(rendered, /data-process-value=|process-fill|clipPath/);
  }
});
test('every renderer exposes readable value semantics and remains passive', () => {
  for (const type of processDisplayTypes) {
    const rendered = html(component(type, { value: 42.5, unit: 'kPa', decimals: 2 }));
    assert.match(rendered, /42\.50 kPa/); assert.match(rendered, /data-process-value="42.5"/);
    assert.match(rendered, new RegExp(`role="${type === 'ledDisplay' ? 'img' : type === 'progressBar' ? 'progressbar' : 'meter'}"`));
    assert.doesNotMatch(rendered, /<(?:input|button|select|textarea)\b/);
  }
});
test('LED is an offline seven-segment numeric SVG with sign, decimal point and readable hidden text', () => {
  const rendered = html(component('ledDisplay', { value: -12.3, decimals: 2, unit: 'A' }));
  assert.equal((rendered.match(/<polygon\b/g) || []).length, 35); assert.equal((rendered.match(/<circle\b/g) || []).length, 1);
  assert.match(rendered, /<svg[^>]*aria-hidden="true"/); assert.match(rendered, /process-accessible-value">-12\.30 A/);
  assert.doesNotMatch(rendered, /<image|https?:|font-face/);
});
test('off-scale renderer always shows actual value and direction while accessible numeric range is clamped', () => {
  for (const type of rangeTypes) for (const value of [-12, 125]) {
    const rendered = html(component(type, { value, decimals: 1, unit: 'L', showValue: false, showPercent: true }));
    assert.ok(rendered.includes(`${value.toFixed(1)} L`)); assert.match(rendered, value < 0 ? /Below range/ : /Above range/);
    assert.match(rendered, new RegExp(`aria-valuenow="${value < 0 ? 0 : 100}"`));
    assert.match(rendered, new RegExp(`data-process-ratio="${value < 0 ? 0 : 1}"`));
  }
  const hidden = html(component('progressBar', { value: 20, showValue: false, showPercent: false }));
  assert.doesNotMatch(hidden, /class="process-readout"/); assert.match(hidden, /aria-valuetext="20\.0"/);
});
test('SVG clipping IDs are independent when repeated components share saved IDs', () => {
  const rendered = renderToStaticMarkup(React.createElement(React.Fragment, null, ...['cylindricalTank', 'cylindricalTank', 'thermometer', 'thermometer'].map(type => view(component(type, { value: 40 })))));
  const ids = [...rendered.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]);
  const references = [...rendered.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map(match => match[1]);
  assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4); assert.deepEqual(new Set(references), new Set(ids));
});
test('common explicit appearance and both orientations reach display markup', () => {
  const rendered = html(component('progressBar', { value: 60, orientation: 'vertical', backgroundColor: '#123456', foregroundColor: '#abcdef', color: '#ff8800', fontSize: 17 }));
  for (const text of ['process-vertical', '--component-background:#123456', '--component-text-color:#abcdef', '--component-accent:#ff8800', '--component-font-size:17px']) assert.ok(rendered.includes(text), text);
  assert.match(html(component('levelIndicator', { orientation: 'horizontal' })), /process-level horizontal/);
  assert.match(html(component('levelIndicator')), /process-level vertical/);
});
test('SVG sizing classes are scoped to graphics and cannot replace the outer display flex layout', () => {
  const css = fs.readFileSync(new URL('./src/processDisplays.css', import.meta.url), 'utf8');
  assert.match(css, /svg\.process-vessel,\s*svg\.process-thermometer-svg\s*\{/);
  for (const type of processDisplayTypes) {
    const rendered = html(component(type, {value: 50}));
    const outerClasses = new Set(rendered.match(/class="(process-display [^"]+)"/)[1].split(/\s+/));
    for (const [, classes] of rendered.matchAll(/<svg class="([^"]+)"/g))
      for (const name of classes.split(/\s+/)) assert.equal(outerClasses.has(name), false, `${type}: graphic class ${name} must not style the outer layout`);
  }
  const thermometer = html(component('thermometer', {value: 50}));
  assert.match(thermometer, /<div class="process-display process-thermometer process-vertical"/);
  assert.match(thermometer, /<svg class="process-thermometer-svg"/);
});
test('same template display evaluates independent numeric row contexts', () => {
  const display = component('progressBar', { bindings: { value: binding('reading') } });
  const template = { id: 'row', name: 'Row', width: 220, height: 260, parameters: { reading: '0' }, parameterTypes: { reading: 'number' }, components: [display] };
  const repeat = component('repeater', { templateId: 'row', rows: [{ id: 'a', parameters: { reading: '25' } }, { id: 'b', parameters: { reading: '75' } }] });
  const rendered = renderToStaticMarkup(React.createElement(ProjectComponentView, { component: repeat, templates: [template], screenId: 'screen', tags: [], parameters: {}, inputs: {}, preview: true, onNavigate() {} }));
  assert.match(rendered, /data-row-id="a"/); assert.match(rendered, /data-row-id="b"/);
  assert.deepEqual([...rendered.matchAll(/data-process-value="([^"]+)"/g)].map(match => match[1]), ['25', '75']);
});
test('runtime health counts unavailable or out-of-range displays once each', () => {
  const item = component('progressBar', { value: 50 });
  const health = (display, parameters = {}) => runtimeBindingHealth(form([display]), [], [], parameters, {});
  assert.equal(health(item).badCount, 0); assert.equal(health(component('progressBar', { value: 101 })).badCount, 1);
  assert.equal(health(component('progressBar', { min: 20, max: 10 })).badCount, 1);
  assert.equal(health(component('ledDisplay', { value: -50 })).badCount, 0);
  const failed = component('thermometer', { bindings: { value: binding('missing'), min: binding('missing'), text: binding('missing') } });
  assert.equal(health(failed).badCount, 1);
  const template = { id: 'row', name: 'Row', width: 220, height: 260, parameters: { reading: '0' }, parameterTypes: { reading: 'number' }, components: [component('progressBar', { bindings: { value: binding('reading') } })] };
  const repeat = component('repeater', { templateId: 'row', rows: [{ id: 'a', parameters: { reading: '25' } }, { id: 'b', parameters: { reading: '125' } }] });
  assert.equal(runtimeBindingHealth(form([repeat]), [template], [], {}, {}).badCount, 1);
});

console.log(`${passed} process-display model and renderer checks passed.`);
