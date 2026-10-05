import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Pure helpers behind the Models explorer: plant tree rows, model list entries, machine health and new locations.
const file = createTestModuleFiles(), modules = new Map(), require = createRequire(import.meta.url);
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const result = file(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); modules.set(name, result); return result; }
  const source = ['ts', 'tsx'].map(extension => new URL(`src/${name}.${extension}`, import.meta.url)).find(path => fs.existsSync(path));
  assert.ok(source, name);
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import\s+["'][^"']+\.css["'];?/g, '')
    .replace(/from (["'])([^"']+)\1/g, (_match, _quote, dependency) => `from ${JSON.stringify(dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const result = file(code); modules.set(name, result); return result;
}
const explorer = await import(load('modelExplorer'));
const { addModelLocation } = await import(load('modelWorkspaceNamespace'));
const { emptyModelPackage } = await import(load('modelWorkspace'));
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

const press = { id: 'Press', version: 1, parameters: [], members: [] }, press2 = { ...press, version: 2 }, pump = { id: 'Pump', version: 1, parameters: [], members: [] };
const machine = (path, definitionId = 'Press', version = 1, extra = {}) => ({ path, definitionId, version, parameters: {}, overrides: {}, ...extra });
const saved = { ...emptyModelPackage(), udtDefinitions: [press, pump], hierarchy: [{ path: '[default]Acme', level: 'Site' }, { path: '[default]Acme/Line1', level: 'Line' }],
  instances: [machine('[default]Acme/Line1/Press01'), machine('[default]Acme/Line1/Press02'), machine('[default]Acme/Line1/Pump01', 'Pump'), machine('[default]Loose/Press09', 'Press', 1, { enabled: false })] };
const draft = { ...saved, udtDefinitions: [...saved.udtDefinitions, press2], instances: [...saved.instances, machine('[default]Acme/Line1/Press03', 'Press', 2)] };

check('path helpers name the root, parents and breadcrumbs', () => {
  assert.equal(explorer.modelPathName(explorer.modelRoot), 'All equipment');
  assert.equal(explorer.modelPathName('[default]Acme/Line1'), 'Line1');
  assert.equal(explorer.modelParentPath('[default]Acme'), explorer.modelRoot);
  assert.equal(explorer.modelParentPath(explorer.modelRoot), '');
  assert.equal(explorer.modelCrumb('[default]Acme/Line1/Press01'), 'Acme › Line1');
});
check('plant rows list locations before machines, honor expansion and add implied folders', () => {
  const collapsed = explorer.modelPlantRows(draft, new Set());
  assert.deepEqual(collapsed.map(row => row.name), ['Acme', 'Loose']);
  assert.equal(collapsed.find(row => row.name === 'Loose').kind, 'folder');
  const open = explorer.modelPlantRows(draft, new Set(['[default]Acme', '[default]Acme/Line1']));
  assert.deepEqual(open.map(row => row.name), ['Acme', 'Line1', 'Press01', 'Press02', 'Press03', 'Pump01', 'Loose']);
  const line = open.find(row => row.name === 'Line1');
  assert.equal(line.level, 'Line'); assert.equal(line.depth, 1); assert.equal(line.hasChildren, true);
  assert.equal(open.find(row => row.name === 'Press03').version, 2);
});
check('plant search shows matches with their ancestors even when collapsed', () => {
  const rows = explorer.modelPlantRows(draft, new Set(), 'pump');
  assert.deepEqual(rows.map(row => row.name), ['Acme', 'Line1', 'Pump01']);
  assert.deepEqual(explorer.modelPlantRows(draft, new Set(), 'nothing-matches'), []);
});
check('model list groups versions, counts machines and marks drafts', () => {
  const entries = explorer.modelTypeEntries(draft, saved, '');
  const pressEntry = entries.find(entry => entry.id === 'Press');
  assert.equal(pressEntry.latest.version, 2);
  assert.deepEqual(pressEntry.versions.map(version => [version.version, version.draft]).sort(), [[1, false], [2, true]]);
  assert.equal(pressEntry.usage, 4); assert.equal(pressEntry.draft, true);
  assert.equal(entries.find(entry => entry.id === 'Pump').draft, false);
  assert.deepEqual(explorer.modelTypeEntries(draft, saved, 'pu').map(entry => entry.id), ['Pump']);
});
check('machine health separates good, attention, waiting, draft and turned-off machines', () => {
  const tags = [{ path: '[default]Acme/Line1/Press01/Speed', quality: 'Good' }, { path: '[default]Acme/Line1/Press02/Speed', quality: 'Good' }, { path: '[default]Acme/Line1/Press02/Count', quality: 'Bad_NotConnected' }, { path: '[default]Acme/Line1/Press03/Speed', quality: 'Good' }];
  const health = explorer.modelInstanceHealth(draft, saved, tags);
  assert.equal(health.get('[default]Acme/Line1/Press01'), 'good');
  assert.equal(health.get('[default]Acme/Line1/Press02'), 'warn');
  assert.equal(health.get('[default]Acme/Line1/Pump01'), 'waiting');
  assert.equal(health.get('[default]Acme/Line1/Press03'), 'draft');
  assert.equal(health.get('[default]Loose/Press09'), 'off');
});
check('new locations take the next level and never collide with existing paths', () => {
  const first = addModelLocation(draft, '[default]Acme/Line1');
  assert.equal(first.level, 'Cell'); assert.equal(first.path, '[default]Acme/Line1/Cell');
  const second = addModelLocation(first.model, '[default]Acme/Line1');
  assert.equal(second.path, '[default]Acme/Line1/Cell2');
  assert.equal(second.model.hierarchy.length, draft.hierarchy.length + 2);
  const top = addModelLocation(emptyModelPackage(), explorer.modelRoot);
  assert.equal(top.level, 'Enterprise'); assert.equal(top.path, '[default]Enterprise');
});
console.log(`${passed} Model explorer checks passed.`);
