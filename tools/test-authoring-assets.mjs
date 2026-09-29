#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const load = async name => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(await readFile(new URL(`../apps/web/src/${name}.ts`, import.meta.url), 'utf8'))).toString('base64')}`);
const { defaultAuthoring, authoringDefaultsError, projectAuthoringDefaults, newDocumentDimensions } = await load('authoringDefaults');
const { projectAssetUses, planAssetReplacement, applyAssetReplacement } = await load('assetLibrary');
let count = 0;
const check = (name, test) => { test(); count++; console.log(`PASS ${name}`); };

check('legacy projects keep established screen, template and grid defaults', () => {
  assert.deepEqual(projectAuthoringDefaults({}), { screenWidth: 1200, screenHeight: 760, templateWidth: 600, templateHeight: 400, gridSize: 8 });
  assert.deepEqual(newDocumentDimensions({}, 'screen'), { width: 1200, height: 760 });
  assert.deepEqual(newDocumentDimensions({}, 'template'), { width: 600, height: 400 });
  const result = projectAuthoringDefaults({}); result.screenWidth = 12;
  assert.equal(defaultAuthoring.screenWidth, 1200);
});
check('valid authoring defaults are copied without resizing authored documents', () => {
  const project = { authoringDefaults: { screenWidth: 1400, screenHeight: 900, templateWidth: 700, templateHeight: 450, gridSize: 12 }, screens: [{ width: 123, height: 456 }], templates: [{ width: 80, height: 90 }] };
  const before = structuredClone(project);
  assert.equal(authoringDefaultsError(project.authoringDefaults), undefined);
  assert.deepEqual(newDocumentDimensions(project, 'screen'), { width: 1400, height: 900 });
  assert.deepEqual(newDocumentDimensions(project, 'template'), { width: 700, height: 450 });
  assert.equal(projectAuthoringDefaults(project).gridSize, 12);
  assert.deepEqual(project, before);
});
check('authoring validation rejects unknown keys, absent keys, nonnumbers, fractions and bounds', () => {
  for (const invalid of [null, [], 'bad', {}, { ...defaultAuthoring, extra: 1 }, { ...defaultAuthoring, screenWidth: undefined }, { ...defaultAuthoring, screenHeight: 0 }, { ...defaultAuthoring, templateWidth: 8193 }, { ...defaultAuthoring, templateHeight: 1.5 }, { ...defaultAuthoring, gridSize: 129 }, { ...defaultAuthoring, gridSize: -1 }, { ...defaultAuthoring, gridSize: '8' }, { ...defaultAuthoring, gridSize: NaN }, { ...defaultAuthoring, screenWidth: Infinity }]) {
    assert.ok(authoringDefaultsError(invalid));
    assert.deepEqual(projectAuthoringDefaults({ authoringDefaults: invalid }), defaultAuthoring);
  }
  for (const value of [{ ...defaultAuthoring, screenWidth: 1, templateHeight: 8192, gridSize: 0 }, { ...defaultAuthoring, gridSize: 128 }]) assert.equal(authoringDefaultsError(value), undefined);
});
check('authoring defaults round trip as plain project data', () => {
  const value = { ...defaultAuthoring, gridSize: 0 };
  assert.deepEqual(projectAuthoringDefaults(JSON.parse(JSON.stringify({ authoringDefaults: value }))), value);
});

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const assets = [{ id: A, name: 'Old', width: 100, height: 50, size: 10, contentType: 'image/png' }, { id: B, name: 'New', width: 50, height: 100, size: 12, contentType: 'image/png' }];
const image = (id, assetId = A) => ({ id, type: 'image', x: 10, y: 20, width: 100, height: 50, groupId: 'group', props: { assetId, alt: 'Keep alt', text: 'Photo', imageFit: 'contain', bindings: { width: { expression: '200', references: {} } } } });
const fixture = () => ({ id: 'p', name: 'Images', revision: 3, parameters: {}, screens: [
  { id: 'same.id', name: 'Desk', width: 1200, height: 760, components: [image('same.id'), image('other', B), { id: 'script', type: 'button', x: 0, y: 0, width: 50, height: 28, props: { assetId: A, script: A } }] },
  { id: 'next', name: 'Second', width: 1200, height: 760, components: [image('same.id')] },
], templates: [{ id: 'same.id', name: 'Card', width: 300, height: 200, parameters: {}, components: [image('same.id')] }], arbitrary: { assetId: A } });
check('usage inventory lists explicit image properties with unambiguous owner-qualified keys', () => {
  const uses = projectAssetUses(fixture());
  assert.equal(uses.length, 4);
  assert.equal(new Set(uses.map(use => use.id)).size, 4);
  assert.equal(uses.filter(use => use.assetId === A).length, 3);
  assert.equal(uses[3].ownerKind, 'template');
  assert.equal(uses[0].alt, 'Keep alt');
  assert.match(uses[0].location, /Screen · Desk/);
});
check('preview leaves the source project and immutable assets untouched', () => {
  const project = fixture(), before = structuredClone(project), assetCopy = structuredClone(assets);
  const plan = planAssetReplacement(project, assets, A, B);
  assert.deepEqual(plan.errors, []); assert.equal(plan.uses.length, 3);
  assert.deepEqual(project, before); assert.deepEqual(assets, assetCopy);
});
check('selected replacement changes only image asset IDs and preserves geometry, bindings and alt', () => {
  const project = fixture(), before = structuredClone(project), plan = planAssetReplacement(project, assets, A, B);
  const result = applyAssetReplacement(plan, project, assets, [plan.uses[0].id, plan.uses[2].id]);
  const expected = structuredClone(project); expected.screens[0].components[0].props.assetId = B; expected.templates[0].components[0].props.assetId = B;
  assert.deepEqual(result, expected); assert.deepEqual(project, before);
  assert.equal(result.screens[1].components[0].props.assetId, A);
  assert.equal(result.screens[0].components[2].props.script, A);
  assert.equal(result.arbitrary.assetId, A);
});
check('replacement can repair a valid missing asset reference using a local image', () => {
  const project = fixture(); project.screens[0].components[0].props.assetId = C;
  const plan = planAssetReplacement(project, assets, C, B);
  assert.deepEqual(plan.errors, []);
  assert.equal(applyAssetReplacement(plan, project, assets, [plan.uses[0].id]).screens[0].components[0].props.assetId, B);
});
check('invalid, same, absent target and unused source assets are rejected', () => {
  for (const [from, to] of [[A, A], [A, C], ['bad', B], [A, 'BAD'], [C, B]]) {
    const plan = planAssetReplacement(fixture(), assets, from, to);
    assert.ok(plan.errors.length);
    assert.throws(() => applyAssetReplacement(plan, fixture(), assets, ['anything']));
  }
});
check('stale revision, unrelated draft changes and local asset metadata changes require new preview', () => {
  const project = fixture(), plan = planAssetReplacement(project, assets, A, B), selected = [plan.uses[0].id];
  for (const changed of [{ ...project, revision: 4 }, { ...project, name: 'Changed' }]) assert.throws(() => applyAssetReplacement(plan, changed, assets, selected), /changed/);
  assert.throws(() => applyAssetReplacement(plan, project, [{ ...assets[0], name: 'Renamed' }, assets[1]], selected), /changed/);
  assert.throws(() => applyAssetReplacement(plan, project, [assets[0]], selected), /changed/);
  assert.doesNotThrow(() => applyAssetReplacement(plan, project, [...assets].reverse(), selected));
});
check('duplicate, empty, invented and stale owner selection keys are rejected', () => {
  const project = fixture(), plan = planAssetReplacement(project, assets, A, B), key = plan.uses[0].id;
  for (const selected of [[], [key, key], ['same.id'], [JSON.stringify(['screen', 'missing', 'same.id'])]]) assert.throws(() => applyAssetReplacement(plan, project, assets, selected), /Select valid/);
});
check('tampered preview rows cannot change unrelated fields or expand supported inventory', () => {
  const project = fixture(), plan = planAssetReplacement(project, assets, A, B);
  const key = plan.uses[0].id;
  plan.uses[0].componentId = 'script'; plan.uses[0].alt = 'Tampered'; plan.uses[0].assetId = C;
  const result = applyAssetReplacement(plan, project, assets, [key]);
  assert.equal(result.screens[0].components[0].props.assetId, B);
  assert.equal(result.screens[0].components[0].props.alt, 'Keep alt');
  assert.equal(result.screens[0].components[2].props.assetId, A);
  assert.throws(() => applyAssetReplacement({ ...plan, replacementId: C }, project, assets, [key]), /changed/);
});
console.log(`${count}/${count} authoring defaults and asset library checks passed.`);
