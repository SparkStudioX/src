#!/usr/bin/env node
// Add a bundled example to the local development project, preserving existing resources.
// node tools/load-example.mjs assets-popups [http://127.0.0.1:5090] [--publish]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
assert.ok(args.filter(arg => arg.startsWith('--')).every(arg => arg === '--publish'), 'Only --publish is supported.');
const positional = args.filter(arg => !arg.startsWith('--'));
assert.ok(positional.length >= 1 && positional.length <= 2, 'Choose a bundled example name, then an optional local gateway URL.');
const [name, address = 'http://127.0.0.1:5090'] = positional;
assert.ok(['application-form', 'reusable-applications', 'assets-popups', 'operator-inputs', 'property-bindings', 'component-workshop', 'template-properties', 'state-controls', 'process-displays', 'process-graphics', 'application-state', 'nested-forms', 'input-state-bindings', 'template-parameter-bindings', 'instance-state', 'component-events'].includes(name), 'Choose a bundled example name.');
const base = new URL(address);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && ['5090', '5091'].includes(base.port), 'Examples are restricted to local development gateways on ports 5090 and 5091.');
assert.ok(base.protocol === 'http:' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Use a plain local gateway URL.');
const root = new URL('../', import.meta.url);
const example = JSON.parse(await readFile(new URL(`examples/${name}.json`, root), 'utf8'));
const assets = [];
for (const asset of example.assets || []) {
  assert.match(asset.file, /^assets\/[a-z0-9-]+\.(png|jpe?g|webp)$/i, 'Bundled images must be under examples/assets.');
  const bytes = await readFile(new URL(`examples/${asset.file}`, root));
  assert.ok(bytes.length > 0 && bytes.length <= 524288, 'Bundled images must be at most 512 KiB.');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.id, 'Bundled asset ID must match its content.');
  assets.push({ ...asset, dataBase64: bytes.toString('base64') });
}

async function api(path, method = 'GET', body) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const project = await api('/project');
const definitions = await api('/tag-definitions');
const newTags = [];
for (const tag of example.tags || []) {
  const existing = definitions.find(item => item.path === tag.path);
  if (existing) {
    assert.equal(existing.kind, 'memory', `Existing ${tag.path} must be a memory tag; no changes made.`);
    assert.equal(existing.dataType, tag.dataType, `Existing ${tag.path} has a different type; no changes made.`);
  } else newTags.push(tag);
}
const next = structuredClone(project);
let addedState = 0;
if (example.sessionState) {
  assert.ok(project.sessionState === undefined || project.sessionState !== null && typeof project.sessionState === 'object' && !Array.isArray(project.sessionState), 'Existing session state must be a declaration map; no changes made.');
  next.sessionState ||= {};
  for (const [key, definition] of Object.entries(example.sessionState)) {
    if (Object.hasOwn(next.sessionState, key)) assert.deepEqual(next.sessionState[key], definition, `Existing session state '${key}' conflicts with this example; no changes made.`);
    else { next.sessionState[key] = structuredClone(definition); addedState++; }
  }
  assert.ok(Object.keys(next.sessionState).length <= 64, 'Merged session state would exceed 64 declarations; no changes made.');
}
const screens = example.screens || [example.screen];
let added = 0;
for (const screen of screens) if (!next.screens.some(item => item.id === screen.id)) {
  next.screens.push(screen); added++;
}
if (example.templates?.length) {
  next.templates ||= [];
  for (const template of example.templates) if (!next.templates.some(item => item.id === template.id)) {
    next.templates.push(template); added++;
  }
}
const backupDirectory = new URL('.data/example-backups/', root);
await mkdir(backupDirectory, { recursive: true });
const backup = new URL(`${Date.now()}-${name}.json`, backupDirectory);
await writeFile(backup, JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });
for (const asset of assets) {
  const savedAsset = await api('/assets', 'POST', { name: asset.name, contentType: asset.contentType, dataBase64: asset.dataBase64 });
  assert.equal(savedAsset.id, asset.id, 'The gateway asset ID must match the example reference.');
}
for (const tag of newTags) await api('/tags', 'POST', tag);
const saved = added || addedState ? await api('/project', 'PUT', next) : project;
console.log(`Added ${added} project resources, ${addedState} session state defaults and ${newTags.length} memory tags; existing resources and tag values preserved.`);
if (assets.length) console.log(`${assets.length} bundled local images are available in the asset library.`);
console.log(`Previous project saved to ${fileURLToPath(backup)}`);
if (publish) {
  const result = await api('/project/publish', 'POST', { revision: saved.revision });
  console.log(`Published revision ${result.revision}. Open ${new URL('/runtime', base)}`);
} else console.log(`Draft revision ${saved.revision} ready for review in the designer.`);
