import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const code = fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from "\.\/([^"]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  modules.set(name, url); return url;
}
const { evaluateComponentBindings, validatePropertyBinding, bindingTargets, componentGeometry, propertyValue, supportsBindingTarget, processBindingTargets } = await import(load('propertyBindings'));
let count = 0;
const check = (name, run) => { run(); count++; console.log(`PASS ${name}`); };
const context = (changes = {}) => ({ components: [], tags: [], parameters: {}, inputs: {}, ...changes });
const custom = (value) => ({ type: typeof value, value });
const definition = (expression, references = {}) => ({ expression, references });
const component = (props = {}, id = 'button') => ({ id, type: 'button', x: 1, y: 2, width: 100, height: 30, props: { text: 'Original', ...props } });
const run = (expression, references = {}, target = 'text', changes = {}, props = {}) => evaluateComponentBindings(component({ ...props, bindings: { [target]: definition(expression, references) } }), context(changes));
const value = (expression, references = {}, target = 'text', changes = {}, props = {}) => {
  const result = run(expression, references, target, changes, props);
  assert.deepEqual(result.errors, {});
  return propertyValue(result.component, target);
};
const error = (expression, references = {}, target = 'text', changes = {}, props = {}) => {
  const result = run(expression, references, target, changes, props);
  assert.equal(typeof result.errors[target], 'string');
  return result;
};

check('unbound components retain identity and existing defaults', () => {
  const original = component();
  assert.equal(evaluateComponentBindings(original, context()).component, original);
});
check('arithmetic follows precedence, parentheses, unary and remainder', () => {
  assert.equal(value('2 + 3 * 4'), '14');
  assert.equal(value('-(2 + 3) * +4 + 21 % 4'), '-19');
  assert.equal(value('.25 * 4 + 2e2'), '201');
  assert.equal(value('10 - 3 - 2'), '5');
});
check('quoted strings and escaped characters stay data', () => {
  assert.equal(value(`'line\\n' + "two\\u0021"`), 'line\ntwo!');
  assert.equal(value(`'\\\'' + '\\\\'`), "'\\");
});
check('strict equality, ordering and Boolean conditions are typed', () => {
  assert.equal(value('2 === 2 && 3 >= 2 && !(1 != 1)', {}, 'enabled'), true);
  assert.equal(value("'a' < 'b'", {}, 'enabled'), true);
  error('1 == "1"', {}, 'enabled');
  error('1 && true', {}, 'enabled');
  error('true < false', {}, 'enabled');
  error('"1" + 1');
});
check('conditional and logical branches resolve data lazily', () => {
  const refs = { missing: { kind: 'tag', path: '[default]missing' } };
  assert.equal(value('false && missing', refs, 'enabled', { communicationLost: true }), false);
  assert.equal(value('true || missing', refs, 'enabled'), true);
  assert.equal(value('true ? "Ready" : missing', refs), 'Ready');
  assert.equal(value('false ? missing : true ? "Nested" : "No"', refs), 'Nested');
  error('true && missing', refs, 'enabled');
});
check('text stringifies finite primitive values only', () => {
  assert.equal(value('true'), 'true');
  assert.equal(value('12.5'), '12.5');
  error('null');
});
check('enabled and visible require actual Boolean results and safe fallbacks', () => {
  assert.equal(error('1', {}, 'enabled').component.props.enabled, false);
  assert.equal(error('"false"', {}, 'visible').component.props.visible, true);
  assert.equal(value('false', {}, 'visible'), false);
});
check('color accepts deterministic hexadecimal formats only', () => {
  for (const color of ['#abc', '#ABCD', '#12ab34', '#12ab34ef']) assert.equal(value(JSON.stringify(color), {}, 'color'), color);
  for (const color of ['garbage', 'red', 'url(http://example.test)', '#12', '#xyz', '#abc\n', '', 'x'.repeat(129)])
    assert.equal(error(JSON.stringify(color), {}, 'color').component.props.color, undefined);
});
check('same-component custom values are typed and independent after copying', () => {
  const props = { customProperties: { count: custom(5) }, bindings: { enabled: definition('count > 0', { count: { kind: 'custom', key: 'count' } }) } };
  const first = component(props);
  const second = component(structuredClone(props), 'copy');
  second.props.customProperties.count.value = 0;
  const scoped = context({ components: [first, second] });
  assert.equal(evaluateComponentBindings(first, scoped).component.props.enabled, true);
  assert.equal(evaluateComponentBindings(second, scoped).component.props.enabled, false);
  assert.equal(first.props.customProperties.count.value, 5);
});
check('sibling custom references stay inside the supplied instance scope', () => {
  const sibling = component({ customProperties: { count: custom(7) } }, 'sibling');
  const refs = { n: { kind: 'custom', componentId: 'sibling', key: 'count' } };
  assert.equal(value('n', refs, 'text', { components: [sibling] }), '7');
  error('n', refs, 'text', { components: [] });
  const anotherInstance = component({ customProperties: { count: custom(20) } }, 'sibling');
  assert.equal(value('n', refs, 'text', { components: [anotherInstance] }), '20');
});
check('custom references reject missing, inherited and malformed values', () => {
  const refs = { n: { kind: 'custom', key: 'count' } };
  error('n', refs);
  error('n', refs, 'text', {}, { customProperties: Object.create({ count: custom(4) }) });
  error('n', refs, 'text', {}, { customProperties: { count: { type: 'number', value: '4' } } });
});
check('parameter and input values use only own properties and keep exact types', () => {
  const refs = { name: { kind: 'parameter', key: 'machine' }, qty: { kind: 'input', key: 'quantity' } };
  assert.equal(value('name', refs, 'text', { parameters: { machine: 'Press 1' } }), 'Press 1');
  assert.equal(value('qty >= 5', refs, 'enabled', { inputs: { quantity: 5 } }), true);
  error('qty', refs, 'text', { inputs: { quantity: null } });
  error('qty', refs, 'text', { inputs: Object.create({ quantity: 3 }) });
});
check('tag path parameters resolve once within the supplied context', () => {
  const refs = { speed: { kind: 'tag', path: '[default]Cells/{machine}/Speed' } };
  const tags = [{ path: '[default]Cells/A/Speed', value: 4, quality: 'Good', dataType: 'Int32', timestamp: '' }];
  assert.equal(value('speed * 2', refs, 'text', { tags, parameters: { machine: 'A' } }), '8');
  error('speed', refs, 'text', { tags });
  error('speed', refs, 'text', { tags, parameters: Object.create({ machine: 'A' }) });
  error('speed', refs, 'text', { tags, parameters: { machine: '{other}', other: 'A' } });
});
check('missing tags, offline connections and bad quality never become data', () => {
  const refs = { n: { kind: 'tag', path: '[default]Value' } };
  const tag = { path: '[default]Value', value: 5, quality: 'Good', dataType: 'Int32', timestamp: '' };
  error('n', refs);
  error('n', refs, 'text', { tags: [tag], communicationLost: true });
  for (const quality of ['Bad', 'Uncertain', 'GoodEnough', 'notGood', '']) error('n', refs, 'text', { tags: [{ ...tag, quality }] });
  assert.equal(value('n', refs, 'text', { tags: [{ ...tag, quality: 'Good_LocalOverride' }] }), '5');
});
check('objects, arrays, nonfinite and unsafe integer source values are rejected', () => {
  for (const invalid of [{}, [], null, NaN, Infinity, -Infinity, 9007199254740992, 'x'.repeat(4097)]) {
    error('n', { n: { kind: 'input', key: 'value' } }, 'text', { inputs: { value: invalid } });
    error('n', { n: { kind: 'tag', path: 'value' } }, 'text', { tags: [{ path: 'value', value: invalid, quality: 'Good' }] });
  }
});
check('division errors, overflow and unsafe integer arithmetic fail closed', () => {
  for (const expression of ['1 / 0', '0 / 0', '1 % 0', '1e309', '9007199254740992', '9007199254740991 + 1']) error(expression);
});
check('evaluation leaves authored bindings and other targets untouched', () => {
  const original = component({ enabled: true, color: '#abc', bindings: { text: definition('2 + 2'), enabled: definition('1 / 0') } });
  const before = structuredClone(original);
  const result = evaluateComponentBindings(original, context());
  assert.equal(result.component.props.text, '4');
  assert.equal(result.component.props.enabled, false);
  assert.equal(result.component.props.color, '#abc');
  assert.deepEqual(Object.keys(result.errors), ['enabled']);
  assert.deepEqual(original, before);
});
check('property access, calls, assignment, templates and unsupported operators cannot execute', () => {
  for (const expression of ['globalThis', 'n.constructor', 'n["x"]', 'n()', 'n = 2', '`hello`', '2 ** 3', 'true; 1', 'null', 'new Thing()'])
    assert.equal(typeof validatePropertyBinding(definition(expression, { n: { kind: 'input', key: 'quantity' } })), 'string', expression);
});
check('prototype names are blocked as aliases, keys and component IDs', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const refs = JSON.parse(`{"${key}":{"kind":"input","key":"quantity"}}`);
    assert.equal(typeof validatePropertyBinding(definition('true', refs)), 'string');
    for (const kind of ['input', 'parameter', 'custom']) assert.equal(typeof validatePropertyBinding(definition('n', { n: { kind, key } })), 'string');
    assert.equal(typeof validatePropertyBinding(definition('n', { n: { kind: 'custom', key: 'count', componentId: key } })), 'string');
  }
});
check('undeclared, malformed and excessive reference definitions are rejected', () => {
  for (const binding of [null, [], { expression: '1' }, definition('missing'), definition('1', []), definition('1', { n: { kind: 'unknown' } }), definition('1', { n: { kind: 'tag', path: '' } }), definition('1', { n: { kind: 'input', key: 'x', secret: true } }), definition('1', Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`n${i}`, { kind: 'input', key: 'x' }])))])
    assert.equal(typeof validatePropertyBinding(binding), 'string');
  for (const key of ['', ' ', '\t\n']) {
    assert.equal(typeof validatePropertyBinding(definition('n', { n: { kind: 'parameter', key } })), 'string');
    assert.equal(typeof validatePropertyBinding(definition('n', { n: { kind: 'custom', key: 'count', componentId: key } })), 'string');
  }
});
check('length, token, parentheses and flat AST depth bounds are enforced', () => {
  for (const expression of [' '.repeat(2049), '1'.repeat(2049), '('.repeat(34) + '1' + ')'.repeat(34), Array(36).fill('1').join('+'), Array(130).fill('1').join('+')])
    assert.equal(typeof validatePropertyBinding(definition(expression)), 'string');
  assert.equal(validatePropertyBinding(definition('('.repeat(16) + '1' + ')'.repeat(16))), undefined);
});
check('partial or malformed expression tokens have precise failure results', () => {
  for (const expression of ['', '1 +', '(1', '1)', 'true ? 1', "'unclosed", "'bad\\q'", "'bad\nline'", "'\\u00zz'", '1 2', '1e'])
    assert.equal(error(expression).component.props.text, 'Binding error', expression);
  assert.equal(value('\ufeff true\u00a0', {}, 'enabled'), true);
  error('\u0085true', {}, 'enabled');
});
check('structural validation allows missing live data but rejects constant target errors', () => {
  assert.equal(validatePropertyBinding(definition('n > 0', { n: { kind: 'tag', path: 'missing' } }), 'enabled'), undefined);
  assert.equal(typeof validatePropertyBinding(definition('"yes"'), 'enabled'), 'string');
  assert.equal(typeof validatePropertyBinding(definition('1 / 0'), 'text'), 'string');
  assert.equal(typeof validatePropertyBinding(definition('"bad"'), 'color'), 'string');
  assert.equal(validatePropertyBinding(definition('"#abc"'), 'color'), undefined);
});
check('malformed runtime binding containers fail without throwing', () => {
  for (const bindings of [[], 'bad', 10, 0, false, null]) {
    const result = evaluateComponentBindings(component({ bindings }), context());
    assert.equal(result.component.props.enabled, false);
    assert.equal(result.component.props.text, 'Binding error');
  }
});
check('common targets and display-specific targets use their correct property location', () => {
  const expected = { text: 'Ready', enabled: true, visible: false, color: '#123', x: 24, y: 48, width: 200, height: 80,
    fontSize: 18, backgroundColor: '#1234', foregroundColor: '#abcdef', borderColor: '#12345678', borderWidth: 2, tagPath: '[default]Equipment/Load' };
  const original = component({ bindings: Object.fromEntries(Object.entries(expected).map(([target, item]) => [target, definition(JSON.stringify(item))])) });
  original.type = 'value';
  const result = evaluateComponentBindings(original, context());
  assert.deepEqual(result.errors, {});
  for (const target of [...Object.keys(expected), 'stateValue', ...processBindingTargets, 'strokeColor', 'fillColor', 'strokeWidth', 'rotation', 'flowing', 'flowReverse', 'active']) assert.ok(bindingTargets.includes(target), target);
  const indicator = { ...component({ bindings: { stateValue: definition('true') } }), type: 'multiStateIndicator' };
  const indicatorResult = evaluateComponentBindings(indicator, context());
  assert.deepEqual(indicatorResult.errors, {});
  assert.equal(propertyValue(indicatorResult.component, 'stateValue'), 'true');
  for (const [target, item] of Object.entries(expected)) assert.equal(propertyValue(result.component, target), item, target);
  for (const target of ['x', 'y', 'width', 'height']) assert.equal(Object.hasOwn(result.component.props, target), false, target);
  assert.equal(original.width, 100);
  assert.equal(original.props.fontSize, undefined);
});
check('input-driven tag paths resolve per form and never mutate authored definitions', () => {
  const original = { ...component({ tagPath: '[default]Fallback', bindings: { tagPath: definition("'[default]Equipment/' + machine + '/Load'", {machine: {kind:'input',key:'machine'}}) } }), type:'gauge' };
  for (const machine of ['Press01','Press02']) {
    const result = evaluateComponentBindings(original, context({inputs:{machine}}));
    assert.deepEqual(result.errors, {});
    assert.equal(result.component.props.tagPath, `[default]Equipment/${machine}/Load`);
  }
  assert.equal(original.props.tagPath, '[default]Fallback');
  const missing = evaluateComponentBindings(original, context());
  assert.equal(missing.component.props.tagPath, '');
  assert.match(missing.errors.tagPath, /not found/);
});
check('invalid tag path results clear the fallback and unsupported component types fail', () => {
  for (const raw of ['', 42, true, 'x'.repeat(1025), '[default]{machine}/Load', 'a\nb']) {
    const original = {...component({tagPath:'[default]Fallback',bindings:{tagPath:definition(JSON.stringify(raw))}}),type:'value'};
    const result = evaluateComponentBindings(original, context());
    assert.equal(result.component.props.tagPath, '');
    assert.equal(typeof result.errors.tagPath, 'string');
    assert.equal(typeof validatePropertyBinding(definition(JSON.stringify(raw)), 'tagPath'), 'string');
  }
  const result = run("'[default]Equipment/Load'", {}, 'tagPath');
  assert.match(result.errors.tagPath, /not supported/);
});
check('geometry targets accept exact bounds and fractional coordinates without coercion', () => {
  for (const [target, minimum] of [['x', 0], ['y', 0], ['width', 1], ['height', 1]]) {
    for (const valid of [minimum, minimum + 0.25, 8192]) {
      assert.equal(value(String(valid), {}, target), valid, `${target}: ${valid}`);
      assert.equal(validatePropertyBinding(definition(String(valid)), target), undefined);
    }
    for (const invalid of [minimum - 0.01, 8192.01, -1, '40', true, false]) {
      const expression = JSON.stringify(invalid);
      const result = error(expression, {}, target);
      assert.equal(propertyValue(result.component, target), propertyValue(component(), target), `${target}: ${expression}`);
      assert.equal(typeof validatePropertyBinding(definition(expression), target), 'string', target);
    }
  }
});
check('invalid geometry never replaces authored fallback values or invents props geometry', () => {
  const original = { ...component({ bindings: { x: definition('-1'), y: definition('8193'), width: definition('0'), height: definition('"12"') } }),
    x: 11, y: 22, width: 123, height: 45 };
  const before = structuredClone(original);
  const result = evaluateComponentBindings(original, context());
  assert.deepEqual(Object.keys(result.errors).sort(), ['height', 'width', 'x', 'y']);
  assert.deepEqual(componentGeometry(original, context()), { left: 11, top: 22, width: 123, height: 45 });
  for (const target of ['x', 'y', 'width', 'height']) {
    assert.equal(result.component[target], original[target]);
    assert.equal(Object.hasOwn(result.component.props, target), false);
  }
  assert.deepEqual(original, before);
});
check('font size and border width use their own bounds and retain authored numeric fallbacks', () => {
  for (const [target, minimum, maximum, fallback] of [['fontSize', 1, 256, 20], ['borderWidth', 0, 32, 2.5]]) {
    for (const valid of [minimum, minimum + 0.5, maximum]) assert.equal(value(String(valid), {}, target), valid);
    for (const invalid of [minimum - 0.1, maximum + 0.1, '16', true]) {
      const expression = JSON.stringify(invalid);
      assert.equal(error(expression, {}, target, {}, { [target]: fallback }).component.props[target], fallback);
      assert.equal(error(expression, {}, target).component.props[target], undefined);
      assert.equal(typeof validatePropertyBinding(definition(expression), target), 'string');
    }
  }
});
check('all four color properties enforce hex results and discard invalid color fallbacks', () => {
  for (const target of ['color', 'backgroundColor', 'foregroundColor', 'borderColor']) {
    for (const color of ['#abc', '#1234', '#ABCDEF', '#123456ab']) assert.equal(value(JSON.stringify(color), {}, target), color);
    for (const color of ['red', '#12', '#12345', '#abcdefg', '#123\n', 'rgba(0,0,0,1)', 123, false]) {
      const expression = JSON.stringify(color);
      assert.equal(error(expression, {}, target, {}, { [target]: '#fff' }).component.props[target], undefined);
      assert.equal(typeof validatePropertyBinding(definition(expression), target), 'string');
    }
  }
});
check('propertyValue reads top-level geometry and property styles without conflating names', () => {
  const original = component({ x: 999, y: 999, width: 999, height: 999, fontSize: 21, backgroundColor: '#abc', borderWidth: 3 });
  for (const target of ['x', 'y', 'width', 'height']) assert.equal(propertyValue(original, target), original[target]);
  assert.equal(propertyValue(original, 'text'), 'Original');
  assert.equal(propertyValue(original, 'fontSize'), 21);
  assert.equal(propertyValue(original, 'backgroundColor'), '#abc');
  assert.equal(propertyValue(original, 'borderWidth'), 3);
  assert.equal(propertyValue(original, 'visible'), undefined);
});
check('componentGeometry keeps authored selection bounds and evaluates only preview/runtime geometry', () => {
  const refs = { position: { kind: 'input', key: 'position' } };
  const original = component({ bindings: { x: definition('position', refs), y: definition('position * 2', refs), width: definition('position + 100', refs), height: definition('80') } });
  assert.deepEqual(componentGeometry(original, context(), false), { left: 1, top: 2, width: 100, height: 30 });
  const live = context({ inputs: { position: 50 } });
  assert.deepEqual(componentGeometry(original, live, true), { left: 50, top: 100, width: 150, height: 80 });
  assert.deepEqual(componentGeometry(original, live), componentGeometry(original, live, true));
  assert.deepEqual(componentGeometry(original, live, false), { left: 1, top: 2, width: 100, height: 30 });
});
check('geometry and appearance reevaluate from updated form inputs without retaining stale results', () => {
  const refs = { count: { kind: 'input', key: 'quantity' } };
  const original = component({ fontSize: 14, borderWidth: 1, bindings: {
    width: definition('100 + count * 10', refs), fontSize: definition('12 + count', refs),
    backgroundColor: definition('count > 5 ? "#008800" : "#880000"', refs), borderWidth: definition('count > 5 ? 3 : 1', refs),
  } });
  const firstResult = evaluateComponentBindings(original, context({ inputs: { quantity: 2 } }));
  const secondResult = evaluateComponentBindings(original, context({ inputs: { quantity: 8 } }));
  assert.deepEqual(firstResult.errors, {}); assert.deepEqual(secondResult.errors, {});
  assert.equal(firstResult.component.width, 120); assert.equal(secondResult.component.width, 180);
  assert.equal(firstResult.component.props.fontSize, 14); assert.equal(secondResult.component.props.fontSize, 20);
  assert.equal(firstResult.component.props.backgroundColor, '#880000'); assert.equal(secondResult.component.props.backgroundColor, '#008800');
  assert.equal(secondResult.component.props.borderWidth, 3);
  const missing = evaluateComponentBindings(original, context({ inputs: { quantity: null } }));
  assert.equal(missing.component.width, 100); assert.equal(missing.component.props.fontSize, 14);
  assert.equal(missing.component.props.backgroundColor, undefined); assert.equal(missing.component.props.borderWidth, 1);
  assert.equal(original.props.backgroundColor, undefined);
});
check('shared component definitions respect each instance form and parameter scope', () => {
  const refs = { amount: { kind: 'input', key: 'quantity' }, side: { kind: 'parameter', key: 'side' } };
  const original = component({ bindings: { x: definition('side == "left" ? 0 : 400', refs), width: definition('amount + 100', refs) } });
  const left = context({ parameters: { side: 'left' }, inputs: { quantity: 10 } });
  const right = context({ parameters: { side: 'right' }, inputs: { quantity: 80 } });
  assert.deepEqual(componentGeometry(original, left), { left: 0, top: 2, width: 110, height: 30 });
  assert.deepEqual(componentGeometry(original, right), { left: 400, top: 2, width: 180, height: 30 });
  assert.deepEqual(componentGeometry(original, left), { left: 0, top: 2, width: 110, height: 30 });
});
check('one invalid layout or style target does not roll back successful neighboring bindings', () => {
  const original = component({ fontSize: 17, bindings: { x: definition('40'), y: definition('-1'), width: definition('200'), fontSize: definition('0') } });
  const result = evaluateComponentBindings(original, context());
  assert.deepEqual(Object.keys(result.errors).sort(), ['fontSize', 'y']);
  assert.deepEqual(componentGeometry(original, context()), { left: 40, top: 2, width: 200, height: 30 });
  assert.equal(result.component.props.fontSize, 17);
});
check('process targets are accepted only on their supported display types', () => {
  const expected = { value: 25.5, min: 0, max: 100, decimals: 2, unit: 'kPa', showValue: true, showPercent: false, orientation: 'vertical' };
  for (const type of ['ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer', 'button', 'value', 'template']) {
    for (const [target, item] of Object.entries(expected)) {
      const allowed = type === 'value' && target === 'unit' || ['ledDisplay', 'progressBar', 'cylindricalTank', 'levelIndicator', 'thermometer'].includes(type) &&
        (!['min', 'max', 'showValue', 'showPercent'].includes(target) || type !== 'ledDisplay') &&
        (target !== 'orientation' || ['progressBar', 'levelIndicator'].includes(type));
      assert.equal(supportsBindingTarget(type, target), allowed);
      const original = { ...component({ bindings: { [target]: definition(JSON.stringify(item)) } }), type };
      const result = evaluateComponentBindings(original, context());
      if (allowed) { assert.deepEqual(result.errors, {}); assert.equal(result.component.props[target], item); }
      else { assert.equal(typeof result.errors[target], 'string'); assert.equal(result.component.props[target], undefined); }
    }
  }
});
check('process numeric, format, flags and orientation results reject coercion and clear authored fallbacks', () => {
  for (const [target, invalid] of [['value', '5'], ['min', false], ['max', true], ['decimals', 2.5], ['decimals', 7], ['unit', 12], ['unit', 'x'.repeat(33)], ['showValue', 1], ['showPercent', 'false'], ['orientation', 'diagonal']]) {
    const expression = JSON.stringify(invalid), original = { ...component({ [target]: target === 'unit' ? 'saved' : 42, bindings: { [target]: definition(expression) } }), type: 'progressBar' };
    const result = evaluateComponentBindings(original, context());
    assert.equal(typeof result.errors[target], 'string', target); assert.equal(result.component.props[target], undefined, target);
    assert.equal(typeof validatePropertyBinding(definition(expression), target), 'string', target);
  }
  assert.equal(typeof validatePropertyBinding(definition('9007199254740992'), 'value'), 'string');
});
check('constant range bindings validate the paired authored/default/constant range', () => {
  const original = { ...component({ min: 0, max: 100 }), type: 'progressBar' };
  assert.match(validatePropertyBinding(definition('100'), 'min', original), /less than/);
  assert.match(validatePropertyBinding(definition('0'), 'max', original), /less than/);
  assert.equal(validatePropertyBinding(definition('99'), 'min', original), undefined);
  original.props.bindings = { max: definition('50') };
  assert.match(validatePropertyBinding(definition('75'), 'min', original), /less than/);
  original.props.bindings = { max: definition('limit', { limit: { kind: 'parameter', key: 'limit' } }) };
  assert.equal(validatePropertyBinding(definition('75'), 'min', original), undefined);
});
console.log(`${count} property binding checks passed.`);
