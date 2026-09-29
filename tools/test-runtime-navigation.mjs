#!/usr/bin/env node
// Isolated API coverage. Own fixture projects are archived; existing projects,
// connections, scripts, tags and application databases are never changed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3 && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Use the isolated gateway on port 5091.');
assert.ok(base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const created = [];
async function request(path, { method = 'GET', body, raw, status = 200, binary = false } = {}) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: body === undefined && raw === undefined ? {} : { 'Content-Type': raw === undefined ? 'application/json' : 'application/zip' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  // If a rejected import regresses, retain its ID so finally still archives it.
  if (path.startsWith('/api/projects/import') && response.ok) created.push(JSON.parse(bytes).id);
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 500)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const scoped = (id, path) => `/api/projects/${encodeURIComponent(id)}${path}`;
const regular = id => ({ id, name: `Screen ${id}`, width: 800, height: 600, parameters: {}, components: [] });
const navigation = { startupScreenId: 'second', mode: 'menu', items: [{ screenId: 'second', label: 'Production' }, { screenId: 'first', label: 'Home' }] };

// Read the actual exported ZIP and rebuild stored entries for invalid-import
// fixtures, preserving the real manifest, draft scripts and query document.
function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  const entries = []; let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength), local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const method = bytes.readUInt16LE(offset + 10); assert.ok(method === 0 || method === 8);
    entries.push({ name, data: method === 0 ? compressed : inflateRawSync(compressed) });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (~crc) >>> 0;
}
function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); records.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`PASS ${name}`); }
try {
  const fixture = await request('/api/projects', { method: 'POST', body: { name: `Navigation fixture ${run}` } });
  created.push(fixture.id);
  const path = suffix => scoped(fixture.id, suffix);
  let saved = await request(path('/project'));
  saved.screens = [{ ...regular('popup'), kind: 'popup' }, regular('first'), regular('second'), regular('unlisted')];
  const save = async draft => saved = await request(path('/project'), { method: 'PUT', body: draft });
  const publish = () => request(path('/project/publish'), { method: 'POST', body: { revision: saved.revision } });
  const runtime = () => request(path('/runtime/project'));
  const reject = async mutate => {
    const invalid = structuredClone(saved); mutate(invalid);
    await request(path('/project'), { method: 'PUT', body: invalid, status: 400 });
    assert.deepEqual(await request(path('/project')), saved, 'Rejected drafts must not change the saved project or revision.');
  };
  await test('legacy projects save and publish without synthesized navigation settings', async () => {
    delete saved.navigation; await save(saved); await publish();
    assert.equal(Object.hasOwn(saved, 'navigation'), false);
    assert.equal(Object.hasOwn(await runtime(), 'navigation'), false);
  });
  await test('startup and ordered explicit menu destinations round-trip through publication', async () => {
    await save({ ...saved, navigation: structuredClone(navigation) }); await publish();
    assert.deepEqual(saved.navigation, navigation);
    assert.deepEqual((await runtime()).navigation, navigation);
    assert.equal((await runtime()).screens.length, 4, 'Unlisted screens remain available to authored buttons and popups.');
  });
  await test('draft navigation edits remain isolated until explicit publication', async () => {
    const next = { startupScreenId: 'first', mode: 'menu', items: [{ screenId: 'first', label: 'Renamed home' }] };
    await save({ ...saved, navigation: next });
    assert.deepEqual((await runtime()).navigation, navigation);
    await publish(); assert.deepEqual((await runtime()).navigation, next);
  });
  await test('menu can be hidden without discarding its saved destinations', async () => {
    const hidden = { ...navigation, mode: 'none' };
    await save({ ...saved, navigation: hidden }); await publish();
    assert.deepEqual((await runtime()).navigation, hidden);
    await save({ ...saved, navigation: { ...navigation, items: [] } }); await publish();
    assert.deepEqual((await runtime()).navigation.items, []);
    await save({ ...saved, navigation: structuredClone(navigation) });
  });
  await test('navigation objects require exact supported keys, string mode and an items array', async () => {
    for (const value of [null, [], false, 1, 'menu', {}, { mode: 'menu', items: [] }, { startupScreenId: 'first', items: [] }, { startupScreenId: 'first', mode: 'none' }, { ...navigation, unknown: true }, { ...navigation, mode: 'tabs' }, { ...navigation, mode: false }, { ...navigation, mode: 'MENU' }, { ...navigation, items: null }, { ...navigation, items: {} }, { ...navigation, items: new Array(101).fill(navigation.items[0]) }])
      await reject(project => project.navigation = value);
  });
  await test('startup and menu destinations must name existing regular screens', async () => {
    for (const startupScreenId of ['', ' ', 'missing', 'popup', 1, null])
      await reject(project => project.navigation.startupScreenId = startupScreenId);
    for (const screenId of ['', ' ', 'missing', 'popup', 1, null])
      await reject(project => project.navigation.items = [{ screenId, label: 'Destination' }]);
    await reject(project => project.navigation.items = [navigation.items[0], navigation.items[0]]);
  });
  await test('menu item shape and human-readable bounded labels are validated', async () => {
    for (const item of [null, [], false, 'first', {}, { screenId: 'first' }, { label: 'Home' }, { screenId: 'first', label: 'Home', icon: 'unknown' }])
      await reject(project => project.navigation.items = [item]);
    for (const label of ['', '   ', null, 3, false, 'x'.repeat(121), 'First\nSecond', 'Null\u0000', 'Control\u0085'])
      await reject(project => project.navigation.items = [{ screenId: 'first', label }]);
    const exactLimit = { ...navigation, items: [{ screenId: 'first', label: 'x'.repeat(120) }] };
    await save({ ...saved, navigation: exactLimit });
    assert.deepEqual(saved.navigation, exactLimit);
    await save({ ...saved, navigation: structuredClone(navigation) });
  });
  await test('screen deletion or popup conversion cannot leave dangling startup/menu references', async () => {
    await reject(project => project.screens = project.screens.filter(screen => screen.id !== 'second'));
    await reject(project => project.screens = project.screens.filter(screen => screen.id !== 'first'));
    await reject(project => project.screens.find(screen => screen.id === 'second').kind = 'popup');
    await reject(project => project.screens.find(screen => screen.id === 'first').kind = 'popup');
  });
  let exported;
  await test('project duplication and portable packages preserve navigation as unpublished drafts', async () => {
    const duplicate = await request(path('/duplicate'), { method: 'POST', body: { name: `Navigation duplicate ${run}` } });
    created.push(duplicate.id);
    assert.deepEqual((await request(scoped(duplicate.id, '/project'))).navigation, navigation);
    assert.equal((await request(scoped(duplicate.id, '/project/publication'))).published, false);
    exported = await request(path('/export'), { binary: true });
    const entries = unzip(exported);
    assert.deepEqual(JSON.parse(entries.find(entry => entry.name === 'project.json').data).navigation, navigation);
    const imported = await request(`/api/projects/import?name=${encodeURIComponent(`Navigation import ${run}`)}`, { method: 'POST', raw: exported });
    const draft = await request(scoped(imported.id, '/project'));
    assert.deepEqual(draft.navigation, navigation);
    assert.equal((await request(scoped(imported.id, '/project/publication'))).published, false);
    await request(scoped(imported.id, '/project/publish'), { method: 'POST', body: { revision: draft.revision } });
    assert.deepEqual((await request(scoped(imported.id, '/runtime/project'))).navigation, navigation);
  });
  await test('invalid packaged navigation is rejected before catalog mutation', async () => {
    const before = await request('/api/projects');
    for (const invalid of [{ ...navigation, startupScreenId: 'missing' }, { ...navigation, items: [{ screenId: 'popup', label: 'Popup' }] }, { ...navigation, mode: 'tabs' }, { ...navigation, unknown: true }]) {
      const entries = unzip(exported).map(entry => entry.name === 'project.json' ? { ...entry, data: Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), navigation: invalid })) } : entry);
      await request('/api/projects/import', { method: 'POST', raw: zip(entries), status: 400 });
      assert.deepEqual(await request('/api/projects'), before);
    }
  });
} finally {
  for (const id of created.reverse()) await request(scoped(id, '/archive'), { method: 'POST', body: { archived: true } });
}
console.log(`${passed}/${passed} runtime-navigation API groups passed; fixture projects archived.`);
