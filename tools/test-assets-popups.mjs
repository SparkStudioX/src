#!/usr/bin/env node
// Isolated gateway only. Restores the original project and its publication.
// Uploaded immutable test assets remain; no asset-deletion API exists.
// Run again with --verify-persistence after restarting the same gateway/data directory.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
assert.ok(args.every(arg => !arg.startsWith('--') || arg === '--verify-persistence'));
const urls = args.filter(arg => !arg.startsWith('--'));
assert.ok(urls.length <= 1);
const base = new URL(urls[0] ?? 'http://127.0.0.1:5091');
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Tests require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12);
  buffer.writeUInt32BE(data.length); buffer.write(type, 4); data.copy(buffer, 8);
  let crc = 0xffffffff;
  for (const value of buffer.subarray(4, -4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  buffer.writeUInt32BE((~crc) >>> 0, buffer.length - 4);
  return buffer;
}
function png(red = true, width = 2, height = 1, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanline = Buffer.from(red ? [0, 255, 0, 0, 255, 0, 0, 255, 255] : [0, 0, 255, 0, 255, 255, 255, 0, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(scanline)), chunk('IEND', Buffer.alloc(0))]);
}
// Original two-pixel JPEG fixture encoded from red and blue pixels with the Windows image encoder.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4H8Q/8h/Uv+vmX/0M0UUV/ptkP/Ipwn/XuH/pKPAzr/kZ4r/r5P8A9KZ//9k=', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=', 'base64').subarray(0, 42);
const fixtures = [
  { name: 'sparkstudio-test-red.png', contentType: 'image/png', bytes: png(), width: 2, height: 1 },
  { name: 'sparkstudio-test-green.png', contentType: 'image/png', bytes: png(false), width: 2, height: 1 },
  { name: 'sparkstudio-test.jpg', contentType: 'image/jpeg', bytes: jpeg, width: 2, height: 1 },
  { name: 'sparkstudio-test.webp', contentType: 'image/webp', bytes: webp, width: 1, height: 1 },
];
async function request(path, { method = 'GET', body, rawBody, status = 200, binary = false, headers = {} } = {}) {
  const response = await fetch(new URL(path, base), {
    method, headers: { ...(body === undefined && rawBody === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (binary) { assert.equal(response.status, status); return { response, bytes: Buffer.from(await response.arrayBuffer()) }; }
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${raw.slice(0, 600)}`);
  return raw ? JSON.parse(raw) : null;
}
const upload = (fixture, overrides = {}, status = 200) => request('/api/assets', { method: 'POST', body: { name: fixture.name, contentType: fixture.contentType, dataBase64: fixture.bytes.toString('base64'), ...overrides }, status });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function verifyAssets() {
  const listed = await request('/api/assets');
  for (const fixture of fixtures) {
    const id = sha(fixture.bytes);
    const metadata = listed.find(asset => asset.id === id);
    assert.ok(metadata, `Persisted asset ${fixture.name} is missing.`);
    assert.deepEqual([metadata.contentType, metadata.size, metadata.width, metadata.height], [fixture.contentType, fixture.bytes.length, fixture.width, fixture.height]);
    const { response, bytes } = await request(`/api/assets/${id}`, { binary: true });
    assert.equal(response.headers.get('content-type'), fixture.contentType);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('etag'), `"${id}"`);
    assert.deepEqual(bytes, fixture.bytes);
  }
}
if (args.includes('--verify-persistence')) {
  await test('all four immutable assets survive a gateway restart with metadata and exact bytes', verifyAssets);
  process.exit(0);
}

const original = await request('/api/project');
const originalQueries = await request('/api/queries');
const runId = randomUUID().replaceAll('-', '');
const paths = ['A', 'B'].map(name => `[default]PopupTests/${runId}/${name}`);
const created = [];
let changed = false;
let failure;
let publishedAt;
const component = (id, type, props, y = 0) => ({ id, type, x: 0, y, width: 240, height: 50, props });
const publish = revision => request('/api/project/publish', { method: 'POST', body: { revision } });
const readValues = async () => (await request('/api/tags/read', { method: 'POST', body: { paths } })).map(tag => tag.value);
const origin = (instanceId = 'first', rowId) => ({ screenId: 'main', componentId: 'open', instanceId, ...(rowId ? { rowId } : {}) });
const action = (body = {}, { screenId = 'detail', componentId = 'commit', status = 200 } = {}) => request(`/api/runtime/screens/${screenId}/components/${componentId}/action`, {
  method: 'POST', body: { publishedAt, ...(screenId === 'detail' ? { instanceId: 'form' } : {}), ...body }, status,
});

try {
  await test('PNG, JPEG and WebP uploads produce bounded metadata and immutable matching bytes', async () => {
    for (const fixture of fixtures) {
      const metadata = await upload(fixture);
      assert.equal(metadata.id, sha(fixture.bytes));
      assert.deepEqual([metadata.contentType, metadata.size, metadata.width, metadata.height], [fixture.contentType, fixture.bytes.length, fixture.width, fixture.height]);
    }
    await verifyAssets();
  });
  await test('identical content deduplicates without renaming or changing an existing asset', async () => {
    const first = await upload(fixtures[0]);
    const second = await upload(fixtures[0], { name: 'different-name.png' });
    assert.deepEqual(second, first);
    await verifyAssets();
  });
  await test('malformed images, mismatched MIME, animation, dimensions and upload sizes are rejected', async () => {
    const corrupted = Buffer.from(fixtures[0].bytes); corrupted[30] ^= 1;
    const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
    const animatedWebp = Buffer.alloc(30); animatedWebp.write('RIFF'); animatedWebp.writeUInt32LE(22, 4); animatedWebp.write('WEBPVP8X', 8); animatedWebp.writeUInt32LE(10, 16); animatedWebp[20] = 2;
    const invalid = [
      { name: '../escape.png' }, { name: 'bad\\name.png' }, { name: 'x'.repeat(121) }, { name: 'bad\nname.png' },
      { contentType: 'image/svg+xml' }, { contentType: 'image/jpeg' }, { dataBase64: 'not valid base64!' },
      { dataBase64: 'data:image/png;base64,' + fixtures[0].bytes.toString('base64') },
      { dataBase64: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') },
      { dataBase64: corrupted.toString('base64') }, { dataBase64: fixtures[0].bytes.subarray(0, 33).toString('base64') },
      { dataBase64: png(true, 8193).toString('base64') }, { dataBase64: png(true, 8192, 8192).toString('base64') },
      { dataBase64: png(true, 2, 1, [chunk('acTL', animation)]).toString('base64') },
      { contentType: 'image/webp', dataBase64: animatedWebp.toString('base64') },
      { dataBase64: Buffer.alloc(512 * 1024 + 1).toString('base64') },
    ];
    for (const overrides of invalid) await upload(fixtures[0], overrides, 400);
    await request('/api/assets', { method: 'POST', body: { name: 'huge.png', contentType: 'image/png', dataBase64: 'A'.repeat(1_048_576) }, status: 413 });
    await request('/api/assets', { method: 'POST', rawBody: '{', status: 400 });
  });
  await test('asset IDs reject paths, URLs, uppercase, terminal newline and missing content', async () => {
    const id = sha(fixtures[0].bytes);
    for (const invalid of ['../project.json', '..\\project.json', 'https://example.com/image.png', id.toUpperCase(), id + '\n', id + '/extra', 'short'])
      await request(`/api/assets/${encodeURIComponent(invalid)}`, { status: 400 });
    await request(`/api/assets/${'0'.repeat(64)}`, { status: 404 });
    await verifyAssets();
  });

  for (const path of paths) {
    await request('/api/tags', { method: 'POST', body: { path, kind: 'memory', dataType: 'Double', value: 0, enabled: true } });
    created.push(path);
  }
  const script = "# popup-private-source\nquality = system.tag.writeBlocking([parameters['target']], [inputs['setpoint']])[0]\nassert quality.isGood()\nresult = {'marker':'popup-v1','parameters':parameters,'inputs':inputs}";
  const project = {
    ...structuredClone(original), name: 'Assets and popup tests', parameters: { area: 'Area1', token: '{area}' },
    templates: [
      { id: 'opener', name: 'Saved opener', width: 300, height: 200, parameters: { path: paths[0], title: 'Machine {area}' }, components: [
        component('open', 'button', { action: 'openPopup', targetScreenId: 'detail', parameters: { target: '{path}', title: '{title}' } }),
        component('icon', 'icon', { icon: 'settings' }, 60),
      ] },
      { id: 'popup-form', name: 'Popup form', width: 300, height: 300, parameters: { target: '{target}', title: '{title}', area: 'Target-{area}', once: '{token}' }, components: [
        component('input', 'numberInput', { fieldKey: 'setpoint', defaultValue: 5, min: 0, max: 100 }),
        component('commit', 'button', { action: 'script', script }, 60),
        component('close', 'button', { action: 'closePopup' }, 120),
        component('image', 'image', { assetId: sha(fixtures[0].bytes), fit: 'contain', alt: 'Local red and blue sample' }, 180),
      ] },
    ],
    screens: [
      { id: 'main', name: 'Regular screen', kind: 'screen', width: 1000, height: 700, parameters: { area: 'Screen-{area}', label: 'Label {area}' }, components: [
        component('first', 'template', { templateId: 'opener', parameters: { path: paths[0] } }),
        component('second', 'template', { templateId: 'opener', parameters: { path: paths[1] } }, 60),
        component('orders', 'repeater', { templateId: 'opener', columns: 2, gap: 8, rows: [{ id: 'a', parameters: { path: paths[0], title: 'Row A {area}' } }, { id: 'b', parameters: { path: paths[1], title: 'Row B {area}' } }] }, 120),
        component('direct', 'button', { action: 'script', script: 'result = parameters' }, 180),
        component('navigate', 'button', { action: 'navigate', targetScreenId: 'main' }, 240),
        component('other-opener', 'button', { action: 'openPopup', targetScreenId: 'other' }, 300),
      ] },
      { id: 'detail', name: 'Detail popup', kind: 'popup', width: 500, height: 450, parameters: { target: paths[0], title: 'Popup {area}', caption: 'Detail {area}' }, components: [
        component('form', 'template', { templateId: 'popup-form', parameters: {} }),
        component('icon', 'icon', { icon: 'info' }, 300),
      ] },
      { id: 'other', name: 'Other popup', kind: 'popup', width: 400, height: 300, parameters: {}, components: [
        component('direct', 'button', { action: 'script', script: "result = 'other'" }),
        component('image', 'image', { assetId: sha(fixtures[1].bytes), fit: 'cover', alt: 'Local green sample' }, 60),
      ] },
    ],
  };
  let draft = await request('/api/project', { method: 'PUT', body: { ...project, revision: (await request('/api/project')).revision } });
  changed = true;
  await publish(draft.revision);
  publishedAt = (await request('/api/runtime/project')).publishedAt;

  await test('published regular and popup screens retain image/icon definitions while all scripts stay hidden', async () => {
    const runtime = await request('/api/runtime/project');
    assert.equal(runtime.screens.find(screen => screen.id === 'detail').kind, 'popup');
    for (const document of [...runtime.screens, ...runtime.templates])
      for (const item of document.components) assert.ok(!Object.hasOwn(item.props, 'script'));
    assert.ok(!JSON.stringify(runtime).includes('popup-private-source'));
    assert.equal(runtime.templates.find(template => template.id === 'popup-form').components.find(item => item.type === 'image').props.assetId, sha(fixtures[0].bytes));
    await verifyAssets();
  });
  await test('regular screen defaults resolve once against validated root context', async () => {
    const result = await action({ parameters: { area: 'Area2' } }, { screenId: 'main', componentId: 'direct' });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.area, 'Screen-Area2');
    assert.equal(result.result.label, 'Label Area2');
    await action({ parameters: { label: 'Forged screen value' } }, { screenId: 'main', componentId: 'direct', status: 400 });
  });
  await test('popup context derives saved instance opener, target defaults and target-template parameters once', async () => {
    const result = await action({ popupOrigin: origin(), parameters: { area: 'Area2' }, inputs: { setpoint: 11 } });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.target, paths[0]);
    assert.equal(result.result.parameters.title, 'Machine Screen-Area2');
    assert.equal(result.result.parameters.caption, 'Detail Area2');
    assert.equal(result.result.parameters.area, 'Target-Area2');
    assert.equal(result.result.parameters.once, '{area}');
    assert.deepEqual(await readValues(), [11, 0]);
    const second = await action({ popupOrigin: origin('second'), inputs: { setpoint: 22 } });
    assert.equal(second.success, true, second.stderr);
    assert.deepEqual(await readValues(), [11, 22]);
  });
  await test('repeater-row popup provenance selects only the saved row context and tag target', async () => {
    const result = await action({ popupOrigin: origin('orders', 'b'), inputs: { setpoint: 33 } });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.parameters.title, 'Row B Screen-Area1');
    assert.equal(result.result.parameters.target, paths[1]);
    assert.deepEqual(await readValues(), [11, 33]);
  });
  await test('missing or forged popup provenance, caller fields and context overrides cannot execute scripts', async () => {
    const baseline = await readValues();
    const cases = [
      [{}, {}, 400], [{ popupOrigin: {} }, {}, 400],
      [{ popupOrigin: { screenId: 'missing', componentId: 'open' } }, {}, 404],
      [{ popupOrigin: { screenId: 'other', componentId: 'direct' } }, {}, 400],
      [{ popupOrigin: { screenId: 'main', componentId: 'navigate' } }, {}, 400],
      [{ popupOrigin: { screenId: 'main', componentId: 'other-opener' } }, {}, 400],
      [{ popupOrigin: origin('missing') }, {}, 404],
      [{ popupOrigin: origin('orders') }, {}, 400],
      [{ popupOrigin: origin('orders', 'missing') }, {}, 404],
      [{ popupOrigin: origin('first', 'a') }, {}, 400],
      [{ popupOrigin: origin(), instanceId: 'missing' }, {}, 404],
      [{ popupOrigin: origin(), rowId: 'a' }, {}, 400],
      [{ popupOrigin: origin(), parameters: { target: paths[1] } }, {}, 400],
      [{ popupOrigin: origin(), parameters: { area: false } }, {}, 400],
      [{ popupOrigin: origin(), inputs: { unknown: 1 } }, {}, 400],
      [{ popupOrigin: origin(), inputs: { setpoint: 101 } }, {}, 400],
      [{ popupOrigin: origin() }, { screenId: 'main', componentId: 'direct' }, 400],
      [{ popupOrigin: origin() }, { componentId: 'close' }, 404],
    ];
    for (const [body, target, status] of cases) await action(body, { ...target, status });
    assert.deepEqual(await readValues(), baseline);
    const result = await action({ popupOrigin: origin(), popupParameters: { target: paths[1] }, inputs: { setpoint: 12 }, code: "raise Exception('untrusted code')" });
    assert.equal(result.success, true, result.stderr);
    assert.deepEqual(await readValues(), [12, 33]);
  });
  await test('publication rejects invalid popup navigation, declarations, local images and icons without replacing the release', async () => {
    const metadata = await request('/api/project/publication');
    const invalid = [
      value => { value.screens[0].kind = 'popup'; },
      value => { value.screens[0].kind = 'invalid'; },
      value => { value.screens[1].parameters.target = 1; },
      value => { value.screens[1].parameters.title = '{unknownRoot}'; },
      value => { value.templates[0].components[0].props.targetScreenId = 'main'; },
      value => { value.templates[0].components[0].props.parameters.unknown = 'bad'; },
      value => { value.templates[0].components[0].props.parameters.title = '{unknownCaller}'; },
      value => { value.screens[0].components.find(item => item.id === 'navigate').props.targetScreenId = 'detail'; },
      value => { value.screens[0].components.find(item => item.id === 'navigate').props.parameters = { area: 'override' }; },
      value => { value.screens[1].components.push(component('nested-popup', 'button', { action: 'openPopup', targetScreenId: 'other' })); },
      value => { value.screens[1].components.push(component('nested-template', 'template', { templateId: 'opener' })); },
      value => { value.screens[0].components.push(component('close', 'button', { action: 'closePopup' })); },
      value => { value.templates[1].components.find(item => item.type === 'image').props.assetId = '0'.repeat(64); },
      value => { value.screens[2].components.find(item => item.type === 'image').props.assetId = 'https://example.com/image.png'; },
      value => { value.screens[2].components.find(item => item.type === 'image').props.fit = 'invalid'; },
      value => { value.screens[2].components.find(item => item.type === 'image').props.src = 'https://example.com/image.png'; },
      value => { value.templates[0].components.find(item => item.type === 'icon').props.icon = '<svg/>'; },
    ];
    for (const mutate of invalid) {
      const value = structuredClone(project); value.revision = (await request('/api/project')).revision; mutate(value);
      const saved = await request('/api/project', { method: 'PUT', body: value });
      await request('/api/project/publish', { method: 'POST', body: { revision: saved.revision }, status: 400 });
      assert.deepEqual(await request('/api/project/publication'), metadata);
    }
  });
  await test('draft opener mapping, popup code, input defaults and image changes stay isolated from publication', async () => {
    const value = structuredClone(project); value.revision = (await request('/api/project')).revision;
    value.screens[0].components.find(item => item.id === 'first').props.parameters.path = paths[1];
    value.templates[1].components.find(item => item.id === 'commit').props.script = script.replace('popup-v1', 'popup-v2');
    value.templates[1].components.find(item => item.id === 'input').props.defaultValue = 8;
    value.templates[1].components.find(item => item.type === 'image').props.assetId = sha(fixtures[1].bytes);
    draft = await request('/api/project', { method: 'PUT', body: value });
    const result = await action({ popupOrigin: origin() });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.marker, 'popup-v1');
    assert.equal(result.result.parameters.target, paths[0]);
    assert.equal(result.result.inputs.setpoint, 5);
    assert.equal((await request('/api/runtime/project')).templates[1].components.find(item => item.type === 'image').props.assetId, sha(fixtures[0].bytes));
    assert.deepEqual(await readValues(), [5, 33]);
  });
  await test('republishing atomically switches popup provenance, code and assets and rejects the stale opener token', async () => {
    await publish(draft.revision);
    await action({ popupOrigin: origin() }, { status: 409 });
    assert.deepEqual(await readValues(), [5, 33]);
    publishedAt = (await request('/api/runtime/project')).publishedAt;
    const result = await action({ popupOrigin: origin() });
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.marker, 'popup-v2');
    assert.equal(result.result.parameters.target, paths[1]);
    assert.deepEqual(await readValues(), [5, 8]);
    await verifyAssets();
  });
} catch (error) {
  failure = error;
  console.error(error.stack ?? error);
} finally {
  if (changed) {
    try {
      const current = await request('/api/project');
      const restored = await request('/api/project', { method: 'PUT', body: { ...original, revision: current.revision } });
      await publish(restored.revision);
      const actual = await request('/api/project'); actual.revision = original.revision;
      assert.deepEqual(actual, original); assert.deepEqual(await request('/api/queries'), originalQueries);
      console.log('PASS original project restored and republished; named queries unchanged');
    } catch (error) { failure ??= error; console.error(`Project cleanup failed: ${error.stack ?? error}`); }
  }
  for (const path of created) {
    try { await request(`/api/tag-definitions?path=${encodeURIComponent(path)}`, { method: 'DELETE', status: 204 }); }
    catch (error) { failure ??= error; console.error(`Tag cleanup failed: ${error.stack ?? error}`); }
  }
}
console.log(`${passed} assets/popup checks passed${failure ? '; test failed' : ''}. Four small immutable image fixtures remain for persistence verification.`);
if (failure) process.exitCode = 1;
