#!/usr/bin/env node
// Shared build entrypoint. All artifact-producing public builds require these gates.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceRoot as root, hasBuildContext, withBuildContext, issueBuildContext, removeBuildContext, deferBuildContextCleanup, expireBuildContext } from './build-context.mjs';
import { runQualityGates } from './quality-gates.mjs';
import { freshDotnetEnvironment } from './dotnet-environment.mjs';

const web = path.join(root, 'apps', 'web');
const reports = path.join(root, '.data', 'quality');
const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools', 'dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
function validateReceipt(receipt) {
  const directory = path.join(reports, 'msbuild');
  if (!receipt || path.dirname(path.resolve(receipt)) !== path.resolve(directory)
    || !/^[a-f0-9-]{36}\.txt$/i.test(path.basename(receipt))) throw new Error('Invalid internal build receipt path.');
}
const env = { ...freshDotnetEnvironment(), DOTNET_CLI_TELEMETRY_OPTOUT: '1', SPARKSTUDIO_DOTNET: dotnet };
if (dotnet === localDotnet) Object.assign(env, {
  DOTNET_ROOT: path.dirname(localDotnet), DOTNET_CLI_HOME: path.join(root, '.tools', 'dotnet-home'),
  NUGET_PACKAGES: path.join(root, '.tools', 'nuget'),
  ...(windows ? { APPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Local') } : {}),
});

function run(name, command, args, cwd = root) {
  console.log(`\n${name}`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env: { ...env, SPARKSTUDIO_BUILD_CONTEXT: process.env.SPARKSTUDIO_BUILD_CONTEXT, SPARKSTUDIO_BUILD_TOKEN: process.env.SPARKSTUDIO_BUILD_TOKEN },
    encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`;
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`), output);
  process.stdout.write(output);
  const passed = result.status === 0 && !result.error;
  return { name, passed, exitCode: result.status, seconds: (Date.now() - started) / 1000 };
}

function requireCommand(...args) {
  const result = run(...args);
  if (!result.passed) throw new Error(`${result.name} failed. Build stopped; diagnostics are in .data/quality.`);
}

function quality() {
  const results = [];
  try {
    runQualityGates([
      { run: () => run('Frontend lint', process.execPath, [path.join(web, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'src', 'vite.config.ts', '--max-warnings', '0'], web) },
      { run: () => run('Backend lint', process.execPath, [path.join(root, 'tools', 'lint-backend.mjs')]) },
      { run: () => run('Offline unit and acceptance tests', process.execPath, [path.join(root, 'tools', 'test-all.mjs')]) },
      { run: () => run('Cyclomatic complexity', process.execPath, [path.join(root, 'tools', 'check-complexity.mjs')]) },
    ], result => results.push(result));
    console.log('\nAll mandatory build quality gates passed.');
  } finally {
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, 'summary.json'), JSON.stringify({ version: 1, passed: results.length === 4 && results.every(result => result.passed), gates: results }, null, 2) + '\n');
  }
}

function frontendBuild() {
  requireCommand('Frontend typecheck', process.execPath, [path.join(web, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', '--pretty', 'false'], web);
  requireCommand('Frontend bundle', process.execPath, [path.join(web, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], web);
}

async function main() {
  const mode = process.argv[2] ?? 'quality';
  if (mode === 'expire-context') {
    if (process.argv.length !== 5) throw new Error('Invalid internal context expiry request.');
    await expireBuildContext(process.argv[3], process.argv[4]);
    return;
  }
  if (mode === 'release-msbuild') {
    const receipt = process.argv[3];
    const afterBuild = process.argv[4] === 'after-build';
    if (!receipt || process.argv.length !== (afterBuild ? 5 : 4)) throw new Error('Invalid internal cleanup request.');
    validateReceipt(receipt);
    const [contextPath, token, ownsContext] = fs.readFileSync(receipt, 'utf8').trim().split('\n');
    if (ownsContext === 'true') {
      if (afterBuild) deferBuildContextCleanup(contextPath, token);
      else removeBuildContext(contextPath, token);
    }
    fs.rmSync(receipt, { force: true });
    return;
  }
  if (!['quality', 'web', 'full', 'msbuild'].includes(mode)
    || (mode !== 'msbuild' && process.argv.length > 3)) throw new Error('Usage: node tools/build-quality.mjs [quality|web|full]');
  let ownerPid;
  let receipt;
  if (mode === 'msbuild' && process.argv.length > 3) {
    if (process.argv.length !== 5) throw new Error('Invalid internal MSBuild request.');
    ownerPid = Number(process.argv[3]); receipt = process.argv[4];
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid internal MSBuild owner.');
    validateReceipt(receipt);
  }
  const writeReceipt = (contextPath, token, ownsContext) => {
    if (!receipt) return;
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, `${contextPath}\n${token}\n${ownsContext}\n`);
  };
  // Called only by Directory.Build.targets. All references inherit this verified lease.
  if (mode === 'msbuild' && hasBuildContext()) {
    writeReceipt(process.env.SPARKSTUDIO_BUILD_CONTEXT, process.env.SPARKSTUDIO_BUILD_TOKEN, false);
    return;
  }
  await withBuildContext(async () => {
    quality();
    if (mode === 'web' || mode === 'full') frontendBuild();
    if (mode === 'full') {
      const destination = path.join(root, 'src', 'SparkStudio.Gateway', 'wwwroot');
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(path.join(web, 'dist'), destination, { recursive: true });
      requireCommand('Gateway build', dotnet, ['build', 'src/SparkStudio.Gateway', '--no-restore']);
    }
  });
  if (ownerPid !== undefined) {
    const context = issueBuildContext(ownerPid);
    writeReceipt(context.contextPath, context.token, true);
  }
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
