import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const hookUrl = asModule(`let values=[],index=0,effects=[];
export const begin=()=>{index=0;};export const clear=()=>{values=[];index=0;effects=[];};
export const useState=initial=>{const at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};
export const useId=()=>'chart-editor';export const useEffect=(run,deps)=>{const at=index++,previous=values[at];if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))){values[at]=deps;effects.push(run);}};
export const flush=()=>{const pending=effects.splice(0);pending.forEach(run=>run());return pending.length;};`);
const modules = new Map();
function url(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_match, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' ? hookUrl : dependency.startsWith('./') ? url(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = asModule(code); modules.set(name, result); return result;
}
const hooks = await import(hookUrl), { default: ChartProperties } = await import(url('ChartProperties'));
const { defaultChartProps, chartKinds } = await import(url('chartModel'));
const { checkpoint, restoreHistory } = await import(url('canvasEditing'));
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const make = () => ({ id: 'plot', type: 'chart', x: 0, y: 0, width: 640, height: 400, props: defaultChartProps() });
function drive(component = make(), onChange = () => {}) {
  hooks.clear(); const patches = [], props = { component, onChange: patch => { patches.push(patch); onChange(patch); } }; let tree;
  const expand = node => !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: React.Children.toArray(node.props?.children).map(expand) } };
  function refresh() { let iterations = 0; do { assert.ok(iterations++ < 5); hooks.begin(); tree = expand(React.createElement(ChartProperties, props)); } while (hooks.flush()); }
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected chart authoring control'); return node; };
  const field = name => find(node => node.props?.id === `chart-editor-${name}` || node.props?.['aria-label'] === name);
  const change = (name, value) => { field(name).props.onChange({ target: { value, checked: value } }); refresh(); };
  const click = label => { find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === label).props.onClick(); refresh(); };
  const apply = () => click('Apply chart');
  refresh(); return { props, patches, refresh, find, field, change, apply, click, all: () => nodes(tree) };
}
let checks = 0; const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check('chart types and structured collections live in consistent three-cell property rows', () => {
  const ui = drive(); assert.deepEqual(nodes(ui.field('kind')).filter(node => node.type === 'option').map(node => node.props.value), chartKinds);
  for (const row of ui.all().filter(node => node.props?.['data-property']?.startsWith('chart.'))) {
    assert.equal(row.props.className, 'property-sheet-row'); const cells = React.Children.toArray(row.props.children); assert.equal(cells.length, 3); assert.equal(cells[1].props.className, 'property-sheet-value');
  }
  for (const property of ['series', 'data']) { const row = ui.find(node => node.props?.['data-property'] === `chart.${property}`); assert.ok(nodes(row).some(node => node.type === 'details')); }
});
check('chart configuration stages edits until one validated Apply without replacing the query binding', () => {
  const component = make(), before = structuredClone(component); component.props.dataSource = { queryId: 'live' };
  const ui = drive(component); ui.change('kind', 'bar'); ui.change('legend', false); ui.change('range', true); ui.change('min', '-5'); ui.change('max', '100');
  assert.deepEqual(ui.patches, []); ui.apply(); assert.equal(ui.patches.length, 1); assert.deepEqual(Object.keys(ui.patches[0]).sort(), ['chart', 'data']);
  assert.equal(ui.patches[0].chart.kind, 'bar'); assert.equal(ui.patches[0].chart.yMin, -5); assert.equal(ui.patches[0].chart.rangeSelector, true); assert.equal(ui.patches[0].chart.showLegend, false);
  assert.deepEqual(component.props.chart, before.props.chart); assert.deepEqual(component.props.dataSource, { queryId: 'live' });
});
check('invalid ranges, malformed series and missing columns keep drafts local with an error', () => {
  const ui = drive(); ui.change('min', '20'); ui.change('max', '10'); ui.apply(); assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
  ui.change('min', ''); ui.change('max', ''); ui.change('Chart series', '{'); ui.apply(); assert.deepEqual(ui.patches, []);
  ui.change('Chart series', '[{"key":"missing"}]'); ui.apply(); assert.deepEqual(ui.patches, []);
  ui.change('Chart series', '[{"key":"produced"}]'); ui.apply(); assert.equal(ui.patches.length, 1);
});
check('Gantt authoring requires an explicit finish column and matching saved data', () => {
  const ui = drive(); ui.change('kind', 'gantt'); ui.apply(); assert.deepEqual(ui.patches, []);
  ui.change('x', 'start'); ui.change('end', 'finish'); ui.change('Chart series', '[{"key":"value"}]');
  ui.change('Chart dataset', JSON.stringify({ columns: ['start', 'finish', 'value'], rows: [{ start: 0, finish: 1000, value: 1 }] })); ui.apply();
  assert.equal(ui.patches.length, 1); assert.equal(ui.patches[0].chart.endKey, 'finish');
});
check('saved component replacement clears an abandoned chart draft before it can Apply', () => {
  const ui = drive(); ui.change('kind', 'pie'); ui.change('Chart series', '{');
  ui.props.component = { ...make(), id: 'replacement' }; ui.refresh(); assert.equal(ui.field('kind').props.value, 'line');
  ui.apply(); assert.equal(ui.patches[0].chart.kind, 'line'); assert.equal(ui.patches[0].chart.series.length, 2);
});
check('malformed saved datasets cannot Apply even while a named query supplies runtime data', () => {
  for (const bound of [false, true]) {
    const component = make(); if (bound) component.props.dataSource = { queryId: 'live' };
    const ui = drive(component);
    for (const data of [{ columns: ['hour'], rows: [{ hour: '08:00', extra: 1 }] }, { columns: ['hour'], rows: [{}] }, { columns: ['hour'], rows: [{ hour: {} }] }, { columns: ['hour', 'hour'], rows: [] }]) {
      ui.change('Chart dataset', JSON.stringify(data)); ui.apply(); assert.deepEqual(ui.patches, []); assert.ok(ui.all().some(node => node.props?.role === 'alert'));
    }
    ui.click('Cancel'); assert.deepEqual(ui.patches, []); ui.apply(); assert.equal(ui.patches.length, 1);
  }
});
check('Cancel discards structured and scalar drafts while Apply supports one normal Undo/Redo history entry', () => {
  const component = make(), original = { id: 'project', name: 'P', revision: 1, parameters: {}, screens: [{ id: 'main', components: [component] }] };
  let project = structuredClone(original), history = { past: [], future: [] };
  const ui = drive(component, patch => { history = checkpoint(history, project); project = { ...project, screens: [{ ...project.screens[0], components: [{ ...component, props: { ...component.props, ...patch } }] }] }; });
  ui.change('kind', 'bar'); ui.change('Chart dataset', '{'); ui.click('Cancel'); assert.equal(ui.field('kind').props.value, 'line'); assert.deepEqual(ui.patches, []); assert.deepEqual(history.past, []);
  ui.change('kind', 'bar'); ui.apply(); assert.equal(history.past.length, 1); const undo = restoreHistory(history, project, 'undo'); assert.deepEqual(undo.project, original); assert.deepEqual(restoreHistory(undo.history, undo.project, 'redo').project, project);
});
console.log(`${checks} chart authoring checks passed.`);
