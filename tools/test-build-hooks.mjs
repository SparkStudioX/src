// Reproduce a standalone coordinator's LOCAL lease without environment fallback.
// SDK reference clones must explicitly forward it to real child quality hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceRoot as root, withBuildContext, hasBuildContext } from './build-context.mjs';
import { freshDotnetEnvironment } from './dotnet-environment.mjs';

const windows = process.platform === 'win32';
const bundled = path.join(root, '.tools/dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(bundled) ? bundled : 'dotnet');
const parent = path.join(root, '.data/quality/build-hook-fixtures');
fs.mkdirSync(parent, { recursive: true });
const fixture = fs.mkdtempSync(path.join(parent, 'references-'));
const env = { ...freshDotnetEnvironment(), MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0' };
delete env.SPARKSTUDIO_BUILD_CONTEXT; delete env.SPARKSTUDIO_BUILD_TOKEN;
if (dotnet === bundled) Object.assign(env, { DOTNET_ROOT: path.dirname(bundled), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'),
  ...(windows ? { APPDATA: path.join(root, '.tools/dotnet-home/AppData/Roaming'), LOCALAPPDATA: path.join(root, '.tools/dotnet-home/AppData/Local') } : {}) });
const authoredHooks = fs.readFileSync(path.join(root, 'Directory.Build.targets'), 'utf8');
const entryPoints = authoredHooks.match(/<Target Name="SparkStudioBuildQuality" BeforeTargets="([^"]+)"/)[1];
const gatewayProject = fs.readFileSync(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'), 'utf8');
const workerTargets = ['CopySourceWorker', 'PublishSourceWorker'].map(name => gatewayProject.match(new RegExp(`<Target Name="${name}"[\\s\\S]*?<\\/Target>`))[0]).join('\n');
const dirs = Object.fromEntries(['Gateway', 'Connectors', 'SourceWorker'].map(name => [name, path.join(fixture, `SparkStudio.${name}`)]));
for (const [name, directory] of Object.entries(dirs)) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'Example.cs'), 'namespace BuildHookFixture; public static class Example { public static int Value => 1; }');
  if (name !== 'Gateway') fs.writeFileSync(path.join(directory, `SparkStudio.${name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><Target Name="AssertForwardedLease" BeforeTargets="SparkStudioBuildQuality"><Error Condition="'$(_QualityContextPath)' != '$(_FixtureLeasePath)' or '$(_QualityContextToken)' != '$(_FixtureLeaseToken)'" Text="The parent local lease was not forwarded through cloned ProjectReference metadata." /></Target></Project>`);
}
const project = path.join(dirs.Gateway, 'SparkStudio.Gateway.csproj');
// Explicit SDK imports allow overriding ONLY this fixture parent's outer gate.
// Its children retain the production hook and validate the issued lease normally.
const parentProject = `<Project><Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" /><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../SparkStudio.Connectors/SparkStudio.Connectors.csproj"><AdditionalProperties>PlcRuntimeIdentifier=fixture-preserved</AdditionalProperties></ProjectReference><ProjectReference Include="../SparkStudio.SourceWorker/SparkStudio.SourceWorker.csproj" ReferenceOutputAssembly="false" Private="false" /></ItemGroup><Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" /><Target Name="SparkStudioBuildQuality" BeforeTargets="${entryPoints}"><Error Condition="'$(_FixtureLeasePath)' == '' or '$(_FixtureLeaseToken)' == ''" Text="Missing fixture coordinator lease." /><PropertyGroup><_QualityContextPath>$(_FixtureLeasePath)</_QualityContextPath><_QualityContextToken>$(_FixtureLeaseToken)</_QualityContextToken></PropertyGroup><WriteLinesToFile File="$(MSBuildProjectDirectory)/gate-count.txt" Lines="entered" Overwrite="false" /></Target><Target Name="VerifyOriginalMetadata" BeforeTargets="ResolveProjectReferences"><Error Condition="'%(ProjectReference.Filename)' == 'SparkStudio.Connectors' and !$([System.String]::Copy('%(ProjectReference.AdditionalProperties)').Contains('PlcRuntimeIdentifier=fixture-preserved'))" Text="Forwarding replaced existing reference metadata." /></Target>${workerTargets}</Project>`;
fs.writeFileSync(project, parentProject);

function run(name, args, expectedFailure) {
  const result = spawnSync(dotnet, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`;
  fs.writeFileSync(path.join(fixture, `${name}.log`), output);
  if (expectedFailure) { assert.notEqual(result.status, 0); assert.match(output, expectedFailure); }
  else assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /Frontend lint|All mandatory build quality/, 'Nested work must not recursively run the public aggregate.');
}
try {
  run('restore', ['restore', project, '--configfile', path.join(root, 'NuGet.Config'), '-p:NuGetAudit=false']);
  run('metadata', ['msbuild', project, '-t:GetTargetFrameworks;GetTargetPath', '-nologo']);
  assert.equal(fs.existsSync(path.join(dirs.Gateway, 'gate-count.txt')), false, 'Restore and metadata queries must not enter the artifact gate.');
  await withBuildContext(async () => {
    const context = [`-p:_FixtureLeasePath=${process.env.SPARKSTUDIO_BUILD_CONTEXT}`, `-p:_FixtureLeaseToken=${process.env.SPARKSTUDIO_BUILD_TOKEN}`];
    const payload = path.join(fixture, 'payload');
    const publish = ['publish', project, '--no-restore', '--self-contained', 'false', '-o', payload, '--disable-build-servers', '-p:UseSharedCompilation=false', ...context];
    // The former implementation updated only originals after the SDK cloned
    // them. Prove this exact failure is detected before recursive work begins.
    const brokenForwarding = '<Target Name="SparkStudioForwardBuildContext" BeforeTargets="ResolveProjectReferences"><ItemGroup><ProjectReference Update="@(ProjectReference)"><AdditionalProperties>%(ProjectReference.AdditionalProperties);_QualityContextPath=$(_QualityContextPath);_QualityContextToken=$(_QualityContextToken)</AdditionalProperties></ProjectReference></ItemGroup></Target>';
    fs.writeFileSync(project, parentProject.replace('</Project>', `${brokenForwarding}</Project>`));
    run('missing-clone-forwarding', publish, /parent local lease was not forwarded/);
    assert.equal(fs.existsSync(path.join(payload, 'SparkStudio.Gateway.dll')), false, 'Missing child context must stop the artifact graph.');
    fs.writeFileSync(project, parentProject);
    fs.rmSync(path.join(dirs.Gateway, 'gate-count.txt'));
    run('publish', publish);
    assert.equal(fs.readFileSync(path.join(dirs.Gateway, 'gate-count.txt'), 'utf8').trim(), 'entered', 'The outer Build/Publish graph enters its gate exactly once.');
    assert.equal(hasBuildContext(), true, 'Child Build/Publish cleanup must retain the coordinator-owned lease.');
    assert.ok(fs.existsSync(path.join(payload, 'SparkStudio.Gateway.dll')));
    assert.ok(fs.existsSync(path.join(payload, 'source-worker/SparkStudio.SourceWorker.dll')));
  });
  console.log('PASS local parent lease reaches real child SDK hooks through cloned reference metadata, with no context environment fallback.');
  console.log('PASS original reference metadata survives; Gateway custom worker publish completes before coordinator cleanup.');
  console.log('PASS fresh restore and read-only SDK metadata do not enter artifact quality gates.');
} finally {
  if (path.dirname(path.resolve(fixture)) !== path.resolve(parent)) throw new Error('Unsafe build hook fixture cleanup path.');
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
