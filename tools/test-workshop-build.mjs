#!/usr/bin/env node
// Offline release-content checks; no running gateway, credentials or extra packages required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readCatalog, buildWorkshop, packWorkshop, buildBundleFiles, localWorkshopFiles, writeZip, readZip, sha256 } from './workshop-packages.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), catalog = await readCatalog(root);
const portable = catalog.workshops.filter(entry => entry.distribution === 'portable');
const options = { version: 'test-1', exportedAt: '2026-09-29T00:00:00.000Z', sourceRevision: '2143ecc26193aad264a0d3e2a5ea841efedb1dbd', sourceDirty: false };
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await check('catalog accounts for every authored example, its source, guide, prerequisites and walkthrough', () => {
  assert.ok(portable.length); assert.ok(catalog.workshops.some(entry => entry.distribution === 'setup-required'));
});
await check('every portable archive preserves authored screens/templates/state/styles/translations/defaults and has only draft project entries', async () => {
  for (const entry of portable) {
    const source = JSON.parse(await readFile(new URL(entry.source, new URL('../', import.meta.url)), 'utf8'));
    const built = await buildWorkshop(root, entry, options.exportedAt), files = readZip(built.bytes);
    assert.deepEqual([...files.keys()].sort(), ['manifest.json', 'project.json', 'queries.json', 'scripts-draft.json']);
    assert.deepEqual(built.project.screens, source.screens ?? [source.screen]); assert.deepEqual(built.project.templates, source.templates ?? []);
    assert.deepEqual(built.project.sessionState, source.sessionState); assert.deepEqual(built.project.parameters, source.parameters ?? {});
    const archivedProject = JSON.parse(files.get('project.json'));
    for (const field of ['styles', 'authoringDefaults', 'localization']) {
      assert.deepEqual(built.project[field], source[field], `${entry.id}: authored ${field} must survive package projection`);
      assert.deepEqual(archivedProject[field], source[field], `${entry.id}: archived ${field} must match its authored source exactly`);
    }
    assert.deepEqual(built.scripts, source.scripts ?? { revision: 0, resources: [] });
    assert.ok(built.scripts.resources.every(resource => resource.enabled === false), 'Imported resource scripts must remain disabled.');
    const manifest = JSON.parse(files.get('manifest.json')); assert.equal(manifest.content, 'draft-only');
    assert.deepEqual(manifest.connectionDependencies, built.queries.length ? [{ id: 'sample', name: 'Built-in sample' }] : []);
  }
});
const entry = portable[0], source = JSON.parse(await readFile(new URL(entry.source, new URL('../', import.meta.url)), 'utf8'));
await check('setup-required examples cannot silently become standalone packages', async () => {
  for (const setup of catalog.workshops.filter(item => item.distribution === 'setup-required')) {
    const authored = JSON.parse(await readFile(new URL(setup.source, new URL('../', import.meta.url)), 'utf8'));
    assert.throws(() => packWorkshop(authored, setup, options.exportedAt), /Setup-required/);
  }
  assert.throws(() => packWorkshop(source, { ...entry, distribution: 'setup-required' }, options.exportedAt));
  assert.throws(() => packWorkshop({ ...source, tags: [{ path: '[default]Demo/Permit' }] }, entry, options.exportedAt), /tags/);
  assert.throws(() => packWorkshop({ ...source, assets: [{ id: 'asset' }] }, entry, options.exportedAt), /Asset-backed/);
});
await check('gateway configuration, secrets, external connections and update queries cannot enter portable packages', () => {
  for (const key of ['connections', 'password', 'accounts', 'tagsFile', 'dataDirectory']) assert.throws(() => packWorkshop({ ...source, [key]: {} }, entry, options.exportedAt), /Unknown example/);
  const query = { id: 'q', name: 'q', connectionId: 'external', sql: 'SELECT 1', parameters: [] };
  assert.throws(() => packWorkshop({ ...source, queries: [query] }, entry, options.exportedAt), /built-in sample/);
  assert.throws(() => packWorkshop({ ...source, queries: [{ ...query, connectionId: 'sample', kind: 'update' }] }, entry, options.exportedAt), /read queries/);
  assert.throws(() => packWorkshop({ ...source, queries: [{ ...query, connectionId: 'sample', password: 'synthetic-forbidden' }] }, entry, options.exportedAt), /Unknown query/);
});
await check('authored gateway scripts are disabled drafts and reject hidden configuration or automatic activation', () => {
  const script = { id: 'test-startup', name: 'Workshop startup', type: 'gateway', enabled: false, event: 'startup', timeoutMs: 10000, threading: 'dedicated', parameters: {}, code: 'print("Workshop")\n' };
  const withScripts = resources => ({ ...source, scripts: { revision: 0, resources } });
  const built = packWorkshop(withScripts([script]), entry, options.exportedAt);
  assert.deepEqual(built.scripts.resources, [script]);
  assert.deepEqual(JSON.parse(readZip(built.bytes).get('scripts-draft.json')), built.scripts);
  for (const patch of [{ enabled: true }, { type: 'client' }, { type: 'library' }, { timeoutMs: 300001 }, { threading: 'unknown' }, { certificate: 'forbidden' }, { event: 'startup', intervalMs: 1000 }])
    assert.throws(() => packWorkshop(withScripts([{ ...script, ...patch }]), entry, options.exportedAt));
  assert.throws(() => packWorkshop({ ...source, scripts: { revision: 1, resources: [script] } }, entry, options.exportedAt), /revision zero/);
  assert.throws(() => packWorkshop({ ...source, scripts: { revision: 0, resources: [script], publishedAt: options.exportedAt } }, entry, options.exportedAt), /explicit draft/);
});
await check('startup must identify a real regular screen', () => {
  assert.throws(() => packWorkshop(source, { ...entry, entryScreenId: 'missing' }, options.exportedAt), /startup/);
  assert.throws(() => packWorkshop({ ...source, screens: [{ id: entry.entryScreenId, kind: 'popup', components: [] }] }, entry, options.exportedAt), /startup/);
});
await check('ZIP paths, duplicate case variants, corrupted content and size limits fail closed', () => {
  for (const name of ['../x', '/absolute', 'C:/secret', 'a\\b', 'a//b', 'a/./b']) assert.throws(() => writeZip(new Map([[name, Buffer.from('x')]])));
  assert.throws(() => writeZip(new Map([['a', Buffer.from('1')], ['A', Buffer.from('2')]])), /Duplicate/);
  const bytes = writeZip(new Map([['project.json', Buffer.from('valid payload')]]));
  const corrupt = Buffer.from(bytes); corrupt[45] ^= 0xff; assert.throws(() => readZip(corrupt));
  assert.throws(() => readZip(Buffer.from('invalid'))); assert.throws(() => readZip(Buffer.alloc(32 * 1024 * 1024 + 1)));
});
await check('same authored inputs and build metadata produce byte-identical packages and bundles', async () => {
  const first = await buildBundleFiles(root, catalog, options), second = await buildBundleFiles(root, catalog, options);
  assert.deepEqual(writeZip(first.files), writeZip(second.files));
});
await check('bundle indexes only portable projects, includes offline guides and hashes every payload file', async () => {
  const { files, manifest } = await buildBundleFiles(root, catalog, options);
  assert.equal(manifest.workshops.length, portable.length); assert.equal(manifest.setupRequired.length, catalog.workshops.length - portable.length);
  const hashes = new Map(files.get('SHA256SUMS').toString().trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]));
  assert.equal(hashes.size, files.size - 1); for (const [name, bytes] of files) if (name !== 'SHA256SUMS') assert.equal(hashes.get(name), sha256(bytes));
  for (const item of manifest.files) { assert.equal(files.get(item.path).length, item.size); assert.equal(sha256(files.get(item.path)), item.sha256); }
  for (const item of manifest.workshops) {
    assert.equal(sha256(files.get(item.package.path)), item.package.sha256);
    assert.match(files.get(item.guide.path).toString(), /unpublished project/);
  }
  assert.deepEqual(readZip(writeZip(files)), new Map([...files].sort(([a], [b]) => a.localeCompare(b, 'en'))));
});
await check('bundle compatibility, source identity and dirty-build warnings stay distinct from the version label', async () => {
  const { files, manifest } = await buildBundleFiles(root, catalog, { ...options, sourceDirty: true });
  assert.equal(manifest.sourceDirty, true); assert.equal(manifest.sourceRevision, options.sourceRevision);
  assert.deepEqual(manifest.compatibility, catalog.compatibility); assert.match(files.get('README.md').toString(), /development build/);
  for (const version of ['../release', '/absolute', 'bad version', '']) await assert.rejects(buildBundleFiles(root, catalog, { ...options, version }));
});
await check('maintained packages are flat, indexed and separate from frozen ZIP paths', async () => {
  const { files, manifest } = await buildBundleFiles(root, catalog, options), local = localWorkshopFiles(files, manifest);
  const index = JSON.parse(local.get('index.json'));
  assert.equal(index.packages.length, portable.length);
  assert.equal([...local.keys()].filter(name => name.endsWith('.sparkproj')).length, portable.length);
  for (const item of index.packages) {
    assert.equal(item.file, `${item.id}.sparkproj`);
    assert.equal(sha256(local.get(item.file)), item.sha256);
    assert.deepEqual(local.get(item.file), files.get(`projects/${item.file}`));
    assert.match(local.get(item.guide).toString(), /select artifacts\/sparkproj\//);
  }
  assert.ok(![...local.keys()].some(name => name.startsWith('projects/')));
});
console.log(`${passed}/${passed} workshop build checks passed across ${portable.length} portable examples.`);
