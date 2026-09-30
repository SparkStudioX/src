import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url), cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = ['ts', 'tsx'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file));
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dep) => prefix + JSON.stringify(dep.startsWith('./') ? load(dep.slice(2)) : pathToFileURL(require.resolve(dep)).href));
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; cache.set(name, url); return url;
}
const { TagSnapshotStore, tagDependencyPaths, validateTagDelta } = await import(load('tagStore'));
const { validateApiPayload, tagByPath } = await import(load('api'));
const { checkpoint, restoreHistory } = await import(load('canvasEditing'));
const { runtimeText } = await import(load('runtimeText'));
let checks = 0;
const check = (name, run) => { run(); console.log(`PASS ${name}`); checks++; };
const sample = (path, value = 1) => ({ path, value, quality: 'Good', timestamp: '2026-09-30T10:00:00Z', dataType: 'number', source: 'memory' });
const project = { id: 'test', name: 'Test', revision: 1, parameters: {}, screens: [{ id: 'main', name: 'Main', width: 800, height: 600, components: [{ id: 'label', type: 'label', x: 0, y: 0, width: 100, height: 50, props: {} }] }] };
check('tag snapshots preserve immutable identities and suppress unchanged frames', () => {
  const store = new TagSnapshotStore(); let updates = 0; store.subscribe(null, () => updates++);
  store.replace([sample('a'), sample('b')]); const first = store.values(); store.replace(structuredClone(first)); assert.equal(store.values(), first); assert.equal(updates, 1);
  store.delta({ upserts: [sample('b', 2)], removed: [] }); assert.equal(store.get('a'), first[0]); assert.equal(updates, 2);
});
check('only affected path subscribers wake; removals and catalog changes propagate', () => {
  const store = new TagSnapshotStore(); let a = 0, b = 0, catalog = 0; store.subscribe(new Set(['a']), () => a++); const stop = store.subscribe(new Set(['b']), () => b++); store.subscribeCatalog(() => catalog++);
  store.replace([sample('a'), sample('b')]); store.delta({ upserts: [sample('b', 2)], removed: [] }); assert.deepEqual([a, b, catalog], [1, 2, 1]);
  store.delta({ upserts: [], removed: ['a'] }); assert.deepEqual([a, b, catalog], [2, 2, 2]); stop(); store.replace([sample('b', 3)]); assert.equal(b, 2);
});
check('malformed, duplicate and conflicting tag frames cannot partially mutate state', () => {
  const store = new TagSnapshotStore(); store.replace([sample('a')]); const before = store.values();
  for (const frame of [{ upserts: [sample('b'), { path: 'bad' }], removed: ['a'] }, { upserts: [sample('a')], removed: ['a'] }, { upserts: [sample('a'), sample('a')], removed: [] }]) assert.throws(() => store.delta(frame));
  assert.equal(store.values(), before); assert.throws(() => validateTagDelta({ upserts: [], removed: ['a', 'a'] }));
});
check('tag scope includes nested parameter matches and fails conservatively for computed addresses', () => {
  assert.deepEqual([...tagDependencyPaths({ tagPath: '[default]Line/{line}/Speed' }, { line: 'A' }, ['[default]Line/A/Speed', '[default]Line/B/Speed', '[default]Other'])], ['[default]Line/A/Speed', '[default]Line/B/Speed']);
  assert.equal(tagDependencyPaths({ bindings: { tagPath: {} } }, {}, []), null);
  assert.deepEqual([...tagDependencyPaths({ references: { p: { kind: 'tag', path: 'one' } } }, {}, [])], ['one']);
});
check('quality and timestamp changes notify even when value does not', () => {
  const store = new TagSnapshotStore(); store.replace([sample('a')]); let notifications = 0; store.subscribe(new Set(['a']), () => notifications++);
  store.delta({ upserts: [{ ...sample('a'), quality: 'Bad' }], removed: [] }); store.delta({ upserts: [{ ...sample('a'), timestamp: '2026-09-30T10:00:01Z' }], removed: [] }); assert.equal(notifications, 2);
});
check('indexed lookups respect replacements and missing paths', () => {
  const tags = [sample('a')]; assert.equal(tagByPath(tags, 'a'), tags[0]); assert.equal(tagByPath(tags, 'missing'), undefined); assert.equal(tagByPath([sample('a', 3)], 'a').value, 3);
});
check('project guard accepts valid documents and rejects unusable shapes before rendering', () => {
  validateApiPayload('/runtime/project', project);
  for (const change of [{ screens: null }, { parameters: [] }, { revision: '1' }, { screens: [{ ...project.screens[0], components: [null] }] }, { localization: { defaultLocale: 'en', locales: ['en'], messages: { bad: null } } }]) assert.throws(() => validateApiPayload('/project', { ...project, ...change }));
  assert.throws(() => validateApiPayload('/project', JSON.parse('{"id":"test","name":"Test","revision":1,"parameters":{},"screens":[],"__proto__":{}}')));
});
check('publication guard requires a usable published timestamp and validates optional revisions', () => {
  validateApiPayload('/project/publication', { published: false }); validateApiPayload('/project/publication', { published: true, revision: 1, publishedAt: '2026-09-30T10:00:00Z' });
  assert.throws(() => validateApiPayload('/project/publication', { published: true })); assert.throws(() => validateApiPayload('/project/publication', []));
});
check('rapid nudges form one undo group while pauses, selections, other edits and redo split groups', () => {
  const first = structuredClone(project), second = { ...first, name: 'Second' };
  let history = checkpoint({ past: [], future: [] }, first, 'nudge:main:a', 1000);
  history = checkpoint(history, second, 'nudge:main:a', 1100); assert.equal(history.past.length, 1); assert.equal(history.past[0], first);
  history = checkpoint(history, second, 'nudge:main:a', 1900); assert.equal(history.past.length, 2);
  history = checkpoint(history, second, 'nudge:main:b', 1901); assert.equal(history.past.length, 3);
  history = checkpoint(history, second); assert.equal(history.coalescing, undefined);
  const undone = restoreHistory(history, second, 'undo'); assert.equal(undone.history.coalescing, undefined);
});
check('runtime chrome translates by locale and supports project overrides with fallback', () => {
  assert.equal(runtimeText(undefined, 'es-MX', 'communicationLost', 'Communication lost'), 'Comunicación perdida');
  const catalog = { defaultLocale: 'en', locales: ['en', 'de'], messages: { 'runtime.retry': { en: 'Retry now', de: 'Noch einmal' } } };
  assert.equal(runtimeText(catalog, 'de', 'retry', 'Try again'), 'Noch einmal'); assert.equal(runtimeText(undefined, 'zz', 'retry', 'Try again'), 'Try again');
});
const { alarmSamples, alarmJournalPage, historySeries, processDataPropertyError } = await import(load('processDataModel'));
check('alarm response validation rejects incomplete event identities and malformed rows', () => {
  const alarm = { id: 'speed', name: 'Speed', tagPath: '[default]Speed', priority: 2, active: true, acknowledged: false, quality: 'Good', value: 90, eventId: 'event-1' };
  assert.deepEqual(alarmSamples({ alarms: [alarm] }), [alarm]); assert.deepEqual(alarmSamples({ events: [alarm], truncated: false }, true), [alarm]);
  assert.throws(() => alarmSamples({ alarms: [{ ...alarm, priority: 9 }] })); assert.throws(() => alarmSamples({ alarms: [{ ...alarm, eventId: null }] }));
});
check('journal parser requires an explicit completeness result, including empty scoped pages', () => {
  assert.deepEqual(alarmJournalPage({ events: [], truncated: true }), { events: [], truncated: true });
  assert.deepEqual(alarmJournalPage({ events: [], truncated: false }), { events: [], truncated: false });
  for (const truncated of [undefined, null, 0, 'false']) assert.throws(() => alarmJournalPage({ events: [], truncated }));
});
check('historical responses preserve bad-quality records and reject unparseable times', () => {
  const response = { series: [{ path: '[default]Speed', points: [{ timestamp: '2026-09-30T10:00:00Z', value: null, quality: 'Bad_Disconnected' }] }], truncated: true };
  assert.equal(historySeries(response), response); assert.throws(() => historySeries({ ...response, truncated: 'true' }));
  assert.throws(() => historySeries({ series: [{ path: 'a', points: [{ timestamp: 'invalid', value: 1, quality: 'Good' }] }], truncated: false }));
});
check('history configuration has finite bounded query ranges and unique limited paths', () => {
  const control = { ...project.screens[0].components[0], type: 'historicalTrend', props: { historyPaths: ['[default]Speed'], historyMinutes: 60, historyMaxPoints: 1000 } };
  assert.equal(processDataPropertyError(control), undefined);
  for (const patch of [{ historyMinutes: 0 }, { historyMinutes: Infinity }, { historyMaxPoints: 10001 }, { historyPaths: ['a', 'a'] }, { historyPaths: [] }]) assert.ok(processDataPropertyError({ ...control, props: { ...control.props, ...patch } }));
});
// Render the shipped journal against deterministic state without running requests/effects.
const React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const journalHooks = asModule('export const useState=initial=>[globalThis.__journalStates.shift(),()=>{}];export const useRef=initial=>({current:initial});export const useEffect=()=>{};');
const journalDeps = {
  react: journalHooks,
  './api': asModule('export const api=()=>{throw new Error("Journal render must not perform requests");};export const displayValue=value=>String(value);export const resolvePath=value=>value;'),
  './ComponentActivity': asModule('export const useComponentActivity=()=>true;'),
  './ChartComponent': asModule('export const ChartGraphic=()=>null;'),
  './chartModel': asModule('export const buildChart=()=>({points:[],gaps:0});'),
  './processDataModel': load('processDataModel'),
};
const journalCode = ts.transpileModule(fs.readFileSync(new URL('src/ProcessDataComponent.tsx', import.meta.url), 'utf8'), { compilerOptions: {module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX} }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dep) => prefix + JSON.stringify(journalDeps[dep] ?? pathToFileURL(require.resolve(dep)).href));
const { default: ProcessDataComponent } = await import(asModule(journalCode));
check('an incomplete empty journal displays its warning and cannot claim no matching events', () => {
  for (const truncated of [true, false]) {
    globalThis.__journalStates = [[], [], '', false, truncated, null, 0];
    const html = renderToStaticMarkup(React.createElement(ProcessDataComponent, {component:{id:'journal',type:'alarmJournalTable',props:{}},parameters:{},preview:true,queryScope:'runtime',publishedAt:'current'}));
    if (truncated) { assert.match(html, /Incomplete journal results/); assert.doesNotMatch(html, /No matching/); }
    else { assert.doesNotMatch(html, /Incomplete journal results/); assert.match(html, /No matching alarm events/); }
  }
  delete globalThis.__journalStates;
});
console.log(`${checks}/${checks} frontend resilience checks passed.`);
