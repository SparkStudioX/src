import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('./src/askSparkDesignerTools.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { executeDesignerTool, designerImplementedNames } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const declarations = JSON.parse(fs.readFileSync(new URL('./src/askSparkDesignerTools.json', import.meta.url), 'utf8'));
assert.deepEqual(declarations.map(item => item.name).sort(), designerImplementedNames().sort());
const fixture = () => ({ id: 'ask-workshop', name: 'Ask workshop', revision: 1, parameters: {}, screens: [{ id: 'home', name: 'Home', width: 1000, height: 800, components: [
  { id: 'background', type: 'rectangle', x: 0, y: 0, width: 900, height: 700, props: { backgroundColor: '#ffffff' } },
  { id: 'first', type: 'label', x: 45, y: 40, width: 140, height: 40, props: { text: 'Speed' } },
  { id: 'second', type: 'value', x: 75, y: 100, width: 140, height: 40, props: { tagPath: '[default]Speed' } },
] }], templates: [] });
let state, token, validations, commits, validation, documentId, documentKind, selection, capture;
const reset = () => { state = fixture(); token = 'initial'; validations = 0; commits = 0; validation = async () => {}; documentId = 'home'; documentKind = 'screen'; selection = ['first', 'second']; capture = async () => ({ data: 'cGl4ZWxz', mimeType: 'image/png', name: 'Canvas.png', width: 1000, height: 800 }); };
const bridge = { snapshot: () => ({ project: state, token, documentId, documentKind, selectedComponentIds: selection, queries: [], scripts: [], assets: [], tags: [{ path: '[default]Speed', quality: 'Good', value: 12, timestamp: new Date().toISOString() }] }),
  validate: async value => { validations++; await validation(value); return { valid: true }; },
  commit: (value, expected) => { assert.equal(expected, token, 'stale draft commit'); state = value; token = `draft-${++commits}`; },
  select: (id, kind, ids) => { documentId = id; documentKind = kind; selection = ids; }, save: async () => ({ saved: true }), preview: async () => ({ preview: true }), capture: signal => capture(signal) };
const run = (name, args = {}, context = { projectId: 'ask-workshop' }, signal = new AbortController().signal) => executeDesignerTool(bridge, `spark_designer_${name}`, args, context, signal);
const target = { documentId: 'home', documentKind: 'screen' };
let passed = 1;
async function check(name, work) { reset(); await work(); passed++; console.log(`PASS ${name}`); }
await check('read tools do not edit or save', async () => { const result = await run('inspect_context'); assert.equal(result.result.snapshotToken, 'initial'); assert.equal(commits, 0); });
await check('component discovery and creation declarations enumerate every real component type', async () => {
  const result = (await run('component_schema')).result;
  const declaredTypes = [...fs.readFileSync(new URL('./src/types.ts', import.meta.url), 'utf8').match(/^export type ComponentType =([\s\S]*?);/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const creation = declarations.find(tool => tool.name === 'spark_designer_create_components').parameters.properties.components;
  assert.deepEqual([...result.supportedComponentTypes].sort(), [...declaredTypes].sort());
  assert.deepEqual([...creation.items.properties.type.enum].sort(), [...declaredTypes].sort());
  assert.equal(creation.minItems, 1); assert.equal(creation.maxItems, 200);
  assert.deepEqual(creation.items.required, ['id', 'type', 'x', 'y', 'width', 'height', 'props']);
  for (const type of declaredTypes) {
    const schema = (await run('component_schema', { type })).result;
    assert.equal(schema.component.example.type, type); assert.equal(schema.examples[0].type, type);
    assert.ok(schema.component.example.props && typeof schema.component.example.props === 'object');
  }
  await assert.rejects(run('component_schema', { type: 'html' }), /Unsupported component type/);
  assert.equal(commits, 0);
});
await check('button schema exposes exact native actions and truthful Python notification examples', async () => {
  const schema = (await run('component_schema', { type: 'button', include: ['actions', 'scripts'] })).result;
  assert.deepEqual(schema.actions.schema.enum, ['navigate', 'script', 'openPopup', 'closePopup', 'message', 'setTagValue']);
  assert.equal(schema.actions.schema.type, 'string');
  assert.equal(schema.scripts.clickToast.nativeToastAction, false);
  assert.deepEqual(schema.scripts.clickToast.propsExample, { text: 'Add item', action: 'script', script: "result = {'message': 'Item selected.'}" });
  assert.match(schema.scripts.clickToast.requirements, /gateway administrator/);
  assert.match(schema.scripts.clickToast.requirements, /Do not call published runtime action tools/);
  assert.match(schema.scripts.javascript.notice, /not the application-level click toast/);
  const message = schema.actions.variants.find(item => item.action === 'message');
  assert.deepEqual(message.fields.properties.message.required, ['messageType', 'scope', 'payload']);
  assert.equal(message.fields.properties.message.additionalProperties, false);
  assert.match(message.rules, /does not show a toast/);
  assert.deepEqual(message.example.message, { messageType: 'order.changed', scope: 'screen', payload: { item: 'Sample' } });
});
await check('input and component event discovery uses exact supported names and handler formats', async () => {
  const include = ['events', 'componentEvents'];
  const button = (await run('component_schema', { type: 'button', include })).result;
  assert.equal(button.sections.events.supported, false);
  assert.ok(!button.sections.componentEvents.supportedEvents.includes('click'));
  assert.ok(!button.sections.componentEvents.supportedEvents.includes('change'));
  assert.deepEqual(button.sections.componentEvents.schema.properties.pointerUp.required, ['language', 'code']);
  assert.equal(button.sections.componentEvents.schema.properties.pointerUp.additionalProperties, false);
  assert.deepEqual(button.sections.componentEvents.schema.properties.propertyChange.oneOf[0].required, ['language', 'code', 'properties']);
  const input = (await run('component_schema', { type: 'textInput', include })).result;
  assert.equal(input.sections.events.supported, true);
  assert.deepEqual(Object.keys(input.sections.events.schema.properties), ['change', 'commit']);
  const password = (await run('component_schema', { type: 'passwordInput', include })).result;
  assert.equal(password.sections.events.schema.properties.change.properties.language.const, 'javascript');
  const watched = password.sections.componentEvents.schema.properties.propertyChange.oneOf;
  assert.ok(watched.every(item => !item.properties.properties.items.enum.includes('value')));
  assert.ok(!watched[1].properties.properties.items.enum.includes('text'));
});
await check('discovery explains transparent hex, all replaceable sections, and bounded asset references', async () => {
  const schema = (await run('component_schema', { type: 'rectangle', detail: 'full' })).result;
  assert.equal(schema.colors.transparent, '#00000000'); assert.match(schema.colors.note, /Named CSS colors/);
  assert.equal(schema.properties.find(item => item.path === 'x').location, 'x');
  assert.equal(schema.properties.find(item => item.path === 'backgroundColor').location, 'props.backgroundColor');
  const sectionNames = declarations.find(tool => tool.name === 'spark_designer_set_component_section').parameters.properties.section.enum;
  for (const name of sectionNames) assert.ok(schema.sections[name].schema, `Missing ${name} format`);
  assert.deepEqual(schema.sections.messageHandlers.schema.items.required, ['id', 'messageType', 'scope', 'language', 'code']);
  assert.equal(schema.sections.messageHandlers.schema.maxItems, 16);
  assert.match(schema.sectionEditing, /shallow-merges/);
  assert.ok(JSON.stringify(schema).length < 180_000);
});
await check('compact schemas preserve property constraints without repeating unrelated reference sections', async () => {
  for (const type of ['button', 'image']) {
    const compact = (await run('component_schema', { type })).result;
    const full = (await run('component_schema', { type, detail: 'full' })).result;
    assert.equal(compact.sections, undefined); assert.equal(compact.scripts, undefined);
    if (type === 'image') {
      assert.equal(compact.existingResources.assetCount, 0);
      assert.deepEqual(compact.existingResources.assets, full.existingResources.assets);
      assert.equal(compact.existingResources.screens, undefined);
      assert.equal(compact.existingResources.templates, undefined);
    } else assert.equal(compact.existingResources, undefined);
    assert.deepEqual(compact.properties, full.properties.map(({ components: _components, ...property }) => property));
    assert.deepEqual(compact.colors, full.colors); assert.deepEqual(compact.component, full.component);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 2, `${type} compact response must omit duplicate reference material`);
    assert.ok(compact.detailLookup.available.includes('bindings'));
  }
  const button = (await run('component_schema', { type: 'button' })).result;
  assert.equal(button.actions.schema.type, 'string');
  assert.deepEqual(button.actions.examples.script, { action: 'script', script: "result = {'message': 'Item selected.'}" });
  assert.match(button.actions.script, /Never use published runtime tools to test an unsaved draft/);
  assert.ok(button.overlayAppearance.propsExample.text.trim());
  assert.equal(button.overlayAppearance.propsExample.foregroundColor, '#00000000');
  assert.match(button.overlayAppearance.note, /shadow remains/);
  const parameters = declarations.find(tool => tool.name === 'spark_designer_component_schema').parameters;
  assert.deepEqual(parameters.properties.include.items.enum, button.detailLookup.available);
  assert.equal((await run('component_schema', { type: 'image' })).result.actions, undefined);
});
await check('targeted schema lookup returns the complete requested definition and rejects misspelled sections', async () => {
  const partial = (await run('component_schema', { type: 'table', include: ['tableEdit', 'dataSource'] })).result;
  const full = (await run('component_schema', { type: 'table', detail: 'full' })).result;
  assert.deepEqual(Object.keys(partial.sections).sort(), ['dataSource', 'tableEdit']);
  assert.deepEqual(partial.sections.tableEdit, full.sections.tableEdit);
  assert.deepEqual(partial.sections.dataSource, full.sections.dataSource);
  assert.equal(partial.actions, undefined); assert.equal(partial.scripts, undefined);
  await assert.rejects(run('component_schema', { type: 'button', include: ['click'] }), /Schema include/);
  await assert.rejects(run('component_schema', { type: 'button', include: 'events' }), /Schema include/);
  await assert.rejects(run('component_schema', { type: 'button', detail: 'unknown' }), /Schema detail/);
});
await check('selected background preserves document Z order', async () => { await run('update_components', { ...target, snapshotToken: token, componentIds: ['background'], patch: { props: { backgroundColor: '#112233' } } }); assert.deepEqual(state.screens[0].components.map(item => item.id), ['background', 'first', 'second']); assert.equal(validations, 1); });
await check('align and Undo preserve the exact prior draft', async () => { const before = JSON.stringify(state); const receipt = await run('arrange_components', { ...target, snapshotToken: token, componentIds: ['first', 'second'], operation: 'align', value: 'left' }); assert.equal(state.screens[0].components[1].x, state.screens[0].components[2].x); assert.equal(receipt.result.snapshotToken, token); receipt.undo(); assert.equal(JSON.stringify(state), before); });
await check('stale snapshot never applies', async () => { await assert.rejects(run('update_document', { ...target, snapshotToken: 'outdated', patch: { name: 'Wrong' } }), /draft changed/); assert.equal(commits, 0); });
await check('edits arriving during validation never get overwritten', async () => { validation = async () => { token = 'manual-edit'; }; await assert.rejects(run('update_document', { ...target, snapshotToken: token, patch: { name: 'New' } }), /stale draft commit/); assert.equal(state.screens[0].name, 'Home'); });
await check('undo refuses to clobber later edits', async () => { const receipt = await run('update_document', { ...target, snapshotToken: token, patch: { name: 'New' } }); token = 'later-edit'; assert.throws(receipt.undo, /stale draft commit/); });
await check('invalid gateway authoring validation leaves original draft untouched', async () => { validation = async () => { throw new Error('Invalid component property'); }; await assert.rejects(run('update_document', { ...target, snapshotToken: token, patch: { width: -1 } }), /Invalid/); assert.equal(commits, 0); });
await check('binding replaces conflicting query binding without deleting fallback', async () => { state.screens[0].components[1].props.queryBindings = { text: { queryId: 'old', column: 'value' } }; await run('set_binding', { ...target, snapshotToken: token, componentId: 'first', property: 'text', kind: 'expression', binding: { expression: 'speed', references: { speed: { kind: 'tag', path: '[default]Speed' } } } }); const props = state.screens[0].components[1].props; assert.equal(props.text, 'Speed'); assert.equal(props.queryBindings.text, undefined); assert.equal(props.bindings.text.references.speed.path, '[default]Speed'); });
await check('cross-project calls refuse even reads', async () => { await assert.rejects(run('inspect_context', {}, { projectId: 'different' }), /captured project/); });
await check('forbidden keys and root identity patches are rejected', async () => { await assert.rejects(run('update_document', { ...target, snapshotToken: token, patch: { id: 'replace' } }), /Unsupported/); await assert.rejects(run('update_components', { ...target, snapshotToken: token, componentIds: ['first'], patch: JSON.parse('{"__proto__":{"admin":true}}') }), /Unsafe/); });
await check('password input defaults stay out of model reads', async () => { state.screens[0].components.push({ id: 'secret', type: 'passwordInput', x: 0, y: 0, width: 10, height: 10, props: { value: 'private', defaultValue: 'private', text: 'private' } }); const result = await run('get_document', target); assert.ok(!JSON.stringify(result).includes('private')); });
await check('tag screen generation uses only existing requested paths', async () => { await run('generate_tag_screen', { snapshotToken: token, newId: 'monitor', name: 'Monitor', paths: ['[default]Speed'] }); assert.equal(state.screens.length, 2); assert.equal(state.screens[1].components[2].props.tagPath, '[default]Speed'); await assert.rejects(run('generate_tag_screen', { snapshotToken: token, newId: 'bad', name: 'Bad', paths: ['[default]Missing'] }), /does not exist/); });
await check('cancellation after validation never commits', async () => { const controller = new AbortController(); validation = async () => controller.abort(); await assert.rejects(run('update_document', { ...target, snapshotToken: token, patch: { name: 'New' } }, { projectId: 'ask-workshop' }, controller.signal)); assert.equal(commits, 0); });
await check('a draft batch creates a document and edits it atomically with one validation and Undo', async () => {
  const before = JSON.stringify(state);
  const receipt = await run('apply_edits', { snapshotToken: token, operations: [
    { name: 'spark_designer_create_document', arguments: { documentKind: 'screen', document: { id: 'new', name: 'New', width: 800, height: 600, components: [] } } },
    { name: 'spark_designer_create_components', arguments: { documentId: 'new', documentKind: 'screen', components: [{ id: 'title', type: 'label', x: 0, y: 0, width: 100, height: 30, props: { text: 'Created together' } }] } },
  ] });
  assert.equal(validations, 1); assert.equal(commits, 1); assert.equal(state.screens[1].components[0].props.text, 'Created together');
  assert.equal(receipt.result.snapshotToken, token); receipt.undo(); assert.equal(JSON.stringify(state), before);
});
await check('invalid later batch operation leaves all prior draft operations unapplied', async () => {
  const before = JSON.stringify(state);
  await assert.rejects(run('apply_edits', { snapshotToken: token, operations: [
    { name: 'spark_designer_update_document', arguments: { ...target, patch: { name: 'Changed' } } },
    { name: 'spark_designer_update_document', arguments: { ...target, patch: { id: 'Wrong' } } },
  ] }), /Unsupported/);
  assert.equal(JSON.stringify(state), before); assert.equal(validations, 0); assert.equal(commits, 0);
});
await check('batches reject saves, nested batches and operation-specific snapshots', async () => {
  for (const name of ['spark_designer_save', 'spark_designer_apply_edits', 'spark_designer_open_document']) await assert.rejects(run('apply_edits', { snapshotToken: token, operations: [{ name, arguments: {} }] }), /only draft edit tools/);
  await assert.rejects(run('apply_edits', { snapshotToken: token, operations: [{ name: 'spark_designer_update_document', arguments: { ...target, snapshotToken: token, patch: { name: 'Wrong' } } }] }), /once on the batch/);
  assert.equal(commits, 0);
});
const execution = (id, index) => ({ projectId: 'ask-workshop', executionBatchId: id, executionBatchIndex: index });
await check('adjacent trusted draft calls advance the original token only within their model response', async () => {
  const initial = token;
  await run('update_document', { ...target, snapshotToken: initial, patch: { name: 'First' } }, execution('one', 0));
  await run('update_document', { ...target, snapshotToken: initial, patch: { width: 1200 } }, execution('one', 1));
  await run('update_document', { ...target, snapshotToken: initial, patch: { height: 900 } }, execution('one', 2));
  assert.equal(commits, 3); assert.equal(state.screens[0].name, 'First'); assert.equal(state.screens[0].height, 900);
  await assert.rejects(run('update_document', { ...target, snapshotToken: initial, patch: { name: 'Stale' } }, execution('two', 0)), /draft changed/);
});
await check('manual edits and intervening tool calls break snapshot chaining', async () => {
  const initial = token;
  await run('update_document', { ...target, snapshotToken: initial, patch: { name: 'First' } }, execution('barrier', 0));
  await assert.rejects(run('update_document', { ...target, snapshotToken: initial, patch: { name: 'Skipped' } }, execution('barrier', 2)), /draft changed/);
  token = 'manual-edit';
  await assert.rejects(run('update_document', { ...target, snapshotToken: initial, patch: { name: 'Clobber' } }, execution('barrier', 1)), /draft changed/);
  assert.equal(state.screens[0].name, 'First');
});
await check('save still requires the exact latest snapshot and model arguments cannot authorize a chain', async () => {
  const initial = token;
  await run('update_document', { ...target, snapshotToken: initial, patch: { name: 'First' } }, execution('save', 0));
  await assert.rejects(run('save', { snapshotToken: initial }, execution('save', 1)), /draft changed/);
  await assert.rejects(run('update_document', { ...target, snapshotToken: initial, patch: { name: 'Wrong' }, executionBatchId: 'save', executionBatchIndex: 1 }), /draft changed/);
});
await check('opening an existing document returns selected context without mutating the project', async () => {
  state.templates.push({ id: 'motor', name: 'Motor', width: 100, height: 100, components: [] });
  const result = await run('open_document', { documentId: 'motor', documentKind: 'template' });
  assert.equal(documentId, 'motor'); assert.equal(documentKind, 'template'); assert.deepEqual(selection, []);
  assert.equal(result.contextUpdate.documentName, 'Motor'); assert.equal(result.contextUpdate.snapshotToken, token); assert.equal(commits, 0);
  await assert.rejects(run('open_document', { documentId: 'missing', documentKind: 'screen' }), /no longer exists/);
});
await check('canvas capture returns image bytes separately from the bounded tool receipt', async () => {
  const receipt = await run('capture_canvas');
  assert.equal(receipt.images[0].data, 'cGl4ZWxz'); assert.equal(receipt.result.width, 1000); assert.equal(receipt.result.documentId, 'home');
  assert.ok(!JSON.stringify(receipt.result).includes('cGl4ZWxz')); assert.equal(commits, 0);
  capture = async () => { token = 'manual-edit'; return { data: 'x' }; };
  await assert.rejects(run('capture_canvas'), /changed during capture/);
});
console.log(`${passed} Ask Spark designer checks passed.`);
