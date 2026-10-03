#!/usr/bin/env node
// Prove actual backend linters reject defects even inside a nested compiler context.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceRoot as root, withBuildContext } from './build-context.mjs';
import { freshDotnetEnvironment } from './dotnet-environment.mjs';

const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools', 'dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
const python = process.env.SPARKSTUDIO_PYTHON || (windows ? path.join(root, 'runtimes/python/windows-x64/python.exe') : 'python3');
const directory = path.join(root, '.data', 'quality', 'analyzer-fixtures');
fs.mkdirSync(directory, { recursive: true });
const fixture = fs.mkdtempSync(path.join(directory, 'negative-'));
// Deliberately poison inherited MSBuild routing: the real net10.0 fixture must
// still reach the pinned SDK and reject CA2200, rather than fail SDK resolution.
const env = { ...freshDotnetEnvironment({ ...process.env,
  MSBUILD_EXE_PATH: path.join(fixture, 'missing-sdk/MSBuild.dll'),
  MSBuildSDKsPath: path.join(fixture, 'missing-sdk/Sdks'),
  DOTNET_HOST_PATH: path.join(fixture, 'missing-sdk/dotnet'),
}), DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0' };
if (dotnet === localDotnet) Object.assign(env, { DOTNET_ROOT: path.dirname(localDotnet), DOTNET_CLI_HOME: path.join(root, '.tools', 'dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools', 'nuget'),
  ...(windows ? { APPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Local') } : {}) });

function execute(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, env: { ...env, SPARKSTUDIO_BUILD_CONTEXT: process.env.SPARKSTUDIO_BUILD_CONTEXT, SPARKSTUDIO_BUILD_TOKEN: process.env.SPARKSTUDIO_BUILD_TOKEN },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
}

await withBuildContext(async () => {
  try {
    const project = path.join(fixture, 'SparkStudio.Connectors.csproj');
    fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
    fs.writeFileSync(path.join(fixture, 'Defect.cs'), 'namespace QualityFixture; public static class Defect { public static void Run() { try { throw new System.InvalidOperationException(); } catch (System.Exception error) { throw error; } } }');
    const artifacts = path.join(fixture, 'output');
    const restore = execute(dotnet, ['restore', project, '--artifacts-path', artifacts, '--configfile', path.join(root, 'NuGet.Config'), '-p:NuGetAudit=false']);
    assert.equal(restore.status, 0, `${restore.stdout}${restore.stderr}${restore.error ?? ''}`);
    const compile = execute(dotnet, ['build', project, '--artifacts-path', artifacts, '--no-restore', '--no-incremental', '--disable-build-servers', '-p:UseSharedCompilation=false']);
    assert.notEqual(compile.status, 0, 'A real SDK analyzer violation must fail nested production compilation.');
    assert.match(`${compile.stdout}${compile.stderr}`, /error CA2200:/, 'The expected linter diagnostic must cause the failure.');
    console.log('PASS backend C# analyzer rejects a stack-destroying rethrow inside the verified build context.');

    const ruffFixture = execute(python, ['-c', 'import runpy, subprocess, sys; tool = runpy.run_path("tools/lint-python.py"); result = subprocess.run([str(tool["ruff_binary"]()), "check", "--config", "ruff.toml", "--stdin-filename", "runtimes/python/worker.py", "-"], input="def example():\\n    return undefined_value\\n".replace("\\\\n", "\\n"), text=True); sys.exit(result.returncode)']);
    assert.notEqual(ruffFixture.status, 0, 'Ruff must reject an undefined runtime variable.');
    assert.match(`${ruffFixture.stdout}${ruffFixture.stderr}`, /F821/, 'The expected Python linter diagnostic must cause the failure.');
    console.log('PASS backend Python linter rejects an undefined runtime variable.');
  } finally {
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== path.resolve(directory)) throw new Error('Unsafe analyzer fixture cleanup path.');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
