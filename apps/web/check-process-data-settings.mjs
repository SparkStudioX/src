import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url), uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hooks = uri(`export const useState = value => globalThis.__processHooks.state(value); export const useRef = value => globalThis.__processHooks.ref(value); export const useCallback = value => value; export const useEffect = () => {};`);
const api = uri(`export const api = (...args) => globalThis.__processApi(...args);`);
const source = ts.transpileModule(fs.readFileSync(new URL('src/GatewayProcessData.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
  .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => prefix + JSON.stringify(dependency === 'react' ? hooks : dependency === './api' ? api : pathToFileURL(require.resolve(dependency)).href));
const { processDataError, default: Settings } = await import(uri(source));
const config = () => ({ revision: 4, alarmRetentionDays: 7, alarms: [{ id: 'high', name: 'High', tagPath: '[default]Workshop/Value', enabled: true, mode: 'high', setpoint: 80, deadband: 5, priority: 3 }], history: [{ tagPath: '[default]Workshop/Value', enabled: true, deadband: 0.5, maxIntervalMs: 1000, retentionDays: 7 }] });
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };
await check('saved rules and their bounded numeric fields are validated before Save', () => {
  assert.equal(processDataError(config()), null);
  for (const edit of [x => x.alarmRetentionDays = 0, x => x.alarmRetentionDays = 7.5, x => x.alarms[0].id = 'bad id', x => x.alarms.push(x.alarms[0]), x => x.alarms[0].tagPath = '[default]{station}/Value', x => x.alarms[0].setpoint = Number.NaN, x => x.alarms[0].deadband = -1, x => x.alarms[0].priority = 5, x => x.history.push(x.history[0]), x => x.history[0].maxIntervalMs = 249, x => x.history[0].maxIntervalMs = 1000.5, x => x.history[0].retentionDays = 3651, x => x.history[0].deadband = Infinity]) {
    const draft = config(); edit(draft); assert.equal(typeof processDataError(draft), 'string');
  }
});
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node, ...nodes(node.props?.children)];
function drive(saved, draft) {
  const state = [saved, draft], refs = []; let cursor = 0, refIndex = 0, tree;
  globalThis.__processHooks = {
    state(value) { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => state[index] = typeof next === 'function' ? next(state[index]) : next]; },
    ref(value) { const index = refIndex++; return refs[index] ??= { current: value }; },
  };
  const render = () => { cursor = 0; refIndex = 0; tree = Settings(); return tree; };
  render();
  return { state, render, button: text => { const value = nodes(tree).find(node => node.type === 'button' && node.props.children === text); assert.ok(value, text); return value; } };
}
await check('Cancel discards staged configuration without gateway writes', () => {
  globalThis.__processApi = () => { throw new Error('No network calls expected.'); };
  const saved = config(), changed = config(); changed.alarms[0].setpoint = 90;
  const ui = drive(saved, changed); assert.equal(ui.button('Save configuration').props.disabled, false);
  ui.button('Cancel changes').props.onClick(); ui.render();
  assert.deepEqual(ui.state[1], saved); assert.notEqual(ui.state[1], saved); assert.equal(ui.button('Save configuration').props.disabled, true);
});
await check('Save sends the reviewed revision and preserves edits on a stale-write error', async () => {
  const saved = config(), changed = config(); changed.history[0].retentionDays = 30;
  const calls = []; globalThis.__processApi = async (...args) => { calls.push(args); throw new Error('Configuration changed. Reload before saving.'); };
  const ui = drive(saved, changed); ui.button('Save configuration').props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)); ui.render();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/gateway/process-data'); assert.equal(calls[0][1], 'PUT'); assert.deepEqual(calls[0][2], changed);
  assert.deepEqual(ui.state[1], changed); assert.equal(ui.button('Reload').props.disabled, true); assert.match(ui.state[3], /Reload/);
});
await check('success uses the new gateway revision and invalid numeric edits cannot Save', async () => {
  const changed = config(); changed.alarmRetentionDays = 14;
  globalThis.__processApi = async (_route, _method, body) => ({ ...body, revision: 5 });
  const ui = drive(config(), changed); ui.button('Save configuration').props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)); ui.render();
  assert.equal(ui.state[0].revision, 5); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.state[1] = { ...ui.state[1], alarmRetentionDays: Number.NaN }; ui.render(); assert.equal(ui.button('Save configuration').props.disabled, true);
});
await check('corrupt configuration requires explicit recovery confirmation and storage failure blocks Save', () => {
  const broken = { ...config(), configurationError: 'Unreadable configuration' }, changed = { ...broken, alarmRetentionDays: 9 };
  const ui = drive(broken, changed); assert.equal(ui.button('Save configuration').props.disabled, true);
  ui.state[1] = { ...changed, replaceInvalidConfiguration: true }; ui.render(); assert.equal(ui.button('Save configuration').props.disabled, false);
  ui.state[1] = { ...ui.state[1], storageError: 'Database requires repair' }; ui.render(); assert.equal(ui.button('Save configuration').props.disabled, true);
});
const example = JSON.parse(fs.readFileSync(new URL('../../examples/process-data-workshop.json', import.meta.url), 'utf8'));
await check('authored workshop uses one memory source, explicit commands and all three runtime controls', () => {
  assert.equal(example.tags.length, 1); assert.equal(example.tags[0].kind, 'memory');
  assert.equal(processDataError({ revision: 1, alarmRetentionDays: 7, ...example.processData }), null);
  const types = example.screens.flatMap(screen => screen.components.map(component => component.type));
  for (const type of ['alarmStatusTable', 'alarmJournalTable', 'historicalTrend', 'equipmentCommand']) assert.ok(types.includes(type));
  assert.equal(example.commands[0].tagPath, example.tags[0].path);
});
delete globalThis.__processHooks; delete globalThis.__processApi;
console.log(`${checks} process data settings groups passed.`);
