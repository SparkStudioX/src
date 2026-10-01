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
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
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
const { ProjectComponentView, instanceInputKey, projectComponentPropsEqual } = await import(moduleUrl('templates'));
const { ApplicationStateProvider } = await import(moduleUrl('applicationState'));
const { AuthProvider } = await import(moduleUrl('Auth'));
const { ApplicationStateStore } = await import(moduleUrl('applicationStateModel'));
const component = (id, type, props) => ({ id, type, x: 0, y: 0, width: 240, height: 80, props });
const binding = (expression, references = {}) => ({ expression, references });
const button = component('apply', 'button', { text: 'Apply', action: 'script', script: 'result = inputs', customProperties: { minimum: { type: 'number', value: 2 } }, bindings: {
  enabled: binding('quantity > minimum', { quantity: { kind: 'input', key: 'quantity' }, minimum: { kind: 'custom', key: 'minimum' } }),
} });
const render = (c, overrides = {}) => renderToStaticMarkup(React.createElement(BoundComponent, { component: c, components: [c], inputs: { quantity: 3 }, tags: [], parameters: {}, preview: true, onNavigate() {}, ...overrides }));
let passed = 0;
function check(name, run) { run(); console.log(`PASS ${name}`); passed++; }
check('gateway command, alarm and history controls dispatch without a direct tag binding', () => {
  for (const [type, marker] of [['equipmentCommand', /class="equipment-command/], ['alarmStatusTable', /class="process-data-component/], ['alarmJournalTable', /class="process-data-component/], ['historicalTrend', /class="historical-series/]]) {
    const c = component('integration', type, { text: type, commandId: 'setpoint', historyPaths: ['[default]Test/Temperature'] });
    const html = renderToStaticMarkup(React.createElement(AuthProvider, { audience: 'operator', projectId: 'workshop' }, React.createElement(BoundComponent, { component: c, components: [c], parameters: {}, tags: [], preview: true, queryScope: 'runtime', publishedAt: '2026-09-30T10:00:00Z', onNavigate() {} })));
    assert.match(html, marker); assert.doesNotMatch(html, /No tag binding|Tag not found/);
  }
});
check('tile memoization ignores unrelated tag ticks but honors removed props and relevant changes', () => {
  const linked = component('reading', 'value', { tagPath: '[default]Used' });
  const used = {path: '[default]Used', value: 1}, other = {path: '[default]Other', value: 1};
  const previous = {component: linked, tags: [used, other], parameters: {}, templates: [], onNavigate() {}};
  assert.equal(projectComponentPropsEqual(previous, {...previous, tags: [used, {...other, value: 2}]}), true);
  assert.equal(projectComponentPropsEqual(previous, {...previous, tags: [{...used, value: 2}, other]}), false);
  assert.equal(projectComponentPropsEqual({...previous, communicationLost: true}, previous), false);
  assert.equal(projectComponentPropsEqual({...previous, readOnly: true}, previous), false);
});
check('tile memoization follows transitive sibling custom bindings and removed indirect tag samples', () => {
  const source = component('source', 'label', { customProperties: { reading: { type: 'number', value: 0 } }, bindings: {
    'customProperties.reading.value': binding('tag', { tag: { kind: 'tag', path: '[default]{machine}/Reading' } }),
  } });
  const middle = component('middle', 'label', { customProperties: { doubled: { type: 'number', value: 0 } }, bindings: {
    'customProperties.doubled.value': binding('reading * 2', { reading: { kind: 'custom', componentId: 'source', key: 'reading' } }),
  } });
  const sink = component('sink', 'label', { bindings: { text: binding('reading', { reading: { kind: 'custom', componentId: 'middle', key: 'doubled' } }) } });
  const used = { path: '[default]Press01/Reading', value: 1, quality: 'Good' }, unrelated = { path: '[default]Other', value: 1, quality: 'Good' };
  const previous = { component: sink, components: [source, middle, sink], tags: [used, unrelated], parameters: { machine: 'Press01' }, templates: [], onNavigate() {} };
  assert.equal(projectComponentPropsEqual(previous, { ...previous, tags: [{ ...used, value: 2 }, unrelated] }), false);
  assert.equal(projectComponentPropsEqual(previous, { ...previous, tags: [used, { ...unrelated, value: 2 }] }), true);
  assert.equal(projectComponentPropsEqual(previous, { ...previous, tags: [unrelated] }), false);
  assert.equal(projectComponentPropsEqual(previous, { ...previous, tags: [{ ...used, quality: 'Bad' }, unrelated] }), false);
});
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
check('hidden project controls retain a marker through the render boundary and design keeps its selection target', () => {
  for (const type of ['image', 'button', 'textInput']) {
    const hidden = component('hidden-' + type, type, { text: 'Hidden ' + type, visible: false, assetId: 'a'.repeat(64), fieldKey: 'name', defaultValue: '' });
    const props = { component: hidden, components: [hidden], templates: [], screenId: 'main', tags: [], parameters: {}, preview: true, onNavigate() {} };
    const runtime = renderToStaticMarkup(React.createElement(ProjectComponentView, props));
    assert.match(runtime, /^<div class="render-boundary-contents"><span class="bound-component-hidden" hidden=""><\/span><\/div>$/);
    assert.doesNotMatch(runtime, /<img|<button|<input|tabindex=/);
    const design = renderToStaticMarkup(React.createElement(ProjectComponentView, { ...props, preview: false }));
    assert.match(design, /design-hidden/); assert.match(design, /Hidden in runtime/);
    assert.doesNotMatch(design, /class="bound-component-hidden" hidden=/);
  }
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
  function Probe() {
    let element = ProjectComponentView(wrapperProps(wrapper, overrides));
    // Peel the tile error boundary and memoized wrapper while React owns hooks.
    element = element.props.children;
    if (typeof element.type === 'object' && element.type.type) element = element.type.type(element.props);
    captured = element.type(element.props); return null;
  }
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
check('runtime property workshop renders bound chart, supplied table and containers without query infrastructure', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../../examples/runtime-property-bindings.json', import.meta.url), 'utf8'));
  const document = fixture.screens[0];
  const store = new ApplicationStateStore(); store.configure('runtime-workshop', fixture.sessionState);
  const owner = store.activateScreen(document.id, document.state);
  const html = renderToStaticMarkup(React.createElement(ApplicationStateProvider, { value: { ...store.context(owner), store } },
    document.components.map(component => React.createElement(ProjectComponentView, { key: component.id, component, components: document.components,
      templates: fixture.templates, screenId: document.id, tags: [], parameters: {}, preview: true, onNavigate() {} }))));
  assert.doesNotMatch(html, /component-binding-error|Binding error:|Choose a named query|No named query/);
  assert.match(html, />42</); assert.match(html, />63</);
  assert.match(html, /view-container-split/);
});
check('image and icon bound alternate text remains literal', () => {
  for (const type of ['image', 'icon']) {
    const html = render(component('media', type, { assetId: 'a'.repeat(64), icon: 'spark', bindings: { alt: binding('"{station}"') } }), { parameters: { station: 'replaced' } });
    assert.match(html, /(?:alt|aria-label)="\{station\}"/);
    assert.doesNotMatch(html, /(?:alt|aria-label)="replaced"/);
  }
});
check('generated images use same-origin blobs and empty sources retain stored-asset rendering', () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'http://127.0.0.1:6090' } };
    const url = 'blob:http://127.0.0.1:6090/visitor-badge';
    const image = component('badge', 'image', { imageUrl: url, assetId: 'a'.repeat(64), fit: 'contain', alt: 'Visitor badge' });
    const html = render(image);
    assert.match(html, /src="blob:http:\/\/127\.0\.0\.1:6090\/visitor-badge"/);
    assert.match(html, /alt="Visitor badge"/); assert.doesNotMatch(html, /assets\//);
    image.props.imageUrl = '';
    assert.match(render(image), /src="[^\"]*\/assets\/a{64}"/);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
check('invalid generated image sources never request a remote URL or reuse a stored fallback', () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'http://127.0.0.1:6090' } };
    const image = component('badge', 'image', { assetId: 'a'.repeat(64) });
    for (const imageUrl of ['https://example.com/badge.png', 'blob:http://127.0.0.1:5090/badge', 'data:image/png;base64,AA==']) {
      image.props.imageUrl = imageUrl;
      const html = render(image);
      assert.doesNotMatch(html, /<img|assets\//); assert.match(html, /local browser blob URL/);
    }
    image.props.imageUrl = '';
    image.props.bindings = { imageUrl: binding('"https://example.com/badge.png"') };
    const html = render(image);
    assert.match(html, /Binding error: imageUrl/); assert.doesNotMatch(html, /<img|assets\//);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
check('supplied table data renders and malformed binding is diagnosed', () => {
  const data = { columns: ['station'], rows: [{ station: 'Live cell' }] };
  const c = component('data-table', 'table', { data, bindings: { data: binding(JSON.stringify(JSON.stringify(data))) } });
  assert.match(render(c), /Live cell/);
  c.props.bindings.data = binding('"bad json"');
  assert.match(render(c), /Binding error:/);
});
check('bound chart data overrides an authored query source and a failed binding never falls back', () => {
  const live = { columns: ['station', 'count'], rows: [{ station: 'Bound station', count: 42 }] };
  const c = component('chart-data', 'chart', { chart: { kind: 'line', xKey: 'station', series: [{ key: 'count' }] },
    dataSource: { queryId: 'unused-authored-query' }, data: { columns: ['station', 'count'], rows: [{ station: 'Authored fallback', count: 999 }] },
    bindings: { data: binding(JSON.stringify(JSON.stringify(live))) } });
  const html = render(c);
  assert.match(html, /Bound station/); assert.doesNotMatch(html, /Authored fallback|Loading dataset|Dataset is loading/);
  c.props.bindings.data = binding('"invalid json"');
  const failed = render(c); assert.match(failed, /Binding error:/); assert.doesNotMatch(failed, /Authored fallback|Bound station/);
});
console.log(`${passed} bound-component renderer checks passed.`);
