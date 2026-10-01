#!/usr/bin/env node
// Synthetic streams/PNGs only. Never opens a camera or contacts a remote service.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const modules = new Map();
async function model(name) {
  if (modules.has(name)) return modules.get(name);
  const source = await readFile(new URL(`../apps/web/src/${name.endsWith('.json') ? name : name + '.ts'}`, import.meta.url), 'utf8');
  let code = name.endsWith('.json') ? 'export default ' + JSON.stringify(JSON.parse(source)) : stripTypeScriptTypes(source, { mode: 'transform' });
  for (const match of [...code.matchAll(/from\s+(["'])\.\/([^"']+)\1/g)]) code = code.replace(match[0], `from ${JSON.stringify(await model(match[2]))}`);
  const uri = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); modules.set(name, uri); return uri;
}
const { ComputerCameraController, cameraInputValue } = await import(await model('computerCameraModel'));
const { isInput, initialInput, resolveInputs, validateInputs, stateInputError } = await import(await model('inputs'));
const { inputDefinitionError } = await import(await model('inputValidation'));
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const image = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' });
function fixture() {
  const snapshots = [], inputs = [], revoked = [], attached = [], streams = [];
  let opening, capturing, urls = 0;
  const stream = () => { const item = { stopped: 0, getTracks: () => [{ stop: () => item.stopped++ }] }; streams.push(item); return item; };
  const controller = new ComputerCameraController({
    open: () => opening?.promise ?? Promise.resolve(stream()), capture: () => capturing?.promise ?? Promise.resolve(image),
    createUrl: () => `blob:http://localhost:5091/photo-${++urls}`, revokeUrl: url => revoked.push(url), attach: value => attached.push(value),
  }, state => snapshots.push(state), value => inputs.push(value));
  controller.activate();
  return { controller, snapshots, inputs, revoked, attached, streams, stream, setOpening: value => opening = value, setCapturing: value => capturing = value };
}
await test('camera starts only on an explicit request, captures once and stops tracks', async () => {
  const test = fixture(); assert.deepEqual(test.streams, []); assert.deepEqual(test.inputs, []);
  await test.controller.start(); assert.equal(test.snapshots.at(-1).phase, 'live');
  await test.controller.capture(); assert.equal(test.snapshots.at(-1).phase, 'captured');
  assert.equal(test.inputs.at(-1), 'blob:http://localhost:5091/photo-1'); assert.equal(test.streams[0].stopped, 1);
  await test.controller.capture(); assert.equal(test.inputs.filter(Boolean).length, 1);
});
await test('retake revokes the old photo; reset clears the form and stops the camera', async () => {
  const test = fixture(); await test.controller.start(); await test.controller.capture();
  await test.controller.start(); assert.deepEqual(test.revoked, ['blob:http://localhost:5091/photo-1']);
  assert.equal(test.inputs.at(-1), ''); assert.equal(test.snapshots.at(-1).phase, 'live');
  test.controller.reset(); assert.equal(test.streams[1].stopped, 1); assert.equal(test.snapshots.at(-1).phase, 'idle');
});
await test('late camera permission after reset or unmount stops the returned stream', async () => {
  for (const stop of ['reset', 'deactivate']) {
    const test = fixture(), wait = deferred(); test.setOpening(wait);
    const pending = test.controller.start(); test.controller[stop](); const stream = test.stream(); wait.resolve(stream); await pending;
    assert.equal(stream.stopped, 1); assert.ok(!test.snapshots.some(state => state.phase === 'live'));
  }
});
await test('late PNG after unmount produces no photo or object URL', async () => {
  const test = fixture(), wait = deferred(); await test.controller.start(); test.setCapturing(wait);
  const pending = test.controller.capture(); test.controller.deactivate(); wait.resolve(image); await pending;
  assert.deepEqual(test.inputs.filter(Boolean), []); assert.deepEqual(test.revoked, []); assert.equal(test.streams[0].stopped, 1);
});
await test('duplicate permission and capture requests are ignored', async () => {
  const test = fixture(), permission = deferred(); test.setOpening(permission);
  const first = test.controller.start(); await test.controller.start(); const stream = test.stream(); permission.resolve(stream); await first;
  const imageWait = deferred(); test.setCapturing(imageWait); const capture = test.controller.capture(); await test.controller.capture(); imageWait.resolve(image); await capture;
  assert.equal(test.inputs.filter(Boolean).length, 1); assert.equal(stream.stopped, 1);
});
await test('permission failure is recoverable and explains browser permission', async () => {
  const test = fixture(), wait = deferred(); test.setOpening(wait); const pending = test.controller.start();
  wait.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await pending;
  assert.equal(test.snapshots.at(-1).phase, 'error'); assert.match(test.snapshots.at(-1).error, /permission was denied/);
  test.setOpening(null); await test.controller.start(); assert.equal(test.snapshots.at(-1).phase, 'live');
});
await test('invalid PNG preserves the live camera and allows retry', async () => {
  const test = fixture(), wait = deferred(); await test.controller.start(); test.setCapturing(wait);
  const pending = test.controller.capture(); wait.resolve(new Blob(['not a photo'], { type: 'text/plain' })); await pending;
  assert.equal(test.snapshots.at(-1).phase, 'live'); assert.match(test.snapshots.at(-1).error, /valid PNG/); assert.equal(test.streams[0].stopped, 0);
  test.setCapturing(null); await test.controller.capture(); assert.equal(test.snapshots.at(-1).phase, 'captured');
});
await test('disabled capture keeps a completed photo alive; state reset and unmount revoke it', async () => {
  const test = fixture(); await test.controller.start(); await test.controller.capture(); const url = test.inputs.at(-1);
  test.controller.suspend(); assert.deepEqual(test.revoked, []); assert.equal(test.snapshots.at(-1).imageUrl, url);
  test.controller.synchronize(url); assert.deepEqual(test.revoked, []);
  test.controller.synchronize(''); assert.deepEqual(test.revoked, [url]); assert.equal(test.snapshots.at(-1).phase, 'idle');
  await test.controller.start(); await test.controller.capture(); test.controller.deactivate(); assert.equal(test.revoked.length, 2);
  test.controller.activate(); test.controller.synchronize(test.inputs.at(-1)); assert.equal(test.inputs.at(-1), '', 'a remounted component clears an expired photo reference');
});
const component = { id: 'camera', type: 'computerCamera', x: 0, y: 0, width: 320, height: 380, props: { text: 'Visitor photo', fieldKey: 'visitorPhoto', defaultValue: '' } };
const screen = { id: 'welcome', name: 'Welcome', width: 800, height: 600, components: [component] };
await test('camera is a transient input and required forms reject an absent or remote photo', () => {
  assert.equal(isInput('computerCamera'), true); assert.equal(initialInput(component, [], {}), '');
  assert.deepEqual(resolveInputs(screen, [], {}), { visitorPhoto: '' });
  const required = structuredClone(screen); required.components[0].props.validation = { required: true, message: 'Capture your photo first.' };
  assert.match(validateInputs(required, { visitorPhoto: '' }), /Capture your photo first/);
  for (const value of ['data:image/png;base64,photo', 'https://example.com/photo.png', 'blob:javascript:bad', 'blob:http://localhost/x y']) assert.equal(cameraInputValue(value), false);
  assert.equal(validateInputs(required, { visitorPhoto: 'blob:http://localhost/photo' }), null);
});
await test('camera supports a declared string state binding and rejects saved photo/tag defaults', () => {
  const bound = structuredClone(component); bound.props.stateBinding = { scope: 'screen', key: 'photoUrl' };
  const state = { session: {}, screen: { photoUrl: 'blob:https://example.com/photo' } };
  assert.equal(stateInputError(bound, state), null); assert.equal(initialInput(bound, [], {}, false, state), state.screen.photoUrl);
  assert.equal(inputDefinitionError({ ...component, props: { ...component.props, defaultValue: 'blob:http://localhost/photo' } }), "A computer camera's saved default must be omitted or empty.");
  assert.match(inputDefinitionError({ ...component, props: { ...component.props, tagPath: '' } }), /cannot read tags/);
});
console.log(`${passed} computer camera checks passed.`);
