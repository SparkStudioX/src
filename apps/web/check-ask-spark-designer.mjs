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
