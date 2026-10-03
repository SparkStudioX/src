#!/usr/bin/env node
// SDK analyzers are the backend linter; recompilation prevents incremental-build omissions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceRoot as root, withBuildContext } from './build-context.mjs';
import { freshDotnetEnvironment } from './dotnet-environment.mjs';

const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools', 'dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
const artifacts = path.join(root, '.data', 'quality', 'lint-build');
const env = { ...freshDotnetEnvironment(), DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
const python = process.env.SPARKSTUDIO_PYTHON || (windows ? path.join(root, 'runtimes/python/windows-x64/python.exe') : 'python3');
if (dotnet === localDotnet) Object.assign(env, { DOTNET_ROOT: path.dirname(localDotnet), DOTNET_CLI_HOME: path.join(root, '.tools', 'dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools', 'nuget'),
  ...(windows ? { APPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, '.tools', 'dotnet-home', 'AppData', 'Local') } : {}) });

await withBuildContext(async () => {
  let failures = 0;
  const lint = spawnSync(python, [path.join(root, 'tools', 'lint-python.py')], { cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(lint.stdout ?? '');
  process.stderr.write(lint.stderr ?? '');
  if (lint.error) console.error(lint.error.message);
  if (lint.status !== 0 || lint.error) failures++;
  for (const project of ['src/SparkStudio.Gateway', 'installer/ServiceHelper']) {
    // The helper is a Windows product even when lint runs on a Linux builder.
    // Its reviewed single-file lock targets win-x64; never infer the host RID.
    const runtime = project === 'installer/ServiceHelper' ? ['--runtime', 'win-x64', '-p:NuGetLockFilePath=packages.win-x64.lock.json'] : [];
    const result = spawnSync(dotnet, ['build', project, '-c', 'Release', '--artifacts-path', artifacts, ...runtime, '--no-incremental', '--verbosity', 'minimal', '-p:RestoreLockedMode=true', '-p:RestoreConfigFile=NuGet.Config'], {
      cwd: root, env: { ...env, SPARKSTUDIO_BUILD_CONTEXT: process.env.SPARKSTUDIO_BUILD_CONTEXT, SPARKSTUDIO_BUILD_TOKEN: process.env.SPARKSTUDIO_BUILD_TOKEN },
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) console.error(result.error.message);
    if (result.status !== 0 || result.error) failures++;
  }
  process.exitCode = failures ? 1 : 0;
});
