import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = name => fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const authSessionUrl = asModule(compile(source('authSession')));
const previewRequestUrl = asModule(compile(source('previewRequest')));
const apiUrl = asModule(compile(source('api')).replaceAll('"./authSession"', JSON.stringify(authSessionUrl)).replaceAll('"./previewRequest"', JSON.stringify(previewRequestUrl)));
const listTreeUrl = asModule(compile(source('listTreeModel')));
const validationUrl = asModule(compile(source('inputValidation')));
const modelUrl = asModule(compile(source('inputs')).replaceAll('"./api"', JSON.stringify(apiUrl)).replaceAll('"./listTreeModel"', JSON.stringify(listTreeUrl)).replaceAll('"./inputValidation"', JSON.stringify(validationUrl)));
const model = await import(modelUrl);
const { initialInput, resolveInputs, validateInputs, isInput, isLocalDateTime, numericInputValue, incrementInput, sliderInputValue } = model;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const component = (type, props = {}) => ({ id: 'field', type, x: 0, y: 0, width: 240, height: 100, props: { fieldKey: 'value', text: 'Field {machine}', ...props } });
const screen = (...components) => ({ id: 'screen', name: 'Screen', width: 1000, height: 700, components });
const validate = (field, value) => validateInputs(screen(field), { value }, { machine: 'A' });
const tag = (value, quality = 'Good') => ({ path: '[default]Cells/A/Value', value, quality, dataType: 'String', timestamp: '' });
const initial = (field, tags = [], lost = false) => initialInput(field, tags, { machine: 'A' }, lost);
const bound = (type, props = {}) => component(type, { tagPath: '[default]Cells/{machine}/Value', ...props });
const options = [{ label: 'Automatic', value: 'auto' }, { label: 'Manual', value: 'manual' }];

check('all ten input types join shared form resolution', () => {
  for (const type of ['textInput', 'textArea', 'numberInput', 'spinner', 'slider', 'checkbox', 'toggle', 'select', 'radioGroup', 'dateTimeInput']) assert.equal(isInput(type), true, type);
  for (const type of ['label', 'button', 'image', 'repeater']) assert.equal(isInput(type), false, type);
});
check('missing or bad-quality bound values never become a fabricated default', () => {
  for (const type of ['textArea', 'spinner', 'slider', 'radioGroup', 'dateTimeInput', 'toggle']) {
    const field = bound(type, { min: 0, max: 100, options, defaultValue: type === 'toggle' ? false : 0 });
    assert.equal(initial(field), null, type);
    assert.equal(initial(field, [tag(0, 'Bad')]), null, type);
    assert.equal(initial(field, [tag(0)], true), null, type);
  }
});
check('good bound values retain their exact scalar types', () => {
  assert.equal(initial(bound('toggle'), [tag(false)]), false);
  assert.equal(initial(bound('textArea'), [tag('First\nSecond')]), 'First\nSecond');
  assert.equal(initial(bound('spinner', { min: -10, max: 10 }), [tag(2.25)]), 2.25);
  assert.equal(initial(bound('slider', { min: 0, max: 100 }), [tag(25)]), 25);
  assert.equal(initial(bound('radioGroup', { options }), [tag('manual')]), 'manual');
  assert.equal(initial(bound('dateTimeInput'), [tag('2024-02-29T23:59')]), '2024-02-29T23:59');
});
check('wrong bound scalar types are unavailable instead of coerced', () => {
  assert.equal(initial(bound('toggle'), [tag('false')]), null);
  assert.equal(initial(bound('spinner'), [tag('12')]), null);
  assert.equal(initial(bound('textArea'), [tag(12)]), null);
  assert.equal(initial(bound('radioGroup', { options }), [tag(true)]), null);
});
check('bound numbers outside declared limits stay unavailable, not clamped', () => {
  for (const type of ['numberInput', 'spinner', 'slider']) {
    const field = bound(type, { min: 10, max: 20 });
    assert.equal(initial(field, [tag(9)]), null);
    assert.equal(initial(field, [tag(21)]), null);
    assert.equal(initial(field, [tag(10)]), 10);
  }
});
check('unsafe integers and nonfinite values never become initial input values', () => {
  for (const value of [Number.NaN, Infinity, -Infinity, 9007199254740992, -9007199254740992]) {
    for (const type of ['numberInput', 'spinner', 'slider']) {
      const props = type === 'slider' ? { min: -1, max: 1 } : {};
      assert.equal(initial(component(type, { ...props, defaultValue: value })), null);
      assert.equal(initial(bound(type, props), [tag(value)]), null);
    }
  }
});
check('malformed explicit defaults do not fall back to known false, zero or text', () => {
  assert.equal(initial(component('toggle', { defaultValue: 'false' })), null);
  assert.equal(initial(component('spinner', { defaultValue: null })), null);
  assert.equal(initial(component('textArea', { defaultValue: false })), null);
  assert.equal(initial(component('radioGroup', { options, defaultValue: 'undeclared' })), null);
});
check('omitted unbound defaults preserve established field behavior', () => {
  assert.equal(initial(component('toggle')), false);
  assert.equal(initial(component('textArea')), '');
  assert.equal(initial(component('dateTimeInput')), '');
  assert.equal(initial(component('spinner')), 0);
  assert.equal(initial(component('spinner', { min: 5 })), null);
  assert.equal(initial(component('radioGroup', { options })), 'auto');
});
check('edits override only their own input fields, even after communication loss', () => {
  const fields = screen(bound('spinner'), { ...bound('toggle'), id: 'second', props: { fieldKey: 'enabled', tagPath: '[default]Other' } }, component('label'));
  assert.deepEqual(resolveInputs(fields, [], {}, { value: 42 }, true), { value: 42, enabled: null });
});
check('inherited edit values cannot silently become form input', () => {
  assert.deepEqual(resolveInputs(screen(component('toggle')), [], {}, Object.create({ value: true })), { value: false });
});
check('validation labels use current context and unavailable errors remain explicit', () => {
  assert.match(validate(component('toggle'), null), /^Field A: the initial value is unavailable/);
});
check('text area accepts multiline text through the exact maximum', () => {
  const field = component('textArea');
  assert.equal(validate(field, '\n'.repeat(4096)), null);
  assert.match(validate(field, 'a'.repeat(4097)), /4096/);
  assert.equal(initial(component('textArea', { defaultValue: 'a'.repeat(4097) })), null);
  assert.match(validate(field, 123), /text value/);
});
check('numeric fields enforce type, precision and inclusive limits', () => {
  for (const type of ['numberInput', 'spinner', 'slider']) {
    const field = component(type, { min: -10, max: 10 });
    for (const value of [-10, 0, 2.5, 10]) assert.equal(validate(field, value), null);
    for (const value of ['', '5', false, NaN, Infinity, -11, 11, 9007199254740992]) assert.equal(typeof validate(field, value), 'string');
  }
});
check('positive UI step does not impose server-style divisibility', () => {
  for (const type of ['numberInput', 'spinner', 'slider']) assert.equal(validate(component(type, { min: 0, max: 100, step: 3 }), 2.5), null);
});
check('invalid numeric definitions cannot produce actionable initial values', () => {
  for (const props of [{ step: 0 }, { step: -1 }, { step: Infinity }, { step: null }, { min: 10, max: 5 }, { min: null }, { max: Infinity }, { min: 9007199254740992 }]) {
    const field = component('spinner', { defaultValue: 0, ...props });
    assert.equal(initial(field), null);
    assert.match(validate(field, 0), /configured numeric/);
  }
  for (const props of [{}, { min: 0 }, { min: 1, max: 1 }]) assert.equal(initial(component('slider', props)), null);
});
check('numeric typing preserves unsafe digits instead of rounding them', () => {
  assert.equal(numericInputValue('9007199254740993'), '9007199254740993');
  assert.equal(numericInputValue('9007199254740991'), 9007199254740991);
  assert.equal(numericInputValue('1e400'), '1e400');
  assert.equal(numericInputValue(''), '');
  assert.equal(numericInputValue('2.25'), 2.25);
  assert.match(validate(component('spinner'), numericInputValue('9007199254740993')), /exact integer range/);
});
check('spinner increment is bounded and decimal increments stay readable', () => {
  const field = component('spinner', { min: 0, max: 1, step: 0.1 });
  assert.equal(incrementInput(field, 0.2, 1), 0.3);
  assert.equal(incrementInput(field, 0.3, -1), 0.2);
  assert.equal(incrementInput(field, 0.95, 1), 1);
  assert.equal(incrementInput(field, 0.05, -1), 0);
  assert.equal(incrementInput(field, null, 1), 0);
  assert.equal(incrementInput(component('spinner'), 9007199254740991, 1), null);
  assert.equal(incrementInput(component('spinner', { step: 0 }), 1, 1), null);
});
check('slider pointer changes honor step and endpoints without constraining initial values', () => {
  const field = component('slider', { min: 0, max: 10, step: 3, defaultValue: 2.5 });
  assert.equal(initial(field), 2.5);
  assert.equal(validate(field, 2.5), null);
  assert.equal(sliderInputValue(field, 2.5), 3);
  assert.equal(sliderInputValue(field, 8), 9);
  assert.equal(sliderInputValue(field, 10), 10);
  assert.equal(incrementInput(field, 2.5, 1), 5.5);
  assert.equal(sliderInputValue(component('slider', { min: 0, max: 1, step: 0.1 }), 0.29), 0.3);
});
check('radio groups enforce declared string options and preserve empty selection as unknown', () => {
  const field = component('radioGroup', { options });
  assert.equal(validate(field, 'manual'), null);
  for (const value of ['', 'other', false, 0]) assert.equal(typeof validate(field, value), 'string');
  assert.equal(initial(bound('radioGroup', { options }), [tag('other')]), null);
  assert.equal(initial(component('radioGroup', { options: [] })), null);
});
check('toggles require Boolean values without coercion or direct commands', () => {
  const field = component('toggle');
  assert.equal(validate(field, true), null);
  assert.equal(validate(field, false), null);
  for (const value of ['true', 'false', 0, 1, undefined]) assert.match(validate(field, value), /On or Off/);
});
check('local date accepts empty, boundary years, leap days and wall-clock minutes', () => {
  for (const value of ['', '0001-01-01T00:00', '9999-12-31T23:59', '2000-02-29T12:30', '2024-02-29T23:59', '2025-03-09T02:30']) {
    assert.equal(isLocalDateTime(value), true, value);
    assert.equal(validate(component('dateTimeInput'), value), null);
    assert.equal(initial(component('dateTimeInput', { defaultValue: value })), value);
  }
});
check('local date rejects invalid calendar days, normalized dates and timezone forms', () => {
  for (const value of ['0000-01-01T00:00', '10000-01-01T00:00', '1900-02-29T12:00', '2023-02-29T12:00', '2024-04-31T12:00', '2024-00-01T12:00', '2024-13-01T12:00', '2024-01-00T12:00', '2024-01-01T24:00', '2024-01-01T23:60', '2024-1-01T00:00', '2024-01-01 12:00', '2024-01-01T12:00:00', '2024-01-01T12:00Z', '2024-01-01T12:00+01:00', ' 2024-01-01T12:00', '2024-01-01T12:00\n', '２０２４-01-01T12:00', true, 0, null]) {
    assert.equal(isLocalDateTime(value), false, String(value));
    assert.equal(typeof validate(component('dateTimeInput'), value), 'string');
    assert.equal(initial(component('dateTimeInput', { defaultValue: value })), null);
  }
});
check('date values are unchanged across process timezones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Chicago', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      assert.equal(initial(bound('dateTimeInput'), [tag('2025-03-09T02:30')]), '2025-03-09T02:30');
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

// Render the actual shared component without mounting a browser or mocking its logic.
const require = createRequire(import.meta.url);
const modules = new Map([['api', apiUrl], ['inputs', modelUrl], ['listTreeModel', listTreeUrl], ['Icon', asModule('export default function Icon() { return null; }')]]);
function loadComponentModule(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`./src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, `Missing component dependency ${name}`);
  const code = compile(fs.readFileSync(file, 'utf8')).replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency.startsWith('./') ? loadComponentModule(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const { ComponentView } = await import(loadComponentModule('Components'));
const view = (field, props = {}) => React.createElement(ComponentView, { component: field, tags: [], parameters: {}, preview: true, onNavigate() {}, ...props });
const render = (field, props) => renderToStaticMarkup(view(field, props));
check('radio instances with the same saved component ID have independent native groups', () => {
  const field = component('radioGroup', { options });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, view(field), view(field)));
  const names = [...html.matchAll(/\bname="([^"]+)"/g)].map(match => match[1]);
  assert.equal(names.length, 4);
  assert.equal(names[0], names[1]);
  assert.equal(names[2], names[3]);
  assert.notEqual(names[0], names[2]);
  assert.match(html, /<legend>Field \{machine\}<\/legend>/);
});
check('all new controls disable their native interactions while locked or designing', () => {
  for (const type of ['textArea', 'spinner', 'slider', 'radioGroup', 'dateTimeInput', 'toggle']) {
    const field = component(type, { min: 0, max: 100, options });
    for (const props of [{ interactionLocked: true }, { preview: false }]) {
      const html = render(field, props);
      const controls = [...html.matchAll(/<(?:input|textarea|button)\b[^>]*>/g)].map(match => match[0]);
      assert.ok(controls.length > 0, type);
      for (const control of controls) assert.match(control, /\bdisabled=""/, `${type}: ${control}`);
    }
  }
});
check('text area renders multiline content with its browser length limit', () => {
  const html = render(component('textArea', { defaultValue: 'First\nSecond' }));
  assert.match(html, /maxlength="4096"/i);
  assert.match(html, />First\nSecond<\/textarea>/);
  assert.match(html, /aria-label="Field \{machine\}"/);
});
check('unavailable slider and toggle render explicit unknown state', () => {
  const range = render(bound('slider', { min: 0, max: 100 }));
  assert.match(range, /Choose a value/);
  assert.match(range, /class="slider-unset"/);
  assert.match(range, /aria-valuetext="Initial value unavailable/);
  const toggle = render(bound('toggle'));
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, />Unknown<\/span>/);
  assert.match(toggle, /Initial value unavailable/);
});
check('native slider markup does not round off-step initial values', () => {
  const html = render(component('slider', { min: 0, max: 10, step: 3, defaultValue: 2.5 }));
  assert.match(html, /step="any"/);
  assert.match(html, /value="2.5"/);
  assert.match(html, />2.5<\/output>/);
});
check('date control emits only the authored local minute string', () => {
  const html = render(component('dateTimeInput', { defaultValue: '2025-03-09T02:30' }));
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /step="60"/);
  assert.match(html, /value="2025-03-09T02:30"/);
  assert.doesNotMatch(html, /2025-03-09T02:30(?::00|Z)/);
});
console.log(`${checks}/${checks} input model checks passed.`);
