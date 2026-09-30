import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const safeId = /^[a-z][a-z0-9-]{0,79}$/;
const crcTable = Array.from({ length: 256 }, (_, number) => {
  let crc = number; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function safeArchivePath(value) {
  assert.ok(typeof value === 'string' && value.length <= 240 && !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Archive paths must be relative ordinary file paths.');
  return value;
}
/** Reproducible ordinary-file ZIPs, without installing an archive dependency. */
export function writeZip(entries) {
  assert.ok(entries.size <= 1028, 'Too many archive entries.');
  const local = [], central = [], names = new Set(); let offset = 0, expanded = 0;
  for (const [name, data] of [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    safeArchivePath(name); assert.ok(!names.has(name.toLowerCase()), 'Duplicate archive entry.'); names.add(name.toLowerCase());
    const bytes = Buffer.from(data), filename = Buffer.from(name), compressed = deflateRawSync(bytes, { level: 9 }), crc = crc32(bytes);
    expanded += bytes.length; assert.ok(expanded <= 64 * 1024 * 1024, 'Archive exceeds 64 MiB expanded.');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, end]); assert.ok(bytes.length <= 32 * 1024 * 1024, 'Archive exceeds 32 MiB compressed.'); return bytes;
}
/** Bounded reader for generated workshop archives and their verification tools. */
export function readZip(bytes) {
  assert.ok(bytes.length >= 22 && bytes.length <= 32 * 1024 * 1024, 'Invalid archive length.');
  const end = bytes.length - 22; assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'Expected an ordinary ZIP without a trailing comment.');
  const count = bytes.readUInt16LE(end + 10); assert.ok(count <= 1028); assert.equal(bytes.readUInt16LE(end + 8), count);
  let offset = bytes.readUInt32LE(end + 16), expanded = 0; const entries = new Map(), names = new Set();
  assert.equal(offset + bytes.readUInt32LE(end + 12), end);
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= end); assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), recordEnd = offset + 46 + length + extra + comment;
    assert.ok(recordEnd <= end); const name = safeArchivePath(bytes.toString('utf8', offset + 46, offset + 46 + length));
    assert.ok(!names.has(name.toLowerCase()), 'Duplicate archive entry.'); names.add(name.toLowerCase());
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20), start = bytes.readUInt32LE(offset + 42);
    assert.ok(!(flags & 1) && [0, 8].includes(method)); assert.ok(start + 30 < end); assert.equal(bytes.readUInt32LE(start), 0x04034b50);
    expanded += size; assert.ok(expanded <= 64 * 1024 * 1024); const dataStart = start + 30 + bytes.readUInt16LE(start + 26) + bytes.readUInt16LE(start + 28); assert.ok(dataStart + compressed <= bytes.readUInt32LE(end + 16));
    const raw = bytes.subarray(dataStart, dataStart + compressed), data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    assert.equal(data.length, size); assert.equal(crc32(data), bytes.readUInt32LE(offset + 16)); entries.set(name, data); offset = recordEnd;
  }
  assert.equal(offset, end); return entries;
}
async function sourceFile(root, relative) {
  safeArchivePath(relative); assert.ok(relative.startsWith('examples/') || relative.startsWith('docs/architecture/'), 'Workshop input must be authored examples or feature documentation.');
  const full = path.resolve(root, relative); const actual = await fs.realpath(full); const expected = path.resolve(root) + path.sep;
  assert.ok(actual.toLowerCase().startsWith(expected.toLowerCase()), 'Workshop input leaves the source checkout.');
  let cursor = path.resolve(root); for (const segment of relative.split('/')) { cursor = path.join(cursor, segment); assert.ok(!(await fs.lstat(cursor)).isSymbolicLink(), 'Linked workshop inputs are not allowed.'); }
  return fs.readFile(full);
}
export async function readCatalog(root) {
  const catalog = JSON.parse(await sourceFile(root, 'examples/catalog.json'));
  assert.equal(catalog.schemaVersion, 1); assert.equal(catalog.compatibility?.packageFormat, 1);
  assert.equal(catalog.compatibility?.baseline?.kind, 'source-commit'); assert.match(catalog.compatibility?.baseline?.value ?? '', /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(catalog.workshops) && catalog.workshops.length > 0 && catalog.workshops.length <= 100);
  const ids = new Set();
  for (const entry of catalog.workshops) {
    assert.match(entry.id, safeId); assert.ok(!ids.has(entry.id), 'Duplicate workshop ID.'); ids.add(entry.id);
    assert.equal(entry.source, `examples/${entry.id}.json`); assert.ok(['portable', 'setup-required'].includes(entry.distribution));
    for (const key of ['title', 'summary', 'guide', 'entryScreenId']) assert.ok(typeof entry[key] === 'string' && entry[key].trim(), `Missing workshop ${key}.`);
    assert.ok(entry.title.length <= 120); for (const key of ['features', 'prerequisites', 'walkthrough']) assert.ok(Array.isArray(entry[key]) && entry[key].every(value => typeof value === 'string' && value.trim()), `Invalid ${key}.`);
    assert.ok(entry.features.length && entry.walkthrough.length); assert.ok(['none', 'memory-tags', 'sqlite-setup'].includes(entry.gatewayWrites));
    if (entry.distribution === 'portable') assert.equal(entry.gatewayWrites, 'none', 'Standalone workshop actions must not write gateway data.');
    await sourceFile(root, entry.source); await sourceFile(root, entry.guide);
  }
  const sources = (await fs.readdir(path.join(root, 'examples'))).filter(file => file.endsWith('.json') && file !== 'catalog.json').map(file => file.slice(0, -5));
  assert.deepEqual([...ids].sort(), sources.sort(), 'Every authored example needs exactly one catalog entry.');
  return catalog;
}
export async function buildWorkshop(root, entry, exportedAt) {
  return packWorkshop(JSON.parse(await sourceFile(root, entry.source)), entry, exportedAt);
}
export function packWorkshop(source, entry, exportedAt) {
  assert.equal(entry.distribution, 'portable', 'Setup-required examples must not be packaged as standalone workshops.');
  assert.ok(Number.isFinite(Date.parse(exportedAt)), 'Invalid package timestamp.');
  const fields = ['name', 'screen', 'screens', 'templates', 'parameters', 'navigation', 'sessionState', 'styles', 'authoringDefaults', 'localization', 'queries', 'assets', 'tags', 'scripts'];
  assert.ok(Object.keys(source).every(key => fields.includes(key)), 'Unknown example fields require explicit package review.');
  assert.ok(!source.tags?.length, 'Gateway tags cannot be embedded in a project package.');
  assert.ok(!source.assets?.length, 'Asset-backed workshops need explicit distribution support before becoming portable.');
  const screens = source.screens ?? [source.screen]; assert.ok(Array.isArray(screens) && screens.length && screens.every(Boolean));
  assert.ok(screens.some(screen => screen.id === entry.entryScreenId && screen.kind !== 'popup'), 'Workshop startup must be a regular screen.');
  const project = { id: `workshop-${entry.id}`, name: entry.title, revision: 0, parameters: source.parameters ?? {}, screens, templates: source.templates ?? [],
    navigation: source.navigation ?? { mode: 'none', startupScreenId: entry.entryScreenId, items: [] }, ...(source.sessionState ? { sessionState: source.sessionState } : {}), ...(source.styles ? { styles: source.styles } : {}), ...(source.authoringDefaults ? { authoringDefaults: source.authoringDefaults } : {}), ...(source.localization ? { localization: source.localization } : {}) };
  const queries = (source.queries ?? []).map(query => {
    assert.equal(query.connectionId, 'sample', 'Portable workshops may reference only the built-in sample connection.'); assert.equal(query.kind ?? 'query', 'query', 'Portable workshops may contain only read queries.');
    assert.ok(Object.keys(query).every(key => ['id', 'name', 'connectionId', 'sql', 'kind', 'parameters'].includes(key)), 'Unknown query field.');
    return { ...query, kind: 'query', parameters: query.parameters.map(parameter => ({ ...parameter, type: parameter.type ?? 'string' })) };
  });
  const scripts = packScriptDraft(source.scripts);
  const manifest = { format: 'sparkstudio-project', formatVersion: 1, content: 'draft-only', projectName: project.name, exportedAt,
    connectionDependencies: queries.length ? [{ id: 'sample', name: 'Built-in sample' }] : [] };
  const bytes = writeZip(new Map([['manifest.json', json(manifest)], ['project.json', json(project)], ['queries.json', json(queries)], ['scripts-draft.json', json(scripts)]]));
  return { project, queries, scripts, bytes };
}
function packScriptDraft(source) {
  if (source === undefined) return { revision: 0, resources: [] };
  assert.ok(source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).every(key => ['revision', 'resources'].includes(key)), 'Workshop scripts must be an explicit draft.');
  assert.equal(source.revision, 0, 'Authored script drafts must start at revision zero.');
  assert.ok(Array.isArray(source.resources) && source.resources.length <= 100, 'Invalid authored script resources.');
  const common = ['id', 'name', 'type', 'code', 'enabled', 'parameters', 'event', 'timeoutMs', 'threading'];
  const options = { startup: [], update: [], shutdown: [], timer: ['intervalMs', 'delayType'], tagChange: ['tagPaths', 'changeTriggers'], message: ['requiredPermission'], scheduled: ['cron', 'timeZone'] };
  const ids = new Set(), messageNames = new Set(), libraryNames = new Set(); let totalCode = 0;
  for (const resource of source.resources) {
    assert.ok(resource && typeof resource === 'object' && !Array.isArray(resource), 'Invalid authored script resource.');
    assert.ok(['gateway', 'library', 'client'].includes(resource.type), 'Unsupported script resource type.');
    assert.equal(resource.enabled, false, 'Portable script resources must be disabled; activation requires explicit review and application publication.');
    if (resource.type === 'gateway') {
      assert.ok(Object.hasOwn(options, resource.event), 'Unsupported gateway event.');
      assert.ok(Object.keys(resource).every(key => common.includes(key) || options[resource.event].includes(key)), 'Unknown or unrelated script option.');
      assert.ok(Number.isInteger(resource.timeoutMs) && resource.timeoutMs >= 100 && resource.timeoutMs <= 300000, 'Invalid script timeout.');
      assert.ok(['dedicated', 'shared'].includes(resource.threading), 'Invalid script threading.');
    } else {
      assert.ok(Object.keys(resource).every(key => ['id', 'name', 'type', 'code', 'enabled', 'parameters', ...(resource.type === 'client' ? ['event'] : [])].includes(key)), 'Unknown or unrelated script option.');
      if (resource.type === 'client') assert.ok(['startup', 'screenOpen'].includes(resource.event), 'Unsupported browser event.');
      else {
        assert.match(resource.name, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
        assert.ok(!libraryNames.has(resource.name), 'Duplicate library name.'); libraryNames.add(resource.name);
      }
    }
    assert.match(resource.id, safeId); assert.ok(!ids.has(resource.id), 'Duplicate script ID.'); ids.add(resource.id);
    assert.ok(typeof resource.name === 'string' && resource.name.trim() && resource.name.length <= 100 && !/[\x00-\x1f\x7f]/.test(resource.name), 'Invalid script name.');
    assert.ok(typeof resource.code === 'string' && Buffer.byteLength(resource.code) <= 65536, 'Script code exceeds its limit.'); totalCode += Buffer.byteLength(resource.code);
    assert.ok(resource.parameters && typeof resource.parameters === 'object' && !Array.isArray(resource.parameters) && Object.keys(resource.parameters).length <= 64, 'Invalid script parameters.');
    for (const [name, value] of Object.entries(resource.parameters)) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
      assert.ok(value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 4096 || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'Script defaults must be bounded scalar values.');
    }
    if (resource.event === 'timer') {
      assert.ok(Number.isInteger(resource.intervalMs) && resource.intervalMs >= 100 && resource.intervalMs <= 86400000, 'Invalid timer interval.');
      assert.ok(['fixedDelay', 'fixedRate'].includes(resource.delayType), 'Invalid timer delay type.');
    }
    if (resource.event === 'tagChange') {
      assert.ok(Array.isArray(resource.tagPaths) && resource.tagPaths.length >= 1 && resource.tagPaths.length <= 64 && new Set(resource.tagPaths).size === resource.tagPaths.length, 'Invalid tag paths.');
      assert.ok(resource.tagPaths.every(value => typeof value === 'string' && value.length <= 512 && /^\[[^\]\s]+\].+/.test(value) && !/[\x00-\x1f\x7f]/.test(value)), 'Tag paths must be absolute.');
      assert.ok(Array.isArray(resource.changeTriggers) && resource.changeTriggers.length >= 1 && resource.changeTriggers.length <= 3 && new Set(resource.changeTriggers).size === resource.changeTriggers.length && resource.changeTriggers.every(value => ['value', 'quality', 'timestamp'].includes(value)), 'Invalid tag-change triggers.');
    }
    if (resource.event === 'message') {
      assert.ok(['operate', 'admin'].includes(resource.requiredPermission), 'Invalid message permission.');
      assert.ok(!messageNames.has(resource.name), 'Duplicate message handler name.'); messageNames.add(resource.name);
    }
    if (resource.event === 'scheduled') {
      assert.ok(typeof resource.cron === 'string' && resource.cron.trim().split(/\s+/).length === 5 && /^[0-9*/,\- ]+$/.test(resource.cron), 'Cron needs five numeric fields.');
      assert.ok(typeof resource.timeZone === 'string' && resource.timeZone.trim() && resource.timeZone.length <= 100, 'Scheduled events need an explicit time zone.');
    }
  }
  assert.ok(totalCode <= 512 * 1024, 'Script draft code exceeds its total limit.');
  return structuredClone(source);
}
function guide(entry, version, compatibility) {
  return `# ${entry.title}\n\n${entry.summary}\n\nWorkshop bundle: ${version}. Requires SparkStudio project format ${compatibility.packageFormat}. ${compatibility.note} Original collection baseline: ${compatibility.baseline.value}.\n\n## Open this workshop\n\n1. Sign in to engineering as a gateway administrator and open Projects.\n2. Choose Import .sparkproj and select projects/${entry.id}.sparkproj. Import creates an independent, unpublished project.\n3. Open the imported project in Designer, inspect its property sheets and scripts, then use Preview.\n4. Publish the saved project when ready. Open Operator application from the left navigation.\n\nPreview starts read-only: native inputs, pure bindings, read queries and navigation work. Authored JavaScript and Python exercises require an administrator to explicitly enable Live actions, or an explicitly published operator application.\n\n## Prerequisites\n\n${entry.prerequisites.map(value => `- ${value}`).join('\n') || '- No external devices, databases or Internet connection.'}\n\n## Try it\n\n${entry.walkthrough.map((value, index) => `${index + 1}. ${value}`).join('\n')}\n\n## What is saved\n\nThe package contains authored project defaults, read-query definitions and component scripts. Where included, library, gateway and browser script resources are disabled drafts: review and enable them, then publish the complete application. Operator state is transient. It contains no accounts, credentials, device configuration, gateway tags or database files. Import never publishes or starts gateway scripts. Review scripts before running an example.\n\nFeature guide: [${entry.title}](../${entry.guide}). Authoring source: [${entry.id}.json](../${entry.source}).\n`;
}
export async function buildBundleFiles(root, catalog, { version, exportedAt, sourceRevision, sourceDirty }) {
  assert.match(version, /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/); assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  const files = new Map(), workshops = [];
  const describe = (name, bytes) => ({ path: name, size: bytes.length, sha256: sha256(bytes) });
  for (const entry of catalog.workshops.filter(item => item.distribution === 'portable')) {
    const built = await buildWorkshop(root, entry, exportedAt), packagePath = `projects/${entry.id}.sparkproj`, guidePath = `guides/${entry.id}.md`, guideBytes = Buffer.from(guide(entry, version, catalog.compatibility));
    files.set(packagePath, built.bytes); files.set(guidePath, guideBytes);
    files.set(entry.source, await sourceFile(root, entry.source)); files.set(entry.guide, await sourceFile(root, entry.guide));
    workshops.push({ id: entry.id, title: entry.title, features: entry.features, package: describe(packagePath, built.bytes), guide: describe(guidePath, guideBytes) });
  }
  const setupRequired = catalog.workshops.filter(item => item.distribution === 'setup-required');
  files.set('catalog.json', json(catalog));
  files.set('README.md', Buffer.from(`# SparkStudio workshops ${version}\n\n${workshops.length} standalone, synthetic workshop projects. Import individual .sparkproj files through Projects, or copy this whole bundle to an air-gapped workstation. No Node.js or build tools are required to import a project.\n\n## Compatibility\n\nRequires project format ${catalog.compatibility.packageFormat}. ${catalog.compatibility.note} Original collection baseline: ${catalog.compatibility.baseline.value}. Development bundle labels are not gateway version numbers. Source revision for this bundle: ${sourceRevision}${sourceDirty ? ' (working tree changes present; development build)' : ''}.\n\n## Import\n\nRead a guide below, then use Projects → Import package. Every import creates a separate unpublished project. Review and Preview it, then Publish to open its operator application. Import does not modify existing projects or configure gateway resources.\n\nPreview starts read-only: native inputs, pure bindings, read queries and navigation work. Authored JavaScript and Python exercises require an administrator to explicitly enable Live actions, or an explicitly published operator application.\n\n## Included projects\n\n${workshops.map(item => `- [${item.title}](${item.guide.path}) — [project](${item.package.path})`).join('\n')}\n\n## Examples requiring setup\n\nThese are cataloged but not included as standalone projects because their gateway prerequisites are not portable:\n\n${setupRequired.map(item => `- **${item.title}**: ${item.prerequisites.join(' ')}`).join('\n')}\n\n## Integrity and source\n\nSHA256SUMS covers every loose payload file except itself; the adjacent .zip.sha256 file covers the distributable ZIP. manifest.json records per-file hashes, source revision and compatibility. Source: https://github.com/SparkStudioX/src. Matching release bundles are distributed from https://github.com/SparkStudioX/releases.\n`));
  const manifest = { format: 'sparkstudio-workshops', formatVersion: 1, version, exportedAt, sourceRevision, sourceDirty, compatibility: catalog.compatibility, workshops, setupRequired,
    files: [...files].map(([name, bytes]) => describe(name, bytes)).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  files.set('manifest.json', json(manifest)); files.set('SHA256SUMS', Buffer.from([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n') + '\n'));
  return { files, manifest };
}

/** Loose packages have one maintained home; versioned ZIP entries keep their portable layout. */
export function localWorkshopFiles(files, manifest) {
  const local = new Map();
  for (const [name, bytes] of files) {
    if (name.startsWith('projects/') && name.endsWith('.sparkproj')) local.set(path.posix.basename(name), bytes);
    else if (name.startsWith('guides/')) local.set(name, Buffer.from(bytes.toString().replace(/select projects\//g, 'select artifacts/sparkproj/')));
    else if (name.startsWith('examples/') || name.startsWith('docs/')) local.set(name, bytes);
  }
  const packages = manifest.workshops.map(item => ({ id: item.id, title: item.title, file: path.posix.basename(item.package.path),
    guide: item.guide.path, sha256: item.package.sha256, size: item.package.size, bundle: manifest.version }));
  local.set('index.json', json({ format: 'sparkstudio-local-workshops', description: 'Current maintained project packages. Rebuild from the authored example catalog.',
    sourceRevision: manifest.sourceRevision, sourceDirty: manifest.sourceDirty, compatibility: manifest.compatibility, packages }));
  local.set('README.md', Buffer.from(`# SparkStudio project packages\n\nThis is the only maintained location for loose .sparkproj files. Import a package through Projects → Import .sparkproj, review it, then publish it.\n\nThese packages require the matching compatible gateway build; see index.json for source identity and compatibility.\n\n${packages.map(item => `- [${item.title}](${item.file}) · [Guide](${item.guide})`).join('\n')}\n\nRebuild with node tools/build-workshops.mjs --version <new-version>. Versioned release ZIPs remain under artifacts/workshops/ and are verified independently of these current packages.\n`));
  return local;
}
