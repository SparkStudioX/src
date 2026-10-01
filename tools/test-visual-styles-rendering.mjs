#!/usr/bin/env node
// Render real shared components without a browser; exercises nested composition and existing gates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = require('esbuild');
const built = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { VisualStyleProvider } from './VisualStyleContext';
  import { ProjectComponentView } from './templates';
  export function render(component, styles, extra = {}) {
    return renderToStaticMarkup(<VisualStyleProvider styles={styles}><ProjectComponentView component={component}
      screenId="home" tags={[]} parameters={{}} preview={true} onNavigate={() => {}} {...extra} /></VisualStyleProvider>);
  }`, resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' }, jsx: 'automatic', logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { render } = module.exports;
const style = { id: 'card', name: 'Card', properties: { color: '#345678', foregroundColor: '#abcdef', backgroundColor: '#123456', fontSize: 22, borderWidth: 2, borderColor: '#defabc' } };
const component = (props = {}, type = 'button') => ({ id: 'control', type, x: 0, y: 0, width: 300, height: 70, props: { text: 'Style control', styleId: 'card', action: 'navigate', targetScreenId: 'next', ...props } });
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
check('assigned style reaches real component CSS without changing its label', () => {
  const html = render(component(), [style]);
  assert.match(html, /--component-accent:#345678/); assert.match(html, /background-color:#123456/); assert.match(html, /--component-font-size:22px/); assert.match(html, /Style control/);
});
check('local and expression-bound values override styles in the real wrapper', () => {
  const html = render(component({ backgroundColor: '#111111', bindings: { foregroundColor: { expression: '"#222222"', references: {} } } }), [style]);
  assert.match(html, /background-color:#111111/); assert.match(html, /--component-text-color:#222222/); assert.doesNotMatch(html, /--component-text-color:#abcdef/);
});
check('native input schemes follow authored, styled, bound and inherited opaque backgrounds', () => {
  for (const [backgroundColor, scheme] of [['#ffffff', 'light'], ['#fff', 'light'], ['#ffffffff', 'light'], ['#111722', 'dark'], ['#000f', 'dark']]) {
    const html = render(component({ backgroundColor, fieldKey: 'note', defaultValue: '' }, 'textInput'), [style]);
    assert.match(html, new RegExp(`color-scheme:${scheme}`));
    assert.match(html, /value=""/);
  }
  assert.match(render(component({ fieldKey: 'note' }, 'textInput'), [style]), /color-scheme:dark/);
  assert.match(render(component({ fieldKey: 'note', bindings: { backgroundColor: { expression: '"#ffffff"', references: {} } } }, 'textInput'), [style]), /color-scheme:light/);
  for (const backgroundColor of [undefined, '#ffffff80', '#fff0']) {
    const html = render(component({ styleId: undefined, backgroundColor, fieldKey: 'note' }, 'textInput'), []);
    assert.doesNotMatch(html, /color-scheme:/, 'unconfigured and translucent controls inherit their surrounding theme');
  }
  const leaf = component({ styleId: undefined, fieldKey: 'note' }, 'textInput');
  const template = { id: 'light-form', name: 'Light form', width: 320, height: 100, parameters: {}, components: [leaf] };
  assert.match(render(component({ styleId: undefined, backgroundColor: '#fff', templateId: template.id }, 'template'), [], { templates: [template] }), /color-scheme:light/);
});
check('read-only and explicit disabled inputs stay disabled with an assigned style', () => {
  for (const extra of [{ readOnly: true }, { interactionLocked: true }]) assert.match(render(component({}, 'textInput'), [style], extra), /disabled=""/);
  assert.match(render(component({ enabled: false }), [style]), /aria-disabled="true"/);
});
check('missing and invalid styles are visible diagnostics with interaction locked', () => {
  for (const styles of [[], [{ ...style, properties: { visible: false } }]]) {
    const html = render(component({ visible: false }), styles);
    assert.match(html, /binding-failed/); assert.match(html, /Binding error: style/); assert.match(html, /aria-disabled="true"/); assert.doesNotMatch(html, /hidden=""/);
  }
});
check('failed color bindings retain an actionable diagnostic above an assigned style', () => {
  const html = render(component({ bindings: { color: { expression: 'live', references: { live: { kind: 'tag', path: '[default]Missing' } } } } }), [style]);
  assert.match(html, /Binding error: color/); assert.match(html, /aria-disabled="true"/); assert.doesNotMatch(html, /--component-accent:#345678/);
});
check('a styled nested template wrapper passes appearance through to its input child', () => {
  const leaf = { ...component({ styleId: undefined, text: 'Nested note', fieldKey: 'note', defaultValue: 'Independent draft' }, 'textInput'), width: 220, height: 70 };
  const inner = { id: 'inner', name: 'Inner', width: 240, height: 100, parameters: {}, components: [leaf] };
  const nested = { ...component({ styleId: undefined, text: 'Inner instance', templateId: 'inner' }, 'template'), width: 240, height: 100 };
  const outer = { id: 'outer', name: 'Outer', width: 260, height: 120, parameters: {}, components: [nested] };
  const html = render({ ...component({ templateId: 'outer' }, 'template'), width: 260, height: 120 }, [style], { templates: [inner, outer] });
  assert.match(html, /Nested note/); assert.match(html, /value="Independent draft"/); assert.match(html, /--component-font-size:22px/); assert.match(html, /--component-text-color:#abcdef/);
  assert.doesNotMatch(html, /Binding error/);
});
check('an invalid styled wrapper locks nested inputs and discloses its style failure', () => {
  const template = { id: 'form', name: 'Form', width: 300, height: 120, parameters: {}, components: [component({ styleId: undefined, fieldKey: 'note' }, 'textInput')] };
  const html = render(component({ templateId: 'form' }, 'template'), [], { templates: [template] });
  assert.match(html, /Binding error: style/); assert.match(html, /disabled=""/); assert.match(html, /aria-disabled="true"/);
});
console.log(`${passed} visual-style renderer groups passed.`);
