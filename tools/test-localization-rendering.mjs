#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = require('esbuild');
const built = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { LocalizationProvider } from './LocalizationContext';
  import { VisualStyleProvider } from './VisualStyleContext';
  import { ProjectComponentView } from './templates';
  export function render(component, catalog, locale, extra = {}) {
    return renderToStaticMarkup(<LocalizationProvider catalog={catalog} locale={locale}><VisualStyleProvider styles={[{id:'card',name:'Card',properties:{fontSize:22}}]}>
      <ProjectComponentView component={component} screenId="home" tags={[]} parameters={{station:'Assembly'}} preview={true} onNavigate={() => {}} {...extra} />
    </VisualStyleProvider></LocalizationProvider>);
  }`, resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' }, jsx: 'automatic', logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { render } = module.exports;
const catalog = { defaultLocale: 'en', locales: ['en', 'es', 'fr'], messages: { note: { en: 'Station {station}', es: 'Estación {station}' }, button: { en: 'Open review', es: 'Abrir revisión' } } };
const component = (props = {}, type = 'textInput') => ({ id: 'note', type, x: 0, y: 0, width: 300, height: 80, props: { text: 'Station {station}', textKey: 'note', fieldKey: 'note', defaultValue: 'BATCH-014', styleId: 'card', ...props } });
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
check('real input caption translates and interpolates while preserving the current user value', () => {
  const html = render(component(), catalog, 'es', { inputs: { note: 'Typed operator note' } });
  assert.match(html, /Estación Assembly/); assert.match(html, /lang="es"/); assert.match(html, /value="Typed operator note"/); assert.match(html, /--component-font-size:22px/); assert.doesNotMatch(html, /Translation unavailable/);
});
check('missing language text displays default language with nonblocking visible note', () => {
  const html = render(component(), catalog, 'fr');
  assert.match(html, /Station Assembly/); assert.match(html, /lang="en"/); assert.match(html, /Translation unavailable for fr; using en/); assert.doesNotMatch(html, /disabled=""|binding-failed/);
});
check('translation content is plain text and cannot insert markup into the component', () => {
  const unsafe = structuredClone(catalog); unsafe.messages.note.es = '<script>{station}</script>';
  const html = render(component(), unsafe, 'es'); assert.match(html, /&lt;script&gt;Assembly&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});
check('missing translation resource uses authored text without exposing current input data in diagnostic', () => {
  const html = render(component(), undefined, 'es', { inputs: { note: 'Private draft value' } });
  assert.match(html, /Caption translation unavailable; using authored text/); assert.match(html, /Station Assembly/); assert.doesNotMatch(html, /title="[^"]*Private draft value/);
});
check('text bindings take precedence and failed bindings remain visible diagnostics', () => {
  const success = render(component({ bindings: { text: { expression: '"Bound caption"', references: {} } } }), catalog, 'fr');
  assert.match(success, /Bound caption/); assert.doesNotMatch(success, /Translation unavailable/);
  const failure = render(component({ bindings: { text: { expression: 'live', references: { live: { kind: 'tag', path: '[default]Absent' } } } } }), catalog, 'es');
  assert.match(failure, /Binding error: text/); assert.match(failure, /disabled=""/); assert.doesNotMatch(failure, /Estación/);
});
check('translation keeps readonly and authored disabled gates intact', () => {
  assert.match(render(component(), catalog, 'es', { readOnly: true }), /disabled=""/);
  assert.match(render(component({ enabled: false }), catalog, 'es'), /disabled=""/);
});
check('translated select caption leaves option labels and submitted values unchanged', () => {
  const html = render(component({ options: [{ label: 'Ready', value: 'ready' }, { label: 'Hold', value: 'hold' }], defaultValue: 'ready' }, 'select'), catalog, 'es', { inputs: { note: 'hold' } });
  assert.match(html, /Estación Assembly/); assert.match(html, /value="ready"/); assert.match(html, />Ready</); assert.match(html, /value="hold" selected=""/); assert.match(html, />Hold</);
});
check('nested template captions inherit the selected language without changing parameters or default values', () => {
  const template = { id: 'card', name: 'Card', width: 320, height: 120, parameters: { station: 'Packing' }, components: [component({ styleId: undefined })] };
  const wrapper = component({ text: 'Outer card', textKey: undefined, templateId: 'card', parameters: { station: 'Packing' }, styleId: undefined }, 'template');
  const html = render(wrapper, catalog, 'es', { templates: [template] }); assert.match(html, /Estación Packing/); assert.match(html, /value="BATCH-014"/); assert.match(html, /lang="es"/);
});
console.log(`${passed} localization renderer groups passed.`);
