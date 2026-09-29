#!/usr/bin/env node
// Isolated gateway only. Creates project fixtures and archives all of them on completion.
// Tests do not configure connections, execute imported scripts, or touch gateway databases/tags.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync, deflateSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.equal(process.argv.length <= 3, true);
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Tests require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.hash && !base.search);
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const created = [];
const expectedCatalog = () => request('/api/projects').then(result => result.projects.map(project => project.id).sort());
async function request(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: body === undefined && raw === undefined ? {} : { 'Content-Type': raw === undefined ? 'application/json' : 'application/zip' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 500)}`);
  return binary ? { response, bytes } : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const scoped = (id, path) => `/api/projects/${encodeURIComponent(id)}${path}`;
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (~crc) >>> 0; }
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const bytes = Buffer.from(entry.data); const compressed = deflateRawSync(bytes); const crc = (crc32(bytes) ^ (entry.badCrc ? 1 : 0)) >>> 0; const size = entry.declaredSize ?? bytes.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE((entry.attributes ?? 0) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function unzip(bytes) {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50); const nameLength = bytes.readUInt16LE(offset + 28); const extra = bytes.readUInt16LE(offset + 30); const comment = bytes.readUInt16LE(offset + 32); const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength); const local = bytes.readUInt32LE(offset + 42); const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28); const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)); const method = bytes.readUInt16LE(offset + 10); const data = method === 0 ? compressed : inflateRawSync(compressed);
    assert.equal(data.length, bytes.readUInt32LE(offset + 24)); assert.equal(crc32(data), bytes.readUInt32LE(offset + 16)); entries.push({ name, data }); offset += 46 + nameLength + extra + comment;
  }
  return entries;
}
function png(green = false) {
  const chunk = (type, data) => { const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(green ? [0, 0, 255, 0, 255] : [0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const json = entries => Object.fromEntries(entries.filter(entry => entry.name.endsWith('.json')).map(entry => [entry.name, JSON.parse(entry.data)]));
function changeJson(entries, filename, edit) { return entries.map(entry => entry.name === filename ? { ...entry, data: Buffer.from(JSON.stringify(edit(JSON.parse(entry.data)))) } : entry); }
async function importPackage(bytes, suffix = '') { const imported = await request(`/api/projects/import?name=${encodeURIComponent(`Package imported ${run}${suffix}`)}`, { method: 'POST', raw: bytes }); created.push(imported.id); return imported; }
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`PASS ${name}`); }
let original; let originalDraft; let exported; let entries; let sourceAssets; let image;
try {
  original = await request('/api/projects', { method: 'POST', body: { name: `Package source ${run}` } }); created.push(original.id);
  image = png();
  const asset = await request(scoped(original.id, '/assets'), { method: 'POST', body: { name: 'Package red.png', contentType: 'image/png', dataBase64: image.toString('base64') } });
  await request(scoped(original.id, '/assets'), { method: 'POST', body: { name: 'Unreferenced green.png', contentType: 'image/png', dataBase64: png(true).toString('base64') } });
  sourceAssets = asset;
  originalDraft = await request(scoped(original.id, '/project'));
  originalDraft.screens[0].components = [{ id: 'logo', type: 'image', x: 20, y: 20, width: 80, height: 80, props: { assetId: asset.id, fit: 'contain', text: 'Portable image' } }, { id: 'caption', type: 'label', x: 120, y: 20, width: 300, height: 40, props: { text: 'Published caption' } }];
  originalDraft.extraGatewayConfiguration = { password: 'synthetic-do-not-export', server: 'synthetic-private-host' };
  originalDraft = await request(scoped(original.id, '/project'), { method: 'PUT', body: originalDraft });
  await request(scoped(original.id, '/project/publish'), { method: 'POST', body: { revision: originalDraft.revision } });
  originalDraft.screens[0].components[1].props.text = 'Draft caption'; originalDraft = await request(scoped(original.id, '/project'), { method: 'PUT', body: originalDraft });
  await request(scoped(original.id, '/queries/lookup'), { method: 'PUT', body: { name: 'Portable query', connectionId: `external-${run}`, sql: 'SELECT @amount AS Amount', parameters: [{ name: 'amount', type: 'int', defaultValue: 2 }] } });
  const scripts = await request(scoped(original.id, '/scripts/resources'));
  scripts.resources = [{ id: 'portable_library', name: 'portable_library', type: 'library', enabled: true, code: 'def echo(value):\n    return value\n', parameters: {} }, { id: 'client_start', name: 'Client start', type: 'client', event: 'startup', enabled: true, code: 'app.notify("Imported scripts require publication");', parameters: {} }, { id: 'gateway_timer', name: 'Timer draft', type: 'gateway', event: 'timer', intervalMs: 1000, enabled: false, code: 'print("Draft timer")', parameters: {} }];
  const savedScripts = await request(scoped(original.id, '/scripts/resources'), { method: 'PUT', body: scripts });
  await request(scoped(original.id, '/scripts/publish'), { method: 'POST', body: { revision: savedScripts.revision } });
  await test('export contains only the latest draft, named queries, draft scripts, and referenced images', async () => {
    const result = await request(scoped(original.id, '/export'), { binary: true }); exported = result.bytes; entries = unzip(exported); const files = json(entries);
    assert.match(result.response.headers.get('content-disposition'), /\.sparkproj/);
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json', `assets/${asset.id}.bin`, `assets/${asset.id}.json`].sort());
    assert.equal(files['project.json'].screens[0].components[1].props.text, 'Draft caption');
    assert.equal(files['project.json'].extraGatewayConfiguration, undefined);
    assert.ok(!entries.some(entry => /published|connection[s.]|database|tags\.json/.test(entry.name)));
    assert.equal(files['manifest.json'].format, 'sparkstudio-project'); assert.equal(files['manifest.json'].formatVersion, 1); assert.equal(files['manifest.json'].content, 'draft-only');
    assert.deepEqual(files['manifest.json'].connectionDependencies, [{ id: `external-${run}`, name: `external-${run}` }]);
    assert.deepEqual(files['scripts-draft.json'].resources.map(resource => resource.id), scripts.resources.map(resource => resource.id));
  });
  await test('import creates independent unpublished projects and preserves resource identities and exact image bytes', async () => {
    const imported = await importPackage(exported); const second = await importPackage(exported, ' copy');
    assert.notEqual(imported.id, original.id); assert.notEqual(second.id, imported.id); assert.equal(imported.published, false);
    const project = await request(scoped(imported.id, '/project')); assert.equal(project.revision, 0); assert.equal(project.id, imported.id); assert.deepEqual(project.screens, json(entries)['project.json'].screens);
    assert.equal((await request(scoped(imported.id, '/project/publication'))).published, false);
    assert.equal((await request(scoped(imported.id, '/scripts/publication'))).published, false);
    assert.deepEqual((await request(scoped(imported.id, '/scripts/resources'))).resources, json(entries)['scripts-draft.json'].resources);
    assert.equal((await request(scoped(imported.id, '/queries')))[0].connectionId, `external-${run}`);
    assert.deepEqual((await request(scoped(imported.id, `/assets/${asset.id}`), { binary: true })).bytes, image);
    assert.equal((await request(scoped(imported.id, '/assets'))).length, 1);
    assert.deepEqual((await request(scoped(imported.id, '/runtime/scripts'))).resources, []);
    project.screens[0].components[1].props.text = 'Independent edit'; await request(scoped(imported.id, '/project'), { method: 'PUT', body: project });
    assert.equal((await request(scoped(original.id, '/project'))).screens[0].components[1].props.text, 'Draft caption');
  });
  const reject = async bytes => {
    const before = await expectedCatalog();
    let response;
    try {
      response = await fetch(new URL('/api/projects/import', base), { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    } catch (error) {
      // Kestrel may close an oversized request before fetch finishes streaming
      // its body. Only that size-limit case permits a reset, and the gateway
      // must still answer with an unchanged catalog before the test can pass.
      if (bytes.length <= 32 * 1024 * 1024 || error.cause?.code !== 'ECONNRESET') throw error;
      assert.deepEqual(await expectedCatalog(), before, 'Oversized uploads must leave the gateway available and its catalog unchanged.');
      return;
    }
    const raw = await response.text();
    // Capture a regression-created project before asserting, so finally still
    // archives it if malformed content was unexpectedly accepted.
    if (response.ok) { const result = JSON.parse(raw); if (result.id) created.push(result.id); }
    assert.ok([400, 413].includes(response.status), `Invalid package returned ${response.status}: ${raw.slice(0, 500)}`);
    assert.deepEqual(await expectedCatalog(), before, 'Rejected archives must not create catalog entries.');
  };
  const rejectEntries = altered => reject(zip(altered));
  await test('archive paths, unknown files, duplicates, directories, symlinks, and reparse entries are rejected before creation', async () => {
    for (const name of ['../project.json', '/project.json', 'C:/project.json', 'assets\\fake.bin', 'connections.json', 'published.json', 'assets/']) await rejectEntries([...entries, { name, data: Buffer.from('{}') }]);
    await rejectEntries([...entries, entries[0]]); await rejectEntries([...entries, { ...entries[0], name: entries[0].name.toUpperCase() }]);
    await rejectEntries(entries.map((entry, index) => index ? entry : { ...entry, attributes: (0xa1ff << 16) >>> 0 }));
    await rejectEntries(entries.map((entry, index) => index ? entry : { ...entry, attributes: 0x400 }));
  });
  await test('unsupported manifest versions and publication content are rejected', async () => {
    for (const patch of [{ formatVersion: 2 }, { format: 'other' }, { content: 'published' }, { connectionDependencies: [] }, { connectionDependencies: [{ id: `external-${run}`, name: 'Connection', password: 'forbidden' }] }]) await rejectEntries(changeJson(entries, 'manifest.json', value => ({ ...value, ...patch })));
    await rejectEntries(entries.filter(entry => entry.name !== 'queries.json'));
    await rejectEntries(entries.map(entry => entry.name === 'manifest.json' ? { ...entry, data: Buffer.from(entry.data.toString().replace('{', '{"format":"duplicate",')) } : entry));
  });
  await test('all query definitions, script resources, and project fields are validated before catalog mutation', async () => {
    for (const edit of [value => [...value, 42], value => [...value, value[0]], value => [{ ...value[0], parameters: {} }], value => [{ ...value[0], parameters: [{ name: 'amount', type: 'unsupported' }] }], value => [{ ...value[0], parameters: [{ name: 'amount', type: 'int', defaultValue: {} }] }], value => [{ ...value[0], parameters: [{ name: 'amount', type: 'int' }, { name: '@amount', type: 'int' }] }]]) await rejectEntries(changeJson(entries, 'queries.json', edit));
    await rejectEntries(changeJson(entries, 'scripts-draft.json', value => ({ ...value, resources: [...value.resources, null] })));
    await rejectEntries(changeJson(entries, 'project.json', value => ({ ...value, screens: 'invalid' })));
    await rejectEntries(changeJson(entries, 'project.json', value => ({ ...value, connections: [] })));
  });
  await test('image metadata, content integrity, missing pairs, unreferenced assets, and 512 KiB bounds are enforced', async () => {
    await rejectEntries(changeJson(entries, `assets/${sourceAssets.id}.json`, value => ({ ...value, width: 2 })));
    await rejectEntries(entries.map(entry => entry.name.endsWith('.bin') ? { ...entry, data: Buffer.from('not an image') } : entry));
    await rejectEntries(entries.filter(entry => !entry.name.endsWith('.bin')));
    await rejectEntries(changeJson(entries, 'project.json', value => ({ ...value, screens: value.screens.map(screen => ({ ...screen, components: screen.components.filter(component => component.type !== 'image') })) })));
    await rejectEntries(entries.map(entry => entry.name.endsWith('.bin') ? { ...entry, declaredSize: 512 * 1024 + 1 } : entry));
  });
  await test('invalid ZIPs, excessive entry counts, and expanded-size declarations are rejected', async () => {
    await reject(Buffer.from('not a zip archive'));
    await rejectEntries(Array.from({ length: 1029 }, () => entries[0]));
    await rejectEntries(entries.map((entry, index) => index ? entry : { ...entry, declaredSize: 64 * 1024 * 1024 + 1 }));
    await rejectEntries(entries.map((entry, index) => index ? entry : { ...entry, declaredSize: 1 }));
    await rejectEntries(entries.map((entry, index) => index ? entry : { ...entry, badCrc: true }));
    await reject(Buffer.alloc(32 * 1024 * 1024 + 1));
  });
} finally {
  for (const id of created.reverse()) await request(scoped(id, '/archive'), { method: 'POST', body: { archived: true } });
}
console.log(`${passed}/${passed} project package checks passed; fixture projects archived.`);
