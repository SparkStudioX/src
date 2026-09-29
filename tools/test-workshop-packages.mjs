#!/usr/bin/env node
// Verify generated workshops through the real importer and publisher on an isolated gateway.
// Imports are archived afterward. No imported action or gateway/client script is executed.
// SPARKSTUDIO_TEST_AUTH_FILE=.data/... node --import ./tools/test-auth-session.mjs tools/test-workshop-packages.mjs artifacts/workshops/<version>
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, sha256 } from './workshop-packages.mjs';

assert.ok(process.argv.length >= 3 && process.argv.length <= 4, 'Provide the generated bundle directory and an optional isolated gateway URL.');
const root = fileURLToPath(new URL('../', import.meta.url));
const allowedRoot = await realpath(path.join(root, 'artifacts', 'workshops'));
const directory = await realpath(path.resolve(process.argv[2]));
assert.ok(directory.startsWith(allowedRoot + path.sep), 'Generated workshop bundles must be inside artifacts/workshops.');
const base = new URL(process.argv[3] ?? 'http://127.0.0.1:5091');
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
assert.equal(base.port, '5091', 'Workshop integration checks require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.hash && !base.search);

async function bundleFile(relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length > 0 && !relative.includes('\\') && !path.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Bundle paths must be safe relative file names.');
  const resolved = await realpath(path.join(directory, ...relative.split('/')));
  assert.ok(resolved.startsWith(directory + path.sep), 'A bundle file must not resolve outside its directory.');
  assert.ok((await stat(resolved)).isFile(), 'Bundle entries must be files.');
  return readFile(resolved);
}

const manifest = JSON.parse(await bundleFile('manifest.json'));
assert.equal(manifest.format, 'sparkstudio-workshops');
assert.equal(manifest.formatVersion, 1);
assert.equal(manifest.compatibility.packageFormat, 1);
assert.ok(Array.isArray(manifest.workshops) && manifest.workshops.length > 0);
assert.equal(new Set(manifest.workshops.map(item => item.id)).size, manifest.workshops.length, 'Workshop identifiers must be unique.');
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
const checksums = new Map();
for (const line of (await bundleFile('SHA256SUMS')).toString('utf8').trim().split(/\r?\n/)) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert.ok(match, 'Checksum lines require lowercase SHA-256 and a relative file path.');
  assert.ok(!checksums.has(match[2]), 'Checksum file paths must be unique.');
  checksums.set(match[2], match[1]);
  assert.equal(sha256(await bundleFile(match[2])), match[1], `Checksum mismatch: ${match[2]}`);
}
assert.equal(checksums.get('manifest.json'), sha256(await bundleFile('manifest.json')), 'The bundle manifest must have a checksum.');
const indexedFiles = new Set();
for (const file of manifest.files) {
  assert.ok(!indexedFiles.has(file.path), 'Manifest file paths must be unique.');
  indexedFiles.add(file.path);
  const bytes = await bundleFile(file.path);
  assert.equal(bytes.length, file.size, `File size mismatch: ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `Manifest checksum mismatch: ${file.path}`);
  assert.equal(checksums.get(file.path), file.sha256, `Unlisted checksum: ${file.path}`);
}
assert.deepEqual([...checksums.keys()].sort(), [...indexedFiles, 'manifest.json'].sort(), 'The checksum list must cover exactly the manifest and indexed payload files.');
const bundleName = `SparkStudio-Workshops-${manifest.version}.zip`;
const bundleBytes = await bundleFile(bundleName);
assert.equal((await bundleFile(bundleName + '.sha256')).toString('utf8'), `${sha256(bundleBytes)}  ${bundleName}\n`, 'The standalone ZIP checksum must match its downloadable bytes.');
const bundleArchive = readZip(bundleBytes);
for (const relative of [...checksums.keys(), 'SHA256SUMS']) {
  assert.ok(bundleArchive.has(relative), `Standalone ZIP is missing ${relative}`);
  assert.deepEqual(bundleArchive.get(relative), await bundleFile(relative), `Standalone ZIP differs: ${relative}`);
}
assert.equal(bundleArchive.size, checksums.size + 1, 'Standalone ZIP must contain exactly the checksummed files and SHA256SUMS.');

const run = randomUUID().replaceAll('-', '').slice(0, 10);
const created = [];
const scoped = (id, route) => `/api/projects/${encodeURIComponent(id)}${route}`;
async function api(route, { method = 'GET', body, raw, binary = false } = {}) {
  const response = await fetch(new URL(route, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: body === undefined && raw === undefined ? {} : { 'Content-Type': raw === undefined ? 'application/json' : 'application/zip' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${bytes.toString('utf8').slice(0, 500)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
const parseEntry = (entries, name) => {
  assert.ok(entries.has(name), `Project archive is missing ${name}`);
  return JSON.parse(entries.get(name).toString('utf8'));
};
function importedProject(source, imported) {
  return { ...structuredClone(source), id: imported.id, name: imported.name, revision: 0 };
}
function operatorProject(project, publishedAt) {
  const result = structuredClone(project);
  for (const document of [...result.screens, ...(result.templates ?? [])]) for (const component of document.components) {
    delete component.props.script;
    if (component.props.tableEdit) delete component.props.tableEdit.script;
  }
  return { ...result, publishedAt };
}

let failure;
let verified = 0;
const connectionsBefore = await api('/api/connections');
const tagsBefore = await api('/api/tag-definitions');
try {
  for (const workshop of manifest.workshops) {
    assert.equal(workshop.package.path, `projects/${workshop.id}.sparkproj`);
    assert.ok(indexedFiles.has(workshop.package.path) && indexedFiles.has(workshop.guide.path), 'Every package and walkthrough must be indexed.');
    const bytes = await bundleFile(workshop.package.path);
    assert.equal(bytes.length, workshop.package.size);
    assert.equal(sha256(bytes), workshop.package.sha256);
    const guide = await bundleFile(workshop.guide.path);
    assert.equal(guide.length, workshop.guide.size);
    assert.equal(sha256(guide), workshop.guide.sha256);
    const entries = readZip(bytes);
    const originalProject = parseEntry(entries, 'project.json');
    const originalQueries = parseEntry(entries, 'queries.json');
    const originalScripts = parseEntry(entries, 'scripts-draft.json');
    const originalManifest = parseEntry(entries, 'manifest.json');
    assert.equal(originalManifest.content, 'draft-only');
    assert.ok(originalQueries.every(query => query.connectionId === 'sample' && query.kind === 'query'), 'Portable workshop queries may only read the built-in sample provider.');
    const imported = await api(`/api/projects/import?name=${encodeURIComponent(`Workshop ${run} ${workshop.id}`)}`, { method: 'POST', raw: bytes });
    created.push(imported.id);
    assert.equal(imported.published, false, 'Imports must not become operator applications automatically.');
    assert.equal((await api(scoped(imported.id, '/project/publication'))).published, false);
    assert.equal((await api(scoped(imported.id, '/scripts/publication'))).published, false);
    const project = await api(scoped(imported.id, '/project'));
    assert.deepEqual(project, importedProject(originalProject, imported), `${workshop.id}: imported draft changed.`);
    assert.deepEqual(await api(scoped(imported.id, '/queries')), originalQueries);
    assert.deepEqual(await api(scoped(imported.id, '/scripts/resources')), originalScripts);
    const publication = await api(scoped(imported.id, '/project/publish'), { method: 'POST', body: { revision: project.revision } });
    assert.equal(publication.published, true);
    const runtime = await api(scoped(imported.id, '/runtime/project'));
    assert.deepEqual(runtime, operatorProject(project, publication.publishedAt), `${workshop.id}: operator snapshot differs from the imported draft.`);
    assert.equal(runtime.navigation.startupScreenId, originalProject.navigation.startupScreenId);
    assert.equal((await api(scoped(imported.id, '/scripts/publication'))).published, false, 'Project publication must not publish script-resource drafts.');
    assert.deepEqual((await api(scoped(imported.id, '/runtime/scripts'))).resources, []);
    const publishedQueries = await api(scoped(imported.id, `/runtime/queries?publishedAt=${encodeURIComponent(publication.publishedAt)}`));
    for (const query of publishedQueries) {
      const definition = originalQueries.find(item => item.id === query.id);
      assert.ok(definition, 'Published query must come from the imported package.');
      assert.equal(definition.connectionId, 'sample');
      assert.deepEqual(query, { id: definition.id, name: definition.name, parameters: definition.parameters });
      const result = await api(scoped(imported.id, `/runtime/queries/${encodeURIComponent(query.id)}/execute`), { method: 'POST', body: { publishedAt: publication.publishedAt, parameters: {} } });
      assert.ok(result.rows.length > 0, 'The portable sample query must work without an external connection.');
    }
    const reexported = readZip(await api(scoped(imported.id, '/export'), { binary: true }));
    assert.deepEqual([...reexported.keys()].sort(), [...entries.keys()].sort(), 'Export must not add gateway configuration or publication files.');
    assert.deepEqual(parseEntry(reexported, 'project.json'), project);
    assert.deepEqual(parseEntry(reexported, 'queries.json'), originalQueries);
    assert.deepEqual(parseEntry(reexported, 'scripts-draft.json'), originalScripts);
    const exportedManifest = parseEntry(reexported, 'manifest.json');
    assert.deepEqual({ ...exportedManifest, projectName: originalManifest.projectName, exportedAt: originalManifest.exportedAt }, originalManifest);
    for (const [name, value] of entries) if (name.startsWith('assets/')) assert.deepEqual(reexported.get(name), value, `Referenced asset changed: ${name}`);
    verified++;
    console.log(`PASS ${workshop.id}: import, explicit publication, operator snapshot, query reads and re-export`);
  }
} catch (error) { failure = error; }
finally {
  for (const id of created.reverse()) try {
    await api(scoped(id, '/archive'), { method: 'POST', body: { archived: true } });
  } catch (error) { failure ??= error; }
  try {
    assert.deepEqual(await api('/api/connections'), connectionsBefore, 'Workshop verification must not change gateway connections.');
    assert.deepEqual(await api('/api/tag-definitions'), tagsBefore, 'Workshop verification must not change gateway tags.');
  } catch (error) { failure ??= error; }
}
if (failure) throw failure;
console.log(`${verified} workshop packages verified; bundle hashes checked, fixture projects archived, gateway connections and tags unchanged.`);
