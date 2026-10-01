import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the shipped models and React renderer together, without a gateway.
const require = createRequire(import.meta.url), modules = new Map();
function moduleUrl(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(name, url); return url;
}
const { default: DrawingComponent, drawingLayout } = await import(moduleUrl('DrawingComponent'));
const { drawingTypes } = await import(moduleUrl('drawingComponents'));
const { ComponentView } = await import(moduleUrl('Components'));
const { default: BoundComponent } = await import(moduleUrl('BoundComponent'));
const component = (type = 'pipe', props = {}, dimensions = {}) => ({ id: 'drawing', type, x: 0, y: 0, width: 240, height: 120, props, ...dimensions });
const parameters = {};
const propsFor = (item, changes = {}) => ({ component: item, tags: [], parameters, preview: true, onNavigate() {}, ...changes });
const html = (item, changes = {}) => renderToStaticMarkup(React.createElement(ComponentView, propsFor(item, changes)));
const boundHtml = (item, changes = {}) => renderToStaticMarkup(React.createElement(BoundComponent, propsFor(item, changes)));
const descendants = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
const binding = key => ({ expression: key, references: { [key]: { kind: 'parameter', key } } });
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('all six drawing types dispatch through the actual component renderer', () => {
  assert.equal(drawingTypes.length, 6);
  for (const type of drawingTypes) {
    const markup = html(component(type));
    assert.match(markup, new RegExp(`drawing-${type}`));
    assert.match(markup, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.match(markup, /role="img"/);
    assert.doesNotMatch(markup, /<(?:input|button|select|textarea)\b|unavailable|NaN|Infinity/);
  }
});

test('rotation fits the entire stroked bounding rectangle in small, wide and tall boxes', () => {
  for (const [width, height] of [[1, 1], [1, 120], [240, 1], [240, 120], [60, 300], [8192, 8192]]) {
    for (const stroke of [1, 12, 32]) for (const rotation of [0, 30, 45, 90, 135, 180, 270, 360]) for (const caption of [false, true]) {
      const layout = drawingLayout(width, height, stroke, rotation, caption);
      assert.ok(Object.values(layout).filter(value => typeof value === 'number').every(Number.isFinite));
      const radians = rotation * Math.PI / 180;
      for (const x of [-layout.innerWidth / 2, layout.innerWidth / 2]) for (const y of [-layout.innerHeight / 2, layout.innerHeight / 2]) {
        const projectedX = layout.width / 2 + layout.scale * (x * Math.cos(radians) - y * Math.sin(radians));
        const projectedY = layout.graphicHeight / 2 + layout.scale * (x * Math.sin(radians) + y * Math.cos(radians));
        assert.ok(projectedX - layout.stroke / 2 >= -1e-8 && projectedX + layout.stroke / 2 <= layout.width + 1e-8);
        assert.ok(projectedY - layout.stroke / 2 >= -1e-8 && projectedY + layout.stroke / 2 <= layout.graphicHeight + 1e-8);
      }
    }
  }
});

test('normalized points become finite numeric geometry with constant physical stroke', () => {
  const tree = DrawingComponent(propsFor(component('polyline', { points: [{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }], strokeWidth: 4 })));
  const line = descendants(tree, node => node.type === 'polyline')[0];
  assert.equal(line.props.points, '0,114 117,0 234,114');
  assert.equal(line.props.strokeWidth, 4);
  assert.equal(line.props.vectorEffect, 'non-scaling-stroke');
  const rounded = html(component('rectangle', { cornerRadius: 50 }));
  assert.match(rounded, /rx="58"/);
});

test('route and primitive labels are accessible without changing their geometry bounds', () => {
  for (const type of ['line', 'polyline', 'pipe', 'rectangle', 'ellipse']) {
    const plain = DrawingComponent(propsFor(component(type))), named = DrawingComponent(propsFor(component(type, { text: 'Transfer route' })));
    const transform = tree => descendants(tree, node => node.props?.className === 'drawing-geometry')[0].props.transform;
    assert.equal(transform(plain), transform(named));
    const markup = renderToStaticMarkup(named);
    assert.match(markup, /aria-label="Transfer route/); assert.doesNotMatch(markup, /drawing-caption/);
  }
  assert.match(html(component('equipmentSymbol', { text: 'Feed pump' })), /drawing-caption/);
});

test('invalid dimensions, geometry, paints and numbers render a diagnostic without SVG fallback', () => {
  const invalid = [
    component('pipe', {}, { width: NaN }), component('pipe', {}, { height: Infinity }), component('pipe', {}, { width: 0 }),
    component('pipe', { strokeWidth: NaN }), component('pipe', { strokeWidth: 33 }), component('rectangle', { rotation: Infinity }),
    component('line', { points: [{ x: 0, y: 0 }, { x: '<script>', y: 100 }] }),
    component('polyline', { points: [{ x: 0, y: 0 }, { x: 101, y: 100 }] }),
    component('pipe', { strokeColor: 'url(https://example.test/a.svg)' }), component('rectangle', { fillColor: 'red' }),
    component('equipmentSymbol', { symbol: 'external', active: true }), component('pipe', { flowing: 'true' }),
  ];
  for (const item of invalid) {
    const markup = html(item);
    assert.match(markup, /role="status"/); assert.match(markup, /Graphic unavailable/);
    assert.doesNotMatch(markup, /<svg|drawing-active|drawing-pipe-flow|<button/);
  }
});

test('flow animates only in preview/operator, supports reverse, and stops without retaining a trail', () => {
  const flowing = component('pipe', { flowing: true, flowReverse: true, color: '#00ff99', fillColor: '#112233' });
  const markup = html(flowing);
  assert.match(markup, /drawing-pipe-flow drawing-flow-animated drawing-flow-reverse/);
  assert.match(markup, /stroke="#00ff99"/); assert.match(markup, /stroke="#112233"/);
  assert.match(markup, /aria-label="Pipe: Flowing reverse"/);
  const designer = html(flowing, { preview: false });
  assert.match(designer, /drawing-pipe-flow/); assert.doesNotMatch(designer, /drawing-flow-animated/);
  const stopped = html(component('pipe', { flowing: false, flowReverse: true }));
  assert.doesNotMatch(stopped, /drawing-pipe-flow|drawing-flow-animated/); assert.match(stopped, /Pipe: Stopped/);
});

test('reduced motion disables the CSS animation while keeping the visible flow indicator', () => {
  const css = fs.readFileSync(new URL('src/drawingComponents.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.drawing-flow-animated\s*\{\s*animation:\s*none;/);
  assert.match(css, /\.drawing-flow-animated\.drawing-flow-reverse\s*\{\s*animation-direction:\s*reverse;/);
  const markup = html(component('pipe', { flowing: true }));
  assert.match(markup, /stroke-dasharray=/); assert.doesNotMatch(markup, /<animate|<script/);
});

test('pump, valve and motor are distinct self-contained schematic symbols with accessible state', () => {
  const symbols = [];
  for (const symbol of ['pump', 'valve', 'motor']) {
    const markup = html(component('equipmentSymbol', { symbol, active: true, color: '#22aa55', text: 'Transfer equipment' }));
    assert.match(markup, new RegExp(`data-equipment-symbol="${symbol}"`));
    assert.match(markup, /aria-label="Transfer equipment: Active"/); assert.match(markup, /stroke="#22aa55"/);
    assert.doesNotMatch(markup, /<image|<use|href=|<script|https?:|<button/);
    symbols.push(markup.match(/<g data-equipment-symbol=.*<\/g>/)?.[0]);
  }
  assert.equal(new Set(symbols).size, 3);
  assert.match(html(component('equipmentSymbol', { active: false })), /aria-label="Pump: Inactive"/);
});

test('equipment navigation and popups use native buttons and the provided callbacks exactly once', () => {
  for (const action of ['navigate', 'openPopup']) {
    const item = component('equipmentSymbol', { action, targetScreenId: 'details' }), calls = [];
    const tree = DrawingComponent(propsFor(item, { onNavigate: target => calls.push(['navigate', target]), onOpenPopup: target => calls.push(['openPopup', target]) }));
    assert.equal(tree.type, 'button'); assert.equal(tree.props.type, 'button'); assert.equal(tree.props.disabled, false);
    assert.equal(tree.props.style.pointerEvents, 'auto');
    assert.equal(tree.props.tabIndex, 0); tree.props.onClick();
    assert.deepEqual(calls, [[action, action === 'navigate' ? 'details' : item]]);
    const viewer = html(item, { readOnly: true });
    assert.match(viewer, /<button/); assert.doesNotMatch(viewer, /disabled=/);
  }
});

test('designer, locked and unavailable equipment cannot dispatch actions even through direct handler calls', () => {
  const item = component('equipmentSymbol', { action: 'navigate', targetScreenId: 'details' });
  for (const changes of [{ preview: false }, { interactionLocked: true }]) {
    const calls = [], tree = DrawingComponent(propsFor(item, { ...changes, onNavigate: target => calls.push(target) }));
    assert.equal(tree.props.disabled, true); tree.props.onClick(); assert.deepEqual(calls, []);
    assert.equal(tree.props.style.pointerEvents, changes.preview === false ? 'none' : 'auto');
    if (changes.preview === false) assert.equal(tree.props.tabIndex, -1);
  }
  const invalid = DrawingComponent(propsFor(component('equipmentSymbol', { action: 'navigate', targetScreenId: 'details', active: undefined, bindings: { active: binding('missing') } })));
  assert.equal(invalid.type, 'div'); assert.equal(invalid.props.onClick, undefined);
  assert.doesNotMatch(html(component('equipmentSymbol', { action: 'script', script: 'writeTag()' })), /<button|<svg/);
});

test('bad bindings remove flow and active indication instead of displaying authored fallback values', () => {
  for (const [type, target, value] of [['pipe', 'flowing', true], ['pipe', 'strokeWidth', 12], ['pipe', 'color', '#00ff00'], ['equipmentSymbol', 'active', true]]) {
    const item = component(type, { [target]: value, bindings: { [target]: binding('missing') } });
    const markup = boundHtml(item);
    assert.match(markup, /Binding error/); assert.match(markup, /Graphic unavailable/);
    assert.doesNotMatch(markup, /<svg|drawing-active|drawing-pipe-flow/);
  }
});

test('static labels resolve parameters once, bound labels stay literal, and text cannot become markup', () => {
  assert.match(html(component('rectangle', { text: 'Area {area}' }), { parameters: { area: 'North' } }), /Area North/);
  const literal = boundHtml(component('ellipse', { bindings: { text: binding('caption') } }), { parameters: { caption: '{area}', area: 'North' } });
  assert.match(literal, /\{area\}/); assert.doesNotMatch(literal, /North/);
  const malicious = html(component('rectangle', { text: '<svg onload="write()">' }));
  assert.match(malicious, /&lt;svg/); assert.doesNotMatch(malicious, /<svg onload/);
  assert.doesNotMatch(html(component('rectangle', { text: '' })), /drawing-caption/);
});

console.log(`Drawing renderer checks passed (${passed} groups).`);
