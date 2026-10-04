#!/usr/bin/env node
// Independently authored workshop and loopback checks. Never contacts a saved gateway.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startDataSourceSimulators } from './run-data-source-simulators.mjs';
import { packWorkshop, readZip } from './workshop-packages.mjs';
import { webModelModule } from './web-model-module.mjs';

const load = async name => JSON.parse(await readFile(new URL('../examples/' + name + '.json', import.meta.url), 'utf8'));
const recipe = await load('uns-model'), faceplates = await load('uns-faceplates'), catalog = await load('catalog');
const { bulkModelInstances, modelLeaves } = await import(await webModelModule('modelWorkspace'));
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log('PASS ' + name); };
await check('source recipes only read synthetic loopback points and models reference existing tags', () => {
  assert.equal(catalog.workshops.find(item => item.id === 'uns-model').distribution, 'setup-required');
  const source = recipe.sourceRecipes.find(item => item.type === 'mtconnect');
  assert.equal(new URL(source.source.endpoint).hostname, '127.0.0.1');
  assert.equal(source.source.points.length, 8); assert.ok(source.source.points.every(point => point.writable === false));
  assert.equal(recipe.modelRecipe.version, 3); assert.equal(recipe.modelRecipe.tags.length, 0);
  const members = recipe.modelRecipe.udtDefinitions.flatMap(type => type.members);
  assert.ok(!members.some(member => ['device', 'opcua'].includes(member.kind)));
  assert.equal(recipe.sourceTagRecipe.tags.length, 8);
});
await check('bulk CSV creates two typed machines and nested model has six concrete leaves', () => {
  const definitions = recipe.modelRecipe.udtDefinitions;
  const instances = bulkModelInstances(recipe.instanceCsv, definitions);
  assert.equal(instances.length, 2); assert.equal(instances[0].parameters.Device, 'Haas01');
  assert.equal(instances[0].parameters.IdealCycleSeconds, 42); assert.equal(instances[1].parameters.IdealCycleSeconds, undefined);
  const leaves = modelLeaves(definitions.find(type => type.id === 'CNC'), definitions);
  assert.equal(leaves.length, 6); assert.ok(leaves.some(leaf => leaf.path === 'Spindle/Load'));
  assert.equal(recipe.upgradeInstances.length, 1);
  assert.ok(recipe.upgradeInstances[0].path.endsWith('CNC01'));
  assert.equal(recipe.upgradeInstances[0].version, 2);
  const next = [...definitions, ...recipe.upgradeRecipe.udtDefinitions];
  assert.ok(!modelLeaves(next.find(type => type.id === 'CNC' && type.version === 2), next).some(leaf => leaf.path === 'Spindle/Load'));
});
await check('portable faceplates carry model requirements without embedding gateway tags or sources', () => {
  const entry = catalog.workshops.find(item => item.id === 'uns-faceplates');
  const packed = packWorkshop(faceplates, entry, '2026-10-04T12:00:00Z');
  const files = readZip(packed.bytes), project = JSON.parse(files.get('project.json'));
  assert.deepEqual([...files.keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
  assert.equal(project.templates[0].parameterTypes.machine, 'model');
  assert.equal(project.templates[0].modelParameters.machine.definitionId, 'CNC');
  const placements = project.screens.flatMap(screen => screen.components).filter(component => component.type === 'template');
  assert.equal(placements.length, 2); assert.equal(new Set(placements.map(component => component.props.parameters.machine)).size, 2);
  assert.ok(project.templates[0].components.every(component => component.props.tagPath.startsWith('{machine}/')));
});
const fixtures = await startDataSourceSimulators({ mtPort: 0, i3xPort: 0, mqttPort: 0, unsModels: true });
try {
  await check('two-machine probe and current responses match every authored point and datatype', async () => {
    const probe = await (await fetch(fixtures.endpoints.mtconnect + '/probe')).text();
    const current = await (await fetch(fixtures.endpoints.mtconnect + '/current')).text();
    for (const device of ['Haas01', 'Haas02']) {
      assert.ok(probe.includes(`uuid="${device}"`)); assert.ok(current.includes(`uuid="${device}"`));
      for (const suffix of ['Sspeed', 'Sload', 'execution', 'PartCountAct']) {
        assert.ok(probe.includes(`id="${device}-${suffix}"`)); assert.ok(current.includes(`dataItemId="${device}-${suffix}"`));
      }
    }
    const sequences = [...current.matchAll(/ sequence="(\d+)"/g)].map(match => Number(match[1]));
    assert.equal(new Set(sequences).size, 8);
    assert.equal(Number(/nextSequence="(\d+)"/.exec(current)[1]), Math.max(...sequences) + 1);
  });
  await check('UNS sample cursor advances without replaying earlier observations', async () => {
    const current = await (await fetch(fixtures.endpoints.mtconnect + '/current')).text();
    const from = Number(/nextSequence="(\d+)"/.exec(current)[1]);
    const controller = new AbortController();
    const response = await fetch(fixtures.endpoints.mtconnect + '/sample?from=' + from, { signal: controller.signal });
    const reader = response.body.getReader(); const chunk = await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
    const sequences = [...Buffer.from(chunk.value).toString().matchAll(/ sequence="(\d+)"/g)].map(match => Number(match[1]));
    assert.equal(sequences.length, 8); assert.ok(sequences.every(sequence => sequence >= from));
  });
} finally { await fixtures.close(); }
console.log(`${checks} UNS workshop checks passed.`);
