#!/usr/bin/env node
// Original synthetic gateway recipe: validate behavior without any running gateway or broker.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webModelModule } from './web-model-module.mjs';
import { readCatalog, packWorkshop } from './workshop-packages.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipe = JSON.parse(await readFile(new URL('../examples/model-operations.json', import.meta.url), 'utf8'));
const { modelLeaves, validateDraftDefinition } = await import(await webModelModule('modelWorkspace'));
const { mergeModelPackage, modelDraftChanges } = await import(await webModelModule('modelDraft'));
const catalog = await readCatalog(root), entry = catalog.workshops.find(item => item.id === 'model-operations');
let count = 0;
const check = (name, run) => { run(); count++; console.log('PASS ' + name); };

check('recipe is explicitly gateway setup, excludes credentials, and never packages as an application', () => {
  assert.equal(entry.distribution, 'setup-required'); assert.equal(entry.gatewayWrites, 'memory-tags');
  assert.throws(() => packWorkshop(recipe, entry, '2026-10-04T12:00:00Z'), /Setup-required/);
  assert.ok(!recipe.connections && !recipe.scripts && !recipe.assets);
  assert.ok(!Object.hasOwn(recipe.publisherRecipe, 'password'));
});
check('three instances resolve distinct synthetic memory tags through one separate source mapping', () => {
  const model = recipe.modelRecipe, definition = model.udtDefinitions[0], profile = model.mappingProfiles[0];
  validateDraftDefinition(definition);
  assert.equal(modelLeaves(definition, model.udtDefinitions).length, 3);
  assert.equal(model.instances.length, 3); assert.equal(model.tags.length, 9);
  assert.ok(model.tags.every(tag => tag.kind === 'memory' && tag.path.startsWith('[default]ModelOperations/Sources/')));
  const sourceValues = new Map(model.tags.map(tag => [tag.path, tag.value]));
  assert.deepEqual(model.instances.map(instance => sourceValues.get(profile.bindings.Load.target.replace('{Device}', instance.parameters.Device))), [28, 64, 91]);
  for (const instance of model.instances) for (const binding of Object.values(profile.bindings)) {
    assert.equal(binding.kind, 'reference'); assert.ok(sourceValues.has(binding.target.replace('{Device}', instance.parameters.Device)));
  }
});
check('contract exercise separates a valid alarm from invalid source data and static-memory freshness', () => {
  const load = recipe.modelRecipe.udtDefinitions[0].members.find(member => member.path === 'Load');
  assert.deepEqual(load.range, { low: 0, high: 100 }); assert.equal(load.unitSystem, 'ucum');
  assert.equal(load.alarms[0].setpoint, 80); assert.equal(load.alarms[0].deadband, 2);
  assert.equal(recipe.valueExercises[0].value, 91); assert.equal(recipe.valueExercises[1].value, 120); assert.equal(recipe.valueExercises[2].value, 70);
  const state = recipe.modelRecipe.udtDefinitions[0].members.find(member => member.path === 'State');
  assert.ok(!state.enumValues.includes(recipe.valueExercises[3].value)); assert.ok(state.enumValues.includes(recipe.valueExercises[4].value));
  assert.equal(recipe.freshnessExercise.freshnessMs, 2000);
  const source = recipe.modelRecipe.tags.find(tag => tag.path === recipe.freshnessExercise.sameValueWrite.path);
  assert.equal(source.value, recipe.freshnessExercise.sameValueWrite.value);
});
check('upgrade changes only the selected equipment and preserves the immutable first model version', () => {
  const base = structuredClone(recipe.modelRecipe), merged = mergeModelPackage(base, recipe.upgradeRecipe);
  assert.equal(merged.udtDefinitions.length, 2); assert.deepEqual(base.udtDefinitions[0], merged.udtDefinitions.find(item => item.version === 1));
  assert.deepEqual([...merged.instances].sort((a, b) => a.path.localeCompare(b.path)).map(item => item.version), [2, 1, 1]);
  assert.equal(merged.instances.find(item => item.path.endsWith('/Press01')).mappingProfileId, 'WorkshopMemoryV2');
  const definition = merged.udtDefinitions.find(item => item.version === 2); validateDraftDefinition(definition);
  assert.equal(modelLeaves(definition, merged.udtDefinitions).length, 4);
  const changedInstances = modelDraftChanges(base, merged).filter(item => item.kind === 'instances');
  assert.equal(changedInstances.length, 1);
});
check('publisher is disabled, loopback-only, bounded and points only to the selected workshop equipment', () => {
  const publisher = recipe.publisherRecipe;
  assert.equal(publisher.enabled, false); assert.equal(new URL(publisher.endpoint).hostname, '127.0.0.1');
  assert.equal(publisher.qos, 1); assert.equal(publisher.retain, false); assert.equal(publisher.queueBytes, 10 * 1024 * 1024);
  assert.deepEqual(publisher.instancePaths, recipe.selectiveExport.instancePaths);
  assert.ok(recipe.expectedObjectTopic.endsWith('/Press01'));
  assert.ok(!recipe.modelRecipe.tags.some(tag => tag.connectionId));
});
console.log(`${count} model operations workshop checks passed.`);
