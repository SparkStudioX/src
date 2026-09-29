#!/usr/bin/env node
// This guard is a source-boundary check, not a complete secret scanner or proof
// of authorship. Review changes to this file and the allowed paths themselves.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const maxBlobBytes = 1024 * 1024;
const maxBatchBytes = 64 * 1024 * 1024;
const binaryAsset = 'examples/assets/assembly-cell.png';
const binaryHash = '0df6492ea1fd39c00f5a4a8b6f96e39c5a6729f211ded9f904be96b18dc4600c';
const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.dockerignore', 'AGENTS.md', 'README.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'NOTICE.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'Dockerfile', 'compose.yaml', 'Directory.Build.props', 'global.json', 'NuGet.Config',
]);
const webFiles = new Set([
  'apps/web/package.json', 'apps/web/package-lock.json', 'apps/web/tsconfig.json',
  'apps/web/vite.config.ts', 'apps/web/index.html', 'apps/web/check-template-model.mjs',
  'apps/web/check-popup-model.mjs', 'apps/web/public/spark.svg',
  'apps/web/check-popup-source.mjs',
  'apps/web/check-input-model.mjs', 'apps/web/check-canvas-model.mjs',
  'apps/web/check-browser-scripts.mjs',
  'apps/web/check-table-selection.mjs',
  'apps/web/check-property-bindings.mjs', 'apps/web/check-bound-components.mjs',
  'apps/web/check-input-events.mjs',
  'apps/web/check-project-routing.mjs',
  'apps/web/check-query-options.mjs',
  'apps/web/check-designer-documents.mjs',
  'apps/web/check-project-panes.mjs',
  'apps/web/check-runtime-quality.mjs',
  'apps/web/check-runtime-navigation.mjs',
  'apps/web/check-query-repeater.mjs',
  'apps/web/check-property-authoring.mjs',
  'apps/web/check-template-parameter-authoring.mjs',
  'apps/web/check-template-parameter-bindings.mjs',
  'apps/web/check-template-parameter-state.mjs', 'apps/web/check-template-parameter-state-authoring.mjs',
  'apps/web/check-instance-state.mjs', 'apps/web/check-instance-state-authoring.mjs',
  'apps/web/check-component-events.mjs', 'apps/web/check-component-events-authoring.mjs',
  'apps/web/check-state-controls.mjs',
  'apps/web/check-state-control-authoring.mjs',
  'apps/web/check-process-displays.mjs',
  'apps/web/check-process-display-authoring.mjs',
  'apps/web/check-list-tree-authoring.mjs',
  'apps/web/check-list-tree.mjs',
  'apps/web/check-table-paging.mjs',
  'apps/web/check-table-columns.mjs',
  'apps/web/check-table-columns-authoring.mjs',
  'apps/web/check-table-editing.mjs',
  'apps/web/check-table-editing-renderer.mjs',
  'apps/web/check-table-editing-authoring.mjs',
  'apps/web/check-table-editing-contexts.mjs',
  'apps/web/check-drawing-components.mjs', 'apps/web/check-drawing-renderer.mjs', 'apps/web/check-drawing-authoring.mjs',
  'apps/web/check-auth-session.mjs',
  'apps/web/check-auth-ui.mjs',
  'apps/web/check-account-settings.mjs',
  'apps/web/check-state-authoring.mjs', 'apps/web/check-application-state.mjs',
  'apps/web/check-nested-templates.mjs', 'apps/web/check-nested-popups.mjs',
  'apps/web/check-input-state-bindings.mjs', 'apps/web/check-input-state-authoring.mjs',
]);
const toolFiles = new Set([
  'bootstrap.ps1', 'build.ps1', 'dev.ps1', 'publish-windows.ps1', 'install-service.ps1',
  'build-installer.ps1', 'test-installer.ps1', 'generate-example-assets.ps1',
  'load-example.mjs', 'test-assets-popups.mjs', 'test-gateway.mjs', 'test-runtime-actions.mjs',
  'test-runtime.mjs', 'test-tag-definitions.mjs', 'test-template-runtime.mjs',
  'check-source.mjs', 'test-source-boundary.mjs', 'install-source-hooks.ps1',
  'test-input-controls.mjs',
  'load-sqlite-example.mjs', 'test-sqlite-application.mjs', 'test-script-resources.mjs',
  'test-sqlite-example.mjs',
  'test-property-bindings.mjs',
  'test-component-events.mjs',
  'test-project-management.mjs', 'test-project-packages.mjs',
  'test-query-controls.mjs', 'load-equipment-example.mjs', 'test-equipment-example.mjs',
  'test-equipment-application.mjs',
  'test-runtime-navigation.mjs',
  'test-query-repeaters.mjs',
  'test-query-popup-actions.mjs',
  'test-template-properties.mjs',
  'test-template-parameters.mjs',
  'test-template-parameter-bindings.mjs',
  'test-template-parameter-state.mjs',
  'test-instance-state.mjs',
  'test-component-lifecycle.mjs',
  'test-state-controls.mjs',
  'test-process-displays.mjs',
  'test-selection-controls.mjs',
  'test-table-columns.mjs',
  'test-table-editing.mjs', 'test-drawing-components.mjs',
  'load-data-controls-example.mjs',
  'test-security.mjs', 'test-auth-session.mjs',
  'test-account-password.mjs',
  'test-application-state.mjs',
  'test-nested-templates.mjs',
  'test-input-state-bindings.mjs',
]);
const architectureDocs = new Set([
  'ASSETS_POPUPS.md', 'COMPONENTS.md', 'PARITY.md', 'PRODUCT.md', 'TEMPLATES.md',
  'WINDOWS_INSTALLER.md', 'SOURCE_BOUNDARY.md',
  'SCRIPTING.md',
  'APPLICATION_STATE.md',
  'NESTED_FORMS.md',
  'INPUT_STATE_BINDINGS.md',
  'TEMPLATE_PARAMETER_BINDINGS.md',
  'TEMPLATE_PARAMETER_STATE.md',
  'INSTANCE_STATE.md',
  'COMPONENT_LIFECYCLE.md',
  'PROPERTY_BINDINGS.md',
  'PROPERTY_SHEET_EVENTS.md',
  'PROJECTS.md',
  'QUERY_CONTROLS.md', 'DRAWING.md',
  'SECURITY.md',
]);
const explicitFiles = new Set([
  '.githooks/pre-commit', '.githooks/pre-push', '.github/workflows/source-boundary.yml',
  'runtimes/python/worker.py', 'installer/SparkStudio.iss', 'installer/INSTALL-NOTES.txt',
  'examples/application-form.json', 'examples/reusable-applications.json', 'examples/assets-popups.json',
  'examples/operator-inputs.json',
  'examples/property-bindings.json',
  'examples/component-workshop.json',
  'examples/template-properties.json',
  'examples/state-controls.json',
  'examples/process-displays.json', 'examples/process-graphics.json',
  'examples/data-controls.json',
  'examples/application-state.json',
  'examples/nested-forms.json',
  'examples/input-state-bindings.json',
  'examples/template-parameter-bindings.json',
  'examples/template-parameter-state.json',
  'examples/instance-state.json',
  'examples/component-events.json',
  'docs/SOURCE_BOUNDARY.md',
  'src/SparkStudio.Connectors/README.md', 'src/SparkStudio.Connectors/NuGet.Config',
  'src/SparkStudio.Connectors.Tests/README.md', 'src/SparkStudio.Gateway/appsettings.json',
  'src/SparkStudio.Connectors/packages.lock.json', 'src/SparkStudio.Connectors/packages.win-x64.lock.json',
  'src/SparkStudio.Connectors.Tests/packages.lock.json', 'src/SparkStudio.Connectors.Tests/packages.win-x64.lock.json',
  'src/SparkStudio.Gateway/packages.lock.json', 'src/SparkStudio.Gateway/packages.win-x64.lock.json',
  'installer/ServiceHelper/packages.lock.json', 'installer/ServiceHelper/packages.win-x64.lock.json',
]);
const deniedSegments = new Set([
  '.git', '.data', '.tools', '.cache', '.npm-cache', '.nuget', 'node_modules',
  'bin', 'obj', 'dist', 'wwwroot', 'artifacts', 'gwbk', 'java', 'decompiled',
  'decompilation', 'downloads', 'pki', 'certs', 'certificates', '__pycache__',
]);
const deniedExtensions = /\.(?:java|class|jar|war|ear|modl|gwbk|zip|7z|rar|tar|tgz|gz|bz2|xz|exe|dll|msi|msix|pdb|so|dylib|a|lib|o|nupkg|whl|pyc|pyo|pfx|p12|pem|key|crt|cer|der|p7b|jks|keystore|db|sqlite|sqlite3|bak|log|cache|tsbuildinfo)$/i;
const contentRules = [
  ['proprietary Java namespace', /\bcom[.]inductiveautomation(?:[.]|\b)/i],
  ['decompiler output marker', /\bDecompiled\s+(?:with|by)\s+(?:CFR|Procyon|Fernflower|Vineflower|JADX)\b/i],
  ['decompiler output marker', /\b(?:Vineflower|Fernflower|Procyon|CFR)\s+decompiler\b/i],
  ['copied vendor documentation origin', /https?:\/\/(?:www[.])?docs[.]inductiveautomation[.]com(?:\/|\b)/i],
  ['vendor copyright marker', /Copyright[^\r\n]{0,90}Inductive\s+Automation/i],
  ['private key material', /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----/],
  ['certificate material', /-----BEGIN\s+CERTIFICATE-----/],
  ['credential-shaped token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/],
];

function git(args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: process.cwd(), maxBuffer: maxBatchBytes, ...options });
  if (result.error) throw new Error(`Git could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Git command failed (${args[0]}). ${result.stderr?.toString().trim().slice(0, 300) || ''}`);
  return result.stdout;
}
function records(buffer) { return buffer.toString('utf8').split('\0').filter(Boolean); }
function canonicalPath(file) {
  if (!file || /[\\\x00-\x1f\x7f:]/.test(file) || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) return 'noncanonical or unsafe path';
  const parts = file.toLowerCase().split('/');
  if (parts.some(part => deniedSegments.has(part))) return 'generated, downloaded, runtime, or third-party directory';
  if (parts.some(part => part.startsWith('.env') || /[.]env(?:[.]|$)/.test(part))) return 'environment file';
  if (deniedExtensions.test(file)) return 'forbidden archive, binary, key, certificate, or generated extension';
  return null;
}
function allowedPath(file) {
  if (rootFiles.has(file) || webFiles.has(file) || explicitFiles.has(file) || file === binaryAsset) return true;
  if (/^apps\/web\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|css|svg)$/.test(file)) return true;
  if (/^src\/SparkStudio\.(?:Gateway|Connectors|Connectors[.]Tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cs|csproj)$/.test(file)) return true;
  if (/^installer\/ServiceHelper\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cs|csproj)$/.test(file)) return true;
  if (file.startsWith('tools/') && toolFiles.has(file.slice(6))) return true;
  if (file.startsWith('docs/architecture/') && architectureDocs.has(file.slice(18))) return true;
  return false;
}
function contentIssues(file, buffer) {
  if (buffer.length > maxBlobBytes) return ['blob exceeds the 1 MiB source limit'];
  if (file === binaryAsset) return createHash('sha256').update(buffer).digest('hex') === binaryHash ? [] : ['binary asset does not match the approved SHA-256'];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return ['non-UTF-8 or binary content outside the approved asset']; }
  if (text.includes('\0') || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return ['binary control bytes in a source file'];
  return contentRules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
function indexEntries() {
  return records(git(['ls-files', '--stage', '-z'])).map(record => {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Cannot parse Git index entry.');
    return { mode: match[1], oid: match[2], stage: Number(match[3]), file: match[4] };
  });
}
function treeEntries(ref) {
  const tree = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]).toString().trim();
  return records(git(['ls-tree', '-r', '-z', '--full-tree', tree])).map(record => {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Cannot parse Git tree entry.');
    return { mode: match[1], oid: match[3], stage: 0, file: match[4] };
  });
}
const blobCache = new Map();
function readBlobs(entries) {
  const ids = [...new Set(entries.map(entry => entry.oid).filter(oid => !blobCache.has(oid)))];
  if (!ids.length) return;
  const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${ids.join('\n')}\n` }).toString().trim().split('\n');
  const selected = [];
  let bytes = 0;
  for (const line of metadata) {
    const [oid, type, sizeText] = line.trim().split(' ');
    const size = Number(sizeText);
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('An index object is not a readable blob.');
    if (size > maxBlobBytes) { blobCache.set(oid, { tooLarge: true }); continue; }
    selected.push(oid); bytes += size + 100;
  }
  if (bytes > maxBatchBytes - 1024) throw new Error('Source scan exceeds the 64 MiB batch safety limit.');
  if (!selected.length) return;
  const output = git(['cat-file', '--batch'], { input: `${selected.join('\n')}\n` });
  let offset = 0;
  for (const expected of selected) {
    const newline = output.indexOf(10, offset);
    const [oid, type, sizeText] = output.subarray(offset, newline).toString().split(' ');
    const size = Number(sizeText);
    if (newline < 0 || oid !== expected || type !== 'blob' || !Number.isSafeInteger(size) || output.length < newline + size + 2) throw new Error('Malformed Git blob stream.');
    blobCache.set(oid, output.subarray(newline + 1, newline + 1 + size));
    offset = newline + size + 2;
  }
}
const failures = new Set();
let examinedFiles = 0;
function fail(label, file, reason) { failures.add(`${label}: ${JSON.stringify(file)} — ${reason}`); }
function scanEntries(entries, label, worktree = false) {
  const accepted = [];
  for (const entry of entries) {
    examinedFiles++;
    if (!['100644', '100755'].includes(entry.mode)) { fail(label, entry.file, 'symlinks, gitlinks, and nonregular modes are forbidden'); continue; }
    if (entry.stage) { fail(label, entry.file, 'unresolved merge entry'); continue; }
    const invalid = canonicalPath(entry.file);
    if (invalid || !allowedPath(entry.file)) { fail(label, entry.file, invalid || 'path is outside the explicit source allowlist'); continue; }
    accepted.push(entry);
  }
  if (!worktree) readBlobs(accepted);
  for (const entry of accepted) {
    let buffer;
    if (worktree) {
      const absolute = path.resolve(process.cwd(), entry.file);
      const relative = path.relative(process.cwd(), absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { fail(label, entry.file, 'path escapes repository'); continue; }
      try {
        const info = fs.lstatSync(absolute);
        if (!info.isFile() || info.isSymbolicLink()) { fail(label, entry.file, 'not a regular worktree file'); continue; }
        if (info.size > maxBlobBytes) { fail(label, entry.file, 'blob exceeds the 1 MiB source limit'); continue; }
        // Do not follow a symlink in any parent path.
        let parent = path.dirname(absolute);
        let unsafeParent = false;
        while (parent !== process.cwd()) { if (fs.lstatSync(parent).isSymbolicLink()) { unsafeParent = true; break; } parent = path.dirname(parent); }
        if (unsafeParent) { fail(label, entry.file, 'symlinked parent directory'); continue; }
        buffer = fs.readFileSync(absolute);
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    } else {
      buffer = blobCache.get(entry.oid);
      if (buffer?.tooLarge) { fail(label, entry.file, 'blob exceeds the 1 MiB source limit'); continue; }
    }
    for (const reason of contentIssues(entry.file, buffer)) fail(label, entry.file, reason);
  }
}
function commitsFor(refs) {
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') throw new Error('History checks require a full clone; fetch complete history first.');
  const tips = refs.map(ref => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim());
  if (!tips.length) return [];
  return git(['rev-list', '--topo-order', '--reverse', ...tips]).toString().trim().split('\n').filter(Boolean);
}
function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--staged';
  if (!['--staged', '--tree', '--worktree', '--history', '--pre-push'].includes(mode) || args.length > (['--tree', '--history'].includes(mode) ? 2 : 1)) throw new Error('Usage: check-source.mjs [--staged | --tree REF | --worktree | --history REF | --pre-push]');
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(fs.realpathSync(root));
  let commits = 0;
  if (mode === '--staged') scanEntries(indexEntries(), 'index');
  else if (mode === '--tree') scanEntries(treeEntries(args[1] || 'HEAD'), 'tree');
  else if (mode === '--worktree') {
    const tracked = new Map(indexEntries().map(entry => [entry.file, entry]));
    const files = records(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
    scanEntries([...new Set(files)].map(file => tracked.get(file) || { file, mode: '100644', stage: 0 }), 'worktree', true);
  } else {
    let refs;
    if (mode === '--history') refs = [args[1] || 'HEAD'];
    else {
      refs = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/i.test(fields[1]) || !/^[0-9a-f]{40,64}$/i.test(fields[3])) throw new Error('Invalid pre-push ref input.');
        return /^0+$/.test(fields[1]) ? null : fields[1];
      }).filter(Boolean);
    }
    const history = commitsFor(refs);
    commits = history.length;
    for (const commit of history) scanEntries(treeEntries(commit), `commit ${commit.slice(0, 12)}`);
  }
  if (failures.size) {
    console.error(`Source boundary rejected ${failures.size} finding(s):`);
    for (const failure of [...failures].slice(0, 100)) console.error(`  ${failure}`);
    if (failures.size > 100) console.error(`  … ${failures.size - 100} more findings omitted.`);
    console.error('Remove forbidden content from the index and, for pushes, from every affected commit. This check does not establish ownership or replace secret review.');
    process.exitCode = 1;
  } else console.log(`Source boundary passed: ${mode}, ${examinedFiles} file entries${commits ? ` across ${commits} commits` : ''}, ${blobCache.size} unique Git blobs.`);
}
try { main(); }
catch (error) { console.error(`Source boundary could not complete: ${error.message}`); process.exitCode = 2; }
