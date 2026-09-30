import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render real components and their binding evaluator, without a DOM or gateway.
const require = createRequire(import.meta.url), modules = new Map();
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
  assert.ok(filename, name);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (full, prefix, quote, dependency) => {
      const url = dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href;
      return `${prefix}${JSON.stringify(url)}`;
    });
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  modules.set(name, url); return url;
}
const { default: BoundComponent } = await import(moduleUrl('BoundComponent'));
const { ProjectComponentView, instanceInputKey } = await import(moduleUrl('templates'));
const { ApplicationStateProvider } = await import(moduleUrl('applicationState'));
const { ApplicationStateStore } = await import(moduleUrl('applicationStateModel'));
const component = (id, type, props) => ({ id, type, x: 0, y: 0, width: 240, height: 80, props });
const binding = (expression, references = {}) => ({ expression, references });
const button = component('apply', 'button', { text: 'Apply', action: 'script', script: 'result = inputs', customProperties: { minimum: { type: 'number', value: 2 } }, bindings: {
  enabled: binding('quantity > minimum', { quantity: { kind: 'input', key: 'quantity' }, minimum: { kind: 'custom', key: 'minimum' } }),
} });
const render = (c, overrides = {}) => renderToStaticMarkup(React.createElement(BoundComponent, { component: c, components: [c], inputs: { quantity: 3 }, tags: [], parameters: {}, preview: true, onNavigate() {}, ...overrides }));
let passed = 0;
function check(name, run) { run(); console.log(`PASS ${name}`); passed++; }
check('bound Enabled controls native button state', () => {
  assert.doesNotMatch(render(button), /disabled=""/);
  assert.match(render(button, { inputs: { quantity: 0 } }), /disabled=""/);
  assert.match(render(button, { inputs: { quantity: 0 } }), /inert=""/);
});
check('hidden runtime controls expose no focus or click target but stay editable in Design', () => {
  const hidden = structuredClone(button); hidden.props.bindings.visible = binding('false');
  assert.match(render(hidden), /class="bound-component-hidden" hidden=""/);
  assert.doesNotMatch(render(hidden), /<button/);
  assert.match(render(hidden, { preview: false }), /Hidden in runtime/);
  assert.match(render(hidden, { preview: false }), /Apply/);
});
check('bad tag quality and lost communication show an error and disable action controls', () => {
  const tagButton = structuredClone(button);
  tagButton.props.bindings.enabled = binding('permit', { permit: { kind: 'tag', path: '[default]Permit' } });
  for (const extra of [{ tags: [] }, { tags: [{ path: '[default]Permit', value: true, quality: 'Bad' }] }, { tags: [{ path: '[default]Permit', value: true, quality: 'Good' }], communicationLost: true }]) {
    const html = render(tagButton, extra); assert.match(html, /Binding error: enabled/); assert.match(html, /disabled=""/);
  }
});
check('binding failure cannot hide its diagnostic', () => {
  const bad = structuredClone(button); bad.props.bindings.visible = binding('false'); bad.props.bindings.enabled = binding('missing', { missing: { kind: 'input', key: 'missing' } });
  assert.match(render(bad), /Binding error: enabled/); assert.match(render(bad), /disabled=""/);
});
check('bound text is not parameter-substituted a second time', () => {
  const label = component('label', 'label', { bindings: { text: binding('literal', { literal: { kind: 'parameter', key: 'text' } }) } });
  assert.match(render(label, { parameters: { text: '{other}', other: 'incorrect substitution' } }), />\{other\}</);
  assert.doesNotMatch(render(label, { parameters: { text: '{other}', other: 'incorrect substitution' } }), /incorrect substitution/);
});
check('bound colors override component accent and direct label color', () => {
  const label = component('label', 'label', { text: 'Colored', color: '#000000', bindings: { color: binding('"#ab1234"') } });
  const html = render(label); assert.match(html, /--component-accent:#ab1234/); assert.match(html, /color:#ab1234/);
});
check('empty text expressions remain empty rather than becoming placeholder captions', () => {
  for (const [type, placeholder] of [['label', 'Text'], ['button', 'Button'], ['table', 'Data table'], ['gauge', 'Process value'], ['value', 'Live value'], ['checkbox', 'Check box']]) {
    const c = component('empty', type, { fieldKey: 'empty', bindings: { text: binding('""') } });
    assert.doesNotMatch(render(c), new RegExp(`>${placeholder}<`));
  }
});
check('input controls and tables inherit explicit disabled state', () => {
  const input = component('quantity', 'numberInput', { fieldKey: 'quantity', enabled: false });
  assert.match(render(input), /disabled=""/);
  const table = component('table', 'table', { text: 'Orders', enabled: false });
  assert.match(render(table), /inert=""/);
});
check('template instances resolve bindings against their own independent form inputs', () => {
  const template = { id: 'form', name: 'Form', width: 300, height: 200, parameters: {}, components: [component('quantity', 'spinner', { fieldKey: 'quantity', min: 0, max: 100, defaultValue: 0 }), button] };
  const scopedInputs = { [instanceInputKey('screen', 'first')]: { quantity: 4 }, [instanceInputKey('screen', 'second')]: { quantity: 0 } };
  const views = ['first', 'second'].map(id => React.createElement(ProjectComponentView, { key: id, component: component(id, 'template', { templateId: 'form' }), screenId: 'screen', templates: [template], parameters: {}, tags: [], preview: true, scopedInputs, onNavigate() {} }));
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, views));
  assert.equal((html.match(/class="render-button"[^>]*disabled=""/g) || []).length, 1);
  assert.equal((html.match(/class="render-button"/g) || []).length, 2);
});
const formTemplate = { id: 'form', name: 'Form', width: 300, height: 200, parameters: { title: 'Row title' }, components: [
  component('entry', 'textInput', { fieldKey: 'note', defaultValue: '' }),
  component('script', 'button', { text: 'Run', action: 'script', script: 'result = inputs' }),
  component('popup', 'button', { text: 'Open', action: 'openPopup', targetScreenId: 'detail' }),
  component('navigation', 'button', { text: 'Navigate', action: 'navigate', targetScreenId: 'other' }),
  component('close', 'button', { text: 'Close', action: 'closePopup' }),
] };
const wrapperProps = (wrapper, overrides = {}) => ({ component: wrapper, components: [wrapper], screenId: 'screen', templates: [formTemplate],
  parameters: { title: 'Parent title' }, tags: [], inputs: {}, preview: true, onNavigate() {}, ...overrides });
const renderWrapper = (wrapper, overrides) => renderToStaticMarkup(React.createElement(ProjectComponentView, wrapperProps(wrapper, overrides)));
const frame = (wrapper, overrides) => {
  // Inspect the returned frame inside React's renderer so its context hook runs
  // with the same default provider context as the full markup checks above.
  let captured;
  function Probe() { const element = ProjectComponentView(wrapperProps(wrapper, overrides)); captured = element.type(element.props); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return captured;
};
function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child => descendants(child, predicate))];
}
const instanceHost = wrapperFrame => descendants(wrapperFrame, node => typeof node.type === 'function' && node.type.name === 'TemplateInstances')[0];
check('wrapper enabled evaluates parent inputs and locks every child control in each row', () => {
  const wrapper = component('wrapper', 'repeater', { templateId: 'form', rows: [{ id: 'a', parameters: {} }, { id: 'b', parameters: {} }], bindings: {
    enabled: binding('permit', { permit: { kind: 'input', key: 'permit' } }),
  } });
  const scopedInputs = { [instanceInputKey('screen', 'wrapper', 'a')]: { permit: true }, [instanceInputKey('screen', 'wrapper', 'b')]: { permit: true } };
  const locked = renderWrapper(wrapper, { inputs: { permit: false }, scopedInputs });
  assert.equal((locked.match(/<button[^>]*disabled=""/g) || []).length, 8);
  assert.equal((locked.match(/<input[^>]*disabled=""/g) || []).length, 2);
  assert.match(locked, /inert=""/);
  const active = renderWrapper(wrapper, { inputs: { permit: true }, scopedInputs });
  assert.doesNotMatch(active, /disabled=""/);
});
check('wrapper callbacks deny script, popup, navigation, close and input changes while disabled', () => {
  const wrapper = component('wrapper', 'template', { templateId: 'form', enabled: false });
  const calls = [], handlers = Object.fromEntries(['onAction', 'onOpenPopup', 'onNavigate', 'onClosePopup', 'onScopedInputChange'].map(name => [name, (...args) => calls.push([name, ...args])]));
  let host = instanceHost(frame(wrapper, handlers));
  for (const name of Object.keys(handlers)) host.props[name]('value');
  assert.deepEqual(calls, []); assert.equal(host.props.interactionLocked, true);
  wrapper.props.enabled = true; host = instanceHost(frame(wrapper, handlers));
  for (const name of Object.keys(handlers)) host.props[name]('value');
  assert.equal(calls.length, 5);
});
check('hidden wrappers keep their forms mounted but inert, and remain visible in authoring', () => {
  const wrapper = component('wrapper', 'template', { templateId: 'form', visible: false });
  const runtime = frame(wrapper); assert.equal(runtime.props.hidden, true); assert.match(runtime.props.className, /bound-component-hidden/);
  assert.equal(instanceHost(runtime).props.interactionLocked, true);
  assert.match(renderWrapper(wrapper), /<input[^>]*disabled=""/);
  const design = frame(wrapper, { preview: false }); assert.equal(design.props.hidden, false);
  assert.match(renderWrapper(wrapper, { preview: false }), /Hidden in runtime/);
});
check('wrapper binding failure stays visible and locks children even with visible false', () => {
  const wrapper = component('wrapper', 'template', { templateId: 'form', visible: false, bindings: { width: binding('missing', { missing: { kind: 'input', key: 'missing' } }) } });
  const view = frame(wrapper); assert.equal(view.props.hidden, false);
  assert.equal(instanceHost(view).props.interactionLocked, true);
  const html = renderWrapper(wrapper); assert.match(html, /Binding error: width/); assert.match(html, /disabled=""/);
});
check('wrapper geometry and accessible caption bind in parent context without rebinding child parameters', () => {
  const wrapper = component('wrapper', 'template', { templateId: 'form', parameters: { title: 'Instance title' }, bindings: {
    width: binding('size', { size: { kind: 'input', key: 'size' } }),
    height: binding('150'), x: binding('64'), y: binding('32'),
    text: binding('caption', { caption: { kind: 'parameter', key: 'title' } }),
  } });
  const extra = { inputs: { size: 500 }, parameters: { title: '{literal}', literal: 'Wrong' } };
  const runtime = frame(wrapper, extra); assert.equal(runtime.props['aria-label'], '{literal}');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => instanceHost(runtime).props.component[key]), [64, 32, 500, 150]);
  assert.deepEqual(instanceHost(runtime).props.component.props.parameters, { title: 'Instance title' });
  const design = frame(wrapper, { ...extra, preview: false });
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => instanceHost(design).props.component[key]), [0, 0, 240, 80]);
});
check('wrapper appearance supplies child defaults while explicit child appearance wins', () => {
  const wrapper = component('wrapper', 'template', { templateId: 'form', backgroundColor: '#112233', foregroundColor: '#abcdef', fontSize: 22, color: '#cc1122', borderColor: '#fedcba', borderWidth: 3 });
  const templates = [{ ...formTemplate, components: [component('plain', 'label', { text: 'Plain', fontSize: undefined, foregroundColor: undefined, backgroundColor: undefined }), component('explicit', 'label', { text: 'Own', color: '#ff00ff', backgroundColor: '#334455', fontSize: 17 }), component('bound', 'label', { text: 'Bound', bindings: { foregroundColor: binding('"#667788"') } })] }];
  const html = renderWrapper(wrapper, { templates });
  assert.match(html, /--template-background:#112233/); assert.match(html, /border-color:#fedcba;border-width:3px/);
  const componentStyle = (markup, id) => {
    const element = [...markup.matchAll(/<div\b[^>]*>/g)].map(match => match[0])
      .find(tag => tag.includes(`data-component-id="${id}"`) && /class="bound-component(?: |")/.test(tag));
    assert.ok(element, `Rendered bound component ${id}`);
    return element.match(/\bstyle="([^"]*)"/)?.[1] ?? '';
  };
  const style = id => componentStyle(html, id);
  assert.match(style('plain'), /--component-text-color:#abcdef/); assert.match(style('plain'), /--component-font-size:22px/);
  assert.match(style('explicit'), /--component-background:#334455/); assert.match(style('explicit'), /--component-accent:#ff00ff/);
  assert.match(style('explicit'), /--component-font-size:17px/); assert.doesNotMatch(style('explicit'), /--component-text-color/);
  assert.match(style('bound'), /--component-text-color:#667788/);
  const unstyled = renderWrapper(component('wrapper', 'template', { templateId: 'form' }), { templates });
  const plainStyle = componentStyle(unstyled, 'plain');
  assert.doesNotMatch(plainStyle, /--component-(text-color|background|font-size)/);
});
check('viewer mode locks inputs and gateway actions while preserving navigation and popup controls', () => {
  for (const type of ['textInput', 'numberInput', 'checkbox', 'select', 'list', 'treeView', 'spinner', 'slider', 'multiStateButton']) {
    const input = component('input', type, { fieldKey: 'value', defaultValue: type === 'checkbox' ? false : type === 'list' || type === 'treeView' || type === 'select' || type === 'multiStateButton' ? 'a' : 0,
      options: [{ value: 'a', label: 'A' }], states: [{ value: 'a', label: 'A', color: '#112233' }] });
    assert.match(render(input, { readOnly: true }), /(?:disabled=""|aria-disabled="true")/);
  }
  assert.match(render(button, { readOnly: true }), /disabled=""/);
  for (const action of ['navigate', 'openPopup', 'closePopup']) {
    assert.doesNotMatch(render(component(action, 'button', { text: action, action, targetScreenId: 'detail' }), { readOnly: true }), /disabled=""/);
  }
});
check('viewer mode reaches template leaves without disabling their navigation', () => {
  const html = renderWrapper(component('wrapper', 'template', { templateId: 'form' }), { readOnly: true });
  assert.match(html, /<input[^>]*disabled=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Run/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Open/);
});
check('authored interaction workshop renders every state binding without diagnostics', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../examples/component-interactions.json', import.meta.url), 'utf8'));
  const document = fixture.screens[0];
  const store = new ApplicationStateStore(); store.configure('interaction-workshop', {});
  const owner = store.activateScreen(document.id, document.state);
  const html = renderToStaticMarkup(React.createElement(ApplicationStateProvider, { value: { ...store.context(owner), store } },
    document.components.map(component => React.createElement(ProjectComponentView, { key: component.id, component, components: document.components,
      templates: fixture.templates, screenId: document.id, tags: [], parameters: {}, preview: true, onNavigate() {} }))));
  assert.doesNotMatch(html, /component-binding-error|Binding error:/);
  assert.match(html, /Focus the station note/); assert.match(html, /No key yet/);
  assert.match(html, /data-component-id="masked-status"/); assert.match(html, /Redacted Python key releases:/);
});
console.log(`${passed} bound-component renderer checks passed.`);
