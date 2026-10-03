// Repository-relative tool discovery shared by offline .NET fixture runners.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withBuildContext, buildContextProperties } from './build-context.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools/dotnet', windows ? 'dotnet.exe' : 'dotnet');
export const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
export const testEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
if (dotnet === localDotnet) Object.assign(testEnv, {
  DOTNET_ROOT: path.dirname(localDotnet),
  DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || path.join(root, '.tools/dotnet-home'),
  NUGET_PACKAGES: process.env.NUGET_PACKAGES || path.join(root, '.tools/nuget'),
  ...(windows ? {
    APPDATA: path.join(root, '.tools/dotnet-home/AppData/Roaming'),
    LOCALAPPDATA: path.join(root, '.tools/dotnet-home/AppData/Local'),
  } : {}),
});

// Model fixtures may reference production projects, but their restores must not
// replace the calling build's RID-specific assets or create assets beside source.
export function productionAssetsSnapshot() {
  return ['src/SparkStudio.Gateway', 'src/SparkStudio.Connectors', 'src/SparkStudio.SourceWorker', 'installer/ServiceHelper'].map(directory => {
    const file = path.join(root, directory, 'obj/project.assets.json');
    return { file, sha256: fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  });
}

export function assertProductionAssetsUnchanged(before) {
  assert.deepEqual(productionAssetsSnapshot(), before, 'Fixture restore replaced the calling production build dependency assets.');
}

export async function runIsolatedFixture(project, configuration) {
  const directory = path.dirname(project);
  const before = productionAssetsSnapshot();
  const result = await withBuildContext(() => spawnSync(dotnet, [
    'run', '--project', project, '--configuration', configuration,
    '--artifacts-path', path.join(directory, 'artifacts'), '--disable-build-servers',
    '-p:UseSharedCompilation=false', ...buildContextProperties(), '--verbosity', 'quiet',
    `-p:RestoreConfigFile=${path.join(directory, 'NuGet.Config')}`, '-p:NuGetAudit=false',
  ], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...testEnv, SPARKSTUDIO_BUILD_CONTEXT: process.env.SPARKSTUDIO_BUILD_CONTEXT, SPARKSTUDIO_BUILD_TOKEN: process.env.SPARKSTUDIO_BUILD_TOKEN },
  }));
  assertProductionAssetsUnchanged(before);
  return result;
}
