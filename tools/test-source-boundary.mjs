#!/usr/bin/env node
// Disposable, synthetic fixtures only. No vendor files or real credentials are read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(sourceRoot, 'tools/check-source.mjs');
const scratchRoot = path.join(sourceRoot, '.data');
fs.mkdirSync(scratchRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(scratchRoot, 'source-boundary-test-'));
// A hook caller can export Git plumbing variables. Never let them redirect a
// synthetic fixture operation into the real source index/object store.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
let checks = 0;
function git(args, input) {
  const result = spawnSync('git', args, { cwd: fixture, env: fixtureEnv, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `Fixture Git command failed (${args[0]}): ${result.stderr}`);
  return result.stdout.trim();
}
function guard(args = [], input = '') {
  return spawnSync(process.execPath, [checker, ...args], { cwd: fixture, env: fixtureEnv, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
function expectPass(args = [], input = '') { const result = guard(args, input); assert.equal(result.status, 0, result.stderr || result.stdout); }
function expectFailure(category, args = [], input = '') { const result = guard(args, input); assert.notEqual(result.status, 0, 'Forbidden fixture unexpectedly passed.'); assert.ok(result.stderr.includes(category), `Expected category '${category}' in: ${result.stderr}`); return result; }
function blob(contents) { return git(['hash-object', '-w', '--stdin'], contents); }
function stage(file, contents, mode = '100644') { git(['update-index', '--add', '--cacheinfo', `${mode},${blob(contents)},${file}`]); }
function remove(file) { git(['update-index', '--force-remove', '--', file]); }
function test(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const clean = '# SparkStudio\nIndependently authored source. Native Ignition import is not available.\n';
const vendor = ['inductive', 'automation'].join('');
const namespace = ['com', vendor, 'ignition', 'Example'].join('.');
const decompiled = ['Decompiled', 'with', 'CFR'].join(' ');

try {
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Source Boundary Fixture']);
  git(['config', 'user.email', 'source-boundary@example.invalid']);
  fs.mkdirSync(path.join(fixture, '.git/empty-hooks'));
  git(['config', 'core.hooksPath', '.git/empty-hooks']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(fixture, 'README.md'), clean);
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'Synthetic clean fixture']);
  const cleanCommit = git(['rev-parse', 'HEAD']);

  test('legitimate generic import-unavailable documentation passes', () => expectPass());
  test('current guard rules are themselves allowed and scanned', () => {
    stage('tools/check-source.mjs', fs.readFileSync(checker)); expectPass(); remove('tools/check-source.mjs');
  });
  test('staged content is checked even if the worktree is clean', () => {
    stage('README.md', `# Toy fixture\n${namespace}\n`);
    const result = expectFailure('proprietary Java namespace');
    assert.ok(!result.stderr.includes(namespace), 'Matched source text must never be printed.');
    stage('README.md', clean);
  });
  test('unstaged forbidden edits do not replace the staged blob', () => {
    fs.writeFileSync(path.join(fixture, 'README.md'), namespace);
    expectPass(); expectFailure('proprietary Java namespace', ['--worktree']);
    fs.writeFileSync(path.join(fixture, 'README.md'), clean);
  });
  for (const [name, file, category] of [
    ['downloaded documentation', 'docs/md/intro.md', 'outside the explicit source allowlist'],
    ['Java source hidden in app folders', 'apps/web/src/Example.JAVA', 'forbidden archive'],
    ['case-insensitive environment files', 'apps/web/src/.ENV.production', 'environment file'],
    ['nested environment files', 'src/SparkStudio.Gateway/local.env', 'environment file'],
    ['case-insensitive Java artifact folder', 'tools/JaVa/copied.mjs', 'third-party directory'],
    ['gateway backup', 'examples/private.GWBK', 'forbidden archive'],
    ['archive renamed within source tree', 'apps/web/src/bundle.Zip', 'forbidden archive'],
    ['compiled binary', 'src/SparkStudio.Gateway/runtime.DLL', 'forbidden archive'],
    ['certificate', 'apps/web/src/server.CRT', 'forbidden archive'],
    ['private key file', 'apps/web/src/server.KEY', 'forbidden archive'],
    ['generated build directory', 'src/SparkStudio.Gateway/Obj/state.json', 'third-party directory'],
    ['downloaded dependency directory', 'apps/web/node_modules/library/index.ts', 'third-party directory'],
    ['runtime data directory', '.data/connections.json', 'third-party directory'],
    ['runtime JSON copied into a backend directory', 'src/SparkStudio.Gateway/connections.json', 'outside the explicit source allowlist'],
    ['runtime JSON copied into installer source', 'installer/ServiceHelper/project.json', 'outside the explicit source allowlist'],
    ['unapproved root file', 'new-file.md', 'outside the explicit source allowlist'],
    ['unexpected asset binary', 'examples/assets/other.png', 'outside the explicit source allowlist'],
  ]) test(name, () => { stage(file, 'synthetic fixture'); expectFailure(category); remove(file); });
  test('symlink index mode is rejected on Windows without creating a symlink', () => {
    stage('apps/web/src/link.ts', '../outside.ts', '120000'); expectFailure('symlinks, gitlinks'); remove('apps/web/src/link.ts');
  });
  test('gitlink/submodule index mode is rejected', () => {
    git(['update-index', '--add', '--cacheinfo', `160000,${cleanCommit},src/SparkStudio.Gateway/module`]);
    expectFailure('symlinks, gitlinks'); remove('src/SparkStudio.Gateway/module');
  });
  for (const [name, content, category] of [
    ['decompiler signature in text', decompiled, 'decompiler output marker'],
    ['copied documentation origin', ['https:/', `docs.${vendor}.com/docs/8.3/intro`].join('/'), 'copied vendor documentation origin'],
    ['private key content in an allowed text file', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private key material'],
    ['certificate content in an allowed text file', ['-----BEGIN', 'CERTIFICATE-----'].join(' '), 'certificate material'],
    ['synthetic credential-shaped token', 'gh' + 'p_' + 'x'.repeat(36), 'credential-shaped token'],
    ['NUL bytes in a renamed binary', Buffer.from([65, 0, 66]), 'binary control bytes'],
    ['invalid UTF-8 in a renamed binary', Buffer.from([0xff, 0xfe, 0x61]), 'non-UTF-8'],
    ['oversized source blob', 'x'.repeat(1024 * 1024 + 1), '1 MiB source limit'],
  ]) test(name, () => { stage('README.md', content); expectFailure(category); stage('README.md', clean); });
  test('approved image content hash passes and any replacement fails', () => {
    const approved = fs.readFileSync(path.join(sourceRoot, 'examples/assets/assembly-cell.png'));
    stage('examples/assets/assembly-cell.png', approved); expectPass();
    stage('examples/assets/assembly-cell.png', Buffer.concat([approved, Buffer.from('changed')]));
    expectFailure('approved SHA-256'); remove('examples/assets/assembly-cell.png');
  });
  test('force-staged ignored runtime artifacts still fail', () => {
    fs.writeFileSync(path.join(fixture, '.gitignore'), '.data/\n');
    git(['add', '.gitignore']); stage('.data/hidden.json', '{}');
    expectFailure('third-party directory'); remove('.data/hidden.json');
  });
  test('worktree mode detects untracked source-policy violations', () => {
    fs.writeFileSync(path.join(fixture, '.ENV.local'), 'toy');
    expectFailure('environment file', ['--worktree']);
    fs.unlinkSync(path.join(fixture, '.ENV.local'));
  });
  test('clean commit tree passes independently of worktree changes', () => {
    fs.writeFileSync(path.join(fixture, 'README.md'), namespace);
    expectPass(['--tree', cleanCommit]);
    fs.writeFileSync(path.join(fixture, 'README.md'), clean);
  });
  test('removed forbidden content is still caught in history and pre-push', () => {
    stage('README.md', decompiled); git(['commit', '--quiet', '-m', 'Synthetic forbidden historical fixture']);
    stage('README.md', clean); git(['commit', '--quiet', '-m', 'Synthetic clean tip']);
    const tip = git(['rev-parse', 'HEAD']);
    expectPass(['--tree', 'HEAD']);
    expectFailure('decompiler output marker', ['--history', 'HEAD']);
    expectFailure('decompiler output marker', ['--pre-push'], `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`);
    expectFailure('decompiler output marker', ['--pre-push'], `refs/heads/main ${tip} refs/heads/main ${cleanCommit}\n`);
  });
  test('a push deleting a ref has no new source history', () => expectPass(['--pre-push'], `(delete) ${'0'.repeat(40)} refs/heads/old ${cleanCommit}\n`));
  test('invalid hook input fails closed', () => expectFailure('Invalid pre-push ref input', ['--pre-push'], 'not valid input\n'));
  console.log(`${checks}/${checks} source boundary checks passed.`);
} finally {
  // Delete only the exact disposable directory created above, never source/.data.
  const resolved = path.resolve(fixture);
  const relative = path.relative(path.resolve(scratchRoot), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('source-boundary-test-')) throw new Error('Refusing unsafe fixture cleanup.');
  fs.rmSync(resolved, { recursive: true, force: true });
}
